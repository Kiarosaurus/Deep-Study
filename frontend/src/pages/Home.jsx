import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import axios from 'axios'
import { flushSync } from 'react-dom'
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

function UploadProgressView({ progress, filename }) {
  const uploading = progress < 100
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="w-full max-w-md flex flex-col items-center gap-5 px-6">
        <div className="text-center">
          {uploading ? (
            <>
              <p className="font-semibold text-slate-700 text-lg">Subiendo archivo...</p>
              <p className="text-3xl font-bold text-indigo-600 mt-1 tabular-nums">{progress}%</p>
            </>
          ) : (
            <>
              <p className="font-semibold text-slate-700 text-lg">Analizando con IA...</p>
              <p className="text-xs text-slate-400 mt-1">Esto puede tardar unos segundos</p>
            </>
          )}
        </div>
        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          {uploading ? (
            <div
              className="h-full bg-indigo-600 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          ) : (
            <div
              className="h-full bg-indigo-500 rounded-full"
              style={{ animation: 'slide-indeterminate 1.5s ease-in-out infinite' }}
            />
          )}
        </div>
        {filename && (
          <p className="text-xs text-slate-400 truncate w-full text-center">{filename}</p>
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

  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState(null)
  const [uploadingFile, setUploadingFile] = useState(null)

  const [overwritePending, setOverwritePending] = useState(null)

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

  async function startUpload(file, opts) {
    setUploadError(null)
    flushSync(() => {
      setUploading(true)
      setUploadProgress(0)
      setUploadingFile(file)
    })
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('language', String(opts?.language ?? 'es'))
      formData.append('keep_terms_in_english', String(Boolean(opts?.keepTermsInEnglish)))
      if (opts?.overwrite) formData.append('overwrite', 'true')

      await axios.post('/api/upload-pdf/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          setUploadProgress(Math.round((e.loaded / e.total) * 99))
        },
      })
      navigate(`/read/${encodeURIComponent(file.name)}`)
    } catch (err) {
      if (err.response?.status === 409) {
        setUploading(false)
        setUploadingFile(null)
        setOverwritePending({ file, opts })
        return
      }
      const detail = err.response?.data?.detail
      let msg
      if (Array.isArray(detail)) {
        msg = detail.map(d => `${d.loc?.join('.') ?? ''}: ${d.msg}`).join(' | ')
      } else if (typeof detail === 'string') {
        msg = detail
      } else if (err.response) {
        msg = `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      } else if (err.request) {
        msg = `Sin respuesta del backend (${err.message}). ¿Está corriendo?`
      } else {
        msg = err.message || 'Error al subir el archivo.'
      }
      setUploadError(msg)
      setUploading(false)
      setUploadingFile(null)
    }
  }

  function handleUpload(file, opts) {
    const exists = documents.some(d => d.filename === file.name)
    if (exists) {
      setOverwritePending({ file, opts })
      return
    }
    startUpload(file, opts)
  }

  if (uploading) {
    return <UploadProgressView progress={uploadProgress} filename={uploadingFile?.name} />
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {overwritePending && (
        <OverwriteModal
          filename={overwritePending.file.name}
          onAccept={() => {
            const pending = overwritePending
            setOverwritePending(null)
            startUpload(pending.file, { ...pending.opts, overwrite: true })
          }}
          onReject={() => setOverwritePending(null)}
        />
      )}

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
            loading={false}
            uploadProgress={0}
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
