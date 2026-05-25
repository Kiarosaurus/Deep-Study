import { useState } from 'react'
import axios from 'axios'
import PdfUploader from './components/PdfUploader'
import PdfViewer from './components/PdfViewer'
import Sidebar from './components/Sidebar'

function App() {
  const [pdfFile, setPdfFile] = useState(null)
  const [globalMap, setGlobalMap] = useState(null)
  const [explanation, setExplanation] = useState(null)
  const [loadingGlobal, setLoadingGlobal] = useState(false)
  const [loadingExplain, setLoadingExplain] = useState(false)
  const [errorGlobal, setErrorGlobal] = useState(null)
  const [errorExplain, setErrorExplain] = useState(null)

  async function handleUpload(file) {
    setPdfFile(file)
    setLoadingGlobal(true)
    setErrorGlobal(null)
    setGlobalMap(null)
    setExplanation(null)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const { data } = await axios.post('/api/upload-pdf/', formData)
      setGlobalMap(data)
    } catch (e) {
      setErrorGlobal(e.response?.data?.detail || e.message)
    } finally {
      setLoadingGlobal(false)
    }
  }

  async function handleExplain(paragraphText) {
    if (!globalMap) return
    setLoadingExplain(true)
    setErrorExplain(null)
    setExplanation(null)

    try {
      const { data } = await axios.post('/api/explain-paragraph/', {
        paragraph_text: paragraphText,
        global_map: globalMap,
      })
      setExplanation(data)
    } catch (e) {
      setErrorExplain(e.response?.data?.detail || e.message)
    } finally {
      setLoadingExplain(false)
    }
  }

  function handleReset() {
    setPdfFile(null)
    setGlobalMap(null)
    setExplanation(null)
    setErrorGlobal(null)
    setErrorExplain(null)
  }

  if (!pdfFile) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <Header />
        <main className="flex-1 flex items-center justify-center px-4">
          <PdfUploader onUpload={handleUpload} loading={loadingGlobal} error={errorGlobal} />
        </main>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header onReset={handleReset} filename={pdfFile.name} />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-[70%] overflow-y-auto bg-gray-100">
          <PdfViewer file={pdfFile} onExplain={handleExplain} canExplain={!!globalMap} />
        </div>
        <div className="w-[30%] overflow-y-auto border-l border-slate-200 bg-white">
          <Sidebar
            globalMap={globalMap}
            explanation={explanation}
            loadingGlobal={loadingGlobal}
            loadingExplain={loadingExplain}
            errorGlobal={errorGlobal}
            errorExplain={errorExplain}
          />
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
