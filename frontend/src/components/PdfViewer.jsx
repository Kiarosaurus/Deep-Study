import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import LinearReader from './LinearReader'
import { resolveSentenceIndices, buildContinuationPayloads, mergedIndicesToOrig } from './highlight-utils'
import { usePdfDocument } from './use-pdf-document'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const ZOOM_MIN  = 0.5
const ZOOM_MAX  = 3.0
const ZOOM_STEP = 0.2

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

// Linear sequence built directly from linearBlocks (already in global reading
// order, one bbox per block). Title is included so the first stop on activation
// lands on the paper title rather than skipping straight to the first paragraph.
// Section headers / captions / authors / equations / code remain visible but are
// skipped for navigation.
const _LINEAR_STOP_ROLES = new Set(['title', 'paragraph', 'figure', 'table'])

function buildLinearReadingSequence(linearBlocks) {
  if (!linearBlocks) return []
  const seq = []
  for (let i = 0; i < linearBlocks.length; i++) {
    const b = linearBlocks[i]
    if (!_LINEAR_STOP_ROLES.has(b.role)) continue
    const kind = b.role === 'paragraph' ? 'p'
               : b.role === 'title'     ? 'h'
               : 'i'
    seq.push({
      kind,
      reading_index: b.reading_index ?? 0,
      blockIdx: i,
      // Fallback to legacy `paragraph_ref` for analysis.json files cached
      // before the rename; new files use `flat_block_ref`.
      flat_block_ref: b.flat_block_ref ?? b.paragraph_ref ?? null,
    })
  }
  return seq
}

function ZoomToolbar({ displayZoom, onIncrease, onDecrease, onFit, canIncrease, canDecrease }) {
  const btn = "w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30 disabled:pointer-events-none transition-colors text-base font-semibold"
  return (
    <div className="absolute top-4 right-4 z-30 flex items-center gap-0.5 bg-white/95 backdrop-blur rounded-xl shadow-md border border-slate-200 p-1 select-none">
      <button onClick={onDecrease} disabled={!canDecrease} title="Texto más pequeño (−)" className={btn}>−</button>
      <button
        onClick={onFit}
        title="Ajustar a 100%"
        className="px-2.5 h-8 flex items-center justify-center rounded-lg text-[11px] font-bold tabular-nums text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors min-w-[3.25rem]"
      >
        {Math.round(displayZoom * 100)}%
      </button>
      <button onClick={onIncrease} disabled={!canIncrease} title="Texto más grande (+)" className={btn}>+</button>
    </div>
  )
}

function ParagraphOverlay({ blocks, images = [], page, flatBase = 0, chainPayloads, chainIds, scale, onExplain, activeParagraph, currentExplanation, explanation, hoveredChain, onHoveredChainChange }) {
  const [hoveredImgIdx, setHoveredImgIdx] = useState(null)

  if ((!blocks && !images?.length) || !scale) return null

  const allItems = explanation?.sentence_explanations ?? []

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {(blocks ?? []).map((block, i) => {
        const paragraphBoxes = block.boxes ?? []
        if (paragraphBoxes.length === 0) return null

        const ownFlatRef = flatBase + i
        // Chain payload (merged text + sentences across continuation chain).
        // Falls back to this block alone when no chain or no payload computed.
        const payload = chainPayloads?.[ownFlatRef] ?? {
          text: block.text ?? '',
          sentences: block.sentences ?? [],
          offset: 0,
          boundaries: [],
          mergedSentences: block.sentences ?? [],
          mergedToOrig: (block.sentences ?? []).map((_, i) => [i]),
        }
        const chainId   = chainIds?.[ownFlatRef]
        const chainKey  = chainId != null ? `c-${chainId}` : `__b-${page}-${i}`
        const isHovered = hoveredChain != null && chainKey === hoveredChain
        const ownLen    = block.sentences?.length ?? 0
        const ownOffset = payload.offset ?? 0
        // Match by merged payload text so every block in the chain lights up
        // together; fall back to flat_block_ref for cross-mode hand-off. Empty
        // text never matches — figures with empty caption would otherwise
        // light up every empty paragraph block.
        const isActive  = (!!payload.text && activeParagraph?.text === payload.text)
                       || (activeParagraph?.flatBlockRef != null
                           && activeParagraph.flatBlockRef === ownFlatRef)

        const lastBox    = paragraphBoxes[paragraphBoxes.length - 1]
        const anchorLeft = lastBox.x1 * scale
        const anchorTop  = lastBox.y1 * scale

        // Localize merged-array indices back into this block's own sentence
        // array — indices outside [ownOffset, ownOffset+ownLen) belong to
        // other chain members and are dropped here.
        const localizeIndices = (mergedIndices) => {
          const out = []
          for (const idx of mergedIndices) {
            if (idx >= ownOffset && idx < ownOffset + ownLen) out.push(idx - ownOffset)
          }
          return out
        }

        const mergedSentences = payload.mergedSentences ?? payload.sentences
        const mergedToOrig    = payload.mergedToOrig
          ?? payload.sentences.map((_, i) => [i])
        const resolveAndMap = (item) =>
          mergedIndicesToOrig(
            resolveSentenceIndices(mergedSentences, item),
            mergedToOrig,
          )

        const currentIndices = (isActive && currentExplanation && ownLen)
          ? localizeIndices(resolveAndMap(currentExplanation))
          : []
        const currentSet = new Set(currentIndices)

        const otherIndices = (isActive && allItems.length && ownLen)
          ? [...new Set(
              allItems
                .filter(it => it !== currentExplanation)
                .flatMap(it => localizeIndices(resolveAndMap(it)))
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
              onClick={() => onExplain(payload.text, mergedSentences, ownFlatRef)}
              onMouseEnter={() => onHoveredChainChange?.(chainKey)}
              onMouseLeave={() => onHoveredChainChange?.(null)}
              title="Explicar párrafo"
            >
              ✦
            </button>
          </div>
        )
      })}

      {(images ?? []).map((img, i) => {
        const b = img.bbox
        if (!b) return null
        const isHovered  = hoveredImgIdx === i
        const left       = b.x0 * scale
        const top        = b.y0 * scale
        const width      = (b.x1 - b.x0) * scale
        const height     = (b.y1 - b.y0) * scale
        const anchorLeft = b.x1 * scale
        const anchorTop  = b.y1 * scale
        const imgRole    = img.role || 'figure'
        const isImgActive = activeParagraph?.role === imgRole
          && activeParagraph?.page === page
          && activeParagraph?.bbox?.x0 === b.x0
          && activeParagraph?.bbox?.y0 === b.y0
        const cap = isImgActive ? img.caption_bbox : null
        return (
          <div key={`img-${i}`}>
            <div
              className="absolute rounded-sm transition-opacity duration-150"
              style={{
                left, top, width, height,
                background: isImgActive
                  ? 'rgba(99,102,241,0.08)'
                  : (isHovered ? 'rgba(99,102,241,0.07)' : 'transparent'),
                border: isImgActive
                  ? '1px solid rgba(99,102,241,0.45)'
                  : (isHovered ? '1px solid rgba(99,102,241,0.22)' : '1px solid transparent'),
              }}
            />
            {cap && (
              <div
                className="absolute pointer-events-none rounded-sm bg-yellow-300/40 transition-all duration-300 ease-out"
                style={{
                  left:   cap.x0 * scale,
                  top:    cap.y0 * scale,
                  width:  (cap.x1 - cap.x0) * scale,
                  height: (cap.y1 - cap.y0) * scale,
                  mixBlendMode: 'multiply',
                }}
              />
            )}
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
              onClick={() => onExplain(
                img.caption_text || '',
                [],
                null,
                {
                  role: img.role || 'figure',
                  page,
                  bbox: img.bbox,
                  caption_text: img.caption_text || '',
                },
              )}
              onMouseEnter={() => setHoveredImgIdx(i)}
              onMouseLeave={() => setHoveredImgIdx(null)}
              title={`Explicar ${img.role === 'table' ? 'tabla' : 'figura'}`}
            >
              ✦
            </button>
          </div>
        )
      })}
    </div>
  )
}

function PdfPage({ pageNumber, width, blocks, images = [], flatBase, chainPayloads, chainIds, onExplain, activeParagraph, currentExplanation, explanation, trackedBox, hoveredChain, onHoveredChainChange }) {
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
        images={images}
        page={pageNumber}
        flatBase={flatBase}
        chainPayloads={chainPayloads}
        chainIds={chainIds}
        scale={scale}
        onExplain={onExplain}
        activeParagraph={activeParagraph}
        currentExplanation={currentExplanation}
        explanation={explanation}
        hoveredChain={hoveredChain}
        onHoveredChainChange={onHoveredChainChange}
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

const PdfViewer = forwardRef(function PdfViewer({ file, onExplain, pages, linearBlocks = [], activeParagraph, currentExplanation, explanation, onHome }, ref) {
  const [numPages, setNumPages]               = useState(null)
  const [hoveredChain, setHoveredChain]       = useState(null)
  const [containerWidth, setContainerWidth]   = useState(null)
  const [userZoom, setUserZoom]               = useState(1.0)
  const [tracking, setTracking]               = useState(false)
  const [currentStop, setCurrentStop]         = useState(0)

  const containerRef = useRef(null)
  const userZoomRef  = useRef(1.0)
  const trackingToolbarRef = useRef(null)
  // Scroll preservation across tracking toggle. lastLinearBlockIdxRef stores
  // the linearBlocks index the user was reading in tracking mode; restored
  // when they toggle back on after a paginated detour. lastPaginatedFlatRef
  // is the flat_block_ref of the paragraph closest to the viewport when they
  // toggle on from paginated, used to land tracking on the same content.
  const lastLinearBlockIdxRef  = useRef(null)
  const lastPaginatedFlatRef   = useRef(null)

  // Cross-document hand-off: flat indices from a previous document do not
  // address valid stops in the new one, so refs are wiped when the file prop
  // flips. Reader.jsx keeps PdfViewer mounted across navigations, so without
  // this reset a stale ref could land tracking at an arbitrary stop.
  useEffect(() => {
    lastLinearBlockIdxRef.current = null
    lastPaginatedFlatRef.current  = null
  }, [file])

  // Lazy-load the pdfjs doc the first time tracking activates and keep it
  // alive for the lifetime of this viewer. LinearReader unmounts on toggle off
  // but the doc + page-canvas cache survive, so re-activating doesn't re-fetch
  // or re-parse the PDF.
  const [docNeeded, setDocNeeded] = useState(false)
  useEffect(() => {
    // Intentional latch: flip on first activation, never reset. Drives the
    // lazy-mount of the shared pdfjs doc so paginated-only sessions don't pay
    // the parsing cost.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tracking) setDocNeeded(true)
  }, [tracking])
  const sharedPdfDoc = usePdfDocument(docNeeded ? file : null)

  useEffect(() => { userZoomRef.current = userZoom }, [userZoom])

  // ── Tracking mode ───────────────────────────────────────────────────────────
  const paginatedSequence = useMemo(() => buildReadingSequence(pages), [pages])
  const linearSequence    = useMemo(() => buildLinearReadingSequence(linearBlocks), [linearBlocks])
  const readingSequence   = tracking ? linearSequence : paginatedSequence

  const pageDims = useMemo(
    () => pages
      ? Object.fromEntries(pages.map(p => [p.page, { width: p.width, height: p.height }]))
      : {},
    [pages],
  )

  // Flat index base per page (cumulative count of pages[*].blocks). Lets each
  // ✦ click forward a global paragraph_ref so linear-mode sync can find the
  // same paragraph in linearBlocks.
  const flatBaseByPage = useMemo(() => {
    if (!pages) return {}
    const out = {}
    let cum = 0
    for (const p of pages) {
      out[p.page] = cum
      cum += (p.blocks?.length || 0)
    }
    return out
  }, [pages])

  // pageWidth recomputado abajo; capturamos vía ref para usar en scrollToStop
  const pageWidthRef = useRef(0)

  // Imperative scroll API for Reader.jsx. centerBlock(linearIdx, opts) brings
  // a specific linearBlocks entry into view; routes to tracking or paginated
  // logic based on current mode. onlyIfHidden skips the scroll when the block
  // is already on screen, used for paragraph-change auto-follow.
  useImperativeHandle(ref, () => ({
    centerBlock(linearIdx, options = {}) {
      const { onlyIfHidden = false, smooth = true, alternatives = null } = options
      const container = containerRef.current
      if (!container || linearIdx == null || !linearBlocks[linearIdx]) return

      // Effective top of the viewable area — tracking toolbar overlays the
      // container top, so blocks under it aren't really visible.
      const effectiveTop = () => {
        const cTop = container.getBoundingClientRect().top
        if (tracking && trackingToolbarRef.current) {
          const t = trackingToolbarRef.current
          return cTop + t.offsetTop + t.offsetHeight
        }
        return cTop
      }

      // ≥50% of block height inside the (toolbar-adjusted) viewport.
      const isBlockVisible = (idx) => {
        if (idx == null || !linearBlocks[idx]) return false
        const cRect = container.getBoundingClientRect()
        const topClip = effectiveTop()
        const botClip = cRect.bottom
        let elTop, elBot
        if (tracking) {
          const el = container.querySelector(`[data-block-idx="${idx}"]`)
          if (!el) return false
          const eRect = el.getBoundingClientRect()
          elTop = eRect.top
          elBot = eRect.bottom
        } else {
          const block = linearBlocks[idx]
          const pageEl = container.querySelector(`[data-page="${block.page}"]`)
          if (!pageEl) return false
          const dim = pageDims[block.page]
          const pw  = pageWidthRef.current
          if (!dim?.width || !pw) return false
          const scale = pw / dim.width
          const pRect = pageEl.getBoundingClientRect()
          elTop = pRect.top + block.bbox.y0 * scale
          elBot = pRect.top + block.bbox.y1 * scale
        }
        const overlap = Math.max(0, Math.min(elBot, botClip) - Math.max(elTop, topClip))
        const blockH  = Math.max(1, elBot - elTop)
        const viewH   = Math.max(1, botClip - topClip)
        return overlap >= Math.min(blockH, viewH) * 0.5
      }

      if (onlyIfHidden) {
        const candidates = Array.isArray(alternatives) && alternatives.length
          ? alternatives
          : [linearIdx]
        if (candidates.some(isBlockVisible)) return
      }

      const cRect = container.getBoundingClientRect()
      const topClip = effectiveTop()
      const viewH   = Math.max(1, cRect.bottom - topClip)

      let elTopAbs, elH
      if (tracking) {
        const el = container.querySelector(`[data-block-idx="${linearIdx}"]`)
        if (!el) return
        const eRect = el.getBoundingClientRect()
        elTopAbs = eRect.top
        elH = eRect.height
      } else {
        const block = linearBlocks[linearIdx]
        const pageEl = container.querySelector(`[data-page="${block.page}"]`)
        if (!pageEl) return
        const dim = pageDims[block.page]
        const pw  = pageWidthRef.current
        if (!dim?.width || !pw) return
        const scale = pw / dim.width
        const pRect = pageEl.getBoundingClientRect()
        elTopAbs = pRect.top + block.bbox.y0 * scale
        elH = (block.bbox.y1 - block.bbox.y0) * scale
      }
      // Center vertically inside the toolbar-adjusted viewport. If block is
      // taller than the viewport, align its top to the top of the area instead
      // so the start of the content lands in view rather than the middle.
      const offsetIntoView = elH >= viewH
        ? 12
        : (viewH - elH) / 2
      const targetY = container.scrollTop
                    + (elTopAbs - cRect.top)
                    - (topClip - cRect.top + offsetIntoView)
      container.scrollTo({ top: Math.max(0, targetY), behavior: smooth ? 'smooth' : 'auto' })
    },

    // Sentence-level scroll. boxes are sentence rects in PDF-point coords
    // (same units as block.bbox). onlyIfNotFullyVisible skips when the entire
    // sentence is already within the visible viewport.
    centerSentence(linearIdx, boxes, options = {}) {
      const { onlyIfNotFullyVisible = false, smooth = true } = options
      const container = containerRef.current
      if (!container || linearIdx == null || !linearBlocks[linearIdx] || !boxes?.length) return

      const block = linearBlocks[linearIdx]
      let bY0 = Infinity, bY1 = -Infinity
      for (const b of boxes) {
        if (b?.y0 != null && b.y0 < bY0) bY0 = b.y0
        if (b?.y1 != null && b.y1 > bY1) bY1 = b.y1
      }
      if (bY0 === Infinity || bY1 === -Infinity) return

      const effectiveTop = () => {
        const cTop = container.getBoundingClientRect().top
        if (tracking && trackingToolbarRef.current) {
          const t = trackingToolbarRef.current
          return cTop + t.offsetTop + t.offsetHeight
        }
        return cTop
      }

      let sTop, sBot
      if (tracking) {
        const el = container.querySelector(`[data-block-idx="${linearIdx}"]`)
        if (!el) return
        const wrapperRect = el.getBoundingClientRect()
        // Mirror BlockCrop's inflation logic so sentence-to-canvas mapping is
        // exact. Equations get a larger vertical pad.
        const yInflate = block.role === 'equation' ? 4 : 2
        const dim = pageDims[block.page]
        const inflY0 = Math.max(0, block.bbox.y0 - yInflate)
        const inflY1 = dim?.height
          ? Math.min(dim.height, block.bbox.y1 + yInflate)
          : block.bbox.y1 + yInflate
        const bbH = Math.max(1, inflY1 - inflY0)
        const scale = wrapperRect.height / bbH
        sTop = wrapperRect.top + (bY0 - inflY0) * scale
        sBot = wrapperRect.top + (bY1 - inflY0) * scale
      } else {
        const pageEl = container.querySelector(`[data-page="${block.page}"]`)
        if (!pageEl) return
        const dim = pageDims[block.page]
        const pw  = pageWidthRef.current
        if (!dim?.width || !pw) return
        const scale = pw / dim.width
        const pRect = pageEl.getBoundingClientRect()
        sTop = pRect.top + bY0 * scale
        sBot = pRect.top + bY1 * scale
      }

      const cRect = container.getBoundingClientRect()
      const topClip = effectiveTop()
      const botClip = cRect.bottom

      if (onlyIfNotFullyVisible) {
        const fully = sTop >= topClip - 1 && sBot <= botClip + 1
        if (fully) return
      }

      const sentH = Math.max(1, sBot - sTop)
      const viewH = Math.max(1, botClip - topClip)
      const offsetIntoView = sentH >= viewH ? 12 : (viewH - sentH) / 2
      const targetY = container.scrollTop
                    + (sTop - cRect.top)
                    - (topClip - cRect.top + offsetIntoView)
      container.scrollTo({ top: Math.max(0, targetY), behavior: smooth ? 'smooth' : 'auto' })
    },
  }), [tracking, linearBlocks, pageDims])

  function scrollToStop(stop) {
    const container = containerRef.current
    if (!container || !stop) return

    // Linear stop: scroll to the data-block-idx wrapper inside LinearReader.
    if (typeof stop.blockIdx === 'number') {
      const el = container.querySelector(`[data-block-idx="${stop.blockIdx}"]`)
      if (!el) return
      const containerRect = container.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      // Tracking toolbar sits 16px from container top; offset = its bottom
      // edge plus a small breathing gap so the block lands clear of the chrome.
      const toolbar = trackingToolbarRef.current
      const toolbarH = toolbar ? toolbar.offsetTop + toolbar.offsetHeight : 0
      const targetY = container.scrollTop
                    + (elRect.top - containerRect.top)
                    - (toolbarH + 12)
      container.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' })
      return
    }

    // Paginated stop: position the bbox 25% from the viewport top.
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

  // Translate a global flat_block_ref (paginated paragraph index, cumulative
  // across pages[*].blocks) into a paginated stop { page, bbox } for scrolling.
  function findPaginatedStopByFlat(flatRef) {
    if (flatRef == null || !pages) return null
    let cum = 0
    for (const p of pages) {
      const blocks = p.blocks ?? []
      if (flatRef < cum + blocks.length) {
        const b = blocks[flatRef - cum]
        if (b?.boxes?.length) return { page: p.page, bbox: b.boxes[0] }
        return null
      }
      cum += blocks.length
    }
    return null
  }

  // Paginated Document re-mounts on toggle off; its data-page wrappers exist
  // before react-pdf has measured the Page, so getBoundingClientRect().top is
  // unreliable until layout completes. Retry on rAF until both the wrapper
  // exists AND it has non-trivial height (a proxy for the Page having rendered
  // its first viewport). Cap retries to avoid a runaway loop.
  function scheduleScrollToPaginatedFlat(flatRef, attempts = 0) {
    if (attempts > 60 || flatRef == null) return
    const target = findPaginatedStopByFlat(flatRef)
    if (!target) return
    const container = containerRef.current
    const el = container?.querySelector(`[data-page="${target.page}"]`)
    const ready = el && pageWidthRef.current && el.getBoundingClientRect().height > 20
    if (!ready) {
      requestAnimationFrame(() => scheduleScrollToPaginatedFlat(flatRef, attempts + 1))
      return
    }
    scrollToStop(target)
  }

  // Closest paginated paragraph to the current viewport top — sampled BEFORE
  // toggling on so tracking can land on the user's reading position rather
  // than at the document start. Iterates pages[*].blocks in flat order and
  // picks the one whose rendered top is nearest the container's top edge.
  function findClosestPaginatedFlatRef() {
    const container = containerRef.current
    if (!container || !pages) return null
    const cRect = container.getBoundingClientRect()
    let best = { flat: null, dist: Infinity }
    let flat = 0
    for (const p of pages) {
      const blocks = p.blocks ?? []
      const pageEl = container.querySelector(`[data-page="${p.page}"]`)
      if (!pageEl) { flat += blocks.length; continue }
      const pageRect = pageEl.getBoundingClientRect()
      if (pageRect.bottom < cRect.top) { flat += blocks.length; continue }
      if (pageRect.top > cRect.bottom) break
      const pw = pageWidthRef.current
      const scale = pw && p.width ? pw / p.width : 0
      for (const b of blocks) {
        const y0 = b.boxes?.[0]?.y0 ?? 0
        const top = pageRect.top + y0 * scale
        const dist = Math.abs(top - cRect.top)
        if (dist < best.dist) best = { flat, dist }
        flat++
      }
    }
    return best.flat
  }

  // Toggle ON/OFF → preserve reading position across modes. scrollTop is
  // shared between paginated and linear, so a raw carry-over lands in
  // unrelated content; instead, on ON pick the matching linear stop
  // (activeParagraph > closest paginated paragraph > last linear position),
  // and on OFF save the current linear stop and scroll the paginated view
  // to the corresponding paragraph.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (tracking) {
      let initialIdx = null
      const ar = activeParagraph?.flatBlockRef
      if (ar != null) {
        const idx = linearSequence.findIndex(s => s.flat_block_ref === ar)
        if (idx >= 0) initialIdx = idx
      }
      if (initialIdx == null && lastPaginatedFlatRef.current != null) {
        const idx = linearSequence.findIndex(
          s => s.flat_block_ref === lastPaginatedFlatRef.current,
        )
        if (idx >= 0) initialIdx = idx
      }
      if (initialIdx == null && lastLinearBlockIdxRef.current != null) {
        const idx = linearSequence.findIndex(
          s => s.blockIdx === lastLinearBlockIdxRef.current,
        )
        if (idx >= 0) initialIdx = idx
      }
      setCurrentStop(initialIdx ?? 0)
      if (initialIdx == null) container.scrollTo({ top: 0, behavior: 'auto' })
      // When initialIdx is set, the auto-scroll effect below scrolls to it
      // once the linear blocks mount.
    } else {
      const stop = linearSequence[currentStop]
      if (stop) lastLinearBlockIdxRef.current = stop.blockIdx
      const ref = stop?.flat_block_ref
      if (ref == null) {
        container.scrollTo({ top: 0, behavior: 'auto' })
      } else {
        scheduleScrollToPaginatedFlat(ref)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking])

  function handleToggleTracking() {
    if (!tracking) {
      // About to turn ON — capture the closest visible paginated paragraph so
      // tracking can resume at the same content. Esc / forced OFF goes through
      // the toggle effect, which captures the linear blockIdx there instead.
      const ref = findClosestPaginatedFlatRef()
      if (ref != null) lastPaginatedFlatRef.current = ref
    }
    setTracking(t => !t)
  }

  // Linear-mode sync: when an active paragraph is set (or changes), jump the
  // tracking cursor to the linear stop whose flat_block_ref matches. Fires
  // both on tracking → true (deferred to after the reset above) and on
  // subsequent ✦ clicks while tracking remains on.
  useEffect(() => {
    if (!tracking) return
    const ref = activeParagraph?.flatBlockRef
    if (ref == null) return
    const idx = linearSequence.findIndex(s => s.flat_block_ref === ref)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (idx >= 0) setCurrentStop(idx)
  }, [tracking, activeParagraph, linearSequence])

  // Auto-scroll al cambiar stop / activar tracking / re-zoom. scrollToStop is
  // a closure over refs + pageDims; pulling it into deps would force a
  // useCallback wrapper for no behavioural gain (the effect already re-fires
  // on every input that scrollToStop reads).
  useEffect(() => {
    if (!tracking) return
    const stop = readingSequence[currentStop]
    if (!stop) return
    const id = requestAnimationFrame(() => scrollToStop(stop))
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking, currentStop, readingSequence, userZoom, containerWidth])

  // Teclado en tracking mode. Wheel = scroll nativo (sin intercepción).
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

    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      
      const viewportFactor = tracking ? 0.1 : 0.55
      
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        node.scrollBy({ top: node.clientHeight * viewportFactor, behavior: 'smooth' })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        node.scrollBy({ top: -node.clientHeight * viewportFactor, behavior: 'smooth' })
      } else if (e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault(); step(1)
      } else if (e.key === 'PageUp') {
        e.preventDefault(); step(-1)
      } else if (e.key === 'Escape') {
        setTracking(false)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
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
  const imagesMap = pages
    ? Object.fromEntries(pages.map(p => [p.page, p.images ?? []]))
    : {}
  // Chain payloads computed over the flat across-pages block list so a
  // continuation chain that crosses a page boundary still resolves. Indexed
  // by flat block ref (page-cumulative position in pages[*].blocks) — same
  // index ParagraphOverlay uses via `flatBase + i`.
  const paginatedChainPayloads = useMemo(() => {
    const flat = (pages ?? []).flatMap(p => p.blocks ?? [])
    return buildContinuationPayloads(flat)
  }, [pages])

  // Per-flat-block chain head index. Keyed by the inner `sentences` array
  // reference — buildContinuationPayloads gives every chain member its OWN
  // wrapper object (different `offset`) but the same merged `sentences`
  // array, so the inner array is the stable identity that groups chain
  // members together while still distinguishing separate chains with
  // identical text.
  const paginatedChainIds = useMemo(() => {
    const headByPayload = new Map()
    const ids = new Array(paginatedChainPayloads.length).fill(null)
    for (let i = 0; i < paginatedChainPayloads.length; i++) {
      const pay = paginatedChainPayloads[i]
      if (!pay) continue
      const key = pay.sentences
      if (!headByPayload.has(key)) headByPayload.set(key, i)
      ids[i] = headByPayload.get(key)
    }
    return ids
  }, [paginatedChainPayloads])

  const currentStopData = tracking ? readingSequence[currentStop] : null

  return (
    <div className="relative h-full bg-gray-100">
      {tracking ? (
        <ZoomToolbar
          displayZoom={1 / userZoom}
          onIncrease={zoomOut}
          onDecrease={zoomIn}
          onFit={zoomFit}
          canIncrease={userZoom > ZOOM_MIN + 1e-3}
          canDecrease={userZoom < ZOOM_MAX - 1e-3}
        />
      ) : (
        <ZoomToolbar
          displayZoom={userZoom}
          onIncrease={zoomIn}
          onDecrease={zoomOut}
          onFit={zoomFit}
          canIncrease={userZoom < ZOOM_MAX - 1e-3}
          canDecrease={userZoom > ZOOM_MIN + 1e-3}
        />
      )}

      {/* Tracking toolbar */}
      <div ref={trackingToolbarRef} className="absolute top-4 left-4 z-30 flex items-center gap-1 bg-white/95 backdrop-blur rounded-xl shadow-md border border-slate-200 p-1.5 select-none">
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
          onClick={handleToggleTracking}
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
        {tracking ? (
          <div className="py-8 min-h-full" style={{ minWidth: 'fit-content' }}>
            {basePageWidth && (
              <LinearReader
                pdfDoc={sharedPdfDoc}
                linearBlocks={linearBlocks}
                pageDims={pageDims}
                contentWidth={Math.max(1, basePageWidth - 96)}
                maxBlockWidth={basePageWidth}
                userZoom={userZoom}
                onExplain={onExplain}
                activeParagraph={activeParagraph}
                currentExplanation={currentExplanation}
                explanation={explanation}
              />
            )}
          </div>
        ) : (
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
                  images={imagesMap[i + 1]}
                  flatBase={flatBaseByPage[i + 1] ?? 0}
                  chainPayloads={paginatedChainPayloads}
                  chainIds={paginatedChainIds}
                  onExplain={onExplain}
                  activeParagraph={activeParagraph}
                  currentExplanation={currentExplanation}
                  explanation={explanation}
                  trackedBox={currentStopData?.page === i + 1 ? currentStopData.bbox : null}
                  hoveredChain={hoveredChain}
                  onHoveredChainChange={setHoveredChain}
                />
              ))}
          </Document>
        </div>
        )}
      </div>
    </div>
  )
})

export default PdfViewer
