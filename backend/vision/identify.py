"""The vision cascade — one entry point that self-routes any food photo.

identify(image_bytes, grams=None) handles a single frame, cheapest-check-first,
and ALWAYS returns a list of components — the model classifies the image and picks
the count, so there's no single-vs-plate switch:

  - single item (an apple)      -> 1 component,  source "vision"
  - nutrition label             -> 1 component,  source "ocr" (read off the panel)
  - barcode / packaged product  -> 1 component,  source "barcode" (Open Food Facts)
  - composed plate (rice + ...)  -> N components, one per distinct food + oil/sauce

Cascade order (stack.md):
  1. barcode decode  — pyzbar, classical CV, no model. Hit -> Open Food Facts.
  2. one multimodal call — classifies + returns components with weight fractions.

Macros per component come from the most authoritative source available: a label's
own panel (source "ocr"), Open Food Facts (barcode), or a USDA FoodData Central
lookup for named ingredients; the model's own estimate is only a flagged fallback.
The model is NEVER told the scale weight — it only names each food (so the DB lookup
can run) and gives each component a "fraction" (its share of the plate by mass).

The result is weight-agnostic: every component carries `per_100g` + `fraction`, so the
caller (the frontend) does the actual `fraction * grams * per-100g` math against the
live scale weight. `grams` is an optional convenience for CLI/tests — pass it and the
result also carries absolute totals; the API path leaves it None. Everything about the
model call is instrumented into a transcript.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import urllib.parse
import urllib.request

from openai import OpenAI

from . import foodfacts


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Lock the vision model early (spec). OpenRouter slugs — confirm they exist on your
# account and that the primary is MULTIMODAL before the demo. Override with env vars.
DEFAULT_MODEL = os.getenv("VISION_MODEL", "qwen/qwen3.5-flash-02-23")
FALLBACK_MODEL = os.getenv("VISION_FALLBACK_MODEL", "google/gemma-4-26b-a4b-it:free")

# Reasoning toggle for the vision call. ON can help the tricky bits (label-OCR digits,
# fraction arithmetic) but slows TTFT and, on some models, leaks thinking into `content`.
# Flip with VISION_REASONING=0.
VISION_REASONING = os.getenv("VISION_REASONING", "1").lower() in ("1", "true", "yes")

# Token caps. VISION_MAX_TOKENS is the overall completion ceiling; VISION_REASONING_MAX_TOKENS
# bounds just the thinking budget so a model can't ruminate forever — kept well below the
# overall cap so the JSON always has room to finish (a truncated reply = a failed identify).
# 256 turned out to guillotine the model mid-thought on the tricky calls (packaged-vs-label
# routing on a blurry carton), so the default is 1024 — enough headroom to finish reasoning
# without leaving less than the JSON needs. Lower it via env if latency matters more.
VISION_MAX_TOKENS = int(os.getenv("VISION_MAX_TOKENS", "2500"))
VISION_REASONING_MAX_TOKENS = int(os.getenv("VISION_REASONING_MAX_TOKENS", "1024"))

# Downscale for the MODEL call only (image tokens dominate vision cost). 1024px on the
# long edge is the OCR-safe sweet spot — small enough to cut a phone photo ~15x in
# tokens, large enough to keep nutrition-label digits legible. The barcode step still
# runs on the ORIGINAL bytes (classical CV is local + free and wants max resolution).
VISION_MAX_EDGE = int(os.getenv("VISION_MAX_EDGE", "1024"))
VISION_JPEG_QUALITY = int(os.getenv("VISION_JPEG_QUALITY", "85"))

# OpenRouter provider routing. A model like gemma-4-31b-it is served by several upstream
# providers; by default OpenRouter load-balances by price. Sorting by "throughput" pins
# each call to the fastest provider instead (same model, just the quickest host). Set
# VISION_PROVIDER_SORT="" to fall back to OpenRouter's default price routing.
# See https://openrouter.ai/docs/features/provider-routing
VISION_PROVIDER_SORT = os.getenv("VISION_PROVIDER_SORT", "throughput")

MACROS = ("kcal", "protein", "carbs", "fat")

OFF_TIMEOUT_S = 6

# Open Food Facts asks every client to identify itself as "AppName/Version (Contact)".
# READ ops (our barcode lookup + name search) need ONLY this — no account or login;
# a compliant UA also avoids being throttled as an unidentified bot. Override the
# contact via env if you fork this. (Auth is only needed for WRITE ops, which we never do.)
OFF_USER_AGENT = os.getenv(
    "OFF_USER_AGENT", "hackxperience/0.1 (wongyida92@gmail.com)"
)


def _prompt() -> str:
    return f"""\
You identify food from a single photo for a nutrition logger, and you ALWAYS return
a list of components. First classify the image, then respond accordingly:

- SINGLE food item (one apple, a banana, a drink): return EXACTLY ONE component. Do
  NOT split a single food into parts (no "flesh" + "skin", no "bun" + "patty" for a
  plain item).
- NUTRITION LABEL clearly visible and readable: return ONE component, READ the panel,
  give its macros per 100 g (convert from per-serving if needed), set "source":"ocr".
- COMPOSED PLATE / meal with several distinct foods (rice + chicken + veg + sauce):
  return ONE component PER distinct food. ALWAYS add cooking oil / sauce as its own
  small component if the food looks fried, oily, or sauced — it's the most-missed
  source of calories.

CRITICAL — you do NOT provide the nutrition numbers; a database does. Your job is to
NAME each food precisely enough that a nutrition database can be looked up for it:
- packaged/branded products are priced from Open Food Facts via your "off_query",
- raw/whole/home-cooked foods are priced from USDA FoodData Central via your "usda_query".
Get those query strings right — that is the whole task. The "est_per_100g" you give is a
LAST-RESORT fallback used ONLY when the database has no match for your query, so never
inflate your confidence in it; the lookup almost always wins over your own guess.

You are NOT told the weight and you must NOT estimate portion size or grams — a scale
handles that separately and the app does the weight math. Instead give each component a
"fraction" of the total food weight (its share of the plate by mass); fractions MUST sum
to 1.0 (a single item is just 1.0).

For each component:
- "name": what it is.
- "source": "ocr" only if you read its macros off a visible nutrition label, else "vision".
- "packaged": true if this is a BRANDED, manufactured, packaged product — something sold
  in packaging under a brand that a packaged-food database would list (soda, chips, candy
  bar, packaged yogurt/drink, protein bar, cereal, instant noodles). false for whole, raw,
  fresh, or home-cooked foods (an apple, grilled chicken, plain rice, a salad).
- "usda_query": for a NON-packaged food, a plain generic US-English ingredient name a
  nutrition database would list, cooked state included — e.g. "white rice, cooked",
  "chicken breast, cooked", "vegetable oil". Food + cooked state ONLY; no brand or extra
  qualifiers. ALWAYS fill this for a non-packaged food so the FDC lookup can run. Leave
  "" only for a packaged product or a label component.
- "off_query": for a PACKAGED product only, the brand + product name to search a
  packaged-food database — e.g. "Coca-Cola Classic", "Pringles Original", "Alpro Soya
  Yogurt". ALWAYS fill this for a packaged product so the Open Food Facts lookup can run.
  Leave "" for non-packaged foods.
- "est_per_100g": macros per 100 g {{"kcal","protein","carbs","fat"}} — the values you
  read for a label, otherwise your best estimate. FALLBACK ONLY: used just if the DB
  lookup misses, so the app can still show something.
- "cooking_note": brief (fried/steamed/raw/sauced).

Respond with ONLY this JSON, no prose, no code fences:
{{
  "name": "<overall dish or item name>",
  "components": [
    {{"name": "<what it is>", "source": "ocr|vision", "packaged": <true|false>,
      "usda_query": "<generic db name, or ''>", "off_query": "<brand + product, or ''>",
      "fraction": <0..1>, "est_per_100g": {{"kcal": <n>, "protein": <g>, "carbs": <g>, "fat": <g>}},
      "cooking_note": "<brief>"}}
  ],
  "confidence": <0..1>,
  "notes": "<one short line>"
}}"""


class IdentifyResult:
    """The outcome of one identify() run, plus the full instrumented transcript."""

    def __init__(self, result: dict, events: list, model: str):
        self.result = result
        self.events = events
        self.model = model

    @property
    def sources(self) -> list:
        return self.result.get("sources", [])

    def transcript(self) -> str:
        return render_transcript(self.events, self.model)


def _client() -> OpenAI:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. Copy vision/.env.example to .env and "
            "fill it in, or export the variable in your shell."
        )
    return OpenAI(base_url=OPENROUTER_BASE_URL, api_key=api_key)


# --- step 1: barcode -> Open Food Facts --------------------------------------

def _decode_barcode(image_bytes: bytes) -> str | None:
    """Classical CV, no model. Returns the first barcode string, or None.

    pyzbar needs the native zbar library; if it isn't installed we simply skip the
    barcode branch rather than fail the whole cascade.
    """
    try:
        import io

        from PIL import Image
        from pyzbar.pyzbar import decode
    except Exception:  # noqa: BLE001 - lib/DLL missing -> skip barcode step
        return None
    try:
        codes = decode(Image.open(io.BytesIO(image_bytes)))
    except Exception:  # noqa: BLE001
        return None
    for c in codes:
        try:
            return c.data.decode("ascii")
        except Exception:  # noqa: BLE001
            continue
    return None


OFF_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl"


def _off_macros(n: dict) -> dict:
    """Pull uniform per-100g macros out of an Open Food Facts nutriments block."""
    n = n or {}
    kcal = n.get("energy-kcal_100g")
    if kcal is None and n.get("energy_100g") is not None:
        kcal = round(n["energy_100g"] / 4.184, 1)  # kJ -> kcal
    return {
        "kcal": kcal,
        "protein": n.get("proteins_100g"),
        "carbs": n.get("carbohydrates_100g"),
        "fat": n.get("fat_100g"),
    }


def _off_serving_grams(p: dict) -> float | None:
    """Grams per serving from an OFF product, or None. Prefers the numeric
    `serving_quantity`; otherwise parses a gram figure out of `serving_size`
    (e.g. "30 g", "3/4 cup (30 g)")."""
    p = p or {}
    q = p.get("serving_quantity")
    try:
        if q is not None and float(q) > 0:
            return round(float(q), 1)
    except (TypeError, ValueError):
        pass
    size = p.get("serving_size")
    if isinstance(size, str):
        m = re.search(r"([\d.]+)\s*g\b", size)
        if m:
            try:
                grams = float(m.group(1))
                return round(grams, 1) if grams > 0 else None
            except ValueError:
                return None
    return None


def _off_lookup(barcode: str) -> dict | None:
    """Best-effort Open Food Facts barcode lookup -> uniform per-100g, or None."""
    url = (
        "https://world.openfoodfacts.org/api/v2/product/"
        f"{barcode}.json?fields=product_name,nutriments,serving_size,serving_quantity"
    )
    req = urllib.request.Request(url, headers={"User-Agent": OFF_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=OFF_TIMEOUT_S) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - offline / not found -> fall through cascade
        return None
    if data.get("status") != 1:
        return None
    p = data.get("product", {}) or {}
    return {
        "food_name": p.get("product_name") or f"barcode {barcode}",
        "macros_per_100g": _off_macros(p.get("nutriments", {})),
        "serving_grams": _off_serving_grams(p),
        "barcode": barcode,
    }


def _off_search(query: str) -> dict | None:
    """Best-effort Open Food Facts NAME search -> uniform per-100g, or None.

    For packaged/branded foods the model flagged but that have no scannable barcode.
    Picks the most popular product that actually carries usable energy data.
    """
    params = urllib.parse.urlencode({
        "search_terms": query,
        "search_simple": 1,
        "action": "process",
        "json": 1,
        "page_size": 5,
        "sort_by": "popularity_key",  # most-scanned first -> the likeliest product
        "fields": "code,product_name,brands,nutriments,serving_size,serving_quantity",
    })
    req = urllib.request.Request(f"{OFF_SEARCH_URL}?{params}",
                                headers={"User-Agent": OFF_USER_AGENT})
    # The OFF search endpoint (cgi/search.pl) intermittently 503s; give it a couple
    # of tries before giving up and letting the caller fall back to an estimate.
    data = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=OFF_TIMEOUT_S) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except Exception:  # noqa: BLE001 - offline / rate-limited / 503
            if attempt < 2:
                time.sleep(1.0 * (attempt + 1))
                continue
            return None
    for p in (data.get("products") or []):
        macros = _off_macros(p.get("nutriments", {}))
        if macros["kcal"] is None:
            continue  # no usable energy on this candidate -> try the next
        # Show the product name alone — OFF's crowd-sourced `brands` field is noisy
        # (e.g. "Coca Cola Life, Coca-Cola") and prepending it just muddies the label.
        return {
            "food_name": (p.get("product_name") or "").strip() or query,
            "macros_per_100g": macros,
            "serving_grams": _off_serving_grams(p),
            "barcode": p.get("code"),
        }
    return None


# --- the multimodal call -----------------------------------------------------

def _data_uri(image_bytes: bytes, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(image_bytes).decode("ascii")


def _downscale_for_model(image_bytes: bytes, mime: str) -> tuple[bytes, str, str | None]:
    """Shrink an oversized image to VISION_MAX_EDGE on the long edge for the model call.

    Returns (bytes, mime, note). Only touches images larger than the cap — an
    already-small image is passed through untouched (no re-encode, so no fresh JPEG
    artifacts on a label). Best-effort: if Pillow is missing or the bytes aren't a
    decodable image, returns them unchanged with note=None.
    """
    try:
        import io

        from PIL import Image
    except Exception:  # noqa: BLE001 - Pillow missing -> send original
        return image_bytes, mime, None
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except Exception:  # noqa: BLE001 - not a decodable image -> send original
        return image_bytes, mime, None

    long_edge = max(img.size)
    if long_edge <= VISION_MAX_EDGE:
        return image_bytes, mime, None  # already small enough; leave it as-is

    scale = VISION_MAX_EDGE / long_edge
    new_size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    resized = img.resize(new_size, Image.LANCZOS)
    if resized.mode not in ("RGB", "L"):
        resized = resized.convert("RGB")
    buf = io.BytesIO()
    resized.save(buf, format="JPEG", quality=VISION_JPEG_QUALITY)
    out = buf.getvalue()
    note = (f"downscaled {img.width}x{img.height} -> {new_size[0]}x{new_size[1]} "
            f"for the model ({len(image_bytes) // 1024}KB -> {len(out) // 1024}KB)")
    return out, "image/jpeg", note


def _reasoning_of(msg) -> str | None:
    r = getattr(msg, "reasoning", None)
    if r is None:
        extra = getattr(msg, "model_extra", None) or {}
        r = extra.get("reasoning")
    return (r or "").strip() or None


def _usage_of(resp) -> dict | None:
    u = getattr(resp, "usage", None)
    if u is None:
        return None
    try:
        return u.model_dump()
    except Exception:  # noqa: BLE001
        return dict(u) if isinstance(u, dict) else None


def _extract_json(text: str) -> dict | None:
    """Pull the JSON object out of a model reply that may wrap it in prose/fences."""
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.lstrip().startswith("json"):
            s = s.lstrip()[4:]
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(s[start : end + 1])
    except json.JSONDecodeError:
        return None


def _coerce_per_100g(obj: dict | None) -> dict:
    out = {}
    for k in MACROS:
        v = (obj or {}).get(k)
        try:
            out[k] = round(float(v), 2) if v is not None else None
        except (TypeError, ValueError):
            out[k] = None
    return out


def _create(client: OpenAI, model: str, image_bytes: bytes, mime: str, prompt: str):
    reasoning = ({"enabled": True, "max_tokens": VISION_REASONING_MAX_TOKENS}
                 if VISION_REASONING else {"enabled": False})
    extra_body = {"reasoning": reasoning}
    # Route to the fastest upstream provider for this model (same weights, quickest host).
    if VISION_PROVIDER_SORT:
        extra_body["provider"] = {"sort": VISION_PROVIDER_SORT}
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url",
                     "image_url": {"url": _data_uri(image_bytes, mime)}},
                ],
            }
        ],
        temperature=0.1,
        max_tokens=VISION_MAX_TOKENS,
        extra_body=extra_body,
    )
    if not resp.choices:
        detail = None
        try:
            detail = resp.to_dict().get("error")
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"no choices from {model}: {detail}")
    return resp


def _call_vision(client: OpenAI, image_bytes: bytes, mime: str, prompt: str, note):
    """The multimodal call with retry-then-fallback. Returns (resp, model_used)."""
    model = DEFAULT_MODEL
    for attempt in range(3):
        try:
            return _create(client, model, image_bytes, mime, prompt), model
        except Exception as e:  # noqa: BLE001 - retry / fallback routing
            if attempt < 2:
                note(f"{model} error ({e}); retry {attempt + 1}/2")
                time.sleep(1.5 * (attempt + 1))
                continue
            if model != FALLBACK_MODEL:
                note(f"{model} failed; falling back to {FALLBACK_MODEL}")
                model = FALLBACK_MODEL
                try:
                    return _create(client, model, image_bytes, mime, prompt), model
                except Exception as e2:  # noqa: BLE001
                    raise RuntimeError(f"both models failed: {e2}") from e2
            raise


# --- assembling components into a result -------------------------------------

def _normalize_fractions(components: list) -> None:
    """Clamp fractions to >=0 and renormalize so they sum to 1 (in place)."""
    fracs = []
    for c in components:
        try:
            f = max(0.0, float(c.get("fraction", 0)))
        except (TypeError, ValueError):
            f = 0.0
        c["fraction"] = f
        fracs.append(f)
    total = sum(fracs)
    if total <= 0:  # nothing usable -> split evenly
        n = len(components) or 1
        for c in components:
            c["fraction"] = 1.0 / n
        return
    for c in components:
        c["fraction"] = round(c["fraction"] / total, 4)


def _resolve_component(raw: dict, note) -> dict:
    """Turn one model component into {name, macro_source, per_100g, ...}.

    Macro source priority: a label's own panel (ocr) > USDA FDC lookup > the model's
    own estimate (flagged). Fraction/cooking_note are carried through.
    """
    name = str(raw.get("name") or "unknown").strip()
    src = str(raw.get("source", "vision")).lower()
    comp = {"name": name, "fraction": raw.get("fraction", 0.0)}
    if raw.get("cooking_note"):
        comp["cooking_note"] = str(raw["cooking_note"]).strip()

    # Packaged/branded product -> Open Food Facts name search is the authoritative
    # source for a manufactured item, so it takes priority even when the model also
    # claims to have OCR'd the carton. A branded product that OFF lists exactly beats a
    # "45 kcal" label read that's easy to over-claim (models routinely tag a packaged
    # item "ocr" and hand back round, generic macros). Fall back to the label read or
    # the model's estimate only when OFF has no usable match.
    if raw.get("packaged"):
        off_query = str(raw.get("off_query") or name).strip()
        comp["off_query"] = off_query
        hit = _off_search(off_query)
        if hit is not None:
            comp["per_100g"] = _coerce_per_100g(hit["macros_per_100g"])
            comp["macro_source"] = "off"
            comp["off_match"] = hit["food_name"]
            if hit.get("serving_grams") is not None:
                comp["serving_grams"] = hit["serving_grams"]
            if hit.get("barcode"):
                comp["barcode"] = hit["barcode"]
            note(f"{name!r} -> Open Food Facts: {hit['food_name']}")
            return comp
        # OFF miss (e.g. the model misread the brand, or OFF 503'd). A genuine label
        # read is still ground truth; otherwise fall through to a generic USDA FDC
        # lookup on the food name below — a named product like "orange juice" is in FDC
        # even when the exact brand isn't in OFF — before we ever use the bare estimate.
        if src == "ocr":
            comp["per_100g"] = _coerce_per_100g(raw.get("est_per_100g"))
            comp["macro_source"] = "label"
            note(f"{name!r} -> packaged, no Open Food Facts match; using label read")
            return comp
        note(f"{name!r} -> packaged, no Open Food Facts match; trying USDA FDC for the generic food")
        # fall through to the FDC lookup below

    if src == "ocr":  # non-packaged label read -> the panel is the ground truth
        comp["per_100g"] = _coerce_per_100g(raw.get("est_per_100g"))
        comp["macro_source"] = "label"
        note(f"{name!r} -> read from nutrition label")
        return comp

    query = str(raw.get("usda_query") or name).strip()
    hit = foodfacts.lookup(query)
    if hit is not None:
        comp["per_100g"] = _coerce_per_100g(hit["macros_per_100g"])
        comp["macro_source"] = "fdc/cache" if hit.get("cached") else "fdc"
        comp["fdc_match"] = hit.get("food_name")
        comp["fdc_id"] = hit.get("fdc_id")
        comp["usda_query"] = query
        note(f"{name!r} -> FDC: {hit.get('food_name')} (fdc {hit.get('fdc_id')})")
    else:
        comp["per_100g"] = _coerce_per_100g(raw.get("est_per_100g"))
        comp["macro_source"] = "estimate"
        comp["usda_query"] = query
        note(f"{name!r} -> no FDC match; using model estimate")
    return comp


def _build_result(name: str, components: list, grams: float | None,
                  events: list, extra: dict | None = None) -> dict:
    """Fold resolved components into the uniform result (with/without a weight)."""
    # Effective per-100g of the whole item = fraction-weighted sum of components.
    per_100g = {k: 0.0 for k in MACROS}
    for c in components:
        for k in MACROS:
            v = c["per_100g"].get(k)
            if v is not None:
                per_100g[k] += c["fraction"] * v
    per_100g = {k: round(v, 2) for k, v in per_100g.items()}

    totals = None
    if grams is not None:
        totals = {k: 0.0 for k in MACROS}
        for c in components:
            g = round(c["fraction"] * grams, 1)
            c["grams"] = g
            c["macros"] = {k: (round(c["per_100g"][k] / 100 * g, 1)
                               if c["per_100g"].get(k) is not None else None)
                           for k in MACROS}
            for k in MACROS:
                if c["macros"][k] is not None:
                    totals[k] += c["macros"][k]
        totals = {k: round(v, 1) for k, v in totals.items()}

    sources = sorted({c["macro_source"] for c in components})
    result = {
        "name": name,
        "components": components,
        "macros_per_100g": per_100g,
        "total_grams": grams,
        "totals": totals,
        "sources": sources,
        "has_estimate": any(c["macro_source"] == "estimate" for c in components),
    }
    if extra:
        result.update(extra)
    events.append({"type": "final", "result": result})
    return result


# --- the one entry point -----------------------------------------------------

def identify(image_bytes: bytes, grams: float | None = None,
             mime: str = "image/jpeg", verbose: bool = True) -> IdentifyResult:
    """Identify any food photo. Returns components + macros (absolute if grams given)."""
    events: list = [{"type": "input", "bytes": len(image_bytes), "mime": mime,
                     "total_grams": grams}]

    def note(text: str) -> None:
        events.append({"type": "note", "content": text})
        if verbose:
            print(f"  [!] {text}")

    # Step 1 — barcode (deterministic, no model, no spend).
    barcode = _decode_barcode(image_bytes)
    if barcode:
        note(f"barcode decoded: {barcode}")
        events.append({"type": "barcode", "value": barcode})
        off = _off_lookup(barcode)
        if off is not None:
            note(f"Open Food Facts hit: {off['food_name']}")
            events.append({"type": "off_hit", "result": off})
            comp = {"name": off["food_name"], "fraction": 1.0,
                    "per_100g": _coerce_per_100g(off["macros_per_100g"]),
                    "macro_source": "barcode", "barcode": barcode}
            if off.get("serving_grams") is not None:
                comp["serving_grams"] = off["serving_grams"]
            result = _build_result(off["food_name"], [comp], grams, events)
            return IdentifyResult(result, events, "barcode/off")
        note("barcode found but no Open Food Facts match; routing to the model")
    else:
        note("no barcode; routing to the multimodal model")

    # Step 2 — the multimodal classify + decompose call. Downscale first: image tokens
    # dominate the cost, and 1024px stays OCR-legible. Barcode above already used the
    # full-resolution original.
    model_bytes, model_mime, resize_note = _downscale_for_model(image_bytes, mime)
    if resize_note:
        note(resize_note)
    client = _client()
    resp, model = _call_vision(client, model_bytes, model_mime, _prompt(), note)
    msg = resp.choices[0].message
    reasoning = _reasoning_of(msg)
    raw = (msg.content or "").strip()
    parsed = _extract_json(raw)
    events.append({"type": "model_turn", "reasoning": reasoning, "raw": raw,
                   "parsed": parsed, "usage": _usage_of(resp)})
    if verbose:
        print(f"  ── vision call ({model}) ──")
        if reasoning:
            print(f"     reasoning: {_oneline(reasoning, 300)}")
        print(f"     raw: {_oneline(raw, 300)}")

    if parsed is None or not parsed.get("components"):
        result = {"name": "unknown", "components": [],
                  "macros_per_100g": {k: None for k in MACROS},
                  "total_grams": grams, "totals": None, "sources": [],
                  "has_estimate": False, "error": "could not parse model JSON"}
        events.append({"type": "final", "result": result})
        return IdentifyResult(result, events, model)

    raw_components = parsed["components"]
    _normalize_fractions(raw_components)
    components = [_resolve_component(c, note) for c in raw_components]
    for c in components:  # emit per-component events for the transcript
        events.append({"type": "component", "component": c})

    extra = {}
    if parsed.get("confidence") is not None:
        try:
            extra["confidence"] = round(float(parsed["confidence"]), 2)
        except (TypeError, ValueError):
            pass
    if parsed.get("notes"):
        extra["notes"] = str(parsed["notes"]).strip()

    name = str(parsed.get("name") or components[0]["name"]).strip()
    result = _build_result(name, components, grams, events, extra)
    return IdentifyResult(result, events, model)


# --- transcript rendering ----------------------------------------------------

def _oneline(s: str, limit: int = 0) -> str:
    s = " ".join((s or "").split())
    return s[:limit] + "…" if limit and len(s) > limit else s


def render_transcript(events: list, model: str) -> str:
    lines: list[str] = ["# Vision identify transcript", f"model: {model}", ""]
    for e in events:
        t = e["type"]
        if t == "input":
            extra = f", measured {e['total_grams']} g" if e.get("total_grams") is not None else ""
            lines += ["## INPUT", f"- {e['bytes']} bytes, `{e['mime']}`{extra}", ""]
        elif t == "component":
            c = e["component"]
            head = f"### COMPONENT: {c['name']}  ({c['macro_source']})"
            if c.get("off_match"):
                q = f"- OFF query: `{c.get('off_query', '')}`  → {c['off_match']}"
            elif c.get("fdc_match"):
                q = f"- FDC query: `{c.get('usda_query', '')}`  → {c['fdc_match']} (fdc {c.get('fdc_id')})"
            else:
                q = f"- query: `{c.get('usda_query') or c.get('off_query') or ''}`"
            split = (f"- {c['fraction'] * 100:.0f}% of total"
                     + (f" = {c['grams']} g" if c.get("grams") is not None else "")
                     + (f"  · {c['cooking_note']}" if c.get("cooking_note") else ""))
            lines += [head, q, split,
                      f"- per 100g: `{json.dumps(c['per_100g'])}`"]
            if c.get("macros") is not None:
                lines.append(f"- contributes: `{json.dumps(c['macros'])}`")
            lines.append("")
        elif t == "note":
            lines += [f"> NOTE: {e['content']}", ""]
        elif t == "barcode":
            lines += ["## BARCODE", f"`{e['value']}`", ""]
        elif t == "off_hit":
            lines += ["## OPEN FOOD FACTS", f"`{json.dumps(e['result'])}`", ""]
        elif t == "model_turn":
            lines.append("## MODEL TURN")
            if e.get("reasoning"):
                lines += ["### reasoning", e["reasoning"], ""]
            lines += ["### raw response", "```", e.get("raw") or "", "```", ""]
            if e.get("parsed") is not None:
                lines += ["### parsed", f"`{json.dumps(e['parsed'])}`", ""]
            if e.get("usage"):
                lines += ["### usage", f"`{json.dumps(e['usage'])}`", ""]
        elif t == "final":
            lines += ["## FINAL RESULT", f"`{json.dumps(e['result'])}`", ""]
    return "\n".join(lines)
