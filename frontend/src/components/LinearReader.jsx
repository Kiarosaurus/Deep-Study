import { useEffect, useRef, useState } from 'react'
import { pdfjs } from 'react-pdf'

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()
}

const PDF_RENDER_SCALE =
  typeof window !== 'undefined'
    ? 2 * (window.devicePixelRatio || 1)
    : 2

const BBOX_INFLATE_PT = 2

export default function LinearReader({
  pdfFile,
  linearBlocks,
  pageDims,
  contentWidth,
  userZoom = 1,
}) {
  const [pageCanvases, setPageCanvases] = useState({})
  const pdfDocRef = useRef(null)

  useEffect(() => {
    if (!pdfFile || !linearBlocks?.length) return
    let cancelled = false

    async function load() {
      const doc = await pdfjs.getDocument(pdfFile).promise
      if (cancelled) {
        doc.destroy?.()
        return
      }
      pdfDocRef.current = doc

      const pageNums = [...new Set(linearBlocks.map(b => b.page))].sort(
        (a, b) => a - b,
      )

      for (const pn of pageNums) {
        if (cancelled) return
        const page = await doc.getPage(pn)
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const ctx = canvas.getContext('2d')
        await page.render({ canvasContext: ctx, viewport }).promise
        if (cancelled) return
        setPageCanvases(prev => ({ ...prev, [pn]: canvas }))
      }
    }

    load().catch(err => {
      if (!cancelled) console.error('LinearReader: failed to render PDF', err)
    })

    return () => {
      cancelled = true
      const doc = pdfDocRef.current
      pdfDocRef.current = null
      if (doc) doc.destroy?.()
      setPageCanvases({})
    }
  }, [pdfFile, linearBlocks])

  const displayWidth = Math.max(1, (contentWidth || 0) * userZoom)

  return (
    <div
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
          />
        ))}
      </div>
    </div>
  )
}

function BlockCrop({ blockIdx, block, srcCanvas, pageDim, displayWidth }) {
  const canvasRef = useRef(null)

  const bbox = block.bbox
  const inflatedY0 = Math.max(0, bbox.y0 - BBOX_INFLATE_PT)
  const inflatedY1 = pageDim?.height
    ? Math.min(pageDim.height, bbox.y1 + BBOX_INFLATE_PT)
    : bbox.y1 + BBOX_INFLATE_PT
  const bbW = Math.max(0, bbox.x1 - bbox.x0)
  const bbH = Math.max(0, inflatedY1 - inflatedY0)

  const aspect = bbW > 0 ? bbH / bbW : 0
  const displayHeight = Math.max(1, Math.round(displayWidth * aspect))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !srcCanvas || displayWidth <= 0 || bbW <= 0 || bbH <= 0) return

    const dpr = window.devicePixelRatio || 1
    const physicalW = Math.max(1, Math.round(displayWidth * dpr))
    const physicalH = Math.max(1, Math.round(displayHeight * dpr))
    if (canvas.width !== physicalW) canvas.width = physicalW
    if (canvas.height !== physicalH) canvas.height = physicalH
    canvas.style.width = `${displayWidth}px`
    canvas.style.height = `${displayHeight}px`

    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, physicalW, physicalH)

    const sx = bbox.x0 * PDF_RENDER_SCALE
    const sy = inflatedY0 * PDF_RENDER_SCALE
    const sw = bbW * PDF_RENDER_SCALE
    const sh = bbH * PDF_RENDER_SCALE
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, physicalW, physicalH)
  }, [srcCanvas, displayWidth, displayHeight, bbox.x0, bbox.y0, bbox.x1, bbox.y1, bbW, bbH, inflatedY0])

  return (
    <div data-block-idx={blockIdx} style={{ width: displayWidth }}>
      {srcCanvas ? (
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
          style={{
            width: displayWidth,
            height: displayHeight,
            borderRadius: 2,
          }}
        />
      )}
    </div>
  )
}
