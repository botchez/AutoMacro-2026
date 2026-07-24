import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useApp, sumMacros } from "@/lib/store";
import { TrendingUp, TrendingDown, Minus, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Mascot } from "@/components/Mascot";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "History — NutriCoach" },
      {
        name: "description",
        content: "Browse your past days, see meal history and macro adherence trends.",
      },
      { property: "og:title", content: "Your NutriCoach history" },
      {
        property: "og:description",
        content: "Timeline of meals with macro totals and consistency trends.",
      },
    ],
  }),
  component: History,
});

function History() {
  const { user, goals, logs, ready } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  const [openDate, setOpenDate] = useState<string | null>(null);

  const enriched = useMemo(() => {
    if (!goals) return [];
    const sorted = [...logs].sort((a, b) => (a.date < b.date ? 1 : -1));
    return sorted.map((d, i) => {
      const totals = sumMacros(d.meals);
      const hit = [
        totals.calories >= goals.calories * 0.9 && totals.calories <= goals.calories * 1.1,
        totals.protein >= goals.protein * 0.9,
        totals.carbs >= goals.carbs * 0.9 && totals.carbs <= goals.carbs * 1.15,
        totals.fat >= goals.fat * 0.9 && totals.fat <= goals.fat * 1.15,
      ].filter(Boolean).length;
      const prev = sorted[i + 1];
      const prevCal = prev ? sumMacros(prev.meals).calories : totals.calories;
      const trend =
        totals.calories > prevCal + 50 ? "up" : totals.calories < prevCal - 50 ? "down" : "flat";
      return { ...d, totals, hit, trend } as const;
    });
  }, [logs, goals]);

  if (!goals) return null;

  const streak = (() => {
    let s = 0;
    for (const d of enriched) {
      if (d.hit >= 3) s++;
      else break;
    }
    return s;
  })();

  return (
    <AppLayout>
      <div className="space-y-6">
        <header className="flex items-center gap-4">
          <Mascot size={64} className="animate-float shrink-0" />
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">History</div>
            <h1 className="text-2xl md:text-3xl">Your journey 🌱</h1>
            <div className="text-xs text-muted-foreground">
              {streak > 0
                ? `🔥 ${streak}-day streak — you're on fire!`
                : "Every log builds your streak!"}
            </div>
          </div>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Days logged" value={enriched.length.toString()} emoji="📅" />
          <StatCard
            label="Current streak"
            value={`${streak} day${streak === 1 ? "" : "s"}`}
            emoji="🔥"
          />
          <StatCard
            label="Avg calories"
            value={
              enriched.length
                ? Math.round(
                    enriched.reduce((s, d) => s + d.totals.calories, 0) / enriched.length,
                  ).toString()
                : "—"
            }
            emoji="⚡"
          />
          <StatCard
            label="Perfect days"
            value={enriched.filter((d) => d.hit === 4).length.toString()}
            emoji="🏆"
          />
        </div>

        <div className="card-soft p-2 md:p-4">
          {enriched.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-5xl">📖</div>
              <div className="mt-2 font-bold">No history yet</div>
              <div className="text-sm text-muted-foreground">
                Log your first meal to start your journey!
              </div>
            </div>
          ) : (
            <ul className="divide-y">
              {enriched.map((d) => {
                const isOpen = openDate === d.date;
                const date = new Date(d.date);
                const label = date.toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                });
                return (
                  <li key={d.date}>
                    <button
                      onClick={() => setOpenDate(isOpen ? null : d.date)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 rounded-xl text-left bounce-tap"
                    >
                      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary font-extrabold">
                        {date.getDate()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold truncate">{label}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {d.meals.length} meal{d.meals.length === 1 ? "" : "s"} ·{" "}
                          {d.totals.calories} kcal · P {Math.round(d.totals.protein)} · C{" "}
                          {Math.round(d.totals.carbs)} · F {Math.round(d.totals.fat)}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <HitPips hit={d.hit} />
                        <TrendIcon trend={d.trend} />
                        <ChevronDown
                          className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
                        />
                      </div>
                    </button>

                    {isOpen && (
                      <div className="px-3 pb-4 animate-pop">
                        <div className="grid grid-cols-4 gap-2 mb-3">
                          <MacroPill
                            label="kcal"
                            value={d.totals.calories}
                            goal={goals.calories}
                            color="oklch(0.72 0.18 145)"
                          />
                          <MacroPill
                            label="P"
                            value={d.totals.protein}
                            goal={goals.protein}
                            color="oklch(0.82 0.18 65)"
                          />
                          <MacroPill
                            label="C"
                            value={d.totals.carbs}
                            goal={goals.carbs}
                            color="oklch(0.75 0.14 235)"
                          />
                          <MacroPill
                            label="F"
                            value={d.totals.fat}
                            goal={goals.fat}
                            color="oklch(0.7 0.2 15)"
                          />
                        </div>
                        <ul className="space-y-2">
                          {d.meals.map((m) => (
                            <li key={m.id} className="rounded-2xl border p-3">
                              <div className="flex items-center justify-between">
                                <div className="font-bold">{m.time}</div>
                                <div className="text-xs text-muted-foreground">
                                  {m.items.reduce((s, it) => s + it.calories, 0)} kcal
                                </div>
                              </div>
                              <ul className="mt-1 text-sm text-muted-foreground">
                                {m.items.map((it) => (
                                  <li key={it.id}>
                                    • {it.name} <span className="opacity-60">({it.grams}g)</span>
                                  </li>
                                ))}
                              </ul>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function StatCard({ label, value, emoji }: { label: string; value: string; emoji: string }) {
  return (
    <div className="card-soft p-4">
      <div className="text-2xl">{emoji}</div>
      <div className="mt-1 text-xl font-extrabold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function HitPips({ hit }: { hit: number }) {
  return (
    <div className="flex gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={cn("h-2 w-2 rounded-full", i < hit ? "bg-primary" : "bg-muted")} />
      ))}
    </div>
  );
}

function TrendIcon({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "up") return <TrendingUp className="h-4 w-4 text-primary" />;
  if (trend === "down") return <TrendingDown className="h-4 w-4 text-berry" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

function MacroPill({
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
  const pct = Math.min(1, goal > 0 ? value / goal : 0);
  return (
    <div className="rounded-xl bg-muted p-2 text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-bold">{Math.round(value)}</div>
      <div className="mt-1 h-1.5 rounded-full bg-background overflow-hidden">
        <div className="h-full" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  );
}
