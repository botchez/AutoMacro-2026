import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  ArrowUpDown,
  Award,
  Beef,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Droplet,
  Edit3,
  Flame,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  TrendingUp,
  Utensils,
  Wheat,
} from "lucide-react";
import historyCoach from "@/assets/facingright.png";
import { AppLayout } from "@/components/AppLayout";
import { MacroRing } from "@/components/MacroRing";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sumMacros, todayIso, useApp, type FoodItem, type MealEntry } from "@/lib/store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "History — NutriCoach" },
      {
        name: "description",
        content: "Review daily meal logs and search your entire food history.",
      },
    ],
  }),
  component: HistoryPage,
});

function HistoryPage() {
  const { user, goals, settings, logs, ready, updateMeal, deleteMeal } = useApp();
  const navigate = useNavigate();

  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date(`${todayIso()}T12:00:00`));
  const [activeTab, setActiveTab] = useState<"daily" | "search">("daily");
  const [openMealId, setOpenMealId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MealEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MealEntry | null>(null);
  const [saving, setSaving] = useState(false);

  // Search tab states (PRESERVED & ENHANCED FOOD HISTORY)
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFilter, setSearchFilter] = useState<
    "all" | "high-protein" | "high-carb" | "high-cal"
  >("all");
  const [historySort, setHistorySort] = useState<"newest" | "oldest" | "calories" | "protein">(
    "newest",
  );

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  const selectedIso = toIso(selectedDate);
  const selectedDay = logs.find((day) => day.date === selectedIso);
  const selectedMeals = useMemo(
    () => [...(selectedDay?.meals ?? [])].sort((a, b) => a.time.localeCompare(b.time)),
    [selectedDay],
  );
  const selectedTotals = useMemo(() => sumMacros(selectedDay?.meals ?? []), [selectedDay]);
  const loggedDates = useMemo(() => logs.map((day) => new Date(`${day.date}T12:00:00`)), [logs]);

  // Overall Statistics (NO STREAK)
  const allDayTotals = useMemo(
    () => logs.map((day) => ({ date: day.date, totals: sumMacros(day.meals) })),
    [logs],
  );

  const averageCalories = useMemo(() => {
    if (!allDayTotals.length) return 0;
    const sum = allDayTotals.reduce((acc, curr) => acc + curr.totals.calories, 0);
    return Math.round(sum / allDayTotals.length);
  }, [allDayTotals]);

  const targetHitRate = useMemo(() => {
    if (!goals || !allDayTotals.length) return 0;
    const hitDays = allDayTotals.filter((d) => {
      const calRatio = d.totals.calories / goals.calories;
      return calRatio >= 0.85 && calRatio <= 1.15;
    }).length;
    return Math.round((hitDays / allDayTotals.length) * 100);
  }, [allDayTotals, goals]);

  // PRESERVED: Flattened food history for search
  const flattenedFoodHistory = useMemo(() => {
    const items: Array<{
      food: FoodItem;
      mealTime: string;
      mealId: string;
      date: string;
    }> = [];

    for (const day of logs) {
      for (const meal of day.meals) {
        for (const food of meal.items) {
          items.push({
            food,
            mealTime: meal.time,
            mealId: meal.id,
            date: day.date,
          });
        }
      }
    }
    return items;
  }, [logs]);

  const foodInsights = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const item of flattenedFoodHistory) {
      const key = item.food.name.trim().toLowerCase();
      const current = counts.get(key);
      counts.set(key, {
        name: current?.name ?? item.food.name,
        count: (current?.count ?? 0) + 1,
      });
    }
    const frequent = [...counts.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
    return {
      uniqueFoods: counts.size,
      frequent: frequent.slice(0, 4),
      mostLogged: frequent[0] ?? null,
    };
  }, [flattenedFoodHistory]);

  const filteredFoodHistory = useMemo(() => {
    let result = [...flattenedFoodHistory];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((item) => item.food.name.toLowerCase().includes(q));
    }
    if (searchFilter === "high-protein") {
      result = result.filter((item) => item.food.protein >= 15);
    } else if (searchFilter === "high-carb") {
      result = result.filter((item) => item.food.carbs >= 30);
    } else if (searchFilter === "high-cal") {
      result = result.filter((item) => item.food.calories >= 250);
    }
    result.sort((a, b) => {
      if (historySort === "oldest") {
        return `${a.date}T${a.mealTime}`.localeCompare(`${b.date}T${b.mealTime}`);
      }
      if (historySort === "calories") return b.food.calories - a.food.calories;
      if (historySort === "protein") return b.food.protein - a.food.protein;
      return `${b.date}T${b.mealTime}`.localeCompare(`${a.date}T${a.mealTime}`);
    });
    return result;
  }, [flattenedFoodHistory, searchQuery, searchFilter, historySort]);

  const saveEdit = async () => {
    if (!editing || !selectedDay) return;
    setSaving(true);
    try {
      await updateMeal(selectedDay.date, editing);
      setEditing(null);
      toast.success("Meal updated successfully!");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update meal");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMeal(deleteTarget.id);
      setDeleteTarget(null);
      setOpenMealId(null);
      toast.success("Meal deleted from daily log");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete meal");
    }
  };

  const shiftDate = (offsetDays: number) => {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + offsetDays);
    setSelectedDate(next);
    setEditing(null);
    setOpenMealId(null);
  };

  if (!goals) return null;

  const selectedHitCount = [
    selectedTotals.calories >= goals.calories * 0.9,
    selectedTotals.protein >= goals.protein * 0.9,
    selectedTotals.carbs >= goals.carbs * 0.9,
    selectedTotals.fat >= goals.fat * 0.9,
  ].filter(Boolean).length;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <img
              src={historyCoach}
              alt="NutriCoach presenting nutrition history"
              className="h-20 w-16 shrink-0 object-contain object-bottom"
            />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-extrabold uppercase tracking-wider text-primary">
                  History Hub
                </span>
                <Badge variant="secondary" className="rounded-full text-[10px] font-bold">
                  {logs.length} Days Logged
                </Badge>
              </div>
              <h1 className="text-2xl font-black md:text-3xl">Daily Nutrition History</h1>
              <p className="text-sm text-muted-foreground">
                Review daily meal logs and search your entire food history.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button asChild size="default" className="rounded-full font-bold bounce-tap">
              <Link to="/log-food">
                <Plus className="mr-1.5 h-4 w-4" /> Log food
              </Link>
            </Button>
          </div>
        </header>

        {/* Metric Cards Banner (NO STREAK) */}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
          <MetricCard
            icon={CalendarDays}
            label="Total Days Logged"
            value={logs.length.toString()}
            subtext={`${logs.reduce((acc, d) => acc + d.meals.length, 0)} total meals recorded`}
            color="text-primary"
            bg="bg-primary/10"
          />
          <MetricCard
            icon={TrendingUp}
            label="Avg Daily Intake"
            value={averageCalories ? `${averageCalories} kcal` : "—"}
            subtext={`Target: ${goals.calories} kcal`}
            color="text-blue-500"
            bg="bg-blue-500/10"
          />
          <MetricCard
            icon={Award}
            label="Target Hit Rate"
            value={`${targetHitRate}%`}
            subtext="Compliance score"
            color="text-rose-500"
            bg="bg-rose-500/10"
          />
        </div>

        {/* Main Tab Navigation */}
        <Tabs
          value={activeTab}
          onValueChange={(val) => setActiveTab(val as "daily" | "search")}
          className="w-full space-y-6"
        >
          <TabsList className="grid w-full grid-cols-2 rounded-2xl bg-muted/60 p-1.5 h-auto">
            <TabsTrigger
              value="daily"
              className="rounded-xl py-2.5 text-xs md:text-sm font-extrabold gap-2 data-[state=active]:bg-card data-[state=active]:text-card-foreground data-[state=active]:shadow-sm"
            >
              <CalendarDays className="h-4 w-4 text-primary" />
              <span>Daily Log</span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                {selectedMeals.length}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="search"
              className="rounded-xl py-2.5 text-xs md:text-sm font-extrabold gap-2 data-[state=active]:bg-card data-[state=active]:text-card-foreground data-[state=active]:shadow-sm"
            >
              <Search className="h-4 w-4 text-blue-500" />
              <span>Food History</span>
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-600">
                {flattenedFoodHistory.length}
              </span>
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: DAILY OVERVIEW & CALENDAR */}
          <TabsContent value="daily" className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-[330px_1fr]">
              {/* Left Column: Calendar & Controls */}
              <div className="space-y-4">
                <section className="card-soft p-4">
                  <div className="flex items-center justify-between mb-3 px-1">
                    <div>
                      <h2 className="text-base font-black">Calendar Picker</h2>
                      <p className="text-[11px] text-muted-foreground">
                        Dots mark dates with logged meals.
                      </p>
                    </div>
                    <Badge variant="outline" className="rounded-full text-[10px]">
                      {loggedDates.length} Days
                    </Badge>
                  </div>

                  <Calendar
                    mode="single"
                    weekStartsOn={settings?.weekStartsOn === "sunday" ? 0 : 1}
                    selected={selectedDate}
                    onSelect={(date) => {
                      if (!date) return;
                      setSelectedDate(date);
                      setEditing(null);
                      setOpenMealId(null);
                    }}
                    modifiers={{ logged: loggedDates }}
                    modifiersClassNames={{
                      logged:
                        "after:absolute after:bottom-1 after:left-1/2 after:h-1.5 after:w-1.5 after:-translate-x-1/2 after:rounded-full after:bg-primary",
                    }}
                    className="mx-auto w-full [--cell-size:2.35rem]"
                  />

                  {/* Navigation Buttons */}
                  <div className="mt-3 grid grid-cols-3 gap-1.5 pt-3 border-t">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => shiftDate(-1)}
                      className="rounded-xl text-xs font-bold"
                    >
                      <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Prev
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSelectedDate(new Date(`${todayIso()}T12:00:00`));
                        setEditing(null);
                        setOpenMealId(null);
                      }}
                      className="rounded-xl text-xs font-extrabold text-primary"
                    >
                      Today
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => shiftDate(1)}
                      className="rounded-xl text-xs font-bold"
                    >
                      Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                  </div>
                </section>

                {/* Day Summary Card */}
                <div className="card-soft p-4 bg-gradient-to-br from-primary/5 via-primary/10 to-transparent">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-muted-foreground">
                      Target Compliance
                    </span>
                    <span className="text-xs font-extrabold text-primary">
                      {selectedHitCount}/4 Targets Hit
                    </span>
                  </div>
                  <div className="mt-2 text-sm font-black">
                    {selectedDay?.meals.length
                      ? `${selectedDay.meals.reduce((acc, m) => acc + m.items.length, 0)} foods in ${selectedDay.meals.length} meal(s)`
                      : "No meals logged"}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedIso === todayIso()
                      ? "Viewing active today log."
                      : `Log entry for ${formatDate(selectedDate)}.`}
                  </p>
                </div>
              </div>

              {/* Right Column: Day Detail & Macro Rings */}
              <div className="space-y-6">
                <section className="card-soft p-5 md:p-6 space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-extrabold uppercase tracking-wider text-primary">
                          Selected Day Log
                        </span>
                        {selectedIso === todayIso() && (
                          <Badge className="rounded-full bg-primary text-primary-foreground text-[10px]">
                            Today
                          </Badge>
                        )}
                      </div>
                      <h2 className="mt-1 text-xl font-black md:text-2xl">
                        {formatDate(selectedDate)}
                      </h2>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        className="rounded-full font-bold text-xs"
                      >
                        <Link to="/log-food">
                          <Plus className="mr-1 h-3.5 w-3.5" /> Add Food to Date
                        </Link>
                      </Button>
                    </div>
                  </div>

                  {/* Macro Rings */}
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-base font-extrabold">Macro Rings Progress</h3>
                      <span className="text-xs font-bold text-muted-foreground">
                        {Math.round((selectedTotals.calories / goals.calories) * 100)}% of daily
                        goal
                      </span>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-2">
                      <MacroRing
                        label="Calories"
                        value={selectedTotals.calories}
                        goal={goals.calories}
                        color="oklch(0.72 0.18 145)"
                        unit=""
                        size={110}
                      />
                      <MacroRing
                        label="Protein"
                        value={selectedTotals.protein}
                        goal={goals.protein}
                        color="oklch(0.82 0.18 65)"
                        unit="g"
                        size={110}
                      />
                      <MacroRing
                        label="Carbs"
                        value={selectedTotals.carbs}
                        goal={goals.carbs}
                        color="oklch(0.75 0.14 235)"
                        unit="g"
                        size={110}
                      />
                      <MacroRing
                        label="Fat"
                        value={selectedTotals.fat}
                        goal={goals.fat}
                        color="oklch(0.7 0.2 15)"
                        unit="g"
                        size={110}
                      />
                    </div>
                  </div>

                  {/* Macro Progress Bars */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t">
                    <MacroProgressRow
                      icon={Flame}
                      label="Calories"
                      value={selectedTotals.calories}
                      goal={goals.calories}
                      unit="kcal"
                      color="bg-leaf"
                    />
                    <MacroProgressRow
                      icon={Beef}
                      label="Protein"
                      value={selectedTotals.protein}
                      goal={goals.protein}
                      unit="g"
                      color="bg-mango"
                    />
                    <MacroProgressRow
                      icon={Wheat}
                      label="Carbs"
                      value={selectedTotals.carbs}
                      goal={goals.carbs}
                      unit="g"
                      color="bg-sky"
                    />
                    <MacroProgressRow
                      icon={Droplet}
                      label="Fat"
                      value={selectedTotals.fat}
                      goal={goals.fat}
                      unit="g"
                      color="bg-berry"
                    />
                  </div>
                </section>

                {/* Meals Section (PREVIOUS ROW DESIGN WITH CENTRALISED TIME BADGE) */}
                <section className="card-soft overflow-hidden">
                  <div className="flex items-center justify-between border-b px-5 py-4 bg-muted/30">
                    <div className="flex items-center gap-2">
                      <Utensils className="h-4 w-4 text-primary" />
                      <h3 className="text-lg font-black">Meals Breakdown</h3>
                    </div>
                    <span className="text-xs font-extrabold text-muted-foreground">
                      {selectedDay?.meals.length ?? 0} Meal(s)
                    </span>
                  </div>

                  {selectedDay?.meals.length ? (
                    <div className="divide-y">
                      {selectedMeals.map((meal) => {
                        const isOpen = openMealId === meal.id;
                        const mealTotals = sumMacros([meal]);
                        return (
                          <article key={meal.id} className="transition-colors">
                            {/* REVERTED TO PREVIOUS ROW LAYOUT WITH PERFECTLY CENTRALISED TIME TEXT */}
                            <button
                              onClick={() => {
                                setOpenMealId(isOpen ? null : meal.id);
                                setEditing(null);
                              }}
                              className="flex w-full items-center gap-3.5 p-4 md:p-5 text-left hover:bg-muted/40 transition-colors"
                            >
                              {/* Centralised Time Badge Container */}
                              <div className="flex shrink-0 flex-col items-center justify-center rounded-2xl bg-primary/10 px-3.5 py-2 text-center min-w-[88px] shadow-2xs">
                                <Clock className="h-3.5 w-3.5 text-primary mb-0.5" />
                                <span className="text-xs font-black text-primary leading-none text-center w-full">
                                  {formatTime(meal.time)}
                                </span>
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="truncate font-extrabold text-base">
                                  {meal.items.map((item) => item.name).join(", ")}
                                </div>
                                <div className="mt-0.5 text-xs text-muted-foreground flex flex-wrap items-center gap-2">
                                  <span>
                                    {meal.items.length} item{meal.items.length === 1 ? "" : "s"}
                                  </span>
                                  <span>·</span>
                                  <span className="font-bold text-foreground">
                                    {Math.round(mealTotals.calories)} kcal
                                  </span>
                                  <span>·</span>
                                  <span>
                                    P: {round(mealTotals.protein)}g | C: {round(mealTotals.carbs)}g
                                    | F: {round(mealTotals.fat)}g
                                  </span>
                                </div>
                              </div>

                              <ChevronDown
                                className={cn(
                                  "h-5 w-5 text-muted-foreground transition-transform duration-200 shrink-0",
                                  isOpen && "rotate-180 text-primary",
                                )}
                              />
                            </button>

                            {isOpen && (
                              <div className="bg-muted/20 px-4 pb-4 md:px-5 md:pb-5">
                                {editing?.id === meal.id ? (
                                  <MealEditor
                                    meal={editing}
                                    setMeal={setEditing}
                                    onCancel={() => setEditing(null)}
                                    onSave={() => void saveEdit()}
                                    saving={saving}
                                  />
                                ) : (
                                  <div className="rounded-2xl border bg-card p-4 space-y-3 shadow-xs">
                                    <div className="text-xs font-extrabold uppercase tracking-wider text-muted-foreground">
                                      Food Items Logged
                                    </div>
                                    <ul className="divide-y border-y">
                                      {meal.items.map((item) => (
                                        <li
                                          key={item.id}
                                          className="flex items-center justify-between py-2.5 text-sm"
                                        >
                                          <div>
                                            <div className="font-bold">{item.name}</div>
                                            <div className="text-xs text-muted-foreground">
                                              {Math.round(item.grams)}g · P: {round(item.protein)}g
                                              | C: {round(item.carbs)}g | F: {round(item.fat)}g
                                            </div>
                                          </div>
                                          <div className="text-xs font-extrabold text-foreground">
                                            {Math.round(item.calories)} kcal
                                          </div>
                                        </li>
                                      ))}
                                    </ul>

                                    <div className="flex items-center justify-between pt-1">
                                      <div className="text-xs font-bold text-primary">
                                        Meal Total: {Math.round(mealTotals.calories)} kcal
                                      </div>
                                      <div className="flex gap-2">
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={() =>
                                            setEditing({
                                              ...meal,
                                              items: meal.items.map((item) => ({ ...item })),
                                            })
                                          }
                                          className="rounded-full h-8 text-xs font-bold"
                                        >
                                          <Edit3 className="mr-1.5 h-3.5 w-3.5" /> Edit
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => setDeleteTarget(meal)}
                                          className="rounded-full h-8 text-xs font-bold text-destructive hover:bg-destructive/10 hover:text-destructive"
                                        >
                                          <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-10 text-center space-y-3">
                      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-muted/60 text-muted-foreground">
                        <Utensils className="h-7 w-7 opacity-50" />
                      </div>
                      <div>
                        <div className="text-lg font-extrabold">No meals logged for this date</div>
                        <p className="text-xs text-muted-foreground max-w-sm mx-auto mt-1">
                          You haven't recorded any food for {formatDate(selectedDate)} yet.
                        </p>
                      </div>
                      <Button asChild size="default" className="rounded-full font-extrabold mt-2">
                        <Link to="/log-food">
                          <Plus className="mr-2 h-4 w-4" /> Add food log
                        </Link>
                      </Button>
                    </div>
                  )}
                </section>
              </div>
            </div>
          </TabsContent>

          {/* TAB 2: PRESERVED & ENHANCED FOOD HISTORY */}
          <TabsContent value="search" className="space-y-6">
            <div className="card-soft p-5 md:p-6 space-y-5">
              <div>
                <div className="flex items-center gap-2">
                  <Search className="h-5 w-5 text-primary" />
                  <h2 className="text-xl font-black">Food History & Search Catalog</h2>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Search across all historical food entries you've ever logged with instant macro
                  filtering.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <HistoryInsight
                  label="Total food entries"
                  value={flattenedFoodHistory.length.toString()}
                />
                <HistoryInsight label="Unique foods" value={foodInsights.uniqueFoods.toString()} />
                <HistoryInsight
                  label="Most logged"
                  value={
                    foodInsights.mostLogged
                      ? `${foodInsights.mostLogged.name} · ${foodInsights.mostLogged.count}×`
                      : "—"
                  }
                />
              </div>

              {/* Search Inputs */}
              <div className="grid gap-3 xl:grid-cols-[minmax(240px,1fr)_auto_180px]">
                <div className="relative">
                  <Search className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search food by name (e.g., Chicken, Oats, Salmon, Protein)..."
                    className="h-10 rounded-xl pl-9 pr-4 text-sm font-semibold"
                  />
                </div>
                <div className="flex gap-1 bg-muted/70 p-1 rounded-xl overflow-x-auto">
                  {(
                    [
                      { id: "all", label: "All Foods" },
                      { id: "high-protein", label: "Protein (≥15g)" },
                      { id: "high-carb", label: "Carbs (≥30g)" },
                      { id: "high-cal", label: "High Cal (≥250)" },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setSearchFilter(f.id)}
                      className={cn(
                        "px-3 py-1.5 text-xs font-bold rounded-lg whitespace-nowrap transition-colors",
                        searchFilter === f.id
                          ? "bg-card text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <label className="relative flex h-10 items-center rounded-xl border bg-card dark:bg-slate-900 pl-9 pr-2">
                  <ArrowUpDown className="absolute left-3 h-4 w-4 text-muted-foreground" />
                  <span className="sr-only">Sort food history</span>
                  <select
                    value={historySort}
                    onChange={(event) =>
                      setHistorySort(
                        event.target.value as "newest" | "oldest" | "calories" | "protein",
                      )
                    }
                    className="h-full w-full appearance-none bg-transparent text-xs font-bold outline-none dark:text-slate-100"
                    aria-label="Sort food history"
                  >
                    <option value="newest" className="bg-card dark:bg-slate-900 dark:text-slate-100">Newest first</option>
                    <option value="oldest" className="bg-card dark:bg-slate-900 dark:text-slate-100">Oldest first</option>
                    <option value="calories" className="bg-card dark:bg-slate-900 dark:text-slate-100">Highest calories</option>
                    <option value="protein" className="bg-card dark:bg-slate-900 dark:text-slate-100">Highest protein</option>
                  </select>
                  <ChevronDown className="pointer-events-none h-3.5 w-3.5 text-muted-foreground" />
                </label>
              </div>

              {foodInsights.frequent.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground">
                    Frequently logged
                  </span>
                  {foodInsights.frequent.map((food) => (
                    <button
                      key={food.name}
                      type="button"
                      onClick={() => setSearchQuery(food.name)}
                      className="rounded-full border bg-card dark:bg-slate-800 px-3 py-1 text-xs font-bold transition-colors hover:border-primary/30 hover:text-primary"
                    >
                      {food.name} <span className="text-muted-foreground">{food.count}×</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Results List */}
              <div className="space-y-3 pt-2 border-t">
                <div className="flex items-center justify-between text-xs font-extrabold text-muted-foreground">
                  <span>SHOWING {filteredFoodHistory.length} LOGGED ITEMS</span>
                  {(searchQuery || searchFilter !== "all" || historySort !== "newest") && (
                    <button
                      onClick={() => {
                        setSearchQuery("");
                        setSearchFilter("all");
                        setHistorySort("newest");
                      }}
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      <RotateCcw className="h-3 w-3" /> Reset view
                    </button>
                  )}
                </div>

                {filteredFoodHistory.length > 0 ? (
                  <div className="divide-y border rounded-2xl overflow-hidden bg-card">
                    {filteredFoodHistory.map((item, idx) => (
                      <div
                        key={`${item.date}-${item.mealId}-${item.food.id}-${idx}`}
                        className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 md:p-4 hover:bg-muted/30 transition-colors gap-3"
                      >
                        <div>
                          <div className="font-extrabold text-base text-foreground">
                            {item.food.name}
                          </div>
                          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2 mt-1">
                            <span className="font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md">
                              {formatHistoryDate(item.date)}
                            </span>
                            <span>·</span>
                            <span>{formatTime(item.mealTime)}</span>
                            <span>·</span>
                            <span className="font-semibold">
                              {Math.round(item.food.grams)}g portion
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-4 border-t sm:border-t-0 pt-2 sm:pt-0">
                          <div className="text-left sm:text-right">
                            <div className="text-sm font-black">
                              {Math.round(item.food.calories)} kcal
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              P:{" "}
                              <span className="font-bold text-amber-600">
                                {round(item.food.protein)}g
                              </span>{" "}
                              | C:{" "}
                              <span className="font-bold text-blue-600">
                                {round(item.food.carbs)}g
                              </span>{" "}
                              | F:{" "}
                              <span className="font-bold text-rose-600">
                                {round(item.food.fat)}g
                              </span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedDate(new Date(`${item.date}T12:00:00`));
                              setOpenMealId(item.mealId);
                              setActiveTab("daily");
                            }}
                            className="rounded-full text-xs font-bold bounce-tap shrink-0"
                          >
                            View Day <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-10 text-center text-muted-foreground space-y-2">
                    <Search className="mx-auto h-8 w-8 opacity-40 text-primary" />
                    <div className="font-extrabold text-base">No food items matched your query</div>
                    <p className="text-xs max-w-sm mx-auto">
                      Try searching with a broader keyword or change your protein/carb filters.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Delete Meal Confirmation Modal */}
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-black">
              Delete this meal log?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              This will permanently delete the meal logged at{" "}
              {deleteTarget ? formatTime(deleteTarget.time) : ""} ({deleteTarget?.items.length}{" "}
              items) from your history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full font-bold">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              className="rounded-full font-bold bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete meal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

{
  /* Helper Components */
}

function HistoryInsight({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/25 px-3 py-2.5">
      <div className="text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-black" title={value}>
        {value}
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  subtext,
  color,
  bg,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string;
  subtext: string;
  color: string;
  bg: string;
}) {
  return (
    <div className="card-soft p-4 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <span className="text-xs font-extrabold text-muted-foreground truncate">{label}</span>
        <span className={cn("p-2 rounded-xl", bg)}>
          <Icon className={cn("h-4 w-4", color)} />
        </span>
      </div>
      <div className="mt-2">
        <div className="text-2xl font-black">{value}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{subtext}</div>
      </div>
    </div>
  );
}

function MacroProgressRow({
  icon: Icon,
  label,
  value,
  goal,
  unit,
  color,
}: {
  icon: typeof Flame;
  label: string;
  value: number;
  goal: number;
  unit: string;
  color: string;
}) {
  const percent = Math.min(100, Math.round((value / goal) * 100));
  return (
    <div className="rounded-2xl bg-muted/40 p-3 space-y-1.5">
      <div className="flex items-center justify-between text-xs font-bold">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-primary" />
          <span>{label}</span>
        </div>
        <div>
          <span className="font-extrabold text-foreground">{Math.round(value)}</span>
          <span className="text-muted-foreground">
            {" "}
            / {Math.round(goal)} {unit}
          </span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function MealEditor({
  meal,
  setMeal,
  onCancel,
  onSave,
  saving,
}: {
  meal: MealEntry;
  setMeal: React.Dispatch<React.SetStateAction<MealEntry | null>>;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const resize = (item: FoodItem, grams: number) => {
    const safe = Math.max(1, grams);
    const ratio = safe / item.grams;
    return {
      ...item,
      grams: safe,
      calories: Math.round(item.calories * ratio),
      protein: round(item.protein * ratio),
      carbs: round(item.carbs * ratio),
      fat: round(item.fat * ratio),
    };
  };

  return (
    <div className="rounded-2xl border border-primary/20 bg-card p-4 space-y-4 shadow-xs">
      <div className="flex items-center justify-between border-b pb-3">
        <div className="text-sm font-extrabold text-primary flex items-center gap-2">
          <Clock className="h-4 w-4" /> Edit Meal Details
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={`time-${meal.id}`} className="text-xs font-bold text-muted-foreground">
            Time:
          </label>
          <Input
            id={`time-${meal.id}`}
            type="time"
            value={meal.time}
            onChange={(event) =>
              setMeal((current) => current && { ...current, time: event.target.value })
            }
            className="h-8 w-28 rounded-lg text-xs font-extrabold text-center"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-bold text-muted-foreground">Items & Gram Amounts</div>
        {meal.items.map((item) => (
          <div key={item.id} className="grid grid-cols-[1fr_90px_auto] items-center gap-2">
            <Input
              value={item.name}
              onChange={(event) =>
                setMeal((current) =>
                  current
                    ? {
                        ...current,
                        items: current.items.map((existing) =>
                          existing.id === item.id
                            ? { ...existing, name: event.target.value }
                            : existing,
                        ),
                      }
                    : current,
                )
              }
              aria-label="Food name"
              className="h-9 rounded-xl text-xs font-bold"
            />
            <div className="relative">
              <Input
                type="number"
                min={1}
                value={Math.round(item.grams)}
                onChange={(event) =>
                  setMeal((current) =>
                    current
                      ? {
                          ...current,
                          items: current.items.map((existing) =>
                            existing.id === item.id
                              ? resize(existing, Number(event.target.value))
                              : existing,
                          ),
                        }
                      : current,
                  )
                }
                aria-label={`${item.name} grams`}
                className="h-9 rounded-xl pr-6 text-right text-xs font-bold"
              />
              <span className="absolute right-2 top-2.5 text-[10px] text-muted-foreground font-bold">
                g
              </span>
            </div>
            <button
              onClick={() =>
                setMeal((current) =>
                  current
                    ? {
                        ...current,
                        items: current.items.filter((existing) => existing.id !== item.id),
                      }
                    : current,
                )
              }
              aria-label={`Remove ${item.name}`}
              className="rounded-lg p-2 text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t pt-3">
        <span className="text-xs font-extrabold text-muted-foreground">
          Total: {Math.round(meal.items.reduce((s, it) => s + it.calories, 0))} kcal
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="rounded-full h-8 text-xs">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={saving || meal.items.length === 0}
            className="rounded-full h-8 text-xs font-extrabold"
          >
            <Save className="mr-1.5 h-3.5 w-3.5" /> {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* Date utilities */

function toIso(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatDate(date: Date) {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatHistoryDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(time: string) {
  const [hour = "0", minute = "0"] = time.split(":");
  return new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
