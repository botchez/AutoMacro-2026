from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import connect, initialize_database, transaction, utc_now
from .models import (
    AuthIn,
    AuthOut,
    CoachHistoryOut,
    CoachMessageIn,
    CoachOut,
    GoalsIn,
    MealIn,
    SignupIn,
    UserOut,
    VisionOut,
)
from .security import (
    hash_password,
    new_session_token,
    token_digest,
    verify_password,
)
from .services.coach import CoachService
from .services.vision import VisionCascade


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="NutriCoach",
    version="1.0.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


def db_connection():
    connection = connect()
    try:
        yield connection
    finally:
        connection.close()


def current_user(
    authorization: str | None = Header(default=None),
    connection: sqlite3.Connection = Depends(db_connection),
) -> sqlite3.Row:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    digest = token_digest(authorization.removeprefix("Bearer ").strip())
    row = connection.execute(
        """
        SELECT u.* FROM users u
        JOIN sessions s ON s.user_id = u.id
        WHERE s.token_hash = ?
        """,
        (digest,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return row


def user_out(row: sqlite3.Row) -> UserOut:
    return UserOut(id=row["id"], name=row["name"], email=row["email"])


def create_session(connection: sqlite3.Connection, user_id: str) -> str:
    token = new_session_token()
    connection.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)",
        (token_digest(token), user_id, utc_now()),
    )
    return token


@app.get("/api/health")
def health() -> dict:
    with transaction() as connection:
        connection.execute("SELECT 1").fetchone()
    return {"status": "ok"}


@app.post("/api/auth/signup", response_model=AuthOut, status_code=201)
def signup(payload: SignupIn, connection: sqlite3.Connection = Depends(db_connection)):
    user_id = str(uuid4())
    try:
        with connection:
            connection.execute(
                """
                INSERT INTO users (id, name, email, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    payload.name.strip(),
                    payload.email.lower(),
                    hash_password(payload.password),
                    utc_now(),
                ),
            )
            token = create_session(connection, user_id)
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="Email is already registered") from error
    return AuthOut(
        token=token,
        user=UserOut(id=user_id, name=payload.name.strip(), email=payload.email.lower()),
    )


@app.post("/api/auth/login", response_model=AuthOut)
def login(payload: AuthIn, connection: sqlite3.Connection = Depends(db_connection)):
    row = connection.execute(
        "SELECT * FROM users WHERE email = ?", (payload.email.lower(),)
    ).fetchone()
    if not row or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    with connection:
        token = create_session(connection, row["id"])
    return AuthOut(token=token, user=user_out(row))


@app.delete("/api/auth/session", status_code=204)
def logout(
    authorization: str | None = Header(default=None),
    connection: sqlite3.Connection = Depends(db_connection),
):
    if authorization and authorization.startswith("Bearer "):
        with connection:
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (token_digest(authorization.removeprefix("Bearer ").strip()),),
            )


@app.get("/api/state")
def state(
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    goals = connection.execute(
        "SELECT * FROM goals WHERE user_id = ?", (user["id"],)
    ).fetchone()
    meals = connection.execute(
        """
        SELECT * FROM meals WHERE user_id = ?
        ORDER BY log_date DESC, log_time ASC
        """,
        (user["id"],),
    ).fetchall()
    logs_by_date: dict[str, dict] = {}
    for meal in meals:
        items = connection.execute(
            "SELECT * FROM meal_items WHERE meal_id = ? ORDER BY rowid",
            (meal["id"],),
        ).fetchall()
        log = logs_by_date.setdefault(
            meal["log_date"], {"date": meal["log_date"], "meals": []}
        )
        log["meals"].append(
            {
                "id": meal["id"],
                "time": meal["log_time"],
                "items": [
                    {
                        "id": item["id"],
                        "name": item["name"],
                        "grams": item["grams"],
                        "calories": item["calories"],
                        "protein": item["protein"],
                        "carbs": item["carbs"],
                        "fat": item["fat"],
                        "fdcId": item["fdc_id"],
                        "source": item["source"],
                    }
                    for item in items
                ],
            }
        )
    goals_payload = None
    if goals:
        goals_payload = {
            "goalType": goals["goal_type"],
            "calories": goals["calories"],
            "protein": goals["protein"],
            "carbs": goals["carbs"],
            "fat": goals["fat"],
            "dietary": goals["dietary"],
            "units": goals["units"],
        }
    return {
        "user": user_out(user).model_dump(),
        "goals": goals_payload,
        "logs": list(logs_by_date.values()),
    }


@app.put("/api/goals")
def put_goals(
    payload: GoalsIn,
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    with connection:
        connection.execute(
            """
            INSERT INTO goals
            (user_id, goal_type, calories, protein, carbs, fat, dietary, units, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              goal_type = excluded.goal_type,
              calories = excluded.calories,
              protein = excluded.protein,
              carbs = excluded.carbs,
              fat = excluded.fat,
              dietary = excluded.dietary,
              units = excluded.units,
              updated_at = excluded.updated_at
            """,
            (
                user["id"],
                payload.goalType,
                payload.calories,
                payload.protein,
                payload.carbs,
                payload.fat,
                payload.dietary,
                payload.units,
                utc_now(),
            ),
        )
    return payload.model_dump(by_alias=True)


@app.post("/api/logs", status_code=201)
def add_log(
    payload: MealIn,
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    meal_id = payload.id or str(uuid4())
    try:
        with connection:
            connection.execute(
                """
                INSERT INTO meals (id, user_id, log_date, log_time, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (meal_id, user["id"], payload.date, payload.time, utc_now()),
            )
            for item in payload.items:
                connection.execute(
                    """
                    INSERT INTO meal_items
                    (id, meal_id, name, grams, calories, protein, carbs, fat, fdc_id, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item.id or str(uuid4()),
                        meal_id,
                        item.name,
                        item.grams,
                        item.calories,
                        item.protein,
                        item.carbs,
                        item.fat,
                        item.fdcId,
                        item.source,
                    ),
                )
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="Meal already exists") from error
    return {"id": meal_id}


@app.put("/api/logs/{meal_id}")
def update_log(
    meal_id: str,
    payload: MealIn,
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    owned = connection.execute(
        "SELECT id FROM meals WHERE id = ? AND user_id = ?",
        (meal_id, user["id"]),
    ).fetchone()
    if not owned:
        raise HTTPException(status_code=404, detail="Meal not found")
    with connection:
        connection.execute(
            "UPDATE meals SET log_date = ?, log_time = ? WHERE id = ?",
            (payload.date, payload.time, meal_id),
        )
        connection.execute("DELETE FROM meal_items WHERE meal_id = ?", (meal_id,))
        for item in payload.items:
            connection.execute(
                """
                INSERT INTO meal_items
                (id, meal_id, name, grams, calories, protein, carbs, fat, fdc_id, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id or str(uuid4()),
                    meal_id,
                    item.name,
                    item.grams,
                    item.calories,
                    item.protein,
                    item.carbs,
                    item.fat,
                    item.fdcId,
                    item.source,
                ),
            )
    return {"id": meal_id}


@app.delete("/api/logs/{meal_id}", status_code=204)
def delete_log(
    meal_id: str,
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    with connection:
        result = connection.execute(
            "DELETE FROM meals WHERE id = ? AND user_id = ?",
            (meal_id, user["id"]),
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Meal not found")


@app.post("/api/vision/analyze", response_model=VisionOut)
async def analyze_vision(
    image: UploadFile = File(...),
    weight: float | None = Form(default=None),
    _: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Upload must be an image")
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image is empty")
    if len(image_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image must be 12 MB or smaller")
    with connection:
        return await VisionCascade(connection).analyze(
            image_bytes,
            image.filename or "meal.jpg",
            image.content_type,
            weight,
        )


@app.get("/api/coach/tip", response_model=CoachOut)
async def coach_tip(
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    with connection:
        return await CoachService(connection).reply(user["id"])


@app.get("/api/coach/history", response_model=CoachHistoryOut)
def coach_history(
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    return CoachService(connection).history(user["id"])


@app.post("/api/coach/message", response_model=CoachOut)
async def coach_message(
    payload: CoachMessageIn,
    user: sqlite3.Row = Depends(current_user),
    connection: sqlite3.Connection = Depends(db_connection),
):
    with connection:
        return await CoachService(connection).reply(user["id"], payload.message)


assets_dir = settings.frontend_dist / "assets"
if assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path.startswith("api/"):
        raise HTTPException(status_code=404)
    dist = settings.frontend_dist
    requested = (dist / path).resolve()
    if path and requested.is_file() and requested.is_relative_to(dist.resolve()):
        return FileResponse(requested)
    index = dist / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(
        status_code=503,
        detail="Frontend is not built. Run npm run build first.",
    )
