"""A tiny in-memory registry of the coach's live progress, keyed by user.

The coach agent runs a multi-step tool-calling loop inside one HTTP request, so the
client can't see what it's doing until the whole thing returns. This registry lets the
agent publish a running list of steps ("Checking your target", "Searching your history")
that a cheap GET /api/coach/status endpoint hands back, so the UI can show the coach
actually calling its tools in real time.

Deliberately in-process and best-effort: it's a live progress hint, not a source of
truth (the committed messages in the DB are). A single dev/uvicorn worker shares one
registry; if the process restarts mid-run the client just falls back to polling history
for the committed reply. A lock guards it because the agent runs in a threadpool while
the status endpoint reads from the event loop.
"""

from __future__ import annotations

import threading
import time

_lock = threading.Lock()
# user_id -> {"active": bool, "steps": list[str], "started_at": float, "updated_at": float}
_runs: dict[str, dict] = {}


def start(user_id: str) -> None:
    """Begin a fresh run for this user, clearing any previous steps."""
    with _lock:
        _runs[user_id] = {
            "active": True,
            "steps": [],
            "started_at": time.time(),
            "updated_at": time.time(),
        }


def add_step(user_id: str, text: str) -> None:
    """Append a human-readable step to the user's active run (no-op if none)."""
    with _lock:
        run = _runs.get(user_id)
        if run is None or not run["active"]:
            return
        run["steps"].append(text)
        run["updated_at"] = time.time()


def finish(user_id: str) -> None:
    """Mark the user's run complete; the steps stay readable until the next start()."""
    with _lock:
        run = _runs.get(user_id)
        if run is not None:
            run["active"] = False
            run["updated_at"] = time.time()


def get(user_id: str) -> dict:
    """Snapshot of the user's run for the status endpoint: {active, steps}."""
    with _lock:
        run = _runs.get(user_id)
        if run is None:
            return {"active": False, "steps": []}
        return {"active": run["active"], "steps": list(run["steps"])}
