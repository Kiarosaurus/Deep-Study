// Loads a pdfjs PDFDocumentProxy from a URL/ArrayBuffer. The doc survives
// across consumer mount/unmount cycles in the same React tree as long as the
// hook is held by a parent that doesn't itself unmount.
//
// Cleanup destroys the doc when pdfFile changes or the holder unmounts, which
// releases pdfjs worker resources.

import { useEffect, useState } from 'react'
import { pdfjs } from 'react-pdf'

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()
}

export function usePdfDocument(pdfFile) {
  const [doc, setDoc] = useState(null)

  useEffect(() => {
    // No pdfFile → no load. The previous effect's cleanup (if any) already
    // ran and nulled the doc, so we don't need to setDoc(null) here.
    if (!pdfFile) return
    let cancelled = false
    let loadedDoc = null

    pdfjs.getDocument(pdfFile).promise
      .then(d => {
        if (cancelled) {
          d.destroy?.()
          return
        }
        loadedDoc = d
        setDoc(d)
      })
      .catch(err => {
        if (!cancelled) console.error('usePdfDocument: getDocument failed', err)
      })

    return () => {
      cancelled = true
      if (loadedDoc) loadedDoc.destroy?.()
      setDoc(null)
    }
  }, [pdfFile])

  return doc
}
