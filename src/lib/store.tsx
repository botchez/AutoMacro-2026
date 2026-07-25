import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
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
  // `triggerCoach` defaults to true (a normal log auto-runs the coach). The coach's own
  // suggestion sidebar passes false so accepting its suggestion doesn't re-run it.
  addMeal: (date: string, meal: MealEntry, options?: { triggerCoach?: boolean }) => Promise<void>;
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

  const addMeal = useCallback(
    async (date: string, meal: MealEntry, options?: { triggerCoach?: boolean }) => {
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
      // Logging from the coach's own suggestion sidebar passes { triggerCoach: false }: the
      // coach just recommended this food, so re-running it to react to the user accepting its
      // own suggestion is redundant (and would spend a needless model call). Skip both the
      // run and the mealsLogged bump so the CoachPanel's watcher doesn't flash either.
      if (options?.triggerCoach === false) return;
      // Every logged batch auto-triggers the coach ONCE, from here (always mounted, so it
      // works from any page): coachTip() runs the agent in "auto" mode over the just-logged
      // batch and APPENDS its advice to the day's persistent thread. Fire-and-forget — never
      // block the save. A mounted CoachPanel watches this run live via mealsLogged (it does
      // not fire its own call), so there's exactly one coach run per logged batch.
      //
      // Surface the run with a toast so it's obvious a reply is generating even when logging
      // from a page without the coach panel in view (e.g. /log-food). The toast tracks the
      // coach's LIVE tool calls (polled from /coach/status, the same steps the panel shows)
      // so the user sees WHAT it's doing — "Checking today's totals", "Reading your target" —
      // then resolves to a brief success or quietly dismisses on error so it never hangs.
      const coachToastId = toast.loading("Coach is reviewing your meal…");
      let watching = true;
      const trackSteps = async () => {
        // ~90s ceiling so a stuck/never-resolving run can't poll forever.
        for (let i = 0; i < 90 && watching; i++) {
          try {
            const status = await api.coachStatus();
            const latest = status.steps?.[status.steps.length - 1];
            if (watching && status.active && latest) {
              toast.loading(`${latest}…`, { id: coachToastId });
            }
          } catch {
            // transient — keep watching
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      };
      void trackSteps();
      api
        .coachTip(todayIso())
        .then(() => {
          watching = false;
          toast.success("Coach added a new tip", { id: coachToastId, duration: 2500 });
        })
        .catch(() => {
          watching = false;
          toast.dismiss(coachToastId);
        });
      setMealsLogged((count) => count + 1);
    },
    [],
  );

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
