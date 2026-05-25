import json
import os
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

Devuelve ÚNICAMENTE un JSON válido. Sin texto adicional."""

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

    MIN_BLOCK_CHARS = 30
    pages_data: list[PageBlocks] = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        raw_blocks = page.get_text("blocks")
        blocks: list[ParagraphBlock] = []
        for x0, y0, x1, y1, text, _block_no, block_type in raw_blocks:
            if block_type != 0:
                continue
            clean = text.strip()
            if len(clean) < MIN_BLOCK_CHARS:
                continue
            blocks.append(ParagraphBlock(
                text=clean,
                bbox=BBox(x0=round(x0, 2), y0=round(y0, 2),
                          x1=round(x1, 2), y1=round(y1, 2)),
            ))
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
