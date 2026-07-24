import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Mascot } from "@/components/Mascot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp, type FoodItem, todayIso } from "@/lib/store";
import { MOCK_FOOD_DB, scaleFood } from "@/lib/mock-foods";
import { Camera, Scale, Trash2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

export const Route = createFileRoute("/log-food")({
  head: () => ({
    meta: [
      { title: "Log food — NutriCoach" },
      {
        name: "description",
        content: "Scan, weigh, and log meals with the friendly NutriCoach food logger.",
      },
      { property: "og:title", content: "Log a meal with NutriCoach" },
      {
        property: "og:description",
        content: "Batch add foods with our smart scan-and-weigh flow.",
      },
    ],
  }),
  component: LogFood,
});

const uid = () => Math.random().toString(36).slice(2, 10);

function LogFood() {
  const { user, goals, addMeal, logs, ready } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  // Day selector — last 7 days
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [hour, setHour] = useState(new Date().getHours().toString().padStart(2, "0"));
  const [minute, setMinute] = useState(new Date().getMinutes().toString().padStart(2, "0"));

  const days = useMemo(() => {
    const arr: { iso: string; dow: string; d: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      arr.push({
        iso: d.toISOString().slice(0, 10),
        dow: d.toLocaleDateString(undefined, { weekday: "short" }),
        d: d.getDate(),
      });
    }
    return arr;
  }, []);

  // Scanner mock state
  const [weight, setWeight] = useState(0);
  const [tareOffset, setTareOffset] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [detected, setDetected] = useState<FoodItem[]>([]);
  const [visionProvider, setVisionProvider] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const displayedWeight = Math.max(0, weight - tareOffset);

  const captureWeight = () => {
    // random plausible weight 40–400g
    setWeight(Math.round(40 + Math.random() * 360));
    toast.success("Weight captured!", { description: "Scale reading locked in." });
  };
  const tare = () => {
    setTareOffset(weight);
    toast("Scale tared to 0g");
  };
  const captureImage = async (file: File) => {
    setScanning(true);
    try {
      const result = await api.analyze(file, displayedWeight);
      const chosen = result.items.map((item) => ({ ...item, id: uid() }));
      setDetected((previous) => [...previous, ...chosen]);
      setVisionProvider(result.provider);
      toast.success(`Detected ${chosen.length} item${chosen.length === 1 ? "" : "s"}!`, {
        description: result.cached
          ? "Loaded from the vision cache."
          : "Nutrition enriched through the food database.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not analyze that image");
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const updateDetected = (id: string, grams: number) => {
    setDetected((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const ref = MOCK_FOOD_DB.find((f) => f.name === it.name);
        const macros = ref
          ? scaleFood(ref.per100, grams)
          : {
              calories: Math.round((it.calories / it.grams) * grams),
              protein: Math.round((it.protein / it.grams) * grams * 10) / 10,
              carbs: Math.round((it.carbs / it.grams) * grams * 10) / 10,
              fat: Math.round((it.fat / it.grams) * grams * 10) / 10,
            };
        return { ...it, grams, ...macros };
      }),
    );
  };

  const removeDetected = (id: string) => setDetected((prev) => prev.filter((it) => it.id !== id));

  const addDetectedToBatch = () => {
    setBatch((b) => [...b, ...detected]);
    setDetected([]);
    setWeight(0);
    setTareOffset(0);
    toast.success("Added to batch");
  };

  // Batch
  const [batch, setBatch] = useState<FoodItem[]>([]);

  const submitBatch = async () => {
    if (!batch.length) {
      toast.error("Add at least one food first!");
      return;
    }
    try {
      await addMeal(selectedDate, {
        id: uid(),
        time: `${hour}:${minute}`,
        items: batch,
      });
      setBatch([]);
      toast.success("Meal logged! 🎉", { description: "Saved to your nutrition history." });
      navigate({ to: "/dashboard" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save meal");
    }
  };

  const batchTotals = batch.reduce(
    (a, it) => ({
      calories: a.calories + it.calories,
      protein: a.protein + it.protein,
      carbs: a.carbs + it.carbs,
      fat: a.fat + it.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  // Coach suggestions
  const suggestion = useMemo(() => {
    if (!goals) return "";
    const dayLog = logs.find((d) => d.date === selectedDate);
    const soFar = (dayLog?.meals ?? []).flatMap((m) => m.items).concat(batch);
    const totals = soFar.reduce(
      (a, it) => ({
        calories: a.calories + it.calories,
        protein: a.protein + it.protein,
        carbs: a.carbs + it.carbs,
        fat: a.fat + it.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    const gaps: string[] = [];
    if (totals.protein < goals.protein * 0.5) gaps.push("protein (try eggs, yogurt, or chicken)");
    if (totals.carbs < goals.carbs * 0.5) gaps.push("carbs (rice, oats, or fruit)");
    if (totals.fat < goals.fat * 0.5) gaps.push("healthy fats (avocado, olive oil, nuts)");
    if (!gaps.length) return "You're crushing it — keep the balance going!";
    return `You're low on ${gaps.join(" and ")}. Consider adding some to this meal!`;
  }, [batch, goals, logs, selectedDate]);

  return (
    <AppLayout>
      <div className="space-y-6">
        <header className="flex items-center gap-4">
          <Mascot size={64} className="animate-float shrink-0" />
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">Log a meal</div>
            <h1 className="text-2xl md:text-3xl">Snap, weigh, log</h1>
            <div className="text-xs text-muted-foreground">I'll cheer you on the whole way 🎉</div>
          </div>
        </header>

        {/* Day selector */}
        <div className="card-soft p-3 flex gap-2 overflow-x-auto">
          {days.map((d) => (
            <button
              key={d.iso}
              onClick={() => setSelectedDate(d.iso)}
              className={cn(
                "shrink-0 rounded-2xl px-4 py-2 text-center bounce-tap min-w-[64px]",
                selectedDate === d.iso ? "bg-primary text-primary-foreground shadow" : "bg-muted",
              )}
            >
              <div className="text-[10px] uppercase font-bold opacity-80">{d.dow}</div>
              <div className="text-lg font-extrabold">{d.d}</div>
            </button>
          ))}
        </div>

        {/* Time */}
        <div className="card-soft p-4 flex items-center gap-3">
          <div className="text-sm font-bold">Time</div>
          <Input
            type="number"
            min={0}
            max={23}
            value={hour}
            onChange={(e) => setHour(e.target.value.padStart(2, "0").slice(-2))}
            className="w-20 text-center font-bold text-lg"
          />
          <span className="text-lg font-extrabold">:</span>
          <Input
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={(e) => setMinute(e.target.value.padStart(2, "0").slice(-2))}
            className="w-20 text-center font-bold text-lg"
          />
        </div>

        {/* Scanner */}
        <div className="card-soft p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg">📸 Smart food scanner</h2>
            <div className="text-xs text-muted-foreground">
              {visionProvider ? `Cascade: ${visionProvider}` : "Vision + FDC cascade"}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            {/* Camera */}
            <div className="rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-6 text-center min-h-[180px] flex flex-col items-center justify-center">
              {scanning ? (
                <>
                  <RefreshCw className="h-10 w-10 animate-spin text-primary" />
                  <div className="mt-2 text-sm font-bold">Analyzing your plate…</div>
                </>
              ) : (
                <>
                  <Camera className="h-10 w-10 text-primary" />
                  <div className="mt-2 text-sm font-bold">Point at your plate</div>
                  <div className="text-xs text-muted-foreground">Tap capture to detect foods</div>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void captureImage(file);
                }}
              />
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={scanning}
                className="mt-4 rounded-full font-bold bounce-tap"
              >
                <Camera className="mr-2 h-4 w-4" /> Choose or capture image
              </Button>
            </div>

            {/* Scale */}
            <div className="rounded-2xl bg-gradient-to-br from-sky/15 to-primary/10 p-6 flex flex-col items-center justify-center">
              <Scale className="h-8 w-8 text-sky-600" />
              <div className="mt-2 text-5xl font-black tabular-nums">
                {displayedWeight}
                <span className="text-xl text-muted-foreground">g</span>
              </div>
              <div className="text-xs text-muted-foreground">Live scale reading</div>
              <div className="mt-4 flex gap-2">
                <Button variant="outline" onClick={tare} className="rounded-full bounce-tap">
                  Tare
                </Button>
                <Button onClick={captureWeight} className="rounded-full font-bold bounce-tap">
                  Capture Weight
                </Button>
              </div>
            </div>
          </div>

          {detected.length > 0 && (
            <div className="mt-5">
              <div className="text-sm font-bold mb-2">Detected items — tweak portions:</div>
              <ul className="space-y-2">
                {detected.map((it) => (
                  <li
                    key={it.id}
                    className="rounded-2xl border p-3 flex items-center gap-3 animate-pop"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-bold truncate">{it.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {it.calories} kcal · P {it.protein} · C {it.carbs} · F {it.fat}
                      </div>
                    </div>
                    <Input
                      type="number"
                      value={it.grams}
                      onChange={(e) => updateDetected(it.id, Number(e.target.value))}
                      className="w-20 text-center font-bold"
                    />
                    <span className="text-xs text-muted-foreground">g</span>
                    <button
                      onClick={() => removeDetected(it.id)}
                      className="text-destructive p-1 bounce-tap"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
              <Button
                onClick={addDetectedToBatch}
                className="mt-3 w-full rounded-full font-bold bounce-tap"
              >
                <Plus className="mr-1 h-4 w-4" /> Add to meal batch
              </Button>
            </div>
          )}
        </div>

        {/* Coach suggestions */}
        <div className="card-soft p-4 flex items-start gap-3 bg-gradient-to-r from-sun/15 to-primary/10">
          <Mascot size={56} className="animate-float shrink-0" />
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wider text-primary font-bold">Coach tip</div>
            <div className="text-sm font-semibold">{suggestion}</div>
          </div>
        </div>

        {/* Batch */}
        <div className="card-soft p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg">🥗 In this meal ({batch.length})</h2>
            <div className="text-xs text-muted-foreground">
              {batchTotals.calories} kcal · P {batchTotals.protein.toFixed(0)} · C{" "}
              {batchTotals.carbs.toFixed(0)} · F {batchTotals.fat.toFixed(0)}
            </div>
          </div>

          {batch.length ? (
            <ul className="space-y-2">
              {batch.map((it) => (
                <li key={it.id} className="rounded-xl bg-muted p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold truncate">{it.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {it.grams}g · {it.calories} kcal
                    </div>
                  </div>
                  <button
                    onClick={() => setBatch((b) => b.filter((x) => x.id !== it.id))}
                    className="text-destructive p-1 bounce-tap"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-center py-6 text-sm text-muted-foreground">
              No items yet. Capture an image or add from the scanner.
            </div>
          )}

          <Button
            onClick={submitBatch}
            size="lg"
            className="mt-4 w-full rounded-full font-bold bounce-tap"
          >
            Save meal 🎉
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
