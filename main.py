import json
import os

import fitz
import google.generativeai as genai
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv()

_api_key = os.getenv("GEMINI_API_KEY")
if not _api_key:
    raise RuntimeError("GEMINI_API_KEY environment variable not set")

genai.configure(api_key=_api_key)

GLOBAL_MAPPING_PROMPT = """Rol: Eres un asistente de investigación académica experto.
Tarea: Vas a recibir el texto completo de un paper científico. Tu objetivo es realizar un "Mapeo Global" del documento y extraer únicamente la información fundamental que un estudiante necesitaría como contexto previo antes de leer el texto línea por línea.

Instrucciones Estrictas: Debes devolver tu respuesta ÚNICAMENTE como un objeto JSON válido, sin texto de relleno antes o después. El JSON debe tener exactamente esta estructura:
{ "acronyms": [{"term": "Acrónimo", "definition": "Definición exacta según el texto"}], "core_methodology": "Un párrafo conciso resumiendo el núcleo de la metodología del paper.", "assumed_concepts": ["Concepto 1", "Concepto 2"] }

Notas: Extrae absolutamente todos los acrónimos utilizados en el documento y su significado. El núcleo de la metodología debe ser un párrafo resumido. Los assumed_concepts son los conceptos clave que el paper asume como sabidos por el lector."""


class Acronym(BaseModel):
    term: str
    definition: str


class GlobalMapping(BaseModel):
    acronyms: list[Acronym]
    core_methodology: str
    assumed_concepts: list[str]


_gemini_model = genai.GenerativeModel(
    model_name="gemini-2.5-flash",
    generation_config=genai.GenerationConfig(
        response_mime_type="application/json",
        response_schema=GlobalMapping,
    ),
    system_instruction=GLOBAL_MAPPING_PROMPT,
)

app = FastAPI(title="DeepStudy API", version="0.1.0")


@app.get("/")
def root():
    return {"status": "ok", "message": "DeepStudy API running"}


@app.post("/upload-pdf/")
async def upload_pdf(file: UploadFile = File(...)):
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

    pages = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        text = page.get_text("text")
        pages.append({"page": page_num + 1, "text": text.strip()})

    doc.close()

    full_text = "\n\n".join(p["text"] for p in pages if p["text"])

    try:
        response = _gemini_model.generate_content(full_text)
        global_mapping = json.loads(response.text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")

    return JSONResponse(content=global_mapping)
