import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";

export type Macros = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

export type Goals = Macros & {
  goalType: "lose" | "maintain" | "gain";
  dietary: string;
  units: "metric" | "imperial";
};

export type ThemeMode = "light" | "dark" | "system";

export function applyTheme(theme: ThemeMode) {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (isDark) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export type UserSettings = Goals & {
  name: string;
  email: string;
  sex: "female" | "male" | "other" | "prefer-not";
  age: number | null;
  height: number | null;
  weight: number | null;
  activity: "low" | "light" | "moderate" | "high";
  allergies: string;
  weekStartsOn: "monday" | "sunday";
  theme?: ThemeMode;
};

export type FoodItem = {
  id: string;
  name: string;
  grams: number;
  fdcId?: string | null;
  source?: string | null;
  /** Per-100g macro density. When present, re-weighing recomputes macros from this
   * (macros = per100 × grams / 100) instead of scaling the already-rounded macros, which
   * compounds rounding badly across edits. */
  per100?: Macros | null;
} & Macros;

export type MealEntry = {
  id: string;
  time: string;
  items: FoodItem[];
};

export type DayLog = {
  date: string;
  meals: MealEntry[];
};

export type User = { id: string; name: string; email: string } | null;

type State = {
  user: User;
  goals: Goals | null;
  settings: UserSettings | null;
  logs: DayLog[];
};

type Ctx = State & {
  ready: boolean;
  busy: boolean;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  // Bumps once per successfully saved batch. The CoachPanel watches it and runs the
  // same coach check the "Test coach" button runs, so logging food auto-pings the coach.
  mealsLogged: number;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setGoals: (goals: Goals) => Promise<void>;
  updateSettings: (settings: UserSettings) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  addMeal: (date: string, meal: MealEntry) => Promise<void>;
  updateMeal: (date: string, meal: MealEntry) => Promise<void>;
  deleteMeal: (mealId: string) => Promise<void>;
  refresh: () => Promise<void>;
  getDay: (date: string) => DayLog | undefined;
};

const AppCtx = createContext<Ctx | null>(null);
const emptyState: State = { user: null, goals: null, settings: null, logs: [] };

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(emptyState);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mealsLogged, setMealsLogged] = useState(0);
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("nutricoach:theme") as ThemeMode | null;
      if (saved && ["light", "dark", "system"].includes(saved)) return saved;
    }
    return "light";
  });

  const setTheme = useCallback((newTheme: ThemeMode) => {
    setThemeState(newTheme);
    if (typeof window !== "undefined") {
      localStorage.setItem("nutricoach:theme", newTheme);
      applyTheme(newTheme);
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    if (!api.hasSession()) {
      setState(emptyState);
      return;
    }
    try {
      setState(await api.state());
    } catch {
      api.clearSession();
      setState(emptyState);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setReady(true));
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setBusy(true);
    try {
      await api.login(email, password);
      setState(await api.state());
    } finally {
      setBusy(false);
    }
  }, []);

  const signup = useCallback(async (name: string, email: string, password: string) => {
    setBusy(true);
    try {
      const user = await api.signup(name, email, password);
      setState({ user, goals: null, settings: null, logs: [] });
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setState(emptyState);
  }, []);

  const setGoals = useCallback(async (goals: Goals) => {
    const saved = await api.saveGoals(goals);
    setState((current) => ({
      ...current,
      goals: saved,
      settings:
        current.settings ??
        (current.user
          ? {
              ...saved,
              name: current.user.name,
              email: current.user.email,
              sex: "prefer-not",
              age: null,
              height: null,
              weight: null,
              activity: "moderate",
              allergies: "",
              weekStartsOn: "monday",
            }
          : null),
    }));
  }, []);

  const updateSettings = useCallback(async (settings: UserSettings) => {
    const saved = await api.saveSettings(settings);
    setState((current) => ({ ...current, ...saved }));
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api.changePassword(currentPassword, newPassword);
  }, []);

  const addMeal = useCallback(async (date: string, meal: MealEntry) => {
    await api.addMeal(date, meal);
    setState((current) => {
      const logs = [...current.logs];
      const index = logs.findIndex((day) => day.date === date);
      if (index >= 0) {
        logs[index] = { ...logs[index], meals: [...logs[index].meals, meal] };
      } else {
        logs.push({ date, meals: [meal] });
      }
      logs.sort((a, b) => (a.date < b.date ? 1 : -1));
      return { ...current, logs };
    });
    // Every logged batch auto-triggers the coach: coachTip() runs the agent in "auto"
    // mode over the just-submitted batch and persists its advice, so the dashboard
    // shows fresh coaching next time it loads. Fire-and-forget — never block the save.
    void api.coachTip().catch(() => {});
    // Signal any mounted CoachPanel to run its coach check live (see mealsLogged).
    setMealsLogged((count) => count + 1);
  }, []);

  const updateMeal = useCallback(async (date: string, meal: MealEntry) => {
    await api.updateMeal(date, meal);
    setState((current) => {
      const logs = current.logs
        .map((day) => ({
          ...day,
          meals: day.meals.filter((existing) => existing.id !== meal.id),
        }))
        .filter((day) => day.meals.length > 0);
      const target = logs.find((day) => day.date === date);
      if (target)
        target.meals = [...target.meals, meal].sort((a, b) => a.time.localeCompare(b.time));
      else logs.push({ date, meals: [meal] });
      logs.sort((a, b) => (a.date < b.date ? 1 : -1));
      return { ...current, logs };
    });
  }, []);

  const deleteMeal = useCallback(async (mealId: string) => {
    await api.deleteMeal(mealId);
    setState((current) => ({
      ...current,
      logs: current.logs
        .map((day) => ({
          ...day,
          meals: day.meals.filter((meal) => meal.id !== mealId),
        }))
        .filter((day) => day.meals.length > 0),
    }));
  }, []);

  const getDay = useCallback(
    (date: string) => state.logs.find((day) => day.date === date),
    [state.logs],
  );

  const value = useMemo<Ctx>(
    () => ({
      ...state,
      ready,
      busy,
      theme,
      setTheme,
      mealsLogged,
      login,
      signup,
      logout,
      setGoals,
      updateSettings,
      changePassword,
      addMeal,
      updateMeal,
      deleteMeal,
      refresh,
      getDay,
    }),
    [
      state,
      ready,
      busy,
      theme,
      setTheme,
      mealsLogged,
      login,
      signup,
      logout,
      setGoals,
      updateSettings,
      changePassword,
      addMeal,
      updateMeal,
      deleteMeal,
      refresh,
      getDay,
    ],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp() {
  const context = useContext(AppCtx);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}

export function sumMacros(meals: MealEntry[]): Macros {
  return meals.reduce(
    (totals, meal) => {
      for (const item of meal.items) {
        totals.calories += item.calories;
        totals.protein += item.protein;
        totals.carbs += item.carbs;
        totals.fat += item.fat;
      }
      return totals;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

export const todayIso = () => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};
