import { useState, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configuración del worker de PDF.js
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const STOP_WORDS = new Set([
  // Español
  'de','del','la','el','los','las','en','a','y','o','u','e','un','una','unos','unas',
  'que','se','con','por','para','su','sus','al','es','son','lo','le','les','si',
  'como','más','pero','este','esta','estos','estas','ese','esa','esos','esas',
  // Inglés
  'the','an','of','in','to','and','or','for','with','is','are','at','by','on',
  'its','be','has','was','were','it','this','that','from','as','an',
])

function significantWords(text) {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  )]
}

// ✨ NUEVA ESTRATEGIA: Extracción basada en las líneas NATIVAS de PyMuPDF
function getHighlightLineBoxes(block, term, scale) {
  if (!term || !block.lines || block.lines.length === 0) return [];

  const sigWords = significantWords(term);
  if (sigWords.length === 0) return [];

  // 1. Puntuamos cada línea nativa dependiendo de cuántas palabras clave contiene
  const lineScores = block.lines.map(line => {
    const lowerLine = line.text.toLowerCase();
    return sigWords.filter(w => lowerLine.includes(w)).length;
  });

  // 2. Encontramos la ventana continua (desde la primera línea coincidente hasta la última)
  let startIndex = -1;
  let endIndex = -1;

  for (let i = 0; i < lineScores.length; i++) {
    if (lineScores[i] > 0) {
      if (startIndex === -1) startIndex = i;
      endIndex = i;
    }
  }

  // Fallback si la búsqueda fuzzy no encuentra coincidencias
  if (startIndex === -1) return [];

  // 3. Devolvemos únicamente los Bounding Boxes exactos de esas líneas en formato de CSS
  return block.lines.slice(startIndex, endIndex + 1).map(line => {
    const { x0, y0, x1, y1 } = line.bbox;
    return {
      left: x0 * scale,
      top: y0 * scale,
      width: (x1 - x0) * scale,
      height: (y1 - y0) * scale,
    };
  });
}

function ParagraphOverlay({ blocks, scale, onExplain, activeParagraph, highlightTerm }) {
  const [hoveredIdx, setHoveredIdx] = useState(null)

  if (!blocks || !scale) return null

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {blocks.map((block, i) => {
        const { x0, y0, x1, y1 } = block.bbox
        const sx0 = x0 * scale
        const sy0 = y0 * scale
        const sx1 = x1 * scale
        const sy1 = y1 * scale
        
        const isHovered = hoveredIdx === i
        const isActive  = activeParagraph?.text === block.text

        // Generamos el array de recuadros precisos por línea
        const highlightBoxes = isActive && highlightTerm
          ? getHighlightLineBoxes(block, highlightTerm, scale)
          : []

        return (
          <div key={i}>
            {/* Hover highlight general del párrafo */}
            <div
              className="absolute rounded-sm transition-opacity duration-150"
              style={{
                left: sx0,
                top: sy0,
                width: sx1 - sx0,
                height: sy1 - sy0,
                background: isHovered ? 'rgba(99,102,241,0.07)' : 'transparent',
                border: isHovered ? '1px solid rgba(99,102,241,0.22)' : '1px solid transparent',
              }}
            />

            {/* ✨ Resaltado línea por línea preciso y múltiple */}
            {highlightBoxes.map((box, idx) => (
              <div
                key={`hl-${i}-${idx}`}
                className="absolute pointer-events-none rounded-sm transition-all duration-300 ease-out"
                style={{
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  background: 'rgba(253, 224, 71, 0.45)', // Amarillo semitransparente limpio
                  mixBlendMode: 'multiply',
                }}
              />
            ))}

            {/* ✦ viñeta button para solicitar la explicación */}
            <button
              className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
              style={{
                left: sx1,
                top: sy1,
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
              onClick={() => onExplain(block.text, block.bbox)}
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

function PdfPage({ pageNumber, width, blocks, onExplain, activeParagraph, highlightTerm }) {
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
        highlightTerm={highlightTerm}
      />
    </div>
  )
}

export default function PdfViewer({ file, onExplain, pages, activeParagraph, highlightTerm }) {
  const [numPages, setNumPages] = useState(null)
  const [containerWidth, setContainerWidth] = useState(null)

  const containerRef = useCallback((node) => {
    if (node) setContainerWidth(node.getBoundingClientRect().width)
  }, [])

  // Restamos padding para los márgenes laterales
  const pageWidth = containerWidth ? containerWidth - 48 : undefined

  // Mapeamos los bloques por página para pasárselos fácilmente a <PdfPage>
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
              highlightTerm={highlightTerm}
            />
          ))}
      </Document>
    </div>
  )
}