import { useState, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export default function PdfViewer({ file, onExplain, canExplain }) {
  const [numPages, setNumPages] = useState(null)
  const [containerWidth, setContainerWidth] = useState(null)
  const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0, text: '' })

  const containerRef = useCallback((node) => {
    if (node) setContainerWidth(node.getBoundingClientRect().width)
  }, [])

  function handleMouseUp() {
    if (!canExplain) return
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (text && text.length > 20) {
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setTooltip({ visible: true, x: rect.left + rect.width / 2, y: rect.top, text })
    } else {
      setTooltip((t) => ({ ...t, visible: false }))
    }
  }

  function handleExplainClick() {
    onExplain(tooltip.text)
    setTooltip((t) => ({ ...t, visible: false }))
    window.getSelection().removeAllRanges()
  }

  return (
    <>
      {tooltip.visible && (
        <button
          onClick={handleExplainClick}
          style={{ top: tooltip.y - 40, left: tooltip.x, transform: 'translateX(-50%)' }}
          className="fixed z-50 bg-indigo-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-lg hover:bg-indigo-700 transition-colors whitespace-nowrap"
        >
          ✦ Explicar selección
        </button>
      )}
      <div
        ref={containerRef}
        onMouseUp={handleMouseUp}
        className="flex flex-col items-center py-8 px-6 bg-gray-100 min-h-full"
      >
        <Document
          file={file}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          loading={<p className="text-slate-400 text-sm mt-16">Cargando PDF...</p>}
          error={<p className="text-red-500 text-sm mt-16">No se pudo cargar el PDF.</p>}
        >
          {numPages &&
            Array.from({ length: numPages }, (_, i) => (
              <div key={i} className="shadow-xl mb-5">
                <Page
                  pageNumber={i + 1}
                  width={containerWidth ? containerWidth - 48 : undefined}
                  renderTextLayer
                  renderAnnotationLayer
                />
              </div>
            ))}
        </Document>
      </div>
    </>
  )
}
