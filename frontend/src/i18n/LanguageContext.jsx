/* eslint-disable react-refresh/only-export-components -- the useUiLang hook is
   intentionally co-located with its provider; this only affects HMR fast-refresh. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { DEFAULT_LANG, LANGS, TRANSLATIONS } from './translations'

const STORAGE_KEY = 'deepstudy:uiLang'
const LangCtx = createContext(null)

function detectInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && TRANSLATIONS[saved]) return saved
  } catch { /* localStorage unavailable */ }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || ''
  if (/^zh/i.test(nav)) return 'zh-Hant'
  if (/^en/i.test(nav)) return 'en'
  if (/^es/i.test(nav)) return 'es'
  return DEFAULT_LANG
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(detectInitial)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((next) => {
    if (TRANSLATIONS[next]) setLangState(next)
  }, [])

  // t(key, vars): resolves a string or (vars)=>string entry for the active
  // language, falling back to English then the raw key. Plain strings support
  // {var} placeholder substitution.
  const t = useCallback((key, vars) => {
    const dict = TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANG]
    let v = dict[key]
    if (v == null) v = TRANSLATIONS.en[key]
    if (v == null) return key
    if (typeof v === 'function') return v(vars || {})
    if (vars) return v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`))
    return v
  }, [lang])

  const value = useMemo(() => ({ lang, setLang, t, langs: LANGS }), [lang, setLang, t])
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>
}

export function useUiLang() {
  const ctx = useContext(LangCtx)
  if (!ctx) throw new Error('useUiLang must be used within a LanguageProvider')
  return ctx
}
