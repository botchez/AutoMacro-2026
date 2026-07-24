"""Coach agent — a native tool-calling nutrition coach.

Vendored verbatim from the validated isolated build; the scenario/runner harness
is intentionally left out (the backend feeds it a CoachState built from the DB).
"""

from .agent import CoachResult, run_coach
from .state import CoachState, FoodItem

__all__ = ["run_coach", "CoachResult", "CoachState", "FoodItem"]
