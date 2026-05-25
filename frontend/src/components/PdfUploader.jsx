import { useState, useRef } from 'react'

export default function PdfUploader({ onUpload, loading, error }) {
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [language, setLanguage] = useState('es')
  const [keepTermsInEnglish, setKeepTermsInEnglish] = useState(false)
  const inputRef = useRef()

  function handleFile(f) {
    if (f?.type === 'application/pdf') setFile(f)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    handleFile(e.dataTransfer.files[0])
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-slate-800">Sube tu paper</h2>
        <p className="mt-2 text-slate-500 text-sm">
          Extrae acrónimos, metodología y conceptos clave en segundos
        </p>
      </div>

      {/* Drop zone */}
      <div
        onClick={() => inputRef.current.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`w-full max-w-md border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors select-none ${
          dragging
            ? 'border-indigo-400 bg-indigo-50'
            : 'border-slate-300 hover:border-indigo-300 hover:bg-slate-100'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={(e) => handleFile(e.target.files[0])}
        />
        <div className="text-5xl mb-4">📄</div>
        {file ? (
          <p className="font-semibold text-indigo-600 text-sm truncate px-2">{file.name}</p>
        ) : (
          <>
            <p className="font-medium text-slate-700">Arrastra un PDF aquí</p>
            <p className="text-xs text-slate-400 mt-1">o haz clic para seleccionar</p>
          </>
        )}
      </div>

      {/* Settings */}
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl px-5 py-4 flex flex-col gap-4">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">
          Configuración
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
        <p className="text-red-500 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-2 w-full max-w-md">
          {error}
        </p>
      )}

      <button
        disabled={!file || loading}
        onClick={() => onUpload(file, { language, keepTermsInEnglish })}
        className="px-8 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-w-40"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            Analizando...
          </span>
        ) : (
          'Analizar paper'
        )}
      </button>
    </div>
  )
}
