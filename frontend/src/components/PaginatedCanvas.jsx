import { memo, useEffect, useRef, useState } from 'react'
import AnnotationLayer from './AnnotationLayer'
import TextLayer from './TextLayer'

// One PDF page rendered as a custom canvas, sourced from the shared
// usePageCache cache. Mirrors what BlockCrop does for tracking mode (single
// pdfjs rasterization at PDF_RENDER_SCALE, then ctx.drawImage on every
// zoom) so paginated mode gets the same GPU-fast zoom path — no react-pdf
// re-rasterization, no "Cargando PDF..." flash, no blank canvas mid-zoom.
//
// `children` is anchored absolute over the canvas at the same px size, so
// ParagraphOverlay / trackedBox positioning logic (scale-based) keeps
// working unchanged.
const PaginatedCanvas = memo(function PaginatedCanvas({
  pdfDoc,
  pageNumber,
  width,
  pageDim,
  srcCanvas,
  requestPage,
  observer,
  children,
}) {
  const wrapperRef = useRef(null)
  const canvasRef  = useRef(null)
  const [visible, setVisible] = useState(false)
  const [pdfPage, setPdfPage] = useState(null)

  // Aspect ratio comes from backend pageDim (PDF points). Fallback to US
  // letter so the wrapper still reserves layout space before the first
  // render completes.
  const pw = pageDim?.width  ?? 612
  const ph = pageDim?.height ?? 792
  const aspect = ph / pw
  const displayHeight = Math.max(1, Math.round(width * aspect))

  // Register with shared IntersectionObserver. The observer's callback in
  // PdfViewer flips this component's `visible` state.
  useEffect(() => {
    const node = wrapperRef.current
    if (!node || !observer) return
    node.__onIntersect = (entry) => setVisible(entry.isIntersecting)
    observer.observe(node)
    return () => {
      observer.unobserve(node)
      delete node.__onIntersect
    }
  }, [observer])

  // Trigger page render when visible without a cached bitmap. Re-requests
  // if the cache evicts us while we're still on-screen.
  useEffect(() => {
    if (visible && !srcCanvas) requestPage(pageNumber)
  }, [visible, srcCanvas, pageNumber, requestPage])

  // Pull the pdfjs page object lazily on first visibility — text/annotation
  // layers need it. Keep it in component state so re-renders don't
  // re-fetch.
  useEffect(() => {
    if (!visible || !pdfDoc || pdfPage) return
    let cancelled = false
    pdfDoc.getPage(pageNumber).then(p => {
      if (!cancelled) setPdfPage(p)
    }).catch(err => {
      if (!cancelled) console.warn(`PaginatedCanvas: getPage ${pageNumber} failed`, err)
    })
    return () => { cancelled = true }
  }, [visible, pdfDoc, pageNumber, pdfPage])

  // Draw the cached page bitmap onto our canvas at displayWidth. Runs on
  // every width change — drawImage is GPU-fast so this stays smooth even
  // mid-wheel-gesture.
  useEffect(() => {
    if (!visible || !srcCanvas) return
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const physicalW = Math.max(1, Math.round(width * dpr))
    const physicalH = Math.max(1, Math.round(displayHeight * dpr))
    if (canvas.width !== physicalW)  canvas.width  = physicalW
    if (canvas.height !== physicalH) canvas.height = physicalH
    canvas.style.width  = `${width}px`
    canvas.style.height = `${displayHeight}px`
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, physicalW, physicalH)
    ctx.drawImage(
      srcCanvas,
      0, 0, srcCanvas.width, srcCanvas.height,
      0, 0, physicalW, physicalH,
    )
  }, [visible, srcCanvas, width, displayHeight])

  const isRendered = visible && !!srcCanvas
  const scale = pw > 0 ? width / pw : 1

  return (
    <div
      ref={wrapperRef}
      data-page={pageNumber}
      className="relative shadow-xl mb-5 bg-white"
      style={{ width, height: displayHeight, position: 'relative' }}
    >
      {isRendered ? (
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width, height: displayHeight }}
        />
      ) : (
        <div
          style={{ width, height: displayHeight, background: '#f1f5f9' }}
        />
      )}

      {/* Native text selection / search. Invisible spans overlay the
          canvas at the same positions as the rendered glyphs. */}
      {isRendered && pdfPage && (
        <TextLayer page={pdfPage} scale={scale} />
      )}

      {/* PDF link / annotation interactivity. */}
      {isRendered && pdfPage && (
        <AnnotationLayer page={pdfPage} scale={scale} />
      )}

      {/* Caller overlays — ParagraphOverlay, trackedBox, etc. They sit
          above text+annotation layers and stay interactive. */}
      {children}
    </div>
  )
})

export default PaginatedCanvas
