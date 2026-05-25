import { useState, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

// Estimates which region of the block bbox contains the term, using
// character-offset fraction mapped to the block's pixel height.
function computeTermHighlight(blockText, term, bbox, scale) {
  const { x0, y0, x1, y1 } = bbox
  const blockW = (x1 - x0) * scale
  const blockH = (y1 - y0) * scale

  const CHARS_PER_LINE = 60
  const totalLines = Math.max(1, Math.round(blockText.length / CHARS_PER_LINE))
  const lineH = blockH / totalLines

  const idx = blockText.toLowerCase().indexOf(term.toLowerCase())
  if (idx === -1) {
    return { left: x0 * scale, top: y0 * scale, width: blockW, height: Math.max(lineH, 14) }
  }

  const startLine = Math.floor(idx / CHARS_PER_LINE)
  const endLine   = Math.ceil((idx + term.length) / CHARS_PER_LINE)
  return {
    left:   x0 * scale,
    top:    y0 * scale + startLine * lineH,
    width:  blockW,
    height: Math.max((endLine - startLine) * lineH, lineH, 14),
  }
}

function ParagraphOverlay({ blocks, scale, onExplain, activeParagraph, highlightTerm }) {
  const [hoveredIdx, setHoveredIdx] = useState(null)

  if (!blocks || !scale) return null

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {blocks.map((block, i) => {
        const { x0, y0, x1, y1 } = block.bbox
        const sx0 = x0 * scale
        const sy0 = y0 * scale
        const sx1 = x1 * scale
        const sy1 = y1 * scale
        const isHovered = hoveredIdx === i
        const isActive  = activeParagraph?.text === block.text

        const termHL = isActive && highlightTerm
          ? computeTermHighlight(block.text, highlightTerm, block.bbox, scale)
          : null

        return (
          <div key={i}>
            {/* Hover highlight rect */}
            <div
              className="absolute rounded-sm transition-opacity duration-150"
              style={{
                left: sx0,
                top: sy0,
                width: sx1 - sx0,
                height: sy1 - sy0,
                background: isHovered ? 'rgba(99,102,241,0.07)' : 'transparent',
                border: isHovered ? '1px solid rgba(99,102,241,0.22)' : '1px solid transparent',
              }}
            />

            {/* Term highlight (yellow marker) — animates position on index change */}
            {termHL && (
              <div
                className="absolute pointer-events-none rounded-sm"
                style={{
                  left:   termHL.left,
                  top:    termHL.top,
                  width:  termHL.width,
                  height: termHL.height,
                  background: 'rgba(253, 224, 71, 0.55)',
                  mixBlendMode: 'multiply',
                  transition: 'top 0.2s ease-out, height 0.2s ease-out',
                }}
              />
            )}

            {/* ✦ viñeta button */}
            <button
              className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
              style={{
                left: sx1,
                top: sy1,
                background: isHovered ? 'rgb(79,70,229)' : 'rgba(99,102,241,0.15)',
                border: '1.5px solid rgba(99,102,241,0.6)',
                color: isHovered ? 'white' : 'rgb(79,70,229)',
                fontSize: '8px',
                fontWeight: 700,
                boxShadow: isHovered ? '0 2px 8px rgba(99,102,241,0.45)' : 'none',
                transform: isHovered
                  ? 'translate(-100%, -100%) scale(1.15)'
                  : 'translate(-100%, -100%)',
              }}
              onClick={() => onExplain(block.text, block.bbox)}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              title="Explicar párrafo"
            >
              ✦
            </button>
          </div>
        )
      })}
    </div>
  )
}

function PdfPage({ pageNumber, width, blocks, onExplain, activeParagraph, highlightTerm }) {
  const [scale, setScale] = useState(null)

  function handlePageLoad(page) {
    const originalWidth = page.getViewport({ scale: 1 }).width
    setScale(width / originalWidth)
  }

  return (
    <div className="relative shadow-xl mb-5">
      <Page
        pageNumber={pageNumber}
        width={width}
        onLoadSuccess={handlePageLoad}
        renderTextLayer
        renderAnnotationLayer
      />
      <ParagraphOverlay
        blocks={blocks}
        scale={scale}
        onExplain={onExplain}
        activeParagraph={activeParagraph}
        highlightTerm={highlightTerm}
      />
    </div>
  )
}

export default function PdfViewer({ file, onExplain, pages, activeParagraph, highlightTerm }) {
  const [numPages, setNumPages] = useState(null)
  const [containerWidth, setContainerWidth] = useState(null)

  const containerRef = useCallback((node) => {
    if (node) setContainerWidth(node.getBoundingClientRect().width)
  }, [])

  const pageWidth = containerWidth ? containerWidth - 48 : undefined

  const blocksMap = pages
    ? Object.fromEntries(pages.map((p) => [p.page, p.blocks]))
    : {}

  return (
    <div
      ref={containerRef}
      className="flex flex-col items-center py-8 px-6 bg-gray-100 min-h-full"
    >
      <Document
        file={file}
        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
        loading={<p className="text-slate-400 text-sm mt-16">Cargando PDF...</p>}
        error={<p className="text-red-500 text-sm mt-16">No se pudo cargar el PDF.</p>}
      >
        {numPages && pageWidth &&
          Array.from({ length: numPages }, (_, i) => (
            <PdfPage
              key={i}
              pageNumber={i + 1}
              width={pageWidth}
              blocks={blocksMap[i + 1]}
              onExplain={onExplain}
              activeParagraph={activeParagraph}
              highlightTerm={highlightTerm}
            />
          ))}
      </Document>
    </div>
  )
}
