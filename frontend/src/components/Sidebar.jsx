const MOCK = {
  core_methodology:
    'Los autores proponen un marco encoder-decoder basado en Transformers que incorpora atención cruzada para alinear representaciones multimodales. El sistema se pre-entrena sobre 1.2B pares imagen-texto y se evalúa mediante fine-tuning supervisado en cuatro benchmarks estándar de comprensión visual y lingüística.',
  acronyms: [
    { term: 'NLP',  definition: 'Natural Language Processing' },
    { term: 'BERT', definition: 'Bidirectional Encoder Representations from Transformers' },
    { term: 'LLM',  definition: 'Large Language Model' },
    { term: 'RAG',  definition: 'Retrieval-Augmented Generation' },
    { term: 'MHA',  definition: 'Multi-Head Attention' },
    { term: 'LoRA', definition: 'Low-Rank Adaptation' },
    { term: 'F1',   definition: 'Harmonic mean of precision and recall' },
  ],
  assumed_concepts: [
    'Attention Mechanism', 'Transfer Learning', 'Fine-tuning',
    'Tokenización', 'Embeddings', 'Backpropagation',
    'Perplexity', 'Clasificación de texto',
  ],
}

function SidebarSkeleton() {
  return (
    <div className="p-5 flex flex-col gap-5 animate-pulse">
      <div className="h-4 bg-slate-200 rounded w-1/3" />
      <div className="bg-slate-100 rounded-xl p-4 flex flex-col gap-2">
        <div className="h-3 bg-slate-200 rounded w-full" />
        <div className="h-3 bg-slate-200 rounded w-5/6" />
        <div className="h-3 bg-slate-200 rounded w-4/6" />
      </div>
      <div className="h-4 bg-slate-200 rounded w-1/3 mt-2" />
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-3 bg-slate-100 rounded w-full" />
      ))}
    </div>
  )
}

export default function Sidebar({ data, loading, error }) {
  const d = data ?? MOCK

  if (loading) return <SidebarSkeleton />

  return (
    <div className="p-5 flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-indigo-600 uppercase tracking-widest">
          Mapeo Global
        </span>
        {!data && (
          <span className="text-[10px] bg-amber-100 text-amber-600 px-2 py-0.5 rounded-full font-medium">
            demo
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* Metodología Core */}
      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          Metodología Core
        </h3>
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
          <p className="text-xs text-slate-700 leading-relaxed">{d.core_methodology}</p>
        </div>
      </section>

      {/* Conceptos Asumidos */}
      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          Conceptos Asumidos
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {d.assumed_concepts.map((c, i) => (
            <span
              key={i}
              className="px-2.5 py-1 bg-slate-100 text-slate-600 text-[11px] rounded-full font-medium border border-slate-200"
            >
              {c}
            </span>
          ))}
        </div>
      </section>

      {/* Acrónimos */}
      <section>
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">
          Acrónimos ({d.acronyms.length})
        </h3>
        <div className="flex flex-col gap-1.5">
          {d.acronyms.map((a, i) => (
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
