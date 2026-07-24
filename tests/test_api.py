from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


TEST_DIR = tempfile.TemporaryDirectory()
os.environ["NUTRICOACH_DB_PATH"] = str(Path(TEST_DIR.name) / "test.sqlite3")
os.environ["NUTRICOACH_FRONTEND_DIST"] = str(Path(TEST_DIR.name) / "dist")

from fastapi.testclient import TestClient  # noqa: E402

from backend.coach.agent import CoachResult  # noqa: E402
from backend.main import app  # noqa: E402

# Stand-in settings so the coach's agent path is active without depending on a real
# OPENROUTER_API_KEY / .env; run_coach is mocked, so nothing hits the network.
_AGENT_SETTINGS = SimpleNamespace(
    openrouter_api_key="test-key", coach_agent_enabled=True, transcripts_dir=None
)


def fake_run_coach(state, trigger, verbose=True, mode="auto", history=None):
    """Stand-in for the real agent: returns advice + suggestions without any network."""
    if mode == "auto":
        return CoachResult(
            "Nice batch — add a bit more protein to close the gap.",
            [],
            "mock-model",
            [{"name": "Greek yogurt", "serving": "200 g", "reason": "Quick protein"}],
        )
    return CoachResult(
        f"Here's my take on: {trigger}",
        [],
        "mock-model",
        [{"name": "Chicken breast", "serving": "150 g", "reason": "Lean protein"}],
    )


class ApiFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()
        response = cls.client.post(
            "/api/auth/login",
            json={"email": "demo@nutricoach.app", "password": "demo1234"},
        )
        assert response.status_code == 200, response.text
        cls.headers = {"Authorization": f"Bearer {response.json()['token']}"}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        TEST_DIR.cleanup()

    def test_health_and_state(self):
        self.assertEqual(self.client.get("/api/health").json(), {"status": "ok"})
        response = self.client.get("/api/state", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["email"], "demo@nutricoach.app")
        self.assertGreaterEqual(len(response.json()["logs"]), 3)

    def test_profile_log_and_coach_flow(self):
        goals = {
            "goalType": "gain",
            "calories": 2600,
            "protein": 170,
            "carbs": 300,
            "fat": 80,
            "dietary": "No restrictions",
            "units": "metric",
        }
        self.assertEqual(
            self.client.put("/api/goals", headers=self.headers, json=goals).status_code,
            200,
        )
        meal = {
            "id": "test-meal",
            "date": "2026-07-24",
            "time": "12:30",
            "items": [
                {
                    "id": "test-food",
                    "name": "Greek Yogurt",
                    "grams": 200,
                    "calories": 118,
                    "protein": 20,
                    "carbs": 7.2,
                    "fat": 0.8,
                    "source": "test",
                }
            ],
        }
        response = self.client.post("/api/logs", headers=self.headers, json=meal)
        self.assertEqual(response.status_code, 201, response.text)
        meal["time"] = "13:15"
        meal["items"][0]["grams"] = 220
        updated = self.client.put(
            "/api/logs/test-meal", headers=self.headers, json=meal
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        state = self.client.get("/api/state", headers=self.headers).json()
        saved = next(
            meal
            for day in state["logs"]
            for meal in day["meals"]
            if meal["id"] == "test-meal"
        )
        self.assertEqual(saved["time"], "13:15")
        self.assertEqual(saved["items"][0]["grams"], 220)
        # The coach runs the (mocked) agent. Suggestions are agent-driven via
        # suggest_foods, shaped {name, serving, reason}.
        with patch("backend.services.coach.run_coach", side_effect=fake_run_coach), patch(
            "backend.services.coach.settings", _AGENT_SETTINGS
        ):
            coach = self.client.get("/api/coach/tip", headers=self.headers)
            self.assertEqual(coach.status_code, 200, coach.text)
            self.assertEqual(coach.json()["source"], "coach-agent")
            self.assertTrue(coach.json()["message"])
            recs = coach.json()["recommendations"]
            self.assertTrue(recs)
            self.assertEqual(set(recs[0]), {"name", "serving", "reason"})
            question = self.client.post(
                "/api/coach/message",
                headers=self.headers,
                json={"message": "What should I eat next?"},
            )
            self.assertEqual(question.status_code, 200)
            self.assertIsInstance(question.json()["recommendations"], list)
            history = self.client.get("/api/coach/history", headers=self.headers)
            self.assertEqual(history.status_code, 200)
            self.assertGreaterEqual(len(history.json()["messages"]), 2)
            # The sidebar persists the coach's latest suggestions across reloads.
            self.assertTrue(history.json()["recommendations"])

        # Fail loud: when the agent errors there is no rule fallback — the coach
        # surfaces a 502 with the reason instead of a canned reply.
        with patch(
            "backend.services.coach.run_coach",
            side_effect=RuntimeError("no choices from model"),
        ), patch("backend.services.coach.settings", _AGENT_SETTINGS):
            failed = self.client.get("/api/coach/tip", headers=self.headers)
            self.assertEqual(failed.status_code, 502)
            self.assertIn("coach agent error", failed.json()["detail"])

        deleted = self.client.delete("/api/logs/test-meal", headers=self.headers)
        self.assertEqual(deleted.status_code, 204)

    def test_vision_fallback_and_cache(self):
        image = b"\x89PNG\r\n\x1a\n" + b"test-image-content"
        files = {"image": ("banana.png", image, "image/png")}
        first = self.client.post(
            "/api/vision/analyze",
            headers=self.headers,
            files=files,
            data={"weight": "120"},
        )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["items"][0]["grams"], 120)
        second = self.client.post(
            "/api/vision/analyze",
            headers=self.headers,
            files=files,
            data={"weight": "120"},
        )
        self.assertTrue(second.json()["cached"])


if __name__ == "__main__":
    unittest.main()
