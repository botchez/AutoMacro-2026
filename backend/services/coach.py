"""Coach endpoint adapter.

The real coach is a native tool-calling agent in `backend/coach/` (an OpenRouter
loop, default model deepseek/deepseek-v4-flash). It reads the day's totals, target
(with a tolerance band), history, the just-submitted batch, and its own last message,
then decides where the user stands. The isolated build drove it off an in-memory
CoachState; here we build that same CoachState from the SQLite DB and run the loop.

Two triggers, two prompts:
  * auto  — fired every time the user logs a whole batch of food (message=None). The
            agent coaches the batch with the "just submitted a meal" system prompt.
  * chat  — the user asked the coach a question. The agent answers conversationally
            (a different system prompt) with the recent thread as context.

`reply()` keeps the HTTP contract (`{message, source, recommendations}`) and the
`coach_messages` persistence. There is deliberately NO deterministic fallback: if the
agent can't produce a reply — key missing, agent disabled, model/upstream error, or an
empty result — it raises `CoachUnavailableError` (surfaced as HTTP 502). Masking those
failures behind a plausible template reply made real problems impossible to diagnose,
so the coach now fails loud instead.

The `recommendations` sidebar is agent-driven: it is empty until the coach actually
recommends foods, which it does by calling the suggest_foods tool. Suggestions are
stored per-user in `coach_suggestions` (one row, replaced each run) so the sidebar
survives reloads. A batch-log run always replaces them (an on-track batch clears the
sidebar); a chat run replaces them only when it actually names foods.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime
from uuid import uuid4

from starlette.concurrency import run_in_threadpool

from ..config import settings
from ..coach import CoachState, FoodItem, run_coach
from ..coach import progress
from ..db import utc_now

# Turns a raw tool name from the agent loop into a line the UI can show while the coach
# works, so the user watches it actually call its tools instead of a blank spinner.
_FRIENDLY_STEP = {
    "get_today_totals": "Checking today’s totals",
    "get_target": "Reading your target",
    "get_recent_logs": "Looking at your recent logs",
    "get_current_batch": "Reviewing the meal you logged",
    "search_food_history": "Searching foods you actually eat",
    "get_day_context": "Checking where you are in the day",
    "get_last_suggestion": "Recalling its last tip",
    "suggest_foods": "Choosing foods for your sidebar",
}

# Goals carry no tolerance column; the validated coach expects one. 10% matches the
# isolated build's default and the tech-stack spec's "close enough" band.
DEFAULT_TOLERANCE_PCT = 10.0

# How many prior turns to hand the agent as chat context.
CHAT_HISTORY_TURNS = 8


class CoachUnavailableError(RuntimeError):
    """The coach agent could not produce a reply (misconfig or upstream error).

    Raised instead of silently substituting a canned reply, so the failure is visible
    in the UI (the Test button fails) and the API (HTTP 502) and can be diagnosed.
    """


class CoachService:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    async def reply(
        self, user_id: str, message: str | None = None, today: str | None = None
    ) -> dict:
        """Coach the user. message=None is an auto batch-log trigger; a message is chat.

        `today` is the client's LOCAL date (YYYY-MM-DD) — the same day the meal log and
        dashboard are showing. The coach reads that day rather than deriving one from a
        server clock, so which meals count as "today" always matches what the user sees,
        regardless of the server's timezone."""
        # Resolve the day once and use it everywhere: which meals count as today, and
        # which day this conversation's turns are filed under (the thread is per-day).
        day = self._valid_date(today) or self._local_today()
        state = self._build_state(user_id, day)

        # For chat, capture the thread BEFORE saving the new user turn so the agent
        # sees prior context without the current question duplicated in.
        chat_history = self._recent_turns(user_id, day) if message else []
        if message:
            # Commit the user's turn immediately, in its own transaction, so it's durable
            # the instant they hit send — if they navigate away while the agent runs, the
            # message is still there (and pollable) when they come back.
            self._save(user_id, "user", message, day)
            self.connection.commit()

        if not (settings.openrouter_api_key and settings.coach_agent_enabled):
            raise CoachUnavailableError(
                "coach agent unavailable: "
                + ("OPENROUTER_API_KEY is not set" if not settings.openrouter_api_key
                   else "COACH_AGENT_ENABLED is off")
            )

        # Publish live progress so the UI can show the coach calling its tools. finish()
        # in the finally guarantees the client's status poll flips inactive even on error.
        progress.start(user_id)
        try:
            # No fallback: a failure here raises CoachUnavailableError and rolls back.
            result = await self._agent_reply(
                state, message, chat_history, self._progress_cb(user_id)
            )
            answer = result.text.strip()
            # Preload real macros onto each suggestion so the sidebar "Add" is instant.
            # This may hit the FDC API for foods the user hasn't logged before, so keep it
            # off the event loop.
            progress.add_step(user_id, "Preparing your suggestions")
            suggestions = await run_in_threadpool(
                self._enrich_suggestions, state, list(result.suggestions)
            )
            source = "coach-agent"

            # The coach thread persists for the whole day: a batch-log trigger appends its
            # coaching to the running conversation rather than wiping it, so logging food
            # (including from the sidebar) never resets the chat. The thread naturally
            # rolls over as older turns age out of the history window.
            self._save(user_id, "assistant", answer, day)
            self._apply_suggestions(user_id, message, suggestions)
            # Commit the reply BEFORE progress.finish() so that once the client's status
            # poll sees "inactive", the reply is already readable from history.
            self.connection.commit()
            return {
                "message": answer,
                "source": source,
                "recommendations": self._load_suggestions(user_id),
            }
        finally:
            progress.finish(user_id)

    def _progress_cb(self, user_id: str):
        """A callback for run_coach that turns loop events into live UI steps."""

        def cb(event: dict) -> None:
            kind = event.get("type")
            if kind == "tool":
                progress.add_step(
                    user_id, _FRIENDLY_STEP.get(event.get("name", ""), "Checking your data")
                )
            elif kind == "answer":
                progress.add_step(user_id, "Writing your answer")

        return cb

    def history(self, user_id: str, today: str | None = None, limit: int = 40) -> dict:
        # Only today's turns: the coach thread is scoped per local day, so a new day
        # starts with a clean chat (older turns stay in the DB but aren't surfaced).
        day = self._valid_date(today) or self._local_today()
        rows = self.connection.execute(
            """
            SELECT role, content, created_at
            FROM (
                SELECT role, content, created_at
                FROM coach_messages
                WHERE user_id = ? AND log_date = ?
                ORDER BY created_at DESC
                LIMIT ?
            )
            ORDER BY created_at ASC
            """,
            (user_id, day, limit),
        ).fetchall()
        return {
            "messages": [
                {
                    "role": row["role"],
                    "content": row["content"],
                    "createdAt": row["created_at"],
                }
                for row in rows
            ],
            "recommendations": self._load_suggestions(user_id),
        }

    # --- the validated agent -----------------------------------------------------

    async def _agent_reply(
        self, state: CoachState, message: str | None, chat_history: list, on_step=None
    ):
        """Return the CoachResult (text + suggestions), or raise CoachUnavailableError.

        The underlying model/network error is preserved in the message so it shows up in
        the API response and server logs — no silent swallowing. `on_step` is threaded
        into run_coach so the loop can publish live progress.
        """
        if message:
            trigger, mode, history = message, "chat", chat_history
        else:
            trigger = "The user just logged a batch of food. Coach them on it."
            mode, history = "auto", None
        try:
            # run_coach is synchronous and does model calls with retries/back-off;
            # keep it off the event loop.
            result = await run_in_threadpool(
                run_coach, state, trigger, False, mode, history, on_step
            )
        except Exception as exc:  # noqa: BLE001 - surface the real failure
            raise CoachUnavailableError(f"coach agent error: {exc}") from exc
        text = (result.text or "").strip()
        if not text or text.startswith("(no final advice"):
            raise CoachUnavailableError("coach agent returned no advice")
        self._maybe_write_transcript(result)
        return result

    def _maybe_write_transcript(self, result) -> None:
        if settings.transcripts_dir is None:
            return
        try:
            directory = settings.transcripts_dir
            directory.mkdir(parents=True, exist_ok=True)
            stamp = utc_now().replace(":", "").replace("-", "")[:15]
            (directory / f"{stamp}_coach.md").write_text(
                result.transcript(), encoding="utf-8"
            )
        except Exception:  # noqa: BLE001 - transcript is a nicety, never fail the request
            pass

    def _recent_turns(self, user_id: str, today: str | None = None) -> list[dict]:
        """The last few chat turns of TODAY, oldest first, as OpenAI-format messages.
        Scoped to the local day so the agent doesn't carry yesterday's conversation."""
        day = self._valid_date(today) or self._local_today()
        rows = self.connection.execute(
            """
            SELECT role, content FROM (
                SELECT role, content, created_at
                FROM coach_messages
                WHERE user_id = ? AND log_date = ?
                ORDER BY created_at DESC
                LIMIT ?
            ) ORDER BY created_at ASC
            """,
            (user_id, day, CHAT_HISTORY_TURNS),
        ).fetchall()
        return [{"role": row["role"], "content": row["content"]} for row in rows]

    # --- build the CoachState the agent reads ------------------------------------

    def _build_state(self, user_id: str, today: str | None = None) -> CoachState:
        # The day to coach on: the client's local date when supplied, else the server's
        # local date as a fallback (e.g. a direct API call with no date).
        today = self._valid_date(today) or self._local_today()
        goals = self.connection.execute(
            "SELECT * FROM goals WHERE user_id = ?", (user_id,)
        ).fetchone()
        preferences = self.connection.execute(
            "SELECT activity, allergies FROM user_settings WHERE user_id = ?",
            (user_id,),
        ).fetchone()

        totals_row = self.connection.execute(
            """
            SELECT
              COALESCE(SUM(i.calories), 0) AS kcal,
              COALESCE(SUM(i.protein), 0) AS protein,
              COALESCE(SUM(i.carbs), 0) AS carbs,
              COALESCE(SUM(i.fat), 0) AS fat
            FROM meals m
            JOIN meal_items i ON i.meal_id = m.id
            WHERE m.user_id = ? AND m.log_date = ?
            """,
            (user_id, today),
        ).fetchone()

        # Today's meals oldest-first: the full run feeds `logs`, the newest meal is the
        # "just submitted" batch that triggered the coach.
        meals_today = self.connection.execute(
            """
            SELECT id FROM meals
            WHERE user_id = ? AND log_date = ?
            ORDER BY log_time ASC, created_at ASC
            """,
            (user_id, today),
        ).fetchall()

        logs: list[FoodItem] = []
        batch_items: list[FoodItem] = []
        for index, meal in enumerate(meals_today):
            items = self.connection.execute(
                """
                SELECT name, calories, protein, carbs, fat
                FROM meal_items WHERE meal_id = ? ORDER BY rowid
                """,
                (meal["id"],),
            ).fetchall()
            food_items = [
                FoodItem(
                    name=row["name"],
                    kcal=row["calories"],
                    protein=row["protein"],
                    carbs=row["carbs"],
                    fat=row["fat"],
                )
                for row in items
            ]
            logs.extend(food_items)
            if index == len(meals_today) - 1:  # newest meal = the submitted batch
                batch_items = food_items

        state = CoachState()
        state.totals = {
            "kcal": totals_row["kcal"],
            "protein": totals_row["protein"],
            "carbs": totals_row["carbs"],
            "fat": totals_row["fat"],
        }
        if goals:
            state.target = {
                "kcal": goals["calories"],
                "protein": goals["protein"],
                "carbs": goals["carbs"],
                "fat": goals["fat"],
                "tolerance_pct": DEFAULT_TOLERANCE_PCT,
                "dietary": goals["dietary"],
                "allergies": preferences["allergies"] if preferences else "",
            }
        state.logs = logs
        state.current_batch = batch_items
        state.history_by_macro = self._history_by_macro(user_id, today)
        state.history_foods = self._history_food_index(user_id)
        state.day_context = self._day_context(len(meals_today))
        state.last_suggestion = self._last_suggestion(user_id, today)
        return state

    def _history_food_index(self, user_id: str) -> dict:
        """Every distinct food the user has logged -> its per-100g density + a typical
        portion, derived from their own logs. Lets the coach's suggestions carry the
        user's real macros so the sidebar "Add" is instant (no lookup on click)."""
        rows = self.connection.execute(
            """
            SELECT i.name AS name,
                   SUM(i.grams)    AS grams,
                   SUM(i.calories) AS calories,
                   SUM(i.protein)  AS protein,
                   SUM(i.carbs)    AS carbs,
                   SUM(i.fat)      AS fat,
                   COUNT(*)        AS n
            FROM meals m
            JOIN meal_items i ON i.meal_id = m.id
            WHERE m.user_id = ? AND i.grams > 0
            GROUP BY LOWER(i.name)
            """,
            (user_id,),
        ).fetchall()
        index: dict = {}
        for r in rows:
            grams = r["grams"] or 0
            if grams <= 0:
                continue
            # Density across all their logs of this food (weighted by grams), and the
            # average portion they tend to eat.
            per100 = {
                "calories": round((r["calories"] or 0) / grams * 100),
                "protein": round((r["protein"] or 0) / grams * 100, 1),
                "carbs": round((r["carbs"] or 0) / grams * 100, 1),
                "fat": round((r["fat"] or 0) / grams * 100, 1),
            }
            index[r["name"].strip().lower()] = {
                "name": r["name"],
                "per100": per100,
                "typical_grams": max(1, round(grams / (r["n"] or 1))),
                "source": "history",
            }
        return index

    # --- preloading macros onto suggestions --------------------------------------

    def _enrich_suggestions(self, state: CoachState, items: list[dict]) -> list[dict]:
        """Attach concrete, ready-to-log macros to each {name, serving, reason} the agent
        suggested, so the sidebar can log it instantly. The numbers come from the user's
        own logs first (their real macros) and fall back to a USDA FDC lookup; a food we
        can't price is left as-is (the UI shows it but its Add just opens the logger)."""
        enriched: list[dict] = []
        for item in items:
            priced = self._price_food(state, item.get("name", ""), item.get("serving"))
            enriched.append({**item, **priced} if priced else item)
        return enriched

    def _price_food(
        self, state: CoachState, name: str, serving: str | None
    ) -> dict | None:
        """Resolve macros for a suggested food: the user's history first, then FDC."""
        norm = " ".join(str(name).strip().lower().split())
        if not norm:
            return None

        # Tier 1 — a food the user actually logs. Exact match, then loose containment
        # ("greek yogurt" ~ "greek yogurt, plain") so small naming differences still hit.
        index: dict = state.history_foods or {}
        hit = index.get(norm)
        if hit is None:
            for key, value in index.items():
                if norm in key or key in norm:
                    hit = value
                    break
        if hit is not None:
            grams = self._parse_serving_grams(serving) or hit["typical_grams"]
            return self._at_serving(hit["per100"], grams, hit["source"])

        # Tier 2 — a new food, priced off USDA FDC (the same path vision uses). Dropped
        # (returns None) when FDC has no match, rather than inventing numbers.
        try:
            from ..vision import foodfacts
        except Exception:  # noqa: BLE001 - engine unavailable -> leave unpriced
            return None
        try:
            fdc = foodfacts.lookup(name)
        except Exception:  # noqa: BLE001 - offline / lookup error -> leave unpriced
            fdc = None
        if not fdc:
            return None
        macros = fdc.get("macros_per_100g") or {}
        if macros.get("kcal") is None:
            return None
        per100 = {
            "calories": round(macros.get("kcal") or 0),
            "protein": round(macros.get("protein") or 0, 1),
            "carbs": round(macros.get("carbs") or 0, 1),
            "fat": round(macros.get("fat") or 0, 1),
        }
        grams = self._parse_serving_grams(serving) or 100
        return self._at_serving(per100, grams, "usda-fdc")

    @staticmethod
    def _at_serving(per100: dict, grams: float, source: str) -> dict:
        """Absolute macros for `grams` of a food plus the per-100g density (for later
        re-weighing) and its provenance."""
        factor = grams / 100
        return {
            "grams": round(grams, 1),
            "calories": round((per100.get("calories") or 0) * factor),
            "protein": round((per100.get("protein") or 0) * factor, 1),
            "carbs": round((per100.get("carbs") or 0) * factor, 1),
            "fat": round((per100.get("fat") or 0) * factor, 1),
            "per100": per100,
            "source": source,
        }

    @staticmethod
    def _parse_serving_grams(serving: str | None) -> float | None:
        """Grams out of a serving string like '150 g' or '3/4 cup (30 g)', else None."""
        if not serving:
            return None
        m = re.search(r"([\d.]+)\s*g\b", str(serving))
        if not m:
            return None
        try:
            grams = float(m.group(1))
        except ValueError:
            return None
        return grams if grams > 0 else None

    def _history_by_macro(self, user_id: str, today: str | None = None) -> dict:
        """Foods the user has eaten on OTHER days, strongest first per macro."""
        column = {"kcal": "calories", "protein": "protein", "carbs": "carbs", "fat": "fat"}
        today = self._valid_date(today) or self._local_today()
        history: dict = {}
        for macro, col in column.items():
            rows = self.connection.execute(
                f"""
                SELECT i.name, MAX(i.{col}) AS strength
                FROM meals m
                JOIN meal_items i ON i.meal_id = m.id
                WHERE m.user_id = ? AND m.log_date < ? AND i.{col} > 0
                GROUP BY LOWER(i.name)
                ORDER BY strength DESC
                LIMIT 6
                """,
                (user_id, today),
            ).fetchall()
            history[macro] = [row["name"] for row in rows]
        return history

    @staticmethod
    def _valid_date(value: str | None) -> str | None:
        """A client-supplied date, accepted only if it's a real YYYY-MM-DD (else None,
        so the caller falls back to the server's local date). Guards against a malformed
        value silently scoping the coach to a day with no meals."""
        if not value:
            return None
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except (ValueError, TypeError):
            return None
        return value

    @staticmethod
    def _local_today() -> str:
        """The user's LOCAL calendar date (YYYY-MM-DD).

        Meals are stored with a local `log_date` (the client's todayIso()), and the
        dashboard groups the day locally too — so the coach must also read "today" by
        local date. SQLite's date('now') is UTC, which near midnight in a UTC+ timezone
        (e.g. 1 AM) points at the previous day: the coach then finds zero meals and
        wrongly reports nothing was logged. The backend runs on the user's own machine,
        so its local date matches the client's.
        """
        return datetime.now().date().isoformat()

    @staticmethod
    def _day_context(meals_logged: int) -> dict:
        hour = datetime.now().hour
        if 5 <= hour < 11:
            time_of_day, remaining = "morning", 2
        elif 11 <= hour < 16:
            time_of_day, remaining = "afternoon", 1
        elif 16 <= hour < 21:
            time_of_day, remaining = "evening", 1
        else:
            time_of_day, remaining = "night", 0
        return {
            "time_of_day": time_of_day,
            "meals_logged": meals_logged,
            "est_meals_remaining": remaining,
        }

    def _last_suggestion(self, user_id: str, today: str | None = None) -> str | None:
        """The coach's most recent tip TODAY (so it doesn't repeat itself within the day,
        and starts fresh on a new one)."""
        day = self._valid_date(today) or self._local_today()
        row = self.connection.execute(
            """
            SELECT content FROM coach_messages
            WHERE user_id = ? AND role = 'assistant' AND log_date = ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (user_id, day),
        ).fetchone()
        return row["content"] if row else None

    # --- agent-driven sidebar suggestions ----------------------------------------

    def _apply_suggestions(
        self, user_id: str, message: str | None, suggestions: list[dict]
    ) -> None:
        """Persist the sidebar suggestions for this run.

        A batch-log run (message is None) always replaces them, so an on-track batch
        that suggested nothing clears the sidebar. A chat run only replaces them when
        it actually named foods, so a plain question doesn't wipe existing suggestions.
        """
        if message is None or suggestions:
            self._store_suggestions(user_id, suggestions)

    def _store_suggestions(self, user_id: str, items: list[dict]) -> None:
        self.connection.execute(
            """
            INSERT INTO coach_suggestions (user_id, items, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                items = excluded.items, updated_at = excluded.updated_at
            """,
            (user_id, json.dumps(items), utc_now()),
        )

    def _load_suggestions(self, user_id: str) -> list[dict]:
        row = self.connection.execute(
            "SELECT items FROM coach_suggestions WHERE user_id = ?", (user_id,)
        ).fetchone()
        if not row:
            return []
        try:
            items = json.loads(row["items"])
        except (TypeError, ValueError):
            return []
        return items if isinstance(items, list) else []

    # --- persistence -------------------------------------------------------------

    def _save(
        self, user_id: str, role: str, content: str, log_date: str | None = None
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO coach_messages (id, user_id, role, content, created_at, log_date)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (str(uuid4()), user_id, role, content, utc_now(), log_date),
        )
