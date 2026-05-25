import { useState, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

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

// Map [charStart, charEnd) over concatenated sentence texts (space-joined) → sentence indices.
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

// Validate Gemini's sentence indices against the quote: exact substring OR ≥70% sig-word overlap.
function indicesAgreeWithQuote(sentences, indices, quote) {
  if (!indices.length || !quote) return false
  const indexedLower = indices.map(i => sentences[i].text).join(' ').toLowerCase()
  if (indexedLower.includes(quote.toLowerCase())) return true
  const words = significantWords(quote)
  if (!words.length) return false
  const hits = words.filter(w => indexedLower.includes(w)).length
  return hits / words.length >= 0.7
}

// 4-tier resolution pipeline. Returns ordered sentence indices to highlight.
//
//   Tier 1 — Gemini's sentence_indices validated against `quote`.
//   Tier 2 — `quote` found verbatim across concatenated sentences → derive indices.
//   Tier 3 — Fuzzy contiguous window over sig-words of `quote || term`.
//   Tier 4 — Soft fallback: in-range raw indices.
//
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

function ParagraphOverlay({ blocks, scale, onExplain, activeParagraph, currentExplanation }) {
  const [hoveredIdx, setHoveredIdx] = useState(null)

  if (!blocks || !scale) return null

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {blocks.map((block, i) => {
        const paragraphBoxes = block.boxes ?? []
        if (paragraphBoxes.length === 0) return null

        const isHovered = hoveredIdx === i
        const isActive  = activeParagraph?.text === block.text

        // Anchor del ✦ button: esquina inferior-derecha del ÚLTIMO rect (fin natural del párrafo).
        const lastBox    = paragraphBoxes[paragraphBoxes.length - 1]
        const anchorLeft = lastBox.x1 * scale
        const anchorTop  = lastBox.y1 * scale

        const sentenceIndices = (isActive && currentExplanation && block.sentences?.length)
          ? resolveSentenceIndices(block.sentences, currentExplanation)
          : []

        const highlightBoxes = sentenceIndices.flatMap(idx =>
          (block.sentences[idx].boxes || []).map(b => ({
            left:   b.x0 * scale,
            top:    b.y0 * scale,
            width:  (b.x1 - b.x0) * scale,
            height: (b.y1 - b.y0) * scale,
          }))
        )

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

            {/* ✦ viñeta button — anclado al final del último rect */}
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

function PdfPage({ pageNumber, width, blocks, onExplain, activeParagraph, currentExplanation }) {
  const [scale, setScale] = useState(null)

  function handlePageLoad(page) {
    const originalWidth = page.getViewport({ scale: 1 }).width
    setScale(width / originalWidth)
  }

  return (
    <div className="relative shadow-xl mb-5 bg-white">
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
      />
    </div>
  )
}

export default function PdfViewer({ file, onExplain, pages, activeParagraph, currentExplanation }) {
  const [numPages, setNumPages] = useState(null)
  const [containerWidth, setContainerWidth] = useState(null)

  const containerRef = useCallback((node) => {
    if (node) setContainerWidth(node.getBoundingClientRect().width)
  }, [])

  const pageWidth = containerWidth ? containerWidth - 48 : undefined

  const blocksMap = pages
    ? Object.fromEntries(pages.map((p) => [p.page, p.blocks]))
    : {}

  return (
    <div
      ref={containerRef}
      className="flex flex-col items-center py-8 px-6 bg-gray-100 min-h-full overflow-y-auto"
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
            />
          ))}
      </Document>
    </div>
  )
}
