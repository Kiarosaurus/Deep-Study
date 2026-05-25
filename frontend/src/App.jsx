import { useState } from 'react'
import PdfUploader from './components/PdfUploader'
import GlobalMappingResult from './components/GlobalMappingResult'

function App() {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleUpload(file) {
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

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-2">
        <span className="text-xl font-bold text-indigo-600">DeepStudy</span>
        <span className="text-slate-300 text-lg">|</span>
        <span className="text-sm text-slate-500">Mapeo Global</span>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-12">
        {result
          ? <GlobalMappingResult data={result} onReset={() => setResult(null)} />
          : <PdfUploader onUpload={handleUpload} loading={loading} error={error} />
        }
      </main>
    </div>
  )
}

export default App
