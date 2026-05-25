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
    <div className="flex flex-col gap-3 animate-pulse">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="border border-slate-100 rounded-xl p-3 flex flex-col gap-2">
          <div className="h-2.5 bg-slate-200 rounded w-1/4" />
          <div className="h-2.5 bg-slate-100 rounded w-full" />
          <div className="h-2.5 bg-slate-100 rounded w-5/6" />
        </div>
      ))}
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
        Selecciona texto en el PDF<br />y pulsa "Explicar selección".
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {explanation.explanations.map((e, i) => (
        <div key={i} className="border border-slate-100 rounded-xl p-3">
          <span className="font-mono text-[11px] font-bold text-indigo-600 block mb-1.5">
            {e.term}
          </span>
          <p className="text-[11px] text-slate-600 leading-relaxed">{e.explanation}</p>
        </div>
      ))}
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
