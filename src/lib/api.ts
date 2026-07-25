import type { DayLog, Goals, Macros, MealEntry, User, UserSettings } from "./store";

const TOKEN_KEY = "nutricoach:session";

type AppState = {
  user: User;
  goals: Goals | null;
  settings: UserSettings | null;
  logs: DayLog[];
};

type AuthResponse = { token: string; user: Exclude<User, null> };
/**
 * A weight-independent detection. The backend never sees the scale weight and does no
 * weight math: it returns each food's per-100g density (`per100`), its `fraction` (share
 * of the whole plate by mass — 1.0 for a single item), and the `source` the numbers came
 * from. The client multiplies `fraction * scaleWeight` to get grams, then prices it off
 * `per100`.
 */
/** One database lookup the resolver made while pricing a food — the model→tool→result
 * chain, surfaced for the debug panel. */
export type ToolCall = {
  tool: string; // "openfoodfacts" | "usda-fdc" | "barcode" | "label" | "estimate"
  query?: string | null; // what was searched
  matchedQuery?: string | null; // the query variant that actually hit (OFF retry)
  result?: string | null; // what came back, or null on a miss
  fdcId?: string | number | null;
  per100?: Record<string, number> | null;
  cached?: boolean | null;
  status: string; // "hit" | "miss" | "used"
};
export type DetectedItem = {
  name: string;
  /** This food's share of the total plate weight (fractions sum to ~1). */
  fraction: number;
  /** Per-100g macro density — the authoritative figure the client scales by weight. */
  per100: Macros;
  confidence: number;
  /** Where the nutrition came from: "openfoodfacts" | "usda-fdc" | "label" | "barcode" | "estimate" | "reference". */
  source: string;
  fdcId?: string | null;
  /** Grams per serving when known (Open Food Facts), else null. */
  servingGrams?: number | null;
  /** The lookups that produced this food's numbers (for the debug panel). */
  trace?: ToolCall[];
};
/** Verbose trace of the whole analyze call, for the frontend debug panel. */
export type VisionDebug = {
  model?: string | null;
  barcode?: string | null;
  modelRaw?: string | null;
  reasoning?: string | null;
  notes?: string[];
  usage?: Record<string, unknown> | null;
};
export type VisionResponse = {
  items: DetectedItem[];
  provider: string;
  cached: boolean;
  debug?: VisionDebug | null;
  /** The model's estimate of the total food weight (grams), used as the portion when no
   * scale is connected. Null on the barcode/fallback paths. */
  estimatedGrams?: number | null;
};
export type CoachRecommendation = {
  name: string;
  reason: string;
  serving: string;
  /** Preloaded macros for the suggested serving, so the sidebar can log it instantly.
   * Absent when the food couldn't be priced — the UI falls back to opening the logger. */
  grams?: number | null;
  calories?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  per100?: Macros | null;
  source?: string | null;
};
export type CoachMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};
export type CoachResponse = {
  message: string;
  source: string;
  recommendations?: CoachRecommendation[];
};

function token() {
  return localStorage.getItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const sessionToken = token();
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function remember(auth: AuthResponse) {
  localStorage.setItem(TOKEN_KEY, auth.token);
  return auth.user;
}

export const api = {
  hasSession: () => Boolean(token()),
  clearSession: () => localStorage.removeItem(TOKEN_KEY),
  state: () => request<AppState>("/api/state"),
  login: async (email: string, password: string) =>
    remember(
      await request<AuthResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    ),
  signup: async (name: string, email: string, password: string) =>
    remember(
      await request<AuthResponse>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
      }),
    ),
  logout: async () => {
    try {
      await request<void>("/api/auth/session", { method: "DELETE" });
    } finally {
      localStorage.removeItem(TOKEN_KEY);
    }
  },
  saveGoals: (goals: Goals) =>
    request<Goals>("/api/goals", { method: "PUT", body: JSON.stringify(goals) }),
  saveSettings: (settings: UserSettings) =>
    request<{
      user: Exclude<User, null>;
      goals: Goals;
      settings: UserSettings;
    }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/api/account/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  addMeal: (date: string, meal: MealEntry) =>
    request<{ id: string }>("/api/logs", {
      method: "POST",
      body: JSON.stringify({ ...meal, date }),
    }),
  updateMeal: (date: string, meal: MealEntry) =>
    request<{ id: string }>(`/api/logs/${meal.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...meal, date }),
    }),
  deleteMeal: (mealId: string) =>
    request<void>(`/api/logs/${mealId}`, {
      method: "DELETE",
    }),
  // No weight is sent: detection is weight-independent (per-100g + fraction). The
  // client applies the live scale weight to the result itself.
  analyze: (image: File) => {
    const form = new FormData();
    form.append("image", image);
    return request<VisionResponse>("/api/vision/analyze", {
      method: "POST",
      body: form,
    });
  },
  scanBarcodeFrame: (frame: Blob) => {
    const form = new FormData();
    form.append("image", frame, "frame.jpg");
    return request<{
      status: "none" | "unmatched" | "matched";
      barcode: string | null;
      result: VisionResponse | null;
    }>("/api/vision/barcode/scan", { method: "POST", body: form });
  },
  // `date` is the client's LOCAL day (YYYY-MM-DD) so the coach scopes "today" to the day
  // the user is looking at, not a server clock (which is UTC and wrong near midnight).
  // `hour` (0-23) is a dev override for the coach's time-of-day context.
  coachTip: (date?: string, hour?: number) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (hour != null) params.set("hour", String(hour));
    const qs = params.toString();
    return request<CoachResponse>(`/api/coach/tip${qs ? `?${qs}` : ""}`);
  },
  // `date` scopes the thread to the client's local day, so a new day loads a fresh chat.
  coachHistory: (date?: string) =>
    request<{ messages?: CoachMessage[]; recommendations?: CoachRecommendation[] }>(
      `/api/coach/history${date ? `?date=${encodeURIComponent(date)}` : ""}`,
    ),
  // Wipe the day's coach thread and sidebar suggestions, returning the empty history.
  coachClear: (date?: string) =>
    request<{ messages?: CoachMessage[]; recommendations?: CoachRecommendation[] }>(
      `/api/coach/history${date ? `?date=${encodeURIComponent(date)}` : ""}`,
      { method: "DELETE" },
    ),
  // Live progress of the coach's current run (the tools it's calling). Cheap to poll
  // while a reply is generating so the UI can show it thinking.
  coachStatus: () => request<{ active: boolean; steps: string[] }>("/api/coach/status"),
  coachMessage: (message: string, date?: string, hour?: number) =>
    request<CoachResponse>("/api/coach/message", {
      method: "POST",
      body: JSON.stringify({ message, date, hour }),
    }),
};
