import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Reader from './pages/Reader'
import LinearReaderTest from './pages/LinearReaderTest'
import { LanguageProvider } from './i18n/LanguageContext'

export default function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/read/:filename" element={<Reader />} />
          <Route path="/linear/:filename" element={<LinearReaderTest />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  )
}
