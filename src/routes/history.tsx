import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  Edit3,
  Flame,
  Plus,
  Save,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Mascot } from "@/components/Mascot";
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
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { sumMacros, todayIso, useApp, type FoodItem, type MealEntry } from "@/lib/store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "History — NutriCoach" },
      {
        name: "description",
        content: "Use the calendar to review, expand, edit, and confirm your daily meal logs.",
      },
    ],
  }),
  component: History,
});

function History() {
  const { user, goals, logs, ready, updateMeal, deleteMeal } = useApp();
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date(`${todayIso()}T12:00:00`));
  const [openMealId, setOpenMealId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MealEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MealEntry | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  const selectedIso = toIso(selectedDate);
  const selectedDay = logs.find((day) => day.date === selectedIso);
  const selectedTotals = useMemo(() => sumMacros(selectedDay?.meals ?? []), [selectedDay]);
  const loggedDates = useMemo(() => logs.map((day) => new Date(`${day.date}T12:00:00`)), [logs]);
  const allTotals = useMemo(
    () => logs.map((day) => ({ date: day.date, totals: sumMacros(day.meals) })),
    [logs],
  );
  const averageCalories = allTotals.length
    ? Math.round(
        allTotals.reduce((total, day) => total + day.totals.calories, 0) / allTotals.length,
      )
    : 0;
  const streak = useMemo(() => calculateStreak(logs.map((day) => day.date)), [logs]);

  const saveEdit = async () => {
    if (!editing || !selectedDay) return;
    setSaving(true);
    try {
      await updateMeal(selectedDay.date, editing);
      setEditing(null);
      toast.success("Meal changes confirmed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the meal");
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
      toast.success("Meal removed from your daily log");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the meal");
    }
  };

  if (!goals) return null;

  return (
    <AppLayout>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center gap-4">
          <Mascot size={64} className="animate-float shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-primary">History</div>
            <h1 className="text-2xl font-black md:text-3xl">Your daily nutrition log</h1>
            <p className="text-sm text-muted-foreground">
              Pick a date, expand a meal, and correct anything that changed.
            </p>
          </div>
          <Button asChild className="rounded-full font-bold">
            <Link to="/log-food">
              <Plus className="mr-2 h-4 w-4" /> Add food
            </Link>
          </Button>
        </header>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard icon={CalendarDays} label="Days logged" value={logs.length.toString()} />
          <StatCard icon={Flame} label="Current streak" value={`${streak} days`} />
          <StatCard
            icon={TrendingUp}
            label="Average calories"
            value={averageCalories ? averageCalories.toString() : "—"}
          />
          <StatCard
            icon={Save}
            label="Meals recorded"
            value={logs.reduce((total, day) => total + day.meals.length, 0).toString()}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[330px_1fr]">
          <section className="card-soft h-fit p-4">
            <div className="mb-2">
              <h2 className="text-lg font-black">Calendar</h2>
              <p className="text-xs text-muted-foreground">Dots indicate days with saved meals.</p>
            </div>
            <Calendar
              mode="single"
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
                  "after:absolute after:bottom-0.5 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary",
              }}
              className="mx-auto w-full [--cell-size:2.35rem]"
            />
            <button
              onClick={() => setSelectedDate(new Date(`${todayIso()}T12:00:00`))}
              className="mt-2 w-full rounded-xl bg-muted py-2 text-xs font-bold text-primary"
            >
              Jump to today
            </button>
          </section>

          <section className="card-soft overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
              <div>
                <div className="text-xs font-extrabold uppercase tracking-wider text-primary">
                  Selected day
                </div>
                <h2 className="mt-1 text-xl font-black">{formatDate(selectedDate)}</h2>
              </div>
              <div className="flex gap-2">
                <MacroBadge label="kcal" value={selectedTotals.calories} />
                <MacroBadge label="P" value={selectedTotals.protein} />
                <MacroBadge label="C" value={selectedTotals.carbs} />
                <MacroBadge label="F" value={selectedTotals.fat} />
              </div>
            </div>

            {selectedDay?.meals.length ? (
              <div className="divide-y">
                {selectedDay.meals.map((meal) => {
                  const isOpen = openMealId === meal.id;
                  const totals = sumMacros([meal]);
                  return (
                    <article key={meal.id}>
                      <button
                        onClick={() => {
                          setOpenMealId(isOpen ? null : meal.id);
                          setEditing(null);
                        }}
                        className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40"
                      >
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary/10 text-sm font-black text-primary">
                          {meal.time}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-extrabold">
                            {meal.items.map((item) => item.name).join(", ")}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {meal.items.length} food{meal.items.length === 1 ? "" : "s"} ·{" "}
                            {Math.round(totals.calories)} kcal
                          </div>
                        </div>
                        <ChevronDown
                          className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
                        />
                      </button>

                      {isOpen && (
                        <div className="bg-muted/25 px-4 pb-4">
                          {editing?.id === meal.id ? (
                            <MealEditor
                              meal={editing}
                              setMeal={setEditing}
                              onCancel={() => setEditing(null)}
                              onSave={() => void saveEdit()}
                              saving={saving}
                            />
                          ) : (
                            <div className="rounded-2xl border bg-white p-4">
                              <ul className="space-y-2">
                                {meal.items.map((item) => (
                                  <li
                                    key={item.id}
                                    className="flex items-center justify-between text-sm"
                                  >
                                    <div>
                                      <span className="font-bold">{item.name}</span>
                                      <span className="ml-2 text-xs text-muted-foreground">
                                        {Math.round(item.grams)}g
                                      </span>
                                    </div>
                                    <span className="text-xs font-semibold text-muted-foreground">
                                      {Math.round(item.calories)} kcal
                                    </span>
                                  </li>
                                ))}
                              </ul>
                              <div className="mt-4 flex gap-2 border-t pt-3">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setEditing({
                                      ...meal,
                                      items: meal.items.map((item) => ({ ...item })),
                                    })
                                  }
                                  className="rounded-full"
                                >
                                  <Edit3 className="mr-1.5 h-3.5 w-3.5" /> Edit meal
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDeleteTarget(meal)}
                                  className="rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                                </Button>
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
              <div className="p-10 text-center">
                <CalendarDays className="mx-auto h-10 w-10 text-muted-foreground/40" />
                <div className="mt-3 font-extrabold">No meals on this day</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add a meal now or choose a day marked on the calendar.
                </p>
                <Button asChild variant="outline" className="mt-4 rounded-full">
                  <Link to="/log-food">Add food</Link>
                </Button>
              </div>
            )}
          </section>
        </div>

        <section className="card-soft p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-black">Selected day macros</h2>
              <p className="text-xs text-muted-foreground">
                Progress against your current daily plan.
              </p>
            </div>
            <span className="text-xs font-bold text-primary">
              {Math.round((selectedTotals.calories / goals.calories) * 100)}% calories
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MacroProgress
              label="Calories"
              value={selectedTotals.calories}
              goal={goals.calories}
              color="bg-leaf"
            />
            <MacroProgress
              label="Protein"
              value={selectedTotals.protein}
              goal={goals.protein}
              color="bg-mango"
            />
            <MacroProgress
              label="Carbs"
              value={selectedTotals.carbs}
              goal={goals.carbs}
              color="bg-sky"
            />
            <MacroProgress
              label="Fat"
              value={selectedTotals.fat}
              goal={goals.fat}
              color="bg-berry"
            />
          </div>
        </section>
      </div>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this meal?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the {deleteTarget?.time} meal and all of its foods from the daily log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Keep meal</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete meal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
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
    <div className="rounded-2xl border border-primary/20 bg-white p-4">
      <div className="flex items-center gap-3">
        <label htmlFor={`time-${meal.id}`} className="text-xs font-bold">
          Meal time
        </label>
        <Input
          id={`time-${meal.id}`}
          type="time"
          value={meal.time}
          onChange={(event) =>
            setMeal((current) => current && { ...current, time: event.target.value })
          }
          className="h-9 w-32 rounded-lg"
        />
      </div>
      <div className="mt-4 space-y-2">
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
              className="h-9 rounded-lg"
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
                className="h-9 rounded-lg pr-6 text-right"
              />
              <span className="absolute right-2 top-2.5 text-[10px] text-muted-foreground">g</span>
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
              className="rounded-lg p-2 text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onCancel} className="rounded-full">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={saving || meal.items.length === 0}
          className="rounded-full"
        >
          <Save className="mr-1.5 h-3.5 w-3.5" /> {saving ? "Saving…" : "Confirm changes"}
        </Button>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string;
}) {
  return (
    <div className="card-soft p-4">
      <Icon className="h-5 w-5 text-primary" />
      <div className="mt-2 text-xl font-black">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function MacroBadge({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-muted px-2.5 py-1.5 text-center">
      <div className="text-[9px] font-bold text-muted-foreground">{label}</div>
      <div className="text-xs font-black">{Math.round(value)}</div>
    </div>
  );
}

function MacroProgress({
  label,
  value,
  goal,
  color,
}: {
  label: string;
  value: number;
  goal: number;
  color: string;
}) {
  const percent = Math.min(100, Math.round((value / goal) * 100));
  return (
    <div className="rounded-2xl bg-muted/60 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-bold">{label}</span>
        <span className="text-muted-foreground">{percent}%</span>
      </div>
      <div className="mt-2 text-lg font-black">
        {Math.round(value)}
        <span className="ml-1 text-xs font-semibold text-muted-foreground">
          / {Math.round(goal)}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

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

function calculateStreak(dates: string[]) {
  const set = new Set(dates);
  const cursor = new Date(`${todayIso()}T12:00:00`);
  let streak = 0;
  while (set.has(toIso(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
