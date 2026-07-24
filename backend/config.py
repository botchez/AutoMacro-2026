from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    database_path: Path = Path(
        os.getenv("NUTRICOACH_DB_PATH", ROOT_DIR / "data" / "nutricoach.sqlite3")
    )
    frontend_dist: Path = Path(
        os.getenv("NUTRICOACH_FRONTEND_DIST", ROOT_DIR / "dist")
    )
    openai_api_key: str | None = os.getenv("OPENAI_API_KEY")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    usda_api_key: str | None = os.getenv("USDA_FDC_API_KEY")


settings = Settings()
