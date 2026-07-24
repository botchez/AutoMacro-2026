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
import sqlite3
from uuid import uuid4

from starlette.concurrency import run_in_threadpool

from ..config import settings
from ..coach import CoachState, FoodItem, run_coach
from ..db import utc_now

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

    async def reply(self, user_id: str, message: str | None = None) -> dict:
        """Coach the user. message=None is an auto batch-log trigger; a message is chat."""
        state = self._build_state(user_id)

        # For chat, capture the thread BEFORE saving the new user turn so the agent
        # sees prior context without the current question duplicated in.
        chat_history = self._recent_turns(user_id) if message else []
        if message:
            self._save(user_id, "user", message)

        if not (settings.openrouter_api_key and settings.coach_agent_enabled):
            raise CoachUnavailableError(
                "coach agent unavailable: "
                + ("OPENROUTER_API_KEY is not set" if not settings.openrouter_api_key
                   else "COACH_AGENT_ENABLED is off")
            )

        # No fallback: a failure here raises CoachUnavailableError and rolls back.
        result = await self._agent_reply(state, message, chat_history)
        answer = result.text.strip()
        suggestions = list(result.suggestions)
        source = "coach-agent"

        # A batch-log trigger (message is None) resets the conversation: the just-logged
        # food starts a fresh thread, so the panel shows only this batch's coaching.
        # (state was built above, so the agent still saw the prior suggestion/context.)
        if message is None:
            self._clear_history(user_id)
        self._save(user_id, "assistant", answer)
        self._apply_suggestions(user_id, message, suggestions)
        return {
            "message": answer,
            "source": source,
            "recommendations": self._load_suggestions(user_id),
        }

    def history(self, user_id: str, limit: int = 40) -> dict:
        rows = self.connection.execute(
            """
            SELECT role, content, created_at
            FROM (
                SELECT role, content, created_at
                FROM coach_messages
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT ?
            )
            ORDER BY created_at ASC
            """,
            (user_id, limit),
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
        self, state: CoachState, message: str | None, chat_history: list
    ):
        """Return the CoachResult (text + suggestions), or raise CoachUnavailableError.

        The underlying model/network error is preserved in the message so it shows up in
        the API response and server logs — no silent swallowing.
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
                run_coach, state, trigger, False, mode, history
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

    def _recent_turns(self, user_id: str) -> list[dict]:
        """The last few chat turns, oldest first, as OpenAI-format messages."""
        rows = self.connection.execute(
            """
            SELECT role, content FROM (
                SELECT role, content, created_at
                FROM coach_messages
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT ?
            ) ORDER BY created_at ASC
            """,
            (user_id, CHAT_HISTORY_TURNS),
        ).fetchall()
        return [{"role": row["role"], "content": row["content"]} for row in rows]

    # --- build the CoachState the agent reads ------------------------------------

    def _build_state(self, user_id: str) -> CoachState:
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
            WHERE m.user_id = ? AND m.log_date = date('now')
            """,
            (user_id,),
        ).fetchone()

        # Today's meals oldest-first: the full run feeds `logs`, the newest meal is the
        # "just submitted" batch that triggered the coach.
        meals_today = self.connection.execute(
            """
            SELECT id FROM meals
            WHERE user_id = ? AND log_date = date('now')
            ORDER BY log_time ASC, created_at ASC
            """,
            (user_id,),
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
        state.history_by_macro = self._history_by_macro(user_id)
        state.day_context = self._day_context(len(meals_today))
        state.last_suggestion = self._last_suggestion(user_id)
        return state

    def _history_by_macro(self, user_id: str) -> dict:
        """Foods the user has eaten on OTHER days, strongest first per macro."""
        column = {"kcal": "calories", "protein": "protein", "carbs": "carbs", "fat": "fat"}
        history: dict = {}
        for macro, col in column.items():
            rows = self.connection.execute(
                f"""
                SELECT i.name, MAX(i.{col}) AS strength
                FROM meals m
                JOIN meal_items i ON i.meal_id = m.id
                WHERE m.user_id = ? AND m.log_date < date('now') AND i.{col} > 0
                GROUP BY LOWER(i.name)
                ORDER BY strength DESC
                LIMIT 6
                """,
                (user_id,),
            ).fetchall()
            history[macro] = [row["name"] for row in rows]
        return history

    @staticmethod
    def _day_context(meals_logged: int) -> dict:
        from datetime import datetime

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

    def _last_suggestion(self, user_id: str) -> str | None:
        row = self.connection.execute(
            """
            SELECT content FROM coach_messages
            WHERE user_id = ? AND role = 'assistant'
            ORDER BY created_at DESC LIMIT 1
            """,
            (user_id,),
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

    def _clear_history(self, user_id: str) -> None:
        """Wipe the user's coach thread. Runs when a new batch resets the conversation."""
        self.connection.execute(
            "DELETE FROM coach_messages WHERE user_id = ?", (user_id,)
        )

    def _save(self, user_id: str, role: str, content: str) -> None:
        self.connection.execute(
            """
            INSERT INTO coach_messages (id, user_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (str(uuid4()), user_id, role, content, utc_now()),
        )
