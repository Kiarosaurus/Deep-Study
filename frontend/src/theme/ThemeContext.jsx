/* eslint-disable react-refresh/only-export-components -- the useTheme hook is
   intentionally co-located with its provider; this only affects HMR. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'deepstudy:theme'
// normal = current palette (default); sepia = warm low-contrast; dark = soft dark.
export const THEMES = ['normal', 'sepia', 'dark']
const THEME_CLASS = { normal: '', sepia: 'theme-sepia', dark: 'theme-dark' }

const ThemeCtx = createContext(null)

function detectInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && THEMES.includes(saved)) return saved
  } catch { /* localStorage unavailable */ }
  return 'normal'
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(detectInitial)

  // Persist + apply the theme class to <html> so the CSS variables + Tailwind
  // overrides + canvas filters cascade over the whole document.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignore */ }
    if (typeof document !== 'undefined') {
      const el = document.documentElement
      el.classList.remove('theme-sepia', 'theme-dark')
      if (THEME_CLASS[theme]) el.classList.add(THEME_CLASS[theme])
      el.dataset.theme = theme
    }
  }, [theme])

  const setTheme = useCallback((next) => {
    if (THEMES.includes(next)) setThemeState(next)
  }, [])

  const cycleTheme = useCallback(() => {
    setThemeState((cur) => THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length])
  }, [])

  const value = useMemo(
    () => ({ theme, setTheme, cycleTheme, themes: THEMES }),
    [theme, setTheme, cycleTheme],
  )
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeCtx)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
