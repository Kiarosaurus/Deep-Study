import json
import os
from pathlib import Path

from google import genai
from google.genai import types
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from extraction import extract_both
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

REGLA FUNDAMENTAL — NO TRADUCIR, EXPLICAR:
Tu trabajo NO es traducir, parafrasear ni resumir las oraciones. Tu trabajo es identificar los CONCEPTOS TÉCNICOS, ACRÓNIMOS, JERGA ESPECIALIZADA, CONTEXTO TEÓRICO IMPLÍCITO o IMPLICACIONES NO TRIVIALES que aparecen DENTRO de cada oración, y explicar QUÉ SIGNIFICAN, POR QUÉ SON RELEVANTES o QUÉ CONTEXTO ASUMEN. Si la oración es trivial y no contiene conceptos especializados, OMÍTELA de la respuesta.

TAREA: Recorre el párrafo oración por oración. Por cada oración (o rango de oraciones) que contenga conceptos no triviales, devuelve UN ÚNICO objeto agrupando todos sus conceptos.

ESTRUCTURA POR OBJETO (3 campos):

1. "sentence_indices": Lista ordenada de índices Sk a los que pertenece este grupo. Normalmente [k]. Si una idea cruza dos oraciones consecutivas, [k, k+1]. NO mezcles oraciones no contiguas en un mismo objeto.

2. "quote": Fragmento textual EXACTO Y VERBATIM del párrafo que abarca los conceptos explicados. Subcadena literal:
   - Cero paráfrasis, cero reordenamiento, cero cambios de puntuación.
   - Sin prefijos "[Sk]".
   - Largo recomendado: 4 a 25 palabras.

3. "concepts": LISTA de explicaciones, una por concepto técnico identificado en esa(s) oración(es). Cada elemento contiene:
   - "term": Concepto, acrónimo, jerga o frase clave (puede ser reformulado o resumido por ti). NO incluyas dos puntos finales.
   - "explanation": Análisis técnico CONCISO en español. Máximo 3 oraciones. NO traduzcas la oración: explica el concepto subyacente — qué es, contexto, por qué importa.

REGLAS GLOBALES:
- Múltiples conceptos en una sola oración → varios elementos dentro de "concepts", UN solo objeto SentenceExplanation.
- Oraciones triviales o puramente descriptivas → no aparecen en la respuesta.
- "quote" y "sentence_indices" deben ser consistentes entre sí.
- NO uses puntuación rara como "))" o "((".
- Devuelve ÚNICAMENTE un JSON válido. Sin texto adicional fuera del JSON."""

_GLOBAL_MODEL = "gemini-3.1-flash-lite"
_EXPLAIN_MODEL = "gemini-2.5-flash-lite"


def _build_global_config(language: str, keep_terms_in_english: bool) -> types.GenerateContentConfig:
    lang_name = "Spanish" if language == "es" else "English"
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


_EXPLAIN_CONFIG = types.GenerateContentConfig(
    system_instruction=EXPLAIN_PROMPT,
    response_mime_type="application/json",
    response_schema=ExplainResponse,
    max_output_tokens=8192,
)


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
                para_map[(p.page, bb.x0, bb.y0, bb.x1, bb.y1)] = flat
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

@app.post("/upload-pdf/")
async def upload_pdf(
    file: UploadFile = File(...),
    language: str = Form("es"),
    keep_terms_in_english: bool = Form(False),
    overwrite: bool = Form(False),
):
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Invalid file type. Only PDF accepted.")

    dest = UPLOADS_DIR / file.filename
    if dest.exists() and not overwrite:
        raise HTTPException(status_code=409, detail=f"'{file.filename}' already exists.")

    contents = await file.read()
    dest.write_bytes(contents)

    try:
        pages_data, linear_blocks = extract_both(contents)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse PDF: {str(e)}")

    _assign_flat_block_refs(pages_data, linear_blocks)

    # Cross-page continuations join with the previous paragraph (no extra "\n\n")
    # so Gemini receives the paragraph as a single semantic unit. If the
    # previous text ends with a soft hyphen, drop it and concatenate seamlessly.
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

    try:
        data = _generate_json(
            _GLOBAL_MODEL,
            full_text,
            _build_global_config(language, keep_terms_in_english),
        )
        global_map = GlobalMapping(**data)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")

    result = UploadResponse(
        filename=file.filename,
        page_count=len(pages_data),
        global_map=global_map,
        pages=pages_data,
        linear_blocks=linear_blocks,
    )
    analysis_path = UPLOADS_DIR / f"{file.filename}.analysis.json"
    analysis_path.write_text(json.dumps(result.model_dump(), ensure_ascii=False), encoding="utf-8")

    return JSONResponse(content=result.model_dump())


@app.post("/explain-paragraph/")
async def explain_paragraph(req: ExplainRequest):
    if not req.paragraph_sentences:
        raise HTTPException(status_code=400, detail="paragraph_sentences is empty")

    numbered = "\n".join(f"[S{i}] {s}" for i, s in enumerate(req.paragraph_sentences))
    prompt = (
        f"Mapa Global del paper:\n{json.dumps(req.global_map, ensure_ascii=False)}"
        f"\n\nPárrafo a explicar (numerado por oraciones):\n{numbered}"
    )
    try:
        return _generate_json(_EXPLAIN_MODEL, prompt, _EXPLAIN_CONFIG)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")
