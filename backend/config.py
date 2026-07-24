from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent


# Load a root .env early so every downstream os.getenv (including the vendored
# vision/coach engines, which read their model + key vars at call time) sees it.
# Best-effort: if python-dotenv isn't installed the process env still wins.
try:
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIR / ".env")
except Exception:  # noqa: BLE001 - dotenv missing / unreadable -> rely on real env
    pass


# The validated FDC lookup (backend/vision/foodfacts.py) reads FDC_API_KEY; this repo
# has historically used USDA_FDC_API_KEY. Bridge the two so either name works and the
# vision cascade picks up the key without touching the vendored module.
if not os.getenv("FDC_API_KEY") and os.getenv("USDA_FDC_API_KEY"):
    os.environ["FDC_API_KEY"] = os.environ["USDA_FDC_API_KEY"]


@dataclass(frozen=True)
class Settings:
    database_path: Path = Path(
        os.getenv("NUTRICOACH_DB_PATH", ROOT_DIR / "data" / "nutricoach.sqlite3")
    )
    frontend_dist: Path = Path(
        os.getenv("NUTRICOACH_FRONTEND_DIST", ROOT_DIR / "dist")
    )
    # OpenRouter drives both the vision cascade and the coach agent (one client, one
    # key, one endpoint — only the model slug differs). Set this to enable the model
    # stages; without it both services fall back to their deterministic paths.
    openrouter_api_key: str | None = os.getenv("OPENROUTER_API_KEY")
    # Kill switch for the coach agent's model calls without touching the shared
    # OPENROUTER key (which also drives vision). Set COACH_AGENT_ENABLED=0 to switch the
    # coach's model calls off: it then returns a clear HTTP 502 (there is no canned
    # fallback) instead of spending tokens. Vision is unaffected.
    coach_agent_enabled: bool = os.getenv("COACH_AGENT_ENABLED", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )
    usda_api_key: str | None = os.getenv("USDA_FDC_API_KEY") or os.getenv("FDC_API_KEY")
    # Kept for backward compatibility; no longer the driver (engines use OpenRouter).
    openai_api_key: str | None = os.getenv("OPENAI_API_KEY")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    # When set, each vision/coach run drops a full human-readable transcript here —
    # the same instrumentation the isolated builds produced, handy on the demo floor.
    transcripts_dir: Path | None = (
        Path(os.environ["NUTRICOACH_TRANSCRIPTS"])
        if os.getenv("NUTRICOACH_TRANSCRIPTS")
        else None
    )


settings = Settings()
