import { useEffect, useRef, useState } from 'react'

// ── Search/lupa selection layer ──────────────────────────────────────────────
// Char-level text selection over the pdfjs text layer, constrained to ONE
// paragraph. Mouse/pen press-drag sets the carets live; touch uses two taps
// (start, then end) since a finger drag is reserved for scrolling. Either way
// circle knobs (44px touch targets) on each end drag to expand/compress, and
// carets resolve via the native caret-from-point API over the transparent
// glyph spans. On arm it also adopts a pre-existing single-paragraph browser
// selection. Every caret is clamped to the bbox of the paragraph locked on
// press, so a selection can never cross blocks. Reports
// { text, paragraphSentences } upward; the parent owns Accept/Cancel.
//
// Coordinate contract: `blocks[*].boxes` and `scale` are expressed in the SAME
// local space as the glyph spans beneath this layer. Paginated mode passes
// page blocks at page scale; tracking mode (a single BlockCrop) passes one
// crop-local synthetic block at the crop's px-per-pt — so the same component
// drives selection in both modes.
export default function SearchSelectionLayer({ blocks, scale, onSearchSelect }) {
  const ref = useRef(null)
  const paraRef = useRef(null)                 // { box, sentences } locked on click 1
  const [startC, setStartC] = useState(null)   // { node, offset }
  const [endC, setEndC] = useState(null)
  const [dragging, setDragging] = useState(null)  // 'start' | 'end' | null
  // Selection rendered from DOM measurement (rects + handle positions). Computed
  // in an effect (post-render) so we never read the ref during render.
  const [view, setView] = useState({ rects: [] })

  // Resolve the text caret under a client point. The drawing overlay sits ABOVE
  // the pdfjs text layer, so we momentarily disable its pointer-events while
  // hit-testing — otherwise caretRangeFromPoint returns this empty overlay div
  // instead of the glyph spans beneath. Only a real text node counts; on miss
  // we warn and return null without touching React state (safety fallback).
  const caretAt = (cx, cy) => {
    const el = ref.current
    const prevPE = el ? el.style.pointerEvents : ''
    if (el) el.style.pointerEvents = 'none'
    let res = null
    try {
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(cx, cy)
        if (r && r.startContainer && r.startContainer.nodeType === Node.TEXT_NODE) {
          res = { node: r.startContainer, offset: r.startOffset }
        }
      } else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(cx, cy)
        if (p && p.offsetNode && p.offsetNode.nodeType === Node.TEXT_NODE) {
          res = { node: p.offsetNode, offset: p.offset }
        }
      }
    } catch (err) {
      console.warn('SearchSelectionLayer: caret hit-test failed', err)
    } finally {
      if (el) el.style.pointerEvents = prevPE
    }
    if (!res) console.warn('SearchSelectionLayer: no text node under point', cx, cy)
    return res
  }

  const paragraphAt = (px, py) => {
    for (const b of (blocks || [])) {
      const bs = b.boxes || []
      if (!bs.length || b.role === 'ignored') continue
      const x0 = Math.min(...bs.map(x => x.x0)) * scale
      const y0 = Math.min(...bs.map(x => x.y0)) * scale
      const x1 = Math.max(...bs.map(x => x.x1)) * scale
      const y1 = Math.max(...bs.map(x => x.y1)) * scale
      if (px >= x0 - 4 && px <= x1 + 4 && py >= y0 - 4 && py <= y1 + 4) {
        return { box: { x0, y0, x1, y1 }, sentences: (b.sentences || []).map(s => s.text) }
      }
    }
    return null
  }

  // Clamp a client point into the locked paragraph's box (keeps carets inside).
  const clampClient = (cx, cy) => {
    const lr = ref.current?.getBoundingClientRect()
    const p = paraRef.current
    if (!lr || !p) return { cx, cy }
    return {
      cx: Math.min(Math.max(cx, lr.left + p.box.x0 + 1), lr.left + p.box.x1 - 1),
      cy: Math.min(Math.max(cy, lr.top + p.box.y0 + 1), lr.top + p.box.y1 - 1),
    }
  }

  // Order two carets into document order (start precedes end).
  const orderCarets = (a, b) => {
    if (!a || !b) return [a, b]
    const cmp = a.node.compareDocumentPosition(b.node)
    const aFirst = (cmp & Node.DOCUMENT_POSITION_FOLLOWING)
      || (a.node === b.node && a.offset <= b.offset)
    return aFirst ? [a, b] : [b, a]
  }

  // Place the start caret (locking the paragraph) from a client point.
  const placeStart = (clientX, clientY, lr) => {
    const para = paragraphAt(clientX - lr.left, clientY - lr.top)
    if (!para) return false
    const c = caretAt(clientX, clientY)
    if (!c) return false
    paraRef.current = para
    setStartC(c)
    setEndC(null)
    return true
  }

  // Touch can't disambiguate a drag (scroll vs select), so touch uses TWO TAPS
  // (tap start, tap end, tap again to restart) + draggable knobs to refine.
  // Mouse/pen press-drag live and a press without a drag leaves the first caret.
  const onPointerDown = (e) => {
    if (e.button != null && e.button > 0) return
    const lr = ref.current?.getBoundingClientRect(); if (!lr) return

    if (e.pointerType === 'touch') {
      if (startC && !endC) {
        const { cx, cy } = clampClient(e.clientX, e.clientY)
        const c = caretAt(cx, cy)
        if (c) setEndC(c)        // tap 2 → close the selection
      } else {
        placeStart(e.clientX, e.clientY, lr)  // tap 1 (or restart after a full pair)
      }
      return
    }

    // Mouse / pen: live drag-select.
    if (placeStart(e.clientX, e.clientY, lr)) {
      e.preventDefault()         // suppress native drag-select under the overlay
      setDragging('new')
    }
  }

  // Build the ordered DOM range from the two carets (null if incomplete/invalid).
  const orderedRange = () => {
    if (!startC || !endC) return null
    try {
      const cmp = startC.node.compareDocumentPosition(endC.node)
      const startFirst = (cmp & Node.DOCUMENT_POSITION_FOLLOWING)
        || (startC.node === endC.node && startC.offset <= endC.offset)
      const a = startFirst ? startC : endC
      const b = startFirst ? endC : startC
      const r = document.createRange()
      r.setStart(a.node, a.offset)
      r.setEnd(b.node, b.offset)
      return r
    } catch { return null }
  }

  // On arm, adopt an existing browser text selection as the initial carets —
  // but only if it is crawlable (both endpoints are real text nodes over the
  // glyph layer) and confined to a SINGLE paragraph of this page. Otherwise
  // leave it untouched so the user selects manually.
  useEffect(() => {
    const selObj = window.getSelection?.()
    if (!selObj || selObj.rangeCount === 0 || selObj.isCollapsed) return
    const range = selObj.getRangeAt(0)
    const sNode = range.startContainer
    const eNode = range.endContainer
    if (sNode.nodeType !== Node.TEXT_NODE || eNode.nodeType !== Node.TEXT_NODE) return
    const lr = ref.current?.getBoundingClientRect(); if (!lr) return
    const rcs = range.getClientRects(); if (!rcs.length) return
    const first = rcs[0]
    const last = rcs[rcs.length - 1]
    const startPara = paragraphAt(first.left + 1 - lr.left, first.top + first.height / 2 - lr.top)
    const endPara = paragraphAt(last.right - 1 - lr.left, last.top + last.height / 2 - lr.top)
    if (!startPara || !endPara) return                       // outside paragraphs / other page
    const b1 = startPara.box, b2 = endPara.box
    if (b1.x0 !== b2.x0 || b1.y0 !== b2.y0 || b1.x1 !== b2.x1 || b1.y1 !== b2.y1) return  // >1 paragraph
    paraRef.current = startPara
    setStartC({ node: sNode, offset: range.startOffset })
    setEndC({ node: eNode, offset: range.endOffset })
    try { selObj.removeAllRanges() } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Measure the selection after carets change and report it up. DOM reads
  // (getClientRects) belong here, post-render — never during render.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const lr = el.getBoundingClientRect()
    // Caret placed, second end pending → render the marker (stem + knob) at the
    // start so the user sees where the press landed (no selection text yet).
    if (startC && !endC) {
      try {
        const cr = document.createRange()
        cr.setStart(startC.node, startC.offset)
        cr.collapse(true)
        const rc = cr.getBoundingClientRect()
        setView({ rects: [], caret: { left: rc.left - lr.left, top: rc.top - lr.top, height: rc.height || 16 } })
      } catch {
        setView({ rects: [] })
      }
      onSearchSelect?.(null)
      return
    }
    const range = orderedRange()
    if (!range) {
      setView({ rects: [] })
      onSearchSelect?.(null)
      return
    }
    const rects = Array.from(range.getClientRects()).map(rc => ({
      left: rc.left - lr.left, top: rc.top - lr.top, width: rc.width, height: rc.height,
    }))
    setView({ rects })
    const text = range.toString().replace(/\s+/g, ' ').trim()
    onSearchSelect?.(text ? { text, paragraphSentences: paraRef.current?.sentences || [] } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startC, endC])

  // Drag a knob: move the corresponding caret, clamped to the paragraph.
  useEffect(() => {
    if (!dragging) return
    const onMove = (ev) => {
      const { cx, cy } = clampClient(ev.clientX, ev.clientY)
      const c = caretAt(cx, cy)
      if (!c) return
      // 'new' (fresh drag-select) and a lone start caret both grow by moving the
      // END; 'start'/'end' on a real selection move their own caret.
      if (dragging === 'start' && endC) setStartC(c)
      else setEndC(c)
    }
    const onUp = () => setDragging(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    // Mobile gestures (scroll takeover, system gesture, incoming call) fire
    // pointercancel instead of pointerup — end the drag so it never wedges.
    window.addEventListener('pointercancel', onUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // endC is read as captured when the drag starts — re-binding on every endC
    // change would tear down the in-progress pointer listeners mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])

  const rects = view.rects
  const firstRect = rects[0]
  const lastRect = rects[rects.length - 1]
  // edge = which side of the rect to anchor on ('left'|'right'); dragSide = the
  // caret ('start'|'end') this handle actually moves. A 44px transparent pad
  // (touch-target minimum) carries the 14px visual circle at its centre, and
  // its touch-action:none commits the gesture to dragging (no page scroll).
  const HIT = 44
  const knob = (rect, edge, dragSide) => rect && (
    <div
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(dragSide) }}
      className="absolute z-30 flex items-center justify-center"
      style={{
        left: (edge === 'left' ? rect.left : rect.left + rect.width) - HIT / 2,
        top: rect.top + rect.height / 2 - HIT / 2,
        width: HIT, height: HIT,
        cursor: 'ew-resize', pointerEvents: 'auto', touchAction: 'none',
      }}
    >
      <div className="rounded-full" style={{
        width: 14, height: 14,
        background: 'rgb(79,70,229)', border: '2px solid white',
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      }} />
    </div>
  )

  // First caret placed, second pending: a thin stem + the same circle knob the
  // finished selection uses, so the marker reads as a draggable handle.
  const caretRect = view.caret && { left: view.caret.left, top: view.caret.top, width: 0, height: view.caret.height }

  // Map each visual knob to the caret it actually controls: rects are in
  // document order, so the first knob drives whichever of startC/endC comes
  // first. This keeps the left handle moving the left caret without ever
  // reordering state.
  const firstSide = (startC && endC && orderCarets(startC, endC)[0] === endC) ? 'end' : 'start'
  const lastSide = firstSide === 'start' ? 'end' : 'start'

  return (
    <div ref={ref} className="absolute inset-0 z-20" style={{ cursor: 'text', touchAction: dragging ? 'none' : 'auto' }} onPointerDown={onPointerDown}>
      {rects.map((r, i) => (
        <div key={i} className="absolute pointer-events-none rounded-sm"
          style={{ left: r.left, top: r.top, width: r.width, height: r.height, background: 'rgba(99,102,241,0.30)' }} />
      ))}
      {caretRect && (
        <div className="absolute pointer-events-none rounded-sm"
          style={{ left: caretRect.left, top: caretRect.top, width: 2, height: caretRect.height, background: 'rgb(79,70,229)' }} />
      )}
      {caretRect && knob(caretRect, 'left', 'start')}
      {knob(firstRect, 'left', firstSide)}
      {knob(lastRect, 'right', lastSide)}
    </div>
  )
}
