import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Reader from './pages/Reader'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/read/:filename" element={<Reader />} />
      </Routes>
    </BrowserRouter>
  )
}
