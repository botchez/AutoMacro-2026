"""The tool-calling loop — the actual agent.

run_coach(state) drives the model over the tools in tools.py until it stops asking
for data and returns advice. Everything here is provider-agnostic OpenAI wire
format pointed at OpenRouter, so the only thing that changes between models is the
COACH_MODEL string.

The run records a full structured transcript — system prompt, user trigger, every
model turn (including its reasoning), each tool's inputs and outputs, token usage,
and the final advice — so you can inspect exactly how the agent thought.
"""

from __future__ import annotations

import json
import os
import time

from openai import OpenAI

from .state import CoachState
from .tools import TOOL_SCHEMAS, run_tool


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Lock the coach model early (spec). Both are OpenRouter slugs — confirm they exist
# on your account before the demo. Override with env vars.
DEFAULT_MODEL = os.getenv("COACH_MODEL", "deepseek/deepseek-v4-flash")
FALLBACK_MODEL = os.getenv("COACH_FALLBACK_MODEL", "openai/gpt-4o-mini")

MAX_ITERATIONS = 5


SYSTEM_PROMPT = """\
You are a supportive nutrition coach. You have tools to read the user's daily \
totals, their target (with a tolerance band), their recent and historical logs, \
the meal they just submitted, and how much of the day remains. On each submit, \
decide where they stand and respond with ONE of:
- a specific suggestion (add more of something, or a food type) when a macro is \
meaningfully short AND there's budget/day left,
- a forward-looking plan for the rest of the day (e.g. "aim protein-heavy at dinner"),
- a gentle note if they're over,
- or simple affirmation ("you're on track — nothing needed") when within tolerance.

HOW TO ASSESS (do this every time):
1. Call get_today_totals, get_target, get_day_context, get_current_batch, and \
get_last_suggestion before deciding. These are cheap — always read them.
2. Evaluate EACH macro (kcal, protein, carbs, fat) SEPARATELY against its own \
target. A macro is "short" if it is below target by MORE than tolerance_pct. \
"Within tolerance" means ALL macros are within their band — never judge on \
calories alone. Protein is usually the binding constraint; check it explicitly.
3. If any macro is short AND the day still has budget/meals left, that is \
actionable. When you want to suggest a food, call search_food_history(macro) for \
the short macro and name a food the user ACTUALLY eats from that list.
4. Look at get_current_batch and get_last_suggestion together: if the batch the \
user just submitted already fulfils your previous suggestion, acknowledge that \
they did it — do NOT repeat the same tip.

POSTURE BY TIME OF DAY: being short early (many meals left) is normal — stay \
informational, do not push "add more now". As est_meals_remaining drops to ~1 and \
a macro is still short, get directive about THAT meal.

Rules: If within the tolerance band, affirm and STOP — do not suggest more. Do not \
repeat a suggestion the user already acted on. Be supportive; never push \
restriction, never shame, never treat "under" as an emergency. Prefer foods the \
user actually eats. Keep it to 1-3 sentences."""


class CoachResult:
    """The outcome of one coach run.

    `events` is the full structured transcript (see the "type" of each dict).
    `transcript()` renders it to a human-readable string. `trace` is a compact
    (kind, ...) tuple list kept for backwards compatibility.
    """

    def __init__(self, text: str, events: list, model: str):
        self.text = text
        self.events = events
        self.model = model

    @property
    def trace(self) -> list:
        out = []
        for e in self.events:
            if e["type"] == "tool_result":
                out.append(("tool", e["name"], e["args"], e["result"]))
            elif e["type"] == "final":
                out.append(("final", e["text"]))
        return out

    def transcript(self) -> str:
        return render_transcript(self.events, self.model)


def _client() -> OpenAI:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. Copy coach/.env.example to .env and "
            "fill it in, or export the variable in your shell."
        )
    return OpenAI(base_url=OPENROUTER_BASE_URL, api_key=api_key)


def _reasoning_of(msg) -> str | None:
    """Pull the model's reasoning/thinking text off the message, if present.

    OpenRouter returns it as a non-standard `reasoning` field, which the OpenAI
    SDK stashes in `model_extra`.
    """
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


def _create(client: OpenAI, model: str, messages: list):
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        tools=TOOL_SCHEMAS,
        tool_choice="auto",
        temperature=0.3,
        # Ask OpenRouter to surface the model's reasoning tokens.
        extra_body={"reasoning": {"enabled": True}},
    )
    # OpenRouter signals provider-side errors (rate limits, timeouts) by returning
    # an error body with no choices. Surface it as an exception so the caller can
    # retry or fall back rather than crashing on resp.choices[0].
    if not resp.choices:
        detail = None
        try:
            detail = resp.to_dict().get("error")
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"no choices from {model}: {detail}")
    return resp


def run_coach(
    state: CoachState,
    trigger: str = "The user just submitted a meal. Coach them.",
    verbose: bool = True,
) -> CoachResult:
    """Run the agent loop against `state` and return advice + a full transcript."""
    client = _client()
    model = DEFAULT_MODEL
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": trigger},
    ]
    events: list = [
        {"type": "system", "content": SYSTEM_PROMPT},
        {"type": "user", "content": trigger},
    ]

    def note(text: str) -> None:
        events.append({"type": "note", "content": text})
        if verbose:
            print(f"  [!] {text}")

    for iteration in range(1, MAX_ITERATIONS + 1):
        resp = None
        # Free/hosted models flake intermittently; retry on the same model before
        # giving up on it and routing to the fallback.
        for attempt in range(3):
            try:
                resp = _create(client, model, messages)
                break
            except Exception as e:  # noqa: BLE001 - retry / fallback routing
                if attempt < 2:
                    note(f"{model} error ({e}); retry {attempt + 1}/2")
                    time.sleep(1.5 * (attempt + 1))
                    continue
                if model != FALLBACK_MODEL:
                    note(f"{model} failed; falling back to {FALLBACK_MODEL}")
                    model = FALLBACK_MODEL
                else:
                    raise
        if resp is None:
            continue  # switched to fallback; re-enter the loop with same messages

        msg = resp.choices[0].message
        reasoning = _reasoning_of(msg)
        tool_calls = []
        for tc in (msg.tool_calls or []):
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            tool_calls.append({"id": tc.id, "name": tc.function.name, "args": args})

        events.append({
            "type": "model_turn",
            "iteration": iteration,
            "reasoning": reasoning,
            "content": (msg.content or "").strip() or None,
            "tool_calls": [{"name": t["name"], "args": t["args"]} for t in tool_calls],
            "usage": _usage_of(resp),
        })
        if verbose:
            print(f"  ── turn {iteration} ({model}) ──")
            if reasoning:
                print(f"     reasoning: {_oneline(reasoning, 300)}")
            for t in tool_calls:
                print(f"     call: {t['name']}({t['args'] or ''})")

        # No tool calls -> this is the final answer.
        if not tool_calls:
            text = (msg.content or "").strip()
            events.append({"type": "final", "reasoning": reasoning, "text": text})
            return CoachResult(text, events, model)

        # Record the assistant turn (with its tool calls) before answering them.
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [
                {
                    "id": t["id"],
                    "type": "function",
                    "function": {"name": t["name"], "arguments": json.dumps(t["args"])},
                }
                for t in tool_calls
            ],
        })

        for t in tool_calls:
            result = run_tool(state, t["name"], t["args"])
            events.append({
                "type": "tool_result",
                "name": t["name"],
                "args": t["args"],
                "result": result,
            })
            if verbose:
                print(f"     -> {t['name']} => {json.dumps(result)}")
            messages.append({
                "role": "tool",
                "tool_call_id": t["id"],
                "content": json.dumps(result),
            })

    # Hit the iteration cap without a final answer.
    text = "(no final advice — hit iteration cap)"
    events.append({"type": "final", "reasoning": None, "text": text})
    return CoachResult(text, events, model)


# --- transcript rendering ----------------------------------------------------

def _oneline(s: str, limit: int = 0) -> str:
    s = " ".join(s.split())
    return s[:limit] + "…" if limit and len(s) > limit else s


def render_transcript(events: list, model: str) -> str:
    """Render a run's events as a readable markdown-ish transcript."""
    lines: list[str] = [f"# Coach run transcript", f"model: {model}", ""]
    for e in events:
        t = e["type"]
        if t == "system":
            lines += ["## SYSTEM PROMPT", e["content"], ""]
        elif t == "user":
            lines += ["## USER TRIGGER", e["content"], ""]
        elif t == "note":
            lines += [f"> NOTE: {e['content']}", ""]
        elif t == "model_turn":
            lines.append(f"## MODEL TURN {e['iteration']}")
            if e.get("reasoning"):
                lines += ["### reasoning", e["reasoning"], ""]
            if e.get("content"):
                lines += ["### content", e["content"], ""]
            if e["tool_calls"]:
                lines.append("### tool calls")
                for c in e["tool_calls"]:
                    lines.append(f"- {c['name']}({json.dumps(c['args'])})")
                lines.append("")
            if e.get("usage"):
                lines += [f"### usage", f"`{json.dumps(e['usage'])}`", ""]
        elif t == "tool_result":
            lines += [
                f"### TOOL RESULT: {e['name']}",
                f"- input:  `{json.dumps(e['args'])}`",
                f"- output: `{json.dumps(e['result'])}`",
                "",
            ]
        elif t == "final":
            if e.get("reasoning"):
                lines += ["## FINAL REASONING", e["reasoning"], ""]
            lines += ["## FINAL ADVICE", e["text"], ""]
    return "\n".join(lines)
