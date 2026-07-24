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
  fallback when no model key is set. Detections are weight-independent (per-100g
  density plus each component's fraction of the plate); the client applies the live
  scale weight, so a result re-prices instantly as the portion changes
- A nutrition coach (`backend/coach/`) that is a real tool-calling agent: it reads
  today's totals vs target (with a tolerance band), the just-logged batch, the user's
  eating history, the time of day, and its own last tip before advising. The chat is a
  persistent conversation scoped to the local day — it appends coaching as you log and
  starts fresh each new day — and its live tool calls stream to the UI as it works.
  There is no canned fallback: if the OpenRouter key is missing or the agent is switched
  off, it fails loud (HTTP 502) instead of faking a reply
- The coach's notion of "today" is the client's LOCAL date, so it always matches the
  meal log and dashboard regardless of the server's timezone
- Both model stages run through a single OpenRouter key. Vision degrades gracefully to
  its deterministic filename fallback with no key; the coach instead requires the key
  plus `COACH_AGENT_ENABLED` and surfaces a clear error when either is missing
- Atomic meal and item writes
- A client-only Vite + React + Tailwind + shadcn UI: scan/upload or barcode a plate,
  edit any portion — logged foods included — with macros recomputed live from the
  stored per-100g density, and log the coach's sidebar suggestions through a quick
  portion modal
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
`OPENROUTER_API_KEY` enables both model stages; `USDA_FDC_API_KEY` (aka `FDC_API_KEY`)
adds authoritative macros for generic ingredients. The vision + logging flows remain
usable without any keys via their deterministic fallbacks. The coach agent is the
exception: it needs `OPENROUTER_API_KEY` and `COACH_AGENT_ENABLED` (on by default; set
it to `0` to switch the coach's model calls off) and returns a clear 502 when either is
missing rather than a canned reply.

## Demo data

The startup seed creates the demo login on a fresh database, but only fills past days.
To load a richer, present-ready state — meals across the last few days **including
today**, using local dates so the dashboard, macros, and coach all have live data — run
from the repo root:

```powershell
python -m backend.seed --reset
```

`--reset` wipes the demo user's existing meals first, so the command is repeatable — run
it before each demo to return to the same known state. Without `--reset` it never
duplicates meals: if the demo user already has meals it leaves them and tells you to use
`--reset`. It is safe to run while the server is up (SQLite WAL) — just refresh the app.
Today is left partly logged on purpose so the coach has a gap to coach.

The coach panel's **Test time** control simulates any hour (0–23), so you can demo
time-of-day coaching without waiting for the real clock.

## Test

```powershell
python -m unittest discover -s tests
npm run build
```
