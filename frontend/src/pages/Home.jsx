import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import axios from 'axios'
import PdfUploader from '../components/PdfUploader'
import OverwriteModal from '../components/OverwriteModal'
import LanguageSwitcher from '../i18n/LanguageSwitcher'
import { useUiLang } from '../i18n/LanguageContext'
import { ThemeSwitch } from '../theme/ThemeToggle'
import { SettingsButton } from '../settings/SettingsModal'

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DocumentCard({ doc, onOpen, onDelete, selectable = false, selected = false, onToggleSelect }) {
  const { t } = useUiLang()
  const [deleting, setDeleting] = useState(false)

  async function handleDelete(e) {
    e.stopPropagation()
    setDeleting(true)
    await onDelete(doc.filename)
  }

  return (
    <div
      onClick={() => (selectable ? onToggleSelect(doc.filename) : onOpen(doc.filename))}
      className={`relative rounded-2xl p-5 flex flex-col gap-3 border transition-all cursor-pointer group ${
        selectable && selected
          ? 'bg-indigo-50/50 border-indigo-400 ring-2 ring-indigo-300'
          : 'bg-white border-slate-200 hover:shadow-md hover:border-indigo-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          {selectable && (
            <span
              className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                selected ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300'
              }`}
            >
              {selected && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
          )}
          <span className="text-3xl">📄</span>
        </div>
        {doc.has_analysis && (
          <span className="text-[10px] font-semibold px-2 py-0.5 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-full shrink-0">
            {t('home.analyzed')}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-800 truncate" title={doc.filename}>
          {doc.filename}
        </p>
        <p className="text-xs text-slate-400 mt-0.5">{formatBytes(doc.size_bytes)}</p>
      </div>
      {!selectable && (
        <div className="flex gap-2" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => onOpen(doc.filename)}
            className="flex-1 text-xs font-semibold py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors"
          >
            {t('common.open')}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors disabled:opacity-40 shrink-0"
            title={t('common.delete')}
          >
            {deleting ? (
              <span className="w-3.5 h-3.5 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin block" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4h6v2" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

function statusBadge(status, t) {
  switch (status) {
    case 'pending':   return { label: t('home.status.pending'),   cls: 'bg-slate-50 text-slate-500 border-slate-200' }
    case 'uploading': return { label: t('home.status.uploading'), cls: 'bg-indigo-50 text-indigo-600 border-indigo-200' }
    case 'analyzing': return { label: t('home.status.analyzing'), cls: 'bg-indigo-50 text-indigo-600 border-indigo-200' }
    case 'fallback':  return { label: t('home.status.fallback'),  cls: 'bg-amber-50 text-amber-700 border-amber-200' }
    case 'conflict':  return { label: t('home.status.conflict'),  cls: 'bg-amber-50 text-amber-600 border-amber-200' }
    case 'done':      return { label: t('home.status.done'),      cls: 'bg-teal-50 text-teal-600 border-teal-200' }
    case 'skipped':   return { label: t('home.status.skipped'),   cls: 'bg-amber-50 text-amber-600 border-amber-200' }
    case 'error':     return { label: t('home.status.error'),     cls: 'bg-red-50 text-red-600 border-red-200' }
    default:          return { label: status,                     cls: 'bg-slate-50 text-slate-500 border-slate-200' }
  }
}

// Translate a backend SSE event into UI state. Successful phases climb the
// bar; fallback phases reset it to 0 and switch the status badge to
// 'fallback' so the user sees something concretely changed. Returns null
// when the event is purely informational and should not update the bar.
function uiUpdateForEvent(ev) {
  if (!ev || !ev.phase) return null
  switch (ev.phase) {
    case 'started':            return { progress: 5,  message: ev.message, status: 'analyzing' }
    case 'device_started':     return { progress: 10, message: ev.message, status: 'analyzing' }
    case 'device_ladder':      return null
    case 'device_skipped':     return { progress: 0,  message: ev.message, status: 'fallback' }
    case 'batch_attempt':
      return ev.tier_index === 0
        ? { progress: 15, message: ev.message, status: 'analyzing' }
        : { progress: 0,  message: ev.message, status: 'fallback' }
    case 'batch_oom':          return { progress: 0,  message: ev.message, status: 'fallback' }
    case 'cuda_oom_abandon':   return { progress: 0,  message: ev.message, status: 'fallback' }
    case 'batch_success':      return { progress: 95, message: ev.message, status: 'analyzing' }
    case 'chunk_tier_started': return { progress: 20, message: ev.message, status: 'fallback' }
    case 'chunk_started':      return { progress: 25, message: ev.message, status: 'analyzing' }
    case 'chunk_progress': {
      const total = Math.max(1, Number(ev.total_chunks) || 1)
      const idx   = Math.max(0, Number(ev.chunk_index) || 0)
      const pct   = Math.min(90, 25 + Math.round((60 * (idx + 1)) / total))
      return { progress: pct, message: ev.message, status: 'analyzing' }
    }
    case 'chunk_oom':          return { progress: 0,  message: ev.message, status: 'fallback' }
    case 'chunked_success':    return { progress: 95, message: ev.message, status: 'analyzing' }
    case 'device_exhausted':   return { progress: 0,  message: ev.message, status: 'fallback' }
    case 'child_error':        return { progress: 0,  message: ev.message, status: 'fallback' }
    case 'global_map_started': return { progress: 97, message: ev.message, status: 'analyzing' }
    case 'done':               return { progress: 100, message: ev.message, status: 'done' }
    case 'failed':             return { progress: 0, message: ev.message, status: 'error' }
    default:                   return { message: ev.message }
  }
}

// Localize an SSE progress event by its `phase`, reading the event's structured
// fields. Falls back to the backend-provided (Spanish) `message` for any phase
// not in the catalog, and to '' when there is no event yet.
function progressMessage(ev, t) {
  if (!ev || !ev.phase) return ''
  const key = `progress.${ev.phase}`
  const out = t(key, ev)
  return out === key ? (ev.message || '') : out
}

function UploadQueueView({ queue, currentIdx, allDone, onClose, onOpen }) {
  const { t } = useUiLang()
  const doneCount = queue.filter(q => q.status === 'done').length
  const errorCount = queue.filter(q => q.status === 'error').length
  const skippedCount = queue.filter(q => q.status === 'skipped').length

  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center px-6 py-10">
      {/* Theme (light/sepia/dark) + UI-language controls — usable even while the
          queue is still uploading/analyzing, mirroring the library header. */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2.5">
        <ThemeSwitch />
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-lg flex flex-col gap-5">
        <div className="text-center">
          {allDone ? (
            <>
              <p className="font-bold text-slate-800 text-xl">{t('home.analysisComplete')}</p>
              <p className="text-sm text-slate-500 mt-1">
                {t('home.doneSummary', { done: doneCount, error: errorCount, skipped: skippedCount })}
              </p>
            </>
          ) : (
            <>
              <p className="font-bold text-slate-800 text-xl">
                {t('home.processing', { current: Math.min(currentIdx + 1, queue.length), total: queue.length })}
              </p>
              <p className="text-xs text-slate-400 mt-1">{t('home.dontClose')}</p>
            </>
          )}
        </div>

        <ul className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
          {queue.map((q, i) => {
            const b = statusBadge(q.status, t)
            const isDone     = q.status === 'done'
            const canOpen    = isDone && !!q.filename && !!onOpen
            const openTarget = canOpen ? q.filename : null
            return (
              <li
                key={`${q.file.name}-${i}`}
                role={canOpen ? 'button' : undefined}
                tabIndex={canOpen ? 0 : undefined}
                onClick={canOpen ? () => onOpen(openTarget) : undefined}
                onKeyDown={canOpen ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(openTarget)
                  }
                } : undefined}
                title={canOpen ? t('home.openAria', { name: q.filename }) : q.file.name}
                className={`rounded-xl px-3 py-2.5 flex items-center gap-3 transition-all duration-150 ${
                  isDone
                    ? 'bg-teal-50/60 border border-teal-200 hover:bg-teal-100 cursor-pointer focus:outline-none focus:ring-2 focus:ring-teal-300'
                    : 'bg-white border border-slate-200'
                }`}
              >
                <span className="text-base shrink-0">{isDone ? '✅' : '📄'}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${isDone ? 'text-teal-900' : 'text-slate-800'}`} title={q.file.name}>
                    {q.file.name}
                  </p>
                  {(q.status === 'uploading' || q.status === 'analyzing' || q.status === 'fallback') && (
                    <div className="mt-1 w-full bg-slate-100 rounded-full h-1 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-200 ${
                          q.status === 'fallback' ? 'bg-amber-500' : 'bg-indigo-600'
                        }`}
                        style={{ width: `${Math.max(0, Math.min(100, q.progress || 0))}%` }}
                      />
                    </div>
                  )}
                  {(() => {
                    const msg = progressMessage(q.lastEvent, t) || q.message
                    return msg && (q.status === 'analyzing' || q.status === 'fallback') && (
                      <p
                        className={`text-[11px] mt-0.5 truncate ${
                          q.status === 'fallback' ? 'text-amber-700' : 'text-slate-500'
                        }`}
                        title={msg}
                      >
                        {msg}
                      </p>
                    )
                  })()}
                  {isDone && (
                    <p className="text-[11px] text-teal-700 mt-0.5">
                      {t('home.readyClick')}
                    </p>
                  )}
                  {q.status === 'error' && q.error && (
                    <p className="text-[11px] text-red-500 mt-0.5 truncate" title={q.error}>
                      {q.error}
                    </p>
                  )}
                </div>
                {canOpen ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen(openTarget) }}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-teal-600 text-white hover:bg-teal-700 transition-colors shrink-0 flex items-center gap-1"
                  >
                    {t('common.open')}
                    <span aria-hidden="true">→</span>
                  </button>
                ) : (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 border rounded-full shrink-0 ${b.cls}`}>
                    {b.label}
                  </span>
                )}
              </li>
            )
          })}
        </ul>

        {allDone && (
          <button
            onClick={onClose}
            className="self-center px-8 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors min-w-44"
          >
            {t('home.backToLibrary')}
          </button>
        )}
      </div>
    </div>
  )
}

export default function Home() {
  const { t } = useUiLang()
  const navigate = useNavigate()
  const location = useLocation()
  const [documents, setDocuments] = useState([])
  const [loadingDocs, setLoadingDocs] = useState(true)

  const [queue, setQueue] = useState(null)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [allDone, setAllDone] = useState(false)
  const [overwriteFor, setOverwriteFor] = useState(null)
  const overwriteResolverRef = useRef(null)
  const [uploadError, setUploadError] = useState(null)

  // Multi-select for bulk deletion. selectMode swaps the cards into checkbox
  // mode; `selected` holds the chosen filenames; confirmBulk gates the
  // destructive delete behind a second, explicit click.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirmBulk, setConfirmBulk] = useState(false)

  useEffect(() => { fetchDocs() }, [location.key])

  async function fetchDocs() {
    try {
      const res = await axios.get('/api/documents/')
      setDocuments(res.data)
    } catch {
      // non-critical
    } finally {
      setLoadingDocs(false)
    }
  }

  async function handleDelete(filename) {
    try {
      await axios.delete(`/api/documents/${encodeURIComponent(filename)}`)
      await fetchDocs()
    } catch {
      // ignore
    }
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelected(new Set())
    setConfirmBulk(false)
  }

  function toggleSelected(filename) {
    setConfirmBulk(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  // Select-all toggles to clear once everything is already picked.
  function toggleSelectAll() {
    setConfirmBulk(false)
    setSelected(prev =>
      prev.size >= documents.length ? new Set() : new Set(documents.map(d => d.filename)),
    )
  }

  // Delete every selected document in parallel; per-file failures are swallowed
  // so one bad delete doesn't abort the rest, and fetchDocs reconciles with the
  // server's truth afterwards.
  async function handleDeleteSelected() {
    if (selected.size === 0) return
    setBulkDeleting(true)
    try {
      await Promise.all(
        [...selected].map(fn =>
          axios.delete(`/api/documents/${encodeURIComponent(fn)}`).catch(() => {}),
        ),
      )
      await fetchDocs()
    } finally {
      setBulkDeleting(false)
      exitSelectMode()
    }
  }

  function handleOpen(filename) {
    navigate(`/read/${encodeURIComponent(filename)}`)
  }

  function describeUploadError(err) {
    const detail = err?.response?.data?.detail
    if (Array.isArray(detail)) {
      return detail.map(d => `${d.loc?.join('.') ?? ''}: ${d.msg}`).join(' | ')
    }
    if (typeof detail === 'string') return detail
    if (err?.response) return t('errors.http', { status: err.response.status })
    if (err?.request) return t('errors.noBackendResponse')
    return err?.message || t('errors.unknown')
  }

  async function processQueue(files, opts) {
    setUploadError(null)
    const items = files.map(f => ({
      file: f,
      status: 'pending',
      progress: 0,
      message: null,
      error: null,
    }))
    setQueue(items)
    setCurrentIdx(0)
    setAllDone(false)

    for (let i = 0; i < items.length; i++) {
      setCurrentIdx(i)
      let overwrite = false
      // Retry loop: re-enters after the user accepts an overwrite prompt.
      while (true) {
        setQueue(prev => prev.map((it, j) =>
          j === i
            ? { ...it, status: 'uploading', progress: 0, message: null, error: null }
            : it,
        ))
        try {
          const formData = new FormData()
          formData.append('file', items[i].file)
          formData.append('language', String(opts?.language ?? 'es'))
          formData.append('keep_terms_in_english', String(Boolean(opts?.keepTermsInEnglish)))
          if (overwrite) formData.append('overwrite', 'true')

          // Phase 1: upload bytes. Backend returns 202 + job_id quickly so
          // this only covers the network transfer.
          const postRes = await axios.post('/api/upload-pdf/', formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            onUploadProgress: (e) => {
              const pct = Math.round((e.loaded / e.total) * 99)
              setQueue(prev => prev.map((it, j) =>
                j === i
                  ? { ...it, status: pct >= 99 ? 'analyzing' : 'uploading', progress: pct }
                  : it,
              ))
            },
          })

          const jobId = postRes?.data?.job_id
          if (!jobId) throw new Error(t('errors.noJobId'))

          // Phase 2: subscribe to SSE progress. Failures here (network,
          // proxy timeout) do not cancel the backend job — extraction keeps
          // running and the analysis file lands on disk regardless. We just
          // reconnect once and, if that also fails, mark the queue item as
          // error while keeping the backend job alive.
          const doneEvent = await new Promise((resolve, reject) => {
            let es = new EventSource(`/api/upload-pdf/${jobId}/events`)
            let reconnected = false

            const close = () => {
              try { es.close() } catch { /* ignore */ }
            }

            const applyEvent = (ev) => {
              const upd = uiUpdateForEvent(ev)
              if (!upd) return
              setQueue(prev => prev.map((it, j) =>
                j === i
                  ? {
                      ...it,
                      status: upd.status ?? it.status,
                      progress: upd.progress ?? it.progress,
                      message: upd.message ?? it.message,
                      // Raw event kept so the queue view can localize the
                      // message by phase in the current UI language.
                      lastEvent: ev,
                    }
                  : it,
              ))
            }

            es.onmessage = (msg) => {
              try {
                const ev = JSON.parse(msg.data)
                applyEvent(ev)
                if (ev.phase === 'done') {
                  close()
                  resolve(ev)
                } else if (ev.phase === 'failed') {
                  close()
                  reject(new Error(progressMessage(ev, t) || t('errors.extractionFailed')))
                }
              } catch {
                // ignore malformed events
              }
            }

            es.onerror = () => {
              if (reconnected) {
                close()
                reject(new Error(t('errors.sseLost')))
                return
              }
              reconnected = true
              close()
              setTimeout(() => {
                es = new EventSource(`/api/upload-pdf/${jobId}/events`)
                es.onmessage = (msg) => {
                  try {
                    const ev = JSON.parse(msg.data)
                    applyEvent(ev)
                    if (ev.phase === 'done') {
                      close()
                      resolve(ev.result)
                    } else if (ev.phase === 'failed') {
                      close()
                      reject(new Error(progressMessage(ev, t) || t('errors.extractionFailed')))
                    }
                  } catch { /* ignore */ }
                }
                es.onerror = () => {
                  close()
                  reject(new Error(t('errors.sseLost')))
                }
              }, 1500)
            }
          })

          setQueue(prev => prev.map((it, j) =>
            j === i
              ? {
                  ...it,
                  status: 'done',
                  progress: 100,
                  // Canonical filename the backend wrote to disk — may differ
                  // from items[i].file.name if the server sanitized or
                  // deduplicated. Falls back to the local file name when the
                  // backend didn't include it (older builds, replay path).
                  filename: doneEvent?.filename ?? items[i].file.name,
                }
              : it,
          ))
          break
        } catch (err) {
          if (err?.response?.status === 409) {
            setQueue(prev => prev.map((it, j) =>
              j === i ? { ...it, status: 'conflict' } : it,
            ))
            setOverwriteFor({ idx: i, file: items[i].file })
            const decision = await new Promise(resolve => {
              overwriteResolverRef.current = resolve
            })
            setOverwriteFor(null)
            overwriteResolverRef.current = null
            if (decision === 'overwrite') {
              overwrite = true
              continue
            }
            setQueue(prev => prev.map((it, j) =>
              j === i ? { ...it, status: 'skipped' } : it,
            ))
            break
          }
          const msg = describeUploadError(err)
          setQueue(prev => prev.map((it, j) =>
            j === i ? { ...it, status: 'error', error: msg } : it,
          ))
          break
        }
      }
    }

    setCurrentIdx(items.length)
    setAllDone(true)
    fetchDocs()
  }

  function handleUpload(files, opts) {
    if (!files?.length) return
    processQueue(files, opts)
  }

  function closeUploadView() {
    setQueue(null)
    setCurrentIdx(0)
    setAllDone(false)
    setUploadError(null)
  }

  if (queue) {
    return (
      <>
        {overwriteFor && (
          <OverwriteModal
            filename={overwriteFor.file.name}
            onAccept={() => overwriteResolverRef.current?.('overwrite')}
            onReject={() => overwriteResolverRef.current?.('skip')}
          />
        )}
        <UploadQueueView
          queue={queue}
          currentIdx={currentIdx}
          allDone={allDone}
          onClose={closeUploadView}
          onOpen={handleOpen}
        />
      </>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-2.5">
          <span className="text-xl">🔬</span>
          <span className="text-lg font-bold text-slate-800 tracking-tight">DeepStudy</span>
          <div className="ml-auto flex items-center gap-2.5">
            <SettingsButton
              className="w-9 h-9 flex items-center justify-center rounded-xl border transition-colors hover:text-indigo-600"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}
            />
            <ThemeSwitch />
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 flex flex-col gap-12">
        <section className="flex flex-col items-center">
          <PdfUploader
            onUpload={handleUpload}
            error={uploadError}
          />
        </section>

        {loadingDocs && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 animate-pulse">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-white border border-slate-200 rounded-2xl h-44" />
            ))}
          </div>
        )}

        {!loadingDocs && documents.length > 0 && (
          <section>
            <div className="flex items-center justify-between gap-3 mb-4 min-h-[34px]">
              <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">
                {selectMode
                  ? t('home.selectedCount', { n: selected.size })
                  : t('home.yourDocs', { n: documents.length })}
              </h2>

              {!selectMode ? (
                <button
                  onClick={() => setSelectMode(true)}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                >
                  {t('home.select')}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleSelectAll}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                  >
                    {selected.size >= documents.length ? t('home.deselectAll') : t('home.selectAll')}
                  </button>
                  {confirmBulk ? (
                    <button
                      onClick={handleDeleteSelected}
                      disabled={bulkDeleting}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5"
                    >
                      {bulkDeleting && (
                        <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin block" />
                      )}
                      {t('home.confirmDelete', { n: selected.size })}
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmBulk(true)}
                      disabled={selected.size === 0}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    >
                      {t('home.deleteSelected', { n: selected.size })}
                    </button>
                  )}
                  <button
                    onClick={exitSelectMode}
                    disabled={bulkDeleting}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors disabled:opacity-40"
                  >
                    {t('home.cancelSelect')}
                  </button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {documents.map(doc => (
                <DocumentCard
                  key={doc.filename}
                  doc={doc}
                  onOpen={handleOpen}
                  onDelete={handleDelete}
                  selectable={selectMode}
                  selected={selected.has(doc.filename)}
                  onToggleSelect={toggleSelected}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
