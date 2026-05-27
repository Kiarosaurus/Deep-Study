import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import PdfViewer from '../components/PdfViewer'
import Sidebar from '../components/Sidebar'

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

async function postExplainWithRetry(payload, onRetry, maxAttempts = 3) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.post('/api/explain-paragraph/', payload)
      return res.data
    } catch (err) {
      lastErr = err
      const status = err?.response?.status
      const isNetwork = !err?.response && err?.code !== 'ECONNABORTED'
      const retryable = isNetwork || RETRYABLE_STATUSES.has(status)
      if (!retryable || attempt === maxAttempts) throw err
      const delayMs = 1000 * 2 ** (attempt - 1)
      onRetry?.(attempt, maxAttempts, delayMs)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

function explainCacheKey(filename, text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i)
  return `deepstudy:explain:${filename}:${(h >>> 0).toString(36)}`
}

function readCachedExplanation(filename, text, memCache) {
  if (memCache.has(text)) return memCache.get(text)
  try {
    const raw = localStorage.getItem(explainCacheKey(filename, text))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    memCache.set(text, parsed)
    return parsed
  } catch {
    return null
  }
}

function writeCachedExplanation(filename, text, data, memCache) {
  memCache.set(text, data)
  try {
    localStorage.setItem(explainCacheKey(filename, text), JSON.stringify(data))
  } catch {
    // localStorage full or unavailable — ignore, mem cache still holds it
  }
}

function buildExplainError(err) {
  if (err?.code === 'ECONNABORTED') {
    return 'La solicitud tardó demasiado y se canceló. Reintenta el botón "Explicar".'
  }
  if (!err?.response) {
    return 'No se pudo conectar con el servidor. Verifica que el backend esté corriendo en :8000 e inténtalo de nuevo.'
  }
  const status = err.response.status
  const detail = err.response.data?.detail ?? ''

  if (status === 400) {
    return `Solicitud inválida: ${detail || 'el párrafo no tiene oraciones para explicar.'}`
  }
  if (status === 502) {
    const lower = detail.toLowerCase()
    if (lower.includes('truncated') || lower.includes('max_tokens')) {
      return 'El modelo devolvió una respuesta incompleta (límite de tokens). Reintenta — suele resolverse al segundo intento.'
    }
    if (lower.includes('invalid json')) {
      return 'El modelo devolvió un JSON malformado. Reintenta — es un error transitorio del LLM.'
    }
    if (lower.includes('429') || lower.includes('rate') || lower.includes('quota')) {
      return 'Límite de tasa de Gemini alcanzado. Espera unos segundos y reintenta.'
    }
    if (lower.includes('empty response')) {
      return 'El modelo no devolvió contenido (posible filtro de seguridad). Reintenta o prueba otro párrafo.'
    }
    return `Error de Gemini: ${detail || 'fallo transitorio'}. Reintenta el botón "Explicar".`
  }
  if (status >= 500) {
    return `Error del servidor (${status}). Reintenta en unos segundos.`
  }
  return `Error inesperado (${status}): ${detail || 'sin detalles'}.`
}

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
  const [retryInfo, setRetryInfo] = useState(null)

  const [tab, setTab] = useState('global')
  const [explainMode, setExplainMode] = useState('conceptos')

  // Auto-switch after receiving an explanation
  useEffect(() => {
    if (explanation) setTab('explain')
  }, [explanation])

  const explanationsCache = useRef(new Map())

  const pdfUrl = `/api/documents/${encodeURIComponent(decoded)}`

  useEffect(() => {
    axios.get(`/api/documents/${encodeURIComponent(decoded)}/analysis`)
      .then(res => setAnalysis(res.data))
      .catch(() => setErrorAnalysis('No se encontró el análisis del documento.'))
      .finally(() => setLoadingAnalysis(false))
  }, [decoded])

  const linearBlocks = useMemo(
    () => analysis?.linear_blocks ?? [],
    [analysis],
  )

  // Precompute list of paragraphs for easy access
  const paragraphList = useMemo(
    () => linearBlocks.filter(b => b.role === 'paragraph'),
    [linearBlocks]
  )

  const handleExplain = useCallback(async (text, sentences, flatBlockRef = null, initialIndex = 0) => {
    if (!analysis) return
    setActiveParagraph({ text, flatBlockRef })
    setCurrentIndex(initialIndex)

    const cached = readCachedExplanation(decoded, text, explanationsCache.current)
    if (cached) {
      setErrorExplain(null)
      setRetryInfo(null)
      setExplanation(cached)
      return
    }

    setLoadingExplain(true)
    setErrorExplain(null)
    setRetryInfo(null)
    try {
      const data = await postExplainWithRetry(
        {
          paragraph_sentences: (sentences ?? []).map(s => s.text),
          global_map: analysis.global_map,
        },
        (attempt, maxAttempts, delayMs) =>
          setRetryInfo({ attempt, maxAttempts, delayMs }),
      )
      writeCachedExplanation(decoded, text, data, explanationsCache.current)
      setExplanation(data)
    } catch (err) {
      setErrorExplain(buildExplainError(err))
    } finally {
      setLoadingExplain(false)
      setRetryInfo(null)
    }
  }, [analysis, decoded])

  const handleHome = useCallback(() => navigate('/'), [navigate])

  // Keyboard navigation: m = global, , = explain-contexto, . = explain-conceptos, arrows to navigate explanations
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return

      if (e.key === 'Tab') {
        e.preventDefault()
        
        if (tab === 'global') {
          setTab('explain')
          setExplainMode('contexto')
        } else if (tab === 'explain') {
          setExplainMode(prev => prev === 'contexto' ? 'conceptos' : 'contexto')
        }
        return
      }

      if (e.key === ',') {
        setTab('global')
        return
      }
      if (e.key === '.') {
        setTab('explain')
        setExplainMode('contexto')
        return
      }
      if (e.key === '-') {
        setTab('explain')
        setExplainMode('conceptos')
        return
      }

      const items = explanation?.sentence_explanations ?? []
      
      if (e.key === 'ArrowRight') {
        if (items.length === 0) return // No explanations to navigate
        e.preventDefault()
        if (currentIndex < items.length - 1) {
          setCurrentIndex(i => i + 1)
        } else {
          // Cross-paragraph: Jump to next paragraph
          const curParaIdx = paragraphList.findIndex(
            b => b.flat_block_ref === activeParagraph?.flatBlockRef
          )
          const next = paragraphList[curParaIdx + 1]
          if (next) handleExplain(next.text, next.sentences, next.flat_block_ref, 0)
        }
      }
      
      if (e.key === 'ArrowLeft') {
        if (items.length === 0) return
        e.preventDefault()
        if (currentIndex > 0) {
          setCurrentIndex(i => i - 1)
        } else {
          // Cross-paragraph: Jump to previous paragraph
          const curParaIdx = paragraphList.findIndex(
            b => b.flat_block_ref === activeParagraph?.flatBlockRef
          )
          const prev = paragraphList[curParaIdx - 1]
          if (prev) {
            const lastIdx = Math.max(0, (prev.sentences?.length || 1) - 1)
            handleExplain(prev.text, prev.sentences, prev.flat_block_ref, lastIdx)
          }
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [explanation, currentIndex, activeParagraph, paragraphList, handleExplain, tab, explainMode])

  const currentExplanation = explanation?.sentence_explanations?.[currentIndex] ?? null

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
      <div className="relative min-w-0 overflow-hidden" style={{ flex: 7 }}>
        <PdfViewer
          file={pdfUrl}
          onExplain={handleExplain}
          pages={analysis?.pages}
          linearBlocks={linearBlocks}
          activeParagraph={activeParagraph}
          currentExplanation={currentExplanation}
          explanation={explanation}
          onHome={handleHome}
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
          retryInfo={retryInfo}
          tab={tab}
          onTabChange={setTab}
          explainMode={explainMode}
          onExplainModeChange={setExplainMode}
        />
      </div>
    </div>
  )
}
