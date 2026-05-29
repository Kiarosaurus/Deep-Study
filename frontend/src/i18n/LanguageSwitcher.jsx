import { useUiLang } from './LanguageContext'

// UI-language picker. Drives interface chrome only — NOT the explanation
// language (that stays the "Idioma de explicación" select in PdfUploader).
export default function LanguageSwitcher({ className = '' }) {
  const { lang, setLang, langs, t } = useUiLang()
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <span className="text-base leading-none" aria-hidden="true">🌐</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        aria-label={t('uploader.uiLang')}
        title={t('uploader.uiLang')}
        className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 bg-white focus:ring-2 focus:ring-indigo-300 focus:outline-none cursor-pointer"
      >
        {langs.map(l => (
          <option key={l.code} value={l.code}>{l.label}</option>
        ))}
      </select>
    </div>
  )
}
