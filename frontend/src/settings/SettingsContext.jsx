/* eslint-disable react-refresh/only-export-components -- the useSettings hook and
   the shared constants are intentionally co-located with the provider; this only
   affects HMR fast-refresh. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'deepstudy:settings'

// Configurable keyboard actions, in display order. Labels are resolved per
// UI-language inside SettingsModal — the action ids here are the stable keys
// every consumer (Reader keymap, settings UI) maps against.
export const ACTIONS = [
  'focusToggle',
  'scrollUp',
  'scrollDown',
  'conceptPrev',
  'conceptNext',
  'centerHighlight',
  'explainTab',
  'globalTab',
  'toggleSidebar',
  'trackingToggle',
  'themeToggle',
  'home',
  'settings',
]

// Actions whose on-screen button can be hidden (see VISIBILITY_ITEMS), so the
// keyboard shortcut is the only remaining way to reach them — it may never be
// left empty. The Shortcuts editor hard-blocks Confirm if any of these is unset.
export const REQUIRED_ACTIONS = ['trackingToggle', 'themeToggle', 'home', 'settings']

// Two presets. 'right' = right-handed: left hand drives the Q/W/A/S/D cluster
// while the right hand holds the mouse. 'left' = mirrored onto the I/J/K/L
// cluster on the right side of the keyboard for a left-hand mouse grip. Space
// (center highlight) is shared by both.
// The digit row is hand-agnostic and shared by both presets: home 1, settings 2,
// trackingToggle 3, toggleSidebar 4, themeToggle 5.
export const DEFAULT_SHORTCUTS = {
  right: {
    focusToggle: 'q', scrollUp: 'w', scrollDown: 's',
    conceptPrev: 'a', conceptNext: 'd', centerHighlight: ' ',
    explainTab: 'e', globalTab: 'r', toggleSidebar: '4',
    trackingToggle: '3', themeToggle: '5', home: '1', settings: '2',
  },
  left: {
    focusToggle: 'o', scrollUp: 'i', scrollDown: 'k',
    conceptPrev: 'j', conceptNext: 'l', centerHighlight: ' ',
    explainTab: 'u', globalTab: 'p', toggleSidebar: '4',
    trackingToggle: '3', themeToggle: '5', home: '1', settings: '2',
  },
}

// On-screen elements that can be individually shown/hidden. Hiding 'home' or
// 'settings' leaves their keyboard shortcut as the only entry point, so the
// SettingsModal surfaces those bindings in an info popup when toggled off.
export const VISIBILITY_ITEMS = ['tracking', 'viewType', 'theme', 'hidePanel', 'zoom', 'conceptScroll', 'home', 'settings']

// Panel (global map + explanation) width as a percentage of the viewport.
// Slider-controlled in settings; clamped so the panel stays usable without
// dominating the reading canvas.
export const PANEL_WIDTH_MIN = 20
export const PANEL_WIDTH_MAX = 60
export const PANEL_WIDTH_DEFAULT = 30

export const DEFAULT_SETTINGS = {
  shortcuts: DEFAULT_SHORTCUTS,
  handMode: 'right',          // 'right' | 'left'
  panelSide: 'right',         // sidebar on the 'right' | 'left'
  panelWidthPct: PANEL_WIDTH_DEFAULT,   // panel width as % of viewport width
  visibility: { tracking: true, viewType: true, theme: true, hidePanel: true, zoom: true, conceptScroll: true, home: true, settings: true },
}

const SettingsCtx = createContext(null)

const clone = (o) => JSON.parse(JSON.stringify(o))

const clampPanelWidth = (v) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return PANEL_WIDTH_DEFAULT
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, n))
}

// Merge a persisted blob over the defaults so newly added fields/keys always
// have a value, even when an older settings object is in localStorage.
function mergeWithDefaults(saved) {
  if (!saved || typeof saved !== 'object') return clone(DEFAULT_SETTINGS)
  return {
    handMode:  saved.handMode  === 'left' ? 'left' : 'right',
    panelSide: saved.panelSide === 'left' ? 'left' : 'right',
    panelWidthPct: clampPanelWidth(saved.panelWidthPct),
    visibility: { ...DEFAULT_SETTINGS.visibility, ...(saved.visibility || {}) },
    shortcuts: {
      right: { ...DEFAULT_SHORTCUTS.right, ...((saved.shortcuts || {}).right || {}) },
      left:  { ...DEFAULT_SHORTCUTS.left,  ...((saved.shortcuts || {}).left  || {}) },
    },
  }
}

function detectInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return mergeWithDefaults(JSON.parse(raw))
  } catch { /* localStorage unavailable */ }
  return clone(DEFAULT_SETTINGS)
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(detectInitial)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* ignore */ }
  }, [settings])

  const setHandMode = useCallback((hand) => {
    setSettings(s => ({ ...s, handMode: hand === 'left' ? 'left' : 'right' }))
  }, [])

  const setPanelSide = useCallback((side) => {
    setSettings(s => ({ ...s, panelSide: side === 'left' ? 'left' : 'right' }))
  }, [])

  const setPanelWidthPct = useCallback((pct) => {
    setSettings(s => ({ ...s, panelWidthPct: clampPanelWidth(pct) }))
  }, [])

  const setVisibility = useCallback((key, value) => {
    setSettings(s => ({ ...s, visibility: { ...s.visibility, [key]: !!value } }))
  }, [])

  // Commit an edited shortcut map for ONE hand (called by the Shortcuts
  // section's Confirm / Reset). The other hand is left untouched.
  const commitShortcuts = useCallback((hand, map) => {
    setSettings(s => ({ ...s, shortcuts: { ...s.shortcuts, [hand]: { ...map } } }))
  }, [])

  const openSettings  = useCallback(() => setIsOpen(true), [])
  const closeSettings = useCallback(() => setIsOpen(false), [])

  const value = useMemo(() => ({
    settings,
    setHandMode, setPanelSide, setPanelWidthPct, setVisibility, commitShortcuts,
    isOpen, openSettings, closeSettings,
  }), [settings, setHandMode, setPanelSide, setPanelWidthPct, setVisibility, commitShortcuts, isOpen, openSettings, closeSettings])

  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>
}

export function useSettings() {
  const ctx = useContext(SettingsCtx)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}
