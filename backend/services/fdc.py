from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import httpx

from ..config import settings


REFERENCE_FOODS = {
    "grilled chicken breast": (165, 31, 0, 3.6),
    "chicken breast": (165, 31, 0, 3.6),
    "steamed broccoli": (35, 2.4, 7, 0.4),
    "broccoli": (35, 2.4, 7, 0.4),
    "brown rice": (123, 2.7, 26, 1),
    "rice": (130, 2.7, 28, 0.3),
    "avocado": (160, 2, 9, 15),
    "salmon fillet": (208, 20, 0, 13),
    "salmon": (208, 20, 0, 13),
    "sweet potato": (86, 1.6, 20, 0.1),
    "greek yogurt": (59, 10, 3.6, 0.4),
    "banana": (89, 1.1, 23, 0.3),
    "almonds": (579, 21, 22, 50),
    "whole wheat bread": (247, 13, 41, 3.4),
    "eggs": (155, 13, 1.1, 11),
    "oatmeal": (68, 2.4, 12, 1.4),
    "pasta": (131, 5, 25, 1.1),
}


class FdcClient:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    async def nutrition_for(self, name: str) -> dict:
        query = name.strip().lower()
        cached = self.connection.execute(
            """
            SELECT payload_json FROM fdc_cache
            WHERE query = ? AND expires_at > ?
            """,
            (query, datetime.now(UTC).isoformat()),
        ).fetchone()
        if cached:
            return json.loads(cached["payload_json"])

        result = None
        if settings.usda_api_key:
            result = await self._fetch_usda(query)
        if result is None:
            result = self._reference_match(query)

        now = datetime.now(UTC)
        self.connection.execute(
            """
            INSERT INTO fdc_cache (query, payload_json, expires_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(query) DO UPDATE SET
              payload_json = excluded.payload_json,
              expires_at = excluded.expires_at,
              updated_at = excluded.updated_at
            """,
            (
                query,
                json.dumps(result),
                (now + timedelta(days=30)).isoformat(),
                now.isoformat(),
            ),
        )
        return result

    async def _fetch_usda(self, query: str) -> dict | None:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                response = await client.post(
                    "https://api.nal.usda.gov/fdc/v1/foods/search",
                    params={"api_key": settings.usda_api_key},
                    json={"query": query, "pageSize": 1},
                )
                response.raise_for_status()
            foods = response.json().get("foods", [])
            if not foods:
                return None
            food = foods[0]
            nutrients = food.get("foodNutrients", [])

            def nutrient_value(name: str, unit: str | None = None) -> float:
                for nutrient in nutrients:
                    if nutrient.get("nutrientName", "").lower() != name:
                        continue
                    if unit and nutrient.get("unitName", "").upper() != unit:
                        continue
                    return float(nutrient.get("value", 0))
                return 0

            return {
                "fdcId": str(food.get("fdcId")),
                "name": food.get("description", query).title(),
                "calories": nutrient_value("energy", "KCAL"),
                "protein": nutrient_value("protein"),
                "carbs": nutrient_value("carbohydrate, by difference"),
                "fat": nutrient_value("total lipid (fat)"),
                "source": "usda-fdc",
            }
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def _reference_match(query: str) -> dict:
        match = next(
            (
                (food_name, macros)
                for food_name, macros in REFERENCE_FOODS.items()
                if food_name in query or query in food_name
            ),
            (query or "mixed meal", (150, 8, 18, 5)),
        )
        name, (calories, protein, carbs, fat) = match
        return {
            "fdcId": None,
            "name": name.title(),
            "calories": calories,
            "protein": protein,
            "carbs": carbs,
            "fat": fat,
            "source": "reference",
        }
