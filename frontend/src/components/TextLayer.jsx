import { memo, useEffect, useRef, useState } from 'react'

// Native PDF text selection / search layer. Reimplements what react-pdf
// does internally so the custom canvas viewport still supports drag-
// select, Ctrl+F, copy-paste, and screen-reader narration.
//
// Rendering strategy: pull the text items from pdfjs via page.getTextContent(),
// position each as an absolute <span> with the same transform pdfjs would
// apply (matrix from `item.transform`), make the spans transparent so the
// rendered canvas shows through. Browser selection treats them as normal
// text.
//
// `scale` = displayWidth / page.viewport.width. Used to map pdfjs viewport
// coords (which are at scale=1) into our rendered display coords.
const TextLayer = memo(function TextLayer({ page, scale }) {
  const containerRef = useRef(null)
  const [items, setItems] = useState(null)
  const [viewport, setViewport] = useState(null)

  // Pull text content once per page. Re-runs on page object change (new
  // document, new page).
  useEffect(() => {
    let cancelled = false
    page.getTextContent().then(content => {
      if (cancelled) return
      setItems(content.items)
      setViewport(page.getViewport({ scale: 1 }))
    }).catch(err => {
      if (!cancelled) console.warn('TextLayer: getTextContent failed', err)
    })
    return () => { cancelled = true }
  }, [page])

  if (!items || !viewport) return null

  // pdfjs ships text item transforms as a 2D affine matrix
  //   [a, b, c, d, e, f]
  // mapping the glyph baseline to viewport coords. Items also carry width/
  // height in viewport units. We convert each item to a positioned <span>
  // sized to its bounding rect and scaled to display.
  return (
    <div
      ref={containerRef}
      className="textLayer"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        opacity: 0.999, // keep selection-target intact while spans render transparent text
        lineHeight: 1.0,
        // Allow user gestures to reach overlays above us by default; spans
        // override to receive selection.
        pointerEvents: 'none',
        userSelect: 'text',
      }}
    >
      {items.map((item, i) => {
        // Some items can be marked-content or have empty str — skip pure
        // whitespace placeholders.
        if (!item.str) return null
        const tx = item.transform
        const fontSize = Math.hypot(tx[2], tx[3]) // sy
        const left = tx[4] * scale
        // pdfjs origin is bottom-left; subtract glyph height so the span
        // top-left aligns with our top-left coord system.
        const top  = (viewport.height - tx[5]) * scale - fontSize * scale
        const width  = (item.width  ?? fontSize) * scale
        const height = (item.height ?? fontSize) * scale
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              left, top,
              width, height,
              fontSize: `${fontSize * scale}px`,
              fontFamily: item.fontName || 'sans-serif',
              color: 'transparent',
              whiteSpace: 'pre',
              transformOrigin: '0% 0%',
              cursor: 'text',
              pointerEvents: 'auto',
            }}
          >
            {item.str}
            {item.hasEOL ? '\n' : ''}
          </span>
        )
      })}
    </div>
  )
})

export default TextLayer
