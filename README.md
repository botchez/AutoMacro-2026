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

## Prerequisites

- Python 3.11+ (developed on 3.13)
- Node.js 18+ with npm

## Quick start (one command)

From the project root:

```powershell
.\run.ps1
```

That's it. `run.ps1` creates the virtualenv, installs the Python and npm
dependencies if they're missing, builds the frontend, and serves the whole app
(API + UI) from a single process. Open `http://localhost:8000`.

If PowerShell blocks the script with an execution-policy error, run it as:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

For hot-reloading development (API on `:8000`, Vite dev server on `:5173`):

```powershell
.\run.ps1 -Dev
```

The seeded demo login is `demo@nutricoach.app` / `demo1234`, and API
documentation is at `/api/docs`. The app runs fully without any API keys — see
[Configuration](#configuration) to enable the AI stages.

## Manual setup

If you'd rather not use `run.ps1`, the underlying steps are:

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

## Configuration

Copy `.env.example` to `.env` or set environment variables in your runtime.
`OPENROUTER_API_KEY` enables both model stages; `USDA_FDC_API_KEY` (aka
`FDC_API_KEY`) adds authoritative macros for generic ingredients. All are optional —
the app remains usable without them via its deterministic fallbacks.

## Test

```powershell
python -m unittest discover -s tests
npm run build
```
