import type { DayLog, FoodItem, Goals, MealEntry, User } from "./store";

const TOKEN_KEY = "nutricoach:session";

type AppState = {
  user: User;
  goals: Goals | null;
  logs: DayLog[];
};

type AuthResponse = { token: string; user: Exclude<User, null> };
export type VisionResponse = {
  items: Array<Omit<FoodItem, "id"> & { confidence: number }>;
  provider: string;
  cached: boolean;
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
  addMeal: (date: string, meal: MealEntry) =>
    request<{ id: string }>("/api/logs", {
      method: "POST",
      body: JSON.stringify({ ...meal, date }),
    }),
  analyze: (image: File, weight?: number) => {
    const form = new FormData();
    form.append("image", image);
    if (weight && weight > 0) form.append("weight", String(weight));
    return request<VisionResponse>("/api/vision/analyze", {
      method: "POST",
      body: form,
    });
  },
  coachTip: () => request<{ message: string; source: string }>("/api/coach/tip"),
  coachMessage: (message: string) =>
    request<{ message: string; source: string }>("/api/coach/message", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
};
