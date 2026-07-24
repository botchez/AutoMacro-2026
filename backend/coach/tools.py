"""The coach's tools: thin, deterministic reads over a CoachState.

Two things live here:
  1. TOOL_SCHEMAS  — the OpenAI/OpenRouter tool definitions the model sees.
  2. run_tool()    — validates args and dispatches to the matching read.

There is no intelligence here on purpose. The model decides *which* tool to call
and what the numbers mean; these functions just hand back data. When the real DB
exists, swap the bodies for Supabase queries and leave everything else untouched.
"""

from __future__ import annotations

from .state import MACROS, CoachState


# --- tool implementations (bound to a state at dispatch time) ----------------

def get_today_totals(state: CoachState) -> dict:
    return dict(state.totals)


def get_target(state: CoachState) -> dict:
    return dict(state.target)


def get_recent_logs(state: CoachState, n: int) -> dict:
    items = [i.as_dict() for i in state.logs[-n:]]
    return {"count": len(items), "items": items}


def get_current_batch(state: CoachState) -> dict:
    items = [i.as_dict() for i in state.current_batch]
    return {"count": len(items), "items": items}


def search_food_history(state: CoachState, macro: str) -> dict:
    foods = state.history_by_macro.get(macro, [])
    return {"macro": macro, "foods": foods}


def get_day_context(state: CoachState) -> dict:
    return dict(state.day_context)


def get_last_suggestion(state: CoachState) -> dict:
    return {"last_suggestion": state.last_suggestion}


# --- argument validation -----------------------------------------------------

def _validate(name: str, args: dict) -> dict:
    """Never trust raw model args. Coerce/clamp; raise on anything unusable."""
    if name == "get_recent_logs":
        n = args.get("n", 5)
        try:
            n = int(n)
        except (TypeError, ValueError):
            n = 5
        return {"n": max(1, min(n, 50))}

    if name == "search_food_history":
        macro = str(args.get("macro", "")).strip().lower()
        if macro not in MACROS:
            raise ValueError(
                f"macro must be one of {MACROS}, got {macro!r}"
            )
        return {"macro": macro}

    # Zero-arg tools: ignore whatever the model sent.
    return {}


_DISPATCH = {
    "get_today_totals": get_today_totals,
    "get_target": get_target,
    "get_recent_logs": get_recent_logs,
    "get_current_batch": get_current_batch,
    "search_food_history": search_food_history,
    "get_day_context": get_day_context,
    "get_last_suggestion": get_last_suggestion,
}


def run_tool(state: CoachState, name: str, raw_args: dict) -> dict:
    """Validate raw model args, then run the matching read against `state`."""
    fn = _DISPATCH.get(name)
    if fn is None:
        return {"error": f"unknown tool {name!r}"}
    try:
        args = _validate(name, raw_args or {})
    except ValueError as e:
        return {"error": str(e)}
    return fn(state, **args)


# --- schemas the model sees --------------------------------------------------

def _tool(name: str, description: str, properties: dict | None = None,
          required: list[str] | None = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties or {},
                "required": required or [],
            },
        },
    }


TOOL_SCHEMAS = [
    _tool("get_today_totals",
          "Macros the user has consumed so far today (includes the meal just "
          "submitted): kcal, protein, carbs, fat."),
    _tool("get_target",
          "The user's daily target for kcal/protein/carbs/fat plus tolerance_pct, "
          "the +/- percent band that counts as 'close enough'."),
    _tool("get_recent_logs",
          "The last n logged food items today, newest last. Use to spot what the "
          "user just added.",
          {"n": {"type": "integer", "description": "How many recent items.",
                 "minimum": 1, "maximum": 50}}),
    _tool("get_current_batch",
          "The items in the meal batch the user just submitted (what triggered you)."),
    _tool("search_food_history",
          "Foods the user has logged on other days that are high in a given macro. "
          "Use to suggest foods they actually eat.",
          {"macro": {"type": "string", "enum": list(MACROS),
                     "description": "Which macro to find strong foods for."}},
          ["macro"]),
    _tool("get_day_context",
          "Where the user is in their day: time_of_day, meals_logged, and "
          "est_meals_remaining. Use to judge urgency."),
    _tool("get_last_suggestion",
          "Your own previous suggestion to this user today, or null if none. Use to "
          "avoid repeating advice they already acted on."),
]
