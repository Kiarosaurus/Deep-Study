import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import LinearReader from './LinearReader'
import PaginatedCanvas from './PaginatedCanvas'
import { resolveSentenceIndices, buildContinuationPayloads, mergedIndicesToOrig, logSentence, flagSentenceEnabled } from './highlight-utils'
import { usePdfDocument } from './use-pdf-document'
import { usePageCache } from './use-page-cache'
import { useUiLang } from '../i18n/LanguageContext'
import { useSettings } from '../settings/SettingsContext'
import { SettingsButton } from '../settings/SettingsModal'
import { ThemeButton } from '../theme/ThemeToggle'
import { useEdit } from '../edit/EditContext'

const ZOOM_MIN  = 0.5
const ZOOM_MAX  = 4.0   // paginated zoom-in ceiling (400%)
// Tracking inverts zoom (display = 1/userZoom): userZoom's UPPER bound is the
// most-zoomed-OUT state, its LOWER bound the most-zoomed-IN. ZOOM_MAX_TRACKING
// 3.0 keeps zoom-out min at 33%; ZOOM_MIN_TRACKING 0.25 lets zoom-in reach 400%
// (1/0.25) — matching paginated's ceiling. LinearReader drops its column-width
// cap so this zoom-in genuinely grows the page (overflow scrolls horizontally).
const ZOOM_MAX_TRACKING = 3.0
const ZOOM_MIN_TRACKING = 0.25
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
  const { t } = useUiLang()
  const btn = "w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30 disabled:pointer-events-none transition-colors text-base font-semibold"
  return (
    <div className="absolute top-4 right-4 z-30 flex items-center gap-0.5 bg-white/95 backdrop-blur rounded-xl shadow-md border border-slate-200 p-1 select-none">
      <button onClick={onDecrease} disabled={!canDecrease} title={t('viewer.zoomSmaller')} className={btn}>−</button>
      <button
        onClick={onFit}
        title={t('viewer.fit100')}
        className="px-2.5 h-8 flex items-center justify-center rounded-lg text-[11px] font-bold tabular-nums text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors min-w-[3.25rem]"
      >
        {Math.round(displayZoom * 100)}%
      </button>
      <button onClick={onIncrease} disabled={!canIncrease} title={t('viewer.zoomLarger')} className={btn}>+</button>
    </div>
  )
}

// Tooltip for a merge-group representative's ✦, reflecting the group's resolved
// hierarchy (resultRole): "Explain figure/table/algorithm" for a visual result,
// else the paragraph label. Non-group buttons use their own fallback title.
const _MERGE_VISUAL_ROLES = new Set(['figure', 'table', 'algorithm'])
function groupExplainTitle(t, membership, fallback) {
  if (!membership) return fallback
  return _MERGE_VISUAL_ROLES.has(membership.resultRole)
    ? t('viewer.explainBlock', { role: membership.resultRole })
    : t('viewer.explainParagraph')
}

// Roles that carry NO ✦ in the paginated overlay — metadata that reshapes
// structure but isn't independently explainable. Mirrors the picker's GROUP B,
// so re-typing a block to one of these (e.g. footnote) drops its ✦.
const _METADATA_ROLES = new Set(['ignored', 'footnote', 'title', 'author', 'section_header'])

function ParagraphOverlay({ blocks, images = [], paintTargets = [], page, flatBase = 0, chainPayloads, chainIds, scale, onExplain, activeParagraph, currentExplanation, explanation, hoveredChain, onHoveredChainChange, armedTool = null, onBlockEdit, mergeSelectedKeys, mergeMembership, onExplainGroup }) {
  const { t } = useUiLang()
  const [hoveredImgIdx, setHoveredImgIdx] = useState(null)
  // Committed merge currently hovered (by groupId) → every member's boxbar
  // lights up together, across blocks AND images on this page.
  const [hoveredGroup, setHoveredGroup] = useState(null)

  if ((!blocks && !images?.length && !paintTargets?.length) || !scale) return null

  const allItems = explanation?.sentence_explanations ?? []

  // ── Same-column continuation grouping ──────────────────────────────────────
  // A continuation chain can stitch several blocks together. When consecutive
  // members sit in the SAME column of the SAME page — e.g. a figure split one
  // paragraph in two — they should read as a single region: ONE union hover
  // box and ONE ✦ button covering the whole span, not one per piece. Members
  // that wrap to the other column keep their own box + button (a single union
  // box would straddle the gutter); cross-page members already land in
  // separate overlays. `groupLeader[i]` is the index of the block that owns
  // block i's rendered box/button; followers fold their box into the leader's
  // union and render no button of their own.
  const pageBlocks = blocks ?? []
  const xRange = (block) => {
    const bs = block.boxes ?? []
    if (!bs.length) return null
    return [Math.min(...bs.map(b => b.x0)), Math.max(...bs.map(b => b.x1))]
  }
  const sameColumn = (a, b) => {
    const ra = xRange(a), rb = xRange(b)
    if (!ra || !rb) return false
    const overlap  = Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0])
    const narrower = Math.min(ra[1] - ra[0], rb[1] - rb[0])
    return narrower > 0 && overlap / narrower >= 0.5
  }
  const groupLeader  = new Array(pageBlocks.length)
  const lastChainIdx = new Map()   // chainId → last block index seen on this page
  for (let i = 0; i < pageBlocks.length; i++) {
    const cid     = chainIds?.[flatBase + i]
    const prevIdx = cid != null ? lastChainIdx.get(cid) : undefined
    groupLeader[i] = (
      prevIdx !== undefined
      && pageBlocks[i].continuation
      && sameColumn(pageBlocks[prevIdx], pageBlocks[i])
    ) ? groupLeader[prevIdx] : i
    if (cid != null) lastChainIdx.set(cid, i)
  }
  // Union box per leader across all members folded into its group.
  const groupUnion = new Map()     // leaderIdx → {x0,y0,x1,y1}
  for (let i = 0; i < pageBlocks.length; i++) {
    const bs = pageBlocks[i].boxes ?? []
    if (!bs.length) continue
    const lead = groupLeader[i]
    const bx = {
      x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)),
      x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)),
    }
    const cur = groupUnion.get(lead)
    groupUnion.set(lead, cur ? {
      x0: Math.min(cur.x0, bx.x0), y0: Math.min(cur.y0, bx.y0),
      x1: Math.max(cur.x1, bx.x1), y1: Math.max(cur.y1, bx.y1),
    } : bx)
  }

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {(blocks ?? []).map((block, i) => {
        const paragraphBoxes = block.boxes ?? []
        if (paragraphBoxes.length === 0) return null
        const isLeader = groupLeader[i] === i
        const unionBox = groupUnion.get(groupLeader[i])
        // Lazo identity for this block + its committed merge-group membership.
        // Linear-only injected blocks have no reading_index; key them on their
        // geometric linearKey (kept in sync with Reader.editKeyOf) so the lazo
        // membership + selection treat them as first-class.
        const blockKey = block.linearKey ? `block:${block.linearKey}` : `block:${page}:${block.reading_index}`
        const blockMembership = mergeMembership?.[blockKey]

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
          footnotes: (block.footnotes ?? []).map(f => f.text),
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

        // Button hangs off the bottom-right of the whole grouped region so it
        // sits at the end of the (possibly multi-piece) paragraph.
        const anchorBox  = unionBox ?? paragraphBoxes[paragraphBoxes.length - 1]
        const anchorLeft = anchorBox.x1 * scale
        const anchorTop  = anchorBox.y1 * scale

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

        if (isActive && currentExplanation && flagSentenceEnabled()) {
          logSentence('PdfViewer.highlight', {
            page,
            blockIdxOnPage: i,
            flatBlockRef: ownFlatRef,
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

        return (
          <div key={i}>
            {/* Hover rect — one union box per same-column group. Followers fold
                into their leader's box, so only the leader paints it. */}
            {isLeader && unionBox && (
              <div
                className="absolute rounded-sm transition-opacity duration-150"
                style={{
                  left:   unionBox.x0 * scale,
                  top:    unionBox.y0 * scale,
                  width:  (unionBox.x1 - unionBox.x0) * scale,
                  height: (unionBox.y1 - unionBox.y0) * scale,
                  background: isHovered ? 'rgba(99,102,241,0.07)' : 'transparent',
                  border: isHovered ? '1px solid rgba(99,102,241,0.22)' : '1px solid transparent',
                }}
              />
            )}

            {/* Otras oraciones del carrusel (no la actual) — sombreado plomo, estático */}
            {otherBoxes.map((box, j) => (
              <div
                key={`ot-${i}-${j}`}
                className="absolute pointer-events-none rounded-sm pg-hl-other"
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
                className="absolute pointer-events-none rounded-sm pg-hl-current transition-all duration-300 ease-out"
                style={{
                  left:   box.left,
                  top:    box.top,
                  width:  box.width,
                  height: box.height,
                  mixBlendMode: 'multiply',
                }}
              />
            ))}

            {/* Footnote boxes — distinct GREEN region, never folded into the
                paragraph's union box (kept separate even in the same column).
                Hidden by default; shown only while hovering the footnote itself
                OR its paragraph (shared chainKey). Hovering the footnote lights
                up the paragraph too, and vice-versa. */}
            {(block.footnotes ?? []).map((fn, j) => {
              const fb = fn.bbox
              if (!fb) return null
              return (
                <div
                  key={`fn-${i}-${j}`}
                  className="absolute pointer-events-auto rounded-sm transition-opacity duration-150"
                  style={{
                    left:   fb.x0 * scale,
                    top:    fb.y0 * scale,
                    width:  (fb.x1 - fb.x0) * scale,
                    height: (fb.y1 - fb.y0) * scale,
                    background: isHovered ? 'rgba(34,197,94,0.20)' : 'transparent',
                    border: isHovered ? '1px solid rgba(34,197,94,0.45)' : '1px solid transparent',
                  }}
                  onMouseEnter={() => onHoveredChainChange?.(chainKey)}
                  onMouseLeave={() => onHoveredChainChange?.(null)}
                />
              )
            })}

            {/* Demoted (mazo/hammer) blocks: faint gray wash, shown ONLY while
                the hammer tool is armed. With any other tool — or none — an
                ignored block is visually imperceptible (clean reading), though
                still soft-deleted in the edit state. */}
            {isLeader && unionBox && block.role === 'ignored' && armedTool === 'demote' && (
              <div
                className="absolute pointer-events-none rounded-sm"
                style={{
                  left:   unionBox.x0 * scale,
                  top:    unionBox.y0 * scale,
                  width:  (unionBox.x1 - unionBox.x0) * scale,
                  height: (unionBox.y1 - unionBox.y0) * scale,
                  background: 'rgba(100,116,139,0.14)',
                  border: '1px dashed rgba(100,116,139,0.4)',
                }}
              />
            )}

            {/* Pincel (promote) affordance: a blue box over EVERY paginated block
                — incl. hammer-ignored — so the user sees what can be re-typed.
                Click opens the TypePicker. The generic edit catcher below is
                suppressed for promote, so this is the sole promote surface. */}
            {isLeader && unionBox && armedTool === 'promote' && (
              <button
                type="button"
                className="absolute pointer-events-auto rounded-sm"
                style={{
                  left:   unionBox.x0 * scale,
                  top:    unionBox.y0 * scale,
                  width:  (unionBox.x1 - unionBox.x0) * scale,
                  height: (unionBox.y1 - unionBox.y0) * scale,
                  background: 'rgba(59,130,246,0.2)',
                  border: '1px solid rgba(59,130,246,0.7)',
                  cursor: 'crosshair',
                }}
                onClick={e => onBlockEdit?.({ kind: 'block', page, reading_index: block.reading_index, role: block.role, continuation: block.continuation, text: payload.text, linearKey: block.linearKey, bbox: unionBox, allowMerges: block.allowMerges }, { x: e.clientX, y: e.clientY })}
              />
            )}

            {/* Lazo: indigo wash on objects selected for an in-progress merge
                ONLY. A committed group leaves no residual box — its single ✦ is
                the indicator. */}
            {isLeader && unionBox && mergeSelectedKeys?.has(blockKey) && (
              <div
                className="absolute pointer-events-none rounded-sm"
                style={{
                  left:   unionBox.x0 * scale,
                  top:    unionBox.y0 * scale,
                  width:  (unionBox.x1 - unionBox.x0) * scale,
                  height: (unionBox.y1 - unionBox.y0) * scale,
                  background: 'rgba(99,102,241,0.16)',
                  border: '1px dashed rgba(99,102,241,0.6)',
                }}
              />
            )}

            {/* Committed merge boxbar: outlines every member of a group so the
                grouping is visible, and lights up the whole group on hover. Only
                in normal mode (no tool armed); the lazo wash above owns the
                in-progress state. */}
            {isLeader && unionBox && blockMembership && !armedTool && (
              <div
                className="absolute pointer-events-auto rounded-sm transition-colors duration-150"
                style={{
                  left:   unionBox.x0 * scale,
                  top:    unionBox.y0 * scale,
                  width:  (unionBox.x1 - unionBox.x0) * scale,
                  height: (unionBox.y1 - unionBox.y0) * scale,
                  background: hoveredGroup === blockMembership.groupId ? 'rgba(99,102,241,0.14)' : 'transparent',
                  border: hoveredGroup === blockMembership.groupId
                    ? '1.5px solid rgba(99,102,241,0.7)'
                    : '1.5px dashed rgba(99,102,241,0.35)',
                }}
                onMouseEnter={() => setHoveredGroup(blockMembership.groupId)}
                onMouseLeave={() => setHoveredGroup(null)}
              />
            )}

            {/* Edit click-catcher: while a CLICK tool is armed, the whole block
                region routes clicks to the edit handler instead of the explain
                flow. Excluded for 'search' — that tool has its own text-selection
                layer and the catcher must not block the caret hit-test. */}
            {isLeader && armedTool && armedTool !== 'search' && armedTool !== 'promote' && unionBox && (
              <button
                type="button"
                className="absolute pointer-events-auto rounded-sm transition-colors"
                style={{
                  left:   unionBox.x0 * scale,
                  top:    unionBox.y0 * scale,
                  width:  (unionBox.x1 - unionBox.x0) * scale,
                  height: (unionBox.y1 - unionBox.y0) * scale,
                  cursor: 'crosshair',
                  background: 'transparent',
                  border: '1px solid transparent',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.12)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
                onClick={e => onBlockEdit?.({ kind: 'block', page, reading_index: block.reading_index, role: block.role, continuation: block.continuation, text: payload.text, linearKey: block.linearKey, bbox: unionBox, allowMerges: block.allowMerges }, { x: e.clientX, y: e.clientY })}
              />
            )}

            {/* ✦ viñeta button — one per same-column group, on the leader. Hidden
                while a tool is armed (clicks go to editing) and on metadata
                blocks. In a merge group EVERY member (tracking off) carries a ✦;
                any of them explains the whole group via onExplainGroup. */}
            {isLeader && !armedTool && !_METADATA_ROLES.has(block.role) && (
              <button
                className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
                style={{
                  left: anchorLeft,
                  top:  anchorTop,
                  // High z so the vertex-centered circle stays above adjacent
                  // block boxes and the text layer.
                  zIndex: 30,
                  background: isHovered ? 'rgb(79,70,229)' : 'rgba(99,102,241,0.15)',
                  border: '1.5px solid rgba(99,102,241,0.6)',
                  color: isHovered ? 'white' : 'rgb(79,70,229)',
                  fontSize: '8px',
                  fontWeight: 700,
                  boxShadow: isHovered ? '0 2px 8px rgba(99,102,241,0.45)' : 'none',
                  // Center the circle ON the union's bottom-right vertex (was
                  // -100%,-100%). Equivalent to bottom:0;right:0 + translate(50%,50%).
                  transform: isHovered
                    ? 'translate(-50%, -50%) scale(1.15)'
                    : 'translate(-50%, -50%)',
                }}
                onClick={() => blockMembership
                  ? onExplainGroup?.(blockMembership.groupId)
                  : onExplain(payload.text, mergedSentences, ownFlatRef, { footnotes: payload.footnotes ?? [] })}
                onMouseEnter={() => { onHoveredChainChange?.(chainKey); if (blockMembership) setHoveredGroup(blockMembership.groupId) }}
                onMouseLeave={() => { onHoveredChainChange?.(null); if (blockMembership) setHoveredGroup(null) }}
                title={groupExplainTitle(t, blockMembership, ['figure', 'table', 'algorithm'].includes(block.role) ? t('viewer.explainBlock', { role: block.role }) : t('viewer.explainParagraph'))}
              >
                ✦
              </button>
            )}
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
        const imgKey = `image:${page}:${img.reading_index}`
        const imgMembership = mergeMembership?.[imgKey]
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
            {/* Lazo selection (indigo) wash for an in-progress merge. */}
            {mergeSelectedKeys?.has(imgKey) && (
              <div
                className="absolute pointer-events-none rounded-sm"
                style={{
                  left, top, width, height,
                  background: 'rgba(99,102,241,0.16)',
                  border: '1px dashed rgba(99,102,241,0.6)',
                }}
              />
            )}
            {/* Committed merge boxbar (image member): outlines the group and
                lights up with the rest of the group on hover. Normal mode only. */}
            {imgMembership && !armedTool && (
              <div
                className="absolute pointer-events-auto rounded-sm transition-colors duration-150"
                style={{
                  left, top, width, height,
                  background: hoveredGroup === imgMembership.groupId ? 'rgba(99,102,241,0.14)' : 'transparent',
                  border: hoveredGroup === imgMembership.groupId
                    ? '1.5px solid rgba(99,102,241,0.7)'
                    : '1.5px dashed rgba(99,102,241,0.35)',
                }}
                onMouseEnter={() => setHoveredGroup(imgMembership.groupId)}
                onMouseLeave={() => setHoveredGroup(null)}
              />
            )}
            {cap && (
              <div
                className="absolute pointer-events-none rounded-sm pg-hl-current transition-all duration-300 ease-out"
                style={{
                  left:   cap.x0 * scale,
                  top:    cap.y0 * scale,
                  width:  (cap.x1 - cap.x0) * scale,
                  height: (cap.y1 - cap.y0) * scale,
                  mixBlendMode: 'multiply',
                }}
              />
            )}
            {armedTool && armedTool !== 'search' && armedTool !== 'promote' && (
              <button
                type="button"
                className="absolute pointer-events-auto rounded-sm transition-colors"
                style={{
                  left, top, width, height,
                  cursor: 'crosshair', background: 'transparent', border: '1px solid transparent',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.12)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
                onClick={e => onBlockEdit?.({ kind: 'image', page, reading_index: img.reading_index, role: img.role || 'figure', bbox: img.bbox, caption_text: img.caption_text || '', allowMerges: img.allowMerges }, { x: e.clientX, y: e.clientY })}
              />
            )}
            {/* Pincel (promote) surface for images — figures/tables/algorithms
                get the same blue affordance as text blocks and open the picker. */}
            {armedTool === 'promote' && (
              <button
                type="button"
                className="absolute pointer-events-auto rounded-sm"
                style={{
                  left, top, width, height,
                  background: 'rgba(59,130,246,0.2)',
                  border: '1px solid rgba(59,130,246,0.7)',
                  cursor: 'crosshair',
                }}
                onClick={e => onBlockEdit?.({ kind: 'image', page, reading_index: img.reading_index, role: img.role || 'figure', bbox: img.bbox, caption_text: img.caption_text || '' }, { x: e.clientX, y: e.clientY })}
              />
            )}
            {!armedTool && !_METADATA_ROLES.has(img.role || 'figure') && (
              <button
                className="absolute pointer-events-auto w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-150"
                style={{
                  left: anchorLeft,
                  top:  anchorTop,
                  // High z so the vertex-centered circle stays above adjacent
                  // block boxes and the text layer.
                  zIndex: 30,
                  background: isHovered ? 'rgb(79,70,229)' : 'rgba(99,102,241,0.15)',
                  border: '1.5px solid rgba(99,102,241,0.6)',
                  color: isHovered ? 'white' : 'rgb(79,70,229)',
                  fontSize: '8px',
                  fontWeight: 700,
                  boxShadow: isHovered ? '0 2px 8px rgba(99,102,241,0.45)' : 'none',
                  // Center the circle ON the image's bottom-right vertex (was
                  // -100%,-100%). Equivalent to bottom:0;right:0 + translate(50%,50%).
                  transform: isHovered
                    ? 'translate(-50%, -50%) scale(1.15)'
                    : 'translate(-50%, -50%)',
                }}
                onClick={() => imgMembership
                  ? onExplainGroup?.(imgMembership.groupId)
                  : onExplain(
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
                onMouseEnter={() => { setHoveredImgIdx(i); if (imgMembership) setHoveredGroup(imgMembership.groupId) }}
                onMouseLeave={() => { setHoveredImgIdx(null); if (imgMembership) setHoveredGroup(null) }}
                title={groupExplainTitle(t, imgMembership, t('viewer.explainBlock', { role: img.role }))}
              >
                ✦
              </button>
            )}
          </div>
        )
      })}

      {/* Pincel (promote) affordance for linear-only blocks (title/author/
          section_header/list) — no pages.blocks row, so they get their own blue
          interactive box here, sourced from `paintTargets`. Each click re-types
          the block via a geometric override (see Reader.setOverride). */}
      {armedTool === 'promote' && scale && (paintTargets ?? []).map((pt, i) => (
        <button
          key={`paint-${pt.page}-${i}`}
          type="button"
          className="absolute pointer-events-auto rounded-sm"
          style={{
            left:   pt.bbox.x0 * scale,
            top:    pt.bbox.y0 * scale,
            width:  (pt.bbox.x1 - pt.bbox.x0) * scale,
            height: (pt.bbox.y1 - pt.bbox.y0) * scale,
            background: 'rgba(59,130,246,0.2)',
            border: '1px solid rgba(59,130,246,0.7)',
            cursor: 'crosshair',
          }}
          onClick={e => onBlockEdit?.(pt, { x: e.clientX, y: e.clientY })}
        />
      ))}
    </div>
  )
}

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
function SearchSelectionLayer({ blocks, scale, onSearchSelect }) {
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

function PdfPage({
  pdfDoc,
  pageNumber,
  width,
  pageDim,
  srcCanvas,
  requestPage,
  observer,
  blocks,
  images = [],
  paintTargets = [],
  flatBase,
  chainPayloads,
  chainIds,
  onExplain,
  activeParagraph,
  currentExplanation,
  explanation,
  trackedBox,
  hoveredChain,
  onHoveredChainChange,
  armedTool = null,
  onBlockEdit,
  mergeSelectedKeys,
  mergeMembership,
  onExplainGroup,
  onSearchSelect,
  searchResetKey,
}) {
  // scale = displayWidth / page-natural-width (PDF points). pageDim comes
  // from the backend analysis; if missing we fall back to a sentinel so
  // overlays stay laid out even before pdfjs resolves the page.
  const naturalW = pageDim?.width ?? 612
  const scale = naturalW > 0 ? width / naturalW : null

  return (
    <PaginatedCanvas
      pdfDoc={pdfDoc}
      pageNumber={pageNumber}
      width={width}
      pageDim={pageDim}
      srcCanvas={srcCanvas}
      requestPage={requestPage}
      observer={observer}
    >
      <ParagraphOverlay
        blocks={blocks}
        images={images}
        paintTargets={paintTargets}
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
        armedTool={armedTool}
        onBlockEdit={onBlockEdit}
        mergeSelectedKeys={mergeSelectedKeys}
        mergeMembership={mergeMembership}
        onExplainGroup={onExplainGroup}
      />
      {armedTool === 'search' && scale && (
        <SearchSelectionLayer
          key={searchResetKey}
          blocks={blocks}
          scale={scale}
          onSearchSelect={onSearchSelect}
        />
      )}
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
    </PaginatedCanvas>
  )
}

// ── Edit toolbar (bottom-left) ───────────────────────────────────────────────
// Two stacked fused pills, matching the top-left clusters' visual language:
//   [ undo | redo ]            history of edit operations
//   [ mazo | pincel | lazo ]   armable click-mode tools
// Each button is independently hideable from settings; a pill disappears when
// all of its buttons are hidden. Tool buttons light up (indigo) while armed.
function EditToolbar() {
  const { t } = useUiLang()
  const { settings } = useSettings()
  const v = settings.visibility
  const { armedTool, armTool, undo, redo, canUndo, canRedo } = useEdit()

  const pillCls = 'flex flex-col items-center gap-1 bg-white/95 backdrop-blur rounded-xl shadow-md border border-slate-200 p-1.5 select-none'
  const baseBtn = 'w-8 h-8 flex items-center justify-center rounded-lg transition-colors'
  const idleBtn = 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
  const disBtn  = 'text-slate-300 pointer-events-none'
  const activeBtn = 'bg-indigo-600 text-white hover:bg-indigo-700'

  const showHistory = v.undo || v.redo
  const showTools = v.demoteBlock || v.promoteBlock || v.mergeBlocks || v.splitMerge || v.searchConcept
  if (!showHistory && !showTools) return null

  const svg = (children) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
  )

  return (
    <div className="absolute bottom-4 left-4 z-30 flex flex-col items-start gap-2">
      {showHistory && (
        <div className={pillCls}>
          {v.undo && (
            <button type="button" onClick={undo} disabled={!canUndo} title={t('viewer.undo')} aria-label={t('viewer.undo')}
              className={`${baseBtn} ${canUndo ? idleBtn : disBtn}`}>
              {svg(<><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></>)}
            </button>
          )}
          {v.redo && (
            <button type="button" onClick={redo} disabled={!canRedo} title={t('viewer.redo')} aria-label={t('viewer.redo')}
              className={`${baseBtn} ${canRedo ? idleBtn : disBtn}`}>
              {svg(<><polyline points="15 14 20 9 15 4" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" /></>)}
            </button>
          )}
        </div>
      )}
      {showTools && (
        <div className={pillCls}>
          {v.demoteBlock && (
            <button type="button" onClick={() => armTool('demote')} title={t('viewer.toolDemote')} aria-label={t('viewer.toolDemote')}
              className={`${baseBtn} ${armedTool === 'demote' ? activeBtn : idleBtn}`}>
              {svg(<><path d="M15 12l-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9" /><path d="M17.64 15 22 10.64" /><path d="m20.91 11.7-1.25-1.25c-.6-.6-.94-1.4-.94-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h.86c.85 0 1.65.34 2.25.94l1.25 1.25" /></>)}
            </button>
          )}
          {v.promoteBlock && (
            <button type="button" onClick={() => armTool('promote')} title={t('viewer.toolPromote')} aria-label={t('viewer.toolPromote')}
              className={`${baseBtn} ${armedTool === 'promote' ? activeBtn : idleBtn}`}>
              {svg(<><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" /></>)}
            </button>
          )}
          {v.mergeBlocks && (
            <button type="button" onClick={() => armTool('merge')} title={t('viewer.toolMerge')} aria-label={t('viewer.toolMerge')}
              className={`${baseBtn} ${armedTool === 'merge' ? activeBtn : idleBtn}`}>
              {svg(<><path d="M7 22a5 5 0 0 1-2-4" /><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1" /><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /></>)}
            </button>
          )}
          {v.splitMerge && (
            <button type="button" onClick={() => armTool('split')} title={t('viewer.toolSplit')} aria-label={t('viewer.toolSplit')}
              className={`${baseBtn} ${armedTool === 'split' ? activeBtn : idleBtn}`}>
              {svg(<><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></>)}
            </button>
          )}
          {v.searchConcept && (
            // Arm on pointerdown with preventDefault so any existing text
            // selection survives the press (mouse AND touch) — the layer then
            // auto-fills both carets from it. preventDefault also stops the tap
            // from collapsing the native selection before the layer mounts.
            <button type="button" onPointerDown={e => { e.preventDefault(); armTool('search') }} title={t('viewer.toolSearch')} aria-label={t('viewer.toolSearch')}
              className={`${baseBtn} ${armedTool === 'search' ? activeBtn : idleBtn}`}>
              {svg(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const PdfViewer = forwardRef(function PdfViewer({ file, onExplain, pages, linearBlocks = [], activeParagraph, currentExplanation, explanation, onHome, onBlockEdit, mergeSelectedKeys, mergeMembership, onExplainGroup, linearEditInfo, paintBlocks = [], onSearchSelect, searchResetKey }, ref) {
  const { t } = useUiLang()
  const { settings, isOpen: settingsOpen } = useSettings()
  const visibility = settings.visibility
  const { armedTool } = useEdit()
  // Global shortcut handlers (incl. tracking) must go quiet while the settings
  // modal is open so capturing a key in a field never fires a reader action.
  const settingsOpenRef = useRef(false)
  useEffect(() => { settingsOpenRef.current = settingsOpen }, [settingsOpen])
  const [hoveredChain, setHoveredChain]       = useState(null)
  const [containerWidth, setContainerWidth]   = useState(null)
  const [userZoom, setUserZoom]               = useState(1.0)
  const [tracking, setTracking]               = useState(false)
  const [currentStop, setCurrentStop]         = useState(0)
  // Document index (table of contents) dropdown — toggled by its button and the
  // 'index' shortcut. Lists every section/subsection header; clicking one
  // scrolls it into view.
  const [indexOpen, setIndexOpen]             = useState(false)
  // Shared IntersectionObserver for both PaginatedCanvas instances and
  // (eventually) any other lazy-render component on the page. Held in
  // state so child effects rebind when it's available.
  const [observerInstance, setObserverInstance] = useState(null)

  const containerRef = useRef(null)
  const trackingToolbarRef    = useRef(null)
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

  // Single shared pdfjs document instance — used by BOTH the paginated
  // PaginatedCanvas pages AND the tracking-mode LinearReader (BlockCrop).
  // Loaded eagerly now that paginated mode also needs it (custom canvas
  // render); the parsing cost happens once per file and is reused across
  // mode toggles + zoom + scroll without re-fetching.
  const sharedPdfDoc = usePdfDocument(file)
  // Shared page-canvas cache. maxCached sized for a sliding window of
  // visible paginated pages (~6 visible at a time on a typical viewport)
  // plus headroom for the IntersectionObserver prefetch margin.
  const { pageCanvases, requestPage } = usePageCache(sharedPdfDoc, { maxCached: 12, concurrent: 2 })
  const numPages = sharedPdfDoc?.numPages ?? null

  // ── Tracking mode ───────────────────────────────────────────────────────────
  const paginatedSequence = useMemo(() => buildReadingSequence(pages), [pages])
  const linearSequence    = useMemo(() => buildLinearReadingSequence(linearBlocks), [linearBlocks])
  const readingSequence   = tracking ? linearSequence : paginatedSequence

  // Document index: every section/subsection header in reading order. Depth is
  // inferred from the leading numbering ("2" → 0, "2.1" → 1, "2.1.3" → 2); an
  // unnumbered header sits at depth 0. `linearIdx` feeds centerBlock for the
  // click-to-scroll.
  const sections = useMemo(() => {
    const out = []
    for (let i = 0; i < linearBlocks.length; i++) {
      const b = linearBlocks[i]
      if (b?.role !== 'section_header') continue
      const text = (b.text || '').trim()
      if (!text) continue
      const m = text.match(/^\s*(\d+(?:\.\d+)*)/)
      const depth = m ? Math.min(3, (m[1].match(/\./g) || []).length) : 0
      out.push({ linearIdx: i, text, depth })
    }
    return out
  }, [linearBlocks])

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

  // centerBlock(linearIdx, opts) brings a specific linearBlocks entry into
  // view; routes to tracking or paginated logic based on current mode.
  // onlyIfHidden skips the scroll when the block is already on screen, used for
  // paragraph-change auto-follow. Shared by the imperative handle (Reader's
  // auto-follow) and the index dropdown's click-to-scroll.
  const centerBlock = useCallback((linearIdx, options = {}) => {
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
  }, [tracking, linearBlocks, pageDims])

  // Toggle the index dropdown — exposed so Reader's 'index' shortcut can open
  // it even when the on-screen button is hidden.
  const toggleIndex = useCallback(() => setIndexOpen(o => !o), [])

  // Imperative scroll API for Reader.jsx.
  useImperativeHandle(ref, () => ({
    centerBlock,
    toggleIndex,

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

    // Raw scroll element for Reader's continuous W/S scroll loop. Same node in
    // both paginated and tracking mode (it IS the overflow-auto root).
    getScrollContainer() {
      return containerRef.current
    },

    // Enter/exit tracking from Reader's keymap (the trackingToggle shortcut).
    // tracking is in deps so this closes over a fresh handleToggleTracking.
    toggleTracking() {
      handleToggleTracking()
    },
  }), [tracking, linearBlocks, pageDims, centerBlock, toggleIndex])

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
      // Leaving tracking: userZoom may sit below the paginated floor (tracking
      // zoom-in reaches 0.25). Clamp back into [ZOOM_MIN, ZOOM_MAX] so the
      // paginated page never renders below its documented minimum.
      setUserZoom(z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)))
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
      if (settingsOpenRef.current) return
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return

      const viewportFactor = tracking ? 0.1 : 0.55
      
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        node.scrollBy({ top: node.clientHeight * viewportFactor, behavior: 'smooth' })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        node.scrollBy({ top: -node.clientHeight * viewportFactor, behavior: 'smooth' })
      } else if (e.key === 'PageDown') {
        // Space intentionally NOT bound here: it is reserved globally for
        // "center current highlight" (Reader.onKey). PageDown still steps.
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
        // Tracking renders the column at 1/userZoom, so spreading fingers must
        // LOWER userZoom to grow it — same inversion onWheel applies via `sign`.
        // Without this, pinch-to-zoom is reversed only while tracking is on.
        const factor = trackingRef.current ? 1 / ratio : ratio
        const next   = pinchStartZoom * factor
        setUserZoom(Math.max(trackingRef.current ? ZOOM_MIN_TRACKING : ZOOM_MIN, Math.min(trackingRef.current ? ZOOM_MAX_TRACKING : ZOOM_MAX, next)))
      }
    }

    function onTouchEnd(e) {
      if (e.touches.length < 2) pinchActive = false
    }

    // Trackpad pinch + Ctrl+wheel zoom. Browsers translate two-finger pinch
    // on a trackpad into a wheel event with ctrlKey=true (Chromium,
    // Firefox, Safari on macOS/Windows/Linux), so the same handler covers
    // both. Both modes now render via canvas drawImage from a cached
    // pdfjs page bitmap (paginated through PaginatedCanvas, tracking
    // through BlockCrop), so zoom is GPU-fast and we can apply userZoom
    // directly per event — no debounce, no CSS-transform preview hack,
    // no blank canvas. Direction inverts in tracking because higher
    // userZoom shrinks the reading column there.
    function onWheel(e) {
      if (!e.ctrlKey) return
      e.preventDefault()
      const clamped = Math.max(-20, Math.min(20, e.deltaY))
      const sign    = trackingRef.current ? -1 : 1
      const factor  = Math.exp(-clamped * 0.005 * sign)
      setUserZoom(z => Math.max(trackingRef.current ? ZOOM_MIN_TRACKING : ZOOM_MIN, Math.min(trackingRef.current ? ZOOM_MAX_TRACKING : ZOOM_MAX, z * factor)))
    }

    // passive:false necesario para que preventDefault sea efectivo durante pinch
    node.addEventListener('touchstart',  onTouchStart, { passive: false })
    node.addEventListener('touchmove',   onTouchMove,  { passive: false })
    node.addEventListener('touchend',    onTouchEnd)
    node.addEventListener('touchcancel', onTouchEnd)
    node.addEventListener('wheel',       onWheel,      { passive: false })

    return () => {
      ro.disconnect()
      node.removeEventListener('touchstart',  onTouchStart)
      node.removeEventListener('touchmove',   onTouchMove)
      node.removeEventListener('touchend',    onTouchEnd)
      node.removeEventListener('touchcancel', onTouchEnd)
      node.removeEventListener('wheel',       onWheel)
    }
  }, [])

  // Shared IntersectionObserver for lazy page renders. rootMargin keeps
  // ~one viewport of headroom so pages prefetch before the user scrolls
  // to them. Container has overflow-auto so it IS the scroll root.
  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const obs = new IntersectionObserver(entries => {
      for (const entry of entries) {
        entry.target.__onIntersect?.(entry)
      }
    }, { root: node, rootMargin: '600px 0px 600px 0px', threshold: 0 })
    setObserverInstance(obs)
    return () => {
      obs.disconnect()
      setObserverInstance(null)
    }
  }, [])

  // Re-add the trackingRef + userZoomRef the wheel/touch handlers need —
  // touch path still reads them for pinch state, and tracking-mode
  // wheel inverts based on trackingRef.
  const userZoomRef = useRef(1.0)
  const trackingRef = useRef(false)
  useEffect(() => { userZoomRef.current = userZoom }, [userZoom])
  useEffect(() => { trackingRef.current = tracking }, [tracking])

  function zoomIn()  { setUserZoom(z => Math.min(z + ZOOM_STEP, tracking ? ZOOM_MAX_TRACKING : ZOOM_MAX)) }
  function zoomOut() { setUserZoom(z => Math.max(z - ZOOM_STEP, tracking ? ZOOM_MIN_TRACKING : ZOOM_MIN)) }
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
  // Per-page pincel paint targets (linear-only blocks — title/author/etc. — that
  // have no pages.blocks row). Only consumed while the promote tool is armed.
  const paintMap = {}
  for (const pt of (paintBlocks ?? [])) (paintMap[pt.page] ||= []).push(pt)
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

  // Hide the nav pill entirely when every control inside it is hidden, so a
  // bare floating chrome bar never shows. Settings sits below it, gated alone.
  const showNavRow = (onHome && visibility.home) || visibility.tracking || visibility.index || (tracking && visibility.viewType)

  return (
    <div className="relative h-full bg-gray-100 pdf-canvas-backdrop">
      {/* Click-away overlay for the index dropdown. */}
      {indexOpen && (
        <div className="fixed inset-0 z-20" onClick={() => setIndexOpen(false)} />
      )}
      {visibility.zoom && (tracking ? (
        <ZoomToolbar
          displayZoom={1 / userZoom}
          onIncrease={zoomOut}
          onDecrease={zoomIn}
          onFit={zoomFit}
          canIncrease={userZoom > ZOOM_MIN_TRACKING + 1e-3}
          canDecrease={userZoom < ZOOM_MAX_TRACKING - 1e-3}
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
      ))}

      {/* Top-left navigation: the tracking toolbar row, with the Settings
          button stacked directly beneath the Home button. */}
      <div className="absolute top-4 left-4 z-30 flex flex-col items-start gap-2">
        {showNavRow && (
        <div ref={trackingToolbarRef} className="flex items-center gap-1 bg-white/95 backdrop-blur rounded-xl shadow-md border border-slate-200 p-1.5 select-none">
          {onHome && visibility.home && (
            <button
              onClick={onHome}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
              title={t('viewer.backToMenu')}
              aria-label={t('viewer.backToMenu')}
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
          {visibility.tracking && (
            <button
              onClick={handleToggleTracking}
              disabled={readingSequence.length === 0}
              className={`px-3 h-8 rounded-lg text-xs font-semibold transition-colors disabled:opacity-30 disabled:pointer-events-none ${
                tracking
                  ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
              }`}
              title={tracking ? t('viewer.trackingExit') : t('viewer.trackingActivate')}
            >
              {tracking ? t('viewer.trackingOn') : t('viewer.trackingOff')}
            </button>
          )}
          {tracking && visibility.viewType && (
            <>
              <button
                onClick={() => setCurrentStop(s => Math.max(0, s - 1))}
                disabled={currentStop <= 0}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30 disabled:pointer-events-none transition-colors font-semibold"
                title={t('viewer.prevStop')}
              >↑</button>
              <span className="text-[11px] font-bold tabular-nums text-slate-600 min-w-[3.5rem] text-center">
                {currentStop + 1}/{readingSequence.length}
              </span>
              <button
                onClick={() => setCurrentStop(s => Math.min(readingSequence.length - 1, s + 1))}
                disabled={currentStop >= readingSequence.length - 1}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30 disabled:pointer-events-none transition-colors font-semibold"
                title={t('viewer.nextStop')}
              >↓</button>
            </>
          )}
          {visibility.index && (
            <button
              onClick={() => setIndexOpen(o => !o)}
              disabled={sections.length === 0}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none ${
                indexOpen
                  ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
              }`}
              title={t('viewer.index')}
              aria-label={t('viewer.index')}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          )}
        </div>
        )}
        {/* Document index dropdown — sections + subsections (indented by depth).
            Click scrolls the header into view. Reachable via the 'index'
            shortcut even when the button above is hidden. */}
        {indexOpen && (
          <div className="w-72 max-h-[60vh] overflow-auto bg-white/95 backdrop-blur rounded-xl shadow-lg border border-slate-200 py-1.5 select-none">
            <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-widest">
              {t('viewer.indexTitle')}
            </div>
            {sections.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400">{t('viewer.indexEmpty')}</div>
            ) : (
              sections.map(s => (
                <button
                  key={s.linearIdx}
                  onClick={() => { centerBlock(s.linearIdx, { smooth: true }); setIndexOpen(false) }}
                  className="block w-full text-left pr-3 py-1.5 text-[13px] text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors truncate"
                  style={{ paddingLeft: 12 + s.depth * 16 }}
                  title={s.text}
                >
                  {s.text}
                </button>
              ))
            )}
          </div>
        )}
        {/* Configuración — directly below the Home button. Hideable; reachable
            via its keyboard shortcut once hidden. */}
        {visibility.settings && (
          <SettingsButton className="w-9 h-9 flex items-center justify-center rounded-xl bg-white/95 backdrop-blur shadow-md border border-slate-200 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors" />
        )}
        {/* Theme cycle (normal → sepia → soft-dark) stacked beneath Settings.
            Hideable; the themeToggle shortcut still cycles when hidden. */}
        {visibility.theme && <ThemeButton />}
      </div>

      {/* Edit toolbar: undo/redo + mazo/pincel/lazo, bottom-left. */}
      <EditToolbar />

      <div
        ref={containerRef}
        className="h-full overflow-auto"
        // Always allow native one-finger pan (both modes). Custom pinch-zoom
        // still works: the 2-finger touchmove handler preventDefaults itself.
        // 'none' here was what froze touch panning while tracking was on.
        style={{ touchAction: 'pan-x pan-y' }}
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
                armedTool={armedTool}
                onBlockEdit={onBlockEdit}
                onExplainGroup={onExplainGroup}
                editInfo={linearEditInfo}
              />
            )}
          </div>
        ) : (
        <div
          className="flex flex-col items-center py-8 px-6 min-h-full"
          style={{ minWidth: 'fit-content' }}
        >
          {!sharedPdfDoc && (
            <p className="text-slate-400 text-sm mt-16">{t('viewer.loadingPdf')}</p>
          )}
          {numPages && pageWidth &&
            Array.from({ length: numPages }, (_, i) => (
              <PdfPage
                key={i}
                pdfDoc={sharedPdfDoc}
                pageNumber={i + 1}
                width={pageWidth}
                pageDim={pageDims[i + 1]}
                srcCanvas={pageCanvases[i + 1]}
                requestPage={requestPage}
                observer={observerInstance}
                blocks={blocksMap[i + 1]}
                images={imagesMap[i + 1]}
                paintTargets={paintMap[i + 1]}
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
                armedTool={armedTool}
                onBlockEdit={onBlockEdit}
                mergeSelectedKeys={mergeSelectedKeys}
                mergeMembership={mergeMembership}
                onExplainGroup={onExplainGroup}
                onSearchSelect={onSearchSelect}
                searchResetKey={searchResetKey}
              />
            ))}
        </div>
        )}
      </div>
    </div>
  )
})

export default PdfViewer
