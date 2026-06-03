import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Reader from './pages/Reader'
import LinearReaderTest from './pages/LinearReaderTest'
import { LanguageProvider } from './i18n/LanguageContext'
import { ThemeProvider } from './theme/ThemeContext'
import { SettingsProvider } from './settings/SettingsContext'
import SettingsModal from './settings/SettingsModal'

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <SettingsProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/read/:filename" element={<Reader />} />
              <Route path="/linear/:filename" element={<LinearReaderTest />} />
            </Routes>
          </BrowserRouter>
          {/* Single modal instance — openable from any SettingsButton. */}
          <SettingsModal />
        </SettingsProvider>
      </LanguageProvider>
    </ThemeProvider>
  )
}
