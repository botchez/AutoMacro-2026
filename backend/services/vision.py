"""Vision endpoint adapter.

The real work lives in the validated cascade (`backend/vision/identify.py`): barcode
-> Open Food Facts, else one multimodal call that classifies the frame and decomposes
a plate into components, each priced from the most authoritative source (label OCR /
Open Food Facts / USDA FDC / a flagged model estimate).

This adapter flattens the cascade's rich per-component result into the flat
`{items, provider, cached}` payload the frontend speaks. Each item is weight-independent:
a per-100g density (`per100`) plus a `fraction` (its share of the plate by mass) and the
`source` the numbers came from — the client multiplies `fraction * scale_weight` to get
grams and prices it off `per100`, so no scale weight is ever sent to the model or baked
into the backend's numbers. Results are cached by image sha256 alone (weight-independent)
and degrade to a deterministic filename fallback whenever the model stage is unavailable
(no OPENROUTER_API_KEY, a missing optional dep, or an upstream error).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3

from starlette.concurrency import run_in_threadpool

from ..config import settings
from ..db import utc_now
from .fdc import REFERENCE_FOODS

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


class VisionCascade:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    async def analyze(
        self, image: bytes, filename: str, content_type: str | None
    ) -> dict:
        # The result is weight-independent now (per-100g + fraction; the client does the
        # weight math), so the cache key is the image alone — the same photo yields the
        # same ratios regardless of what the scale reads.
        digest = hashlib.sha256(image).hexdigest()
        cached = self.connection.execute(
            "SELECT payload_json FROM vision_cache WHERE image_sha256 = ?",
            (digest,),
        ).fetchone()
        if cached:
            payload = json.loads(cached["payload_json"])
            payload["cached"] = True
            return payload

        # The cascade is synchronous (and may block on model/HTTP calls with retries),
        # so run it off the event loop.
        items, provider, debug = await run_in_threadpool(
            self._run_cascade, image, filename, content_type
        )
        if not items:  # cascade produced nothing usable -> deterministic fallback
            items = self._filename_fallback(filename, digest)
            provider = "filename-fallback"
            debug = {
                "model": "filename-fallback",
                "notes": [
                    "vision model unavailable (no key / dep / upstream error); "
                    "guessed foods from the filename."
                ],
            }

        payload = {"items": items, "provider": provider, "cached": False, "debug": debug}
        self.connection.execute(
            """
            INSERT OR REPLACE INTO vision_cache
            (image_sha256, payload_json, provider, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (digest, json.dumps(payload), provider, utc_now()),
        )
        return payload

    # --- direct barcode lookup (client decoded it; skip the model entirely) -------

    async def lookup_barcode(self, barcode: str) -> dict | None:
        """Price a client-decoded barcode straight off Open Food Facts.

        Returns the flat {items, provider, cached} payload, or None when the product
        isn't in Open Food Facts (or the lookup is unavailable) so the caller can fall
        back to a normal photo capture. No model call, no image upload. The item is
        weight-independent (per-100g + fraction 1.0); the client applies the scale weight.
        """
        digest = f"barcode:{barcode}"
        cached = self.connection.execute(
            "SELECT payload_json FROM vision_cache WHERE image_sha256 = ?",
            (digest,),
        ).fetchone()
        if cached:
            payload = json.loads(cached["payload_json"])
            payload["cached"] = True
            return payload

        # The OFF lookup is a blocking HTTP call with a timeout; keep it off the loop.
        off = await run_in_threadpool(self._off_lookup, barcode)
        if off is None:
            return None

        serving_grams = off.get("serving_grams")
        per100 = self._per100(off.get("macros_per_100g"))
        item = {
            "name": off.get("food_name") or f"Barcode {barcode}",
            "fraction": 1.0,
            "per100": per100,
            "confidence": _SOURCE_CONFIDENCE["barcode"],
            "fdcId": barcode,
            "source": _SOURCE_LABEL["barcode"],
            "servingGrams": (
                round(float(serving_grams), 1) if serving_grams is not None else None
            ),
            "trace": [
                {
                    "tool": "barcode",
                    "query": barcode,
                    "result": off.get("food_name"),
                    "per100": per100,
                    "status": "hit",
                }
            ],
        }
        debug = {
            "model": "barcode/openfoodfacts",
            "barcode": barcode,
            "notes": [f"decoded barcode {barcode} -> Open Food Facts: {item['name']}"],
        }
        payload = {
            "items": [item],
            "provider": "barcode/openfoodfacts",
            "cached": False,
            "debug": debug,
        }
        self.connection.execute(
            """
            INSERT OR REPLACE INTO vision_cache
            (image_sha256, payload_json, provider, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (digest, json.dumps(payload), "barcode/openfoodfacts", utc_now()),
        )
        return payload

    @staticmethod
    def _per100(macros: dict | None) -> dict:
        """Uniform per-100g macro payload (calories/protein/carbs/fat) from the cascade's
        {kcal,protein,carbs,fat} block. Missing values become 0 so the client can always
        multiply by a weight."""
        m = macros or {}
        return {
            "calories": round(m.get("kcal") or 0.0),
            "protein": round(m.get("protein") or 0.0, 1),
            "carbs": round(m.get("carbs") or 0.0, 1),
            "fat": round(m.get("fat") or 0.0, 1),
        }

    @staticmethod
    def decode_barcode(image: bytes) -> str | None:
        """Decode the first barcode in a frame with pyzbar (classical CV, no model).

        Imported lazily so a missing native zbar lib degrades to None rather than
        breaking the endpoint. Runs on the ORIGINAL frame bytes — barcodes want
        resolution and pyzbar is local + free.
        """
        try:
            from ..vision.identify import _decode_barcode
        except Exception:  # noqa: BLE001 - engine/zbar unavailable -> no decode
            return None
        try:
            return _decode_barcode(image)
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _off_lookup(barcode: str) -> dict | None:
        """Best-effort Open Food Facts barcode lookup, reusing the cascade's client.

        Imported lazily (like the cascade) so a missing optional dep or an offline box
        degrades to None -> the endpoint 404s and the UI falls back to photo capture.
        """
        try:
            from ..vision.identify import _off_lookup as off_lookup
        except Exception:  # noqa: BLE001 - engine unavailable -> no barcode lookup
            return None
        try:
            return off_lookup(barcode)
        except Exception:  # noqa: BLE001 - offline / not found -> fall back
            return None

    # --- the validated cascade, adapted to the flat item contract ----------------

    def _run_cascade(
        self, image: bytes, filename: str, content_type: str | None
    ) -> tuple[list[dict], str, dict | None]:
        """Run identify() and flatten its components. Returns ([], "", None) on failure.

        The scale weight is deliberately NOT passed to identify() — the model is never
        told the weight and the backend does no weight math. Each item carries only its
        per-100g density + fraction (its share of the plate); the client multiplies by the
        live scale weight. The third return value is a verbose debug block (model, raw
        reply, step notes) for the frontend's debug panel."""
        if not settings.openrouter_api_key:
            return [], "", None  # no key -> caller uses the filename fallback
        try:
            # Imported lazily so a missing optional dep (openai/pillow) degrades to the
            # fallback instead of breaking import of the whole service.
            from ..vision import identify
        except Exception:  # noqa: BLE001 - engine deps unavailable -> fallback
            return [], "", None

        mime = content_type or "image/jpeg"
        try:
            result = identify(image, grams=None, mime=mime, verbose=False)
        except Exception:  # noqa: BLE001 - model/network error -> fallback
            return [], "", None

        self._maybe_write_transcript(filename, result)

        top_conf = result.result.get("confidence")
        items: list[dict] = []
        for component in result.result.get("components", []):
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
                    # This component's share of the plate by mass; the client turns it
                    # into grams against the scale weight and prices it off per100.
                    "fraction": round(float(component.get("fraction") or 0.0), 4),
                    "per100": self._per100(per_100g),
                    "confidence": max(0.0, min(1.0, float(confidence))),
                    "fdcId": reference,
                    "source": _SOURCE_LABEL.get(source_tag, source_tag),
                    # Grams-per-serving when the source knows it (Open Food Facts).
                    "servingGrams": (
                        round(float(serving_grams), 1)
                        if serving_grams is not None
                        else None
                    ),
                    # The lookups that produced this food's numbers (debug panel).
                    "trace": component.get("trace", []),
                }
            )
        return items, result.model, self._build_debug(result)

    @staticmethod
    def _build_debug(result) -> dict:
        """Distil the cascade's event transcript into a JSON-safe debug block."""
        model_turn = next(
            (e for e in result.events if e.get("type") == "model_turn"), {}
        )
        barcode_evt = next(
            (e for e in result.events if e.get("type") == "barcode"), None
        )
        return {
            "model": result.model,
            "barcode": barcode_evt.get("value") if barcode_evt else None,
            "modelRaw": model_turn.get("raw"),
            "reasoning": model_turn.get("reasoning"),
            "usage": model_turn.get("usage"),
            "notes": [e["content"] for e in result.events if e.get("type") == "note"],
        }

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
    def _filename_fallback(filename: str, digest: str) -> list[dict]:
        normalized = re.sub(r"[_\-.]+", " ", filename.lower())
        candidates = [name for name in REFERENCE_FOODS if name in normalized]
        if not candidates:
            names = list(REFERENCE_FOODS)
            candidates = [names[int(digest[:8], 16) % len(names)]]
        candidates = candidates[:3]
        # Even split across the guessed foods; the client applies the scale weight.
        fraction = round(1.0 / len(candidates), 4)
        items = []
        for name in candidates:
            calories, protein, carbs, fat = REFERENCE_FOODS[name]
            items.append(
                {
                    "name": name.title(),
                    "fraction": fraction,
                    "per100": {
                        "calories": round(calories),
                        "protein": round(protein, 1),
                        "carbs": round(carbs, 1),
                        "fat": round(fat, 1),
                    },
                    "confidence": 0.45,
                    "fdcId": None,
                    "source": "reference",
                    "servingGrams": None,
                }
            )
        return items
