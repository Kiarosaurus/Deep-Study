import json
import os

import fitz
import google.generativeai as genai
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv()

_api_key = os.getenv("GEMINI_API_KEY")
if not _api_key:
    raise RuntimeError("GEMINI_API_KEY environment variable not set")

genai.configure(api_key=_api_key)

GLOBAL_MAPPING_PROMPT = """Rol: Eres un asistente de investigación académica experto integrado en una interfaz de lectura inmersiva.

Contexto Global del Documento: {AQUÍ_INYECTARAS_EL_GLOBAL_MAP}
Texto a analizar: {AQUÍ_INYECTARAS_EL_PARAGRAPH_TEXT}

Tarea: Analiza el texto proporcionado. Tu objetivo es explicar ÚNICAMENTE los conceptos complejos, jerga técnica o acrónimos presentes en este párrafo específico que NO estén ya definidos de forma clara en el propio texto. Usa el "Contexto Global" como base para tus explicaciones.

Instrucciones Estrictas:

NO uses lenguaje conversacional. NO digas "En esta línea se intenta decir..." ni uses frases introductorias.

Devuelve tu respuesta ÚNICAMENTE como un objeto JSON válido con esta estructura:
{ "explanations": [{"term": "Concepto o Acrónimo extraído del párrafo", "explanation": "Explicación directa, técnica y concisa de máximo 3 oraciones."}] }

Si el párrafo es simple y no requiere explicaciones adicionales, devuelve una lista vacía en "explanations"."""


class Acronym(BaseModel):
    term: str
    definition: str


class GlobalMapping(BaseModel):
    acronyms: list[Acronym]
    core_methodology: str
    assumed_concepts: list[str]


# ── Spatial extraction ───────────────────────────────────────────────────────

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


# ── Pasada 2: Explicación Local ──────────────────────────────────────────────

class ExplainRequest(BaseModel):
    paragraph_text: str
    global_map: dict


class TermExplanation(BaseModel):
    term: str
    explanation: str


class ExplainResponse(BaseModel):
    explanations: list[TermExplanation]


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


@app.get("/")
def root():
    return {"status": "ok", "message": "DeepStudy API running"}


@app.post("/upload-pdf/")
async def upload_pdf(
    file: UploadFile = File(...),
    language: str = Form("es"),
    keep_terms_in_english: bool = Form(False),
):
    if file.content_type != "application/pdf":
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{file.content_type}'. Only PDF files accepted.",
        )

    contents = await file.read()

    try:
        doc = fitz.open(stream=contents, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not parse PDF: {str(e)}")

    if doc.page_count == 0:
        raise HTTPException(status_code=422, detail="PDF has no pages.")

    # Minimum chars to discard page numbers, headers, isolated labels
    MIN_BLOCK_CHARS = 30

    pages_data: list[PageBlocks] = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        raw_blocks = page.get_text("blocks")  # (x0,y0,x1,y1,text,block_no,block_type)
        blocks: list[ParagraphBlock] = []
        for x0, y0, x1, y1, text, _block_no, block_type in raw_blocks:
            if block_type != 0:          # skip image blocks
                continue
            clean = text.strip()
            if len(clean) < MIN_BLOCK_CHARS:  # skip noise
                continue
            blocks.append(ParagraphBlock(
                text=clean,
                bbox=BBox(x0=round(x0, 2), y0=round(y0, 2),
                          x1=round(x1, 2), y1=round(y1, 2)),
            ))
        pages_data.append(PageBlocks(page=page_num + 1, blocks=blocks))

    doc.close()

    full_text = "\n\n".join(
        b.text for p in pages_data for b in p.blocks
    )

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
