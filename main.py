import json
import os
import re
from pathlib import Path
from dataclasses import dataclass

import fitz
from google import genai
from google.genai import types
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

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


# ── Pydantic models ───────────────────────────────────────────────────────────

class Acronym(BaseModel):
    term: str
    definition: str


class GlobalMapping(BaseModel):
    acronyms: list[Acronym]
    core_methodology: str
    assumed_concepts: list[str]


class BBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float

# NUEVO: Modelo para extraer líneas precisas
class LineBlock(BaseModel):
    text: str
    bbox: BBox

class ParagraphBlock(BaseModel):
    text: str
    bbox: BBox
    lines: list[LineBlock] = []  # Ahora el frontend recibirá este array
    

class PageBlocks(BaseModel):
    page: int
    blocks: list[ParagraphBlock]


class UploadResponse(BaseModel):
    filename: str
    page_count: int
    global_map: GlobalMapping
    pages: list[PageBlocks]


class DocumentInfo(BaseModel):
    filename: str
    size_bytes: int
    has_analysis: bool


class ExplainRequest(BaseModel):
    paragraph_text: str
    global_map: dict


class TermExplanation(BaseModel):
    term: str
    explanation: str


class ExplainResponse(BaseModel):
    explanations: list[TermExplanation]


# ── Estructura Temporal para Heurística ───────────────────────────────────────
@dataclass
class TextCandidate:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    is_indented: bool
    font_size: float
    lines: list[LineBlock]  # Ahora guardamos las líneas temporalmente aquí


# ── AI models ─────────────────────────────────────────────────────────────────

EXPLAIN_PROMPT = """Eres un tutor académico experto. Recibirás un párrafo de un paper científico y el Mapa Global del documento.

Tu tarea: identifica TODAS las IDEAS COMPLEJAS, implicaciones profundas, contexto subyacente y términos técnicos en el párrafo. 
Explica cada elemento de forma analítica y concisa en español.

Reglas de extracción:
- NO te limites a acrónimos. Si una oración describe un "approach" o una tecnología (ej. avances en diseños MEMS), extrae esa frase clave y explica qué significa, por qué es relevante o su contexto.
- Si para una sola oración existen múltiples ideas complejas o conceptos técnicos iterativos, DIVÍDELOS en varios objetos independientes dentro de la lista (un globo de explicación por cada idea).

Reglas estrictas de formato JSON:
- "term": La frase, idea o concepto clave exacto extraído del texto. NO incluyas dos puntos finales.
- "explanation": Tu explicación profunda, técnica y concisa (máximo 3 oraciones).
- NO uses puntuación extraña como "))", "((", ni símbolos LaTeX sin contexto.
- Devuelve ÚNICAMENTE un JSON válido. Sin ningún texto adicional fuera del JSON."""

_GLOBAL_MODEL  = "gemini-3.1-flash-lite"
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
    """Llama Gemini, valida finish_reason, parsea JSON. Lanza RuntimeError con causa específica."""
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

# ── Extraction helpers ────────────────────────────────────────────────────────

_CLOSING_PUNCT       = frozenset('.!?…')
_HEADER_FOOTER_MARGIN = 0.08
_TITLE_PAGE_MARGIN   = 0.22
_MIN_WORDS           = 5
_INDENT_THRESHOLD    = 15.0     # pts: diferencia x0 para considerar sangría
_TITLE_FONT_RATIO    = 1.5

_JUNK_PREFIXES = (
    'keywords', 'keywords:', 'index terms', 'index terms:',
    'reference format', 'reference format:', 'acm reference format',
    'ccs concepts',
)


def _looks_like_section_title(text: str) -> bool:
    words = text.split()
    if not words or len(words) > 8:
        return False
    if re.match(r'^(?:\d+\.?[\d.]*|[A-Z]{1,5}\.?)\s+\S', text):
        return True
    alpha = [w for w in words if w.isalpha()]
    if alpha and all(w.isupper() for w in alpha):
        return True
    return False


def _ends_sentence(text: str) -> bool:
    return bool(text) and text[-1] in _CLOSING_PUNCT


def _is_junk_section(text: str) -> bool:
    lower = text.lower().lstrip()
    return any(lower.startswith(kw) for kw in _JUNK_PREFIXES)


def _page_median_font_size(dict_blocks: list) -> float:
    sizes = [
        span["size"]
        for b in dict_blocks if b.get("type") == 0
        for line in b.get("lines", [])
        for span in line.get("spans", [])
        if span.get("text", "").strip()
    ]
    if not sizes: return 10.0
    sizes.sort()
    return sizes[len(sizes) // 2]


def _block_avg_font_size(block: dict) -> float:
    sizes = [
        span["size"]
        for line in block.get("lines", [])
        for span in line.get("spans", [])
        if span.get("text", "").strip()
    ]
    return sum(sizes) / len(sizes) if sizes else 0.0

def _split_by_indent(block: dict) -> list[TextCandidate]:
    """Calcula matemáticamente la sangría y extrae sub-bloques y sus líneas nativas."""
    lines = block.get("lines", [])
    if not lines:
        return []
    std_x0 = min(ln["bbox"][0] for ln in lines)
    block_font = _block_avg_font_size(block)
    
    result = []
    cur_texts, cur_bbox, cur_lines = [], None, []
    
    for ln in lines:
        lx0, ly0, lx1, ly1 = ln["bbox"]
        line_text = " ".join(s.get("text", "") for s in ln.get("spans", [])).strip()
        if not line_text:
            continue
        
        # Matemáticas de sangría: si el inicio de esta línea se separa del borde general
        line_is_indented = (lx0 - std_x0) > _INDENT_THRESHOLD
        
        if cur_texts and line_is_indented:
            # Nuevo párrafo detectado por sangría
            is_indented = (cur_bbox[0] - std_x0) > _INDENT_THRESHOLD if cur_bbox else False
            result.append(TextCandidate(*cur_bbox, " ".join(cur_texts), is_indented, block_font, cur_lines))
            cur_texts, cur_bbox, cur_lines = [], None, []
        
        cur_texts.append(line_text)
        # GUARDAMOS LA LÍNEA INDIVIDUAL
        cur_lines.append(LineBlock(
            text=line_text,
            bbox=BBox(x0=round(lx0, 2), y0=round(ly0, 2), x1=round(lx1, 2), y1=round(ly1, 2))
        ))

        if cur_bbox is None:
            cur_bbox = (lx0, ly0, lx1, ly1)
        else:
            cur_bbox = (min(cur_bbox[0], lx0), min(cur_bbox[1], ly0),
                        max(cur_bbox[2], lx1), max(cur_bbox[3], ly1))
        
    if cur_texts:
        is_indented = (cur_bbox[0] - std_x0) > _INDENT_THRESHOLD if cur_bbox else False
        result.append(TextCandidate(*cur_bbox, " ".join(cur_texts), is_indented, block_font, cur_lines))
        
    return result


app = FastAPI(title="DeepStudy API", version="0.1.0")


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
        doc = fitz.open(stream=contents, filetype="pdf")
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse PDF: {str(e)}")

    pages_data: list[PageBlocks] = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        page_h = page.rect.height
        top_limit = page_h * (_TITLE_PAGE_MARGIN if page_num == 0 else _HEADER_FOOTER_MARGIN)
        bot_limit = page_h * (1.0 - _HEADER_FOOTER_MARGIN)

        raw = page.get_text("dict")
        dict_blocks = raw.get("blocks", [])
        median_size = _page_median_font_size(dict_blocks)

        # PASADA 1: Filtro de Ruido
        candidates: list[TextCandidate] = []
        for block in dict_blocks:
            if block.get("type") != 0: continue
            _, by0, _, by1 = block["bbox"]
            if by0 < top_limit or by1 > bot_limit: continue
            if page_num == 0 and _block_avg_font_size(block) > median_size * _TITLE_FONT_RATIO:
                continue
            
            for cand in _split_by_indent(block):
                if not cand.text or _is_junk_section(cand.text): continue
                if len(cand.text.split()) < _MIN_WORDS and not _looks_like_section_title(cand.text):
                    continue
                candidates.append(cand)

        # PASADA 2: Heurística avanzada de Subtítulos y Mergeo por Sangría
        blocks: list[ParagraphBlock] = []
        i = 0
        while i < len(candidates):
            curr = candidates[i]
            
            if i + 1 < len(candidates):
                nxt = candidates[i+1]
                if curr.font_size > nxt.font_size * 1.2 and len(curr.text.split()) < 6 and not curr.is_indented:
                    i += 1
                    continue
            
            text = curr.text
            x0, y0, x1, y1 = curr.x0, curr.y0, curr.x1, curr.y1
            merged_lines = list(curr.lines)  # Copiamos las líneas iniciales
            
            # Mergeo inteligente por Sangría (Columnas rotas)
            while i + 1 < len(candidates):
                nxt = candidates[i+1]
                
                if i + 2 < len(candidates):
                    n_nxt = candidates[i+2]
                    if nxt.font_size > n_nxt.font_size * 1.2 and len(nxt.text.split()) < 6 and not nxt.is_indented:
                        break
                elif len(nxt.text.split()) < 6 and not nxt.is_indented and nxt.font_size > curr.font_size * 1.2:
                    break
                
                if not nxt.is_indented:
                    i += 1
                    text = f"{text} {nxt.text}"
                    merged_lines.extend(nxt.lines)  # MERGE: Acumulamos las líneas de la otra columna
                    x0, y0 = min(x0, nxt.x0), min(y0, nxt.y0)
                    x1, y1 = max(x1, nxt.x1), max(y1, nxt.y1)
                else:
                    break
            
            # Pasamos el array de líneas completo al modelo de respuesta final
            blocks.append(ParagraphBlock(
                text=text,
                bbox=BBox(x0=round(x0, 2), y0=round(y0, 2),
                          x1=round(x1, 2), y1=round(y1, 2)),
                lines=merged_lines
            ))
            i += 1

        pages_data.append(PageBlocks(page=page_num + 1, blocks=blocks))

    doc.close()

    full_text = "\n\n".join(b.text for p in pages_data for b in p.blocks)

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
    )
    analysis_path = UPLOADS_DIR / f"{file.filename}.analysis.json"
    analysis_path.write_text(json.dumps(result.model_dump(), ensure_ascii=False), encoding="utf-8")

    return JSONResponse(content=result.model_dump())

@app.post("/explain-paragraph/")
async def explain_paragraph(req: ExplainRequest):
    prompt = (
        f"Mapa Global del paper:\n{json.dumps(req.global_map, ensure_ascii=False)}"
        f"\n\nPárrafo a explicar:\n{req.paragraph_text}"
    )
    try:
        return _generate_json(_EXPLAIN_MODEL, prompt, _EXPLAIN_CONFIG)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")