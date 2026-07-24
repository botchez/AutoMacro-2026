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


class SettingsIn(GoalsIn):
    name: str = Field(min_length=1, max_length=80)
    email: EmailStr
    sex: Literal["female", "male", "other", "prefer-not"] = "prefer-not"
    age: int | None = Field(default=None, ge=16, le=120)
    height: float | None = Field(default=None, gt=0, le=300)
    weight: float | None = Field(default=None, gt=0, le=1_500)
    activity: Literal["low", "light", "moderate", "high"] = "moderate"
    allergies: str = Field(default="", max_length=500)
    weekStartsOn: Literal["monday", "sunday"] = "monday"


class SettingsOut(SettingsIn):
    pass


class SettingsUpdateOut(ApiModel):
    user: UserOut
    goals: GoalsIn
    settings: SettingsOut


class PasswordChangeIn(ApiModel):
    currentPassword: str = Field(min_length=8, max_length=128)
    newPassword: str = Field(min_length=8, max_length=128)


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


class CoachRecommendation(ApiModel):
    name: str
    reason: str
    serving: str


class CoachMessageOut(ApiModel):
    role: Literal["user", "assistant"]
    content: str
    createdAt: str


class CoachOut(ApiModel):
    message: str
    # Free string: the coach agent labels replies "coach-agent"; the deterministic
    # fallback uses "rules".
    source: str
    recommendations: list[CoachRecommendation]


class CoachHistoryOut(ApiModel):
    messages: list[CoachMessageOut]
    recommendations: list[CoachRecommendation]


class Per100Macros(ApiModel):
    """Per-100g macro density. The weight-independent nutrition figure the client
    multiplies by the live scale weight — the backend never bakes in a weight."""

    calories: float = Field(ge=0)
    protein: float = Field(ge=0)
    carbs: float = Field(ge=0)
    fat: float = Field(ge=0)


class ToolCall(ApiModel):
    """One database lookup the resolver made while pricing a food — surfaced to the UI
    so the model→tool→result chain is visible for debugging."""

    tool: str  # "openfoodfacts" | "usda-fdc" | "barcode" | "label" | "estimate"
    query: str | None = None  # what was searched
    matchedQuery: str | None = None  # the query variant that actually hit (OFF retry)
    result: str | None = None  # what came back (product/food name), or null on a miss
    fdcId: str | int | None = None
    per100: dict | None = None  # the per-100g macros this lookup produced
    cached: bool | None = None
    status: str  # "hit" | "miss" | "used"


class VisionFood(ApiModel):
    name: str
    # A ratio, not a weight: this component's share of the whole plate by mass.
    # Fractions across items sum to ~1.0 (a single item is 1.0). The client turns
    # `fraction * scale_weight` into grams, then prices it off `per100`.
    fraction: float = Field(ge=0, le=1)
    per100: Per100Macros
    confidence: float = Field(ge=0, le=1)
    # Where the nutrition came from, surfaced verbatim in the UI so the user can see
    # it: "openfoodfacts", "usda-fdc", "label", "barcode", or "estimate".
    source: str
    fdcId: str | None = None
    # Grams-per-serving when the source knows it (Open Food Facts), else null.
    servingGrams: float | None = None
    # The lookups that produced this food's numbers (for the debug panel).
    trace: list[ToolCall] = []


class VisionDebug(ApiModel):
    """Verbose trace of the whole analyze call, for the frontend debug panel."""

    model: str | None = None  # the model/provider that answered ("barcode/off" for a scan)
    barcode: str | None = None  # decoded barcode, if any
    modelRaw: str | None = None  # the model's raw JSON reply
    reasoning: str | None = None  # the model's chain-of-thought, when it exposes it
    notes: list[str] = []  # step-by-step notes from the cascade
    usage: dict | None = None  # token usage for the model call


class VisionOut(ApiModel):
    items: list[VisionFood]
    provider: str
    cached: bool = False
    debug: VisionDebug | None = None
    # The model's estimate of the TOTAL food weight (grams). The client uses it as the
    # portion when no scale is connected; a real scale reading overrides it. None on the
    # barcode/filename-fallback paths.
    estimatedGrams: float | None = None
