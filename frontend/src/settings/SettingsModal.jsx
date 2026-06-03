import { useEffect, useState } from 'react'
import { useUiLang } from '../i18n/LanguageContext'
import { ACTIONS, DEFAULT_SHORTCUTS, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, REQUIRED_ACTIONS, VISIBILITY_ITEMS, useSettings } from './SettingsContext'

// ── Localized labels ─────────────────────────────────────────────────────────
// Self-contained so the feature ships without touching the global translations
// catalog. zh-Hant falls back to English.
const L = {
  es: {
    title: 'Configuración', shortcuts: 'Atajos de teclado', display: 'Pantalla y Layout',
    right: 'Mano derecha', left: 'Mano izquierda', action: 'Acción',
    onlyActive: 'Solo se edita la mano seleccionada; la contraria queda deshabilitada.',
    reset: 'Restablecer por defecto', confirm: 'Confirmar cambios',
    emptyTitle: 'Campos vacíos', back: 'Regresar a editar', confirmAnyway: 'Confirmar de todos modos',
    emptyBody: 'Hay atajos sin asignar. Esas acciones se quedarán sin tecla. ¿Confirmar de todos modos?',
    requiredTitle: 'Campos obligatorios', ok: 'Entendido',
    requiredBody: 'No es posible dejar estos campos vacíos:',
    hiddenTitle: 'Botón oculto', hiddenBody: 'Aún puedes usar estas acciones con el teclado:',
    visibility: 'Visibilidad de la interfaz', layout: 'Posición de los paneles',
    panelWidth: 'Ancho del panel (% de pantalla)',
    panelRight: 'Derecha', panelLeft: 'Izquierda', close: 'Cerrar', space: 'Espacio', unset: 'Vacío',
    actions: {
      focusToggle: 'Cambiar foco (Canvas/Panel)', scrollUp: 'Scroll arriba', scrollDown: 'Scroll abajo',
      conceptPrev: 'Concepto anterior', conceptNext: 'Concepto siguiente', centerHighlight: 'Centrar resaltado',
      explainTab: 'Explicación', globalTab: 'Mapa Global', toggleSidebar: 'Ocultar/mostrar panel',
      trackingToggle: 'Activar/salir seguimiento', home: 'Ir a inicio', settings: 'Abrir configuración',
    },
    vis: {
      tracking: 'Botón de tracking', viewType: 'Navegación de vista (parada / contador)',
      hidePanel: 'Botón ocultar panel', zoom: 'Botones de zoom', conceptScroll: 'Botones de scroll entre conceptos',
      home: 'Botón de inicio', settings: 'Botón de configuración',
    },
  },
  en: {
    title: 'Settings', shortcuts: 'Keyboard shortcuts', display: 'Display & Layout',
    right: 'Right hand', left: 'Left hand', action: 'Action',
    onlyActive: 'Only the selected hand is editable; the opposite one is disabled.',
    reset: 'Reset to defaults', confirm: 'Confirm changes',
    emptyTitle: 'Empty fields', back: 'Back to editing', confirmAnyway: 'Confirm anyway',
    emptyBody: 'Some shortcuts are unassigned. Those actions will have no key. Confirm anyway?',
    requiredTitle: 'Required fields', ok: 'Got it',
    requiredBody: 'These fields cannot be left empty:',
    hiddenTitle: 'Button hidden', hiddenBody: 'You can still use these actions from the keyboard:',
    visibility: 'Interface visibility', layout: 'Panel position',
    panelWidth: 'Panel width (% of screen)',
    panelRight: 'Right', panelLeft: 'Left', close: 'Close', space: 'Space', unset: 'Unset',
    actions: {
      focusToggle: 'Toggle focus (Canvas/Panel)', scrollUp: 'Scroll up', scrollDown: 'Scroll down',
      conceptPrev: 'Previous concept', conceptNext: 'Next concept', centerHighlight: 'Center highlight',
      explainTab: 'Explanation', globalTab: 'Global Map', toggleSidebar: 'Toggle panel',
      trackingToggle: 'Toggle tracking', home: 'Go to home', settings: 'Open settings',
    },
    vis: {
      tracking: 'Tracking button', viewType: 'View navigation (stop / counter)',
      hidePanel: 'Hide-panel button', zoom: 'Zoom buttons', conceptScroll: 'Concept scroll buttons',
      home: 'Home button', settings: 'Settings button',
    },
  },
}

function useLabels() {
  const { lang } = useUiLang()
  return L[lang] || L.en
}

const clone = (o) => JSON.parse(JSON.stringify(o))

function keyLabel(k, labels) {
  if (k === ' ') return labels.space
  if (!k) return ''
  return k.toUpperCase()
}

function GearIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// Reusable entry-point button. Styling is passed in so it can sit in the Home
// header or the reader's floating toolbar.
export function SettingsButton({ className = '', style, iconSize = 18 }) {
  const { openSettings } = useSettings()
  const labels = useLabels()
  return (
    <button type="button" onClick={openSettings} title={labels.title} aria-label={labels.title} className={className} style={style}>
      <GearIcon size={iconSize} />
    </button>
  )
}

// Single keybinding field: focus + press a key to capture it. Backspace/Delete
// clears it. Modifier-only keys are ignored.
function ShortcutInput({ value, disabled, invalid, onCapture, labels }) {
  return (
    <input
      type="text"
      readOnly
      inputMode="none"
      disabled={disabled}
      value={keyLabel(value, labels)}
      placeholder={labels.unset}
      onKeyDown={(e) => {
        if (disabled) return
        if (['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock'].includes(e.key)) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Backspace' || e.key === 'Delete') return onCapture('')
        if (e.key === ' ' || e.code === 'Space') return onCapture(' ')
        if (e.key.length === 1) return onCapture(e.key.toLowerCase())
      }}
      className={`w-16 text-center text-xs font-mono font-bold rounded-lg border px-1.5 py-1.5 cursor-pointer select-none transition-colors focus:outline-none ${
        disabled
          ? 'bg-slate-50 text-slate-300 border-slate-200 cursor-not-allowed'
          : invalid
            ? 'border-red-400 bg-red-50 text-red-600 focus:ring-2 focus:ring-red-300'
            : 'border-slate-300 bg-white text-slate-700 hover:border-indigo-300 focus:ring-2 focus:ring-indigo-300'
      }`}
    />
  )
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-xl border border-slate-200 bg-slate-100 p-0.5 select-none">
      {options.map(opt => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 h-8 rounded-lg text-xs font-semibold transition-colors ${
              active ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function Slider({ value, min, max, step = 1, onChange, suffix = '' }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-indigo-600 cursor-pointer"
      />
      <span className="text-xs font-bold tabular-nums text-slate-600 min-w-[3rem] text-right">{value}{suffix}</span>
    </div>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex items-center justify-between w-full gap-3 py-2.5 group">
      <span className="text-[13px] text-slate-600 group-hover:text-slate-800 transition-colors text-left">{label}</span>
      <span className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? 'bg-indigo-600' : 'bg-slate-300'}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </span>
    </button>
  )
}

// Gate: the panel only mounts while open, so its draft state initializes fresh
// from the committed shortcuts on every open (no reseed effect needed).
export default function SettingsModal() {
  const { isOpen } = useSettings()
  if (!isOpen) return null
  return <SettingsPanel />
}

function SettingsPanel() {
  const { settings, setHandMode, setPanelSide, setPanelWidthPct, setVisibility, commitShortcuts, closeSettings } = useSettings()
  const labels = useLabels()
  const hand = settings.handMode

  // Draft of BOTH hands' maps; only the active hand is editable. Committed
  // bindings live in context — the draft is local until Confirm.
  const [draft, setDraft] = useState(() => clone(settings.shortcuts))
  const [showEmptyWarn, setShowEmptyWarn] = useState(false)
  // Hard-block popup for unset REQUIRED actions, and the info popup shown when a
  // Home/Settings button is hidden (surfaces its keyboard fallback).
  const [showRequiredWarn, setShowRequiredWarn] = useState(false)
  const [hiddenInfo, setHiddenInfo] = useState(null)   // null | 'home' | 'settings'

  // Esc closes the modal (capture + stopPropagation so it doesn't reach the
  // reader's global shortcut handlers).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSettings() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeSettings])

  const activeMap = draft[hand]
  const dirty = JSON.stringify(activeMap) !== JSON.stringify(settings.shortcuts[hand])
  // Required actions block Confirm outright; other empties only warn.
  const missingRequired = REQUIRED_ACTIONS.filter(a => !activeMap[a])
  const emptyOptional = ACTIONS.filter(a => !REQUIRED_ACTIONS.includes(a) && !activeMap[a])

  // Assign a key to an action. Collision rule: if the key is already used by
  // another action in the same hand, the previous owner is cleared.
  const capture = (actionId, key) => {
    setDraft(prev => {
      const cur = { ...prev[hand] }
      if (key) for (const a of ACTIONS) if (a !== actionId && cur[a] === key) cur[a] = ''
      cur[actionId] = key
      return { ...prev, [hand]: cur }
    })
  }
  const resetActive = () => setDraft(prev => ({ ...prev, [hand]: { ...DEFAULT_SHORTCUTS[hand] } }))
  const doConfirm = () => {
    if (missingRequired.length > 0) { setShowRequiredWarn(true); return }
    if (emptyOptional.length > 0) { setShowEmptyWarn(true); return }
    commitShortcuts(hand, activeMap)
  }
  const confirmAnyway = () => { commitShortcuts(hand, activeMap); setShowEmptyWarn(false) }

  // Hiding the Home / Settings button leaves its shortcut as the only entry
  // point — surface the active hand's bindings so the user isn't stranded.
  const onVisibilityChange = (item, value) => {
    setVisibility(item, value)
    if (!value && (item === 'home' || item === 'settings')) setHiddenInfo(item)
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={closeSettings} />

      <div className="relative w-full max-w-2xl max-h-[88vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-slate-200">
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-white/95 backdrop-blur border-b border-slate-200">
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2"><GearIcon size={18} /> {labels.title}</h2>
          <button onClick={closeSettings} title={labels.close} aria-label={labels.close} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">✕</button>
        </div>

        <div className="px-6 py-5 flex flex-col gap-8">
          {/* ── Shortcuts ──────────────────────────────────────────────── */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">{labels.shortcuts}</h3>
              <Segmented value={hand} onChange={setHandMode} options={[{ value: 'right', label: labels.right }, { value: 'left', label: labels.left }]} />
            </div>
            <p className="text-[11px] text-slate-400">{labels.onlyActive}</p>

            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2 px-4 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                <span>{labels.action}</span>
                <span className={`text-center transition-colors ${hand === 'right' ? 'text-indigo-600' : ''}`}>{labels.right}</span>
                <span className={`text-center transition-colors ${hand === 'left' ? 'text-indigo-600' : ''}`}>{labels.left}</span>
              </div>
              {ACTIONS.map(a => (
                <div key={a} className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2 px-4 py-2 border-b border-slate-100 last:border-0">
                  <span className="text-[13px] text-slate-600">{labels.actions[a]}</span>
                  <div className="flex justify-center">
                    <ShortcutInput value={draft.right[a]} disabled={hand !== 'right'} invalid={hand === 'right' && !draft.right[a]} labels={labels} onCapture={(k) => capture(a, k)} />
                  </div>
                  <div className="flex justify-center">
                    <ShortcutInput value={draft.left[a]} disabled={hand !== 'left'} invalid={hand === 'left' && !draft.left[a]} labels={labels} onCapture={(k) => capture(a, k)} />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <button onClick={resetActive} className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
                {labels.reset}
              </button>
              <button onClick={doConfirm} disabled={!dirty} className="text-xs font-semibold px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:pointer-events-none transition-colors">
                {labels.confirm}
              </button>
            </div>
          </section>

          {/* ── Display & Layout ───────────────────────────────────────── */}
          <section className="flex flex-col gap-4">
            <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">{labels.display}</h3>

            <div>
              <p className="text-[12px] font-semibold text-slate-500 mb-1">{labels.visibility}</p>
              <div className="rounded-xl border border-slate-200 px-4 divide-y divide-slate-100">
                {VISIBILITY_ITEMS.map(item => (
                  <Toggle key={item} label={labels.vis[item]} checked={settings.visibility[item]} onChange={(v) => onVisibilityChange(item, v)} />
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[12px] font-semibold text-slate-500">{labels.layout}</p>
              <Segmented value={settings.panelSide} onChange={setPanelSide} options={[{ value: 'right', label: labels.panelRight }, { value: 'left', label: labels.panelLeft }]} />
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-[12px] font-semibold text-slate-500">{labels.panelWidth}</p>
              <Slider value={settings.panelWidthPct} min={PANEL_WIDTH_MIN} max={PANEL_WIDTH_MAX} onChange={setPanelWidthPct} suffix="%" />
            </div>
          </section>
        </div>
      </div>

      {/* Empty-fields warning — nested above the settings card. */}
      {showEmptyWarn && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setShowEmptyWarn(false)} />
          <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-amber-600">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <h4 className="text-sm font-bold text-slate-800">{labels.emptyTitle}</h4>
            </div>
            <p className="text-[13px] text-slate-600 leading-relaxed">{labels.emptyBody}</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setShowEmptyWarn(false)} className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
                {labels.back}
              </button>
              <button onClick={confirmAnyway} className="text-xs font-semibold px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors">
                {labels.confirmAnyway}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Required-fields hard block — these actions have a hideable button, so
          their shortcut may never be empty. No "confirm anyway" here. */}
      {showRequiredWarn && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setShowRequiredWarn(false)} />
          <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-red-600">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <h4 className="text-sm font-bold text-slate-800">{labels.requiredTitle}</h4>
            </div>
            <p className="text-[13px] text-slate-600 leading-relaxed">
              {labels.requiredBody}{' '}
              <span className="font-semibold text-slate-800">{missingRequired.map(a => labels.actions[a]).join(', ')}</span>
            </p>
            <div className="flex items-center justify-end">
              <button onClick={() => setShowRequiredWarn(false)} className="text-xs font-semibold px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
                {labels.back}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden Home/Settings button — surface its keyboard fallback so the user
          isn't stranded without an on-screen entry point. */}
      {hiddenInfo && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setHiddenInfo(null)} />
          <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-indigo-600">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <h4 className="text-sm font-bold text-slate-800">{labels.hiddenTitle}</h4>
            </div>
            <p className="text-[13px] text-slate-600 leading-relaxed">{labels.hiddenBody}</p>
            <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
              {['home', 'settings'].map(a => (
                <div key={a} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-[13px] text-slate-600">{labels.actions[a]}</span>
                  <kbd className="text-xs font-mono font-bold rounded-md border border-slate-300 bg-slate-50 text-slate-700 px-2 py-1 min-w-[2rem] text-center">{keyLabel(settings.shortcuts[hand][a], labels) || labels.unset}</kbd>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end">
              <button onClick={() => setHiddenInfo(null)} className="text-xs font-semibold px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
                {labels.ok}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
