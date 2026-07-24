"""Authoritative per-100g macros for a single ingredient, via USDA FoodData Central.

The vision model decomposes a plate into single ingredients (rice, chicken, oil);
this module turns each ingredient NAME into real per-100g macros from USDA FDC —
so the numbers in the log come from a citeable source, not a model guess.

Design:
  - lookup(name) normalizes the name, checks a local SQLite cache, and only calls
    the FDC API on a miss. Hits are stored (with the chosen fdc_id, so the match is
    stable and correctable). Misses are NOT cached — the caller falls back to the
    model's estimate for that component, flagged as such.
  - The cache is a single .sqlite file (isolated-harness pattern, like the coach's
    in-memory state). Swap `_Cache` for a Supabase-backed store later; the lookup
    logic above it doesn't change.

FDC data types are restricted to generic foods (Foundation / SR Legacy / Survey),
whose nutrient values are already per 100 g — no serving-size math needed.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path

FDC_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"
FDC_TIMEOUT_S = 8

# Free key from https://fdc.nal.usda.gov/api-key-signup.html. DEMO_KEY works for a
# handful of test calls but is rate-limited hard — set a real key before the demo.
# Read at CALL time, not import time: a .env loaded by the runner after this module
# is imported must still be picked up.
def _api_key() -> str:
    return os.getenv("FDC_API_KEY", "DEMO_KEY")

# Generic, per-100g data types. Order = preference when we pick a row.
FDC_DATA_TYPES = ["Foundation", "SR Legacy", "Survey (FNDDS)"]

# FDC nutrient numbers -> our macro keys.
_NUTRIENT_MAP = {"208": "kcal", "203": "protein", "205": "carbs", "204": "fat"}

# Processed/prepared qualifiers that usually mean "not the plain ingredient the
# vision model named" — penalize them so "chicken breast" doesn't resolve to
# "chicken breast tenders, breaded, microwaved".
_PROCESSED_MARKERS = (
    "breaded", "batter", "battered", "microwaved", "canned", "sauce", "gravy",
    "fast food", "restaurant", "frozen meal", "dinner", "nugget", "patty",
    "flavored", "seasoned", "smoked", "cured", "sweetened", "with ",
    # derived/dessert forms that shouldn't match a plain-ingredient name
    "yogurt", "juice", "beverage", "drink", "snack", "dessert", "chips",
    "cracker", "cake", "bar,", "spread",
    # FDC "part-only" entries — just the skin/fat of a cut, wildly fatty. "skin ("
    # / "skin," catch "Chicken, skin (drumsticks...)" without hitting "meat and skin".
    "skin (", "skin,",
)

# Prep/generic words that describe HOW a food is done, not WHAT it is. A candidate
# must match at least one non-prep ("content") token — otherwise "bok choy cooked"
# happily matches "Dove, cooked" on the word "cooked" alone.
_PREP_TOKENS = frozenset({
    "cooked", "raw", "boiled", "poached", "steamed", "fried", "roasted", "baked",
    "grilled", "fresh", "nfs", "ns", "prepared", "whole", "and", "or", "the", "a",
})

DEFAULT_DB = Path(__file__).resolve().parent / "foodfacts_cache.sqlite"


# --- cache -------------------------------------------------------------------

class _Cache:
    """Tiny SQLite cache of resolved lookups, keyed by normalized query."""

    def __init__(self, path: Path = DEFAULT_DB):
        self.conn = sqlite3.connect(str(path))
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS foods (
                   query_norm TEXT PRIMARY KEY,
                   fdc_id     INTEGER,
                   food_name  TEXT,
                   kcal REAL, protein REAL, carbs REAL, fat REAL,
                   source     TEXT,
                   fetched_at TEXT
               )"""
        )
        self.conn.commit()

    def get(self, query_norm: str) -> dict | None:
        row = self.conn.execute(
            "SELECT fdc_id, food_name, kcal, protein, carbs, fat, source "
            "FROM foods WHERE query_norm = ?",
            (query_norm,),
        ).fetchone()
        if row is None:
            return None
        fdc_id, name, kcal, protein, carbs, fat, source = row
        return {
            "food_name": name,
            "fdc_id": fdc_id,
            "macros_per_100g": {"kcal": kcal, "protein": protein,
                                "carbs": carbs, "fat": fat},
            "source": source,
            "cached": True,
        }

    def put(self, query_norm: str, result: dict) -> None:
        m = result["macros_per_100g"]
        self.conn.execute(
            "INSERT OR REPLACE INTO foods "
            "(query_norm, fdc_id, food_name, kcal, protein, carbs, fat, source, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (query_norm, result.get("fdc_id"), result["food_name"],
             m.get("kcal"), m.get("protein"), m.get("carbs"), m.get("fat"),
             result.get("source", "fdc"),
             time.strftime("%Y-%m-%dT%H:%M:%S")),
        )
        self.conn.commit()


_cache_singleton: _Cache | None = None


def _cache() -> _Cache:
    global _cache_singleton
    if _cache_singleton is None:
        _cache_singleton = _Cache()
    return _cache_singleton


# --- FDC call ----------------------------------------------------------------

def _normalize(name: str) -> str:
    return " ".join(str(name).strip().lower().split())


def _macros_from_food(food: dict) -> dict | None:
    """Pull per-100g kcal/protein/carbs/fat out of one FDC food record."""
    macros = {"kcal": None, "protein": None, "carbs": None, "fat": None}
    for n in food.get("foodNutrients", []) or []:
        num = str(n.get("nutrientNumber") or n.get("number") or "")
        key = _NUTRIENT_MAP.get(num)
        if key is None:
            # Search-endpoint records sometimes nest under "nutrient".
            nested = n.get("nutrient") or {}
            key = _NUTRIENT_MAP.get(str(nested.get("number") or ""))
        if key is None:
            continue
        val = n.get("value")
        if val is None:
            val = n.get("amount")
        if val is not None and macros[key] is None:
            try:
                macros[key] = round(float(val), 2)
            except (TypeError, ValueError):
                pass
    # Require at least energy to consider it a usable hit.
    return macros if macros["kcal"] is not None else None


def _fdc_search(query: str) -> dict | None:
    # POST with a JSON body: the GET form 400s on data types containing spaces/parens
    # (notably "Survey (FNDDS)"), which is the type that carries cooked/prepared foods.
    api_key = _api_key()
    url = f"{FDC_SEARCH_URL}?{urllib.parse.urlencode({'api_key': api_key})}"
    body = json.dumps({
        "query": query,
        "dataType": FDC_DATA_TYPES,
        # Fetch a wide-ish page and re-rank ourselves: FDC's own relevance sort puts
        # odd part-only rows (skin/fat cuts) above the clean "meat only" entry, so a
        # small pageSize can miss the row we actually want.
        "pageSize": 15,
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "User-Agent": "hackxperience-vision/0.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=FDC_TIMEOUT_S) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # A 429/403 is a KEY problem, not "no such food" — make it visible so a
        # throttled DEMO_KEY isn't mistaken for FDC having no data.
        import sys
        hint = " (DEMO_KEY is rate-limited — set a real FDC_API_KEY)" if api_key == "DEMO_KEY" else ""
        print(f"  [foodfacts] FDC HTTP {e.code} for {query!r}{hint}", file=sys.stderr)
        return None
    except Exception:  # noqa: BLE001 - offline / not found -> miss
        return None

    q_tokens = set(_normalize(query).replace(",", " ").split())
    content_tokens = q_tokens - _PREP_TOKENS
    best, best_score = None, float("-inf")
    for food in data.get("foods", []) or []:
        macros = _macros_from_food(food)
        if macros is None:  # no usable energy value -> skip
            continue
        desc = (food.get("description") or "").lower()
        # The food noun itself must appear — matching only prep words ("cooked")
        # is how a leafy green resolves to pigeon meat. No content match -> reject.
        if content_tokens and not any(t in desc for t in content_tokens):
            continue
        matches = sum(1 for t in q_tokens if t in desc)
        penalty = sum(1 for m in _PROCESSED_MARKERS if m in desc)
        # Reward query-token overlap, punish processed markers and long noisy
        # descriptions; prefer the cleanest generic row.
        score = 2 * matches - 1.5 * penalty - 0.01 * len(desc)
        if score > best_score:
            best, best_score = food, score
            best["_macros"] = macros
    if best is None:
        return None
    return {
        "food_name": best.get("description", query),
        "fdc_id": best.get("fdcId"),
        "macros_per_100g": best["_macros"],
        "source": "fdc",
        "cached": False,
    }


def lookup(name: str, use_cache: bool = True) -> dict | None:
    """Real per-100g macros for an ingredient, or None if FDC has no match.

    None means "no authoritative source" — the caller should fall back to the
    model's estimate and flag it. A hit is cached so repeats are instant/offline.
    """
    q = _normalize(name)
    if not q:
        return None
    if use_cache:
        hit = _cache().get(q)
        if hit is not None:
            return hit
    result = _fdc_search(q)
    if result is not None and use_cache:
        _cache().put(q, result)
    return result


if __name__ == "__main__":
    # Quick manual probe: python -m vision.foodfacts "white rice, cooked" chicken oil
    import sys

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    # Load a .env (vision/ or project root) so a direct probe sees the real key too.
    for cand in (Path.cwd() / ".env", Path(__file__).resolve().parent / ".env",
                 Path(__file__).resolve().parent.parent / ".env"):
        if cand.exists():
            for ln in cand.read_text(encoding="utf-8").splitlines():
                ln = ln.strip()
                if ln and not ln.startswith("#") and "=" in ln:
                    k, _, v = ln.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            break
    queries = sys.argv[1:] or ["white rice, cooked", "chicken breast, cooked",
                               "vegetable oil", "bok choy, cooked"]
    print(f"FDC_API_KEY = {'DEMO_KEY (rate-limited)' if _api_key() == 'DEMO_KEY' else 'set'}")
    for query in queries:
        res = lookup(query)
        if res is None:
            print(f"  {query!r:40} -> no FDC match (would fall back to estimate)")
        else:
            tag = "cache" if res.get("cached") else "api"
            print(f"  {query!r:40} -> [{tag}] {res['food_name']} "
                  f"(fdc {res['fdc_id']}) {json.dumps(res['macros_per_100g'])}")
