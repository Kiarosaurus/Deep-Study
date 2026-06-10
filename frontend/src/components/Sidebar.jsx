import { forwardRef, useCallback, useEffect, useRef } from 'react'
import { useUiLang } from '../i18n/LanguageContext'
import { useSettings } from '../settings/SettingsContext'
import MathText, { wrapBareLatex } from './MathText'

function SkeletonGlobal() {
  return (
    <div className="flex flex-col gap-5 animate-pulse">
      <div className="h-3 bg-slate-200 rounded w-1/3" />
      <div className="bg-slate-100 rounded-xl p-4 flex flex-col gap-2">
        <div className="h-2.5 bg-slate-200 rounded w-full" />
        <div className="h-2.5 bg-slate-200 rounded w-5/6" />
        <div className="h-2.5 bg-slate-200 rounded w-4/6" />
      </div>
      <div className="h-3 bg-slate-200 rounded w-1/3" />
      <div className="flex flex-wrap gap-1.5">
        {[80, 60, 90, 70, 55].map((w, i) => (
          <div key={i} style={{ width: w }} className="h-6 bg-slate-100 rounded-full" />
        ))}
      </div>
      <div className="h-3 bg-slate-200 rounded w-1/3" />
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-8 bg-slate-100 rounded-lg" />
      ))}
    </div>
  )
}

function SkeletonExplain({ retryInfo }) {
  const { t } = useUiLang()
  return (
    <div className="flex flex-col gap-6">
      {retryInfo && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          {t('sidebar.retrying', { attempt: retryInfo.attempt, max: retryInfo.maxAttempts - 1, secs: Math.round(retryInfo.delayMs / 1000) })}
        </div>
      )}
      <div className="flex flex-col gap-6 animate-pulse">
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5 flex flex-col gap-3">
          <div className="h-3 bg-slate-200 rounded w-1/3" />
          <div className="h-2.5 bg-slate-100 rounded w-full" />
          <div className="h-2.5 bg-slate-100 rounded w-5/6" />
          <div className="h-2.5 bg-slate-100 rounded w-4/6" />
        </div>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-slate-100 rounded-xl" />
          <div className="flex-1 h-2.5 bg-slate-100 rounded mx-4" />
          <div className="w-8 h-8 bg-slate-100 rounded-xl" />
        </div>
      </div>
    </div>
  )
}

function GlobalMapView({ globalMap }) {
  const { t } = useUiLang()
  if (!globalMap) {
    return (
      <p className="text-xs text-slate-400 text-center mt-10 leading-relaxed">
        {t('sidebar.globalEmpty')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          {t('sidebar.coreMethodology')}
        </h3>
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
          <p className="text-xs text-slate-700 leading-relaxed">{globalMap.core_methodology}</p>
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          {t('sidebar.assumedConcepts')}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {globalMap.assumed_concepts.map((c, i) => (
            <span
              key={i}
              className="px-2.5 py-1 bg-slate-100 text-slate-600 text-[11px] rounded-full font-medium border border-slate-200"
            >
              {c}
            </span>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          {t('sidebar.acronyms', { n: globalMap.acronyms.length })}
        </h3>
        <div className="flex flex-col gap-1.5">
          {globalMap.acronyms.map((a, i) => (
            <div
              key={i}
              className="flex gap-3 items-start bg-white border border-slate-100 rounded-lg px-3 py-2"
            >
              <span className="font-mono text-[11px] font-bold text-indigo-600 shrink-0 mt-0.5 w-12">
                {a.term}
              </span>
              <span className="text-[11px] text-slate-600 leading-relaxed">{a.definition}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

// `pending` is true only while the explanation is still the skeleton (data not
// yet resolved). A placeholder sentence keys its loading state on THAT, not on
// the global loadingExplain flag — once a real response is in, a no-concept
// sentence is definitively concept-free and must show the message immediately,
// even if the loading flag desynced.
function ConceptosPanel({ items, currentIndex, onIndexChange, pending }) {
  const { t } = useUiLang()
  const { settings } = useSettings()
  const total = items.length

  if (total === 0) {
    return (
      <div className="mt-6 px-4 py-5 rounded-2xl border border-slate-100 bg-slate-50 text-center">
        <p className="text-xs text-slate-400 leading-relaxed italic">
          {t('sidebar.paragraphClear')}
        </p>
      </div>
    )
  }

  const current  = items[currentIndex] ?? items[0]
  const concepts = current?.concepts ?? []
  const canPrev  = currentIndex > 0
  const canNext  = currentIndex < total - 1
  const isPlaceholder = current?.is_placeholder === true

  return (
    <div className="flex flex-col gap-5">
      <div
        key={currentIndex}
        className={`flex flex-col gap-4 rounded-2xl border p-5 shadow-sm ${
          isPlaceholder ? 'border-slate-100 bg-slate-50' : 'border-slate-200 bg-white'
        }`}
        style={{ animation: 'cardIn 0.18s ease-out' }}
      >
        <blockquote className={`border-l-[3px] pl-3 py-0.5 ${
          isPlaceholder ? 'border-slate-300' : 'border-indigo-400'
        }`}>
          <div className="text-sm italic text-slate-700 leading-snug">
            <MathText>{wrapBareLatex(current.quote ?? '')}</MathText>
          </div>
        </blockquote>

        {isPlaceholder ? (
          pending ? (
            <div className="flex flex-col gap-2 animate-pulse">
              <div className="h-2.5 bg-slate-200 rounded w-1/3" />
              <div className="h-2.5 bg-slate-100 rounded w-full" />
              <div className="h-2.5 bg-slate-100 rounded w-5/6" />
              <div className="h-2.5 bg-slate-100 rounded w-4/6" />
            </div>
          ) : (
            <p className="text-[12px] text-slate-400 italic leading-relaxed">
              {t('sidebar.sentenceNoConcepts')}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-4">
            {concepts.map((c, idx) => (
              <div key={idx} className="flex flex-col gap-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-600">
                  <MathText>{c.term ?? ''}</MathText>
                </p>
                <div className="text-[13px] text-slate-600 leading-relaxed">
                  <MathText>{c.explanation ?? ''}</MathText>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {settings.visibility.conceptScroll && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onIndexChange(i => i - 1)}
            disabled={!canPrev}
            title={t('sidebar.prev')}
            className="w-8 h-8 flex items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            ←
          </button>

          <span className="flex-1 text-center text-[11px] text-slate-400 font-medium tabular-nums select-none">
            {t('sidebar.sentenceCounter', { i: currentIndex + 1, total })}
          </span>

          <button
            onClick={() => onIndexChange(i => i + 1)}
            disabled={!canNext}
            title={t('sidebar.next')}
            className="w-8 h-8 flex items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            →
          </button>
        </div>
      )}
    </div>
  )
}

function ContextoPanel({ context, loadingExplain }) {
  const { t } = useUiLang()
  if (!context) {
    if (loadingExplain) {
      return (
        <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-pulse">
          <div className="flex flex-col gap-1.5">
            <div className="h-2.5 bg-slate-200 rounded w-1/3" />
            <div className="h-2.5 bg-slate-100 rounded w-5/6" />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="h-2.5 bg-slate-200 rounded w-1/3" />
            <div className="h-2.5 bg-slate-100 rounded w-full" />
            <div className="h-2.5 bg-slate-100 rounded w-4/6" />
          </div>
        </div>
      )
    }
    return (
      <div className="mt-6 px-4 py-5 rounded-2xl border border-slate-100 bg-slate-50 text-center">
        <p className="text-xs text-slate-400 leading-relaxed italic">
          {t('sidebar.noContext')}
        </p>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      style={{ animation: 'cardIn 0.18s ease-out' }}
    >
      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-600">
          {t('sidebar.roleInSection')}
        </p>
        <div className="text-sm text-slate-700 leading-snug">
          <MathText>{context.section_role ?? ''}</MathText>
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-600">
          {t('sidebar.narrative')}
        </p>
        <div className="text-[13px] text-slate-600 leading-relaxed">
          <MathText>{context.narrative ?? ''}</MathText>
        </div>
      </section>
    </div>
  )
}

function ExplainView({ explanation, error, currentIndex, onIndexChange, explainMode, onExplainModeChange, loadingExplain, retryInfo }) {
  const { t } = useUiLang()
  if (error) {
    return (
      <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
        {error}
      </p>
    )
  }

  if (!explanation) {
    return (
      <p className="text-xs text-slate-400 text-center mt-10 leading-relaxed">
        {t('sidebar.explainEmpty')}
      </p>
    )
  }

  const items   = explanation.sentence_explanations ?? []
  const context = explanation.paragraph_context ?? null
  // Skeleton = the pre-fetch placeholder seed; once a real response replaces it,
  // every remaining placeholder is a confirmed no-concept sentence.
  const isSkeleton = explanation.__skeleton === true

  return (
    <div className="flex flex-col gap-4">
      {loadingExplain && retryInfo && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          {t('sidebar.retrying', { attempt: retryInfo.attempt, max: retryInfo.maxAttempts - 1, secs: Math.round(retryInfo.delayMs / 1000) })}
        </div>
      )}
      <div className="flex p-0.5 bg-slate-100 rounded-lg">
        {[
          { id: 'contexto',  label: t('sidebar.modeContexto')  },
          { id: 'conceptos', label: t('sidebar.modeConceptos') },
        ].map(m => (
          <button
            key={m.id}
            onClick={() => onExplainModeChange(m.id)}
            className={`flex-1 text-[11px] font-semibold py-1.5 rounded-md transition-colors ${
              explainMode === m.id
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {explainMode === 'conceptos'
        ? <ConceptosPanel items={items} currentIndex={currentIndex} onIndexChange={onIndexChange} pending={isSkeleton} />
        : <ContextoPanel context={context} loadingExplain={loadingExplain} />
      }
    </div>
  )
}

const Sidebar = forwardRef(function Sidebar({
  globalMap, explanation,
  loadingGlobal, loadingExplain,
  errorGlobal, errorExplain,
  currentIndex, onIndexChange,
  retryInfo,
  tab, onTabChange,
  explainMode, onExplainModeChange
}, ref) {
  const { t } = useUiLang()

  // The scroll container is exposed to the parent via `ref`; keep an internal
  // handle too (merged below) so we can reset its scroll ourselves.
  const scrollRef = useRef(null)
  const setScrollRef = useCallback((node) => {
    scrollRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }, [ref])

  // Moving between concepts/sentences (currentIndex) jumps the panel back to the
  // top, so each new concept card reads from its start instead of inheriting the
  // previous card's scroll offset.
  useEffect(() => {
    if (tab === 'explain' && scrollRef.current) scrollRef.current.scrollTop = 0
  }, [currentIndex, tab, explainMode])

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-slate-200 shrink-0">
        {[
          { id: 'global', label: t('sidebar.tabGlobal') },
          { id: 'explain', label: t('sidebar.tabExplain') },
        ].map((tab_) => (
          <button
            key={tab_.id}
            onClick={() => onTabChange(tab_.id)}
            className={`flex-1 text-[11px] font-semibold py-3 transition-colors relative ${
              tab === tab_.id
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            {tab_.label}
            {tab_.id === 'explain' && (loadingExplain || explanation) && (
              <span
                className={`ml-1.5 inline-block w-1.5 h-1.5 rounded-full align-middle ${
                  loadingExplain ? 'bg-amber-400 animate-pulse' : 'bg-indigo-400'
                }`}
              />
            )}
          </button>
        ))}
      </div>

      <div ref={setScrollRef} className="p-5 overflow-y-auto flex-1">
        {tab === 'global' && (
          loadingGlobal ? <SkeletonGlobal /> :
          errorGlobal
            ? <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{errorGlobal}</p>
            : <GlobalMapView globalMap={globalMap} />
        )}
        {tab === 'explain' && (
          (loadingExplain && !explanation)
            ? <SkeletonExplain retryInfo={retryInfo} />
            : <ExplainView
                explanation={explanation}
                error={errorExplain}
                currentIndex={currentIndex}
                onIndexChange={onIndexChange}
                explainMode={explainMode}
                onExplainModeChange={onExplainModeChange}
                loadingExplain={loadingExplain}
                retryInfo={retryInfo}
              />
        )}
      </div>
    </div>
  )
})

export default Sidebar
