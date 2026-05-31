# DeepStudy

> An immersive reader for scientific papers that turns a raw PDF into a structured, sentence-aware document and layers AI-generated context on top of every paragraph, figure, and table — so you understand the *background the authors assumed you already had*, not just a translation of what's on the page.

DeepStudy ingests a research PDF, reconstructs its true reading order and layout
with on-device layout-detection models, and uses Google Gemini to build a
**global document map** plus **deep, on-demand explanations** anchored to exact
sentence bounding boxes. The frontend renders the original PDF with a custom
text/highlight layer (and an optional reflowed "linear" reader), so the AI's
explanations are visually pinned to the precise lines they describe.

---

## Key Features

- **Structure-aware PDF extraction.** Marker + Surya layout models classify every
  block (`Text`, `SectionHeader`, `Caption`, `Figure`, `Table`, …) and the
  pipeline walks the document structure directly — yielding **line-level
  polygons and per-sentence bounding boxes** without a second PDF parse.
- **Aggressive noise filtering.** Titles, authors/affiliations, DOI/ISBN and
  copyright boilerplate, `CCS Concepts` / `Keywords` sections, page headers/footers,
  references, and everything after `Acknowledgments` / `References` are dropped
  before any text reaches the model — on *every* page, not just page 1.
- **Cross-page & cross-column paragraph fusion.** A two-rule heuristic stitches
  paragraphs that continue across page/column breaks so explanations operate on
  complete logical units, not visual fragments.
- **Callout, caption & footnote handling.** Boxed/shaded callouts are detected
  and excluded from merges; figure captions are absorbed into their image's hover
  region; symbol-marked footnotes (`* † ‡ § ¶`) are linked to the citing
  paragraph and fed into its explanation as labeled context.
- **Two-tier Gemini analysis.** One pass builds a global map (acronyms, core
  methodology, assumed concepts); a per-paragraph pass returns concept-level
  explanations with **exact verbatim quotes and sentence indices** for precise
  highlighting, plus narrative paragraph context.
- **Multimodal figure/table explanations.** For figures, tables, and algorithms
  the backend rasterizes the source bbox with PyMuPDF/pdfium and sends the image
  to Gemini's multimodal endpoint.
- **Resilient, self-tuning extraction (the standout).** Extraction runs in an
  isolated subprocess with an **adaptive batch-size + chunked fallback ladder**
  driven by live RAM/VRAM probing — survives OOM kills, downgrades GPU→CPU
  automatically, and persists a per-machine cost profile that refines over time.
- **Immersive reader UI.** Native PDF rendering with a custom selectable text
  layer and annotation/highlight overlay, an optional reflowed linear reader,
  3-mode theming (normal / sepia / soft-dark with a PDF canvas filter), and
  trilingual UI (English / Español / 繁體中文).
- **Streaming progress & on-disk caching.** Uploads return immediately (HTTP 202)
  and report extraction progress over Server-Sent Events; results are cached as
  `<file>.analysis.json` so a reopened document never re-hits Gemini.

---

## Tech Stack & Architecture

| Layer | Technologies |
|-------|--------------|
| **Backend** | Python 3.12, FastAPI, Uvicorn (async + SSE streaming) |
| **PDF / Layout** | `marker-pdf` + Surya layout-detection models, PyMuPDF, `pypdfium2` (crop rasterization) |
| **AI** | Google Gemini `gemini-3.1-flash-lite` (text global-map + per-paragraph explain, and multimodal figure/table explain) via `google-genai` |
| **Concurrency / Resilience** | `subprocess` worker isolation, `threading.Semaphore` extraction gate, `asyncio` SSE, `psutil` resource probing |
| **Frontend** | React 19, Vite 8, TailwindCSS 4, `pdfjs-dist` (custom text + annotation layers), React Router 7, axios |
| **Validation** | Pydantic models shared across all endpoints |
| **Packaging** | Docker + Docker Compose (multi-stage frontend build → nginx with `/api` reverse proxy) |

### How it fits together

```
            ┌──────────── Frontend (React 19 / Vite / pdfjs) ────────────┐
            │  Home (upload)  ·  Reader (PDF + highlight)  ·  Linear      │
            └───────────────────────────┬───────────────────────────────┘
                              HTTP / SSE │  (nginx /api proxy in Docker)
            ┌───────────────────────────▼───────────────────────────────┐
            │                  FastAPI app  (main.py)                     │
            │   /upload-pdf  ·  SSE events  ·  /explain-paragraph  ·  docs │
            └───────┬───────────────────────────────────┬────────────────┘
        threadpool  │ semaphore-gated                    │ Gemini (google-genai)
            ┌───────▼────────────┐               ┌────────▼─────────┐
            │ extraction_runner  │  subprocess   │  global map +    │
            │  (fallback ladder) ├──────────────►│  per-¶ explains  │
            │  batch_planner     │ marker_worker │  multimodal fig  │
            │  runtime_metrics   │ (Marker/Surya)│                  │
            └────────────────────┘               └──────────────────┘
                     │ writes
                     ▼
            uploads/<file>.pdf  +  <file>.analysis.json   (cached result)
```

**Why the subprocess boundary matters:** Marker/Surya read their `*_BATCH_SIZE`
env vars only at model-init time, so the parent process cannot retune them once
`marker` is imported. `extraction_runner.py` spawns a fresh interpreter per
attempt — letting `batch_planner.py` pick a new batch (sized against current
free RAM/VRAM) on every retry, and letting the parent detect a hard OOM kill
(exit codes 137/138) and fall back: smaller batch → CPU pass → page-chunked
sub-PDFs → `ExtractionFailed`. Observed peak memory is written back into a
persisted `MachineProfile` so the cost model self-corrects across runs.

---

## Prerequisites

- **Python** 3.12+
- **Node.js** 18+ and npm
- A **Google Gemini API key** — <https://aistudio.google.com/apikey>
- *(Docker path)* Docker Engine 24+ with the Compose plugin
- *(Optional)* NVIDIA GPU + Container Toolkit for CUDA acceleration — CPU is the default

> First run downloads ~2 GB of Surya/HuggingFace model weights (cached afterward).

---

## Installation

### 1. Clone

```bash
git clone https://github.com/Kiarosaurus/Deep-Study.git DeepStudy
cd DeepStudy
```

### 2. Configure environment

```bash
cp .env.example .env
# edit .env and set GEMINI_API_KEY=your_key_here
```

Only `GEMINI_API_KEY` is mandatory. `.env.example` documents every other knob
(log level, extraction parallelism, frontend diagnostics, and advanced
Marker/Surya batch tunables) — all with sensible defaults.

### 3a. Run with Docker (single command — recommended)

```bash
docker compose up --build
```

- Backend → <http://localhost:8000>
- Frontend → <http://localhost:5173>

`uploads/` is bind-mounted so PDFs and `*.analysis.json` survive `docker compose down`.
The model cache lives in the named volume `marker-cache`. The frontend container
serves the built bundle via nginx and proxies `/api/*` to the backend over
Compose DNS — **no CORS setup needed**. First build takes 5–10 min (torch +
marker-pdf); later builds are layer-cached.

### 3b. Run manually (two terminals)

**Backend:**

```bash
python3 -m venv venv
source venv/bin/activate          # Linux/WSL/macOS
# .\venv\Scripts\Activate.ps1     # Windows PowerShell
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Health check: <http://localhost:8000/> → `{"status":"ok","message":"DeepStudy API running"}`

**Frontend:**

```bash
cd frontend
npm install
npm run dev          # → http://localhost:5173
```

### Optional environment overrides

| Variable | Default | Effect |
|----------|---------|--------|
| `DEEPSTUDY_LOG_LEVEL` | `INFO` | Backend log verbosity (`DEBUG`/`INFO`/`WARNING`/…) |
| `DEEPSTUDY_EXTRACT_PARALLEL` | `1` | Concurrent Marker extractions (raise only with large RAM/VRAM) |
| `DEEPSTUDY_CONT_DEBUG` | `0` | `1` traces continuation-paragraph merge decisions |
| `VITE_FLAG_SENTENCE` | unset | `1` bakes highlight-resolution diagnostics into the frontend build |
| `TORCH_DEVICE` | auto | Force `cuda` / `mps` / `cpu` (otherwise auto-detected) |

---

## Usage

### Web flow

1. Open <http://localhost:5173>, upload a PDF, pick the explanation language
   (`es` / `en` / `zh-Hant`) and whether to keep technical terms in English.
2. Watch live extraction progress (SSE). On completion the reader opens.
3. Click any paragraph, figure, or table to fetch its AI explanation — highlights
   are pinned to the exact sentences/regions described.

### API

Interactive docs (Swagger): <http://localhost:8000/docs>

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/documents/` | List uploaded PDFs |
| `GET` | `/documents/{filename}` | Download the PDF |
| `GET` | `/documents/{filename}/analysis` | Cached analysis JSON |
| `DELETE` | `/documents/{filename}` | Delete PDF + its analysis |
| `POST` | `/upload-pdf/` | Upload & analyze (returns `202 {job_id, filename}`) |
| `GET` | `/upload-pdf/{job_id}/events` | SSE stream of extraction progress |
| `POST` | `/explain-paragraph/` | Explain a paragraph / figure / table |

**Upload a PDF** (`multipart/form-data`): `file` (required), `language`
(`es` default / `en` / `zh-Hant`), `keep_terms_in_english` (bool),
`overwrite` (bool).

```bash
curl -X POST http://localhost:8000/upload-pdf/ \
  -F "file=@paper.pdf" \
  -F "language=en" \
  -F "keep_terms_in_english=true"
# → {"job_id":"<uuid>","filename":"paper.pdf"}
```

**Follow progress** over Server-Sent Events:

```bash
curl -N http://localhost:8000/upload-pdf/<job_id>/events
# data: {"phase":"global_map_started","message":"..."}
# data: {"phase":"done","filename":"paper.pdf"}
```

**Explain a paragraph** (sentence-segmented + global map for grounding):

```bash
curl -X POST http://localhost:8000/explain-paragraph/ \
  -H "Content-Type: application/json" \
  -d '{
        "paragraph_sentences": ["Recent MEMS resonators reach GHz frequencies.",
                                 "They operate at low power."],
        "global_map": { "acronyms": [], "core_methodology": "",
                        "assumed_concepts": [] },
        "language": "en"
      }'
```

Returns `sentence_explanations` (each with `sentence_indices`, a verbatim
`quote`, and a list of `concepts`) plus a `paragraph_context` block — enough for
the frontend to resolve and highlight the exact spans.

---

## Project Structure

```
DeepStudy/
├── main.py                 # FastAPI app: routes, Gemini calls, SSE, prompts
├── extraction.py           # Marker layout walk → paragraphs + sentence bboxes
├── extraction_runner.py    # Subprocess orchestration + fallback ladder
├── batch_planner.py        # Adaptive batch size & chunk planning from RAM/VRAM
├── marker_worker.py        # Marker child-process entrypoint (per-attempt env)
├── runtime_metrics.py      # Resource probing + persisted MachineProfile
├── jobs.py                 # In-memory job registry + SSE event queues
├── models.py               # Pydantic schemas shared across endpoints
├── requirements.txt
├── Dockerfile              # Backend image
├── docker-compose.yml      # backend + frontend orchestration
├── .env.example            # Annotated config template
├── uploads/                # Persisted PDFs + <file>.analysis.json cache
└── frontend/               # React 19 / Vite / Tailwind SPA
    ├── nginx.conf          # SPA fallback + /api → backend proxy
    └── src/
        ├── pages/          # Home, Reader, LinearReaderTest
        ├── components/     # PdfViewer, TextLayer, AnnotationLayer, LinearReader…
        ├── theme/          # 3-mode theme context + toggle
        └── i18n/           # en / es / zh-Hant translations
```

---

## Notes

- Analyses are cached as `uploads/<filename>.analysis.json` to avoid redundant
  Gemini calls; deleting the PDF removes its analysis too.
- A disconnecting SSE client does **not** cancel a running extraction — the
  result still lands on disk and is reachable via `/documents/{filename}/analysis`.
- GPU is off by default. To enable CUDA in Docker, base the backend `Dockerfile`
  on an `nvidia/cuda` runtime image and add a GPU device reservation for the
  backend service.
- On WSL, reach the frontend from Windows at <http://localhost:5173> (automatic
  port forwarding).
```
