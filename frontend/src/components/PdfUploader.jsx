import { useState, useRef } from 'react'

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function PdfUploader({ onUpload, error }) {
  const [files, setFiles] = useState([])
  const [dragging, setDragging] = useState(false)
  const [language, setLanguage] = useState('es')
  const [keepTermsInEnglish, setKeepTermsInEnglish] = useState(true)
  const inputRef = useRef()

  function addFiles(list) {
    const pdfs = Array.from(list || []).filter(f => f.type === 'application/pdf')
    if (!pdfs.length) return
    setFiles(prev => {
      const seen = new Set(prev.map(f => f.name))
      const merged = [...prev]
      for (const f of pdfs) {
        if (!seen.has(f.name)) {
          merged.push(f)
          seen.add(f.name)
        }
      }
      return merged
    })
  }

  function removeFile(name) {
    setFiles(prev => prev.filter(f => f.name !== name))
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  function handleSubmit() {
    if (!files.length) return
    onUpload(files, { language, keepTermsInEnglish })
    setFiles([])
  }

  const count = files.length
  const buttonLabel = count === 0
    ? 'Analizar papers'
    : count === 1
      ? 'Analizar 1 paper'
      : `Analizar ${count} papers`

  return (
    <div className="flex flex-col items-center gap-6 w-full">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-slate-800">Sube tus papers</h2>
        <p className="mt-2 text-slate-500 text-sm">
          Uno o varios PDFs. Se analizan y quedan en tu biblioteca, listos para abrir.
        </p>
      </div>

      <div
        onClick={() => inputRef.current.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`w-full max-w-md border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors select-none ${
          dragging
            ? 'border-indigo-400 bg-indigo-50'
            : 'border-slate-300 hover:border-indigo-300 hover:bg-slate-100'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <div className="text-5xl mb-3">📄</div>
        <p className="font-medium text-slate-700">Arrastra PDFs aquí</p>
        <p className="text-xs text-slate-400 mt-1">o haz clic para seleccionar uno o varios</p>
      </div>

      {count > 0 && (
        <ul className="w-full max-w-md flex flex-col gap-2">
          {files.map(f => (
            <li
              key={f.name}
              className="bg-white border border-slate-200 rounded-xl px-3 py-2 flex items-center gap-3"
            >
              <span className="text-base shrink-0">📄</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate" title={f.name}>{f.name}</p>
                <p className="text-[11px] text-slate-400">{formatBytes(f.size)}</p>
              </div>
              <button
                onClick={() => removeFile(f.name)}
                className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0 text-lg leading-none"
                title="Quitar"
                aria-label={`Quitar ${f.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl px-5 py-4 flex flex-col gap-4">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">
          Configuración (aplica a todos)
        </span>

        <div className="flex items-center justify-between">
          <label htmlFor="language" className="text-sm text-slate-700">
            Idioma de explicación
          </label>
          <select
            id="language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 bg-white focus:ring-2 focus:ring-indigo-300 focus:outline-none cursor-pointer"
          >
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={keepTermsInEnglish}
            onChange={(e) => setKeepTermsInEnglish(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer"
          />
          <span className="text-sm text-slate-700 leading-snug group-hover:text-slate-900 transition-colors">
            Mantener términos técnicos y acrónimos en Inglés
          </span>
        </label>
      </div>

      {error && (
        <div className="w-full max-w-md bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <p className="text-sm font-semibold text-red-600 mb-0.5">Error</p>
          <p className="text-xs text-red-500">{error}</p>
        </div>
      )}

      <button
        disabled={!count}
        onClick={handleSubmit}
        className="px-8 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-w-40"
      >
        {buttonLabel}
      </button>
    </div>
  )
}
