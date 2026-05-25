import json
import os
import re
from pathlib import Path

import fitz
import google.generativeai as genai
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

load_dotenv()

_api_key = os.getenv("GEMINI_API_KEY")
if not _api_key:
    raise RuntimeError("GEMINI_API_KEY environment variable not set")

genai.configure(api_key=_api_key)

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


class ParagraphBlock(BaseModel):
    text: str
    bbox: BBox


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


# ── AI models ─────────────────────────────────────────────────────────────────

EXPLAIN_PROMPT = """Eres un tutor académico experto. Recibirás un párrafo de un paper científico y el Mapa Global del documento (acrónimos y metodología).

Tu tarea: identifica TODOS los términos técnicos, acrónimos y conceptos difíciles presentes en el párrafo y explica cada uno de forma clara y concisa en español, usando el contexto del paper para ser preciso.

Reglas estrictas de formato JSON:
- Los valores de "term" y "explanation" deben contener texto limpio y legible.
- NO uses puntuación extraña como "))", "((", ni símbolos LaTeX sin contexto.
- NO añadas dos puntos ":" al final del campo "term". El frontend gestiona el formato visual.
- Devuelve ÚNICAMENTE un JSON válido. Sin ningún texto adicional fuera del JSON."""

_GLOBAL_GEN_CONFIG = genai.GenerationConfig(
    response_mime_type="application/json",
    response_schema=GlobalMapping,
)


def _build_global_model(language: str, keep_terms_in_english: bool) -> genai.GenerativeModel:
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
    return genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        generation_config=_GLOBAL_GEN_CONFIG,
        system_instruction=GLOBAL_MAPPING_PROMPT + extra,
    )


_explain_model = genai.GenerativeModel(
    model_name="gemini-2.5-flash-lite",
    generation_config=genai.GenerationConfig(
        response_mime_type="application/json",
        response_schema=ExplainResponse,
    ),
    system_instruction=EXPLAIN_PROMPT,
)

# ── Extraction helpers ────────────────────────────────────────────────────────

_CLOSING_PUNCT       = frozenset('.!?…')
_HEADER_FOOTER_MARGIN = 0.08
_TITLE_PAGE_MARGIN   = 0.22     # top exclusion on page 1 to skip title/authors
_MIN_WORDS           = 5
_INDENT_THRESHOLD    = 15.0     # pt: x0 delta that signals a new indented paragraph
_TITLE_FONT_RATIO    = 1.5      # block avg font > page median × this → skip on page 1

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
    if not sizes:
        return 10.0
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


def _split_by_indent(block: dict) -> list[tuple]:
    """Split a get_text('dict') block into (x0,y0,x1,y1,text) by line indentation."""
    lines = block.get("lines", [])
    if not lines:
        return []
    std_x0 = min(ln["bbox"][0] for ln in lines)
    result, cur_texts, cur_bbox = [], [], None
    for ln in lines:
        lx0, ly0, lx1, ly1 = ln["bbox"]
        line_text = " ".join(s.get("text", "") for s in ln.get("spans", [])).strip()
        if not line_text:
            continue
        if cur_texts and (lx0 - std_x0) > _INDENT_THRESHOLD:
            result.append((*cur_bbox, " ".join(cur_texts)))
            cur_texts, cur_bbox = [], None
        cur_texts.append(line_text)
        if cur_bbox is None:
            cur_bbox = (lx0, ly0, lx1, ly1)
        else:
            cur_bbox = (min(cur_bbox[0], lx0), min(cur_bbox[1], ly0),
                        max(cur_bbox[2], lx1), max(cur_bbox[3], ly1))
    if cur_texts:
        result.append((*cur_bbox, " ".join(cur_texts)))
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
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{file.content_type}'. Only PDF files accepted.",
        )

    dest = UPLOADS_DIR / file.filename
    if dest.exists() and not overwrite:
        raise HTTPException(status_code=409, detail=f"'{file.filename}' already exists.")

    contents = await file.read()

    # Save PDF to disk
    dest.write_bytes(contents)

    try:
        doc = fitz.open(stream=contents, filetype="pdf")
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Could not parse PDF: {str(e)}")

    if doc.page_count == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="PDF has no pages.")

    pages_data: list[PageBlocks] = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        page_h = page.rect.height
        top_limit = page_h * (_TITLE_PAGE_MARGIN if page_num == 0 else _HEADER_FOOTER_MARGIN)
        bot_limit = page_h * (1.0 - _HEADER_FOOTER_MARGIN)

        raw = page.get_text("dict")
        dict_blocks = raw.get("blocks", [])
        median_size = _page_median_font_size(dict_blocks)

        # Pass 1: filter noise + split by indentation
        candidates: list[tuple] = []
        for block in dict_blocks:
            if block.get("type") != 0:
                continue
            _, by0, _, by1 = block["bbox"]
            if by0 < top_limit or by1 > bot_limit:
                continue
            if page_num == 0 and _block_avg_font_size(block) > median_size * _TITLE_FONT_RATIO:
                continue
            for sx0, sy0, sx1, sy1, text in _split_by_indent(block):
                clean = text.strip()
                if not clean or _is_junk_section(clean):
                    continue
                if len(clean.split()) < _MIN_WORDS and not _looks_like_section_title(clean):
                    continue
                candidates.append((sx0, sy0, sx1, sy1, clean))

        # Pass 2: merge broken paragraphs (double-column splits)
        blocks: list[ParagraphBlock] = []
        i = 0
        while i < len(candidates):
            x0, y0, x1, y1, text = candidates[i]
            if not _looks_like_section_title(text):
                while not _ends_sentence(text) and i + 1 < len(candidates):
                    if _looks_like_section_title(candidates[i + 1][4]):
                        break
                    i += 1
                    nx0, ny0, nx1, ny1, ntext = candidates[i]
                    text = f"{text} {ntext}"
                    x0, y0 = min(x0, nx0), min(y0, ny0)
                    x1, y1 = max(x1, nx1), max(y1, ny1)
            blocks.append(ParagraphBlock(
                text=text,
                bbox=BBox(x0=round(x0, 2), y0=round(y0, 2),
                          x1=round(x1, 2), y1=round(y1, 2)),
            ))
            i += 1

        pages_data.append(PageBlocks(page=page_num + 1, blocks=blocks))

    doc.close()

    full_text = "\n\n".join(b.text for p in pages_data for b in p.blocks)

    try:
        model = _build_global_model(language, keep_terms_in_english)
        response = model.generate_content(full_text)
        global_map = GlobalMapping(**json.loads(response.text))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")

    result = UploadResponse(
        filename=file.filename,
        page_count=len(pages_data),
        global_map=global_map,
        pages=pages_data,
    )

    # Persist analysis alongside PDF
    analysis_path = UPLOADS_DIR / f"{file.filename}.analysis.json"
    analysis_path.write_text(
        json.dumps(result.model_dump(), ensure_ascii=False),
        encoding="utf-8",
    )

    return JSONResponse(content=result.model_dump())


@app.post("/explain-paragraph/")
async def explain_paragraph(req: ExplainRequest):
    prompt = (
        f"Mapa Global del paper:\n{json.dumps(req.global_map, ensure_ascii=False)}"
        f"\n\nPárrafo a explicar:\n{req.paragraph_text}"
    )
    try:
        response = _explain_model.generate_content(prompt)
        return json.loads(response.text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")
