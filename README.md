# NutriCoach

NutriCoach runs as one FastAPI service with one SQLite database. The React app is
a client-only Vite build served by FastAPI, so production uses one process, one
port, and same-origin `/api` calls.

## What is included

- SQLite-backed accounts, goals, meal logs, coach history, vision cache, and FDC
  cache in `data/nutricoach.sqlite3`
- A vision cascade (`backend/vision/`) that checks its image cache, decodes any
  barcode (Open Food Facts), then makes one multimodal call that classifies the
  frame and decomposes a plate into components — each priced from the most
  authoritative source available (label OCR, Open Food Facts name search, USDA
  FoodData Central, or a flagged model estimate) — with a deterministic filename
  fallback when no model key is set
- A nutrition coach (`backend/coach/`) that is a real tool-calling agent: it reads
  today's totals vs target (with a tolerance band), the just-submitted batch, the
  user's eating history, the time of day, and its own last suggestion before
  advising, with a deterministic rule-based fallback
- Both model stages run through a single OpenRouter key (the vision cascade and the
  coach agent), so the app degrades gracefully to its deterministic paths with no
  key at all
- Atomic meal and item writes
- A client-only Vite + React + Tailwind + shadcn UI
- FastAPI static hosting with SPA fallback

## Local setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm install
```

For development, run the API and Vite in separate terminals:

```powershell
npm run dev:api
npm run dev
```

Vite proxies `/api` to FastAPI. For the single-process production shape:

```powershell
npm run build
npm start
```

Open `http://localhost:8000`. API documentation is at `/api/docs`.

The seeded demo login is `demo@nutricoach.app` / `demo1234`.

Copy `.env.example` to `.env` or set environment variables in your runtime.
`OPENROUTER_API_KEY` enables both model stages; `USDA_FDC_API_KEY` (aka
`FDC_API_KEY`) adds authoritative macros for generic ingredients. All are optional —
the app remains usable without them via its deterministic fallbacks.

## Test

```powershell
python -m unittest discover -s tests
npm run build
```
