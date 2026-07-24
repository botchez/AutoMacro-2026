# NutriCoach

NutriCoach runs as one FastAPI service with one SQLite database. The React app is
a client-only Vite build served by FastAPI, so production uses one process, one
port, and same-origin `/api` calls.

## What is included

- SQLite-backed accounts, goals, meal logs, coach history, vision cache, and FDC
  cache in `data/nutricoach.sqlite3`
- A vision cascade that checks its image cache, uses OpenAI vision when
  configured, falls back safely, and enriches detected foods through USDA FoodData
  Central or local reference data
- A nutrition coach that uses the current user's goals and today's logs, with an
  optional OpenAI stage and a deterministic rule-based fallback
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
`OPENAI_API_KEY` and `USDA_FDC_API_KEY` are optional; the app remains usable
without them.

## Test

```powershell
python -m unittest discover -s tests
npm run build
```
