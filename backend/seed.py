"""Repeatable demo seeding.

Run ``python -m backend.seed`` to load a present-ready demo state for the
``demo@nutricoach.app`` user: goals plus meals across the last few days **including
today**, using the user's LOCAL date (matching how the app logs and displays days, so
the dashboard rings, daily totals, and the coach all have live data on open).

Today is deliberately only *partly* logged (breakfast + lunch), leaving the rest of the
day open so the coach has something to suggest.

Pass ``--reset`` to wipe the demo user's existing meals first, so the command is
idempotent — safe to run before every demo to return to the same known state. Without
``--reset`` it won't duplicate meals: if the demo user already has meals it leaves them
alone and tells you to re-run with ``--reset``.

Safe to run while the server is up (SQLite WAL) — refresh the app to see the new data.
"""

from __future__ import annotations

import argparse
from datetime import date, timedelta
from uuid import uuid4

from .config import settings
from .db import initialize_database, transaction, utc_now
from .security import hash_password

DEMO_EMAIL = "demo@nutricoach.app"
DEMO_PASSWORD = "demo1234"

# (day_offset, [(time, [(name, grams, kcal, protein, carbs, fat), ...]), ...]).
# Offset 0 is TODAY, intentionally partial so the coach has room to coach dinner.
DEMO_DAYS: list[tuple[int, list[tuple[str, list[tuple[str, int, int, int, int, int]]]]]] = [
    (
        0,
        [
            ("07:45", [("Greek yogurt + berries", 220, 210, 20, 24, 4)]),
            ("12:30", [("Chicken & rice bowl", 400, 620, 46, 62, 16)]),
        ],
    ),
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
            ("19:00", [("Beef stir-fry + noodles", 430, 780, 40, 82, 26)]),
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


def _ensure_demo_user(connection) -> str:
    row = connection.execute(
        "SELECT id FROM users WHERE email = ?", (DEMO_EMAIL,)
    ).fetchone()
    if row:
        return row["id"]
    user_id = str(uuid4())
    connection.execute(
        "INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, "Demo", DEMO_EMAIL, hash_password(DEMO_PASSWORD), utc_now()),
    )
    return user_id


def _ensure_goals(connection, user_id: str) -> None:
    connection.execute(
        """
        INSERT INTO goals
          (user_id, goal_type, calories, protein, carbs, fat, dietary, units, updated_at)
        VALUES (?, 'maintain', 2200, 140, 250, 70, 'No restrictions', 'metric', ?)
        ON CONFLICT(user_id) DO UPDATE SET
          goal_type = excluded.goal_type, calories = excluded.calories,
          protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat,
          dietary = excluded.dietary, units = excluded.units, updated_at = excluded.updated_at
        """,
        (user_id, utc_now()),
    )


def _insert_meals(connection, user_id: str) -> tuple[int, int]:
    """Insert the demo meals, dated off the LOCAL today. Returns (meals, items)."""
    today = date.today()  # local date — the same basis the app logs meals on
    created_at = utc_now()
    meal_count = item_count = 0
    for offset, meals in DEMO_DAYS:
        log_date = (today - timedelta(days=offset)).isoformat()
        for log_time, items in meals:
            meal_id = str(uuid4())
            connection.execute(
                "INSERT INTO meals (id, user_id, log_date, log_time, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (meal_id, user_id, log_date, log_time, created_at),
            )
            meal_count += 1
            for name, grams, kcal, protein, carbs, fat in items:
                connection.execute(
                    """
                    INSERT INTO meal_items
                      (id, meal_id, name, grams, calories, protein, carbs, fat, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed')
                    """,
                    (str(uuid4()), meal_id, name, grams, kcal, protein, carbs, fat),
                )
                item_count += 1
    return meal_count, item_count


def seed(reset: bool = False) -> dict:
    """(Re)load the demo state. Returns a small summary dict of what happened."""
    initialize_database()  # ensure schema + migrations exist first
    with transaction() as connection:
        user_id = _ensure_demo_user(connection)
        _ensure_goals(connection, user_id)
        if reset:
            # meal_items cascade via the meals FK (ON DELETE CASCADE).
            connection.execute("DELETE FROM meals WHERE user_id = ?", (user_id,))
        existing = connection.execute(
            "SELECT COUNT(*) AS n FROM meals WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
        if existing:
            return {"user_id": user_id, "skipped": True, "meals": 0, "items": 0}
        meals, items = _insert_meals(connection, user_id)
        return {"user_id": user_id, "skipped": False, "meals": meals, "items": items}


def main() -> None:
    parser = argparse.ArgumentParser(description="Load demo data for NutriCoach.")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Wipe the demo user's existing meals before seeding (idempotent reload).",
    )
    args = parser.parse_args()
    result = seed(reset=args.reset)
    print(f"Database: {settings.database_path}")
    if result["skipped"]:
        print(
            f"Demo user {DEMO_EMAIL} already has meals — left untouched.\n"
            "Re-run with --reset to wipe and reload a clean demo state."
        )
    else:
        print(
            f"Seeded {result['meals']} meals ({result['items']} items) including today "
            f"for {DEMO_EMAIL} (password: {DEMO_PASSWORD})."
        )


if __name__ == "__main__":
    main()
