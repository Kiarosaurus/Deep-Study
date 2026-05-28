import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import axios from 'axios'
import PdfUploader from '../components/PdfUploader'
import OverwriteModal from '../components/OverwriteModal'

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DocumentCard({ doc, onOpen, onDelete }) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete(e) {
    e.stopPropagation()
    setDeleting(true)
    await onDelete(doc.filename)
  }

  return (
    <div
      onClick={() => onOpen(doc.filename)}
      className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-3 hover:shadow-md hover:border-indigo-200 transition-all cursor-pointer group"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-3xl">📄</span>
        {doc.has_analysis && (
          <span className="text-[10px] font-semibold px-2 py-0.5 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-full shrink-0">
            Analizado
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-800 truncate" title={doc.filename}>
          {doc.filename}
        </p>
        <p className="text-xs text-slate-400 mt-0.5">{formatBytes(doc.size_bytes)}</p>
      </div>
      <div className="flex gap-2" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => onOpen(doc.filename)}
          className="flex-1 text-xs font-semibold py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors"
        >
          Abrir
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors disabled:opacity-40 shrink-0"
          title="Eliminar"
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
    </div>
  )
}

function statusBadge(status) {
  switch (status) {
    case 'pending':   return { label: 'En cola',     cls: 'bg-slate-50 text-slate-500 border-slate-200' }
    case 'uploading': return { label: 'Subiendo',    cls: 'bg-indigo-50 text-indigo-600 border-indigo-200' }
    case 'analyzing': return { label: 'Analizando',  cls: 'bg-indigo-50 text-indigo-600 border-indigo-200' }
    case 'conflict':  return { label: 'Confirmar…',  cls: 'bg-amber-50 text-amber-600 border-amber-200' }
    case 'done':      return { label: 'Hecho',       cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' }
    case 'skipped':   return { label: 'Omitido',     cls: 'bg-amber-50 text-amber-600 border-amber-200' }
    case 'error':     return { label: 'Error',       cls: 'bg-red-50 text-red-600 border-red-200' }
    default:          return { label: status,        cls: 'bg-slate-50 text-slate-500 border-slate-200' }
  }
}

function UploadQueueView({ queue, currentIdx, allDone, onClose }) {
  const doneCount = queue.filter(q => q.status === 'done').length
  const errorCount = queue.filter(q => q.status === 'error').length
  const skippedCount = queue.filter(q => q.status === 'skipped').length

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-lg flex flex-col gap-5">
        <div className="text-center">
          {allDone ? (
            <>
              <p className="font-bold text-slate-800 text-xl">Análisis completado</p>
              <p className="text-sm text-slate-500 mt-1">
                {doneCount} listo{doneCount === 1 ? '' : 's'}
                {errorCount > 0 && `, ${errorCount} con error`}
                {skippedCount > 0 && `, ${skippedCount} omitido${skippedCount === 1 ? '' : 's'}`}
              </p>
            </>
          ) : (
            <>
              <p className="font-bold text-slate-800 text-xl">
                Procesando ({Math.min(currentIdx + 1, queue.length)} / {queue.length})
              </p>
              <p className="text-xs text-slate-400 mt-1">No cierres esta ventana</p>
            </>
          )}
        </div>

        <ul className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
          {queue.map((q, i) => {
            const b = statusBadge(q.status)
            return (
              <li
                key={`${q.file.name}-${i}`}
                className="bg-white border border-slate-200 rounded-xl px-3 py-2.5 flex items-center gap-3"
              >
                <span className="text-base shrink-0">📄</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate" title={q.file.name}>
                    {q.file.name}
                  </p>
                  {q.status === 'uploading' && (
                    <div className="mt-1 w-full bg-slate-100 rounded-full h-1 overflow-hidden">
                      <div
                        className="h-full bg-indigo-600 rounded-full transition-all duration-200"
                        style={{ width: `${q.progress}%` }}
                      />
                    </div>
                  )}
                  {q.status === 'analyzing' && (
                    <div className="mt-1 w-full bg-slate-100 rounded-full h-1 overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 rounded-full"
                        style={{ animation: 'slide-indeterminate 1.5s ease-in-out infinite' }}
                      />
                    </div>
                  )}
                  {q.status === 'error' && q.error && (
                    <p className="text-[11px] text-red-500 mt-0.5 truncate" title={q.error}>
                      {q.error}
                    </p>
                  )}
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 border rounded-full shrink-0 ${b.cls}`}>
                  {b.label}
                </span>
              </li>
            )
          })}
        </ul>

        {allDone && (
          <button
            onClick={onClose}
            className="self-center px-8 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors min-w-44"
          >
            Volver a la biblioteca
          </button>
        )}
      </div>
    </div>
  )
}

export default function Home() {
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
      await axios.delete(`/api/documents/${filename}`)
      await fetchDocs()
    } catch {
      // ignore
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
    if (err?.response) return `HTTP ${err.response.status}`
    if (err?.request) return 'Sin respuesta del backend'
    return err?.message || 'Error desconocido'
  }

  async function processQueue(files, opts) {
    setUploadError(null)
    const items = files.map(f => ({
      file: f,
      status: 'pending',
      progress: 0,
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
          j === i ? { ...it, status: 'uploading', progress: 0, error: null } : it,
        ))
        try {
          const formData = new FormData()
          formData.append('file', items[i].file)
          formData.append('language', String(opts?.language ?? 'es'))
          formData.append('keep_terms_in_english', String(Boolean(opts?.keepTermsInEnglish)))
          if (overwrite) formData.append('overwrite', 'true')

          await axios.post('/api/upload-pdf/', formData, {
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
          setQueue(prev => prev.map((it, j) =>
            j === i ? { ...it, status: 'done', progress: 100 } : it,
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
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-4">
              Tus documentos ({documents.length})
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {documents.map(doc => (
                <DocumentCard
                  key={doc.filename}
                  doc={doc}
                  onOpen={handleOpen}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
