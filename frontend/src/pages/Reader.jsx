import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import PdfViewer from '../components/PdfViewer'
import Sidebar from '../components/Sidebar'

export default function Reader() {
  const { filename } = useParams()
  const navigate = useNavigate()
  const decoded = decodeURIComponent(filename)

  const [analysis, setAnalysis] = useState(null)
  const [loadingAnalysis, setLoadingAnalysis] = useState(true)
  const [errorAnalysis, setErrorAnalysis] = useState(null)

  const [explanation, setExplanation] = useState(null)
  const [loadingExplain, setLoadingExplain] = useState(false)
  const [errorExplain, setErrorExplain] = useState(null)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [activeParagraph, setActiveParagraph] = useState(null)

  const explanationsCache = useRef(new Map())

  const pdfUrl = `/api/documents/${encodeURIComponent(decoded)}`

  useEffect(() => {
    axios.get(`/api/documents/${encodeURIComponent(decoded)}/analysis`)
      .then(res => setAnalysis(res.data))
      .catch(() => setErrorAnalysis('No se encontró el análisis del documento.'))
      .finally(() => setLoadingAnalysis(false))
  }, [decoded])

  useEffect(() => {
    setCurrentIndex(0)
  }, [explanation])

  async function handleExplain(text, bbox) {
    if (!analysis) return
    setActiveParagraph({ text, bbox })
    setCurrentIndex(0)

    if (explanationsCache.current.has(text)) {
      setErrorExplain(null)
      setExplanation(explanationsCache.current.get(text))
      return
    }

    setLoadingExplain(true)
    setErrorExplain(null)
    try {
      const res = await axios.post('/api/explain-paragraph/', {
        paragraph_text: text,
        global_map: analysis.global_map,
      })
      explanationsCache.current.set(text, res.data)
      setExplanation(res.data)
    } catch {
      setErrorExplain('Error al explicar el párrafo.')
    } finally {
      setLoadingExplain(false)
    }
  }

  const highlightTerm = explanation?.explanations?.[currentIndex]?.term ?? null

  if (loadingAnalysis) {
    return (
      <div className="h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
          <p className="text-sm text-slate-500">Cargando documento...</p>
        </div>
      </div>
    )
  }

  if (errorAnalysis) {
    return (
      <div className="h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-500 mb-4">{errorAnalysis}</p>
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
    <div className="flex h-screen overflow-hidden bg-white">
      <button
        onClick={() => navigate('/')}
        className="absolute top-4 left-4 z-20 flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 bg-white/90 backdrop-blur px-3 py-1.5 rounded-xl border border-slate-200 shadow-sm transition-colors"
      >
        ← Inicio
      </button>

      <div className="overflow-y-auto min-w-0" style={{ flex: 7 }}>
        <PdfViewer
          file={pdfUrl}
          onExplain={handleExplain}
          pages={analysis?.pages}
          activeParagraph={activeParagraph}
          highlightTerm={highlightTerm}
        />
      </div>

      <div className="border-l border-slate-200 overflow-hidden min-w-0" style={{ flex: 3 }}>
        <Sidebar
          globalMap={analysis?.global_map}
          explanation={explanation}
          loadingGlobal={false}
          loadingExplain={loadingExplain}
          errorGlobal={null}
          errorExplain={errorExplain}
          currentIndex={currentIndex}
          onIndexChange={setCurrentIndex}
        />
      </div>
    </div>
  )
}
