import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import PdfViewer from '../components/PdfViewer'
import Sidebar from '../components/Sidebar'
import { buildContinuationPayloads, resolveSentenceIndices, logSentence } from '../components/highlight-utils'
import { useUiLang } from '../i18n/LanguageContext'
import { useTheme } from '../theme/ThemeContext'
import { ACTIONS, useSettings } from '../settings/SettingsContext'
import { useEdit } from '../edit/EditContext'

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

// Empty manual-edit state. `pageOverrides` maps "<page>:<reading_index>" → a
// role override (e.g. { role: 'ignored' } for a mazo-demoted paragraph).
// `mergeGroups` are lazo-created units explained as one (figure if any image
// member, else combined paragraph + footnote-type members).
const DEFAULT_EDITS = { pageOverrides: {}, mergeGroups: [] }

// Roles offered by the pincel (promote) picker, split into two UX groups:
// GROUP A are explainable (carry a ✦ + an explanation); GROUP B are metadata that
// reshape structure without being independently explainable. Any role can be
// assigned to any object — that's how broken extractions get repaired.
const PROMOTE_GROUPS = [
  {
    titleKey: 'viewer.typeGroupExplainable',
    items: [
      { role: 'paragraph', labelKey: 'viewer.typeParagraph' },
      { role: 'figure',    labelKey: 'viewer.typeFigure' },
      { role: 'table',     labelKey: 'viewer.typeTable' },
      { role: 'algorithm', labelKey: 'viewer.typeAlgorithm' },
      { role: 'equation',  labelKey: 'viewer.typeEquation' },
    ],
  },
  {
    titleKey: 'viewer.typeGroupMetadata',
    items: [
      { role: 'ignored',        labelKey: 'viewer.typeIgnored' },
      { role: 'footnote',       labelKey: 'viewer.typeFootnote' },
      { role: 'title',          labelKey: 'viewer.typeTitle' },
      { role: 'author',         labelKey: 'viewer.typeAuthor' },
      { role: 'section_header', labelKey: 'viewer.typeSectionHeader' },
    ],
  },
]

// A lazo (manual) merge resolves its consolidated type the same way the backend
// merge state machine does: a VISUAL block dominates text. Precedence table >
// figure > algorithm; only when no member is visual does the result stay a
// paragraph. Mirrors `extraction._merge_figure_captions_*` (the "visual wins"
// rule) — replicated here because that pass is Python and not callable at
// runtime from the client.
const MERGE_VISUAL_ROLES = ['table', 'figure', 'algorithm']
function resolveMergedRole(roles) {
  for (const v of MERGE_VISUAL_ROLES) {
    if (roles.includes(v)) return v
  }
  return 'paragraph'
}

// Bounding box of a list of per-line boxes.
function unionOfBoxes(boxes) {
  return boxes.reduce((a, b) => ({
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
  }), { ...boxes[0] })
}

// Stable override key for a linear-only block (a FullBlock with no pages.blocks
// row — title/author/section_header/list — so it has no per-page reading_index
// to key on). Extraction is deterministic, so a rounded page+bbox origin is a
// stable identity across reloads. Namespaced `L:` so it never collides with the
// per-page `page:reading_index` keys.
function paintKey(page, bbox) {
  return `L:${page}:${Math.round(bbox.x0)}:${Math.round(bbox.y0)}`
}

// True when two bboxes overlap heavily (≥60% of the smaller area). Used to
// bridge the per-page and linear projections: both walk the SAME Marker blocks,
// so a paragraph's bbox is near-identical across them, and overlap matching
// survives the minor bbox tweaks each projection's post-passes apply.
function bboxOverlapHigh(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const inter = ix * iy
  if (inter <= 0) return false
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0)
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0)
  return inter / Math.max(1e-6, Math.min(areaA, areaB)) >= 0.6
}

// A block earns its ✦ (in BOTH modes) only when its role makes it explainable.
// Mirrors LinearReader's `isInteractive` so a linear-only block injected into the
// paginated projection shows the SAME affordance it already shows in tracking —
// never one without the other. A pincel-promoted title/author reaches this once
// it's a sentence-bearing paragraph.
function isExplainableParagraph(b) {
  return b.role === 'paragraph' && (b.sentences?.length ?? 0) > 0
}

// Unified per-object identity for the edit tools (lazo membership/selection and
// merge-group resolution). Injected/linear-only blocks have no reading_index, so
// they key on their geometric linearKey; native blocks and images key on
// page+reading_index. This is what makes a promoted block a FIRST-CLASS citizen
// of the linker/scissors — the exact same lookup as any native object. NOTE: the
// `block:` variant is mirrored inline by ParagraphOverlay's blockKey in PdfViewer.
function editKeyOf(t) {
  return t.linearKey ? `block:${t.linearKey}` : `${t.kind}:${t.page}:${t.reading_index}`
}

// Floating block-type picker for the pincel tool. Anchored at the click point,
// clamped to the viewport. Two visual columns: explainable roles vs metadata
// (`ignored` flagged red as the destructive choice). Backdrop closes it.
function TypePicker({ x, y, onPick, onClose, t }) {
  const left = Math.max(8, Math.min(x, window.innerWidth - 360))
  const top  = Math.max(8, Math.min(y, window.innerHeight - 260))
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-[22rem] bg-white/95 backdrop-blur rounded-xl shadow-lg border border-slate-200 p-2 select-none"
        style={{ left, top }}
      >
        <div className="px-1.5 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-widest">
          {t('viewer.typePickerTitle')}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {PROMOTE_GROUPS.map(group => (
            <div key={group.titleKey} className="flex flex-col">
              <div className="px-1.5 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                {t(group.titleKey)}
              </div>
              {group.items.map(({ role, labelKey }) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => onPick(role)}
                  className={`block w-full text-left px-2 py-1.5 rounded-lg text-[13px] transition-colors ${
                    role === 'ignored'
                      ? 'text-red-600 hover:bg-red-50'
                      : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

async function postExplainWithRetry(payload, onRetry, maxAttempts = 3) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.post('/api/explain-paragraph/', payload)
      return res.data
    } catch (err) {
      lastErr = err
      const status = err?.response?.status
      const isNetwork = !err?.response && err?.code !== 'ECONNABORTED'
      const retryable = isNetwork || RETRYABLE_STATUSES.has(status)
      if (!retryable || attempt === maxAttempts) throw err
      const delayMs = 1000 * 2 ** (attempt - 1)
      onRetry?.(attempt, maxAttempts, delayMs)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

function djb2(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
}

// Cache key version. Bump when stored explanation shape changes so stale
// entries from old shapes get orphaned instead of mis-deserialized.
const EXPLAIN_CACHE_VERSION = 'v3'

function explainCacheKey(filename, text, opts = {}) {
  // Language is part of the key: the same paragraph explained in es / en /
  // zh-Hant produces different text, so each language caches independently.
  const lang = opts.language || 'es'
  // Figures/tables have no representative text — key on role+page+bbox so a
  // recropped or relocated figure invalidates correctly.
  if (opts.role === 'figure' || opts.role === 'table' || opts.role === 'algorithm') {
    const b = opts.bbox || {}
    const tag = `${opts.role}:${opts.page}:${b.x0},${b.y0},${b.x1},${b.y1}`
    return `deepstudy:explain:${EXPLAIN_CACHE_VERSION}:${lang}:${filename}:${djb2(tag)}`
  }
  return `deepstudy:explain:${EXPLAIN_CACHE_VERSION}:${lang}:${filename}:${djb2(text)}`
}

function readCachedExplanation(filename, text, memCache, opts = {}) {
  const key = explainCacheKey(filename, text, opts)
  if (memCache.has(key)) return memCache.get(key)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    memCache.set(key, parsed)
    return parsed
  } catch {
    return null
  }
}

function writeCachedExplanation(filename, text, data, memCache, opts = {}) {
  const key = explainCacheKey(filename, text, opts)
  memCache.set(key, data)
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // localStorage full or unavailable — ignore, mem cache still holds it
  }
}

function buildExplainError(err, t) {
  if (err?.code === 'ECONNABORTED') {
    return t('errors.explain.timeout')
  }
  if (!err?.response) {
    return t('errors.explain.noConnection')
  }
  const status = err.response.status
  const detail = err.response.data?.detail ?? ''

  if (status === 400) {
    return t('errors.explain.badRequest', { detail })
  }
  if (status === 502) {
    const lower = detail.toLowerCase()
    if (lower.includes('truncated') || lower.includes('max_tokens')) {
      return t('errors.explain.truncated')
    }
    if (lower.includes('invalid json')) {
      return t('errors.explain.invalidJson')
    }
    if (lower.includes('429') || lower.includes('rate') || lower.includes('quota')) {
      return t('errors.explain.rateLimit')
    }
    if (lower.includes('empty response')) {
      return t('errors.explain.empty')
    }
    return t('errors.explain.geminiTransient', { detail })
  }
  if (status >= 500) {
    return t('errors.explain.server', { status })
  }
  return t('errors.explain.unexpected', { status, detail })
}

export default function Reader() {
  const { t } = useUiLang()
  const { settings, isOpen: settingsOpen, openSettings } = useSettings()
  const { visibility, panelSide, panelWidthPct } = settings
  const { cycleTheme } = useTheme()
  const { armTool, armedTool, disarm, commitEdit, undo, redo, mergeBuffer, addToMergeBuffer, clearMergeBuffer } = useEdit()
  const { filename } = useParams()

  // Panel occupies a user-configurable share of the viewport (settings slider),
  // tracked off window width so it follows live resizes. The wrapper animates
  // between this width and 0; the inner panel keeps the same width so its
  // content slides under the clip instead of reflowing during the transition.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  )
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const sidebarWidth = Math.round(viewportWidth * (panelWidthPct / 100))
  const navigate = useNavigate()
  const decoded = decodeURIComponent(filename)

  const [analysis, setAnalysis] = useState(null)
  const [loadingAnalysis, setLoadingAnalysis] = useState(true)
  const [errorAnalysis, setErrorAnalysis] = useState(null)

  const [explanation, setExplanation] = useState(null)
  const [loadingExplain, setLoadingExplain] = useState(false)
  const [errorExplain, setErrorExplain] = useState(null)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [activeParagraph, setActiveParagraph] = useState(null)
  const [retryInfo, setRetryInfo] = useState(null)

  const [tab, setTab] = useState('global')
  const [explainMode, setExplainMode] = useState('conceptos')
  // Right panel (global map / explanation) visibility. Toggled by the viewer
  // button, "." and "Z"; auto-opened by the content shortcuts (E / R / ✦).
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  // Keyboard focus target for immersive navigation. 'canvas' drives the
  // continuous W/S scroll over the PDF; 'sidebar' routes W/S into the panel's
  // own scroll. Toggled with Q. Space never changes it.
  const [focusArea, setFocusArea] = useState('canvas')

  const uiStateRef = useRef({ tab, explainMode })
  useEffect(() => {
    uiStateRef.current = { tab, explainMode }
  }, [tab, explainMode])

  // Auto-switch after receiving a real explanation. Skeleton placeholders set
  // explanation before the fetch resolves; don't yank the user out of the
  // global map for a loading state.
  useEffect(() => {
    if (explanation && !explanation.__skeleton) setTab('explain')
  }, [explanation])

  const explanationsCache = useRef(new Map())
  const viewerRef         = useRef(null)
  const explainRequestId  = useRef(0)
  const explanationRef    = useRef(null)
  const currentIndexRef   = useRef(0)
  useEffect(() => { explanationRef.current  = explanation  }, [explanation])
  useEffect(() => { currentIndexRef.current = currentIndex }, [currentIndex])

  // Mirror focus + panel state into refs so the once-bound global W/S scroll
  // listener and the Z handler read fresh values without rebinding.
  const focusAreaRef     = useRef('canvas')
  const isSidebarOpenRef = useRef(true)
  const sidebarScrollRef = useRef(null)   // → Sidebar's inner scroll container
  useEffect(() => { focusAreaRef.current     = focusArea     }, [focusArea])
  useEffect(() => { isSidebarOpenRef.current = isSidebarOpen }, [isSidebarOpen])

  // Active keybindings come from the selected hand in SettingsContext. Build a
  // key→action lookup for the keydown handler; mirror the scroll keys + the
  // modal-open flag into refs for the once-bound continuous-scroll listener.
  const activeShortcuts = settings.shortcuts[settings.handMode]
  const keyToAction = useMemo(() => {
    const m = {}
    for (const a of ACTIONS) { const key = activeShortcuts[a]; if (key) m[key] = a }
    return m
  }, [activeShortcuts])
  const scrollKeysRef   = useRef({ up: 'w', down: 's' })
  const settingsOpenRef = useRef(false)
  useEffect(() => {
    scrollKeysRef.current = { up: activeShortcuts.scrollUp, down: activeShortcuts.scrollDown }
  }, [activeShortcuts])
  useEffect(() => { settingsOpenRef.current = settingsOpen }, [settingsOpen])

  const pdfUrl = `/api/documents/${encodeURIComponent(decoded)}`

  // ── Manual edits (mazo / pincel / lazo) ─────────────────────────────────────
  // Block role overrides (and, later, merge groups) layered over the extracted
  // analysis and persisted to the backend so they survive reload. Declared
  // before the analysis-load effect, which hydrates them from disk.
  const [edits, setEdits] = useState(DEFAULT_EDITS)
  // Pincel type picker: { target, x, y } anchored at the click, or null.
  const [promotePicker, setPromotePicker] = useState(null)
  // Lupa (search) selection: { text, paragraphSentences } | null, a reset
  // counter that tells the selection overlay to clear, and a busy flag.
  const [searchSel, setSearchSel] = useState(null)
  const [searchResetKey, setSearchResetKey] = useState(0)
  const [searchBusy, setSearchBusy] = useState(false)
  // JSON of the value last known in sync with the backend — lets the persist
  // effect skip the change triggered by hydration.
  const lastPersisted = useRef(null)

  useEffect(() => {
    axios.get(`/api/documents/${encodeURIComponent(decoded)}/analysis`)
      .then(res => {
        setAnalysis(res.data)
        // Hydrate manual edits from disk in the same callback (not a synchronous
        // effect body) so undo/redo start clean and the persist effect skips it.
        const ed = res.data?.edits && typeof res.data.edits === 'object'
          ? { pageOverrides: res.data.edits.pageOverrides ?? {}, mergeGroups: res.data.edits.mergeGroups ?? [] }
          : DEFAULT_EDITS
        lastPersisted.current = JSON.stringify(ed)
        setEdits(ed)
        disarm()  // never carry an armed tool across documents
        setPromotePicker(null)
        setSearchSel(null)
      })
      .catch(() => setErrorAnalysis(true))
      .finally(() => setLoadingAnalysis(false))
  }, [decoded, disarm])

  // Linear projection with page-level role overrides bridged in, so tracking
  // mode reflects edits made in paginated mode (mazo demote / pincel promote).
  // Overrides match linear blocks by BBOX. Two flavours:
  //   - identity-carrying (pincel on a linear-only block: title/author/
  //     section_header/list with NO pages.blocks row) store their own
  //     { bbox, page } and match directly;
  //   - legacy per-page (keyed page:reading_index) resolve their bbox via
  //     pages.blocks.
  // This bbox-first bridge is what lets the pincel re-type ANY block — even ones
  // the backend never emitted into pages.blocks — into the reading flow.
  const projectedLinear = useMemo(() => {
    const raw = analysis?.linear_blocks ?? []
    const po = edits.pageOverrides
    if (!raw.length || !po || Object.keys(po).length === 0) return raw

    const overridesByPage = {}  // page -> [{ bbox, role, continuation }]
    for (const [key, val] of Object.entries(po)) {
      if (!val) continue
      let bbox, pg
      if (val.bbox) {
        bbox = val.bbox; pg = val.page              // identity-carrying (linear-only)
      } else {
        const [pageStr, riStr] = key.split(':')     // legacy per-page override
        pg = Number(pageStr)
        const ri = Number(riStr)
        const p = analysis?.pages?.find(x => x.page === pg)
        const b = p?.blocks?.find(bl => bl.reading_index === ri)
        if (!b?.boxes?.length) continue
        bbox = unionOfBoxes(b.boxes)
      }
      if (!bbox || pg == null) continue
      ;(overridesByPage[pg] ||= []).push({ bbox, role: val.role, continuation: val.continuation })
    }
    if (Object.keys(overridesByPage).length === 0) return raw

    return raw.map(L => {
      const cands = overridesByPage[L.page]
      if (!cands || !L.bbox) return L
      const m = cands.find(c => bboxOverlapHigh(c.bbox, L.bbox))
      if (!m) return L
      let nb = L
      if (m.role && m.role !== L.role) nb = { ...nb, role: m.role }
      if (m.continuation === false && L.continuation) nb = { ...nb, continuation: false }
      return nb
    })
  }, [analysis, edits])

  // Reading/tracking sequence: hammer-ignored blocks are dropped ENTIRELY so
  // they vanish from the LinearReader render, nav, paragraphList, chainPayloads
  // and linearEditInfo. They survive in `projectedLinear` / `editedPages`, so the
  // pincel and the paginated hammer overlay can still see + restore them.
  const linearBlocks = useMemo(
    () => projectedLinear.filter(b => b.role !== 'ignored'),
    [projectedLinear],
  )

  // The pincel (promote) sees EVERYTHING — every role (incl. title/author/
  // section_header/list the backend never made explainable) AND hammer-ignored
  // blocks — so it can re-type any of them into the reading flow.
  const paintableBlocks = projectedLinear

  // Dropped OCR text the backend preserved in pages[].metadata_blocks — footnotes,
  // page headers/footers, references, acknowledgments/keywords, contact/noise:
  // every text object the reading-flow pipeline discarded. They live OUTSIDE the
  // reading flow (never added to linearBlocks/tracking) and default to role
  // 'ignored' so they neither auto-inject nor show a ✦. They exist purely so the
  // universal pincel can enclose and re-type them. Empty on analysis.json files
  // generated before the backend field existed (those docs must be re-analyzed).
  const metadataBlocksRaw = useMemo(() => {
    const out = []
    for (const p of (analysis?.pages || [])) {
      for (const mb of (p.metadata_blocks || [])) {
        if (mb?.bbox) out.push({
          page: p.page, bbox: mb.bbox, role: 'ignored',
          text: mb.text ?? '', sentences: mb.sentences ?? [], source: mb.source_type,
        })
      }
    }
    return out
  }, [analysis])

  // Same bbox-first override bridge as projectedLinear, but over the dropped
  // blocks: a pincel promotion (stored under the block's linearKey WITH its bbox)
  // re-types the metadata block by geometry. Only bbox-carrying overrides apply.
  const projectedMetadata = useMemo(() => {
    const raw = metadataBlocksRaw
    const po = edits.pageOverrides
    if (!raw.length || !po || Object.keys(po).length === 0) return raw
    const overridesByPage = {}
    for (const val of Object.values(po)) {
      if (!val?.bbox) continue
      ;(overridesByPage[val.page] ||= []).push({ bbox: val.bbox, role: val.role })
    }
    if (Object.keys(overridesByPage).length === 0) return raw
    return raw.map(M => {
      const cands = overridesByPage[M.page]
      if (!cands) return M
      const m = cands.find(c => bboxOverlapHigh(c.bbox, M.bbox))
      return (m && m.role && m.role !== M.role) ? { ...M, role: m.role } : M
    })
  }, [metadataBlocksRaw, edits])

  // Persist edits to the backend (debounced) whenever they change post-hydration.
  useEffect(() => {
    if (lastPersisted.current === null) return  // not hydrated yet
    const s = JSON.stringify(edits)
    if (s === lastPersisted.current) return     // hydration or no-op change
    lastPersisted.current = s
    const id = setTimeout(() => {
      axios.patch(`/api/documents/${encodeURIComponent(decoded)}/analysis/edits`, edits).catch(() => {})
    }, 400)
    return () => clearTimeout(id)
  }, [edits, decoded])

  // Apply page-level role overrides onto the extracted pages projection, THEN
  // inject promoted linear-only paragraphs (title/author/section_header the
  // pincel re-typed to 'paragraph') that have no pages.blocks row — so the
  // paginated overlay draws their ✦ through the SAME block path as a native
  // paragraph. Without this they're explainable only in tracking mode.
  const editedPages = useMemo(() => {
    const pages = analysis?.pages
    if (!pages) return pages
    const po = edits.pageOverrides
    const hasOverrides = po && Object.keys(po).length > 0

    // 1. Role/continuation overrides over the native pages.blocks.
    const based = !hasOverrides ? pages : pages.map(p => {
      let blocksChanged = false
      const blocks = p.blocks.map(b => {
        const o = po[`${p.page}:${b.reading_index}`]
        if (!o) return b
        let nb = b
        if (o.role && o.role !== b.role) nb = { ...nb, role: o.role }
        if (o.continuation === false && b.continuation) nb = { ...nb, continuation: false }
        if (nb !== b) blocksChanged = true
        return nb
      })
      // Images carry a role too (figure/table/algorithm). The pincel re-types
      // them via an `img:` override so figures/tables are first-class pincel
      // targets. Keyed apart from blocks to avoid reading_index collisions.
      let imagesChanged = false
      const images = (p.images || []).map(im => {
        const o = po[`img:${p.page}:${im.reading_index}`]
        if (!o || !o.role || o.role === im.role) return im
        imagesChanged = true
        return { ...im, role: o.role }
      })
      if (!blocksChanged && !imagesChanged) return p
      return {
        ...p,
        blocks: blocksChanged ? blocks : p.blocks,
        images: imagesChanged ? images : p.images,
      }
    })

    // 2. Inject linear-only paragraphs that carry no pages identity. The bbox-
    //    overlap test is the SAME predicate linearOnlyPaintTargets uses, so a
    //    block is EITHER a native-overlay block OR an injected one — never both,
    //    so its ✦ (and its blue pincel box) is drawn exactly once.
    const nativeBoxesByPage = {}
    for (const p of based) {
      nativeBoxesByPage[p.page] = [
        ...(p.blocks || []).filter(b => b.boxes?.length).map(b => unionOfBoxes(b.boxes)),
        ...(p.images || []).filter(im => im.bbox).map(im => im.bbox),
      ]
    }
    // Source = the reading-flow linear blocks PLUS the dropped metadata blocks:
    // promoting either to a sentence-bearing paragraph injects it identically, so
    // a re-typed footnote/acknowledgment becomes a first-class paginated block.
    const injectByPage = {}
    for (const L of [...linearBlocks, ...projectedMetadata]) {
      if (!L.bbox || !isExplainableParagraph(L)) continue
      const boxes = nativeBoxesByPage[L.page]
      if (!boxes || boxes.some(bb => bboxOverlapHigh(bb, L.bbox))) continue  // has a pages identity
      ;(injectByPage[L.page] ||= []).push({
        // Synthetic pages.blocks row. `boxes:[bbox]` feeds the overlay's union →
        // bottom-right ✦ anchor (reads bbox.x1 / bbox.y1 = x_max / y_max). The
        // tags keep it safe downstream: `linearInjected` makes the continuation
        // builder treat it as transparent (it never chains) and keeps
        // linearEditInfo on the original's geometric key; `linearKey` IS that
        // key, so editing the injected block re-routes to the same override.
        reading_index: undefined,
        linearInjected: true,
        linearKey: paintKey(L.page, L.bbox),
        bbox: L.bbox,
        boxes: [L.bbox],
        role: L.role,
        continuation: false,
        text: L.text ?? '',
        sentences: L.sentences ?? [],
        footnotes: L.footnotes ?? [],
      })
    }
    if (Object.keys(injectByPage).length === 0) return based
    return based.map(p => {
      const extra = injectByPage[p.page]
      return extra ? { ...p, blocks: [...p.blocks, ...extra] } : p
    })
  }, [analysis, edits, linearBlocks, projectedMetadata])

  // Merge a patch into one block's override (role and/or continuation),
  // recorded for undo/redo. `patch` e.g. { role: 'ignored' } or
  // { continuation: false } (scissors cutting a natural join).
  const setOverride = useCallback((target, patch) => {
    // Linear-only targets (pincel on title/author/section_header/list) carry a
    // geometric key + their bbox, so the projection bridge can match them with
    // no pages.blocks row. Everything else keys on the per-page reading_index.
    const key = target.linearKey
      ? target.linearKey
      : target.kind === 'image'
        ? `img:${target.page}:${target.reading_index}`
        : `${target.page}:${target.reading_index}`
    // linearKey and image overrides both stash their bbox so the linear
    // projection can bridge the new role into tracking by geometry (`img:` keys
    // don't parse as page:reading_index, so projectedLinear matches them by bbox).
    const identity = (target.linearKey || target.kind === 'image')
      ? { bbox: target.bbox, page: target.page }
      : {}
    const prev = edits.pageOverrides[key]
    const next = { ...(prev || {}), ...identity, ...patch }
    commitEdit({
      apply: () => setEdits(e => ({ ...e, pageOverrides: { ...e.pageOverrides, [key]: next } })),
      revert: () => setEdits(e => {
        const po = { ...e.pageOverrides }
        if (prev) po[key] = prev; else delete po[key]
        return { ...e, pageOverrides: po }
      }),
    })
  }, [edits, commitEdit])

  // Cut a manual lazo merge group (scissors), recorded for undo/redo.
  const removeMergeGroup = useCallback((groupId) => {
    const g = (edits.mergeGroups || []).find(x => x.id === groupId)
    if (!g) return
    commitEdit({
      apply: () => setEdits(e => ({ ...e, mergeGroups: (e.mergeGroups || []).filter(x => x.id !== groupId) })),
      revert: () => setEdits(e => ({ ...e, mergeGroups: [...(e.mergeGroups || []).filter(x => x.id !== groupId), g] })),
    })
  }, [edits, commitEdit])

  // Dispatch a click from an armed edit tool onto a target block/image. Each
  // completed operation is pushed through commitEdit so undo/redo can replay it.
  const onBlockEdit = useCallback((target, pos) => {
    if (!target) return
    if (armedTool === 'demote') {
      // Mazo/hammer toggles a block's soft-delete: paragraph → 'ignored', and
      // clicking an already-ignored block clears the role override (un-ignore).
      if (target.kind !== 'block') return
      if (target.role === 'paragraph') setOverride(target, { role: 'ignored' })
      else if (target.role === 'ignored') setOverride(target, { role: null })
      else return  // nothing toggled → tool stays armed
      disarm()  // effective use → auto-disarm
      return
    }
    if (armedTool === 'promote') {
      // Pincel: open the block-type picker at the click. Works on EVERY object —
      // blocks (incl. injected linear-only + ignored) AND images (figure/table/
      // algorithm). The chosen role flows through setOverride's geometric /
      // reading_index / img routing.
      setPromotePicker({ target, x: pos?.x ?? 0, y: pos?.y ?? 0 })
      return
    }
    if (armedTool === 'merge') {
      // Lazo: toggle the object in the selection buffer. Only explainables are
      // selectable — an image, or a non-ignored block (including injected
      // linear-only ones, keyed geometrically). The buffer commits on confirm.
      const explainable = target.kind === 'image' || (target.kind === 'block' && target.role !== 'ignored')
      if (!explainable) return
      addToMergeBuffer({
        key: editKeyOf(target),
        kind: target.kind,
        page: target.page,
        reading_index: target.reading_index,
        linearKey: target.linearKey,
        bbox: target.bbox,
        role: target.role,
      })
      return
    }
    if (armedTool === 'split') {
      // Tijeras: cut a merge. A manual lazo group is removed; otherwise a
      // natural continuation join is blocked (this block stops continuing the
      // previous one). Baked figure/caption/panel merges are not cut here.
      const memberKey = editKeyOf(target)
      const g = (edits.mergeGroups || []).find(grp =>
        grp.members.some(m => editKeyOf(m) === memberKey))
      if (g) { removeMergeGroup(g.id); disarm(); return }
      if (target.kind === 'block' && target.continuation) {
        setOverride(target, { continuation: false })
        disarm()  // effective cut → auto-disarm
      }
      return
    }
  }, [armedTool, setOverride, addToMergeBuffer, edits, removeMergeGroup, disarm])

  // Keys currently selected for an in-progress lazo merge (persistent tint).
  const selectedKeys = useMemo(() => new Set(mergeBuffer.map(m => m.key)), [mergeBuffer])

  // Resolve committed merge groups to a per-object lookup: key → { groupId,
  // isRep }. The representative (first member) carries the group's ✦ button.
  const mergeMembership = useMemo(() => {
    const map = {}
    for (const g of (edits.mergeGroups || [])) {
      const resultRole = g.resultRole || (g.explainAs === 'figure' ? 'figure' : 'paragraph')
      g.members.forEach((m, i) => {
        map[editKeyOf(m)] = { groupId: g.id, isRep: i === 0, resultRole }
      })
    }
    return map
  }, [edits])

  // Commit the buffered selection as ONE consolidated block, applying the same
  // hierarchy rule as the automatic merge state machine: `resultRole` is the
  // dominant visual type among the members (figure/table/algorithm), else
  // paragraph. Members must share a page (the per-page overlay renders the
  // group's ✦ on one page). Immutable update via setEdits.
  const confirmMerge = useCallback(() => {
    if (mergeBuffer.length < 2) return
    const page = mergeBuffer[0].page
    if (mergeBuffer.some(m => m.page !== page)) return
    const members = mergeBuffer.map(m => ({ kind: m.kind, page: m.page, reading_index: m.reading_index, linearKey: m.linearKey, bbox: m.bbox, role: m.role }))
    const resultRole = resolveMergedRole(
      members.map(m => m.role || (m.kind === 'image' ? 'figure' : 'paragraph')),
    )
    const id = `mg-${page}-${members.map(m => editKeyOf(m).replace(/[^\w]/g, '')).join('-')}`
    commitEdit({
      apply: () => setEdits(e => ({ ...e, mergeGroups: [...(e.mergeGroups || []).filter(g => g.id !== id), { id, members, resultRole }] })),
      revert: () => setEdits(e => ({ ...e, mergeGroups: (e.mergeGroups || []).filter(g => g.id !== id) })),
    })
    clearMergeBuffer()
    disarm()  // effective merge → auto-disarm
  }, [mergeBuffer, commitEdit, clearMergeBuffer, disarm])

  // Reverse bridge for tracking-mode editing: per linear block, the page-
  // projection identity it maps to (by bbox overlap) plus its lazo state.
  // Lets BlockCrop route tool clicks (onBlockEdit), tint selected/merged
  // blocks, and explain a merge group from its representative — the same
  // operations the paginated overlay supports. Indexed by linear block index.
  const linearEditInfo = useMemo(() => {
    if (!linearBlocks.length) return []
    const pageIdx = {}
    for (const p of (editedPages || [])) {
      pageIdx[p.page] = {
        // Skip injected linear-only blocks: their linear original must keep
        // matching its own geometric (linearKey) target, not this synthetic row
        // (which has no reading_index), so tracking-mode edits still resolve.
        blocks: (p.blocks || []).filter(b => b.boxes?.length && !b.linearInjected)
          .map(b => ({ bbox: unionOfBoxes(b.boxes), reading_index: b.reading_index, role: b.role, continuation: b.continuation })),
        images: (p.images || []).filter(im => im.bbox)
          .map(im => ({ bbox: im.bbox, reading_index: im.reading_index, role: im.role || 'figure' })),
      }
    }
    return linearBlocks.map(L => {
      const p = pageIdx[L.page]
      if (!p || !L.bbox) return null
      const b = p.blocks.find(x => bboxOverlapHigh(x.bbox, L.bbox))
      const im = b ? null : p.images.find(x => bboxOverlapHigh(x.bbox, L.bbox))
      let target
      if (b) target = { kind: 'block', page: L.page, reading_index: b.reading_index, role: b.role, continuation: b.continuation }
      else if (im) target = { kind: 'image', page: L.page, reading_index: im.reading_index, role: im.role }
      // Linear-only block (title/author/section_header/list): no pages.blocks
      // row, so hand the pincel a geometric override target to convert it.
      else target = { kind: 'block', linearKey: paintKey(L.page, L.bbox), page: L.page, bbox: L.bbox, role: L.role }
      const key = editKeyOf(target)
      return { target, membership: mergeMembership[key], selected: selectedKeys.has(key) }
    })
  }, [linearBlocks, editedPages, mergeMembership, selectedKeys])

  // Pincel (promote) affordance for objects the paginated overlay can't reach by
  // an editedPages.blocks row:
  //   - linear-only roles (title/author/section_header/list), AND
  //   - dropped OCR metadata (footnotes, headers/footers, references,
  //     acknowledgments, …) — projectedMetadata.
  // This is what makes the pincel UNIVERSAL: every OCR text object gets a blue
  // box. Objects WITH a pages identity (incl. promoted+injected ones) already
  // get their box from ParagraphOverlay over editedPages, so the bbox-overlap
  // test excludes them here — drawn exactly once. Sourced so hammer-ignored and
  // metadata blocks alike stay paintable.
  const linearOnlyPaintTargets = useMemo(() => {
    if (!paintableBlocks.length && !projectedMetadata.length) return []
    const pageBoxes = {}
    for (const p of (editedPages || [])) {
      pageBoxes[p.page] = [
        ...(p.blocks || []).filter(b => b.boxes?.length).map(b => unionOfBoxes(b.boxes)),
        ...(p.images || []).filter(im => im.bbox).map(im => im.bbox),
      ]
    }
    const out = []
    for (const L of [...paintableBlocks, ...projectedMetadata]) {
      if (!L.bbox) continue
      const boxes = pageBoxes[L.page] || []
      if (boxes.some(bb => bboxOverlapHigh(bb, L.bbox))) continue  // has a pages identity
      out.push({ kind: 'block', linearKey: paintKey(L.page, L.bbox), page: L.page, bbox: L.bbox, role: L.role })
    }
    return out
  }, [paintableBlocks, projectedMetadata, editedPages])

  // Chain payloads — one shared object per continuation chain.
  const chainPayloads = useMemo(
    () => buildContinuationPayloads(linearBlocks),
    [linearBlocks],
  )

  // Navigable list — paragraphs (one entry per continuation chain) + figures/
  // tables, in reading order. Figures carry the opts handleExplain needs.
  const paragraphList = useMemo(() => {
    // Single pass: text → list of paragraph linearBlocks indices sharing that
    // chain. O(n) vs O(n²) nested scan.
    const chainMembers = new Map()
    for (let i = 0; i < linearBlocks.length; i++) {
      if (linearBlocks[i].role !== 'paragraph') continue
      const pay = chainPayloads[i]
      if (!pay) continue
      const list = chainMembers.get(pay.text)
      if (list) list.push(i)
      else chainMembers.set(pay.text, [i])
    }

    const items = []
    const seenTexts = new Set()
    for (let i = 0; i < linearBlocks.length; i++) {
      const b = linearBlocks[i]
      if (b.role === 'paragraph') {
        const pay = chainPayloads[i]
        if (!pay || seenTexts.has(pay.text)) continue
        seenTexts.add(pay.text)
        items.push({
          kind: 'paragraph',
          linearIdx: i,
          linearIdxs: chainMembers.get(pay.text) ?? [i],
          text: pay.text,
          sentences: pay.mergedSentences ?? pay.sentences,
          flat_block_ref: b.flat_block_ref,
        })
      } else if (b.role === 'figure' || b.role === 'table' || b.role === 'algorithm') {
        items.push({
          kind: 'figure',
          linearIdx: i,
          linearIdxs: [i],
          text: b.caption_text || '',
          sentences: [],
          flat_block_ref: b.flat_block_ref ?? null,
          role: b.role,
          page: b.page,
          bbox: b.bbox,
          caption_text: b.caption_text || '',
        })
      }
    }
    return items
  }, [linearBlocks, chainPayloads])


  // Expand AI explanations into one carousel entry per original sentence: real
  // items emitted at their first covered index, placeholders for gaps. Keeps
  // original item shape (quote / sentence_indices / concepts) so highlighting
  // via resolveSentenceIndices keeps working.
  //
  // Claim sentences by RESOLVED indices (Tier 1/2/3 output), not declared
  // sentence_indices. Resolved is what actually lights up yellow when the
  // slot is active; using it here means any sentence covered by a real
  // item's highlight is exclusive to that item, so no two carousel slots
  // ever paint the same sentence yellow.
  const alignExplanations = (aiData, originalSentences) => {
    if (!originalSentences?.length) return aiData
    if (!aiData || !Array.isArray(aiData.sentence_explanations)) return aiData
    const raw = aiData.sentence_explanations
    const N = originalSentences.length

    const resolvedByItem = raw.map(item => {
      const r = resolveSentenceIndices(originalSentences, item)
      return Array.isArray(r) ? r : []
    })

    const sentToItem = new Map()
    resolvedByItem.forEach((idxs, idx) => {
      for (const k of idxs) {
        if (Number.isInteger(k) && k >= 0 && k < N && !sentToItem.has(k)) {
          sentToItem.set(k, idx)
        }
      }
    })

    logSentence('alignExplanations.resolved', {
      perItem: resolvedByItem.map((r, i) => ({
        itemIdx: i,
        declared: raw[i]?.sentence_indices,
        resolved: r,
      })),
      sentenceClaimMap: [...sentToItem.entries()].map(([sentIdx, itemIdx]) => ({ sentIdx, itemIdx })),
    })

    const aligned = []
    const emitted = new Set()
    for (let i = 0; i < N; i++) {
      const itemIdx = sentToItem.get(i)
      if (itemIdx !== undefined) {
        if (emitted.has(itemIdx)) continue
        emitted.add(itemIdx)
        aligned.push(raw[itemIdx])
      } else {
        const placeholderIndices = [i]
        while (i + 1 < N && sentToItem.get(i + 1) === undefined) {
          i++
          placeholderIndices.push(i)
        }
        aligned.push({
          sentence_indices: placeholderIndices,
          quote: placeholderIndices.map(k => originalSentences[k]?.text ?? '').join(' '),
          concepts: [],
          is_placeholder: true,
        })
      }
    }

    // Defensive: keep items whose declared indices were all out of range so the
    // user still sees what the LLM produced even if it mislabeled.
    raw.forEach((item, idx) => {
      if (emitted.has(idx)) return
      const idxs = Array.isArray(item?.sentence_indices) ? item.sentence_indices : []
      const hasValid = idxs.some(k => Number.isInteger(k) && k >= 0 && k < N)
      if (!hasValid) aligned.push(item)
    })

    return { ...aiData, sentence_explanations: aligned }
  }

  // One placeholder per sentence so highlights + carousel slots show
  // immediately, before the AI fetch resolves. Marked with __skeleton so the
  // tab-auto-switch effect and index re-anchor logic can tell it apart from a
  // real response.
  const buildSkeletonExplanation = (sentences) => {
    if (!sentences?.length) return null
    return {
      __skeleton: true,
      sentence_explanations: sentences.map((s, i) => ({
        sentence_indices: [i],
        quote: s?.text ?? '',
        concepts: [],
        is_placeholder: true,
      })),
      paragraph_context: null,
    }
  }

  const handleExplain = useCallback(async (text, sentences, flatBlockRef = null, opts = {}) => {
    if (!analysis) return
    setIsSidebarOpen(true)  // explaining always reveals the panel
    const { initialIndex = 0, role, page, bbox, caption_text, footnotes = [] } = opts
    const isFigure = role === 'figure' || role === 'table' || role === 'algorithm'
    // Explanation language chosen at upload (persisted in the analysis). Drives
    // the Gemini output language; independent of the UI language. Older
    // analyses without the field fall back to Spanish.
    const explainLang = analysis.language || 'es'

    // Stamp this call so an earlier in-flight fetch can't overwrite a later
    // user action (e.g. retry-throttled A resolving after the user clicked B).
    const myReqId = ++explainRequestId.current
    const isCurrent = () => myReqId === explainRequestId.current

    setActiveParagraph({ text, flatBlockRef, role, page, bbox })
    setCurrentIndex(initialIndex === 'last' ? 0 : initialIndex)
    setErrorExplain(null)
    setRetryInfo(null)

    logSentence('handleExplain.input', {
      flatBlockRef,
      role,
      page,
      isFigure,
      sentenceCount: sentences?.length ?? 0,
      sentences: (sentences ?? []).map((s, i) => ({
        idx: i,
        boxes: s?.boxes?.length ?? 0,
        text: (s?.text ?? '').slice(0, 100),
      })),
      paragraphText: (text ?? '').slice(0, 200),
    })

    const cacheOpts = { role, page, bbox, language: explainLang }
    const cached = readCachedExplanation(decoded, text, explanationsCache.current, cacheOpts)
    if (cached) {
      logSentence('handleExplain.cacheHit', {
        rawItems: (cached.sentence_explanations ?? []).map((it, i) => ({
          itemIdx: i,
          sentence_indices: it?.sentence_indices,
          quote: (it?.quote ?? '').slice(0, 100),
        })),
      })
      const alignedCached = alignExplanations(cached, sentences)
      logSentence('handleExplain.aligned', {
        source: 'cache',
        alignedItems: (alignedCached.sentence_explanations ?? []).map((it, i) => ({
          slot: i,
          sentence_indices: it?.sentence_indices,
          placeholder: !!it?.is_placeholder,
          quote: (it?.quote ?? '').slice(0, 100),
        })),
      })
      setExplanation(alignedCached)
      if (initialIndex === 'last') {
        setCurrentIndex(Math.max(0, (alignedCached.sentence_explanations?.length || 1) - 1))
      }
      return
    }

    // Paragraphs: seed carousel with skeleton so highlights + slots render
    // pre-fetch. Figures have no sentence geometry → fall back to clearing.
    if (!isFigure && sentences?.length) {
      setExplanation(buildSkeletonExplanation(sentences))
      if (initialIndex === 'last') {
        setCurrentIndex(Math.max(0, sentences.length - 1))
      }
    } else {
      setExplanation(null)
    }

    setLoadingExplain(true)
    try {
      const payload = isFigure
        ? {
            paragraph_sentences: [],
            global_map: analysis.global_map,
            block_type: role,
            filename: decoded,
            page,
            bbox,
            caption_text: caption_text || '',
            language: explainLang,
          }
        : {
            paragraph_sentences: (sentences ?? []).map(s => s.text),
            global_map: analysis.global_map,
            footnotes: footnotes ?? [],
            language: explainLang,
          }
      const data = await postExplainWithRetry(
        payload,
        (attempt, maxAttempts, delayMs) => {
          if (isCurrent()) setRetryInfo({ attempt, maxAttempts, delayMs })
        },
      )

      // Cache raw response unconditionally (it's still valid for this text);
      // only commit to UI state when this call is still the latest.
      writeCachedExplanation(decoded, text, data, explanationsCache.current, cacheOpts)
      if (!isCurrent()) return

      logSentence('handleExplain.llmResponse', {
        rawItems: (data?.sentence_explanations ?? []).map((it, i) => ({
          itemIdx: i,
          sentence_indices: it?.sentence_indices,
          quote: (it?.quote ?? '').slice(0, 100),
          concepts: (it?.concepts ?? []).length,
        })),
      })

      const alignedData = alignExplanations(data, sentences)

      logSentence('handleExplain.aligned', {
        source: 'fresh',
        alignedItems: (alignedData.sentence_explanations ?? []).map((it, i) => ({
          slot: i,
          sentence_indices: it?.sentence_indices,
          placeholder: !!it?.is_placeholder,
          quote: (it?.quote ?? '').slice(0, 100),
        })),
      })

      // Re-anchor currentIndex: if the user was on a skeleton slot for sentence
      // S, jump to the aligned item that covers S — keeps cursor on the same
      // sentence even when grouping shifts other slots around it.
      const prevExp = explanationRef.current
      const prevIdx = currentIndexRef.current
      let nextIdx = (initialIndex === 'last')
        ? Math.max(0, (alignedData.sentence_explanations?.length || 1) - 1)
        : initialIndex
      if (prevExp?.__skeleton && !isFigure
          && Array.isArray(prevExp.sentence_explanations)
          && Array.isArray(alignedData.sentence_explanations)) {
        const prevItem = prevExp.sentence_explanations[prevIdx]
        const prevSentenceIdx = prevItem?.sentence_indices?.[0]
        if (Number.isInteger(prevSentenceIdx)) {
          const found = alignedData.sentence_explanations.findIndex(it =>
            Array.isArray(it?.sentence_indices) && it.sentence_indices.includes(prevSentenceIdx),
          )
          if (found >= 0) nextIdx = found
        }
      }

      setExplanation(alignedData)
      setCurrentIndex(nextIdx)

    } catch (err) {
      if (isCurrent()) {
        setErrorExplain(buildExplainError(err, t))
        setExplanation(null)
      }
    } finally {
      if (isCurrent()) {
        setLoadingExplain(false)
        setRetryInfo(null)
      }
    }
  }, [analysis, decoded, t])

  const handleHome = useCallback(() => navigate('/'), [navigate])

  // Explain a lazo merge group as the ONE consolidated block it represents,
  // following the group's resolved hierarchy (resultRole) — the same outcome
  // the automatic merge state machine would produce. Reuses the existing
  // explain flows unchanged: a visual result (figure/table/algorithm) rasters
  // the recomputed union bbox of EVERY member with the combined captions;
  // otherwise the paragraph members are concatenated and footnote-role members
  // feed the footnotes channel (the symbol-footnote path).
  const explainGroup = useCallback((groupId) => {
    const g = (edits.mergeGroups || []).find(x => x.id === groupId)
    if (!g || !editedPages) return
    const resolved = g.members.map(m => {
      const p = editedPages.find(pg => pg.page === m.page)
      if (!p) return null
      if (m.kind === 'image') {
        const img = (p.images || []).find(im => im.reading_index === m.reading_index)
        return img ? { kind: 'image', page: m.page, ...img } : null
      }
      const b = (p.blocks || []).find(bl =>
        m.linearKey ? bl.linearKey === m.linearKey : bl.reading_index === m.reading_index)
      return b ? { kind: 'block', page: m.page, ...b } : null
    }).filter(Boolean)
    if (!resolved.length) return

    // Back-compat: groups persisted before resultRole carried `explainAs`.
    const resultRole = g.resultRole || (g.explainAs === 'figure' ? 'figure' : 'paragraph')

    // Recompute the consolidated bbox across ALL members (images + text).
    const memberBox = (r) => r.kind === 'image' ? r.bbox : (r.boxes?.length ? unionOfBoxes(r.boxes) : null)
    const boxes = resolved.map(memberBox).filter(Boolean)
    const bbox = boxes.length
      ? boxes.reduce((a, b) => ({
          x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
        }), { ...boxes[0] })
      : null

    if (MERGE_VISUAL_ROLES.includes(resultRole)) {
      const caption_text = resolved
        .map(r => r.kind === 'image' ? (r.caption_text || '') : (r.text || ''))
        .filter(Boolean)
        .join('\n')
      const page = (resolved.find(r => r.kind === 'image') || resolved[0]).page
      handleExplain(caption_text, [], null, { role: resultRole, page, bbox, caption_text })
      return
    }

    const footnoteTexts = []
    const textParts = []
    let sentences = []
    for (const r of resolved) {
      if (r.role === 'footnote') { if (r.text) footnoteTexts.push(r.text); continue }
      if (r.text) textParts.push(r.text)
      if (Array.isArray(r.sentences) && r.sentences.length) sentences = sentences.concat(r.sentences)
    }
    handleExplain(textParts.join('\n\n'), sentences, null, { footnotes: footnoteTexts })
  }, [edits, editedPages, handleExplain])

  // ── Lupa: forced concept extraction from the selected fragment ──────────────
  const onSearchSelect = useCallback((sel) => setSearchSel(sel), [])

  // Clear just the in-progress selection (overlay resets via the bumped key);
  // the tool stays armed so the user can select again.
  const clearSearchSelection = useCallback(() => {
    setSearchSel(null)
    setSearchResetKey(k => k + 1)
  }, [])

  // Cancel = unconditional full reset: drop the selection AND exit the tool.
  const cancelSearch = useCallback(() => {
    clearSearchSelection()
    disarm()
  }, [clearSearchSelection, disarm])

  // Send the highlighted fragment to /extract-concept and inject the returned
  // concept(s) into the active paragraph's explanation immutably (appended as a
  // new item so previous concepts are preserved).
  const confirmSearch = useCallback(async () => {
    const sel = searchSel
    if (!sel?.text || !analysis || searchBusy) return
    setSearchBusy(true)
    let extracted = false
    try {
      const { data } = await axios.post('/api/extract-concept/', {
        selected_text: sel.text,
        paragraph_sentences: sel.paragraphSentences || [],
        global_map: analysis.global_map,
        language: analysis.language || 'es',
      })
      const concepts = Array.isArray(data?.concepts) ? data.concepts : []
      if (concepts.length) {
        extracted = true
        setIsSidebarOpen(true)
        setTab('explain')
        const item = { sentence_indices: [], quote: sel.text, concepts, forced: true }
        setExplanation(prev => {
          const base = (prev && Array.isArray(prev.sentence_explanations))
            ? prev
            : { sentence_explanations: [], paragraph_context: { section_role: '', narrative: '' } }
          return { ...base, sentence_explanations: [...base.sentence_explanations, item] }
        })
      }
    } catch { /* surfaced as no-op; the selection is cleared regardless */ }
    finally {
      setSearchBusy(false)
      clearSearchSelection()
      // Effective extraction → auto-disarm. A failed/empty search keeps the tool
      // armed so the user can retry without re-selecting it.
      if (extracted) disarm()
    }
  }, [searchSel, analysis, searchBusy, clearSearchSelection, disarm])

  // Keyboard navigation: m = global, , = explain-contexto, . = explain-conceptos, arrows to navigate explanations
  useEffect(() => {
    function onKey(e) {
      if (settingsOpenRef.current) return  // settings modal owns the keyboard
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return

      const items = explanation?.sentence_explanations ?? []

      const dispatch = (entry, initialIndex = 0) => {
        if (!entry) return
        if (entry.kind === 'figure') {
          handleExplain(entry.text, [], entry.flat_block_ref, {
            initialIndex,
            role: entry.role,
            page: entry.page,
            bbox: entry.bbox,
            caption_text: entry.caption_text,
          })
        } else {
          handleExplain(entry.text, entry.sentences, entry.flat_block_ref, { initialIndex })
        }
        if (entry.linearIdx != null) {
          // 'last' lands on the trailing sentence — usually in the last chain
          // member, not the head. Aim the scroll there so the cursor's
          // sentence is the part centered, not the chain start on a prior page.
          const targetIdx = (initialIndex === 'last' && Array.isArray(entry.linearIdxs) && entry.linearIdxs.length)
            ? entry.linearIdxs[entry.linearIdxs.length - 1]
            : entry.linearIdx
          viewerRef.current?.centerBlock(targetIdx, {
            onlyIfHidden: true,
            alternatives: entry.linearIdxs,
          })
        }
      }

      const matchActive = (entry) => {
        if (!entry || !activeParagraph) return false
        if (entry.kind === 'paragraph') return entry.text === activeParagraph.text
        return entry.kind === 'figure'
          && activeParagraph.role === entry.role
          && activeParagraph.page === entry.page
          && activeParagraph.bbox?.x0 === entry.bbox?.x0
          && activeParagraph.bbox?.y0 === entry.bbox?.y0
      }

      // Resolve the linearBlocks index + sentence boxes for the first
      // highlighted sentence of an item. For chain paragraphs we pick the
      // chain member covering the smallest merged sentence index — i.e. the
      // earlier reading-order fragment when a sentence is split across blocks.
      const sentenceTargetForItem = (item) => {
        if (!activeParagraph) return null
        if (activeParagraph.role === 'figure' || activeParagraph.role === 'table' || activeParagraph.role === 'algorithm') {
          for (let i = 0; i < linearBlocks.length; i++) {
            const b = linearBlocks[i]
            if (b.role === activeParagraph.role
                && b.page === activeParagraph.page
                && b.bbox?.x0 === activeParagraph.bbox?.x0
                && b.bbox?.y0 === activeParagraph.bbox?.y0) {
              return { idx: i, boxes: null, isFigure: true }
            }
          }
          return null
        }
        const text = activeParagraph.text
        if (!text) return null
        const members = []
        for (let i = 0; i < linearBlocks.length; i++) {
          if (linearBlocks[i].role !== 'paragraph') continue
          const pay = chainPayloads[i]
          if (!pay || pay.text !== text) continue
          members.push({
            idx: i,
            offset: pay.offset ?? 0,
            length: linearBlocks[i].sentences?.length ?? 0,
          })
        }
        if (members.length === 0) return null
        if (!item) return { idx: members[0].idx, boxes: null, isFigure: false }
        const payload = chainPayloads[members[0].idx]
        const indices = resolveSentenceIndices(payload.sentences, item)
        if (!indices.length) return { idx: members[0].idx, boxes: null, isFigure: false }
        const minK = Math.min(...indices)
        const member = members.find(m => minK >= m.offset && minK < m.offset + m.length)
        if (!member) return { idx: members[0].idx, boxes: null, isFigure: false }
        const localIdx = minK - member.offset
        const block = linearBlocks[member.idx]
        const boxes = block.sentences?.[localIdx]?.boxes ?? []
        return { idx: member.idx, boxes, isFigure: false }
      }

      const centerForItem = (item, onlyIfNotFullyVisible) => {
        const target = sentenceTargetForItem(item)
        if (!target) return
        if (target.isFigure || !target.boxes?.length) {
          viewerRef.current?.centerBlock(target.idx, { onlyIfHidden: onlyIfNotFullyVisible })
        } else {
          viewerRef.current?.centerSentence(target.idx, target.boxes, { onlyIfNotFullyVisible })
        }
      }

      // Navigate concepts — shared by the configurable conceptPrev/Next keys
      // and the fixed arrow keys. dir = +1 next, -1 previous.
      const navConcept = (dir) => {
        if (!activeParagraph) {
          if (paragraphList[0]) dispatch(paragraphList[0], 0)
          return
        }
        if (dir > 0) {
          if (currentIndex < items.length - 1) {
            const nextIdx = currentIndex + 1
            setCurrentIndex(nextIdx)
            centerForItem(items[nextIdx], true)
          } else {
            const curIdx = paragraphList.findIndex(matchActive)
            dispatch(paragraphList[curIdx + 1], 0)
          }
        } else {
          if (currentIndex > 0) {
            const nextIdx = currentIndex - 1
            setCurrentIndex(nextIdx)
            centerForItem(items[nextIdx], true)
          } else {
            const curIdx = paragraphList.findIndex(matchActive)
            dispatch(paragraphList[curIdx - 1], 'last')
          }
        }
      }

      // ── Configurable shortcut actions ────────────────────────────────────
      // Keys come from SettingsContext (active hand) — never hard-coded
      // letters. scrollUp/scrollDown are owned by the continuous-scroll effect.
      const k = (e.key === ' ' || e.code === 'Space') ? ' '
              : (typeof e.key === 'string' && e.key.length === 1) ? e.key.toLowerCase()
              : null
      const action = k ? keyToAction[k] : null

      if (action === 'centerHighlight') {
        // Center the current highlight only — always swallow so it never falls
        // through to the browser's native page-scroll.
        e.preventDefault()
        const cur = items[currentIndex]
        if (cur && activeParagraph) centerForItem(cur, false)
        return
      }
      if (action === 'focusToggle') {
        e.preventDefault()
        setFocusArea(f => (f === 'canvas' ? 'sidebar' : 'canvas'))
        return
      }
      if (action === 'explainTab') {
        e.preventDefault()
        setIsSidebarOpen(true)
        isSidebarOpenRef.current = true
        const nextMode = uiStateRef.current.explainMode === 'contexto' ? 'conceptos' : 'contexto'
        setTab('explain')
        setExplainMode(nextMode)
        uiStateRef.current = { tab: 'explain', explainMode: nextMode }
        return
      }
      if (action === 'globalTab') {
        e.preventDefault()
        setIsSidebarOpen(true)
        isSidebarOpenRef.current = true
        setTab('global')
        uiStateRef.current = { ...uiStateRef.current, tab: 'global' }
        return
      }
      if (action === 'toggleSidebar') {
        e.preventDefault()
        const next = !isSidebarOpenRef.current
        isSidebarOpenRef.current = next
        setIsSidebarOpen(next)
        if (!next && focusAreaRef.current === 'sidebar') {
          focusAreaRef.current = 'canvas'
          setFocusArea('canvas')
        }
        return
      }
      if (action === 'conceptNext') { e.preventDefault(); navConcept(1); return }
      if (action === 'conceptPrev') { e.preventDefault(); navConcept(-1); return }
      // Tracking toggle lives in PdfViewer (local state); reach it imperatively.
      if (action === 'trackingToggle') { e.preventDefault(); viewerRef.current?.toggleTracking?.(); return }
      // Index dropdown also lives in PdfViewer; toggle it imperatively.
      if (action === 'index') { e.preventDefault(); viewerRef.current?.toggleIndex?.(); return }
      if (action === 'themeToggle') { e.preventDefault(); cycleTheme(); return }
      if (action === 'home') { e.preventDefault(); navigate('/'); return }
      if (action === 'settings') { e.preventDefault(); openSettings(); return }
      // Edit toolbar shortcuts. undo/redo step the edit history; the three tools
      // arm a click-mode (toggling off if already armed).
      if (action === 'undo') { e.preventDefault(); undo(); return }
      if (action === 'redo') { e.preventDefault(); redo(); return }
      if (action === 'demoteBlock')  { e.preventDefault(); armTool('demote');  return }
      if (action === 'promoteBlock') { e.preventDefault(); armTool('promote'); return }
      if (action === 'mergeBlocks')  { e.preventDefault(); armTool('merge');   return }
      if (action === 'splitMerge')   { e.preventDefault(); armTool('split');   return }
      if (action === 'searchConcept'){ e.preventDefault(); armTool('search');  return }

      // Shared Accept (Enter) / Cancel (Delete) for interactive selection tools.
      // Lazo: Enter commits the buffered merge, Delete clears the selection.
      // (The search/lupa selection wires its own confirm/cancel here too.)
      if (armedTool === 'merge') {
        if (e.key === 'Enter') { e.preventDefault(); confirmMerge(); return }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearMergeBuffer(); return }
      }
      if (armedTool === 'search') {
        if (e.key === 'Enter') { e.preventDefault(); confirmSearch(); return }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); cancelSearch(); return }
      }

      if (e.key === '<') {
        e.preventDefault()
        setIsSidebarOpen(true)  // a closed panel opens onto the explanation
        const currentTab = uiStateRef.current.tab
        const currentMode = uiStateRef.current.explainMode

        if (!activeParagraph && paragraphList[0]) {
          dispatch(paragraphList[0], 0)
          setTab('explain')
          setExplainMode('contexto')
          uiStateRef.current = { tab: 'explain', explainMode: 'contexto' }
          return
        }

        if (currentTab === 'global') {
          setTab('explain')
          setExplainMode('contexto')
          uiStateRef.current = { tab: 'explain', explainMode: 'contexto' }
        } else if (currentTab === 'explain') {
          const nextMode = currentMode === 'contexto' ? 'conceptos' : 'contexto'
          setExplainMode(nextMode)
          uiStateRef.current = { tab: 'explain', explainMode: nextMode }
        }
        return
      }

      if (e.key === '-') {
        setIsSidebarOpen(true)  // a closed panel opens onto the global map
        setTab('global')
        uiStateRef.current = { ...uiStateRef.current, tab: 'global' }
        return
      }
      if (e.key === ',') {
        setIsSidebarOpen(true)
        setTab('explain')
        setExplainMode('contexto')
        uiStateRef.current = { tab: 'explain', explainMode: 'contexto' }
        return
      }
      if (e.key === '.') {
        e.preventDefault()
        setIsSidebarOpen(o => !o)  // toggle the right panel
        return
      }
      // Fixed arrow keys always mirror conceptPrev/Next, regardless of the
      // configured letter keys.
      if (e.key === 'ArrowRight') { e.preventDefault(); navConcept(1); return }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); navConcept(-1); return }
    }

    // Capture phase so focused Sidebar buttons don't swallow Space (their
    // bubble-phase activation runs after our handler in capture).
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [explanation, currentIndex, activeParagraph, paragraphList, handleExplain, linearBlocks, chainPayloads, keyToAction, navigate, openSettings, cycleTheme, armTool, undo, redo, armedTool, confirmMerge, clearMergeBuffer, confirmSearch, cancelSearch])

  // ── Continuous scroll (W / S) ────────────────────────────────────────────
  // Behaviour depends on focusArea (read through a ref so this binds ONCE and
  // the rAF loop is never torn down by re-renders):
  //   • sidebar → native vertical scrollBy inside the panel.
  //   • canvas  → hold-to-scroll loop at a constant speed. A quick
  //     release+repress of the same key (<300ms) locks 2× speed until keyup.
  // The rAF is cancelled on keyup and on unmount.
  useEffect(() => {
    const NORMAL = 9              // px/frame (~540px/s @60fps)
    const FAST   = NORMAL * 2     // exactly double on double-tap-and-hold
    const DOUBLE_TAP_MS = 300
    const SIDEBAR_STEP  = 64

    let rafId = null
    let dir = 0                       // -1 up | +1 down | 0 idle
    let speed = NORMAL
    let activeKey = null              // 'up' | 'down' currently driving the loop
    const lastUp = { up: 0, down: 0 } // last keyup time per key → double-tap window

    const loop = () => {
      const el = viewerRef.current?.getScrollContainer?.()
      if (el && dir !== 0) el.scrollTop += dir * speed
      rafId = requestAnimationFrame(loop)
    }
    const start = () => { if (rafId == null) rafId = requestAnimationFrame(loop) }
    const stop  = () => { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null } }

    // Resolve the event against the user's configured scroll keys (read live
    // through a ref so remapping in settings takes effect without rebinding).
    const dirOf = (e) => {
      const k = (e.key === ' ' || e.code === 'Space') ? ' '
              : (typeof e.key === 'string' && e.key.length === 1) ? e.key.toLowerCase()
              : null
      if (!k) return null
      const { up, down } = scrollKeysRef.current
      if (up && k === up) return 'up'
      if (down && k === down) return 'down'
      return null
    }

    const onKeyDown = (e) => {
      if (settingsOpenRef.current) return
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const which = dirOf(e)
      if (!which) return
      e.preventDefault()

      if (focusAreaRef.current === 'sidebar') {
        const el = sidebarScrollRef.current
        if (el) el.scrollBy({ top: which === 'down' ? SIDEBAR_STEP : -SIDEBAR_STEP, behavior: 'smooth' })
        return
      }

      // Canvas: ignore OS auto-repeat (the rAF loop drives the hold).
      if (e.repeat) return
      const fast = performance.now() - lastUp[which] < DOUBLE_TAP_MS
      dir = which === 'down' ? 1 : -1
      speed = fast ? FAST : NORMAL
      activeKey = which
      start()
    }

    const onKeyUp = (e) => {
      const which = dirOf(e)
      if (!which) return
      lastUp[which] = performance.now()   // arm the double-tap window
      if (which === activeKey) {
        dir = 0
        activeKey = null
        stop()                            // clean up the rAF on release
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      stop()
    }
  }, [])

  const currentExplanation = explanation?.sentence_explanations?.[currentIndex] ?? null

  if (loadingAnalysis) {
    return (
      <div className="h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
          <p className="text-sm text-slate-500">{t('reader.loadingDoc')}</p>
        </div>
      </div>
    )
  }

  if (errorAnalysis) {
    return (
      <div className="h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-500 mb-4">{t('reader.analysisNotFound')}</p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors"
          >
            {t('common.backHome')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex h-screen overflow-hidden bg-white ${panelSide === 'left' ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`relative min-w-0 flex-1 overflow-hidden transition-shadow duration-200 ${
          focusArea === 'canvas' ? 'ring-2 ring-inset ring-indigo-400/60' : ''
        }`}
      >
        <PdfViewer
          ref={viewerRef}
          file={pdfUrl}
          onExplain={handleExplain}
          pages={editedPages}
          linearBlocks={linearBlocks}
          activeParagraph={activeParagraph}
          currentExplanation={currentExplanation}
          explanation={explanation}
          onHome={handleHome}
          onBlockEdit={onBlockEdit}
          mergeSelectedKeys={selectedKeys}
          mergeMembership={mergeMembership}
          onExplainGroup={explainGroup}
          linearEditInfo={linearEditInfo}
          paintBlocks={linearOnlyPaintTargets}
          onSearchSelect={onSearchSelect}
          searchResetKey={searchResetKey}
        />
        {/* Toggle the right panel (global map / explanation). Icon flips to the
            opposite chevron when the panel is hidden. Also bound to "." */}
        {visibility.hidePanel && (
          <button
            onClick={() => setIsSidebarOpen(o => !o)}
            title={isSidebarOpen ? t('viewer.hidePanel') : t('viewer.showPanel')}
            aria-label={isSidebarOpen ? t('viewer.hidePanel') : t('viewer.showPanel')}
            className="absolute bottom-4 right-4 z-30 w-9 h-9 flex items-center justify-center rounded-xl bg-white/95 backdrop-blur shadow-md border border-slate-200 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
              {isSidebarOpen
                ? <polyline points="7 9 10 12 7 15" />
                : <polyline points="10 9 7 12 10 15" />}
            </svg>
          </button>
        )}
      </div>

      {/* Sidebar wrapper animates its width to 0 (100% to the canvas) when
          closed. The inner panel keeps a fixed width so it slides under the
          clip rather than reflowing. Ring marks it as the active focus area. */}
      <div
        className={`relative shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out ${
          isSidebarOpen ? (panelSide === 'left' ? 'border-r border-slate-200' : 'border-l border-slate-200') : ''
        }`}
        style={{ width: isSidebarOpen ? sidebarWidth : 0 }}
      >
        {/* Focus ring painted as a separate overlay so it sits ABOVE the panel
            content. As an inset ring on the wrapper it would render under the
            child backgrounds (concept explanations), which hid it. */}
        {focusArea === 'sidebar' && (
          <div className="pointer-events-none absolute inset-0 z-50 ring-2 ring-inset ring-indigo-400/60" />
        )}
        <div className="h-full min-w-0" style={{ width: sidebarWidth }}>
          <Sidebar
            ref={sidebarScrollRef}
            globalMap={analysis?.global_map}
            explanation={explanation}
            loadingGlobal={false}
            loadingExplain={loadingExplain}
            errorGlobal={null}
            errorExplain={errorExplain}
            currentIndex={currentIndex}
            onIndexChange={setCurrentIndex}
            retryInfo={retryInfo}
            tab={tab}
            onTabChange={setTab}
            explainMode={explainMode}
            onExplainModeChange={setExplainMode}
          />
        </div>
      </div>

      {/* Pincel block-type picker — floats at the click point. */}
      {promotePicker && (
        <TypePicker
          x={promotePicker.x}
          y={promotePicker.y}
          t={t}
          onClose={() => setPromotePicker(null)}
          onPick={(role) => { setOverride(promotePicker.target, { role }); setPromotePicker(null); disarm() }}
        />
      )}

      {/* Lazo confirm/cancel bar — appears while selecting objects to merge. */}
      {armedTool === 'merge' && mergeBuffer.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-white/95 backdrop-blur rounded-xl shadow-lg border border-slate-200 px-4 py-2 select-none">
          <span className="text-[13px] text-slate-600">{t('viewer.toolMergeHint')} · {mergeBuffer.length}</span>
          <button
            type="button"
            onClick={confirmMerge}
            disabled={mergeBuffer.length < 2}
            className="px-3 h-8 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            {t('viewer.toolConfirm')}
          </button>
          <button
            type="button"
            onClick={clearMergeBuffer}
            className="px-3 h-8 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
          >
            {t('viewer.toolCancel')}
          </button>
        </div>
      )}

      {/* Lupa accept/cancel bar — same layout as the lazo bar. */}
      {armedTool === 'search' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-white/95 backdrop-blur rounded-xl shadow-lg border border-slate-200 px-4 py-2 select-none">
          <span className="text-[13px] text-slate-600">
            {searchBusy ? t('viewer.searchExtracting') : t('viewer.searchHint')}
          </span>
          <button
            type="button"
            onClick={confirmSearch}
            disabled={!searchSel?.text || searchBusy}
            className="px-3 h-8 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            {t('viewer.toolConfirm')}
          </button>
          <button
            type="button"
            onClick={cancelSearch}
            className="px-3 h-8 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
          >
            {t('viewer.toolCancel')}
          </button>
        </div>
      )}
    </div>
  )
}
