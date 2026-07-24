import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mascot } from "@/components/Mascot";
import { useApp, type Goals } from "@/lib/store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Set your goals — NutriCoach" },
      {
        name: "description",
        content: "Tell your coach what you're aiming for and get a personalized daily target.",
      },
      { property: "og:title", content: "Set your nutrition goals" },
      { property: "og:description", content: "Personalize your daily macro targets." },
    ],
  }),
  component: Onboarding,
});

const steps = ["Goal", "Calories", "Protein", "Carbs", "Fat", "Preferences"] as const;

function Onboarding() {
  const { user, setGoals, goals, ready } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [data, setData] = useState<Goals>(
    goals ?? {
      goalType: "maintain",
      calories: 2200,
      protein: 140,
      carbs: 250,
      fat: 70,
      dietary: "No restrictions",
      units: "metric",
    },
  );

  useEffect(() => {
    if (ready && !user) navigate({ to: "/" });
  }, [ready, user, navigate]);

  const next = async () => {
    if (step < steps.length - 1) setStep(step + 1);
    else {
      try {
        await setGoals(data);
        navigate({ to: "/dashboard" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save goals");
      }
    }
  };
  const back = () => step > 0 && setStep(step - 1);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg card-soft p-6 md:p-8 animate-pop">
        <div className="flex items-center gap-3 mb-4">
          <Mascot size={56} className="animate-float" />
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Step {step + 1} of {steps.length}
            </div>
            <div className="text-lg font-extrabold">{steps[step]}</div>
          </div>
        </div>

        {/* Progress */}
        <div className="flex gap-1 mb-6">
          {steps.map((_, i) => (
            <div
              key={i}
              className={cn(
                "h-2 flex-1 rounded-full transition-colors",
                i <= step ? "bg-primary" : "bg-muted",
              )}
            />
          ))}
        </div>

        <div className="min-h-[220px]">
          {step === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">What are you working toward?</p>
              {(
                [
                  ["lose", "🔥 Lose fat", "Gentle deficit, protein-forward"],
                  ["maintain", "⚖️ Maintain", "Feel great, stay steady"],
                  ["gain", "💪 Gain muscle", "Fuel your training"],
                ] as const
              ).map(([v, title, desc]) => (
                <button
                  key={v}
                  onClick={() => setData({ ...data, goalType: v })}
                  className={cn(
                    "w-full text-left rounded-2xl border-2 p-4 bounce-tap",
                    data.goalType === v ? "border-primary bg-primary/10" : "border-border",
                  )}
                >
                  <div className="font-bold">{title}</div>
                  <div className="text-xs text-muted-foreground">{desc}</div>
                </button>
              ))}
            </div>
          )}

          {step >= 1 && step <= 4 && (
            <NumberStep
              label={
                step === 1
                  ? "Daily calories"
                  : step === 2
                    ? "Protein (g)"
                    : step === 3
                      ? "Carbs (g)"
                      : "Fat (g)"
              }
              value={
                step === 1
                  ? data.calories
                  : step === 2
                    ? data.protein
                    : step === 3
                      ? data.carbs
                      : data.fat
              }
              onChange={(v) => {
                if (step === 1) setData({ ...data, calories: v });
                if (step === 2) setData({ ...data, protein: v });
                if (step === 3) setData({ ...data, carbs: v });
                if (step === 4) setData({ ...data, fat: v });
              }}
              hint={
                step === 1
                  ? "Not sure? 2200 is a friendly starting point."
                  : step === 2
                    ? "Aim for ~1.6–2.2g/kg bodyweight."
                    : step === 3
                      ? "Your main fuel source. Adjust to your training."
                      : "Don't fear fat — flavor + hormones love it."
              }
            />
          )}

          {step === 5 && (
            <div className="space-y-4">
              <div>
                <Label>Dietary preference</Label>
                <div className="flex flex-wrap gap-2 mt-2">
                  {["No restrictions", "Vegetarian", "Vegan", "Pescatarian", "Gluten-free"].map(
                    (d) => (
                      <button
                        key={d}
                        onClick={() => setData({ ...data, dietary: d })}
                        className={cn(
                          "rounded-full px-3 py-1.5 text-sm font-semibold border-2 bounce-tap",
                          data.dietary === d ? "border-primary bg-primary/10" : "border-border",
                        )}
                      >
                        {d}
                      </button>
                    ),
                  )}
                </div>
              </div>
              <div>
                <Label>Units</Label>
                <div className="flex gap-2 mt-2">
                  {(["metric", "imperial"] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => setData({ ...data, units: u })}
                      className={cn(
                        "flex-1 rounded-2xl px-3 py-3 text-sm font-bold border-2 bounce-tap capitalize",
                        data.units === u ? "border-primary bg-primary/10" : "border-border",
                      )}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-2">
          {step > 0 && (
            <Button variant="outline" onClick={back} className="rounded-full bounce-tap">
              Back
            </Button>
          )}
          <Button onClick={next} className="ml-auto rounded-full font-bold bounce-tap" size="lg">
            {step === steps.length - 1 ? "Finish 🎉" : "Next →"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NumberStep({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <div>
      <Label htmlFor="n">{label}</Label>
      <Input
        id="n"
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="text-2xl h-14 rounded-2xl mt-2 font-bold"
      />
      <p className="text-xs text-muted-foreground mt-2">{hint}</p>
      <div className="flex gap-2 mt-4">
        {[-50, -10, +10, +50].map((delta) => (
          <button
            key={delta}
            onClick={() => onChange(Math.max(0, value + delta))}
            className="flex-1 rounded-full bg-muted hover:bg-accent text-sm font-bold py-2 bounce-tap"
          >
            {delta > 0 ? `+${delta}` : delta}
          </button>
        ))}
      </div>
    </div>
  );
}
