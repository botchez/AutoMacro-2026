from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from .config import settings
from .security import hash_password


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    goal_type TEXT NOT NULL CHECK (goal_type IN ('lose', 'maintain', 'gain')),
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fat REAL NOT NULL,
    dietary TEXT NOT NULL,
    units TEXT NOT NULL CHECK (units IN ('metric', 'imperial')),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sex TEXT NOT NULL DEFAULT 'prefer-not'
        CHECK (sex IN ('female', 'male', 'other', 'prefer-not')),
    age INTEGER,
    height REAL,
    weight REAL,
    activity TEXT NOT NULL DEFAULT 'moderate'
        CHECK (activity IN ('low', 'light', 'moderate', 'high')),
    allergies TEXT NOT NULL DEFAULT '',
    week_starts_on TEXT NOT NULL DEFAULT 'monday'
        CHECK (week_starts_on IN ('monday', 'sunday')),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date TEXT NOT NULL,
    log_time TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS meals_user_date_idx
ON meals(user_id, log_date DESC, log_time DESC);

CREATE TABLE IF NOT EXISTS meal_items (
    id TEXT PRIMARY KEY,
    meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    grams REAL NOT NULL,
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fat REAL NOT NULL,
    fdc_id TEXT,
    source TEXT
);

CREATE INDEX IF NOT EXISTS meal_items_meal_idx ON meal_items(meal_id);

CREATE TABLE IF NOT EXISTS fdc_cache (
    query TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vision_cache (
    image_sha256 TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coach_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS coach_messages_user_idx
ON coach_messages(user_id, created_at DESC);

-- The coach's current food suggestions for the sidebar (one row per user, replaced
-- each coach run). Empty/missing means the sidebar shows nothing.
CREATE TABLE IF NOT EXISTS coach_suggestions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    items TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def connect(path: Path | None = None) -> sqlite3.Connection:
    database_path = path or settings.database_path
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path, timeout=10, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


@contextmanager
def transaction(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    connection = connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database(path: Path | None = None) -> None:
    with transaction(path) as connection:
        connection.executescript(SCHEMA)
        _seed_demo(connection)


def _seed_demo(connection: sqlite3.Connection) -> None:
    existing = connection.execute(
        "SELECT id FROM users WHERE email = ?", ("demo@nutricoach.app",)
    ).fetchone()
    if existing:
        return

    user_id = str(uuid4())
    created_at = utc_now()
    connection.execute(
        """
        INSERT INTO users (id, name, email, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            user_id,
            "Demo",
            "demo@nutricoach.app",
            hash_password("demo1234"),
            created_at,
        ),
    )
    connection.execute(
        """
        INSERT INTO goals
        (user_id, goal_type, calories, protein, carbs, fat, dietary, units, updated_at)
        VALUES (?, 'maintain', 2200, 140, 250, 70, 'No restrictions', 'metric', ?)
        """,
        (user_id, created_at),
    )

    sample_days = [
        (
            1,
            [
                ("08:15", [("Oatmeal + berries", 250, 320, 10, 55, 6), ("Latte", 240, 120, 8, 12, 4)]),
                ("13:00", [("Chicken bowl", 400, 640, 48, 60, 18)]),
                ("19:30", [("Salmon + rice", 380, 720, 42, 70, 22)]),
            ],
        ),
        (
            2,
            [
                ("09:00", [("Greek yogurt + honey", 220, 260, 18, 30, 6)]),
                ("12:30", [("Turkey sandwich", 320, 520, 34, 55, 16)]),
            ],
        ),
        (
            3,
            [
                ("08:00", [("Eggs + avocado toast", 300, 540, 24, 40, 28)]),
                ("18:45", [("Pasta bolognese", 420, 780, 32, 90, 24)]),
            ],
        ),
    ]
    today = datetime.now(UTC).date()
    for day_offset, meals in sample_days:
        log_date = (today - timedelta(days=day_offset)).isoformat()
        for log_time, items in meals:
            meal_id = str(uuid4())
            connection.execute(
                """
                INSERT INTO meals (id, user_id, log_date, log_time, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (meal_id, user_id, log_date, log_time, created_at),
            )
            for name, grams, calories, protein, carbs, fat in items:
                connection.execute(
                    """
                    INSERT INTO meal_items
                    (id, meal_id, name, grams, calories, protein, carbs, fat, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed')
                    """,
                    (
                        str(uuid4()),
                        meal_id,
                        name,
                        grams,
                        calories,
                        protein,
                        carbs,
                        fat,
                    ),
                )


def cached_json_get(
    connection: sqlite3.Connection, table: str, key_column: str, key: str
) -> dict | None:
    if table not in {"fdc_cache", "vision_cache"}:
        raise ValueError("Unsupported cache table")
    row = connection.execute(
        f"SELECT payload_json FROM {table} WHERE {key_column} = ?", (key,)
    ).fetchone()
    return json.loads(row["payload_json"]) if row else None
