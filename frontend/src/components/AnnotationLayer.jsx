import { memo, useEffect, useState } from 'react'

// PDF annotation interactivity (clickable links, URI hyperlinks, internal
// page references). Reimplements the subset of react-pdf's annotation
// layer that scientific papers actually rely on:
//   - Link annotations with `url` → external links (open in new tab).
//   - Link annotations with `dest` → internal jumps (scroll to target
//     page; pdfjs resolves the destination to a page index).
//
// Other annotation types (form fields, sticky notes, freetext, ink) are
// ignored on purpose — they're rare in papers and would balloon scope.
const AnnotationLayer = memo(function AnnotationLayer({ page, scale, onInternalNav }) {
  const [annotations, setAnnotations] = useState(null)
  const [viewport, setViewport] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      page.getAnnotations(),
      Promise.resolve(page.getViewport({ scale: 1 })),
    ]).then(([anns, vp]) => {
      if (cancelled) return
      setAnnotations(anns)
      setViewport(vp)
    }).catch(err => {
      if (!cancelled) console.warn('AnnotationLayer: getAnnotations failed', err)
    })
    return () => { cancelled = true }
  }, [page])

  if (!annotations || !viewport) return null

  return (
    <div
      className="annotationLayer"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      }}
    >
      {annotations.map((a, i) => {
        if (a.subtype !== 'Link') return null
        const rect = a.rect // [x0, y0, x1, y1] in PDF point coords
        if (!rect) return null
        // PDF coords are bottom-left origin; flip Y into our top-left
        // canvas coords.
        const left   = rect[0] * scale
        const top    = (viewport.height - rect[3]) * scale
        const width  = (rect[2] - rect[0]) * scale
        const height = (rect[3] - rect[1]) * scale
        const style = {
          position: 'absolute',
          left, top, width, height,
          pointerEvents: 'auto',
          // Keep transparent so the rendered glyphs underneath stay
          // visible; a faint hover tint shows the user something is
          // clickable.
          background: 'transparent',
          cursor: 'pointer',
          border: '0',
        }
        if (a.url) {
          return (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              title={a.url}
              style={style}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            />
          )
        }
        if (a.dest) {
          // Internal jump — pdfjs returns either a destination name (string)
          // or a resolved array; either way the page index is resolvable
          // via doc.getDestination + getPageIndex. We surface this to the
          // parent via onInternalNav callback so the viewer can scroll.
          return (
            <button
              key={i}
              type="button"
              title="Internal link"
              style={style}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => onInternalNav?.(a.dest)}
            />
          )
        }
        return null
      })}
    </div>
  )
})

export default AnnotationLayer
