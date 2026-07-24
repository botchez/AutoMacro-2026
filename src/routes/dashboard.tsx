import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import femaleEating from "@/assets/femaleeating.png";
import { AppLayout } from "@/components/AppLayout";
import { MacroRing } from "@/components/MacroRing";
import { CoachPanel } from "@/components/CoachPanel";
import { Button } from "@/components/ui/button";
import { sumMacros, todayIso, useApp } from "@/lib/store";
import { Flame, Beef, Wheat, Droplet, Plus } from "lucide-react";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — NutriCoach" },
      { name: "description", content: "See today's macro progress at a glance and stay on track." },
      { property: "og:title", content: "Your NutriCoach dashboard" },
      { property: "og:description", content: "Daily macro rings, coach tips, and today's meals." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { user, goals, logs, ready } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  const today = todayIso();
  const day = logs.find((d) => d.date === today);
  const totals = useMemo(() => sumMacros(day?.meals ?? []), [day]);

  if (!goals) return null;

  const calPct = Math.min(1, totals.calories / goals.calories);
  const hitCount = [
    totals.calories >= goals.calories * 0.9,
    totals.protein >= goals.protein * 0.9,
    totals.carbs >= goals.carbs * 0.9,
    totals.fat >= goals.fat * 0.9,
  ].filter(Boolean).length;

  return (
    <AppLayout>
      <div className="space-y-6">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">Today</div>
            <h1 className="truncate text-2xl md:text-3xl">Hi {user?.name ?? "friend"}</h1>
          </div>
          <Button asChild size="lg" className="rounded-full font-bold bounce-tap shrink-0">
            <Link to="/log-food">
              <Plus className="mr-1 h-4 w-4" /> Log food
            </Link>
          </Button>
        </header>

        <CoachPanel />

        {/* Rings */}
        <div className="card-soft p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg">Macro progress</h2>
            <div className="text-xs text-muted-foreground">{hitCount}/4 hit</div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MacroRing
              label="Calories"
              value={totals.calories}
              goal={goals.calories}
              color="oklch(0.72 0.18 145)"
              unit=""
            />
            <MacroRing
              label="Protein"
              value={totals.protein}
              goal={goals.protein}
              color="oklch(0.82 0.18 65)"
            />
            <MacroRing
              label="Carbs"
              value={totals.carbs}
              goal={goals.carbs}
              color="oklch(0.75 0.14 235)"
            />
            <MacroRing label="Fat" value={totals.fat} goal={goals.fat} color="oklch(0.7 0.2 15)" />
          </div>
        </div>

        {/* Summary + today's food */}
        <div className="grid gap-6 md:grid-cols-2">
          <div className="card-soft p-6">
            <h3 className="mb-4 text-lg">Summary</h3>
            <div className="space-y-3">
              <SummaryRow
                icon={<Flame className="h-4 w-4" />}
                label="Calories"
                value={totals.calories}
                goal={goals.calories}
                color="oklch(0.72 0.18 145)"
              />
              <SummaryRow
                icon={<Beef className="h-4 w-4" />}
                label="Protein"
                value={totals.protein}
                goal={goals.protein}
                color="oklch(0.82 0.18 65)"
              />
              <SummaryRow
                icon={<Wheat className="h-4 w-4" />}
                label="Carbs"
                value={totals.carbs}
                goal={goals.carbs}
                color="oklch(0.75 0.14 235)"
              />
              <SummaryRow
                icon={<Droplet className="h-4 w-4" />}
                label="Fat"
                value={totals.fat}
                goal={goals.fat}
                color="oklch(0.7 0.2 15)"
              />
            </div>
            <div className="mt-4 rounded-2xl bg-muted p-3 text-xs text-muted-foreground">
              You've logged {Math.round(calPct * 100)}% of your calorie target.
            </div>
          </div>

          <div className="card-soft p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg">Today's food</h3>
              <Link to="/log-food" className="text-xs font-bold text-primary hover:underline">
                + Add
              </Link>
            </div>
            {day && day.meals.length ? (
              <ul className="space-y-3">
                {day.meals.map((m) => (
                  <li key={m.id} className="rounded-2xl border p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-bold">{m.time}</div>
                      <div className="text-xs text-muted-foreground">
                        {m.items.reduce((s, it) => s + it.calories, 0)} kcal
                      </div>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground truncate">
                      {m.items.map((it) => it.name).join(", ")}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-center py-6">
                <img
                  src={femaleEating}
                  alt="Woman enjoying a healthy meal"
                  className="mx-auto h-32 w-32 object-contain"
                />
                <div className="mt-2 font-bold">No meals yet today</div>
                <div className="text-sm text-muted-foreground">
                  Tap "Log food" to add your first!
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function SummaryRow({
  icon,
  label,
  value,
  goal,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  goal: number;
  color: string;
}) {
  const pct = Math.max(0, Math.min(1, goal > 0 ? value / goal : 0));
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <span style={{ color }}>{icon}</span> {label}
        </div>
        <div className="text-muted-foreground">
          <span className="font-bold text-foreground">{Math.round(value)}</span> /{" "}
          {Math.round(goal)}
        </div>
      </div>
      <div className="mt-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct * 100}%`, background: color }}
        />
      </div>
    </div>
  );
}
