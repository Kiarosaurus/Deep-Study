import { useState, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export default function PdfViewer({ file }) {
  const [numPages, setNumPages] = useState(null)
  const [containerWidth, setContainerWidth] = useState(null)

  const containerRef = useCallback((node) => {
    if (node) setContainerWidth(node.getBoundingClientRect().width)
  }, [])

  return (
    <div ref={containerRef} className="flex flex-col items-center py-8 px-6 bg-gray-100 min-h-full">
      <Document
        file={file}
        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
        loading={
          <p className="text-slate-400 text-sm mt-16">Cargando PDF...</p>
        }
        error={
          <p className="text-red-500 text-sm mt-16">No se pudo cargar el PDF.</p>
        }
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
  )
}
