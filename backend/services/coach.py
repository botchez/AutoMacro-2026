"""Coach endpoint adapter.

The real agent lives in `backend/coach/` — a native tool-calling loop that reads the
day's totals, target (with a tolerance band), history, the just-submitted batch, and
its own last suggestion, then decides where the user stands. The isolated build drove
it off an in-memory CoachState; here we build that same CoachState from the SQLite DB
(exactly the swap the validated code was written to allow) and run the loop.

`reply()` keeps the existing HTTP contract (`{message, source}`) and the
`coach_messages` persistence, and degrades to a deterministic, supportive rule reply
whenever the model stage is unavailable (no OPENROUTER_API_KEY or an upstream error).
"""

from __future__ import annotations

import sqlite3
from uuid import uuid4

from starlette.concurrency import run_in_threadpool

from ..config import settings
from ..coach import CoachState, FoodItem, run_coach
from ..db import utc_now

# Goals carry no tolerance column; the validated coach expects one. 10% matches the
# isolated build's default and the tech-stack spec's "close enough" band.
DEFAULT_TOLERANCE_PCT = 10.0

# Foods to suggest per short macro when the user has no personal history to draw on.
_FALLBACK_IDEAS = {
    "protein": "Greek yogurt, eggs, tofu, fish, or chicken would close the gap efficiently.",
    "carbs": "Fruit, oats, rice, or potatoes would add useful energy.",
    "fat": "Avocado, nuts, seeds, or a drizzle of olive oil would round things out.",
    "kcal": "A balanced snack, like yogurt with fruit and nuts, would top you up nicely.",
}


class CoachService:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    async def reply(self, user_id: str, message: str | None = None) -> dict:
        state = self._build_state(user_id)
        if message:
            self._save(user_id, "user", message)

        answer = None
        source = "rules"
        if settings.openrouter_api_key:
            answer = await self._agent_reply(state, message)
            if answer:
                source = "coach-agent"
        if not answer:
            answer = self._rule_reply(state)

        self._save(user_id, "assistant", answer)
        return {"message": answer, "source": source}

    # --- the validated agent -----------------------------------------------------

    async def _agent_reply(self, state: CoachState, message: str | None) -> str | None:
        trigger = message or "The user just submitted a meal. Coach them."
        try:
            # run_coach is synchronous and does model calls with retries/back-off;
            # keep it off the event loop.
            result = await run_in_threadpool(run_coach, state, trigger, False)
        except Exception:  # noqa: BLE001 - no key / model error -> rule fallback
            return None
        text = (result.text or "").strip()
        if not text or text.startswith("(no final advice"):
            return None
        self._maybe_write_transcript(result)
        return text

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

    # --- build the CoachState the agent reads ------------------------------------

    def _build_state(self, user_id: str) -> CoachState:
        goals = self.connection.execute(
            "SELECT * FROM goals WHERE user_id = ?", (user_id,)
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

    # --- deterministic fallback (no key / model error) ---------------------------

    @staticmethod
    def _rule_reply(state: CoachState) -> str:
        target = state.target
        totals = state.totals
        tolerance = target.get("tolerance_pct", DEFAULT_TOLERANCE_PCT) / 100
        # Gap per macro, only counting a macro "short" once it's beyond its band.
        gaps = {}
        for macro in ("protein", "carbs", "fat", "kcal"):
            goal = target.get(macro) or 0
            have = totals.get(macro) or 0
            short = goal - have
            gaps[macro] = short if short > goal * tolerance else 0

        binding = max(gaps, key=gaps.get)
        if gaps[binding] <= 0:
            return (
                "You're on track — every macro is within its target band today. "
                "Nothing needed; keep the next choice simple and enjoy the consistency."
            )

        idea = _FALLBACK_IDEAS[binding]
        favourites = [f for f in state.history_by_macro.get(binding, []) if f]
        if favourites:
            idea = f"Something you eat often like {favourites[0]} would help. {idea}"
        label = "calories" if binding == "kcal" else binding
        return (
            f"You have the most room left in {label} today "
            f"(about {round(gaps[binding])} to go). {idea}"
        )

    # --- persistence -------------------------------------------------------------

    def _save(self, user_id: str, role: str, content: str) -> None:
        self.connection.execute(
            """
            INSERT INTO coach_messages (id, user_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (str(uuid4()), user_id, role, content, utc_now()),
        )
