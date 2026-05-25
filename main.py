import fitz
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

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

    return JSONResponse(
        content={
            "filename": file.filename,
            "page_count": len(pages),
            "pages": pages,
            "full_text": full_text,
        }
    )
