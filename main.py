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

# Visual line (PyMuPDF) — usado internamente
class LineBlock(BaseModel):
    text: str
    bbox: BBox


# Oración semántica — unidad de resaltado expuesta al frontend
class SentenceBlock(BaseModel):
    text: str
    boxes: list[BBox]  # 1+ rects: uno por línea visual tocada, sliceado proporcionalmente


class ParagraphBlock(BaseModel):
    text: str
    boxes: list[BBox]  # 1+ rects: uno por columna/sección contigua que ocupa el párrafo
    sentences: list[SentenceBlock] = []


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
    paragraph_sentences: list[str]
    global_map: dict


class ConceptExplanation(BaseModel):
    term: str
    explanation: str


class SentenceExplanation(BaseModel):
    sentence_indices: list[int]
    quote: str
    concepts: list[ConceptExplanation]


class ExplainResponse(BaseModel):
    sentence_explanations: list[SentenceExplanation]


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

# Sentence boundary: punctuation + whitespace + uppercase-or-opener
# Evita romper en "Fig. 1", "et al.", "e.g." (lookahead exige Mayúscula / paréntesis / comilla)
_SENT_BOUNDARY_RE = re.compile(r'(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"\(])')


def _split_sentences(text: str) -> list[tuple[str, int, int]]:
    """Devuelve [(sentence_text, start_char, end_char), ...] sobre `text`."""
    spans: list[tuple[str, int, int]] = []
    cursor = 0
    for m in _SENT_BOUNDARY_RE.finditer(text):
        end = m.start()
        s = cursor
        while s < end and text[s].isspace():
            s += 1
        if s < end:
            spans.append((text[s:end], s, end))
        cursor = m.end()
    if cursor < len(text):
        s = cursor
        while s < len(text) and text[s].isspace():
            s += 1
        if s < len(text):
            spans.append((text[s:], s, len(text)))
    return spans


def _sentence_boxes(visual_lines: list[LineBlock], sent_start: int, sent_end: int) -> list[BBox]:
    """Para una oración [sent_start, sent_end) sobre el texto concatenado (join con ' '),
    calcula los rects en pantalla intersectando con cada línea visual y sliceando
    horizontalmente vía proporción char→pixel."""
    boxes: list[BBox] = []
    cursor = 0
    for line in visual_lines:
        ln_len = len(line.text)
        ln_start = cursor
        ln_end   = cursor + ln_len
        cursor   = ln_end + 1  # +1 = separador espacio

        ovl_s = max(sent_start, ln_start)
        ovl_e = min(sent_end,   ln_end)
        if ovl_e <= ovl_s or ln_len == 0:
            continue

        local_s = ovl_s - ln_start
        local_e = ovl_e - ln_start

        bb = line.bbox
        line_w = bb.x1 - bb.x0
        ratio  = line_w / ln_len
        new_x0 = bb.x0 + local_s * ratio
        new_x1 = bb.x0 + local_e * ratio

        boxes.append(BBox(
            x0=round(new_x0, 2), y0=round(bb.y0, 2),
            x1=round(new_x1, 2), y1=round(bb.y1, 2),
        ))
    return boxes


def _build_sentences(paragraph_text: str, visual_lines: list[LineBlock]) -> list[SentenceBlock]:
    """Segmenta el párrafo en oraciones y asigna rects proporcionales."""
    out: list[SentenceBlock] = []
    for sent_text, s, e in _split_sentences(paragraph_text):
        boxes = _sentence_boxes(visual_lines, s, e)
        if boxes:
            out.append(SentenceBlock(text=sent_text, boxes=boxes))
    return out


def _union_bbox(lines: list[LineBlock]) -> BBox:
    return BBox(
        x0=round(min(l.bbox.x0 for l in lines), 2),
        y0=round(min(l.bbox.y0 for l in lines), 2),
        x1=round(max(l.bbox.x1 for l in lines), 2),
        y1=round(max(l.bbox.y1 for l in lines), 2),
    )


def _split_lines_into_columns(lines: list[LineBlock]) -> list[list[LineBlock]]:
    """Agrupa líneas visuales contiguas verticalmente. Rompe en saltos grandes
    (cambio de columna, salto vertical hacia arriba) → cada grupo = un rect."""
    if not lines:
        return []
    groups: list[list[LineBlock]] = [[lines[0]]]
    for ln in lines[1:]:
        prev = groups[-1][-1]
        prev_h = max(prev.bbox.y1 - prev.bbox.y0, 1.0)
        vert_gap = ln.bbox.y0 - prev.bbox.y1
        # Salto hacia arriba (nueva columna) OR gap vertical > 2x altura línea
        if ln.bbox.y0 < prev.bbox.y0 - prev_h * 0.5 or vert_gap > prev_h * 2.0:
            groups.append([ln])
        else:
            groups[-1].append(ln)
    return groups


def _paragraph_boxes(visual_lines: list[LineBlock]) -> list[BBox]:
    """Rects ajustados al párrafo: uno por sección contigua (columna)."""
    return [_union_bbox(g) for g in _split_lines_into_columns(visual_lines)]


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
            merged_lines = list(curr.lines)

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
                    merged_lines.extend(nxt.lines)
                else:
                    break

            blocks.append(ParagraphBlock(
                text=text,
                boxes=_paragraph_boxes(merged_lines),
                sentences=_build_sentences(text, merged_lines),
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
    if not req.paragraph_sentences:
        raise HTTPException(status_code=400, detail="paragraph_sentences vacío")

    numbered = "\n".join(f"[S{i}] {s}" for i, s in enumerate(req.paragraph_sentences))
    prompt = (
        f"Mapa Global del paper:\n{json.dumps(req.global_map, ensure_ascii=False)}"
        f"\n\nPárrafo a explicar (numerado por oraciones):\n{numbered}"
    )
    try:
        return _generate_json(_EXPLAIN_MODEL, prompt, _EXPLAIN_CONFIG)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")