import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { resolveSentenceIndices } from './highlight-utils'
import { PDF_RENDER_SCALE, usePageCache } from './use-page-cache'
import { usePdfDocument } from './use-pdf-document'

const BBOX_INFLATE_PT = 2

export default function LinearReader({
  pdfDoc,
  pdfFile,
  linearBlocks,
  pageDims,
  contentWidth,
  userZoom = 1,
  onExplain,
  activeParagraph,
  currentExplanation,
  explanation,
}) {
  // If the parent already owns a doc, use it. Otherwise fall back to loading
  // from pdfFile ourselves (LinearReaderTest standalone case).
  const ownedDoc = usePdfDocument(pdfDoc ? null : pdfFile)
  const effectiveDoc = pdfDoc ?? ownedDoc
  const { pageCanvases, requestPage } = usePageCache(effectiveDoc, { maxCached: 8, concurrent: 2 })

  const [visibleSet, setVisibleSet] = useState(() => new Set())
  const [hoveredIdx, setHoveredIdx] = useState(null)
  const [observerInstance, setObserverInstance] = useState(null)

  const rootDivRef = useRef(null)
  const firstVisibleLoggedRef = useRef(false)
  const mountTimeRef = useRef(0)

  useEffect(() => {
    mountTimeRef.current = performance.now()
  }, [])

  // Auto-detect nearest scroll container so IntersectionObserver fires on the
  // right axis even when LinearReader is nested inside PdfViewer.
  useEffect(() => {
    if (!rootDivRef.current) return
    let cur = rootDivRef.current.parentElement
    let scrollRoot = null
    while (cur && cur !== document.body) {
      const style = window.getComputedStyle(cur)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        scrollRoot = cur
        break
      }
      cur = cur.parentElement
    }

    const observer = new IntersectionObserver(entries => {
      setVisibleSet(prev => {
        const next = new Set(prev)
        let changed = false
        for (const e of entries) {
          const idx = Number(e.target.dataset.blockIdx)
          if (Number.isNaN(idx)) continue
          if (e.isIntersecting) {
            if (!next.has(idx)) { next.add(idx); changed = true }
          } else if (next.has(idx)) {
            next.delete(idx); changed = true
          }
        }
        return changed ? next : prev
      })
    }, { root: scrollRoot, rootMargin: '400px 0px 400px 0px', threshold: 0 })

    setObserverInstance(observer)
    return () => {
      observer.disconnect()
      setObserverInstance(null)
    }
  }, [])

  // Dev-only timing: first block visible after mount.
  useEffect(() => {
    if (firstVisibleLoggedRef.current || visibleSet.size === 0) return
    if (import.meta.env?.DEV) {
      const elapsed = (performance.now() - mountTimeRef.current).toFixed(1)
      console.log(`[LinearReader] first block visible @ ${elapsed}ms`)
    }
    firstVisibleLoggedRef.current = true
  }, [visibleSet])

  const handleHoverChange = useCallback((idx, hover) => {
    setHoveredIdx(hover ? idx : null)
  }, [])

  const displayWidth = Math.max(1, (contentWidth || 0) * userZoom)

  return (
    <div
      ref={rootDivRef}
      className="bg-white"
      style={{ paddingLeft: 48, paddingRight: 48 }}
    >
      <div
        className="mx-auto"
        style={{
          width: displayWidth,
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
        }}
      >
        {linearBlocks.map((block, i) => (
          <BlockCrop
            key={`${block.page}-${block.reading_index}-${i}`}
            blockIdx={i}
            block={block}
            srcCanvas={pageCanvases[block.page]}
            pageDim={pageDims?.[block.page]}
            displayWidth={displayWidth}
            visible={visibleSet.has(i)}
            observer={observerInstance}
            requestPage={requestPage}
            hovered={hoveredIdx === i}
            onHoverChange={handleHoverChange}
            onExplain={onExplain}
            activeParagraph={activeParagraph}
            currentExplanation={currentExplanation}
            explanation={explanation}
          />
        ))}
      </div>
    </div>
  )
}

// Shallow-prop memo. Stable refs for callbacks (handleHoverChange/onExplain/
// requestPage are useCallback) + per-page srcCanvas references mean a cache
// publish only re-renders blocks of the page that was just rendered/evicted,
// and a hover/visibility change only re-renders the affected block.
const BlockCrop = memo(function BlockCrop({
  blockIdx,
  block,
  srcCanvas,
  pageDim,
  displayWidth,
  visible,
  observer,
  requestPage,
  hovered,
  onHoverChange,
  onExplain,
  activeParagraph,
  currentExplanation,
  explanation,
}) {
  const wrapperRef = useRef(null)
  const canvasRef  = useRef(null)

  const bbox = block.bbox
  const inflatedY0 = Math.max(0, bbox.y0 - BBOX_INFLATE_PT)
  const inflatedY1 = pageDim?.height
    ? Math.min(pageDim.height, bbox.y1 + BBOX_INFLATE_PT)
    : bbox.y1 + BBOX_INFLATE_PT
  const bbW = Math.max(0, bbox.x1 - bbox.x0)
  const bbH = Math.max(0, inflatedY1 - inflatedY0)

  const aspect = bbW > 0 ? bbH / bbW : 0
  const displayHeight = Math.max(1, Math.round(displayWidth * aspect))

  // Register with the shared IntersectionObserver.
  useEffect(() => {
    const node = wrapperRef.current
    if (!node || !observer) return
    observer.observe(node)
    return () => observer.unobserve(node)
  }, [observer])

  // Trigger page render when this block becomes visible without a cached page.
  // Also re-requests if the page is evicted while we're still on-screen.
  useEffect(() => {
    if (visible && !srcCanvas) requestPage(block.page)
  }, [visible, srcCanvas, block.page, requestPage])

  // Drop hover state when scrolling off-viewport. onMouseLeave only fires while
  // the wrapper still has interactive handlers; once isInteractive flips false
  // it never fires, leaving hovered=true stuck until the block re-enters.
  useEffect(() => {
    if (!visible && hovered) onHoverChange?.(blockIdx, false)
  }, [visible, hovered, blockIdx, onHoverChange])

  // Draw crop on visibility + cache hit. Re-draws on srcCanvas change (e.g.
  // after eviction + re-render) and on resize/zoom.
  useEffect(() => {
    if (!visible || !srcCanvas) return
    const canvas = canvasRef.current
    if (!canvas || displayWidth <= 0 || bbW <= 0 || bbH <= 0) return

    const dpr = window.devicePixelRatio || 1
    const physicalW = Math.max(1, Math.round(displayWidth * dpr))
    const physicalH = Math.max(1, Math.round(displayHeight * dpr))
    if (canvas.width !== physicalW) canvas.width = physicalW
    if (canvas.height !== physicalH) canvas.height = physicalH
    canvas.style.width  = `${displayWidth}px`
    canvas.style.height = `${displayHeight}px`

    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, physicalW, physicalH)

    ctx.drawImage(
      srcCanvas,
      bbox.x0 * PDF_RENDER_SCALE,
      inflatedY0 * PDF_RENDER_SCALE,
      bbW * PDF_RENDER_SCALE,
      bbH * PDF_RENDER_SCALE,
      0, 0, physicalW, physicalH,
    )
  }, [visible, srcCanvas, displayWidth, displayHeight, bbox.x0, inflatedY0, bbW, bbH])

  const isRendered    = visible && !!srcCanvas
  const isInteractive = isRendered && block.role === 'paragraph' && !!block.sentences?.length
  const isActive      = isInteractive && activeParagraph?.text === block.text
  const bboxScale     = bbW > 0 ? displayWidth / bbW : 0

  function toLocalRect(b) {
    return {
      left:   (b.x0 - bbox.x0) * bboxScale,
      top:    (b.y0 - inflatedY0) * bboxScale,
      width:  (b.x1 - b.x0) * bboxScale,
      height: (b.y1 - b.y0) * bboxScale,
    }
  }

  const allItems = explanation?.sentence_explanations ?? []
  const currentIndices = (isActive && currentExplanation)
    ? resolveSentenceIndices(block.sentences, currentExplanation)
    : []
  const currentSet = new Set(currentIndices)
  const otherIndices = isActive
    ? [...new Set(
        allItems
          .filter(it => it !== currentExplanation)
          .flatMap(it => resolveSentenceIndices(block.sentences, it))
      )].filter(idx => !currentSet.has(idx))
    : []

  const boxesFromIndices = (indices) =>
    indices.flatMap(idx =>
      (block.sentences[idx]?.boxes || []).map(toLocalRect)
    )

  const otherBoxes     = boxesFromIndices(otherIndices)
  const highlightBoxes = boxesFromIndices(currentIndices)

  let anchor = null
  if (isInteractive) {
    const lastSent = block.sentences[block.sentences.length - 1]
    const lastBox  = lastSent?.boxes?.[lastSent.boxes.length - 1]
    if (lastBox) {
      anchor = {
        left: (lastBox.x1 - bbox.x0) * bboxScale,
        top:  (lastBox.y1 - inflatedY0) * bboxScale,
      }
    }
  }

  return (
    <div
      ref={wrapperRef}
      data-block-idx={blockIdx}
      className="relative"
      style={{ width: displayWidth, height: displayHeight }}
      onMouseEnter={isInteractive ? () => onHoverChange?.(blockIdx, true) : undefined}
      onMouseLeave={isInteractive ? () => onHoverChange?.(blockIdx, false) : undefined}
    >
      {isRendered ? (
        <canvas
          ref={canvasRef}
          style={{
            width: displayWidth,
            height: displayHeight,
            borderRadius: 2,
            display: 'block',
          }}
        />
      ) : (
        <div
          className="bg-slate-100"
          style={{
            width: displayWidth,
            height: displayHeight,
            borderRadius: 2,
          }}
        />
      )}

      {isInteractive && (
        <div className="absolute inset-0 pointer-events-none">
          <div
            className="absolute rounded-sm transition-opacity duration-150"
            style={{
              left: 0,
              top: 0,
              width: displayWidth,
              height: displayHeight,
              background: hovered ? 'rgba(99,102,241,0.07)' : 'transparent',
              border: hovered ? '1px solid rgba(99,102,241,0.22)' : '1px solid transparent',
            }}
          />

          {otherBoxes.map((box, j) => (
            <div
              key={`ot-${j}`}
              className="absolute rounded-sm bg-slate-400/30"
              style={{ ...box, mixBlendMode: 'multiply' }}
            />
          ))}

          {highlightBoxes.map((box, j) => (
            <div
              key={`hl-${j}`}
              className="absolute rounded-sm bg-yellow-300/40 transition-all duration-300 ease-out"
              style={{ ...box, mixBlendMode: 'multiply' }}
            />
          ))}

          {anchor && (
            <button
              className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
              style={{
                left: anchor.left,
                top:  anchor.top,
                background: hovered ? 'rgb(79,70,229)' : 'rgba(99,102,241,0.15)',
                border: '1.5px solid rgba(99,102,241,0.6)',
                color: hovered ? 'white' : 'rgb(79,70,229)',
                fontSize: '8px',
                fontWeight: 700,
                boxShadow: hovered ? '0 2px 8px rgba(99,102,241,0.45)' : 'none',
                transform: hovered
                  ? 'translate(-100%, -100%) scale(1.15)'
                  : 'translate(-100%, -100%)',
              }}
              onClick={() => onExplain?.(block.text, block.sentences, block.flat_block_ref ?? block.paragraph_ref ?? null)}
              title="Explicar párrafo"
            >
              ✦
            </button>
          )}
        </div>
      )}
    </div>
  )
})
