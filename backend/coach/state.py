"""In-memory state for the coach agent.

For feasibility testing the whole "database" is a single CoachState object seeded
per scenario. When Supabase exists, only the tool bodies in tools.py change — this
file and the agent loop stay the same shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field


MACROS = ("kcal", "protein", "carbs", "fat")


@dataclass
class FoodItem:
    """One logged food. macros are the amounts actually eaten (not per-100g)."""

    name: str
    kcal: float = 0.0
    protein: float = 0.0
    carbs: float = 0.0
    fat: float = 0.0

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "kcal": self.kcal,
            "protein": self.protein,
            "carbs": self.carbs,
            "fat": self.fat,
        }


@dataclass
class CoachState:
    """Everything the coach can read for one point-in-time on one user's day."""

    # Consumed so far today (running totals, includes the just-submitted batch).
    totals: dict = field(default_factory=lambda: {m: 0.0 for m in MACROS})

    # The user's goal for the day plus the "close enough" band.
    target: dict = field(
        default_factory=lambda: {
            "kcal": 2200.0,
            "protein": 150.0,
            "carbs": 220.0,
            "fat": 70.0,
            "tolerance_pct": 10.0,
        }
    )

    # Full log for today, oldest first. get_recent_logs slices the tail.
    logs: list[FoodItem] = field(default_factory=list)

    # The meal batch that just triggered this coach run.
    current_batch: list[FoodItem] = field(default_factory=list)

    # Foods the user has eaten on other days — the "what they actually eat" memory.
    # macro name -> list of food names strong in that macro.
    history_by_macro: dict = field(default_factory=dict)

    # Where we are in the day.
    day_context: dict = field(
        default_factory=lambda: {
            "time_of_day": "afternoon",
            "meals_logged": 2,
            "est_meals_remaining": 1,
        }
    )

    # The coach's own previous message, or None if this is the first run today.
    last_suggestion: str | None = None

    # Foods the agent chose to surface in the UI sidebar this run, set via the
    # suggest_foods tool. Empty unless the agent actually recommended something.
    suggestions: list = field(default_factory=list)
