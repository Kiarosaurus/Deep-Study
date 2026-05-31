import { THEMES, useTheme } from './ThemeContext'
import { useUiLang } from '../i18n/LanguageContext'

function Icon({ theme }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }
  if (theme === 'dark') {
    return <svg {...common}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
  }
  if (theme === 'sepia') {
    // droplet — warm / low light
    return <svg {...common}><path d="M12 3c3.5 4.5 6 7 6 10a6 6 0 0 1-12 0c0-3 2.5-5.5 6-10z" /></svg>
  }
  // normal — sun
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  )
}

// Three-way segmented switch — used on Home.
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  const { t } = useUiLang()
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-xl border p-0.5 select-none"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
      role="radiogroup"
      aria-label={t('theme.label')}
    >
      {THEMES.map((m) => {
        const active = theme === m
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(m)}
            title={t(`theme.${m}`)}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
            style={active
              ? { background: 'var(--accent, #4f46e5)', color: '#fff' }
              : { color: 'var(--text-muted)' }}
          >
            <Icon theme={m} />
          </button>
        )
      })}
    </div>
  )
}

// Single button cycling normal → sepia → dark — used in the reader (bottom-left).
export function ThemeButton({ className = '' }) {
  const { theme, cycleTheme } = useTheme()
  const { t } = useUiLang()
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={`${t('theme.label')}: ${t(`theme.${theme}`)} → ${t(`theme.${next}`)}`}
      aria-label={t('theme.label')}
      className={`w-9 h-9 flex items-center justify-center rounded-xl shadow-md border backdrop-blur transition-colors ${className}`}
      style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-muted)' }}
    >
      <Icon theme={theme} />
    </button>
  )
}
