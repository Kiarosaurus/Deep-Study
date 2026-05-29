import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import PdfViewer from '../components/PdfViewer'
import Sidebar from '../components/Sidebar'
import { buildContinuationPayloads, resolveSentenceIndices, logSentence } from '../components/highlight-utils'

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

function djb2(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
}

// Cache key version. Bump when stored explanation shape changes so stale
// entries from old shapes get orphaned instead of mis-deserialized.
const EXPLAIN_CACHE_VERSION = 'v2'

function explainCacheKey(filename, text, opts = {}) {
  // Figures/tables have no representative text — key on role+page+bbox so a
  // recropped or relocated figure invalidates correctly.
  if (opts.role === 'figure' || opts.role === 'table' || opts.role === 'algorithm') {
    const b = opts.bbox || {}
    const tag = `${opts.role}:${opts.page}:${b.x0},${b.y0},${b.x1},${b.y1}`
    return `deepstudy:explain:${EXPLAIN_CACHE_VERSION}:${filename}:${djb2(tag)}`
  }
  return `deepstudy:explain:${EXPLAIN_CACHE_VERSION}:${filename}:${djb2(text)}`
}

function readCachedExplanation(filename, text, memCache, opts = {}) {
  const key = explainCacheKey(filename, text, opts)
  if (memCache.has(key)) return memCache.get(key)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    memCache.set(key, parsed)
    return parsed
  } catch {
    return null
  }
}

function writeCachedExplanation(filename, text, data, memCache, opts = {}) {
  const key = explainCacheKey(filename, text, opts)
  memCache.set(key, data)
  try {
    localStorage.setItem(key, JSON.stringify(data))
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

  const uiStateRef = useRef({ tab, explainMode })
  useEffect(() => {
    uiStateRef.current = { tab, explainMode }
  }, [tab, explainMode])

  // Auto-switch after receiving a real explanation. Skeleton placeholders set
  // explanation before the fetch resolves; don't yank the user out of the
  // global map for a loading state.
  useEffect(() => {
    if (explanation && !explanation.__skeleton) setTab('explain')
  }, [explanation])

  const explanationsCache = useRef(new Map())
  const viewerRef         = useRef(null)
  const explainRequestId  = useRef(0)
  const explanationRef    = useRef(null)
  const currentIndexRef   = useRef(0)
  useEffect(() => { explanationRef.current  = explanation  }, [explanation])
  useEffect(() => { currentIndexRef.current = currentIndex }, [currentIndex])

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

  // Chain payloads — one shared object per continuation chain.
  const chainPayloads = useMemo(
    () => buildContinuationPayloads(linearBlocks),
    [linearBlocks],
  )

  // Navigable list — paragraphs (one entry per continuation chain) + figures/
  // tables, in reading order. Figures carry the opts handleExplain needs.
  const paragraphList = useMemo(() => {
    // Single pass: text → list of paragraph linearBlocks indices sharing that
    // chain. O(n) vs O(n²) nested scan.
    const chainMembers = new Map()
    for (let i = 0; i < linearBlocks.length; i++) {
      if (linearBlocks[i].role !== 'paragraph') continue
      const pay = chainPayloads[i]
      if (!pay) continue
      const list = chainMembers.get(pay.text)
      if (list) list.push(i)
      else chainMembers.set(pay.text, [i])
    }

    const items = []
    const seenTexts = new Set()
    for (let i = 0; i < linearBlocks.length; i++) {
      const b = linearBlocks[i]
      if (b.role === 'paragraph') {
        const pay = chainPayloads[i]
        if (!pay || seenTexts.has(pay.text)) continue
        seenTexts.add(pay.text)
        items.push({
          kind: 'paragraph',
          linearIdx: i,
          linearIdxs: chainMembers.get(pay.text) ?? [i],
          text: pay.text,
          sentences: pay.mergedSentences ?? pay.sentences,
          flat_block_ref: b.flat_block_ref,
        })
      } else if (b.role === 'figure' || b.role === 'table' || b.role === 'algorithm') {
        items.push({
          kind: 'figure',
          linearIdx: i,
          linearIdxs: [i],
          text: b.caption_text || '',
          sentences: [],
          flat_block_ref: b.flat_block_ref ?? null,
          role: b.role,
          page: b.page,
          bbox: b.bbox,
          caption_text: b.caption_text || '',
        })
      }
    }
    return items
  }, [linearBlocks, chainPayloads])


  // Expand AI explanations into one carousel entry per original sentence: real
  // items emitted at their first covered index, placeholders for gaps. Keeps
  // original item shape (quote / sentence_indices / concepts) so highlighting
  // via resolveSentenceIndices keeps working.
  const alignExplanations = (aiData, originalSentences) => {
    if (!originalSentences?.length) return aiData
    if (!aiData || !Array.isArray(aiData.sentence_explanations)) return aiData
    const raw = aiData.sentence_explanations
    const N = originalSentences.length

    const sentToItem = new Map()
    raw.forEach((item, idx) => {
      const idxs = Array.isArray(item?.sentence_indices) ? item.sentence_indices : []
      for (const k of idxs) {
        if (Number.isInteger(k) && k >= 0 && k < N && !sentToItem.has(k)) {
          sentToItem.set(k, idx)
        }
      }
    })

    const aligned = []
    const emitted = new Set()
    for (let i = 0; i < N; i++) {
      const itemIdx = sentToItem.get(i)
      if (itemIdx !== undefined) {
        if (emitted.has(itemIdx)) continue
        emitted.add(itemIdx)
        aligned.push(raw[itemIdx])
      } else {
        const sText = originalSentences[i]?.text ?? ''
        aligned.push({
          sentence_indices: [i],
          quote: sText,
          concepts: [],
          is_placeholder: true,
        })
      }
    }

    // Defensive: keep items whose declared indices were all out of range so the
    // user still sees what the LLM produced even if it mislabeled.
    raw.forEach((item, idx) => {
      if (emitted.has(idx)) return
      const idxs = Array.isArray(item?.sentence_indices) ? item.sentence_indices : []
      const hasValid = idxs.some(k => Number.isInteger(k) && k >= 0 && k < N)
      if (!hasValid) aligned.push(item)
    })

    return { ...aiData, sentence_explanations: aligned }
  }

  // One placeholder per sentence so highlights + carousel slots show
  // immediately, before the AI fetch resolves. Marked with __skeleton so the
  // tab-auto-switch effect and index re-anchor logic can tell it apart from a
  // real response.
  const buildSkeletonExplanation = (sentences) => {
    if (!sentences?.length) return null
    return {
      __skeleton: true,
      sentence_explanations: sentences.map((s, i) => ({
        sentence_indices: [i],
        quote: s?.text ?? '',
        concepts: [],
        is_placeholder: true,
      })),
      paragraph_context: null,
    }
  }

  const handleExplain = useCallback(async (text, sentences, flatBlockRef = null, opts = {}) => {
    if (!analysis) return
    const { initialIndex = 0, role, page, bbox, caption_text } = opts
    const isFigure = role === 'figure' || role === 'table' || role === 'algorithm'

    // Stamp this call so an earlier in-flight fetch can't overwrite a later
    // user action (e.g. retry-throttled A resolving after the user clicked B).
    const myReqId = ++explainRequestId.current
    const isCurrent = () => myReqId === explainRequestId.current

    setActiveParagraph({ text, flatBlockRef, role, page, bbox })
    setCurrentIndex(initialIndex === 'last' ? 0 : initialIndex)
    setErrorExplain(null)
    setRetryInfo(null)

    logSentence('handleExplain.input', {
      flatBlockRef,
      role,
      page,
      isFigure,
      sentenceCount: sentences?.length ?? 0,
      sentences: (sentences ?? []).map((s, i) => ({
        idx: i,
        boxes: s?.boxes?.length ?? 0,
        text: (s?.text ?? '').slice(0, 100),
      })),
      paragraphText: (text ?? '').slice(0, 200),
    })

    const cacheOpts = { role, page, bbox }
    const cached = readCachedExplanation(decoded, text, explanationsCache.current, cacheOpts)
    if (cached) {
      logSentence('handleExplain.cacheHit', {
        rawItems: (cached.sentence_explanations ?? []).map((it, i) => ({
          itemIdx: i,
          sentence_indices: it?.sentence_indices,
          quote: (it?.quote ?? '').slice(0, 100),
        })),
      })
      const alignedCached = alignExplanations(cached, sentences)
      logSentence('handleExplain.aligned', {
        source: 'cache',
        alignedItems: (alignedCached.sentence_explanations ?? []).map((it, i) => ({
          slot: i,
          sentence_indices: it?.sentence_indices,
          placeholder: !!it?.is_placeholder,
          quote: (it?.quote ?? '').slice(0, 100),
        })),
      })
      setExplanation(alignedCached)
      if (initialIndex === 'last') {
        setCurrentIndex(Math.max(0, (alignedCached.sentence_explanations?.length || 1) - 1))
      }
      return
    }

    // Paragraphs: seed carousel with skeleton so highlights + slots render
    // pre-fetch. Figures have no sentence geometry → fall back to clearing.
    if (!isFigure && sentences?.length) {
      setExplanation(buildSkeletonExplanation(sentences))
      if (initialIndex === 'last') {
        setCurrentIndex(Math.max(0, sentences.length - 1))
      }
    } else {
      setExplanation(null)
    }

    setLoadingExplain(true)
    try {
      const payload = isFigure
        ? {
            paragraph_sentences: [],
            global_map: analysis.global_map,
            block_type: role,
            filename: decoded,
            page,
            bbox,
            caption_text: caption_text || '',
          }
        : {
            paragraph_sentences: (sentences ?? []).map(s => s.text),
            global_map: analysis.global_map,
          }
      const data = await postExplainWithRetry(
        payload,
        (attempt, maxAttempts, delayMs) => {
          if (isCurrent()) setRetryInfo({ attempt, maxAttempts, delayMs })
        },
      )

      // Cache raw response unconditionally (it's still valid for this text);
      // only commit to UI state when this call is still the latest.
      writeCachedExplanation(decoded, text, data, explanationsCache.current, cacheOpts)
      if (!isCurrent()) return

      logSentence('handleExplain.llmResponse', {
        rawItems: (data?.sentence_explanations ?? []).map((it, i) => ({
          itemIdx: i,
          sentence_indices: it?.sentence_indices,
          quote: (it?.quote ?? '').slice(0, 100),
          concepts: (it?.concepts ?? []).length,
        })),
      })

      const alignedData = alignExplanations(data, sentences)

      logSentence('handleExplain.aligned', {
        source: 'fresh',
        alignedItems: (alignedData.sentence_explanations ?? []).map((it, i) => ({
          slot: i,
          sentence_indices: it?.sentence_indices,
          placeholder: !!it?.is_placeholder,
          quote: (it?.quote ?? '').slice(0, 100),
        })),
      })

      // Re-anchor currentIndex: if the user was on a skeleton slot for sentence
      // S, jump to the aligned item that covers S — keeps cursor on the same
      // sentence even when grouping shifts other slots around it.
      const prevExp = explanationRef.current
      const prevIdx = currentIndexRef.current
      let nextIdx = (initialIndex === 'last')
        ? Math.max(0, (alignedData.sentence_explanations?.length || 1) - 1)
        : initialIndex
      if (prevExp?.__skeleton && !isFigure
          && Array.isArray(prevExp.sentence_explanations)
          && Array.isArray(alignedData.sentence_explanations)) {
        const prevItem = prevExp.sentence_explanations[prevIdx]
        const prevSentenceIdx = prevItem?.sentence_indices?.[0]
        if (Number.isInteger(prevSentenceIdx)) {
          const found = alignedData.sentence_explanations.findIndex(it =>
            Array.isArray(it?.sentence_indices) && it.sentence_indices.includes(prevSentenceIdx),
          )
          if (found >= 0) nextIdx = found
        }
      }

      setExplanation(alignedData)
      setCurrentIndex(nextIdx)

    } catch (err) {
      if (isCurrent()) {
        setErrorExplain(buildExplainError(err))
        setExplanation(null)
      }
    } finally {
      if (isCurrent()) {
        setLoadingExplain(false)
        setRetryInfo(null)
      }
    }
  }, [analysis, decoded])

  const handleHome = useCallback(() => navigate('/'), [navigate])

  // Keyboard navigation: m = global, , = explain-contexto, . = explain-conceptos, arrows to navigate explanations
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return

      const items = explanation?.sentence_explanations ?? []

      const dispatch = (entry, initialIndex = 0) => {
        if (!entry) return
        if (entry.kind === 'figure') {
          handleExplain(entry.text, [], entry.flat_block_ref, {
            initialIndex,
            role: entry.role,
            page: entry.page,
            bbox: entry.bbox,
            caption_text: entry.caption_text,
          })
        } else {
          handleExplain(entry.text, entry.sentences, entry.flat_block_ref, { initialIndex })
        }
        if (entry.linearIdx != null) {
          // 'last' lands on the trailing sentence — usually in the last chain
          // member, not the head. Aim the scroll there so the cursor's
          // sentence is the part centered, not the chain start on a prior page.
          const targetIdx = (initialIndex === 'last' && Array.isArray(entry.linearIdxs) && entry.linearIdxs.length)
            ? entry.linearIdxs[entry.linearIdxs.length - 1]
            : entry.linearIdx
          viewerRef.current?.centerBlock(targetIdx, {
            onlyIfHidden: true,
            alternatives: entry.linearIdxs,
          })
        }
      }

      const matchActive = (entry) => {
        if (!entry || !activeParagraph) return false
        if (entry.kind === 'paragraph') return entry.text === activeParagraph.text
        return entry.kind === 'figure'
          && activeParagraph.role === entry.role
          && activeParagraph.page === entry.page
          && activeParagraph.bbox?.x0 === entry.bbox?.x0
          && activeParagraph.bbox?.y0 === entry.bbox?.y0
      }

      // Resolve the linearBlocks index + sentence boxes for the first
      // highlighted sentence of an item. For chain paragraphs we pick the
      // chain member covering the smallest merged sentence index — i.e. the
      // earlier reading-order fragment when a sentence is split across blocks.
      const sentenceTargetForItem = (item) => {
        if (!activeParagraph) return null
        if (activeParagraph.role === 'figure' || activeParagraph.role === 'table' || activeParagraph.role === 'algorithm') {
          for (let i = 0; i < linearBlocks.length; i++) {
            const b = linearBlocks[i]
            if (b.role === activeParagraph.role
                && b.page === activeParagraph.page
                && b.bbox?.x0 === activeParagraph.bbox?.x0
                && b.bbox?.y0 === activeParagraph.bbox?.y0) {
              return { idx: i, boxes: null, isFigure: true }
            }
          }
          return null
        }
        const text = activeParagraph.text
        if (!text) return null
        const members = []
        for (let i = 0; i < linearBlocks.length; i++) {
          if (linearBlocks[i].role !== 'paragraph') continue
          const pay = chainPayloads[i]
          if (!pay || pay.text !== text) continue
          members.push({
            idx: i,
            offset: pay.offset ?? 0,
            length: linearBlocks[i].sentences?.length ?? 0,
          })
        }
        if (members.length === 0) return null
        if (!item) return { idx: members[0].idx, boxes: null, isFigure: false }
        const payload = chainPayloads[members[0].idx]
        const indices = resolveSentenceIndices(payload.sentences, item)
        if (!indices.length) return { idx: members[0].idx, boxes: null, isFigure: false }
        const minK = Math.min(...indices)
        const member = members.find(m => minK >= m.offset && minK < m.offset + m.length)
        if (!member) return { idx: members[0].idx, boxes: null, isFigure: false }
        const localIdx = minK - member.offset
        const block = linearBlocks[member.idx]
        const boxes = block.sentences?.[localIdx]?.boxes ?? []
        return { idx: member.idx, boxes, isFigure: false }
      }

      const centerForItem = (item, onlyIfNotFullyVisible) => {
        const target = sentenceTargetForItem(item)
        if (!target) return
        if (target.isFigure || !target.boxes?.length) {
          viewerRef.current?.centerBlock(target.idx, { onlyIfHidden: onlyIfNotFullyVisible })
        } else {
          viewerRef.current?.centerSentence(target.idx, target.boxes, { onlyIfNotFullyVisible })
        }
      }

      if (e.key === ' ' || e.code === 'Space') {
        const cur = items[currentIndex]
        if (cur && activeParagraph) {
          e.preventDefault()
          centerForItem(cur, false)
        }
        return
      }

      if (e.key === '<') {
        e.preventDefault()
        const currentTab = uiStateRef.current.tab
        const currentMode = uiStateRef.current.explainMode

        if (!activeParagraph && paragraphList[0]) {
          dispatch(paragraphList[0], 0)
          setTab('explain')
          setExplainMode('contexto')
          uiStateRef.current = { tab: 'explain', explainMode: 'contexto' }
          return
        }

        if (currentTab === 'global') {
          setTab('explain')
          setExplainMode('contexto')
          uiStateRef.current = { tab: 'explain', explainMode: 'contexto' }
        } else if (currentTab === 'explain') {
          const nextMode = currentMode === 'contexto' ? 'conceptos' : 'contexto'
          setExplainMode(nextMode)
          uiStateRef.current = { tab: 'explain', explainMode: nextMode }
        }
        return
      }

      if (e.key === '-') {
        setTab('global')
        uiStateRef.current = { ...uiStateRef.current, tab: 'global' }
        return
      }
      if (e.key === ',') {
        setTab('explain')
        setExplainMode('contexto')
        uiStateRef.current = { tab: 'explain', explainMode: 'contexto' }
        return
      }
      if (e.key === '.') {
        setTab('explain')
        setExplainMode('conceptos')
        uiStateRef.current = { tab: 'explain', explainMode: 'conceptos' }
        return
      }
      if (e.key === 'ArrowRight') {
        if (!activeParagraph) {
          if (paragraphList[0]) {
            e.preventDefault()
            dispatch(paragraphList[0], 0)
          }
          return
        }

        e.preventDefault()
        if (currentIndex < items.length - 1) {
          const nextIdx = currentIndex + 1
          setCurrentIndex(nextIdx)
          centerForItem(items[nextIdx], true)
        } else {
          const curIdx = paragraphList.findIndex(matchActive)
          dispatch(paragraphList[curIdx + 1], 0)
        }
      }

      if (e.key === 'ArrowLeft') {
        if (!activeParagraph) {
          if (paragraphList[0]) {
            e.preventDefault()
            dispatch(paragraphList[0], 0)
          }
          return
        }

        e.preventDefault()
        if (currentIndex > 0) {
          const nextIdx = currentIndex - 1
          setCurrentIndex(nextIdx)
          centerForItem(items[nextIdx], true)
        } else {
          const curIdx = paragraphList.findIndex(matchActive)
          dispatch(paragraphList[curIdx - 1], 'last')
        }
      }
    }

    // Capture phase so focused Sidebar buttons don't swallow Space (their
    // bubble-phase activation runs after our handler in capture).
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [explanation, currentIndex, activeParagraph, paragraphList, handleExplain, linearBlocks, chainPayloads])

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
          ref={viewerRef}
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
