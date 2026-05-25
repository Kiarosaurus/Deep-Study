import { useState } from 'react'
import PdfUploader from './components/PdfUploader'
import PdfViewer from './components/PdfViewer'
import Sidebar from './components/Sidebar'

function App() {
  const [pdfFile, setPdfFile] = useState(null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleUpload(file) {
    setPdfFile(file)
    setLoading(true)
    setError(null)
    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch('/api/upload-pdf/', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Error desconocido')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (!pdfFile) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <Header />
        <main className="flex-1 flex items-center justify-center px-4">
          <PdfUploader onUpload={handleUpload} loading={loading} error={error} />
        </main>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header onReset={() => { setPdfFile(null); setResult(null) }} filename={pdfFile.name} />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-[70%] overflow-y-auto bg-gray-100">
          <PdfViewer file={pdfFile} />
        </div>
        <div className="w-[30%] overflow-y-auto border-l border-slate-200 bg-white">
          <Sidebar data={result} loading={loading} error={error} />
        </div>
      </div>
    </div>
  )
}

function Header({ onReset, filename }) {
  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-3 shrink-0">
      <span className="text-lg font-bold text-indigo-600">DeepStudy</span>
      {filename && (
        <>
          <span className="text-slate-300">/</span>
          <span className="text-sm text-slate-500 truncate max-w-xs">{filename}</span>
          <button
            onClick={onReset}
            className="ml-auto text-xs text-slate-400 hover:text-indigo-600 transition-colors"
          >
            ← Nuevo paper
          </button>
        </>
      )}
    </header>
  )
}

export default App
