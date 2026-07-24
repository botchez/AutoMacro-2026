from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import re
import sqlite3
from dataclasses import dataclass

import httpx

from ..config import settings
from ..db import utc_now
from .fdc import FdcClient, REFERENCE_FOODS


@dataclass
class DetectedFood:
    name: str
    grams: float
    confidence: float


class VisionCascade:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection
        self.fdc = FdcClient(connection)

    async def analyze(
        self, image: bytes, filename: str, content_type: str | None, weight: float | None
    ) -> dict:
        image_digest = hashlib.sha256(image).hexdigest()
        digest = f"{image_digest}:{round(weight or 0, 1)}"
        cached = self.connection.execute(
            "SELECT payload_json, provider FROM vision_cache WHERE image_sha256 = ?",
            (digest,),
        ).fetchone()
        if cached:
            payload = json.loads(cached["payload_json"])
            payload["cached"] = True
            return payload

        detections: list[DetectedFood] = []
        provider = "filename-fallback"
        if settings.openai_api_key:
            detections = await self._openai_detect(image, content_type, weight)
            if detections:
                provider = "openai"
        if not detections:
            detections = self._filename_fallback(filename, image_digest, weight)

        items = []
        for detection in detections:
            reference = await self.fdc.nutrition_for(detection.name)
            factor = detection.grams / 100
            items.append(
                {
                    "name": reference["name"],
                    "grams": round(detection.grams, 1),
                    "calories": round(reference["calories"] * factor),
                    "protein": round(reference["protein"] * factor, 1),
                    "carbs": round(reference["carbs"] * factor, 1),
                    "fat": round(reference["fat"] * factor, 1),
                    "confidence": detection.confidence,
                    "fdcId": reference.get("fdcId"),
                    "source": reference["source"],
                }
            )
        payload = {"items": items, "provider": provider, "cached": False}
        self.connection.execute(
            """
            INSERT OR REPLACE INTO vision_cache
            (image_sha256, payload_json, provider, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (digest, json.dumps(payload), provider, utc_now()),
        )
        return payload

    async def _openai_detect(
        self, image: bytes, content_type: str | None, weight: float | None
    ) -> list[DetectedFood]:
        mime = content_type or mimetypes.guess_type("image.jpg")[0] or "image/jpeg"
        encoded = base64.b64encode(image).decode("ascii")
        prompt = (
            "Identify the visible foods. Return only JSON with an items array. "
            "Each item needs name, estimated_grams, and confidence (0 to 1). "
            f"The scale weight is {weight or 'unknown'} grams; use it as the total "
            "when supplied. Do not invent foods that are not visibly plausible."
        )
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {settings.openai_api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": settings.openai_model,
                        "response_format": {"type": "json_object"},
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": prompt},
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": f"data:{mime};base64,{encoded}"
                                        },
                                    },
                                ],
                            }
                        ],
                    },
                )
                response.raise_for_status()
            data = json.loads(
                response.json()["choices"][0]["message"]["content"]
            ).get("items", [])
            return [
                DetectedFood(
                    name=str(item["name"]),
                    grams=max(1, float(item.get("estimated_grams", 100))),
                    confidence=min(1, max(0, float(item.get("confidence", 0.75)))),
                )
                for item in data[:6]
                if item.get("name")
            ]
        except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return []

    @staticmethod
    def _filename_fallback(
        filename: str, digest: str, weight: float | None
    ) -> list[DetectedFood]:
        normalized = re.sub(r"[_\-.]+", " ", filename.lower())
        candidates = [
            food_name for food_name in REFERENCE_FOODS if food_name in normalized
        ]
        if not candidates:
            names = list(REFERENCE_FOODS)
            candidates = [names[int(digest[:8], 16) % len(names)]]
        total = weight if weight and weight > 0 else 180
        grams_each = total / len(candidates)
        return [
            DetectedFood(name=name, grams=grams_each, confidence=0.45)
            for name in candidates[:3]
        ]
