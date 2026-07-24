import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, ArrowRight, Check, Ruler, Sparkles, Target } from "lucide-react";
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
      { title: "Build your nutrition plan — NutriCoach" },
      {
        name: "description",
        content: "Answer a few questions and get personalized daily nutrition targets.",
      },
    ],
  }),
  component: Onboarding,
});

const steps = [
  { label: "Goal", icon: Target },
  { label: "About you", icon: Ruler },
  { label: "Routine", icon: Activity },
  { label: "Your plan", icon: Sparkles },
] as const;

type Profile = {
  goalType: Goals["goalType"];
  sex: "female" | "male" | "other";
  age: number;
  height: number;
  weight: number;
  activity: "low" | "light" | "moderate" | "high";
  dietary: string;
  units: Goals["units"];
};

const activityOptions: Array<{
  value: Profile["activity"];
  label: string;
  detail: string;
  factor: number;
}> = [
  { value: "low", label: "Mostly seated", detail: "Little planned exercise", factor: 1.2 },
  { value: "light", label: "Lightly active", detail: "1–3 workouts per week", factor: 1.375 },
  { value: "moderate", label: "Active", detail: "3–5 workouts per week", factor: 1.55 },
  { value: "high", label: "Very active", detail: "Hard training most days", factor: 1.725 },
];

function Onboarding() {
  const { user, updateSettings, settings, goals, ready } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<Profile>({
    goalType: goals?.goalType ?? "maintain",
    sex: "other",
    age: 30,
    height: 170,
    weight: 70,
    activity: "moderate",
    dietary: goals?.dietary ?? "No restrictions",
    units: goals?.units ?? "metric",
  });
  const calculated = useMemo(() => calculateTargets(profile), [profile]);
  const [targets, setTargets] = useState<Goals | null>(goals);

  useEffect(() => {
    if (ready && !user) navigate({ to: "/" });
  }, [ready, user, navigate]);

  useEffect(() => {
    if (step === steps.length - 1 && !targets) setTargets(calculated);
  }, [calculated, step, targets]);

  const next = () => {
    if (step === 1 && (profile.age < 16 || profile.height <= 0 || profile.weight <= 0)) {
      toast.error("Please enter a valid age, height, and weight.");
      return;
    }
    if (step < steps.length - 1) {
      if (step === steps.length - 2) setTargets(calculated);
      setStep((current) => current + 1);
    }
  };

  const finish = async () => {
    if (!targets) return;
    setSaving(true);
    try {
      if (!user) return;
      await updateSettings({
        ...targets,
        name: user.name,
        email: user.email,
        sex: profile.sex,
        age: profile.age,
        height: profile.height,
        weight: profile.weight,
        activity: profile.activity,
        dietary: profile.dietary,
        allergies: settings?.allergies ?? "",
        weekStartsOn: settings?.weekStartsOn ?? "monday",
      });
      toast.success("Your nutrition plan is ready");
      navigate({ to: "/dashboard" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your plan");
    } finally {
      setSaving(false);
    }
  };

  const changeUnits = (units: Goals["units"]) => {
    if (units === profile.units) return;
    setProfile((current) => ({
      ...current,
      units,
      height:
        units === "imperial"
          ? Math.round((current.height / 2.54) * 10) / 10
          : Math.round(current.height * 2.54),
      weight:
        units === "imperial"
          ? Math.round(current.weight * 2.20462 * 10) / 10
          : Math.round((current.weight / 2.20462) * 10) / 10,
    }));
  };

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="mx-auto grid min-h-[calc(100vh-2rem)] max-w-5xl overflow-hidden rounded-[2rem] border bg-card shadow-xl transition-colors dark:shadow-black/40 md:min-h-[680px] md:grid-cols-[280px_1fr]">
        <aside className="bg-gradient-to-br from-primary/15 via-sun/15 to-sky/15 p-6 transition-colors dark:from-emerald-950/65 dark:via-slate-900 dark:to-cyan-950/40 md:p-8">
          <div className="flex items-center gap-3">
            <Mascot size={58} className="animate-float" />
            <div>
              <div className="text-lg font-black">Build your plan</div>
              <div className="text-xs font-semibold text-muted-foreground">About 2 minutes</div>
            </div>
          </div>

          <ol className="mt-6 grid grid-cols-4 gap-2 md:mt-10 md:grid-cols-1 md:gap-3">
            {steps.map(({ label, icon: Icon }, index) => (
              <li
                key={label}
                className={cn(
                  "flex items-center gap-3 rounded-2xl p-2 transition-colors md:p-3",
                  index === step && "bg-card shadow-sm dark:ring-1 dark:ring-white/5",
                  index < step && "text-primary",
                )}
              >
                <span
                  className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-card/70",
                    index === step && "bg-primary text-primary-foreground",
                  )}
                >
                  {index < step ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                </span>
                <span className="hidden text-sm font-bold md:block">{label}</span>
              </li>
            ))}
          </ol>

          <p className="mt-8 hidden text-xs leading-5 text-muted-foreground md:block">
            Targets are practical estimates, not medical advice. You can adjust them anytime.
          </p>
        </aside>

        <section className="flex flex-col p-6 md:p-10">
          <div className="mb-8">
            <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-primary">
              Step {step + 1} of {steps.length}
            </div>
            <h1 className="mt-2 text-3xl font-black">{stepTitle(step)}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{stepDescription(step)}</p>
          </div>

          <div className="flex-1">
            {step === 0 && <GoalStep profile={profile} setProfile={setProfile} />}
            {step === 1 && (
              <BodyStep profile={profile} setProfile={setProfile} changeUnits={changeUnits} />
            )}
            {step === 2 && <RoutineStep profile={profile} setProfile={setProfile} />}
            {step === 3 && targets && <PlanStep targets={targets} setTargets={setTargets} />}
          </div>

          <div className="mt-8 flex items-center gap-3 border-t pt-5">
            {step > 0 && (
              <Button
                variant="outline"
                onClick={() => setStep((current) => current - 1)}
                className="rounded-full"
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
            )}
            {step < steps.length - 1 ? (
              <Button onClick={next} className="ml-auto rounded-full font-bold" size="lg">
                Continue <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={finish}
                disabled={saving}
                className="ml-auto rounded-full font-bold"
                size="lg"
              >
                {saving ? "Saving…" : "Use this plan"}
                {!saving && <Check className="ml-2 h-4 w-4" />}
              </Button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function GoalStep({
  profile,
  setProfile,
}: {
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
}) {
  const options = [
    { value: "lose", title: "Lose body fat", detail: "A sustainable calorie deficit" },
    { value: "maintain", title: "Maintain & feel good", detail: "Steady energy and balance" },
    { value: "gain", title: "Build muscle", detail: "Extra fuel for training and recovery" },
  ] as const;
  return (
    <div className="grid gap-3">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => setProfile((current) => ({ ...current, goalType: option.value }))}
          className={cn(
            "flex items-center justify-between rounded-2xl border-2 p-4 text-left transition-colors",
            profile.goalType === option.value
              ? "border-primary bg-primary/7"
              : "border-border hover:border-primary/30",
          )}
        >
          <div>
            <div className="font-extrabold">{option.title}</div>
            <div className="mt-1 text-sm text-muted-foreground">{option.detail}</div>
          </div>
          <span
            className={cn(
              "grid h-6 w-6 place-items-center rounded-full border-2",
              profile.goalType === option.value && "border-primary bg-primary text-white",
            )}
          >
            {profile.goalType === option.value && <Check className="h-3.5 w-3.5" />}
          </span>
        </button>
      ))}
    </div>
  );
}

function BodyStep({
  profile,
  setProfile,
  changeUnits,
}: {
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
  changeUnits: (units: Goals["units"]) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <Label>Units</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(["metric", "imperial"] as const).map((unit) => (
            <button
              key={unit}
              onClick={() => changeUnits(unit)}
              className={cn(
                "rounded-xl border-2 px-4 py-2.5 text-sm font-bold capitalize",
                profile.units === unit ? "border-primary bg-primary/7" : "border-border",
              )}
            >
              {unit}
            </button>
          ))}
        </div>
      </div>
      <div>
        <Label>Which estimate should we use?</Label>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(["female", "male", "other"] as const).map((sex) => (
            <button
              key={sex}
              onClick={() => setProfile((current) => ({ ...current, sex }))}
              className={cn(
                "rounded-xl border-2 px-3 py-2.5 text-sm font-bold capitalize",
                profile.sex === sex ? "border-primary bg-primary/7" : "border-border",
              )}
            >
              {sex}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <NumberField
          label="Age"
          value={profile.age}
          suffix="years"
          onChange={(age) => setProfile((current) => ({ ...current, age }))}
        />
        <NumberField
          label="Height"
          value={profile.height}
          suffix={profile.units === "metric" ? "cm" : "in"}
          onChange={(height) => setProfile((current) => ({ ...current, height }))}
        />
        <NumberField
          label="Weight"
          value={profile.weight}
          suffix={profile.units === "metric" ? "kg" : "lb"}
          onChange={(weight) => setProfile((current) => ({ ...current, weight }))}
        />
      </div>
    </div>
  );
}

function RoutineStep({
  profile,
  setProfile,
}: {
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-2">
        {activityOptions.map((option) => (
          <button
            key={option.value}
            onClick={() => setProfile((current) => ({ ...current, activity: option.value }))}
            className={cn(
              "rounded-2xl border-2 p-3 text-left",
              profile.activity === option.value ? "border-primary bg-primary/7" : "border-border",
            )}
          >
            <div className="font-bold">{option.label}</div>
            <div className="text-xs text-muted-foreground">{option.detail}</div>
          </button>
        ))}
      </div>
      <div>
        <Label>Dietary preference</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {["No restrictions", "Vegetarian", "Vegan", "Pescatarian", "Gluten-free"].map(
            (dietary) => (
              <button
                key={dietary}
                onClick={() => setProfile((current) => ({ ...current, dietary }))}
                className={cn(
                  "rounded-full border-2 px-3 py-1.5 text-sm font-semibold",
                  profile.dietary === dietary ? "border-primary bg-primary/7" : "border-border",
                )}
              >
                {dietary}
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function PlanStep({
  targets,
  setTargets,
}: {
  targets: Goals;
  setTargets: React.Dispatch<React.SetStateAction<Goals | null>>;
}) {
  return (
    <div>
      <div className="rounded-2xl bg-gradient-to-r from-primary/10 via-sun/10 to-sky/10 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="font-extrabold">Your personalized daily targets</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Calculated from your body profile, routine, and goal. Fine-tune any value before
              saving.
            </p>
          </div>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        {(
          [
            ["calories", "Calories", "kcal"],
            ["protein", "Protein", "g"],
            ["carbs", "Carbs", "g"],
            ["fat", "Fat", "g"],
          ] as const
        ).map(([key, label, suffix]) => (
          <NumberField
            key={key}
            label={label}
            value={Math.round(targets[key])}
            suffix={suffix}
            onChange={(value) => setTargets((current) => current && { ...current, [key]: value })}
          />
        ))}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="relative mt-1.5">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-12 rounded-xl pr-12 font-bold"
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  );
}

function calculateTargets(profile: Profile): Goals {
  const weightKg = profile.units === "metric" ? profile.weight : profile.weight / 2.20462;
  const heightCm = profile.units === "metric" ? profile.height : profile.height * 2.54;
  const sexAdjustment = profile.sex === "male" ? 5 : profile.sex === "female" ? -161 : -78;
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * profile.age + sexAdjustment;
  const factor =
    activityOptions.find((option) => option.value === profile.activity)?.factor ?? 1.375;
  const adjustment = profile.goalType === "lose" ? -400 : profile.goalType === "gain" ? 300 : 0;
  const calories = Math.max(1200, Math.round((bmr * factor + adjustment) / 10) * 10);
  const proteinPerKg = profile.goalType === "lose" ? 2 : profile.goalType === "gain" ? 1.8 : 1.6;
  const protein = Math.round(weightKg * proteinPerKg);
  const fat = Math.round((calories * 0.28) / 9);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return {
    goalType: profile.goalType,
    calories,
    protein,
    carbs,
    fat,
    dietary: profile.dietary,
    units: profile.units,
  };
}

function stepTitle(step: number) {
  return [
    "What are you working toward?",
    "Tell us about yourself",
    "What does your week look like?",
    "Review your daily targets",
  ][step];
}

function stepDescription(step: number) {
  return [
    "Choose the outcome that matters most right now.",
    "These details help estimate your energy needs.",
    "Activity and food preferences shape a plan you can actually follow.",
    "Your coach will use these targets for daily suggestions.",
  ][step];
}
