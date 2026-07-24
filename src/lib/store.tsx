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

export type FoodItem = {
  id: string;
  name: string;
  grams: number;
  fdcId?: string | null;
  source?: string | null;
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
  logs: DayLog[];
};

type Ctx = State & {
  ready: boolean;
  busy: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setGoals: (goals: Goals) => Promise<void>;
  addMeal: (date: string, meal: MealEntry) => Promise<void>;
  refresh: () => Promise<void>;
  getDay: (date: string) => DayLog | undefined;
};

const AppCtx = createContext<Ctx | null>(null);
const emptyState: State = { user: null, goals: null, logs: [] };

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(emptyState);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

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
      setState({ user, goals: null, logs: [] });
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
    setState((current) => ({ ...current, goals: saved }));
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
      login,
      signup,
      logout,
      setGoals,
      addMeal,
      refresh,
      getDay,
    }),
    [state, ready, busy, login, signup, logout, setGoals, addMeal, refresh, getDay],
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
