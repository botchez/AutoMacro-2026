from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class UserOut(ApiModel):
    id: str
    name: str
    email: str


class AuthIn(ApiModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class SignupIn(AuthIn):
    name: str = Field(min_length=1, max_length=80)


class AuthOut(ApiModel):
    token: str
    user: UserOut


class GoalsIn(ApiModel):
    goalType: Literal["lose", "maintain", "gain"]
    calories: float = Field(gt=0, le=20_000)
    protein: float = Field(ge=0, le=2_000)
    carbs: float = Field(ge=0, le=3_000)
    fat: float = Field(ge=0, le=1_000)
    dietary: str = Field(max_length=120)
    units: Literal["metric", "imperial"]


class FoodItemIn(ApiModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    grams: float = Field(gt=0, le=100_000)
    calories: float = Field(ge=0, le=100_000)
    protein: float = Field(ge=0, le=10_000)
    carbs: float = Field(ge=0, le=10_000)
    fat: float = Field(ge=0, le=10_000)
    fdcId: str | None = None
    source: str | None = None


class MealIn(ApiModel):
    id: str | None = None
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(pattern=r"^\d{2}:\d{2}$")
    items: list[FoodItemIn] = Field(min_length=1, max_length=100)


class CoachMessageIn(ApiModel):
    message: str = Field(min_length=1, max_length=2_000)


class CoachOut(ApiModel):
    message: str
    # "coach-agent" when the tool-calling agent produced the reply, "rules" for the
    # deterministic fallback. Kept a free string so the engine can label its source.
    source: str


class VisionFood(ApiModel):
    name: str
    grams: float
    calories: float
    protein: float
    carbs: float
    fat: float
    confidence: float = Field(ge=0, le=1)
    fdcId: str | None = None
    source: str


class VisionOut(ApiModel):
    items: list[VisionFood]
    provider: str
    cached: bool = False
