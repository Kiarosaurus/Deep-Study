export default function OverwriteModal({ filename, onAccept, onReject }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-[fadeIn_0.15s_ease-out]">

        <div className="flex items-center gap-3 mb-5">
          <span className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-100 text-xl shrink-0">
            ⚠️
          </span>
          <div>
            <h2 className="text-base font-bold text-slate-800">Archivo ya existe</h2>
            <p className="text-xs text-slate-500">Este documento está en tu biblioteca</p>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-5">
          <p className="text-[11px] font-semibold text-amber-600 uppercase tracking-wider mb-1">
            Nombre del archivo
          </p>
          <p className="font-mono text-sm text-amber-900 break-all">{filename}</p>
        </div>

        <p className="text-sm text-slate-600 leading-relaxed mb-6">
          Si continúas, el archivo y su análisis existentes serán
          <span className="font-semibold text-slate-800"> sobreescritos permanentemente</span>.
        </p>

        <div className="flex gap-3">
          <button
            onClick={onReject}
            className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-semibold rounded-xl hover:bg-slate-50 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onAccept}
            className="flex-1 px-4 py-2.5 bg-amber-500 text-white text-sm font-semibold rounded-xl hover:bg-amber-600 transition-colors"
          >
            Sobreescribir
          </button>
        </div>

      </div>
    </div>
  )
}
