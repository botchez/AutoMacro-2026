import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  SunMoon,
  UserRound,
  Utensils,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useApp, type ThemeMode, type UserSettings } from "@/lib/store";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — NutriCoach" },
      {
        name: "description",
        content: "Manage your profile, nutrition targets, preferences, theme, and account security.",
      },
    ],
  }),
  component: SettingsPage,
});

const sections = [
  { id: "profile", label: "Personal details", icon: UserRound },
  { id: "targets", label: "Nutrition targets", icon: SlidersHorizontal },
  { id: "preferences", label: "Preferences", icon: Utensils },
  { id: "appearance", label: "Appearance", icon: SunMoon },
  { id: "security", label: "Security", icon: ShieldCheck },
] as const;

function SettingsPage() {
  const { user, goals, settings, theme, setTheme, ready, updateSettings, changePassword } = useApp();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState("profile");
  const savedSettings = useMemo(
    () =>
      settings
        ? { ...settings, theme: settings.theme ?? theme }
        : user && goals
          ? {
              ...goals,
              name: user.name,
              email: user.email,
              sex: "prefer-not" as const,
              age: null,
              height: null,
              weight: null,
              activity: "moderate" as const,
              allergies: "",
              weekStartsOn: "monday" as const,
              theme,
            }
          : null,
    [settings, user, goals, theme],
  );

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  useEffect(() => {
    if (savedSettings) setDraft(savedSettings);
  }, [savedSettings]);

  const dirty = useMemo(
    () =>
      Boolean(draft && savedSettings && JSON.stringify(draft) !== JSON.stringify(savedSettings)),
    [draft, savedSettings],
  );

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error("Please enter your name.");
      return;
    }
    if (draft.calories < 800 || draft.calories > 10_000) {
      toast.error("Enter a daily calorie target between 800 and 10,000 kcal.");
      return;
    }
    if ([draft.protein, draft.carbs, draft.fat].some((value) => value < 0)) {
      toast.error("Macro targets cannot be negative.");
      return;
    }
    setSaving(true);
    try {
      await updateSettings({
        ...draft,
        name: draft.name.trim(),
        email: draft.email.trim().toLowerCase(),
        dietary: draft.dietary.trim() || "No restrictions",
        allergies: draft.allergies.trim(),
      });
      toast.success("Settings saved", {
        description: "Your dashboard and nutrition plan are now up to date.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your settings");
    } finally {
      setSaving(false);
    }
  };

  const jumpTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!ready || !draft || !goals) {
    return (
      <AppLayout>
        <div className="grid min-h-[60vh] place-items-center">
          <div className="flex items-center gap-3 text-sm font-bold text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            Loading your settings…
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-5xl space-y-6 pb-24">
        <header className="overflow-hidden rounded-3xl border bg-card">
          <div className="grid gap-5 p-6 md:grid-cols-[1fr_auto] md:items-center md:p-8">
            <div>
              <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-primary">
                Your account
              </div>
              <h1 className="mt-2 text-3xl font-black md:text-4xl">Settings</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                Keep your profile accurate and fine-tune the daily targets NutriCoach uses across
                your dashboard, food log, and coaching.
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-2xl bg-primary/8 px-4 py-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-lg font-black text-primary-foreground">
                {initials(draft.name)}
              </span>
              <div className="min-w-0">
                <div className="max-w-48 truncate font-extrabold">{draft.name}</div>
                <div className="max-w-48 truncate text-xs text-muted-foreground">{draft.email}</div>
              </div>
            </div>
          </div>
          <div className="h-1.5 bg-[linear-gradient(90deg,var(--color-primary),var(--color-sun),var(--color-sky),var(--color-berry))]" />
        </header>

        <div className="grid items-start gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="card-soft p-2 lg:sticky lg:top-6">
            <nav aria-label="Settings sections" className="grid grid-cols-2 gap-1 lg:grid-cols-1">
              {sections.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => jumpTo(id)}
                  className={cn(
                    "flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-bold transition-colors",
                    activeSection === id
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground/65 hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{label}</span>
                  <ChevronRight className="ml-auto hidden h-4 w-4 lg:block" />
                </button>
              ))}
            </nav>
          </aside>

          <div className="space-y-6">
            <SettingsSection
              id="profile"
              icon={UserRound}
              title="Personal details"
              description="These details help keep recommendations relevant to you."
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Full name" htmlFor="settings-name">
                  <Input
                    id="settings-name"
                    autoComplete="name"
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, name: event.target.value })
                    }
                    className="h-11 rounded-xl"
                  />
                </Field>
                <Field label="Email address" htmlFor="settings-email">
                  <Input
                    id="settings-email"
                    type="email"
                    autoComplete="email"
                    value={draft.email}
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, email: event.target.value })
                    }
                    className="h-11 rounded-xl"
                  />
                </Field>
                <Field label="Age" htmlFor="settings-age" hint="16–120 years">
                  <Input
                    id="settings-age"
                    type="number"
                    min={16}
                    max={120}
                    value={draft.age ?? ""}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              age: event.target.value ? Number(event.target.value) : null,
                            }
                          : current,
                      )
                    }
                    className="h-11 rounded-xl"
                  />
                </Field>
                <Field label="Profile used for estimates">
                  <Select
                    value={draft.sex}
                    onValueChange={(sex: UserSettings["sex"]) =>
                      setDraft((current) => current && { ...current, sex })
                    }
                  >
                    <SelectTrigger className="h-11 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                      <SelectItem value="prefer-not">Prefer not to say</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label="Height"
                  htmlFor="settings-height"
                  hint={draft.units === "metric" ? "Centimetres" : "Inches"}
                >
                  <MeasurementInput
                    id="settings-height"
                    value={draft.height}
                    suffix={draft.units === "metric" ? "cm" : "in"}
                    onChange={(height) => setDraft((current) => current && { ...current, height })}
                  />
                </Field>
                <Field
                  label="Current weight"
                  htmlFor="settings-weight"
                  hint="Update this as your body changes"
                >
                  <MeasurementInput
                    id="settings-weight"
                    value={draft.weight}
                    suffix={draft.units === "metric" ? "kg" : "lb"}
                    onChange={(weight) => setDraft((current) => current && { ...current, weight })}
                  />
                </Field>
              </div>
            </SettingsSection>

            <SettingsSection
              id="targets"
              icon={SlidersHorizontal}
              title="Daily nutrition targets"
              description="Changes appear immediately in macro rings, summaries, and coach guidance."
            >
              <div>
                <Label className="text-sm font-extrabold">Primary goal</Label>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["lose", "Lose body fat", "Steady deficit"],
                      ["maintain", "Maintain", "Balanced intake"],
                      ["gain", "Build muscle", "Recovery surplus"],
                    ] as const
                  ).map(([value, label, detail]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() =>
                        setDraft((current) => (current ? { ...current, goalType: value } : current))
                      }
                      className={cn(
                        "rounded-2xl border-2 p-3 text-left transition-colors",
                        draft.goalType === value
                          ? "border-primary bg-primary/8"
                          : "border-border hover:border-primary/30",
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-extrabold">
                        <span
                          className={cn(
                            "grid h-5 w-5 place-items-center rounded-full border",
                            draft.goalType === value &&
                              "border-primary bg-primary text-primary-foreground",
                          )}
                        >
                          {draft.goalType === value && <Check className="h-3 w-3" />}
                        </span>
                        {label}
                      </div>
                      <div className="ml-7 mt-1 text-xs text-muted-foreground">{detail}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <MacroTarget
                  label="Calories"
                  value={draft.calories}
                  unit="kcal"
                  color="bg-primary"
                  onChange={(calories) =>
                    setDraft((current) => current && { ...current, calories })
                  }
                />
                <MacroTarget
                  label="Protein"
                  value={draft.protein}
                  unit="g"
                  color="bg-mango"
                  onChange={(protein) => setDraft((current) => current && { ...current, protein })}
                />
                <MacroTarget
                  label="Carbohydrates"
                  value={draft.carbs}
                  unit="g"
                  color="bg-sky"
                  onChange={(carbs) => setDraft((current) => current && { ...current, carbs })}
                />
                <MacroTarget
                  label="Fat"
                  value={draft.fat}
                  unit="g"
                  color="bg-berry"
                  onChange={(fat) => setDraft((current) => current && { ...current, fat })}
                />
              </div>

              <MacroBalance settings={draft} />
            </SettingsSection>

            <SettingsSection
              id="preferences"
              icon={Utensils}
              title="Nutrition and app preferences"
              description="Tell NutriCoach how you eat and how you prefer to use the app."
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Dietary preference">
                  <Select
                    value={draft.dietary}
                    onValueChange={(dietary) =>
                      setDraft((current) => current && { ...current, dietary })
                    }
                  >
                    <SelectTrigger className="h-11 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "No restrictions",
                        "Vegetarian",
                        "Vegan",
                        "Pescatarian",
                        "Gluten-free",
                        "Halal",
                        "Kosher",
                      ].map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Activity level">
                  <Select
                    value={draft.activity}
                    onValueChange={(activity: UserSettings["activity"]) =>
                      setDraft((current) => current && { ...current, activity })
                    }
                  >
                    <SelectTrigger className="h-11 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Mostly seated</SelectItem>
                      <SelectItem value="light">Lightly active</SelectItem>
                      <SelectItem value="moderate">Active</SelectItem>
                      <SelectItem value="high">Very active</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Food allergies or exclusions" htmlFor="settings-allergies">
                  <Input
                    id="settings-allergies"
                    value={draft.allergies}
                    placeholder="e.g. peanuts, shellfish"
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, allergies: event.target.value } : current,
                      )
                    }
                    className="h-11 rounded-xl"
                  />
                </Field>
                <Field label="Measurement units">
                  <Select value={draft.units} onValueChange={changeUnits(setDraft, draft)}>
                    <SelectTrigger className="h-11 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="metric">Metric (kg, cm)</SelectItem>
                      <SelectItem value="imperial">Imperial (lb, in)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Week starts on">
                  <Select
                    value={draft.weekStartsOn}
                    onValueChange={(weekStartsOn: UserSettings["weekStartsOn"]) =>
                      setDraft((current) => current && { ...current, weekStartsOn })
                    }
                  >
                    <SelectTrigger className="h-11 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monday">Monday</SelectItem>
                      <SelectItem value="sunday">Sunday</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="mt-5 flex gap-3 rounded-2xl bg-sky/10 p-4 text-sm">
                <Activity className="mt-0.5 h-4 w-4 shrink-0 text-sky" />
                <p className="leading-5 text-muted-foreground">
                  Dietary preferences and exclusions are shared with your AI coach so its food
                  suggestions can better fit your needs.
                </p>
              </div>
            </SettingsSection>

            <AppearanceSection draft={draft} setDraft={setDraft} setTheme={setTheme} />

            <PasswordSection changePassword={changePassword} />
          </div>
        </div>
      </div>

      <div className="fixed inset-x-4 bottom-4 z-20 rounded-2xl border bg-background/95 p-3 shadow-xl backdrop-blur md:left-auto md:w-[520px]">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            {dirty ? "You have unsaved changes." : "All changes are saved."}
          </div>
          <div className="flex gap-2">
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => savedSettings && setDraft(savedSettings)}
                disabled={saving}
                className="rounded-xl"
              >
                Discard
              </Button>
            )}
            <Button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="min-w-32 rounded-xl font-extrabold"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: typeof UserRound;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="card-soft scroll-mt-6 p-5 md:p-7">
      <div className="mb-6 flex gap-3 border-b pb-5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-xl font-black">{title}</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <Label htmlFor={htmlFor} className="font-extrabold">
          {label}
        </Label>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function MeasurementInput({
  id,
  value,
  suffix,
  onChange,
}: {
  id: string;
  value: number | null;
  suffix: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type="number"
        min={1}
        step="0.1"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        className="h-11 rounded-xl pr-12"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}

function MacroTarget({
  label,
  value,
  unit,
  color,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  color: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded-2xl border bg-background p-3">
      <span className={cn("h-9 w-1.5 shrink-0 rounded-full", color)} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold text-muted-foreground">{label}</span>
        <span className="relative mt-1 block">
          <Input
            type="number"
            min={0}
            step={label === "Calories" ? 10 : 1}
            value={value}
            aria-label={`${label} target`}
            onChange={(event) => onChange(Number(event.target.value))}
            className="h-9 rounded-lg border-0 bg-muted/60 pr-14 font-extrabold shadow-none"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
            {unit}
          </span>
        </span>
      </span>
    </label>
  );
}

function MacroBalance({ settings }: { settings: UserSettings }) {
  const macroCalories = settings.protein * 4 + settings.carbs * 4 + settings.fat * 9;
  const difference = settings.calories ? Math.abs(macroCalories - settings.calories) : 0;
  const close = difference <= settings.calories * 0.1;
  return (
    <div className={cn("mt-4 rounded-2xl p-4", close ? "bg-primary/8" : "bg-sun/15")}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full",
            close ? "bg-primary text-primary-foreground" : "bg-sun text-foreground",
          )}
        >
          {close ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <SlidersHorizontal className="h-3.5 w-3.5" />
          )}
        </span>
        <div>
          <div className="text-sm font-extrabold">
            {close ? "Your targets are well balanced" : "Review your macro balance"}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Protein, carbs, and fat provide about {Math.round(macroCalories).toLocaleString()} kcal
            per day, compared with your {Math.round(settings.calories).toLocaleString()} kcal
            target.
          </p>
        </div>
      </div>
    </div>
  );
}

function PasswordSection({
  changePassword,
}: {
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 8) {
      toast.error("Your new password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("The new passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update your password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      id="security"
      icon={ShieldCheck}
      title="Password and security"
      description="Use a unique password with at least eight characters."
    >
      <form onSubmit={submit}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Current password" htmlFor="current-password">
            <PasswordInput
              id="current-password"
              value={currentPassword}
              show={showPasswords}
              autoComplete="current-password"
              onChange={setCurrentPassword}
            />
          </Field>
          <div className="hidden sm:block" />
          <Field label="New password" htmlFor="new-password">
            <PasswordInput
              id="new-password"
              value={newPassword}
              show={showPasswords}
              autoComplete="new-password"
              onChange={setNewPassword}
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password">
            <PasswordInput
              id="confirm-password"
              value={confirmPassword}
              show={showPasswords}
              autoComplete="new-password"
              onChange={setConfirmPassword}
            />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-5">
          <button
            type="button"
            onClick={() => setShowPasswords((current) => !current)}
            className="flex items-center gap-2 text-xs font-bold text-muted-foreground hover:text-foreground"
          >
            {showPasswords ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showPasswords ? "Hide passwords" : "Show passwords"}
          </button>
          <Button
            type="submit"
            variant="outline"
            disabled={saving || !currentPassword || !newPassword || !confirmPassword}
            className="rounded-xl font-extrabold"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {saving ? "Updating…" : "Update password"}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function PasswordInput({
  id,
  value,
  show,
  autoComplete,
  onChange,
}: {
  id: string;
  value: string;
  show: boolean;
  autoComplete: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      id={id}
      type={show ? "text" : "password"}
      autoComplete={autoComplete}
      value={value}
      minLength={8}
      onChange={(event) => onChange(event.target.value)}
      className="h-11 rounded-xl"
    />
  );
}

function changeUnits(
  setDraft: React.Dispatch<React.SetStateAction<UserSettings | null>>,
  current: UserSettings,
) {
  return (units: UserSettings["units"]) => {
    if (units === current.units) return;
    setDraft((draft) => {
      if (!draft) return draft;
      return {
        ...draft,
        units,
        height:
          draft.height == null
            ? null
            : units === "imperial"
              ? round(draft.height / 2.54)
              : round(draft.height * 2.54),
        weight:
          draft.weight == null
            ? null
            : units === "imperial"
              ? round(draft.weight * 2.20462)
              : round(draft.weight / 2.20462),
      };
    });
  };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function AppearanceSection({
  draft,
  setDraft,
  setTheme,
}: {
  draft: UserSettings;
  setDraft: React.Dispatch<React.SetStateAction<UserSettings | null>>;
  setTheme: (theme: ThemeMode) => void;
}) {
  const currentTheme = draft.theme || "light";
  return (
    <SettingsSection
      id="appearance"
      icon={SunMoon}
      title="Appearance & Theme"
      description="Choose your preferred color theme. Dark mode provides a sleek dark background and vibrant high-contrast accents, especially for coach conversation."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          {
            value: "light" as const,
            label: "Light Mode",
            desc: "Bright & energetic UI",
            icon: Sun,
            previewBg: "bg-white border-slate-200 text-slate-900 shadow-sm",
            badgeBg: "bg-emerald-600 text-white",
            chatBubble: "bg-emerald-100/80 text-emerald-950",
          },
          {
            value: "dark" as const,
            label: "Dark Mode",
            desc: "Deep Slate & Glowing accents",
            icon: Moon,
            previewBg: "bg-slate-950 border-slate-800 text-slate-100 shadow-sm",
            badgeBg: "bg-emerald-500 text-slate-950 font-bold",
            chatBubble: "bg-slate-800 text-slate-100 border border-slate-700",
          },
          {
            value: "system" as const,
            label: "System default",
            desc: "Syncs with your device setting",
            icon: Monitor,
            previewBg: "bg-slate-900/60 border-slate-700 text-slate-100 shadow-sm",
            badgeBg: "bg-primary text-primary-foreground",
            chatBubble: "bg-slate-800/80 text-slate-200",
          },
        ].map(({ value, label, desc, icon: Icon, previewBg, badgeBg, chatBubble }) => {
          const active = currentTheme === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => {
                setDraft((current) => current && { ...current, theme: value });
                setTheme(value);
              }}
              className={cn(
                "relative overflow-hidden rounded-2xl border-2 p-4 text-left transition-all bounce-tap",
                active
                  ? "border-primary bg-primary/8 shadow-md"
                  : "border-border hover:border-primary/40",
              )}
            >
              <div
                className={cn(
                  "mb-3.5 h-24 rounded-xl border p-3 flex flex-col justify-between transition-colors",
                  previewBg,
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "text-[9px] px-2 py-0.5 rounded-full font-extrabold uppercase tracking-wider",
                      badgeBg,
                    )}
                  >
                    Coach
                  </span>
                  <Icon className="h-4 w-4 opacity-80" />
                </div>
                <div className={cn("text-[11px] font-semibold p-2 rounded-lg truncate", chatBubble)}>
                  "What should I eat for dinner?"
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm font-extrabold">
                <span
                  className={cn(
                    "grid h-5 w-5 place-items-center rounded-full border",
                    active && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {active && <Check className="h-3 w-3" />}
                </span>
                {label}
              </div>
              <div className="ml-7 mt-1 text-xs text-muted-foreground">{desc}</div>
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
}
