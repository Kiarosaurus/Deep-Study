# DeepStudy

Immersive reader for scientific papers. A FastAPI backend processes PDFs through Marker (Surya layout-detection models that classify `Text`, `SectionHeader`, `Caption`, `Figure`, and related block types) and builds paragraphs plus per-sentence bounding boxes from the lines Marker already extracts. Gemini produces a global document map and contextual per-paragraph explanations. The frontend is built with Vite and React 19 using `react-pdf` for rendering.

The pipeline applies the following filters automatically: the document title, author and affiliation blocks (including the case in which Marker mislabels them as `SectionHeader`), DOI / ISBN / `Permission to make` notices, `CCS Concepts` / `Keywords` / `Index Terms` sections, `PageHeader`, `PageFooter`, `Footnote`, `Reference`, and every block that appears after `Acknowledgments` / `References` / `Bibliography`. License and copyright boilerplate (Creative Commons / CC BY variants, "licensed under …", `creativecommons.org` URLs, `© 2024 …`, `Copyright held by …`) is dropped on every page, not just page 1, so per-page license footers never reach paragraph analysis.

## Stack

- **Backend:** Python 3.12, FastAPI, Uvicorn, Marker (`marker-pdf`, Surya models), google-genai
- **Frontend:** React 19, Vite 8, TailwindCSS 4, axios, react-pdf, react-router-dom
- **AI:** Gemini `gemini-3.1-flash-lite` (used for both global mapping and per-paragraph explanations)

## Requirements

- Python 3.12+
- Node.js 18+ and npm
- A Google Gemini API key ([get one here](https://aistudio.google.com/apikey))

## Installation

### 1. Clone the repository

```bash
git clone <repo-url> DeepStudy
cd DeepStudy
```

### 2. Backend

Create the virtual environment and install dependencies:

```bash
python3 -m venv venv
source venv/bin/activate          # Linux/WSL/macOS
# .\venv\Scripts\Activate.ps1     # Windows PowerShell
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in your Gemini API key:

```bash
cp .env.example .env
# then edit .env and set GEMINI_API_KEY=your_api_key_here
```

`.env.example` documents every variable the project consumes (required, optional backend, optional frontend build-time, and advanced Marker/Surya tunables). Only `GEMINI_API_KEY` is mandatory; the rest fall back to sensible defaults.

### 3. Frontend

```bash
cd frontend
npm install
cd ..
```

## Running the project

You can run everything with a single Docker command, or run the backend and frontend manually in two terminals.

### Option A — Docker (single command)

Requirements: Docker Engine 24+ and the Docker Compose plugin (`docker compose`). A `.env` file with `GEMINI_API_KEY=...` must exist at the project root.

```bash
docker compose up --build
```

This builds two images (`deepstudy-backend`, `deepstudy-frontend`) and starts both services:

- Backend on <http://localhost:8000>
- Frontend on <http://localhost:5173>

`uploads/` is bind-mounted from the host so PDFs and `*.analysis.json` files persist across `docker compose down`. The Surya / HuggingFace model cache (~2 GB downloaded on first run) is kept in a named volume `marker-cache` so subsequent runs reuse it.

Stop with `Ctrl+C` (or `docker compose down` from another terminal). Rebuild after dependency changes with `docker compose up --build`.

**Optional env overrides** (set in `.env` or via `export` before `docker compose up`; see `.env.example` for the full annotated list including advanced Marker/Surya tunables):

| Variable | Default | Effect |
|----------|---------|--------|
| `DEEPSTUDY_LOG_LEVEL` | `INFO` | Backend log verbosity (`DEBUG`, `INFO`, `WARNING`, ...) |
| `DEEPSTUDY_EXTRACT_PARALLEL` | `1` | How many Marker extractions can run in parallel |
| `DEEPSTUDY_CONT_DEBUG` | `0` | `1` to trace continuation-paragraph merge decisions |
| `VITE_FLAG_SENTENCE` | unset | `1` to bake `flag_sentence` diagnostic logging into the frontend build |

**Notes**

- First build takes 5–10 minutes (torch + marker-pdf + Surya weights). Subsequent builds are fast thanks to layer caching.
- The frontend container serves the built bundle through nginx and proxies `/api/*` to the `backend` service via compose DNS — no CORS configuration needed.
- GPU is **not** enabled by default. Backend runs Marker on CPU. To enable CUDA, base `Dockerfile` on `nvidia/cuda:12.x-runtime-ubuntu22.04`, install Python on top, and add `deploy.resources.reservations.devices` for the backend service.

### Option B — Manual (two terminals)

#### Terminal 1 — Backend (port 8000)

```bash
cd DeepStudy
source venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Confirm the service is reachable: <http://localhost:8000/> should return `{"status": "ok", "message": "DeepStudy API running"}`.

#### Terminal 2 — Frontend (port 5173)

```bash
cd DeepStudy/frontend
npm run dev
```

Open <http://localhost:5173> in the browser.

## Main endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | Health check |
| `GET`  | `/documents/` | Lists uploaded PDFs |
| `GET`  | `/documents/{filename}` | Downloads the PDF |
| `GET`  | `/documents/{filename}/analysis` | Returns the cached analysis JSON |
| `DELETE` | `/documents/{filename}` | Deletes the PDF and its analysis |
| `POST` | `/upload-pdf/` | Uploads and analyzes a PDF |
| `POST` | `/explain-paragraph/` | Explains the concepts contained in a paragraph |

### Parameters for `/upload-pdf/` (multipart/form-data)

- `file` (PDF, required)
- `language` — `"es"` (default) or `"en"`
- `keep_terms_in_english` — `true` to retain acronyms and assumed concepts in English
- `overwrite` — `true` to replace an existing document with the same filename

Interactive API docs: <http://localhost:8000/docs>

## Project structure

```
DeepStudy/
├── main.py              # FastAPI application (routes + Gemini calls)
├── extraction.py        # Marker-based PDF layout extraction pipeline
├── models.py            # Pydantic models shared across endpoints
├── requirements.txt
├── Dockerfile           # Backend image
├── docker-compose.yml   # Orchestrates backend + frontend
├── .dockerignore
├── .env                 # GEMINI_API_KEY (not committed)
├── .env.example         # Annotated template for .env (committed)
├── uploads/             # Persisted PDFs and analysis JSON files
├── venv/                # Python virtual environment (gitignored)
└── frontend/
    ├── package.json
    ├── Dockerfile       # Multistage build → nginx
    ├── nginx.conf       # SPA + /api proxy to backend service
    ├── .dockerignore
    ├── src/
    └── node_modules/    # (gitignored)
```

## Notes

- Uploaded PDFs and their analyses are stored under `uploads/`. The analysis is cached as `<filename>.analysis.json` to avoid redundant Gemini calls.
- If the frontend (5173) cannot reach the backend (8000) because of CORS, add `CORSMiddleware` to `main.py`:
  ```python
  from fastapi.middleware.cors import CORSMiddleware
  app.add_middleware(
      CORSMiddleware,
      allow_origins=["http://localhost:5173"],
      allow_methods=["*"],
      allow_headers=["*"],
  )
  ```
- On WSL, access the frontend from Windows via `http://localhost:5173` (automatic port forwarding).
