import asyncio
import io
import json
import logging
import os
import threading
from pathlib import Path

import pypdfium2 as pdfium
from google import genai
from google.genai import types
from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from extraction_runner import ExtractionFailed, extract_resilient
from jobs import JOBS, progress_callback_for
from models import (
    DocumentInfo,
    ExplainRequest,
    ExplainResponse,
    FullBlock,
    GlobalMapping,
    PageBlocks,
    UploadResponse,
)

load_dotenv()

# Wire up python logging so messages from extraction_runner / batch_planner
# / marker_worker actually surface on uvicorn's stderr. Without this the
# library-level `logger.info(...)` calls are silently dropped because no
# handler is attached at module import time. We use a level threshold that
# can be overridden via DEEPSTUDY_LOG_LEVEL for verbose debugging.
_log_level = os.getenv("DEEPSTUDY_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("deepstudy.main")

# Serialise heavy extractions across concurrent uploads. Each Marker run
# loads multi-GB of weights and saturates either VRAM (CUDA) or one CPU
# core per Surya batch; if two uploads land at the same instant they both
# spawn marker_worker simultaneously and the OS OOM-kills both. The
# semaphore is a process-local queue, not a fairness primitive — order
# follows asyncio/threadpool wakeups. Tunable via DEEPSTUDY_EXTRACT_PARALLEL
# (default 1). Use threading.Semaphore because _run_extraction_pipeline
# executes inside loop.run_in_executor (a thread, not a coroutine).
_extract_parallel = max(1, int(os.getenv("DEEPSTUDY_EXTRACT_PARALLEL", "1")))
_EXTRACTION_GATE = threading.Semaphore(_extract_parallel)
logger.info("extraction concurrency gate sized at %d slot(s)", _extract_parallel)

_api_key = os.getenv("GEMINI_API_KEY")
if not _api_key:
    raise RuntimeError("GEMINI_API_KEY environment variable not set")

_client = genai.Client(api_key=_api_key)

UPLOADS_DIR = Path("uploads")
UPLOADS_DIR.mkdir(exist_ok=True)

GLOBAL_MAPPING_PROMPT = """Rol: Eres un asistente de investigación académica experto integrado en una interfaz de lectura inmersiva.

Contexto Global del Documento: {AQUÍ_INYECTARAS_EL_GLOBAL_MAP}
Texto a analizar: {AQUÍ_INYECTARAS_EL_PARAGRAPH_TEXT}

Tarea: Analiza el texto proporcionado. Tu objetivo es explicar ÚNICAMENTE los conceptos complejos, jerga técnica o acrónimos presentes en este párrafo específico que NO estén ya definidos de forma clara en el propio texto. Usa el "Contexto Global" como base para tus explicaciones.

Instrucciones Estrictas:

NO uses lenguaje conversacional. NO digas "En esta línea se intenta decir..." ni uses frases introductorias.

Devuelve tu respuesta ÚNICAMENTE como un objeto JSON válido con esta estructura:
{ "explanations": [{"term": "Concepto o Acrónimo extraído del párrafo", "explanation": "Explicación directa, técnica y concisa de máximo 3 oraciones."}] }

Si el párrafo es simple y no requiere explicaciones adicionales, devuelve una lista vacía en "explanations"."""


EXPLAIN_PROMPT = """Eres un tutor académico experto. Recibirás un párrafo de un paper científico SEGMENTADO POR ORACIONES y el Mapa Global del documento.

FORMATO DE ENTRADA: Cada oración del párrafo viene precedida por una etiqueta [Sk] (k = índice 0-based, donde una oración = fragmento entre puntos). Ejemplo:
[S0] Recent advances in MEMS designs have enabled high-frequency resonators.
[S1] These devices operate with low power consumption.

Debes producir DOS salidas en el MISMO JSON:

═══════════════════════════════════════════════════════════
PARTE A — "sentence_explanations" (CONCEPTOS)
═══════════════════════════════════════════════════════════

REGLA FUNDAMENTAL — NO TRADUCIR, APORTAR CONTEXTO PROFUNDO:
Tu trabajo NO es traducir, parafrasear ni resumir las oraciones. Tu trabajo es identificar los CONCEPTOS TÉCNICOS, ACRÓNIMOS o JERGA ESPECIALIZADA que aparecen DENTRO de cada oración, y aportar TODO EL CONTEXTO TEÓRICO NECESARIO para entenderlos profundamente. Debes extraer información adicional valiosa que el autor asume que el lector ya sabe. Explica QUÉ SIGNIFICAN, POR QUÉ SON RELEVANTES AQUÍ y QUÉ BACKGROUND ASUMEN. Si la oración es trivial, OMÍTELA.

Recorre el párrafo oración por oración. Por cada oración (o rango de oraciones) que contenga conceptos no triviales, devuelve UN ÚNICO objeto agrupando todos sus conceptos.

ESTRUCTURA POR OBJETO (3 campos):

1. "sentence_indices": Lista ordenada de índices Sk. Normalmente [k]. Si una idea cruza dos oraciones consecutivas, [k, k+1]. NO mezcles oraciones no contiguas.

2. "quote": Fragmento textual EXACTO Y VERBATIM del párrafo que abarca los conceptos. Subcadena literal:
   - Cero paráfrasis, cero reordenamiento, cero cambios de puntuación.
   - Sin prefijos "[Sk]".
   - Largo recomendado: 4 a 25 palabras.

3. "concepts": LISTA, una por concepto técnico. Cada elemento:
   - "term": Concepto, acrónimo, jerga o frase clave. NO incluyas dos puntos finales.
   - "explanation": Análisis profundo, VERBOSO y altamente CONTEXTUAL en el idioma de salida. NO te limites a dar una definición de diccionario ni a repetir/traducir lo que ya dice la oración original. Aporta información adicional de valor, trasfondo teórico o las implicaciones prácticas que ayuden al usuario a entender POR QUÉ este concepto importa en esta línea. Extiéndete lo necesario para dejar el panorama absolutamente claro y rico en detalles (usa de 3 a 6 oraciones largas y descriptivas).
REGLAS PARTE A:
- Múltiples conceptos en una sola oración → varios elementos en "concepts", UN solo objeto.
- Oraciones triviales → no aparecen.
- "quote" y "sentence_indices" deben ser consistentes.
- Sin puntuación rara como "))" o "((".

═══════════════════════════════════════════════════════════
PARTE B — "paragraph_context" (CONTEXTO)
═══════════════════════════════════════════════════════════

Explica el CONTEXTO en el que fueron escritas estas oraciones — no qué dicen, sino POR QUÉ aparecen aquí y QUÉ ROL CUMPLEN en el paper.

Usa el Mapa Global para inferir en qué sección del paper estás (introducción, métodos, resultados, discusión, etc.) y qué hilo argumental conecta este párrafo con el resto del documento.

ESTRUCTURA (2 campos):

1. "section_role": UNA línea (máximo 12 palabras) etiquetando qué hace este párrafo. Ejemplos: "Motiva el problema desde una limitación previa", "Describe la configuración experimental", "Reporta resultado clave del método propuesto", "Contrasta con trabajo relacionado".

2. "narrative": 2 a 4 oraciones en el idioma de salida que respondan: ¿Sobre qué construye este párrafo (qué viene antes)? ¿Hacia dónde lleva (qué viene después)? ¿Qué intención tiene el autor aquí — argumentar, justificar, contrastar, definir, evaluar? NO repitas el contenido literal del párrafo: explica su FUNCIÓN.

REGLAS PARTE B:
- Siempre devuelve "paragraph_context" aunque el párrafo sea simple. Nunca lo omitas.
- No uses comillas para citar el párrafo — referencia su rol, no su texto.

═══════════════════════════════════════════════════════════
SALIDA: ÚNICAMENTE un JSON válido con ambas partes. Sin texto adicional fuera del JSON."""

_GLOBAL_MODEL = "gemini-3.1-flash-lite"
_EXPLAIN_MODEL = "gemini-3.1-flash-lite"


# Explanation output languages. Maps the wire code (sent by the frontend's
# "Idioma de explicación" select) to the name injected into the Gemini prompt.
# Independent from the UI language. Unknown codes fall back to English.
_LANG_NAMES = {
    "es": "Spanish",
    "en": "English",
    "zh-Hant": "Traditional Chinese (繁體中文)",
}


def _lang_name(language: str) -> str:
    return _LANG_NAMES.get(language, "English")


def _build_global_config(language: str, keep_terms_in_english: bool) -> types.GenerateContentConfig:
    lang_name = _lang_name(language)
    extra = f"\n\nLANGUAGE RULE: Generate ALL text values in {lang_name}."
    if keep_terms_in_english:
        extra += (
            f"\nTERMS RULE (strict): Translate to {lang_name}: "
            "the 'definition' field of every acronym, the 'core_methodology' string, "
            "and all descriptive text. "
            "Keep in English ONLY: (1) the 'term' field of each acronym object, "
            "(2) every string inside 'assumed_concepts'. No exceptions."
        )
    return types.GenerateContentConfig(
        system_instruction=GLOBAL_MAPPING_PROMPT + extra,
        response_mime_type="application/json",
        response_schema=GlobalMapping,
        max_output_tokens=16384,
    )


def _explain_lang_rule(language: str) -> str:
    """Dominant final language directive appended to every explain prompt. The
    base prompts describe the task in Spanish for historical reasons; this rule
    overrides the output language without touching that wording, and protects
    the verbatim `quote` fragments from being translated."""
    lang_name = _lang_name(language)
    return (
        f"\n\nLANGUAGE RULE (overrides any language named above): Write every "
        f"natural-language value — 'term', 'explanation', 'section_role' and "
        f"'narrative' — in {lang_name}. Do NOT translate the verbatim 'quote' "
        f"fields: copy them exactly from the source text. Leave math symbols, "
        f"code and acronyms in their original form."
    )


def _build_explain_config(base_prompt: str, language: str) -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        system_instruction=base_prompt + _explain_lang_rule(language),
        response_mime_type="application/json",
        response_schema=ExplainResponse,
        max_output_tokens=10240,
    )


FIGURE_EXPLAIN_PROMPT = """Eres un tutor académico experto. Recibirás una IMAGEN (figura o tabla extraída de un paper científico), opcionalmente su pie de figura/tabla, y el Mapa Global del documento.

Debes producir DOS salidas en el MISMO JSON:

═══════════════════════════════════════════════════════════
PARTE A — "sentence_explanations" (CONCEPTOS DE LA IMAGEN)
═══════════════════════════════════════════════════════════

Identifica entre 2 y 6 ELEMENTOS VISUALES o CONCEPTOS TÉCNICOS clave que aparecen en la imagen (ejes, etiquetas, símbolos, escalas de color, métricas, valores numéricos destacados, nombres de métodos comparados, axiomas de la tabla, columnas/filas relevantes, anotaciones, regiones resaltadas, etc.).

Por cada uno, devuelve UN objeto con:

1. "sentence_indices": SIEMPRE [0] (la imagen es una sola unidad — no hay segmentación por oraciones).

2. "quote": Fragmento textual EXACTO del pie de figura/tabla (si existe) que ancla este concepto. Si el concepto no está mencionado literalmente en el pie, devuelve "" (cadena vacía).

3. "concepts": Lista con UN solo elemento:
   - "term": Nombre del elemento visual o concepto (p. ej. "Eje X: SNR (dB)", "Diagonal de la matriz de confusión", "Línea azul: método propuesto", "Color: cohesión del cluster").
   - "explanation": Análisis VERBOSO en el idioma de salida que explique QUÉ ES ese elemento y especialmente POR QUÉ ES IMPORTANTE conocerlo para entender la imagen. Debe quedar absolutamente claro qué aporta a la lectura visual de la figura/tabla. Aporta background teórico cuando ayude. 3 a 6 oraciones largas y descriptivas.

═══════════════════════════════════════════════════════════
PARTE B — "paragraph_context" (INTERPRETACIÓN DE LA IMAGEN)
═══════════════════════════════════════════════════════════

Interpreta la imagen como un todo — no describas oración por oración el pie de figura.

1. "section_role": UNA línea (máximo 14 palabras) etiquetando QUÉ MUESTRA la figura o tabla y cómo encaja en la narrativa del paper. Ejemplos: "Compara baseline vs. método propuesto sobre conjunto de pruebas", "Visualiza arquitectura del modelo de extremo a extremo", "Muestra distribución de errores en función de SNR".

2. "narrative": 3 a 5 oraciones interpretando la imagen. Responde: ¿Qué patrón visual destaca? ¿Qué conclusión quiere transmitir el autor mostrándola? ¿Cómo soporta el argumento del paper? ¿Qué debe captar el lector al primer vistazo? NO te limites a describir lo obvio: interpreta la intención.

═══════════════════════════════════════════════════════════
SALIDA: ÚNICAMENTE un JSON válido con ambas partes. Sin texto adicional fuera del JSON."""


ALGORITHM_EXPLAIN_PROMPT = """Eres un tutor académico experto. Recibirás una IMAGEN que muestra un ALGORITMO (pseudocódigo numerado por pasos) extraído de un paper científico, su cabecera (p. ej. "Algorithm 1 Min-Max Decomposition"), y el Mapa Global del documento.

Debes producir DOS salidas en el MISMO JSON:

═══════════════════════════════════════════════════════════
PARTE A — "sentence_explanations" (CONCEPTOS / PASOS DEL ALGORITMO)
═══════════════════════════════════════════════════════════

Identifica entre 2 y 8 elementos clave del algoritmo: variables de entrada (Require), variables auxiliares inicializadas, pasos numerados que ejecuten una operación no trivial, expresiones matemáticas con definiciones por casos, condiciones de parada / bucles, e invariantes implícitas.

Por cada uno, devuelve UN objeto con:

1. "sentence_indices": SIEMPRE [0] (el algoritmo es una sola unidad — no hay segmentación por oraciones).

2. "quote": Fragmento textual EXACTO del algoritmo que ancla este elemento (p. ej. "1: inf ← a large number", "wij = Tij/(Dij+1) if Dij ≥ 1", "If k = r, STOP"). Si no hay literal claro, devuelve "" (cadena vacía).

3. "concepts": Lista con UN solo elemento:
   - "term": Nombre del paso o concepto (p. ej. "Inicialización de inf como cota superior", "Paso 3: construcción del grafo bipartito ponderado", "Definición por casos de wij", "Condición de terminación k = r").
   - "explanation": Análisis VERBOSO en el idioma de salida. Explica QUÉ HACE ese paso, POR QUÉ se hace (rol algorítmico), y qué efecto tiene sobre las estructuras de datos del algoritmo. Aporta contexto teórico cuando ayude (complejidad, garantía de convergencia, semántica de operadores como ← o ⊕). 3 a 6 oraciones largas y descriptivas.

═══════════════════════════════════════════════════════════
PARTE B — "paragraph_context" (INTERPRETACIÓN GLOBAL DEL ALGORITMO)
═══════════════════════════════════════════════════════════

Interpreta el algoritmo como un todo — no expliques paso por paso.

1. "section_role": UNA línea (máximo 14 palabras) etiquetando QUÉ resuelve el algoritmo y cómo encaja en la narrativa del paper. Ejemplos: "Descompone matriz en sub-asignaciones mediante matching iterativo", "Computa coreset disperso vía muestreo ponderado".

2. "narrative": 3 a 5 oraciones interpretando el algoritmo. Responde: ¿Cuál es la idea central? ¿Qué bucle o invariante lo gobierna? ¿Cuándo termina y por qué? ¿Qué propiedad / garantía sostiene el autor con él? NO repitas los pasos literalmente: interpreta la estrategia.

═══════════════════════════════════════════════════════════
SALIDA: ÚNICAMENTE un JSON válido con ambas partes. Sin texto adicional fuera del JSON."""


def _render_pdf_crop(pdf_path: Path, page_idx0: int, bbox: dict, scale: float = 2.0) -> bytes:
    """Render page `page_idx0` (0-based) of `pdf_path` at `scale`, crop to bbox
    (PDF-point coordinates, top-left origin — same convention Marker uses), and
    return PNG bytes. Used by the figure/table explain branch."""
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page = pdf[page_idx0]
        bitmap = page.render(scale=scale)
        img = bitmap.to_pil()
        w, h = img.size
        box = (
            max(0, int(bbox["x0"] * scale)),
            max(0, int(bbox["y0"] * scale)),
            min(w, int(bbox["x1"] * scale)),
            min(h, int(bbox["y1"] * scale)),
        )
        if box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError(f"Invalid crop box after scaling: {box}")
        crop = img.crop(box)
        buf = io.BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue()
    finally:
        pdf.close()


def _generate_json_multimodal(
    model: str, parts: list, config: types.GenerateContentConfig
) -> dict:
    """Same envelope as `_generate_json` but accepts a list of Part objects
    (mix of image inline_data and text) instead of a string."""
    contents = [types.Content(role="user", parts=parts)]
    response = _client.models.generate_content(model=model, contents=contents, config=config)
    candidate = response.candidates[0] if response.candidates else None
    finish = getattr(candidate, "finish_reason", None)
    text = response.text
    if not text:
        raise RuntimeError(f"Empty response (finish_reason={finish})")
    if finish and str(finish).rsplit(".", 1)[-1] not in ("STOP", "1"):
        raise RuntimeError(f"Response truncated (finish_reason={finish}, bytes={len(text)})")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON (finish_reason={finish}): {e}")


def _generate_json(model: str, contents: str, config: types.GenerateContentConfig) -> dict:
    response = _client.models.generate_content(model=model, contents=contents, config=config)
    candidate = response.candidates[0] if response.candidates else None
    finish = getattr(candidate, "finish_reason", None)
    text = response.text
    if not text:
        raise RuntimeError(f"Empty response (finish_reason={finish})")
    if finish and str(finish).rsplit(".", 1)[-1] not in ("STOP", "1"):
        raise RuntimeError(f"Response truncated (finish_reason={finish}, bytes={len(text)})")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON (finish_reason={finish}): {e}")


def _assign_flat_block_refs(
    pages_data: list[PageBlocks], linear_blocks: list[FullBlock]
) -> None:
    """Match every linear paragraph back to its flat index in pages[*].blocks.

    `pages[*].blocks` is a flat list across all pages (page 1 block 0 = 0,
    page 1 block 1 = 1, …) and includes captions alongside body paragraphs.
    Matching key is (page, bbox) since both pipelines share filters and emit
    the same ParagraphBlock geometry for non-section, non-noise text blocks.
    """
    para_map: dict[tuple, int] = {}
    flat = 0
    for p in pages_data:
        for b in p.blocks:
            if b.boxes:
                bb = b.boxes[0]
                key = (p.page, bb.x0, bb.y0, bb.x1, bb.y1)
                # Bboxes are rounded to 2 decimals (see _polygon_to_bbox), so
                # exact-match collisions imply Marker emitted two paragraphs
                # at the same polygon — never observed in real PDFs. Last
                # entry wins; the earlier flat index becomes unreachable from
                # the linear side, which is fine since both blocks share text.
                para_map[key] = flat
            flat += 1
    for fb in linear_blocks:
        if fb.role != "paragraph":
            continue
        key = (fb.page, fb.bbox.x0, fb.bbox.y0, fb.bbox.x1, fb.bbox.y1)
        fb.flat_block_ref = para_map.get(key)


app = FastAPI(title="DeepStudy API", version="0.2.0")


# ── Document management endpoints ─────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "message": "DeepStudy API running"}


@app.get("/documents/", response_model=list[DocumentInfo])
def list_documents():
    docs = []
    for f in sorted(UPLOADS_DIR.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True):
        docs.append(DocumentInfo(
            filename=f.name,
            size_bytes=f.stat().st_size,
            has_analysis=(UPLOADS_DIR / f"{f.name}.analysis.json").exists(),
        ))
    return docs


@app.get("/documents/{filename}")
def get_document(filename: str):
    path = UPLOADS_DIR / filename
    if not path.exists() or path.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail="Document not found.")
    return FileResponse(path, media_type="application/pdf", filename=filename)


@app.get("/documents/{filename}/analysis")
def get_analysis(filename: str):
    path = UPLOADS_DIR / f"{filename}.analysis.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Analysis not found.")
    return JSONResponse(content=json.loads(path.read_text(encoding="utf-8")))


@app.patch("/documents/{filename}/analysis/edits")
def patch_analysis_edits(filename: str, edits: dict = Body(...)):
    """Persist the reader's manual edits (block role overrides + merge groups)
    into the analysis JSON under an `edits` key. The payload shape is owned by
    the frontend (EditContext) and stored verbatim — the backend only round-
    trips it so edits survive reload. Written atomically via a temp file."""
    path = UPLOADS_DIR / f"{filename}.analysis.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Analysis not found.")
    data = json.loads(path.read_text(encoding="utf-8"))
    data["edits"] = edits
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return {"ok": True}


@app.delete("/documents/{filename}")
def delete_document(filename: str):
    path = UPLOADS_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Document not found.")
    path.unlink()
    analysis = UPLOADS_DIR / f"{filename}.analysis.json"
    if analysis.exists():
        analysis.unlink()
    return {"deleted": filename}


# ── Upload & analysis endpoints ───────────────────────────────────────────────

def _run_extraction_pipeline(
    *,
    job_id: str,
    filename: str,
    contents: bytes,
    language: str,
    keep_terms_in_english: bool,
) -> None:
    """Synchronous worker run inside a threadpool executor by the upload
    endpoint. Drives `extract_resilient` (with progress callback pushed to
    the job's SSE queue), runs the Gemini global-map call, and writes the
    analysis JSON to disk. Updates the job state to done/failed at the end.
    """
    job = JOBS.get(job_id)
    if job is None:
        logger.warning("extraction pipeline: unknown job_id=%s, dropping", job_id)
        return
    dest = UPLOADS_DIR / filename
    # Mark queued while waiting on the semaphore so the SSE stream shows the
    # client that we are not stalled, just behind another upload.
    if not _EXTRACTION_GATE.acquire(blocking=False):
        logger.info(
            "job %s (%s) queued behind concurrent extraction",
            job_id, filename,
        )
        job.push_event({
            "phase": "queued",
            "message": "Esperando turno detrás de otra extracción en curso",
        })
        _EXTRACTION_GATE.acquire()
    logger.info("job %s (%s) acquired extraction slot", job_id, filename)
    job.status = "running"
    try:
        try:
            pages_data, linear_blocks = extract_resilient(
                contents,
                on_event=progress_callback_for(job),
            )
        except ExtractionFailed as e:
            dest.unlink(missing_ok=True)
            logger.error("job %s extraction exhausted fallbacks: %s", job_id, e)
            JOBS.mark_failed(
                job_id,
                "PDF extraction exhausted memory at every fallback. "
                f"Close other apps and retry. Detail: {e}",
            )
            return
        except Exception as e:
            dest.unlink(missing_ok=True)
            logger.exception("job %s extraction crashed: %s", job_id, e)
            JOBS.mark_failed(job_id, f"Could not parse PDF: {e}")
            return

        _assign_flat_block_refs(pages_data, linear_blocks)

        parts: list[str] = []
        for p in pages_data:
            for b in p.blocks:
                if b.continuation and parts:
                    prev = parts[-1].rstrip()
                    if prev.endswith(("-", "—", "¬")):
                        parts[-1] = prev[:-1] + b.text.lstrip()
                    else:
                        parts[-1] = prev + " " + b.text.lstrip()
                else:
                    parts.append(b.text)
        full_text = "\n\n".join(parts)

        job.push_event({
            "phase": "global_map_started",
            "message": "Generando mapa global con Gemini",
        })

        try:
            data = _generate_json(
                _GLOBAL_MODEL,
                full_text,
                _build_global_config(language, keep_terms_in_english),
            )
            global_map = GlobalMapping(**data)
        except Exception as e:
            JOBS.mark_failed(job_id, f"Gemini API error: {e}")
            return

        result = UploadResponse(
            filename=filename,
            page_count=len(pages_data),
            global_map=global_map,
            pages=pages_data,
            linear_blocks=linear_blocks,
            language=language,
        )
        analysis_path = UPLOADS_DIR / f"{filename}.analysis.json"
        analysis_path.write_text(
            json.dumps(result.model_dump(), ensure_ascii=False),
            encoding="utf-8",
        )
        JOBS.mark_done(job_id, result.model_dump())
    except Exception as e:
        logger.exception("job %s unexpected pipeline error", job_id)
        JOBS.mark_failed(job_id, f"Unexpected error: {e}")
    finally:
        _EXTRACTION_GATE.release()
        logger.info("job %s released extraction slot", job_id)


@app.post("/upload-pdf/")
async def upload_pdf(
    file: UploadFile = File(...),
    language: str = Form("es"),
    keep_terms_in_english: bool = Form(False),
    overwrite: bool = Form(False),
):
    """Accept a PDF upload and kick off extraction in the background.

    Returns 202 + `{job_id, filename}` immediately so the client never
    times out on long extractions. The actual extraction (+ Gemini call)
    runs in a thread-pool executor and reports progress through SSE at
    `/upload-pdf/{job_id}/events`.
    """
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Invalid file type. Only PDF accepted.")

    dest = UPLOADS_DIR / file.filename
    if dest.exists() and not overwrite:
        raise HTTPException(status_code=409, detail=f"'{file.filename}' already exists.")

    contents = await file.read()
    dest.write_bytes(contents)

    loop = asyncio.get_running_loop()
    job = JOBS.create(file.filename, loop)
    # Periodically prune old finished jobs. Cheap; runs on every upload.
    JOBS.prune()

    # Run extraction in a threadpool so the event loop stays responsive for
    # the SSE endpoint. We don't await the future — its lifecycle is tracked
    # by the JobRegistry, not by request scope.
    loop.run_in_executor(
        None,
        lambda: _run_extraction_pipeline(
            job_id=job.id,
            filename=file.filename,
            contents=contents,
            language=language,
            keep_terms_in_english=keep_terms_in_english,
        ),
    )

    return JSONResponse(
        status_code=202,
        content={"job_id": job.id, "filename": file.filename},
    )


@app.get("/upload-pdf/{job_id}/events")
async def upload_pdf_events(job_id: str, request: Request):
    """Server-Sent Events stream of extraction progress for `job_id`.

    Each event is a JSON object: `{phase, message, ...}`. Terminal events
    (`phase: 'done'` or `phase: 'failed'`) close the stream. The client
    disconnecting does NOT cancel the underlying job — extraction keeps
    running so the result is still cached on disk and reachable via
    `/documents/{filename}/analysis` once finished.
    """
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job_id: {job_id}")

    async def event_stream():
        # If the job already finished before the client subscribed, replay
        # the terminal event so the client doesn't hang waiting.
        if job.status in ("done", "failed"):
            if job.status == "done":
                yield (
                    "data: "
                    + json.dumps({
                        "phase": "done",
                        "message": "Análisis completado",
                        "filename": job.filename,
                    }, ensure_ascii=False)
                    + "\n\n"
                )
            else:
                yield (
                    "data: "
                    + json.dumps({
                        "phase": "failed",
                        "message": job.error or "Unknown error",
                    }, ensure_ascii=False)
                    + "\n\n"
                )
            return

        # Stream events as they arrive. A small keepalive timeout makes sure
        # proxies don't kill an idle connection during long batch runs.
        while True:
            if await request.is_disconnected():
                return
            try:
                event = await asyncio.wait_for(job.events.get(), timeout=15.0)
            except asyncio.TimeoutError:
                # SSE comment line keeps the connection alive without
                # surfacing anything to the client-side JSON parser.
                yield ": keepalive\n\n"
                continue
            if event.get("__terminal__"):
                return
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable buffering on nginx-style proxies
        },
    )


@app.post("/explain-paragraph/")
async def explain_paragraph(req: ExplainRequest):
    if req.block_type in ("figure", "table", "algorithm"):
        return _explain_figure(req)

    if not req.paragraph_sentences:
        raise HTTPException(status_code=400, detail="paragraph_sentences is empty")

    numbered = "\n".join(f"[S{i}] {s}" for i, s in enumerate(req.paragraph_sentences))
    prompt = (
        f"Mapa Global del paper:\n{json.dumps(req.global_map, ensure_ascii=False)}"
        f"\n\nPárrafo a explicar (numerado por oraciones):\n{numbered}"
    )
    # Symbol-marked footnotes the paragraph cites — extra context for the
    # explanation, explicitly labeled so the model treats them as footnotes.
    if req.footnotes:
        foot = "\n".join(f"[Footnote] {f}" for f in req.footnotes)
        prompt += (
            "\n\nFootnotes referenced by this paragraph (additional context, "
            f"not part of the sentence numbering):\n{foot}"
        )
    try:
        return _generate_json(
            _EXPLAIN_MODEL, prompt, _build_explain_config(EXPLAIN_PROMPT, req.language)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")


def _explain_figure(req: ExplainRequest) -> dict:
    if not req.filename or req.page is None or req.bbox is None:
        raise HTTPException(
            status_code=400,
            detail="figure/table/algorithm explain requires filename, page and bbox",
        )
    pdf_path = UPLOADS_DIR / req.filename
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="Source PDF not found")
    try:
        png_bytes = _render_pdf_crop(
            pdf_path,
            page_idx0=req.page - 1,
            bbox=req.bbox.model_dump(),
            scale=2.0,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not rasterize figure: {str(e)}")

    is_algorithm = req.block_type == "algorithm"
    label = {"figure": "figura", "table": "tabla", "algorithm": "algoritmo"}.get(req.block_type, req.block_type)
    caption_label = "Cabecera" if is_algorithm else "Pie"
    text_prompt = (
        f"Mapa Global del paper:\n{json.dumps(req.global_map, ensure_ascii=False)}"
        f"\n\nTipo de bloque: {req.block_type}"
        f"\n{caption_label} ({label}):\n{req.caption_text or '(sin texto)'}"
    )
    parts = [
        types.Part(inline_data=types.Blob(mime_type="image/png", data=png_bytes)),
        types.Part(text=text_prompt),
    ]
    base_prompt = ALGORITHM_EXPLAIN_PROMPT if is_algorithm else FIGURE_EXPLAIN_PROMPT
    config = _build_explain_config(base_prompt, req.language)
    try:
        return _generate_json_multimodal(_EXPLAIN_MODEL, parts, config)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")
