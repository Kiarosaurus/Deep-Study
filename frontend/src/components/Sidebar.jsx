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

function SkeletonExplain({ retryInfo }) {
  return (
    <div className="flex flex-col gap-6">
      {retryInfo && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          Reintentando ({retryInfo.attempt}/{retryInfo.maxAttempts - 1}) en {Math.round(retryInfo.delayMs / 1000)}s — error transitorio del modelo.
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

function ConceptosPanel({ items, currentIndex, onIndexChange, loadingExplain }) {
  const total = items.length

  if (total === 0) {
    return (
      <div className="mt-6 px-4 py-5 rounded-2xl border border-slate-100 bg-slate-50 text-center">
        <p className="text-xs text-slate-400 leading-relaxed italic">
          Este párrafo es claro y no contiene estructuras complejas.
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
          <p className="text-sm italic text-slate-700 leading-snug">
            {current.quote}
          </p>
        </blockquote>

        {isPlaceholder ? (
          loadingExplain ? (
            <div className="flex flex-col gap-2 animate-pulse">
              <div className="h-2.5 bg-slate-200 rounded w-1/3" />
              <div className="h-2.5 bg-slate-100 rounded w-full" />
              <div className="h-2.5 bg-slate-100 rounded w-5/6" />
              <div className="h-2.5 bg-slate-100 rounded w-4/6" />
            </div>
          ) : (
            <p className="text-[12px] text-slate-400 italic leading-relaxed">
              Esta oración no contiene conceptos técnicos que requieran explicación adicional.
            </p>
          )
        ) : (
          <div className="flex flex-col gap-4">
            {concepts.map((c, idx) => (
              <div key={idx} className="flex flex-col gap-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-600">
                  {c.term}
                </p>
                <p className="text-[13px] text-slate-600 leading-relaxed">
                  {c.explanation}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => onIndexChange(i => i - 1)}
          disabled={!canPrev}
          title="Anterior (←)"
          className="w-8 h-8 flex items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 disabled:opacity-30 disabled:pointer-events-none transition-colors"
        >
          ←
        </button>

        <span className="flex-1 text-center text-[11px] text-slate-400 font-medium tabular-nums select-none">
          {currentIndex + 1} de {total} {total === 1 ? 'oración' : 'oraciones'}
        </span>

        <button
          onClick={() => onIndexChange(i => i + 1)}
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

function ContextoPanel({ context, loadingExplain }) {
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
          No hay contexto disponible para este párrafo.
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
          Rol en la sección
        </p>
        <p className="text-sm text-slate-700 leading-snug">
          {context.section_role}
        </p>
      </section>

      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-600">
          Narrativa
        </p>
        <p className="text-[13px] text-slate-600 leading-relaxed">
          {context.narrative}
        </p>
      </section>
    </div>
  )
}

function ExplainView({ explanation, error, currentIndex, onIndexChange, explainMode, onExplainModeChange, loadingExplain, retryInfo }) {
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

  const items   = explanation.sentence_explanations ?? []
  const context = explanation.paragraph_context ?? null

  return (
    <div className="flex flex-col gap-4">
      {loadingExplain && retryInfo && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          Reintentando ({retryInfo.attempt}/{retryInfo.maxAttempts - 1}) en {Math.round(retryInfo.delayMs / 1000)}s — error transitorio del modelo.
        </div>
      )}
      <div className="flex p-0.5 bg-slate-100 rounded-lg">
        {[
          { id: 'contexto',  label: 'Contexto'  },
          { id: 'conceptos', label: 'Conceptos' },
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
        ? <ConceptosPanel items={items} currentIndex={currentIndex} onIndexChange={onIndexChange} loadingExplain={loadingExplain} />
        : <ContextoPanel context={context} loadingExplain={loadingExplain} />
      }
    </div>
  )
}

export default function Sidebar({
  globalMap, explanation,
  loadingGlobal, loadingExplain,
  errorGlobal, errorExplain,
  currentIndex, onIndexChange,
  retryInfo,
  tab, onTabChange,
  explainMode, onExplainModeChange
}) {

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-slate-200 shrink-0">
        {[
          { id: 'global', label: 'Mapa Global' },
          { id: 'explain', label: 'Explicación' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
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
}
