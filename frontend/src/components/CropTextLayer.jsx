import { memo, useEffect, useState } from 'react'

// Transparent, selectable pdfjs glyph layer for ONE block crop (tracking mode).
// `TextLayer` does this for a whole paginated page; here we restrict it to a
// single block and re-origin the glyphs into the crop's local pixel space so
// the spans land exactly over the rasterized BlockCrop beneath. The search/lupa
// SearchSelectionLayer caret-hit-tests these spans, giving tracking mode the
// same char-level text selection paginated mode already has.
//
// Coordinate contract (mirrors LinearReader.BlockCrop): a page point (px, py)
// maps to crop-local px as `(px - originX) * scale` / `(py - originY) * scale`,
// where originX = bbox.x0, originY = the crop's inflated top, and scale =
// canvasWidth / bboxWidth. Pass those verbatim from BlockCrop.
const CropTextLayer = memo(function CropTextLayer({ pdfDoc, pageNum, originX, originY, scale, width, height }) {
  const [data, setData] = useState(null)   // { items, viewportHeight }

  useEffect(() => {
    if (!pdfDoc) return
    let cancelled = false
    pdfDoc.getPage(pageNum)
      .then(page => page.getTextContent().then(content => {
        if (cancelled) return
        setData({ items: content.items, vh: page.getViewport({ scale: 1 }).height })
      }))
      .catch(err => { if (!cancelled) console.warn('CropTextLayer: getTextContent failed', err) })
    return () => { cancelled = true }
  }, [pdfDoc, pageNum])

  if (!data || !scale) return null

  return (
    <div
      className="textLayer"
      style={{
        position: 'absolute',
        left: 0, top: 0, width, height,
        overflow: 'hidden',
        opacity: 0.999,        // keep selection-target intact while text renders transparent
        lineHeight: 1.0,
        pointerEvents: 'none', // spans opt back in; the wrapper stays gesture-transparent
        userSelect: 'text',
      }}
    >
      {data.items.map((item, i) => {
        if (!item.str) return null
        const tx = item.transform
        const fontSize = Math.hypot(tx[2], tx[3])
        // pdfjs origin is bottom-left; convert the baseline to a top-origin page
        // point, then re-origin + scale into the crop's local pixels.
        const left = (tx[4] - originX) * scale
        const top  = ((data.vh - tx[5]) - originY) * scale - fontSize * scale
        // Cull glyphs outside this crop (the page text layer covers the whole
        // page; we only want this block's region). Small pad for partials.
        if (left > width + 40 || top > height + 40 || left < -120 || top < -40) return null
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              left, top,
              width:  (item.width  ?? fontSize) * scale,
              height: (item.height ?? fontSize) * scale,
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

export default CropTextLayer
