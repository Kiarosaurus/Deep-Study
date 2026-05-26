import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Reader from './pages/Reader'
import LinearReaderTest from './pages/LinearReaderTest'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/read/:filename" element={<Reader />} />
        <Route path="/linear/:filename" element={<LinearReaderTest />} />
      </Routes>
    </BrowserRouter>
  )
}
