import { useEffect, useRef, useState } from 'react'
import { pdfjs } from 'react-pdf'
import { resolveSentenceIndices } from './highlight-utils'

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
  onExplain,
  activeParagraph,
  currentExplanation,
  explanation,
}) {
  const [pageCanvases, setPageCanvases] = useState({})
  const [hoveredIdx, setHoveredIdx] = useState(null)
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
            hovered={hoveredIdx === i}
            onHoverChange={hover => setHoveredIdx(hover ? i : null)}
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

function BlockCrop({
  blockIdx,
  block,
  srcCanvas,
  pageDim,
  displayWidth,
  hovered,
  onHoverChange,
  onExplain,
  activeParagraph,
  currentExplanation,
  explanation,
}) {
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

  const isInteractive = block.role === 'paragraph' && !!block.sentences?.length
  const isActive = isInteractive && activeParagraph?.text === block.text
  const bboxScale = bbW > 0 ? displayWidth / bbW : 0

  // Page-space sentence box → crop-local CSS pixel rect.
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

  // Anchor ✦ button at the last sentence's last box (bottom-right of the
  // paragraph text), translated up-left so it sits just above end of line.
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
      data-block-idx={blockIdx}
      className="relative"
      style={{ width: displayWidth }}
      onMouseEnter={isInteractive ? () => onHoverChange?.(true) : undefined}
      onMouseLeave={isInteractive ? () => onHoverChange?.(false) : undefined}
    >
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

      {isInteractive && (
        <div className="absolute inset-0 pointer-events-none">
          {/* Hover tint over the whole paragraph crop */}
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

          {/* Other sentences from the carousel — static gray */}
          {otherBoxes.map((box, j) => (
            <div
              key={`ot-${j}`}
              className="absolute rounded-sm bg-slate-400/30"
              style={{ ...box, mixBlendMode: 'multiply' }}
            />
          ))}

          {/* Current sentence — animated yellow */}
          {highlightBoxes.map((box, j) => (
            <div
              key={`hl-${j}`}
              className="absolute rounded-sm bg-yellow-300/40 transition-all duration-300 ease-out"
              style={{ ...box, mixBlendMode: 'multiply' }}
            />
          ))}

          {/* ✦ explain button anchored at last sentence end */}
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
              onClick={() => onExplain?.(block.text, block.sentences, block.paragraph_ref ?? null)}
              title="Explicar párrafo"
            >
              ✦
            </button>
          )}
        </div>
      )}
    </div>
  )
}
