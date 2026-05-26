# DeepStudy

Lector inmersivo de papers científicos. Backend FastAPI procesa PDFs con Marker (layout-detection models de Surya: clasifica `Text`, `SectionHeader`, `Caption`, `Figure`, etc.) y construye párrafos + bboxes por oración a partir de las líneas que Marker ya extrae. Gemini genera el mapa global y las explicaciones contextuales. Frontend Vite + React 19 con `react-pdf`.

Filtros aplicados automáticamente al pipeline: título del documento, bloques de autor/afiliación (también cuando Marker los etiqueta como `SectionHeader`), copyright/DOI/ISBN/`Permission to make`, secciones `CCS Concepts` / `Keywords` / `Index Terms`, `PageHeader`, `PageFooter`, `Footnote`, `Reference`, y todo lo posterior a `Acknowledgments` / `References` / `Bibliography`.

## Stack

- **Backend:** Python 3.12, FastAPI, Uvicorn, Marker (`marker-pdf`, modelos Surya), google-genai
- **Frontend:** React 19, Vite 8, TailwindCSS 4, axios, react-pdf, react-router-dom
- **IA:** Gemini (`gemini-3.1-flash-lite` para mapping global, `gemini-2.5-flash-lite` para explicaciones)

## Requisitos

- Python 3.12+
- Node.js 18+ y npm
- API key de Google Gemini ([obtenerla aquí](https://aistudio.google.com/apikey))

## Instalación

### 1. Clonar y entrar al proyecto

```bash
git clone <repo-url> DeepStudy
cd DeepStudy
```

### 2. Backend

Crear venv e instalar dependencias:

```bash
python3 -m venv venv
source venv/bin/activate          # Linux/WSL/macOS
# .\venv\Scripts\Activate.ps1     # Windows PowerShell
pip install -r requirements.txt
```

Crear archivo `.env` en la raíz del proyecto:

```env
GEMINI_API_KEY=tu_api_key_aqui
```

### 3. Frontend

```bash
cd frontend
npm install
cd ..
```

## Cómo correr el proyecto

Necesitas **dos terminales** abiertas simultáneamente.

### Terminal 1 — Backend (puerto 8000)

```bash
cd DeepStudy
source venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Verifica que esté corriendo: <http://localhost:8000/> debe responder `{"status": "ok", "message": "DeepStudy API running"}`.

### Terminal 2 — Frontend (puerto 5173)

```bash
cd DeepStudy/frontend
npm run dev
```

Abre <http://localhost:5173> en el navegador.

## Endpoints principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/` | Health check |
| `GET`  | `/documents/` | Lista PDFs subidos |
| `GET`  | `/documents/{filename}` | Descarga el PDF |
| `GET`  | `/documents/{filename}/analysis` | Devuelve el análisis JSON |
| `DELETE` | `/documents/{filename}` | Elimina PDF + análisis |
| `POST` | `/upload-pdf/` | Sube y analiza un PDF |
| `POST` | `/explain-paragraph/` | Explica conceptos de un párrafo |

### Parámetros de `/upload-pdf/` (multipart/form-data)

- `file` (PDF, obligatorio)
- `language` — `"es"` (default) o `"en"`
- `keep_terms_in_english` — `true` para mantener acrónimos y conceptos asumidos en inglés
- `overwrite` — `true` para sobrescribir si ya existe

Docs interactivos: <http://localhost:8000/docs>

## Estructura

```
DeepStudy/
├── main.py              # Backend FastAPI completo
├── requirements.txt
├── .env                 # GEMINI_API_KEY (no commitear)
├── uploads/             # PDFs y análisis JSON persistidos
├── venv/                # Entorno Python (gitignorar)
└── frontend/
    ├── package.json
    ├── src/
    └── node_modules/    # (gitignorar)
```

## Notas

- Los PDFs subidos y sus análisis se guardan en `uploads/`. El análisis se cachea como `<filename>.analysis.json` para no re-llamar a Gemini.
- Si el frontend (5173) no logra hablar con el backend (8000) por CORS, agregar `CORSMiddleware` en `main.py`:
  ```python
  from fastapi.middleware.cors import CORSMiddleware
  app.add_middleware(
      CORSMiddleware,
      allow_origins=["http://localhost:5173"],
      allow_methods=["*"],
      allow_headers=["*"],
  )
  ```
- En WSL, accede al frontend desde Windows vía `http://localhost:5173` (port forwarding automático).
