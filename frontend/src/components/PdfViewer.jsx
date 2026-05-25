import { useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export default function PdfViewer({ file = '/test.pdf' }) {
  const [numPages, setNumPages] = useState(null)

  return (
    <div className="bg-gray-100 min-h-screen flex flex-col items-center py-8 px-4">
      <Document
        file={file}
        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
        loading={<p className="text-slate-500 text-sm mt-12">Cargando PDF...</p>}
        error={<p className="text-red-500 text-sm mt-12">No se pudo cargar el PDF.</p>}
      >
        {numPages &&
          Array.from({ length: numPages }, (_, i) => (
            <div key={i} className="shadow-xl mb-6">
              <Page
                pageNumber={i + 1}
                renderTextLayer
                renderAnnotationLayer
              />
            </div>
          ))}
      </Document>
    </div>
  )
}
