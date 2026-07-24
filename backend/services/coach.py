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
        return {
            "message": answer,
            "source": source,
            "recommendations": self._recommendations(snapshot, message),
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
        latest_question = next(
            (row["content"] for row in reversed(rows) if row["role"] == "user"),
            None,
        )
        return {
            "messages": [
                {
                    "role": row["role"],
                    "content": row["content"],
                    "createdAt": row["created_at"],
                }
                for row in rows
            ],
            "recommendations": self._recommendations(
                self.snapshot(user_id), latest_question
            ),
        }

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

    @staticmethod
    def _recommendations(
        snapshot: dict, message: str | None = None
    ) -> list[dict[str, str]]:
        goals = snapshot.get("goals")
        today = snapshot.get("today", {})
        if not goals:
            return [
                {
                    "name": "Balanced meal",
                    "reason": "Set your nutrition goals to receive tailored food ideas.",
                    "serving": "1 meal",
                }
            ]

        remaining = {
            "protein": max(0, goals["protein"] - today.get("protein", 0)),
            "carbs": max(0, goals["carbs"] - today.get("carbs", 0)),
            "fat": max(0, goals["fat"] - today.get("fat", 0)),
        }
        query = (message or "").lower()
        focus = max(remaining, key=remaining.get)
        if any(word in query for word in ("protein", "muscle", "recovery")):
            focus = "protein"
        elif any(word in query for word in ("carb", "energy", "pre-workout", "preworkout")):
            focus = "carbs"
        elif any(word in query for word in ("fat", "omega", "satiety")):
            focus = "fat"
        dietary = (goals.get("dietary") or "No restrictions").lower()

        meal_kind = next(
            (
                kind
                for kind in ("breakfast", "lunch", "dinner", "snack")
                if kind in query
            ),
            None,
        )

        if meal_kind == "breakfast":
            foods = (
                [
                    ("Banana", "Quick morning energy", "1 medium"),
                    ("Whole wheat bread", "A fiber-rich breakfast base", "2 slices"),
                    ("Almonds", "Plant-based fats for a satisfying start", "30 g"),
                ]
                if "vegan" in dietary
                else [
                    ("Greek yogurt", "A high-protein breakfast base", "200 g"),
                    ("Banana", "Quick morning carbohydrates", "1 medium"),
                    ("Whole wheat bread", "Fiber-rich energy for the morning", "2 slices"),
                ]
            )
        elif meal_kind == "lunch":
            foods = (
                [
                    ("Brown rice", "A steady-energy lunch base", "1 cup cooked"),
                    ("Steamed broccoli", "Fiber and volume for lunch", "1½ cups"),
                    ("Avocado", "Unsaturated fats to round out the meal", "½ avocado"),
                ]
                if "vegan" in dietary or "vegetarian" in dietary
                else [
                    ("Grilled chicken breast", "Lean protein for lunch", "150 g"),
                    ("Brown rice", "Steady carbohydrates for the afternoon", "1 cup cooked"),
                    ("Steamed broccoli", "Fiber and micronutrients", "1½ cups"),
                ]
            )
        elif meal_kind == "dinner":
            foods = (
                [
                    ("Sweet potato", "A satisfying dinner carbohydrate", "1 medium"),
                    ("Steamed broccoli", "A high-volume vegetable side", "1½ cups"),
                    ("Avocado", "Unsaturated fats for a balanced plate", "½ avocado"),
                ]
                if "vegan" in dietary or "vegetarian" in dietary
                else [
                    ("Salmon fillet", "Protein and omega-3 fats for dinner", "150 g"),
                    ("Sweet potato", "Fiber-rich carbohydrates", "1 medium"),
                    ("Steamed broccoli", "A light vegetable side", "1½ cups"),
                ]
            )
        elif meal_kind == "snack":
            foods = (
                [
                    ("Banana", "Quick energy in a simple portion", "1 medium"),
                    ("Almonds", "Portable plant-based protein and fats", "30 g"),
                    ("Whole wheat bread", "A convenient fiber-rich snack", "1 slice"),
                ]
                if "vegan" in dietary
                else [
                    ("Greek yogurt", "A quick protein-focused snack", "200 g"),
                    ("Banana", "Portable carbohydrates for energy", "1 medium"),
                    ("Almonds", "Healthy fats in a measured serving", "30 g"),
                ]
            )
        elif focus == "protein":
            if "vegan" in dietary:
                foods = [
                    ("Almonds", "Plant-based protein and healthy fats", "30 g"),
                    ("Whole wheat bread", "A practical plant-based protein boost", "2 slices"),
                    ("Steamed broccoli", "Light plant protein with plenty of fiber", "1½ cups"),
                ]
            elif "vegetarian" in dietary:
                foods = [
                    ("Greek yogurt", "High protein without a large meal", "200 g"),
                    ("Almonds", "Portable protein and healthy fats", "30 g"),
                    ("Whole wheat bread", "Easy protein and carbohydrate pairing", "2 slices"),
                ]
            elif "pescatarian" in dietary:
                foods = [
                    ("Salmon fillet", "Protein-rich and a source of omega-3 fats", "150 g"),
                    ("Greek yogurt", "A quick high-protein snack", "200 g"),
                    ("Almonds", "Portable protein and healthy fats", "30 g"),
                ]
            else:
                foods = [
                    ("Grilled chicken breast", "Lean protein for today's remaining target", "150 g"),
                    ("Greek yogurt", "A quick high-protein snack", "200 g"),
                    ("Salmon fillet", "Protein plus beneficial omega-3 fats", "150 g"),
                ]
        elif focus == "carbs":
            foods = [
                ("Brown rice", "Steady carbohydrates for energy", "1 cup cooked"),
                ("Banana", "Quick, convenient carbohydrates", "1 medium"),
                ("Sweet potato", "Carbohydrates with fiber and micronutrients", "1 medium"),
            ]
        else:
            foods = [
                ("Avocado", "A simple source of unsaturated fat", "½ avocado"),
                ("Almonds", "Healthy fats in an easy measured portion", "30 g"),
                (
                    "Whole wheat bread" if "vegan" in dietary else "Salmon fillet",
                    "A balanced way to round out today's macros",
                    "2 slices" if "vegan" in dietary else "150 g",
                ),
            ]

        gap = round(remaining[focus])
        question_context = (
            f"Suggested for your {meal_kind} question"
            if meal_kind
            else f"Suggested from your latest {focus} question"
            if message
            else "Suggested from today's remaining macros"
        )
        return [
            {
                "name": name,
                "reason": (
                    f"{reason}. {question_context}; about {gap}g {focus} remains today."
                ),
                "serving": serving,
            }
            for name, reason, serving in foods
        ]
