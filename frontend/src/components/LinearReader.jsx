import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveSentenceIndices, buildContinuationPayloads, mergedIndicesToOrig, logSentence, flagSentenceEnabled } from './highlight-utils'
import { PDF_RENDER_SCALE, usePageCache } from './use-page-cache'
import { usePdfDocument } from './use-pdf-document'
import { useUiLang } from '../i18n/LanguageContext'

const BBOX_INFLATE_PT       = 2
const EQUATION_Y_INFLATE_PT = 4

// Figure / table wider than this fraction of the PDF page is treated as
// full-width (spans both columns of a two-column layout).
const FULL_WIDTH_PT_FRACTION = 0.6
// Approximate single-column-text width relative to page width. Used to derive
// px-per-pt scale so that a full-width figure renders at ~2× column width.
const SINGLE_COL_PT_RATIO    = 0.46

const BASE_GAP_PX     = 7
const SECTION_TOP_PX  = 16
const SECTION_BOT_PX  = 4

// Fraction of the available column the reading text occupies at userZoom=1.
// Anything below 1 leaves visible margin on both sides via the mx-auto wrap.
// Lower values = more breathing room; chosen by user preference.
const DEFAULT_COLUMN_FACTOR = 0.7

function blockMarginTop(block, prev) {
  if (!prev) return 0
  if (block.role === 'title') return 0
  if (block.role === 'section_header') return SECTION_TOP_PX
  // Continuation only visually merges when the previous block is also a
  // paragraph. If a figure / equation / header interrupts the cross-page chain
  // the gap should remain so the reader sees the interrupting block clearly.
  if (block.role === 'paragraph' && block.continuation && prev.role === 'paragraph') return 0
  if (block.role === 'caption' && (prev.role === 'figure' || prev.role === 'table')) return 0
  return BASE_GAP_PX
}

function blockMarginBottom(block) {
  if (block.role === 'section_header') return SECTION_BOT_PX
  return 0
}

export default function LinearReader({
  pdfDoc,
  pdfFile,
  linearBlocks,
  pageDims,
  contentWidth,
  maxBlockWidth,
  userZoom = 1,
  onExplain,
  activeParagraph,
  currentExplanation,
  explanation,
}) {
  // If the parent already owns a doc, use it. Otherwise fall back to loading
  // from pdfFile ourselves (LinearReaderTest standalone case).
  const ownedDoc = usePdfDocument(pdfDoc ? null : pdfFile)
  const effectiveDoc = pdfDoc ?? ownedDoc
  const { pageCanvases, requestPage } = usePageCache(effectiveDoc, { maxCached: 8, concurrent: 2 })

  const [visibleSet, setVisibleSet] = useState(() => new Set())
  const [hoveredChain, setHoveredChain] = useState(null)
  const [observerInstance, setObserverInstance] = useState(null)

  const rootDivRef = useRef(null)
  const firstVisibleLoggedRef = useRef(false)
  const mountTimeRef = useRef(0)

  useEffect(() => {
    mountTimeRef.current = performance.now()
  }, [])

  // Auto-detect nearest scroll container so IntersectionObserver fires on the
  // right axis even when LinearReader is nested inside PdfViewer.
  useEffect(() => {
    if (!rootDivRef.current) return
    let cur = rootDivRef.current.parentElement
    let scrollRoot = null
    while (cur && cur !== document.body) {
      const style = window.getComputedStyle(cur)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        scrollRoot = cur
        break
      }
      cur = cur.parentElement
    }

    const observer = new IntersectionObserver(entries => {
      setVisibleSet(prev => {
        const next = new Set(prev)
        let changed = false
        for (const e of entries) {
          const idx = Number(e.target.dataset.blockIdx)
          if (Number.isNaN(idx)) continue
          if (e.isIntersecting) {
            if (!next.has(idx)) { next.add(idx); changed = true }
          } else if (next.has(idx)) {
            next.delete(idx); changed = true
          }
        }
        return changed ? next : prev
      })
    }, { root: scrollRoot, rootMargin: '400px 0px 400px 0px', threshold: 0 })

    setObserverInstance(observer)
    return () => {
      observer.disconnect()
      setObserverInstance(null)
    }
  }, [])

  // Dev-only timing: first block visible after mount.
  useEffect(() => {
    if (firstVisibleLoggedRef.current || visibleSet.size === 0) return
    if (import.meta.env?.DEV) {
      const elapsed = (performance.now() - mountTimeRef.current).toFixed(1)
      console.log(`[LinearReader] first block visible @ ${elapsed}ms`)
    }
    firstVisibleLoggedRef.current = true
  }, [visibleSet])

  const handleHoverChange = useCallback((chainKey, hover) => {
    // Functional setter so an out-of-order mouseLeave doesn't clear a
    // freshly-set hoveredChain from a sibling's mouseEnter.
    setHoveredChain(prev => {
      if (hover) return chainKey
      return prev === chainKey ? null : prev
    })
  }, [])

  // Tracking-mode zoom semantics differ from paginated: zoom up shrinks the
  // reading column (widening the side margins) and scales text down, zoom
  // down expands the column toward the container edges (less margin) and
  // scales text up. displayWidth never exceeds the column the parent gave
  // us, so zooming out far enough flattens against contentWidth.
  const baseWidth = Math.max(1, contentWidth || 0)
  const desired   = (baseWidth * DEFAULT_COLUMN_FACTOR) / Math.max(0.1, userZoom)
  const displayWidth = Math.max(1, Math.min(baseWidth, desired))
  // Full-width figures are still allowed to bleed up to the absolute outer
  // bound the parent provided (basePageWidth). Independent of userZoom — the
  // figure scales proportionally via pxPerPt derived from displayWidth.
  const maxBoxWidth = Math.max(displayWidth, (maxBlockWidth ?? contentWidth) || 0)

  const chainPayloads = useMemo(
    () => buildContinuationPayloads(linearBlocks),
    [linearBlocks],
  )

  // chainIds[i] = head linearBlocks index of the chain block i belongs to.
  // Keyed by the inner `sentences` array reference — buildContinuationPayloads
  // gives every chain member its OWN wrapper object (different `offset`) but
  // the same merged `sentences` array, so the inner array is the stable
  // identity that groups chain members together while still distinguishing
  // separate chains with identical text.
  const chainIds = useMemo(() => {
    const headByPayload = new Map()
    const ids = new Array(linearBlocks.length).fill(null)
    for (let i = 0; i < linearBlocks.length; i++) {
      const pay = chainPayloads[i]
      if (!pay) continue
      const key = pay.sentences
      if (!headByPayload.has(key)) headByPayload.set(key, i)
      ids[i] = headByPayload.get(key)
    }
    return ids
  }, [linearBlocks, chainPayloads])

  // Non-paragraph blocks (figures, captions, etc.) between two paragraphs that
  // belong to the same continuation chain are deferred to render after the chain
  // ends, so they don't visually interrupt merged paragraphs.
  const renderList = useMemo(() => {
    const result = []
    const deferred = []
    let lastRenderedIdx = -1

    const emit = (origIdx) => {
      result.push({ origIdx, prevOrigIdx: lastRenderedIdx })
      lastRenderedIdx = origIdx
    }

    const flushDeferred = () => {
      for (const di of deferred) emit(di)
      deferred.length = 0
    }

    const nextParaIsContinuation = (from) => {
      for (let k = from + 1; k < linearBlocks.length; k++) {
        if (linearBlocks[k]?.role === 'paragraph') return linearBlocks[k].continuation === true
      }
      return false
    }

    for (let i = 0; i < linearBlocks.length; i++) {
      const b = linearBlocks[i]
      if (b?.role !== 'paragraph') {
        if (nextParaIsContinuation(i)) {
          deferred.push(i)
        } else {
          flushDeferred()
          emit(i)
        }
      } else {
        emit(i)
        if (!nextParaIsContinuation(i)) flushDeferred()
      }
    }
    flushDeferred()
    return result
  }, [linearBlocks])

  return (
    <div
      ref={rootDivRef}
      className="bg-white"
      style={{ paddingLeft: 48, paddingRight: 48 }}
    >
      <div
        className="mx-auto"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {renderList.map(({ origIdx, prevOrigIdx }) => {
          const block = linearBlocks[origIdx]
          const chainKey = chainIds[origIdx] != null ? `c-${chainIds[origIdx]}` : `__b-${origIdx}`
          return (
            <BlockCrop
              key={`${block.page}-${block.reading_index}-${origIdx}`}
              blockIdx={origIdx}
              block={block}
              prevBlock={prevOrigIdx >= 0 ? linearBlocks[prevOrigIdx] : null}
              srcCanvas={pageCanvases[block.page]}
              pageDim={pageDims?.[block.page]}
              displayWidth={displayWidth}
              maxBoxWidth={maxBoxWidth}
              visible={visibleSet.has(origIdx)}
              observer={observerInstance}
              requestPage={requestPage}
              hovered={hoveredChain === chainKey}
              chainKey={chainKey}
              onHoverChange={handleHoverChange}
              onExplain={onExplain}
              chainPayload={chainPayloads[origIdx]}
              activeParagraph={activeParagraph}
              currentExplanation={currentExplanation}
              explanation={explanation}
            />
          )
        })}
      </div>
    </div>
  )
}

// Shallow-prop memo. Stable refs for callbacks (handleHoverChange/onExplain/
// requestPage are useCallback) + per-page srcCanvas references mean a cache
// publish only re-renders blocks of the page that was just rendered/evicted,
// and a hover/visibility change only re-renders the affected block.
const BlockCrop = memo(function BlockCrop({
  blockIdx,
  block,
  prevBlock,
  srcCanvas,
  pageDim,
  displayWidth,
  maxBoxWidth,
  visible,
  observer,
  requestPage,
  hovered,
  chainKey,
  onHoverChange,
  onExplain,
  chainPayload,
  activeParagraph,
  currentExplanation,
  explanation,
}) {
  const { t } = useUiLang()
  const wrapperRef = useRef(null)
  const canvasRef  = useRef(null)

  const bbox = block.bbox
  // Equations: Marker sometimes emits a tight y-bbox that clips ascenders /
  // descenders of math symbols. Use a larger vertical inflation for them.
  const yInflate = block.role === 'equation' ? EQUATION_Y_INFLATE_PT : BBOX_INFLATE_PT
  const inflatedY0 = Math.max(0, bbox.y0 - yInflate)
  const inflatedY1 = pageDim?.height
    ? Math.min(pageDim.height, bbox.y1 + yInflate)
    : bbox.y1 + yInflate
  const bbW = Math.max(0, bbox.x1 - bbox.x0)
  const bbH = Math.max(0, inflatedY1 - inflatedY0)
  const aspect = bbW > 0 ? bbH / bbW : 0

  // Uniform px-per-pt across the document. A paragraph block, by assumption,
  // fills ~SINGLE_COL_PT_RATIO of the page width and we want it to render at
  // displayWidth, so that ratio fixes the scale; every other block then
  // renders at its natural size relative to that paragraph. Section headers,
  // authors, captions, equations etc. keep their visual size relationship to
  // body text from the original PDF instead of being stretched to fill the
  // reading column.
  const pxPerPt = pageDim
    ? displayWidth / Math.max(1, pageDim.width * SINGLE_COL_PT_RATIO)
    : null
  const naturalPx = pxPerPt ? Math.max(1, Math.round(bbW * pxPerPt)) : displayWidth

  // Full-width figures / tables are allowed to bleed beyond the column; every
  // other block clamps to displayWidth (so a title or wide section header
  // gets downscaled instead of overflowing).
  const canBeFullWidth = block.role === 'figure' || block.role === 'table' || block.role === 'algorithm'
  const isFullWidth = canBeFullWidth
    && pageDim
    && bbW > pageDim.width * FULL_WIDTH_PT_FRACTION

  let boxWidth, canvasWidth, overflowX
  if (isFullWidth) {
    const natural = Math.max(displayWidth, naturalPx)
    if (natural > maxBoxWidth) {
      boxWidth = maxBoxWidth
      canvasWidth = natural
      overflowX = true
    } else {
      boxWidth = natural
      canvasWidth = natural
      overflowX = false
    }
  } else {
    const clamped = Math.min(displayWidth, naturalPx)
    boxWidth = clamped
    canvasWidth = clamped
    overflowX = false
  }
  const displayHeight = Math.max(1, Math.round(canvasWidth * aspect))

  const marginTop    = blockMarginTop(block, prevBlock)
  const marginBottom = blockMarginBottom(block)

  // Register with the shared IntersectionObserver.
  useEffect(() => {
    const node = wrapperRef.current
    if (!node || !observer) return
    observer.observe(node)
    return () => observer.unobserve(node)
  }, [observer])

  // Trigger page render when this block becomes visible without a cached page.
  // Also re-requests if the page is evicted while we're still on-screen.
  useEffect(() => {
    if (visible && !srcCanvas) requestPage(block.page)
  }, [visible, srcCanvas, block.page, requestPage])

  // Drop hover state when scrolling off-viewport. onMouseLeave only fires while
  // the wrapper still has interactive handlers; once isInteractive flips false
  // it never fires, leaving hovered=true stuck until the block re-enters.
  useEffect(() => {
    if (!visible && hovered) onHoverChange?.(chainKey, false)
  }, [visible, hovered, chainKey, onHoverChange])

  // Draw crop on visibility + cache hit. Re-draws on srcCanvas change (e.g.
  // after eviction + re-render) and on resize/zoom.
  useEffect(() => {
    if (!visible || !srcCanvas) return
    const canvas = canvasRef.current
    if (!canvas || canvasWidth <= 0 || bbW <= 0 || bbH <= 0) return

    const dpr = window.devicePixelRatio || 1
    const physicalW = Math.max(1, Math.round(canvasWidth * dpr))
    const physicalH = Math.max(1, Math.round(displayHeight * dpr))
    if (canvas.width !== physicalW) canvas.width = physicalW
    if (canvas.height !== physicalH) canvas.height = physicalH
    canvas.style.width  = `${canvasWidth}px`
    canvas.style.height = `${displayHeight}px`

    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, physicalW, physicalH)

    ctx.drawImage(
      srcCanvas,
      bbox.x0 * PDF_RENDER_SCALE,
      inflatedY0 * PDF_RENDER_SCALE,
      bbW * PDF_RENDER_SCALE,
      bbH * PDF_RENDER_SCALE,
      0, 0, physicalW, physicalH,
    )
  }, [visible, srcCanvas, canvasWidth, displayHeight, bbox.x0, inflatedY0, bbW, bbH])

  const isRendered    = visible && !!srcCanvas
  const isFigure      = block.role === 'figure' || block.role === 'table' || block.role === 'algorithm'
  const isInteractive = isRendered && (
    (block.role === 'paragraph' && (block.sentences?.length ?? 0) > 0)
    || isFigure
  )
  // Cross-page chain merged text/sentences (cache-key + Gemini payload). For
  // non-paragraph roles we fall back to block.text so the active check on
  // those still degrades gracefully (it never matches anyway). `offset` is
  // the position of this block's sentences inside payload.sentences — used
  // to translate LLM-returned indices (relative to the merged array) back
  // into this block's own sentence array for highlight rendering.
  const payload = chainPayload ?? {
    text: block.text,
    sentences: block.sentences ?? [],
    offset: 0,
    boundaries: [],
    mergedSentences: block.sentences ?? [],
    mergedToOrig: (block.sentences ?? []).map((_, i) => [i]),
  }
  const isActive  = isInteractive && (
    (!!payload.text && activeParagraph?.text === payload.text)
    || (isFigure
        && activeParagraph?.role === block.role
        && activeParagraph?.page === block.page
        && activeParagraph?.bbox?.x0 === block.bbox?.x0
        && activeParagraph?.bbox?.y0 === block.bbox?.y0)
  )
  const bboxScale = bbW > 0 ? canvasWidth / bbW : 0
  const ownLen    = block.sentences?.length ?? 0
  const ownOffset = payload.offset ?? 0

  function toLocalRect(b) {
    return {
      left:   (b.x0 - bbox.x0) * bboxScale,
      top:    (b.y0 - inflatedY0) * bboxScale,
      width:  (b.x1 - b.x0) * bboxScale,
      height: (b.y1 - b.y0) * bboxScale,
    }
  }

  // Map merged-array indices to this block's own sentence indices. Indices
  // outside [offset, offset+ownLen) belong to other halves of the chain and
  // are dropped here (they get rendered by those halves).
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

  const allItems = explanation?.sentence_explanations ?? []
  const currentIndices = (isActive && currentExplanation)
    ? localizeIndices(resolveAndMap(currentExplanation))
    : []
  const currentSet = new Set(currentIndices)
  const otherIndices = isActive
    ? [...new Set(
        allItems
          .filter(it => it !== currentExplanation)
          .flatMap(it => localizeIndices(resolveAndMap(it)))
      )].filter(idx => !currentSet.has(idx))
    : []

  const boxesFromIndices = (indices) =>
    indices.flatMap(idx =>
      (block.sentences[idx]?.boxes || []).map(toLocalRect)
    )

  const otherBoxes     = boxesFromIndices(otherIndices)
  const highlightBoxes = boxesFromIndices(currentIndices)

  if (isActive && currentExplanation && flagSentenceEnabled()) {
    logSentence('LinearReader.highlight', {
      blockIdx,
      role: block.role,
      page: block.page,
      ownLen,
      ownOffset,
      mergedSentencesCount: mergedSentences.length,
      payloadSentencesCount: payload.sentences?.length ?? 0,
      currentExplanation: {
        sentence_indices: currentExplanation?.sentence_indices,
        quote: (currentExplanation?.quote ?? '').slice(0, 100),
        placeholder: !!currentExplanation?.is_placeholder,
      },
      currentIndicesLocalized: currentIndices,
      otherIndicesLocalized: otherIndices,
      boxCounts: {
        current: highlightBoxes.length,
        other: otherBoxes.length,
      },
    })
  }

  // When a figure/table is active and has a merged caption_bbox, highlight the
  // caption region of the crop so the user sees what's being analyzed.
  const captionHighlight = (isActive && isFigure && block.caption_bbox)
    ? toLocalRect(block.caption_bbox)
    : null

  let anchor = null
  if (isInteractive) {
    if (isFigure) {
      // Figures/tables: anchor at the bottom-right corner of the rendered
      // canvas (no sentence geometry to anchor to).
      anchor = { left: canvasWidth, top: displayHeight }
    } else {
      const lastSent = block.sentences[block.sentences.length - 1]
      const lastBox  = lastSent?.boxes?.[lastSent.boxes.length - 1]
      if (lastBox) {
        anchor = {
          left: (lastBox.x1 - bbox.x0) * bboxScale,
          top:  (lastBox.y1 - inflatedY0) * bboxScale,
        }
      }
    }
  }

  return (
    <div
      ref={wrapperRef}
      data-block-idx={blockIdx}
      className="relative"
      style={{
        width: boxWidth,
        // `minHeight` reserves layout space matching the canvas BEFORE the
        // image draws (avoids jump-in on cache miss). Once the canvas
        // mounts, the wrapper grows to whatever the canvas / placeholder
        // is, so a 1-px rounding discrepancy never produces a vertical
        // overflow — and therefore never a phantom Y scrollbar.
        minHeight: displayHeight,
        marginTop,
        marginBottom,
        overflowX: overflowX ? 'auto' : 'visible',
        // CSS spec implicitly computes overflowY to `auto` when overflowX
        // is non-visible. Pin overflowY to hidden so figures / tables only
        // ever scroll horizontally. Since wrapper height auto-fits the
        // canvas via the block layout, there is no real overflow to clip.
        overflowY: overflowX ? 'hidden' : 'visible',
        // Block any ancestor flex container from shrinking this block
        // below its natural height (would clip the canvas without showing
        // a scrollbar because overflowY is hidden).
        flexShrink: 0,
      }}
      onMouseEnter={isInteractive ? () => onHoverChange?.(chainKey, true) : undefined}
      onMouseLeave={isInteractive ? () => onHoverChange?.(chainKey, false) : undefined}
    >
      {isRendered ? (
        <canvas
          ref={canvasRef}
          style={{
            width: canvasWidth,
            height: displayHeight,
            borderRadius: 2,
            display: 'block',
          }}
        />
      ) : (
        <div
          className="bg-slate-100"
          style={{
            width: canvasWidth,
            height: displayHeight,
            borderRadius: 2,
          }}
        />
      )}

      {isInteractive && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ width: canvasWidth, height: displayHeight }}
        >
          <div
            className="absolute rounded-sm transition-opacity duration-150"
            style={{
              left: 0,
              top: 0,
              width: canvasWidth,
              height: displayHeight,
              background: hovered ? 'rgba(99,102,241,0.07)' : 'transparent',
              border: hovered ? '1px solid rgba(99,102,241,0.22)' : '1px solid transparent',
            }}
          />

          {otherBoxes.map((box, j) => (
            <div
              key={`ot-${j}`}
              className="absolute rounded-sm bg-slate-400/30"
              style={{ ...box, mixBlendMode: 'multiply' }}
            />
          ))}

          {highlightBoxes.map((box, j) => (
            <div
              key={`hl-${j}`}
              className="absolute rounded-sm bg-yellow-300/40 transition-all duration-300 ease-out"
              style={{ ...box, mixBlendMode: 'multiply' }}
            />
          ))}

          {captionHighlight && (
            <div
              className="absolute rounded-sm bg-yellow-300/40 transition-all duration-300 ease-out"
              style={{ ...captionHighlight, mixBlendMode: 'multiply' }}
            />
          )}

          {anchor && (
            <button
              className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
              style={{
                left: anchor.left,
                top:  anchor.top,
                background: hovered ? 'rgb(79,70,229)' : 'rgba(99,102,241,0.15)',
                border: '1.5px solid rgba(99,102,241,0.6)',
                color: hovered ? 'white' : 'rgb(79,70,229)',
                fontSize: '8px',
                fontWeight: 700,
                boxShadow: hovered ? '0 2px 8px rgba(99,102,241,0.45)' : 'none',
                transform: hovered
                  ? 'translate(-100%, -100%) scale(1.15)'
                  : 'translate(-100%, -100%)',
              }}
              onClick={() => {
                if (isFigure) {
                  onExplain?.(
                    block.caption_text || '',
                    [],
                    block.flat_block_ref ?? null,
                    {
                      role: block.role,
                      page: block.page,
                      bbox: block.bbox,
                      caption_text: block.caption_text || '',
                    },
                  )
                } else {
                  onExplain?.(
                    payload.text,
                    payload.mergedSentences ?? payload.sentences,
                    block.flat_block_ref ?? block.paragraph_ref ?? null,
                  )
                }
              }}
              title={isFigure ? t('viewer.explainBlock', { role: block.role }) : t('viewer.explainParagraph')}
            >
              ✦
            </button>
          )}
        </div>
      )}
    </div>
  )
})
