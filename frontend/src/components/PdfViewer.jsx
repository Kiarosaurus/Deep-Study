import { useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const ZOOM_MIN  = 0.5
const ZOOM_MAX  = 3.0
const ZOOM_STEP = 0.2

const STOP_WORDS = new Set([
  'de','del','la','el','los','las','en','a','y','o','u','e','un','una','unos','unas',
  'que','se','con','por','para','su','sus','al','es','son','lo','le','les','si',
  'como','más','pero','este','esta','estos','estas','ese','esa','esos','esas',
  'the','an','of','in','to','and','or','for','with','is','are','at','by','on',
  'its','be','has','was','were','it','this','that','from','as',
])

function significantWords(text) {
  if (!text) return []
  return [...new Set(
    text.toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  )]
}

function charRangeToSentenceIndices(sentences, charStart, charEnd) {
  const indices = []
  let cursor = 0
  for (let i = 0; i < sentences.length; i++) {
    const len = sentences[i].text.length
    const sentEnd = cursor + len
    if (sentEnd > charStart && cursor < charEnd) indices.push(i)
    cursor = sentEnd + 1
  }
  return indices
}

function indicesAgreeWithQuote(sentences, indices, quote) {
  if (!indices.length || !quote) return false
  const indexedLower = indices.map(i => sentences[i].text).join(' ').toLowerCase()
  if (indexedLower.includes(quote.toLowerCase())) return true
  const words = significantWords(quote)
  if (!words.length) return false
  const hits = words.filter(w => indexedLower.includes(w)).length
  return hits / words.length >= 0.7
}

function resolveSentenceIndices(sentences, item) {
  if (!sentences?.length || !item) return []
  const { quote, sentence_indices: raw, concepts } = item

  const cleanIndices = Array.isArray(raw)
    ? raw.filter(i => Number.isInteger(i) && i >= 0 && i < sentences.length)
    : []

  // Tier 1
  if (indicesAgreeWithQuote(sentences, cleanIndices, quote)) return cleanIndices

  // Tier 2
  if (quote) {
    let concat = ''
    for (let i = 0; i < sentences.length; i++) {
      concat += sentences[i].text
      if (i < sentences.length - 1) concat += ' '
    }
    const idx = concat.toLowerCase().indexOf(quote.toLowerCase())
    if (idx !== -1) {
      const located = charRangeToSentenceIndices(sentences, idx, idx + quote.length)
      if (located.length) return located
    }
  }

  // Tier 3 — fuzzy sobre quote o concatenación de terms
  const conceptTerms = Array.isArray(concepts) ? concepts.map(c => c.term).join(' ') : ''
  const fuzzySource = quote || conceptTerms || ''
  const sigWords = significantWords(fuzzySource)
  if (sigWords.length) {
    const sentLowers = sentences.map(s => s.text.toLowerCase())
    const threshold  = Math.ceil(sigWords.length * 0.6)
    let bestStart = -1, bestEnd = -1, bestHits = 0
    for (let s = 0; s < sentences.length; s++) {
      const seen = new Set()
      for (let e = s; e < sentences.length && e - s < 5; e++) {
        for (const w of sigWords) if (sentLowers[e].includes(w)) seen.add(w)
        if (seen.size >= threshold && seen.size > bestHits) {
          bestHits  = seen.size
          bestStart = s
          bestEnd   = e
        }
      }
    }
    if (bestStart !== -1) {
      return Array.from({ length: bestEnd - bestStart + 1 }, (_, k) => bestStart + k)
    }
  }

  // Tier 4
  return cleanIndices
}

// ── Reading sequence (tracking mode) ──────────────────────────────────────────
// Construye cola global ordenada de "stops" intercalando párrafos e imágenes
// según reading_index del backend. Párrafos multi-box (paragraph wrapping
// columnas) se expanden en sub-stops, sub-ordenados por x0 luego y0.
function buildReadingSequence(pages) {
  if (!pages) return []
  const seq = []
  for (const p of pages) {
    const items = []
    for (const block of (p.blocks || [])) {
      for (const box of (block.boxes || [])) {
        items.push({
          kind: 'p',
          page: p.page,
          reading_index: block.reading_index ?? 0,
          bbox: box,
        })
      }
    }
    for (const im of (p.images || [])) {
      items.push({
        kind: 'i',
        page: p.page,
        reading_index: im.reading_index ?? 0,
        bbox: im.bbox,
      })
    }
    items.sort((a, b) => {
      if (a.reading_index !== b.reading_index) return a.reading_index - b.reading_index
      if (a.bbox.x0 !== b.bbox.x0)             return a.bbox.x0 - b.bbox.x0
      return a.bbox.y0 - b.bbox.y0
    })
    seq.push(...items)
  }
  return seq
}

function ZoomToolbar({ zoom, onZoomOut, onFit, onZoomIn }) {
  const btn = "w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30 disabled:pointer-events-none transition-colors text-base font-semibold"
  return (
    <div className="absolute top-4 right-4 z-30 flex items-center gap-0.5 bg-white/95 backdrop-blur rounded-xl shadow-md border border-slate-200 p-1 select-none">
      <button onClick={onZoomOut} disabled={zoom <= ZOOM_MIN + 1e-3} title="Disminuir zoom (−)" className={btn}>−</button>
      <button
        onClick={onFit}
        title="Ajustar a pantalla"
        className="px-2.5 h-8 flex items-center justify-center rounded-lg text-[11px] font-bold tabular-nums text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors min-w-[3.25rem]"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button onClick={onZoomIn} disabled={zoom >= ZOOM_MAX - 1e-3} title="Aumentar zoom (+)" className={btn}>+</button>
    </div>
  )
}

function ParagraphOverlay({ blocks, scale, onExplain, activeParagraph, currentExplanation, explanation }) {
  const [hoveredIdx, setHoveredIdx] = useState(null)

  if (!blocks || !scale) return null

  const allItems = explanation?.sentence_explanations ?? []

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {blocks.map((block, i) => {
        const paragraphBoxes = block.boxes ?? []
        if (paragraphBoxes.length === 0) return null

        const isHovered = hoveredIdx === i
        const isActive  = activeParagraph?.text === block.text

        const lastBox    = paragraphBoxes[paragraphBoxes.length - 1]
        const anchorLeft = lastBox.x1 * scale
        const anchorTop  = lastBox.y1 * scale

        const currentIndices = (isActive && currentExplanation && block.sentences?.length)
          ? resolveSentenceIndices(block.sentences, currentExplanation)
          : []
        const currentSet = new Set(currentIndices)

        const otherIndices = (isActive && allItems.length && block.sentences?.length)
          ? [...new Set(
              allItems
                .filter(it => it !== currentExplanation)
                .flatMap(it => resolveSentenceIndices(block.sentences, it))
            )].filter(idx => !currentSet.has(idx))
          : []

        const boxesFromIndices = (indices) => indices.flatMap(idx =>
          (block.sentences[idx]?.boxes || []).map(b => ({
            left:   b.x0 * scale,
            top:    b.y0 * scale,
            width:  (b.x1 - b.x0) * scale,
            height: (b.y1 - b.y0) * scale,
          }))
        )

        const otherBoxes     = boxesFromIndices(otherIndices)
        const highlightBoxes = boxesFromIndices(currentIndices)

        return (
          <div key={i}>
            {/* Hover rects — uno por columna/sección del párrafo */}
            {paragraphBoxes.map((b, k) => {
              const left   = b.x0 * scale
              const top    = b.y0 * scale
              const width  = (b.x1 - b.x0) * scale
              const height = (b.y1 - b.y0) * scale
              return (
                <div
                  key={`hov-${i}-${k}`}
                  className="absolute rounded-sm transition-opacity duration-150"
                  style={{
                    left, top, width, height,
                    background: isHovered ? 'rgba(99,102,241,0.07)' : 'transparent',
                    border: isHovered ? '1px solid rgba(99,102,241,0.22)' : '1px solid transparent',
                  }}
                />
              )
            })}

            {/* Otras oraciones del carrusel (no la actual) — sombreado plomo, estático */}
            {otherBoxes.map((box, j) => (
              <div
                key={`ot-${i}-${j}`}
                className="absolute pointer-events-none rounded-sm bg-slate-400/30"
                style={{
                  left:   box.left,
                  top:    box.top,
                  width:  box.width,
                  height: box.height,
                  mixBlendMode: 'multiply',
                }}
              />
            ))}

            {/* Resaltado por oración — múltiples rects sliceados proporcionalmente */}
            {highlightBoxes.map((box, j) => (
              <div
                key={`hl-${i}-${j}`}
                className="absolute pointer-events-none rounded-sm bg-yellow-300/40 transition-all duration-300 ease-out"
                style={{
                  left:   box.left,
                  top:    box.top,
                  width:  box.width,
                  height: box.height,
                  mixBlendMode: 'multiply',
                }}
              />
            ))}

            {/* ✦ viñeta button */}
            <button
              className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
              style={{
                left: anchorLeft,
                top:  anchorTop,
                background: isHovered ? 'rgb(79,70,229)' : 'rgba(99,102,241,0.15)',
                border: '1.5px solid rgba(99,102,241,0.6)',
                color: isHovered ? 'white' : 'rgb(79,70,229)',
                fontSize: '8px',
                fontWeight: 700,
                boxShadow: isHovered ? '0 2px 8px rgba(99,102,241,0.45)' : 'none',
                transform: isHovered
                  ? 'translate(-100%, -100%) scale(1.15)'
                  : 'translate(-100%, -100%)',
              }}
              onClick={() => onExplain(block.text, block.sentences)}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              title="Explicar párrafo"
            >
              ✦
            </button>
          </div>
        )
      })}
    </div>
  )
}

function PdfPage({ pageNumber, width, blocks, onExplain, activeParagraph, currentExplanation, explanation, trackedBox }) {
  // Guarda originalWidth (no scale) — así `scale = width / originalWidth` se recomputa
  // automáticamente cuando `width` cambia por zoom o resize.
  const [originalWidth, setOriginalWidth] = useState(null)
  const scale = originalWidth ? width / originalWidth : null

  function handlePageLoad(page) {
    setOriginalWidth(page.getViewport({ scale: 1 }).width)
  }

  return (
    <div className="relative shadow-xl mb-5 bg-white" data-page={pageNumber}>
      <Page
        pageNumber={pageNumber}
        width={width}
        onLoadSuccess={handlePageLoad}
        renderTextLayer
        renderAnnotationLayer
      />
      <ParagraphOverlay
        blocks={blocks}
        scale={scale}
        onExplain={onExplain}
        activeParagraph={activeParagraph}
        currentExplanation={currentExplanation}
        explanation={explanation}
      />
      {trackedBox && scale && (
        <div
          className="absolute pointer-events-none rounded-md transition-all duration-500 ease-out z-20"
          style={{
            left:   trackedBox.x0 * scale - 6,
            top:    trackedBox.y0 * scale - 6,
            width:  (trackedBox.x1 - trackedBox.x0) * scale + 12,
            height: (trackedBox.y1 - trackedBox.y0) * scale + 12,
            border: '3px solid rgb(99,102,241)',
            boxShadow: '0 0 0 9999px rgba(15,23,42,0.45), 0 0 24px rgba(99,102,241,0.55)',
          }}
        />
      )}
    </div>
  )
}

export default function PdfViewer({ file, onExplain, pages, activeParagraph, currentExplanation, explanation, onHome }) {
  const [numPages, setNumPages]               = useState(null)
  const [containerWidth, setContainerWidth]   = useState(null)
  const [userZoom, setUserZoom]               = useState(1.0)
  const [tracking, setTracking]               = useState(false)
  const [currentStop, setCurrentStop]         = useState(0)

  const containerRef = useRef(null)
  const userZoomRef  = useRef(1.0)

  useEffect(() => { userZoomRef.current = userZoom }, [userZoom])

  // ── Tracking mode ───────────────────────────────────────────────────────────
  const readingSequence = useMemo(() => buildReadingSequence(pages), [pages])
  const pageDims = useMemo(
    () => pages
      ? Object.fromEntries(pages.map(p => [p.page, { width: p.width, height: p.height }]))
      : {},
    [pages],
  )

  // pageWidth recomputado abajo; capturamos vía ref para usar en scrollToStop
  const pageWidthRef = useRef(0)

  function scrollToStop(stop) {
    const container = containerRef.current
    if (!container || !stop) return
    const el = container.querySelector(`[data-page="${stop.page}"]`)
    if (!el) return
    const dim = pageDims[stop.page]
    const pw  = pageWidthRef.current
    if (!dim?.width || !pw) return
    const scale = pw / dim.width
    const containerRect = container.getBoundingClientRect()
    const pageRect      = el.getBoundingClientRect()
    const viewportH     = container.clientHeight
    const targetY = container.scrollTop
                  + (pageRect.top - containerRect.top)
                  + stop.bbox.y0 * scale
                  - viewportH * 0.25
    container.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' })
  }

  // Toggle ON → reset al primer stop
  useEffect(() => {
    if (tracking) setCurrentStop(0)
  }, [tracking])

  // Auto-scroll al cambiar stop / activar tracking / re-zoom
  useEffect(() => {
    if (!tracking) return
    const stop = readingSequence[currentStop]
    if (!stop) return
    const id = requestAnimationFrame(() => scrollToStop(stop))
    return () => cancelAnimationFrame(id)
  }, [tracking, currentStop, readingSequence, userZoom, containerWidth])

  // Hijack wheel + teclado en tracking mode
  useEffect(() => {
    if (!tracking) return
    const node = containerRef.current
    if (!node) return

    let cooldown = false
    function step(delta) {
      if (cooldown) return
      cooldown = true
      setTimeout(() => { cooldown = false }, 450)
      setCurrentStop(s => Math.max(0, Math.min(readingSequence.length - 1, s + delta)))
    }

    function onWheel(e) {
      e.preventDefault()
      if (e.deltaY > 0) step(1)
      else if (e.deltaY < 0) step(-1)
    }
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault(); step(1)
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault(); step(-1)
      } else if (e.key === 'Escape') {
        setTracking(false)
      }
    }

    node.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      node.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [tracking, readingSequence.length])

  // Container width tracking + touch gestures (pinch-to-zoom). Pan = scroll nativo.
  useEffect(() => {
    const node = containerRef.current
    if (!node) return

    // Initial measure
    setContainerWidth(node.getBoundingClientRect().width)

    // Re-measure on resize
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w) setContainerWidth(w)
    })
    ro.observe(node)

    // Pinch state — ref-like via closure
    let pinchActive    = false
    let pinchStartDist = 0
    let pinchStartZoom = 1.0

    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)

    function onTouchStart(e) {
      if (e.touches.length === 2) {
        pinchActive    = true
        pinchStartDist = dist(e.touches[0], e.touches[1])
        pinchStartZoom = userZoomRef.current
      }
    }

    function onTouchMove(e) {
      if (!pinchActive || e.touches.length < 2) return
      e.preventDefault() // bloquea zoom nativo del browser durante pinch custom
      const d = dist(e.touches[0], e.touches[1])
      if (pinchStartDist > 0) {
        const ratio = d / pinchStartDist
        const next  = pinchStartZoom * ratio
        setUserZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next)))
      }
    }

    function onTouchEnd(e) {
      if (e.touches.length < 2) pinchActive = false
    }

    // passive:false necesario para que preventDefault sea efectivo durante pinch
    node.addEventListener('touchstart',  onTouchStart, { passive: false })
    node.addEventListener('touchmove',   onTouchMove,  { passive: false })
    node.addEventListener('touchend',    onTouchEnd)
    node.addEventListener('touchcancel', onTouchEnd)

    return () => {
      ro.disconnect()
      node.removeEventListener('touchstart',  onTouchStart)
      node.removeEventListener('touchmove',   onTouchMove)
      node.removeEventListener('touchend',    onTouchEnd)
      node.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [])

  function zoomIn()  { setUserZoom(z => Math.min(z + ZOOM_STEP, ZOOM_MAX)) }
  function zoomOut() { setUserZoom(z => Math.max(z - ZOOM_STEP, ZOOM_MIN)) }
  function zoomFit() { setUserZoom(1.0) }

  // pageWidth = ancho base ajustado a contenedor * factor de zoom del usuario.
  // PdfPage usa `scale = width / originalWidth` → overlays se reescalan automáticamente.
  const basePageWidth = containerWidth ? containerWidth - 48 : undefined
  const pageWidth     = basePageWidth ? basePageWidth * userZoom : undefined
  useEffect(() => { pageWidthRef.current = pageWidth || 0 }, [pageWidth])

  const blocksMap = pages
    ? Object.fromEntries(pages.map(p => [p.page, p.blocks]))
    : {}

  const currentStopData = tracking ? readingSequence[currentStop] : null

  return (
    <div className="relative h-full bg-gray-100">
      <ZoomToolbar zoom={userZoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={zoomFit} />

      {/* Tracking toolbar */}
      <div className="absolute top-4 left-4 z-30 flex items-center gap-1 bg-white/95 backdrop-blur rounded-xl shadow-md border border-slate-200 p-1.5 select-none">
        {onHome && (
          <button
            onClick={onHome}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
            title="Volver al menú principal"
            aria-label="Volver al menú principal"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12l9-9 9 9" />
              <path d="M5 10v10h14V10" />
            </svg>
          </button>
        )}
        <button
          onClick={() => setTracking(t => !t)}
          disabled={readingSequence.length === 0}
          className={`px-3 h-8 rounded-lg text-xs font-semibold transition-colors disabled:opacity-30 disabled:pointer-events-none ${
            tracking
              ? 'bg-indigo-600 text-white hover:bg-indigo-700'
              : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
          }`}
          title={tracking ? 'Salir (Esc)' : 'Activar Modo de Seguimiento'}
        >
          {tracking ? '◉ Seguimiento ON' : '◯ Activar Seguimiento'}
        </button>
        {tracking && (
          <>
            <button
              onClick={() => setCurrentStop(s => Math.max(0, s - 1))}
              disabled={currentStop <= 0}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30 disabled:pointer-events-none transition-colors font-semibold"
              title="Anterior (↑ / PgUp)"
            >↑</button>
            <span className="text-[11px] font-bold tabular-nums text-slate-600 min-w-[3.5rem] text-center">
              {currentStop + 1}/{readingSequence.length}
            </span>
            <button
              onClick={() => setCurrentStop(s => Math.min(readingSequence.length - 1, s + 1))}
              disabled={currentStop >= readingSequence.length - 1}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30 disabled:pointer-events-none transition-colors font-semibold"
              title="Siguiente (↓ / Space / PgDn)"
            >↓</button>
          </>
        )}
      </div>

      <div
        ref={containerRef}
        className="h-full overflow-auto"
        style={{ touchAction: tracking ? 'none' : 'pan-x pan-y' }}
      >
        <div
          className="flex flex-col items-center py-8 px-6 min-h-full"
          style={{ minWidth: 'fit-content' }}
        >
          <Document
            file={file}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            loading={<p className="text-slate-400 text-sm mt-16">Cargando PDF...</p>}
            error={<p className="text-red-500 text-sm mt-16">No se pudo cargar el PDF.</p>}
          >
            {numPages && pageWidth &&
              Array.from({ length: numPages }, (_, i) => (
                <PdfPage
                  key={i}
                  pageNumber={i + 1}
                  width={pageWidth}
                  blocks={blocksMap[i + 1]}
                  onExplain={onExplain}
                  activeParagraph={activeParagraph}
                  currentExplanation={currentExplanation}
                  explanation={explanation}
                  trackedBox={currentStopData?.page === i + 1 ? currentStopData.bbox : null}
                />
              ))}
          </Document>
        </div>
      </div>
    </div>
  )
}
