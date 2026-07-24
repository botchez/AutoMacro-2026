"""Vision endpoint adapter.

The real work lives in the validated cascade (`backend/vision/identify.py`): barcode
-> Open Food Facts, else one multimodal call that classifies the frame and decomposes
a plate into components, each priced from the most authoritative source (label OCR /
Open Food Facts / USDA FDC / a flagged model estimate).

This adapter keeps the existing HTTP contract intact — it flattens the cascade's rich
per-component result into the flat `{items, provider, cached}` payload the frontend
already speaks, preserves the sha256+weight `vision_cache`, and degrades to a
deterministic filename fallback whenever the model stage is unavailable (no
OPENROUTER_API_KEY, a missing optional dep, or an upstream error) so the demo never
hard-fails.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass

from starlette.concurrency import run_in_threadpool

from ..config import settings
from ..db import utc_now
from .fdc import REFERENCE_FOODS

# When no scale weight is supplied we still owe the frontend absolute macros, so we
# price the item against a nominal total (overridden the instant a real weight lands).
DEFAULT_TOTAL_GRAMS = 180.0

# The cascade tags every component with where its macros came from; map that to a
# confidence the UI can show. Authoritative sources rank high; a model estimate low.
_SOURCE_CONFIDENCE = {
    "barcode": 0.97,
    "label": 0.95,
    "off": 0.85,
    "fdc": 0.85,
    "fdc/cache": 0.85,
    "estimate": 0.5,
}

# Normalize the cascade's internal source tags to stable, UI-facing badge strings.
_SOURCE_LABEL = {
    "barcode": "barcode",
    "label": "label",
    "off": "openfoodfacts",
    "fdc": "usda-fdc",
    "fdc/cache": "usda-fdc",
    "estimate": "estimate",
}


@dataclass
class DetectedFood:
    name: str
    grams: float
    confidence: float


class VisionCascade:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    async def analyze(
        self, image: bytes, filename: str, content_type: str | None, weight: float | None
    ) -> dict:
        image_digest = hashlib.sha256(image).hexdigest()
        digest = f"{image_digest}:{round(weight or 0, 1)}"
        cached = self.connection.execute(
            "SELECT payload_json FROM vision_cache WHERE image_sha256 = ?",
            (digest,),
        ).fetchone()
        if cached:
            payload = json.loads(cached["payload_json"])
            payload["cached"] = True
            return payload

        weight_g = weight if weight and weight > 0 else None
        # The cascade is synchronous (and may block on model/HTTP calls with retries),
        # so run it off the event loop.
        items, provider = await run_in_threadpool(
            self._run_cascade, image, filename, content_type, weight_g
        )
        if not items:  # cascade produced nothing usable -> deterministic fallback
            items = self._filename_fallback(filename, image_digest, weight_g)
            provider = "filename-fallback"

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

    # --- the validated cascade, adapted to the flat item contract ----------------

    def _run_cascade(
        self, image: bytes, filename: str, content_type: str | None, weight_g: float | None
    ) -> tuple[list[dict], str]:
        """Run identify() and flatten its components. Returns ([], "") on any failure."""
        if not settings.openrouter_api_key:
            return [], ""  # no key -> caller uses the filename fallback
        try:
            # Imported lazily so a missing optional dep (openai/pillow) degrades to the
            # fallback instead of breaking import of the whole service.
            from ..vision import identify
        except Exception:  # noqa: BLE001 - engine deps unavailable -> fallback
            return [], ""

        # The cascade prices components off `grams`; feed it the scale weight, or the
        # nominal default so items still carry absolute macros when weight is absent.
        total = weight_g if weight_g is not None else DEFAULT_TOTAL_GRAMS
        mime = content_type or "image/jpeg"
        try:
            result = identify(image, grams=total, mime=mime, verbose=False)
        except Exception:  # noqa: BLE001 - model/network error -> fallback
            return [], ""

        self._maybe_write_transcript(filename, result)

        top_conf = result.result.get("confidence")
        items: list[dict] = []
        for component in result.result.get("components", []):
            macros = component.get("macros") or {}
            per_100g = component.get("per_100g") or {}
            serving_grams = component.get("serving_grams")
            source_tag = component.get("macro_source", "estimate")
            fdc_id = component.get("fdc_id")
            # For barcode/OFF components there's no fdcId but there may be a barcode we
            # can surface in the same slot so the log keeps a stable reference.
            reference = str(fdc_id) if fdc_id is not None else component.get("barcode")
            confidence = top_conf if top_conf is not None else _SOURCE_CONFIDENCE.get(
                source_tag, 0.7
            )
            items.append(
                {
                    "name": component.get("name", "food"),
                    "grams": round(component.get("grams") or 0.0, 1),
                    "calories": round(macros.get("kcal") or 0.0),
                    "protein": round(macros.get("protein") or 0.0, 1),
                    "carbs": round(macros.get("carbs") or 0.0, 1),
                    "fat": round(macros.get("fat") or 0.0, 1),
                    "confidence": max(0.0, min(1.0, float(confidence))),
                    "fdcId": reference,
                    "source": _SOURCE_LABEL.get(source_tag, source_tag),
                    # Portion helpers for the "log by serving / re-weigh" flow: the
                    # food's per-100g density and grams-per-serving when known (OFF).
                    "per100": {
                        "calories": round(per_100g.get("kcal") or 0.0),
                        "protein": round(per_100g.get("protein") or 0.0, 1),
                        "carbs": round(per_100g.get("carbs") or 0.0, 1),
                        "fat": round(per_100g.get("fat") or 0.0, 1),
                    },
                    "servingGrams": (
                        round(float(serving_grams), 1)
                        if serving_grams is not None
                        else None
                    ),
                }
            )
        return items, result.model

    def _maybe_write_transcript(self, filename: str, result) -> None:
        if settings.transcripts_dir is None:
            return
        try:
            directory = settings.transcripts_dir
            directory.mkdir(parents=True, exist_ok=True)
            stem = re.sub(r"[^a-z0-9]+", "-", filename.lower()).strip("-") or "frame"
            stamp = utc_now().replace(":", "").replace("-", "")[:15]
            (directory / f"{stamp}_vision_{stem}.md").write_text(
                result.transcript(), encoding="utf-8"
            )
        except Exception:  # noqa: BLE001 - transcript is a nicety, never fail the request
            pass

    # --- deterministic fallback (no model / no key) ------------------------------

    @staticmethod
    def _filename_fallback(
        filename: str, digest: str, weight_g: float | None
    ) -> list[dict]:
        normalized = re.sub(r"[_\-.]+", " ", filename.lower())
        candidates = [name for name in REFERENCE_FOODS if name in normalized]
        if not candidates:
            names = list(REFERENCE_FOODS)
            candidates = [names[int(digest[:8], 16) % len(names)]]
        candidates = candidates[:3]
        total = weight_g if weight_g is not None else DEFAULT_TOTAL_GRAMS
        grams_each = total / len(candidates)
        items = []
        for name in candidates:
            calories, protein, carbs, fat = REFERENCE_FOODS[name]
            factor = grams_each / 100
            items.append(
                {
                    "name": name.title(),
                    "grams": round(grams_each, 1),
                    "calories": round(calories * factor),
                    "protein": round(protein * factor, 1),
                    "carbs": round(carbs * factor, 1),
                    "fat": round(fat * factor, 1),
                    "confidence": 0.45,
                    "fdcId": None,
                    "source": "reference",
                }
            )
        return items
