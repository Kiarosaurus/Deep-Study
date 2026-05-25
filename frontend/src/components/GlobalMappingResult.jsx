export default function GlobalMappingResult({ data, onReset }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">Mapeo Global</h2>
        <button
          onClick={onReset}
          className="text-sm text-slate-400 hover:text-indigo-600 transition-colors"
        >
          ← Nuevo paper
        </button>
      </div>

      <section className="bg-white rounded-2xl border border-slate-200 p-6">
        <h3 className="text-xs font-semibold text-indigo-600 uppercase tracking-widest mb-3">
          Metodología Core
        </h3>
        <p className="text-slate-700 leading-relaxed text-sm">{data.core_methodology}</p>
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 p-6">
        <h3 className="text-xs font-semibold text-indigo-600 uppercase tracking-widest mb-3">
          Conceptos Asumidos
        </h3>
        <div className="flex flex-wrap gap-2">
          {data.assumed_concepts.map((concept, i) => (
            <span
              key={i}
              className="px-3 py-1 bg-indigo-50 text-indigo-700 text-xs rounded-full font-medium border border-indigo-100"
            >
              {concept}
            </span>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 p-6">
        <h3 className="text-xs font-semibold text-indigo-600 uppercase tracking-widest mb-3">
          Acrónimos ({data.acronyms.length})
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left py-2 pr-6 text-slate-400 font-medium text-xs w-24">
                  Término
                </th>
                <th className="text-left py-2 text-slate-400 font-medium text-xs">
                  Definición
                </th>
              </tr>
            </thead>
            <tbody>
              {data.acronyms.map((a, i) => (
                <tr key={i} className="border-b border-slate-50 last:border-0">
                  <td className="py-2 pr-6 font-mono font-bold text-slate-800 text-xs align-top">
                    {a.term}
                  </td>
                  <td className="py-2 text-slate-600 text-xs leading-relaxed">
                    {a.definition}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
