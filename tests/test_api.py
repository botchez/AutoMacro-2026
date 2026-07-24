from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


TEST_DIR = tempfile.TemporaryDirectory()
os.environ["NUTRICOACH_DB_PATH"] = str(Path(TEST_DIR.name) / "test.sqlite3")
os.environ["NUTRICOACH_FRONTEND_DIST"] = str(Path(TEST_DIR.name) / "dist")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


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
        coach = self.client.get("/api/coach/tip", headers=self.headers)
        self.assertEqual(coach.status_code, 200)
        self.assertTrue(coach.json()["message"])

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
