import { useState } from 'react'
import { flushSync } from 'react-dom'
import axios from 'axios'
import PdfUploader from './components/PdfUploader'
import PdfViewer from './components/PdfViewer'
import Sidebar from './components/Sidebar'

function App() {
  const [pdfFile, setPdfFile] = useState(null)
  const [globalMap, setGlobalMap] = useState(null)
  const [pagesData, setPagesData] = useState(null)
  const [explanation, setExplanation] = useState(null)
  const [loadingGlobal, setLoadingGlobal] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [loadingExplain, setLoadingExplain] = useState(false)
  const [errorGlobal, setErrorGlobal] = useState(null)
  const [errorExplain, setErrorExplain] = useState(null)

  async function handleUpload(file, config = {}) {
    // flushSync forces React to commit loading=true to DOM before the async op starts.
    // Without it, React 18 batching can delay the render until after Axios returns on localhost.
    flushSync(() => {
      setLoadingGlobal(true)
      setUploadProgress(0)
      setErrorGlobal(null)
      setGlobalMap(null)
      setExplanation(null)
    })

    const formData = new FormData()
    formData.append('file', file)
    formData.append('language', config.language ?? 'es')
    formData.append('keep_terms_in_english', String(config.keepTermsInEnglish ?? false))

    try {
      const { data } = await axios.post('/api/upload-pdf/', formData, {
        onUploadProgress: (e) => {
          const pct = e.total ? Math.round((e.loaded * 100) / e.total) : 0
          setUploadProgress(pct)
        },
      })
      setPdfFile(file)          // transition to split view only after full response
      setGlobalMap(data.global_map)
      setPagesData(data.pages)
    } catch (e) {
      setErrorGlobal(e.response?.data?.detail || e.message)
      setUploadProgress(0)
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
    setPagesData(null)
    setExplanation(null)
    setErrorGlobal(null)
    setErrorExplain(null)
    setUploadProgress(0)
  }

  if (!pdfFile) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <Header />
        <main className="flex-1 flex items-center justify-center px-4">
          <PdfUploader
            onUpload={handleUpload}
            loading={loadingGlobal}
            uploadProgress={uploadProgress}
            error={errorGlobal}
          />
        </main>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header onReset={handleReset} filename={pdfFile.name} />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-[70%] overflow-y-auto bg-gray-100">
          <PdfViewer file={pdfFile} onExplain={handleExplain} pages={pagesData} />
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
