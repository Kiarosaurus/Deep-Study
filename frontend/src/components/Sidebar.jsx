import { useState, useEffect } from 'react'

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

function SkeletonExplain() {
  return (
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
  )
}

function GlobalMapView({ globalMap }) {
  if (!globalMap) {
    return (
      <p className="text-xs text-slate-400 text-center mt-10 leading-relaxed">
        Sube un paper para generar<br />el mapa global.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          Metodología Core
        </h3>
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
          <p className="text-xs text-slate-700 leading-relaxed">{globalMap.core_methodology}</p>
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          Conceptos Asumidos
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
          Acrónimos ({globalMap.acronyms.length})
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

function ExplainView({ explanation, error }) {
  const [currentIndex, setCurrentIndex] = useState(0)

  useEffect(() => {
    setCurrentIndex(0)
  }, [explanation])

  useEffect(() => {
    const items = explanation?.explanations
    if (!items?.length) return
    const total = items.length

    function handleKey(e) {
      if (e.key === 'ArrowRight') setCurrentIndex(i => Math.min(i + 1, total - 1))
      else if (e.key === 'ArrowLeft') setCurrentIndex(i => Math.max(i - 1, 0))
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [explanation])

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
        Pulsa ✦ en cualquier párrafo<br />del PDF para explicarlo.
      </p>
    )
  }

  const items = explanation.explanations
  const total = items.length

  if (total === 0) {
    return (
      <p className="text-xs text-slate-400 text-center mt-10 leading-relaxed">
        Este párrafo no contiene<br />conceptos complejos.
      </p>
    )
  }

  const current = items[currentIndex]
  const canPrev = currentIndex > 0
  const canNext = currentIndex < total - 1

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-5">
        <p className="font-mono text-sm font-bold text-indigo-600 mb-3 break-words">
          {current.term}
        </p>
        <p className="text-xs text-slate-700 leading-relaxed">{current.explanation}</p>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setCurrentIndex(i => i - 1)}
          disabled={!canPrev}
          title="Anterior (←)"
          className="w-8 h-8 flex items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 disabled:opacity-30 disabled:pointer-events-none transition-colors"
        >
          ←
        </button>

        <span className="flex-1 text-center text-[11px] text-slate-400 font-medium tabular-nums select-none">
          {currentIndex + 1} de {total} {total === 1 ? 'concepto' : 'conceptos'}
        </span>

        <button
          onClick={() => setCurrentIndex(i => i + 1)}
          disabled={!canNext}
          title="Siguiente (→)"
          className="w-8 h-8 flex items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 disabled:opacity-30 disabled:pointer-events-none transition-colors"
        >
          →
        </button>
      </div>
    </div>
  )
}

export default function Sidebar({
  globalMap, explanation,
  loadingGlobal, loadingExplain,
  errorGlobal, errorExplain,
}) {
  const [tab, setTab] = useState('global')

  useEffect(() => {
    if (explanation) setTab('explain')
  }, [explanation])

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-slate-200 shrink-0">
        {[
          { id: 'global', label: 'Mapa Global' },
          { id: 'explain', label: 'Explicación' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 text-[11px] font-semibold py-3 transition-colors relative ${
              tab === t.id
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            {t.label}
            {t.id === 'explain' && (loadingExplain || explanation) && (
              <span
                className={`ml-1.5 inline-block w-1.5 h-1.5 rounded-full align-middle ${
                  loadingExplain ? 'bg-amber-400 animate-pulse' : 'bg-indigo-400'
                }`}
              />
            )}
          </button>
        ))}
      </div>

      <div className="p-5 overflow-y-auto flex-1">
        {tab === 'global' && (
          loadingGlobal ? <SkeletonGlobal /> :
          errorGlobal
            ? <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{errorGlobal}</p>
            : <GlobalMapView globalMap={globalMap} />
        )}
        {tab === 'explain' && (
          loadingExplain ? <SkeletonExplain /> :
          <ExplainView explanation={explanation} error={errorExplain} />
        )}
      </div>
    </div>
  )
}
