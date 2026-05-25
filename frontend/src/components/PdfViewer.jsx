import { useState, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

function ParagraphOverlay({ blocks, scale, onExplain }) {
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

        return (
          <div key={i}>
            {/* Highlight rect shown on hover */}
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
            {/* Viñeta button at bottom-right corner of block */}
            <button
              className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
              style={{
                left: sx1,
                top: sy1,
                transform: 'translate(-100%, -100%)',
                background: isHovered ? 'rgb(99,102,241)' : 'rgba(255,255,255,0.85)',
                border: isHovered ? 'none' : '1px solid rgba(99,102,241,0.35)',
                color: isHovered ? 'white' : 'rgb(99,102,241)',
                fontSize: '8px',
                fontWeight: 700,
                boxShadow: isHovered ? '0 2px 8px rgba(99,102,241,0.4)' : 'none',
              }}
              onClick={() => onExplain(block.text)}
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

function PdfPage({ pageNumber, width, blocks, onExplain }) {
  const [scale, setScale] = useState(null)

  function handlePageLoad(page) {
    // page.view = [x0, y0, x1, y1] in PDF user-space points (72 DPI)
    const originalWidth = page.view[2] - page.view[0]
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
      <ParagraphOverlay blocks={blocks} scale={scale} onExplain={onExplain} />
    </div>
  )
}

export default function PdfViewer({ file, onExplain, pages }) {
  const [numPages, setNumPages] = useState(null)
  const [containerWidth, setContainerWidth] = useState(null)

  const containerRef = useCallback((node) => {
    if (node) setContainerWidth(node.getBoundingClientRect().width)
  }, [])

  const pageWidth = containerWidth ? containerWidth - 48 : undefined

  // page number → blocks lookup
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
            />
          ))}
      </Document>
    </div>
  )
}
