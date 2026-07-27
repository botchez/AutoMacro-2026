# NutriCoach

Point a camera at a plate, put it on a load cell, and get an accurate macro log.
Then get coached on what to eat next.

NutriCoach pairs a **vision cascade** (barcode → multimodal model → authoritative
nutrition databases) with a **hardware food scale** (ESP32 + HX711 over Web Serial)
and a **tool-calling coach agent** that reads your actual day before it says anything.

It ships as one FastAPI process serving one SQLite database and a pre-built React
bundle, so production is one port and same-origin `/api` calls: no separate node
server, no CORS.

---

## How it works

### 1. Weight comes from hardware, not from the model

The model is **never told the scale weight**. It only names each food and gives each
component a `fraction` (its share of the plate by mass). Every detection is returned
weight-independent as `per_100g` + `fraction`, and the client does
`fraction × grams × per-100g` against the live scale reading.

That means a result **re-prices instantly** as you add or remove food, with no second
model call. It also means the vision cache is keyed on the image alone.

An ESP32 with an HX711 load-cell amp streams one reading per line at 115200 baud
(~10/sec). The browser talks to it directly over the Web Serial API, so there's no
driver and no daemon. Firmware and wiring are in [`hardware_src/scale/scale.ino`](hardware_src/scale/scale.ino);
the client side is [`src/hooks/use-scale.ts`](src/hooks/use-scale.ts). Once you've
authorized the port, it silently reconnects on page load.

The app is fully usable without the scale; type the grams instead.

### 2. The vision cascade (`backend/vision/`)

Cheapest check first, and it always returns a list of components:

| Step                   | What runs                                        | Cost   |
| ---------------------- | ------------------------------------------------ | ------ |
| 1. Image cache         | SQLite lookup by image sha256                    | free   |
| 2. Barcode decode      | pyzbar, classical CV, local → Open Food Facts   | free   |
| 3. One multimodal call | classifies the frame*and* decomposes the plate | 1 call |

The single model call self-routes, so there is no single-item-vs-plate switch:

- a single food (an apple) → **1 component**
- a readable nutrition label → **1 component**, macros read off the panel (`ocr`)
- a packaged product → **1 component** from Open Food Facts (`barcode`)
- a composed plate → **N components**, one per distinct food, plus oil/sauce as its
  own component when the food looks fried or sauced (the most-missed calories)

Macros for each component then come from the most authoritative source available:
the label's own panel, Open Food Facts, or a USDA FoodData Central lookup. **The
model's own estimate is only a flagged last resort**, and the UI badges every item
with where its numbers came from. Without an API key the cascade degrades to a
deterministic filename fallback, so the log-food flow still works end to end.

### 3. The coach is a real agent (`backend/coach/`)

Not a prompt with the day's totals pasted in, but a tool-calling loop that decides
what it needs to read. Its tools:

`get_today_totals` · `get_target` · `get_day_context` · `get_current_batch` ·
`get_last_suggestion` · `get_recent_logs` · `search_food_history` · `suggest_foods`

So it evaluates **each macro separately** against its own tolerance band (protein is
usually the binding constraint), knows how much of the day is left, checks whether
the batch you just logged already fulfils its previous tip so it doesn't repeat
itself, and names foods **you actually eat** by searching your own history. Its live
tool calls stream into the UI while it works.

Suggestions land in a sidebar and can be logged through a quick portion modal.

---

## Models

Both stages run through a **single OpenRouter key**: one client, one endpoint, and
only the model slug differs.

| Stage  | Default model                  | Requirement                        |
| ------ | ------------------------------ | ---------------------------------- |
| Vision | `google/gemma-4-31b-it`      | must be**multimodal**        |
| Coach  | `deepseek/deepseek-v4-flash` | must support**tool calling** |

Override either with `VISION_MODEL` / `COACH_MODEL`. Vision calls are pinned to the
fastest upstream provider via OpenRouter's `throughput` routing, and the image is
downscaled to 1024px on the long edge for the model call only (the barcode step still
runs on the original bytes). Reasoning is on by default for vision, since it helps
label-OCR digits and packaged-vs-label routing, and can be disabled with
`VISION_REASONING=0` for roughly 2× faster responses.

Set `NUTRICOACH_TRANSCRIPTS=data/transcripts` to write a full human-readable
transcript per run: the system prompt, every model turn including its reasoning, each
tool's inputs and outputs, token usage, and each component's macro source. This is
where the vision "reasoning" lives; it is never in the answer JSON.

---

## Stack

**Backend:** FastAPI, SQLite (WAL), Pydantic, OpenAI SDK wire format pointed at
OpenRouter, pyzbar + Pillow for barcodes.
**Frontend:** React 19, TanStack Router + Query, Tailwind 4, shadcn/ui, Recharts,
Vite 8, TypeScript.
**Hardware:** ESP32-WROOM-32 + HX711 + 4-wire load cell, driven over Web Serial.

---

## Quick start

```powershell
git clone https://github.com/botchez/AutoMacro-2026.git
cd AutoMacro-2026
copy .env.example .env    # then add your OPENROUTER_API_KEY
.\run.ps1
```

`run.ps1` bootstraps the venv and npm deps if missing, builds the frontend, and
serves everything on [http://localhost:8000](http://localhost:8000). Use `.\run.ps1 -Dev` for the API on
`:8000` plus the Vite dev server on `:5173`.

Manual setup, if you'd rather:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm install

npm run dev:api   # FastAPI on :8000
npm run dev       # Vite on :5173, proxies /api

# or the single-process production shape
npm run build
npm start
```

API docs are at `/api/docs`. The seeded demo login is
`demo@nutricoach.app` / `demo1234`.

> **Browser note:** the food scale needs the Web Serial API, so use Chrome or Edge on
> `localhost` or HTTPS. Everything else works in any browser.

### Environment

Copy `.env.example` to `.env`. Nothing is required to boot:

| Variable                                  | Effect if unset                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`                    | Vision falls back to a deterministic filename match;**the coach returns 502**                          |
| `USDA_FDC_API_KEY` (or `FDC_API_KEY`) | Generic ingredients lose authoritative USDA macros ([free key](https://fdc.nal.usda.gov/api-key-signup.html)) |
| `COACH_AGENT_ENABLED`                   | On by default; set`0` to switch the coach's model calls off without touching vision                        |
| `OFF_USER_AGENT`                        | Open Food Facts asks for`AppName/Version (contact)` on reads, so set your own contact if you fork this     |

---

## Demo data

The startup seed creates the demo login on a fresh database but only fills past days.
For a present-ready state, with meals across the last few days **including today** on
local dates so the dashboard, macros, and coach all have live data:

```powershell
python -m backend.seed --reset
```

`--reset` wipes the demo user's meals first, so it's repeatable. Run it before each
demo to return to a known state. Without `--reset` it never duplicates: if the demo
user already has meals it leaves them alone and tells you to use `--reset`. Safe to
run while the server is up (SQLite WAL); just refresh.

Today is left **partly** logged on purpose, so the coach has a gap to coach.

The coach panel's **Test time** control simulates any hour (0–23), so you can demo
time-of-day coaching without waiting for the real clock.

---

## Tests

```powershell
python -m unittest discover -s tests
npm run build     # tsc --noEmit + vite build
npm run lint
```

---

## Layout

```
backend/
  main.py          FastAPI app: auth, logs, vision, coach, SPA fallback
  config.py        settings + .env loading
  db.py            SQLite schema, WAL, transactions
  seed.py          demo user + demo meals (--reset)
  vision/          the cascade: identify.py, foodfacts.py, warm FDC cache
  coach/           the agent: agent.py (tool loop), tools.py, state.py, progress.py
  services/        endpoint adapters over the vision + coach engines
hardware_src/
  scale/scale.ino  ESP32 + HX711 firmware
src/
  routes/          dashboard, log-food, history, settings, onboarding
  hooks/use-scale.ts   Web Serial connection to the scale
  components/      CoachPanel, MacroRing, Mascot, shadcn/ui
tests/
```

SQLite holds accounts, goals, meals and items, coach history, the vision image
cache, and the FDC cache in `data/nutricoach.sqlite3`. Meal and item writes are
atomic.
