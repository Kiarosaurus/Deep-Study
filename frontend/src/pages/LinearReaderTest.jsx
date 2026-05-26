import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import LinearReader from '../components/LinearReader'

export default function LinearReaderTest() {
  const { filename } = useParams()
  const navigate = useNavigate()
  const decoded = decodeURIComponent(filename)

  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState(null)
  const [containerWidth, setContainerWidth] = useState(null)
  const containerRef = useRef(null)

  const pdfUrl = `/api/documents/${encodeURIComponent(decoded)}`

  useEffect(() => {
    axios
      .get(`/api/documents/${encodeURIComponent(decoded)}/analysis`)
      .then(res => setAnalysis(res.data))
      .catch(() => setError('No se encontró el análisis del documento.'))
  }, [decoded])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    setContainerWidth(node.getBoundingClientRect().width)
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w) setContainerWidth(w)
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const pageDims = useMemo(
    () => analysis?.pages
      ? Object.fromEntries(
          analysis.pages.map(p => [p.page, { width: p.width, height: p.height }]),
        )
      : {},
    [analysis],
  )

  const readingContentWidth = containerWidth ? Math.min(containerWidth - 96, 880) : null

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-500 mb-4">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors"
          >
            Volver al inicio
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-screen overflow-auto bg-white">
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200 px-6 py-2 text-xs text-slate-500 flex items-center gap-3">
        <button
          onClick={() => navigate('/')}
          className="px-2 py-1 rounded hover:bg-slate-100 text-slate-600"
        >
          ← Inicio
        </button>
        <span className="font-semibold text-slate-700">{decoded}</span>
        <span className="ml-auto">LinearReader dev preview</span>
      </div>
      {analysis && readingContentWidth && (
        <LinearReader
          pdfFile={pdfUrl}
          linearBlocks={analysis.linear_blocks || []}
          pageDims={pageDims}
          contentWidth={readingContentWidth}
          userZoom={1}
        />
      )}
    </div>
  )
}
