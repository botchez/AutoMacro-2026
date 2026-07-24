from __future__ import annotations

import json
import sqlite3
from uuid import uuid4

import httpx

from ..config import settings
from ..db import utc_now


class CoachService:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def snapshot(self, user_id: str) -> dict:
        goals = self.connection.execute(
            "SELECT * FROM goals WHERE user_id = ?", (user_id,)
        ).fetchone()
        totals = self.connection.execute(
            """
            SELECT
              COALESCE(SUM(i.calories), 0) AS calories,
              COALESCE(SUM(i.protein), 0) AS protein,
              COALESCE(SUM(i.carbs), 0) AS carbs,
              COALESCE(SUM(i.fat), 0) AS fat
            FROM meals m
            JOIN meal_items i ON i.meal_id = m.id
            WHERE m.user_id = ? AND m.log_date = date('now')
            """,
            (user_id,),
        ).fetchone()
        return {
            "goals": dict(goals) if goals else None,
            "today": dict(totals) if totals else {},
        }

    async def reply(self, user_id: str, message: str | None = None) -> dict:
        snapshot = self.snapshot(user_id)
        if message:
            self._save(user_id, "user", message)

        answer = None
        source = "rules"
        if settings.openai_api_key:
            answer = await self._openai_reply(message, snapshot)
            if answer:
                source = "openai"
        if not answer:
            answer = self._rule_reply(snapshot, message)

        self._save(user_id, "assistant", answer)
        return {"message": answer, "source": source}

    def _save(self, user_id: str, role: str, content: str) -> None:
        self.connection.execute(
            """
            INSERT INTO coach_messages (id, user_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (str(uuid4()), user_id, role, content, utc_now()),
        )

    async def _openai_reply(self, message: str | None, snapshot: dict) -> str | None:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {settings.openai_api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": settings.openai_model,
                        "messages": [
                            {
                                "role": "system",
                                "content": (
                                    "You are a warm, practical nutrition coach. Give one "
                                    "specific suggestion in at most 45 words. Never diagnose, "
                                    "shame, or prescribe. Use the provided goals and today's "
                                    "logged totals. Mention that estimates are approximate when "
                                    "relevant."
                                ),
                            },
                            {
                                "role": "user",
                                "content": json.dumps(
                                    {
                                        "question": message
                                        or "Give me my most useful next nutrition step.",
                                        "nutrition": snapshot,
                                    }
                                ),
                            },
                        ],
                    },
                )
                response.raise_for_status()
            return str(response.json()["choices"][0]["message"]["content"]).strip()
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def _rule_reply(snapshot: dict, message: str | None) -> str:
        goals = snapshot.get("goals")
        today = snapshot.get("today", {})
        if not goals:
            return "Set your daily targets first, then I can coach your next meal around them."
        gaps = {
            "protein": max(0, goals["protein"] - today.get("protein", 0)),
            "carbs": max(0, goals["carbs"] - today.get("carbs", 0)),
            "fat": max(0, goals["fat"] - today.get("fat", 0)),
        }
        largest = max(gaps, key=gaps.get)
        if gaps[largest] <= 0:
            return "Your macros are covered today. Keep the next choice simple, hydrate, and enjoy the consistency."
        ideas = {
            "protein": "Greek yogurt, eggs, tofu, fish, or chicken would close the gap efficiently.",
            "carbs": "Fruit, oats, rice, or potatoes would add useful energy.",
            "fat": "Avocado, nuts, seeds, or olive oil would round things out.",
        }
        prefix = "For your next meal, " if not message else "Based on today’s log, "
        return f"{prefix}you have the most room for {largest}. {ideas[largest]}"
