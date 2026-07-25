import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Loader2, Plus, Send, Sparkles, Trash2, Utensils } from "lucide-react";
import { toast } from "sonner";
import coachHero from "@/assets/bicepsflex.png";
import { api, type CoachMessage, type CoachRecommendation } from "@/lib/api";
import { todayIso, useApp, type Macros } from "@/lib/store";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

const prompts = ["What should I eat next?", "How is my protein?", "Help me balance dinner"];

const uid = () => Math.random().toString(36).slice(2, 10);
const round1 = (value?: number | null) => Math.round((value ?? 0) * 10) / 10;

// Friendly provenance for a preloaded suggestion's macros (mirrors the log-food badges).
function sourceLabel(source?: string | null): string | null {
  switch (source) {
    case "history":
      return "From your logs";
    case "usda-fdc":
    case "fdc":
    case "fdc/cache":
      return "USDA FoodData Central";
    case "openfoodfacts":
      return "Open Food Facts";
    default:
      return null;
  }
}

export function CoachPanel() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [recommendations, setRecommendations] = useState<CoachRecommendation[]>([]);
  const [recommendationContext, setRecommendationContext] = useState("today’s macro gaps");
  const [loading, setLoading] = useState(true);
  // A reply is generating (survives navigation via server-side progress polling), plus
  // the live tool steps the coach reports as it works.
  const [pending, setPending] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  // Which suggestions have already been logged today (checkmark on their Add button).
  const [loggedNames, setLoggedNames] = useState<string[]>([]);
  // A suggestion opened in the quick-log modal to adjust its serving before logging.
  const [logTarget, setLogTarget] = useState<CoachRecommendation | null>(null);
  const [logGrams, setLogGrams] = useState("");
  const [logSaving, setLogSaving] = useState(false);
  // Simulate the hour the coach sees, to test its time-of-day coaching. "" means use the
  // real clock. Applies to both the chat and the "Run coach tip" button.
  const [devHour, setDevHour] = useState("");
  const [devRunning, setDevRunning] = useState(false);
  // Wiping the day's thread + sidebar and reopening with a fresh tip.
  const [clearing, setClearing] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const { mealsLogged, addMeal } = useApp();

  // --- watching an in-flight coach reply ---------------------------------------
  // The reply is generated server-side and its messages are committed to the DB, so we
  // poll: /coach/status for the live tool steps, and /coach/history for the finished
  // reply. This is what makes a message survive navigating away and back — the run keeps
  // going on the server and we re-attach to it, rather than losing local state.
  const watchRef = useRef<number | null>(null);
  const settledRef = useRef(true); // no run in flight to begin with
  const sawActiveRef = useRef(false);
  const startupRef = useRef(0);

  const stopWatch = () => {
    if (watchRef.current !== null) {
      window.clearInterval(watchRef.current);
      watchRef.current = null;
    }
  };

  // Pull the committed conversation; returns true once the reply has landed.
  const finalizeReply = async () => {
    if (settledRef.current) return true;
    try {
      const history = await api.coachHistory(todayIso());
      const msgs = Array.isArray(history.messages) ? history.messages : [];
      setMessages(msgs);
      if (Array.isArray(history.recommendations)) setRecommendations(history.recommendations);
      if (msgs.length && msgs[msgs.length - 1].role === "assistant") {
        settledRef.current = true;
        stopWatch();
        setPending(false);
        setSteps([]);
        return true;
      }
    } catch {
      // transient — the next tick tries again
    }
    return false;
  };

  const settleError = (text: string) => {
    if (settledRef.current) return;
    settledRef.current = true;
    stopWatch();
    setPending(false);
    setSteps([]);
    setMessages((current) => [
      ...current,
      { role: "assistant", content: text, createdAt: new Date().toISOString() },
    ]);
  };

  // Begin watching a run: reset the guards, show the pending indicator, and poll.
  // `silent` suppresses the "didn't respond" error bubble — used for the auto batch-log
  // watch, where no visible run (e.g. the agent is disabled) should just settle quietly
  // and leave the conversation untouched, rather than injecting a failure message.
  const startWatch = ({ silent = false }: { silent?: boolean } = {}) => {
    stopWatch();
    settledRef.current = false;
    sawActiveRef.current = false;
    startupRef.current = 0;
    setPending(true);
    setSteps([]);

    const giveUp = (text: string) => {
      if (silent) {
        settledRef.current = true;
        stopWatch();
        setPending(false);
        setSteps([]);
      } else {
        settleError(text);
      }
    };

    const tick = async () => {
      if (settledRef.current) return;
      let status: { active: boolean; steps: string[] } | null = null;
      try {
        status = await api.coachStatus();
      } catch {
        status = null;
      }
      if (status?.active) {
        sawActiveRef.current = true;
        setSteps(status.steps ?? []);
        return;
      }
      // Run is idle/unreachable: the reply may already be committed.
      if (await finalizeReply()) return;
      if (sawActiveRef.current) {
        giveUp("⚠️ The coach didn’t finish responding. Please try again.");
        return;
      }
      // Startup grace: the run may not have registered yet (a few ticks), then give up.
      startupRef.current += 1;
      if (startupRef.current > 8) {
        giveUp("⚠️ The coach didn’t respond. Please try again.");
      }
    };

    watchRef.current = window.setInterval(() => void tick(), 1200);
    void tick();
  };

  // Stop polling if the panel unmounts (the run keeps going server-side regardless).
  useEffect(() => stopWatch, []);

  // Per-100g density for a suggestion — preloaded when the coach priced the food, else
  // derived from its serving so the modal always has something to re-scale by weight.
  const per100Of = (food: CoachRecommendation): Macros | null => {
    if (food.per100) return food.per100;
    if (food.grams != null && food.grams > 0 && food.calories != null) {
      const f = 100 / food.grams;
      return {
        calories: (food.calories ?? 0) * f,
        protein: (food.protein ?? 0) * f,
        carbs: (food.carbs ?? 0) * f,
        fat: (food.fat ?? 0) * f,
      };
    }
    return null;
  };

  // Adding a suggestion opens the quick-log modal (prefilled with its serving) so the
  // user can adjust the portion before it's logged, rather than committing instantly.
  const openLog = (food: CoachRecommendation) => {
    setLogTarget(food);
    setLogGrams(String(Math.round(food.grams ?? 100)));
  };

  const confirmLog = async () => {
    if (!logTarget) return;
    const per100 = per100Of(logTarget);
    if (!per100) return;
    const grams = Math.max(1, Math.round(parseFloat(logGrams) || 0));
    const factor = grams / 100;
    setLogSaving(true);
    try {
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(
        2,
        "0",
      )}`;
      await addMeal(
        todayIso(),
        {
          id: uid(),
          time,
          items: [
            {
              id: uid(),
              name: logTarget.name,
              grams,
              calories: Math.round(per100.calories * factor),
              protein: round1(per100.protein * factor),
              carbs: round1(per100.carbs * factor),
              fat: round1(per100.fat * factor),
              source: logTarget.source ?? "coach",
              per100,
            },
          ],
        },
        // Accepting the coach's own suggestion — don't re-run the coach on it.
        { triggerCoach: false },
      );
      setLoggedNames((current) => [...current, logTarget.name]);
      toast.success(`${logTarget.name} logged`, {
        description: `${grams}g · ${Math.round(per100.calories * factor)} kcal`,
      });
      setLogTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not log that food");
    } finally {
      setLogSaving(false);
    }
  };

  // The simulated hour to send the coach, or undefined to use the real clock.
  const devHourValue = (): number | undefined => {
    if (devHour === "") return undefined;
    const n = Number.parseInt(devHour, 10);
    if (Number.isNaN(n)) return undefined;
    return Math.min(23, Math.max(0, n));
  };

  // Run a fresh coach tip at the simulated hour and append its reply, so we can see what
  // the coach says at any time of day.
  const runDevTip = async () => {
    if (devRunning || loading || pending) return;
    const hour = devHourValue();
    setDevRunning(true);
    try {
      const tip = await api.coachTip(todayIso(), hour);
      setMessages((current) => [
        ...current,
        { role: "assistant", content: tip.message, createdAt: new Date().toISOString() },
      ]);
      setRecommendations(Array.isArray(tip.recommendations) ? tip.recommendations : []);
      setRecommendationContext(
        hour != null ? `simulated ${String(hour).padStart(2, "0")}:00` : "your latest logged meal",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Coach test failed");
    } finally {
      setDevRunning(false);
    }
  };

  // Clear today's conversation: stop any in-flight watch, wipe the thread and sidebar
  // server-side, then reopen with a fresh coach tip so the panel isn't left blank.
  const clearChat = async () => {
    if (loading || pending || clearing) return;
    setClearing(true);
    stopWatch();
    settledRef.current = true;
    try {
      await api.coachClear(todayIso());
      setSteps([]);
      setPending(false);
      setRecommendationContext("today’s macro gaps");
      // Reopen with a fresh tip, mirroring first load; fall back to a static line if the
      // agent is unavailable so we still show an empty, usable chat.
      try {
        const tip = await api.coachTip(todayIso());
        setMessages([
          { role: "assistant", content: tip.message, createdAt: new Date().toISOString() },
        ]);
        setRecommendations(Array.isArray(tip.recommendations) ? tip.recommendations : []);
      } catch {
        setMessages([
          {
            role: "assistant",
            content: "Cleared. Log a meal or ask me anything to start fresh.",
            createdAt: new Date().toISOString(),
          },
        ]);
        setRecommendations([]);
      }
      toast.success("Chat cleared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear the chat");
    } finally {
      setClearing(false);
    }
  };

  useEffect(() => {
    const loadConversation = async () => {
      setLoading(true);
      try {
        const history = await api.coachHistory(todayIso());
        const savedMessages = Array.isArray(history.messages) ? history.messages : [];
        setRecommendations(Array.isArray(history.recommendations) ? history.recommendations : []);
        if (savedMessages.length) {
          setMessages(savedMessages);
          const latestQuestion = [...savedMessages]
            .reverse()
            .find((item) => item.role === "user")?.content;
          if (latestQuestion) setRecommendationContext(latestQuestion);
          // A trailing user turn with no reply means a run is still in flight (e.g. we
          // navigated away while it was thinking) — re-attach and show its progress.
          if (savedMessages[savedMessages.length - 1].role === "user") startWatch();
        } else {
          // No thread yet — generate the opening tip. Fire it and WATCH the run (rather
          // than awaiting a stepless spinner) so its live tool-call steps show while it
          // thinks; the watch reads the committed reply back from history when it lands.
          startWatch();
          void api
            .coachTip(todayIso())
            .catch(() => settleError("⚠️ Coach unavailable. Log a meal and try again."));
        }
      } catch {
        setMessages([
          {
            role: "assistant",
            content: "Log a meal and I’ll help you decide what to eat next.",
            createdAt: new Date().toISOString(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    void loadConversation();
  }, []);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
    // `pending`/`steps` are included so the "Coach is working…" indicator scrolls into
    // view the moment a run starts (e.g. right after logging a meal), not just when the
    // finished message lands.
  }, [messages, loading, pending, steps]);

  const ask = async (question = message) => {
    const trimmed = question.trim();
    if (!trimmed || loading || pending) return;
    setMessage("");
    setRecommendationContext(trimmed);
    setMessages((current) => [
      ...current,
      { role: "user", content: trimmed, createdAt: new Date().toISOString() },
    ]);
    // Start watching immediately so the live tool steps show and, crucially, the run is
    // re-attachable from history if the user navigates away before it finishes.
    startWatch();
    try {
      await api.coachMessage(trimmed, todayIso(), devHourValue());
      await finalizeReply();
    } catch (error) {
      // Surface the real failure instead of a soothing non-answer — the coach fails
      // loud now, so show why (e.g. the 502 detail from the agent) for diagnosis.
      settleError(
        error instanceof Error ? `⚠️ Coach unavailable: ${error.message}` : "⚠️ Coach unavailable.",
      );
    }
  };

  // Auto-coach when a meal is logged. The store fires the single coachTip() run (so it
  // works from any page); here we only WATCH it — surfacing the live tool steps and
  // appending its coaching to the day's persistent thread — instead of firing a second
  // call. A batch watch settles quietly if no run registers, leaving the chat untouched.
  const startBatchWatch = () => {
    if (loading) return;
    setRecommendationContext("your latest logged meal");
    startWatch({ silent: true });
  };

  // Keep the latest startBatchWatch in a ref so the meal-log effect can call it without
  // re-firing on every render (the function is recreated each render).
  const startBatchWatchRef = useRef(startBatchWatch);
  startBatchWatchRef.current = startBatchWatch;

  // Watch the coach whenever a new batch of food is logged. Initialised to the current
  // count so it never fires on mount — only on genuine in-session increments.
  const seenMealsRef = useRef(mealsLogged);
  useEffect(() => {
    if (mealsLogged === seenMealsRef.current) return;
    seenMealsRef.current = mealsLogged;
    startBatchWatchRef.current();
  }, [mealsLogged]);

  // Live macros for the quick-log modal, recomputed from the food's per-100g density as
  // the user edits the serving.
  const logPer100 = logTarget ? per100Of(logTarget) : null;
  const logGramsNum = Math.max(1, Math.round(parseFloat(logGrams) || 0));
  const logPreview = logPer100
    ? {
        calories: Math.round(logPer100.calories * (logGramsNum / 100)),
        protein: round1(logPer100.protein * (logGramsNum / 100)),
        carbs: round1(logPer100.carbs * (logGramsNum / 100)),
        fat: round1(logPer100.fat * (logGramsNum / 100)),
      }
    : null;

  return (
    <>
      <section className="relative overflow-hidden rounded-[2rem] border border-primary/20 bg-gradient-to-br from-primary/15 via-card to-sun/15 p-5 shadow-lg shadow-primary/5 transition-colors dark:border-emerald-900/35 dark:from-emerald-950/55 dark:via-slate-900/95 dark:to-cyan-950/30 dark:shadow-black/50 md:p-7">
        <div
          aria-hidden="true"
          className="absolute -right-16 -top-16 h-52 w-52 rounded-full bg-sky/20 dark:bg-emerald-500/10 blur-3xl pointer-events-none"
        />
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <div className="flex items-center gap-4">
              <div className="flex h-24 w-24 shrink-0 items-end justify-center">
                <img
                  src={coachHero}
                  alt="NutriCoach flexing"
                  className="h-24 w-24 object-contain object-bottom"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.16em] text-primary dark:text-emerald-400">
                  <Sparkles className="h-4 w-4" /> AI nutrition coach
                </div>
                <h2 className="mt-1 text-2xl font-black text-foreground">Ask your coach</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Your conversation is saved and updates with every meal.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void clearChat()}
                disabled={loading || pending || clearing || messages.length === 0}
                aria-label="Clear conversation"
                className="flex shrink-0 items-center gap-1.5 self-start rounded-full border bg-white/70 px-3 py-1.5 text-xs font-bold text-foreground/70 transition-colors hover:border-rose-300 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:border-rose-500/50 dark:hover:text-rose-400"
              >
                {clearing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Clear
              </button>
            </div>

            <div
              ref={threadRef}
              aria-live="polite"
              className="mt-5 h-64 space-y-3 overflow-y-auto rounded-2xl border border-white/80 bg-white/80 dark:border-slate-800 dark:bg-slate-950/85 p-4 pr-2 shadow-inner transition-colors"
            >
              {messages.map((item, index) => (
                <div
                  key={`${item.createdAt}-${index}`}
                  className={item.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={
                      item.role === "user"
                        ? "max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm font-semibold leading-5 text-primary-foreground shadow-sm"
                        : "max-w-[88%] rounded-2xl rounded-bl-md bg-muted dark:bg-slate-800/90 dark:border dark:border-slate-700/60 dark:text-slate-100 px-4 py-2.5 text-sm font-semibold leading-5 shadow-sm"
                    }
                  >
                    {item.role === "assistant" && (
                      <div className="mb-1 text-[10px] font-extrabold uppercase tracking-wider text-primary dark:text-emerald-400 flex items-center gap-1">
                        <Sparkles className="h-3 w-3 inline" /> Coach
                      </div>
                    )}
                    {item.content}
                  </div>
                </div>
              ))}
              {(loading || pending) && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-md bg-muted dark:bg-slate-800/90 dark:border dark:border-slate-700/60 px-4 py-3 text-xs font-bold text-muted-foreground dark:text-slate-300">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-primary dark:text-emerald-400" />
                      {pending ? "Coach is working…" : "Thinking about today’s log…"}
                    </div>
                    {pending && steps.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {steps.map((step, index) => (
                          <li
                            key={`${index}-${step}`}
                            className="flex items-center gap-1.5 text-[11px] font-semibold"
                          >
                            {index === steps.length - 1 ? (
                              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary dark:text-emerald-400" />
                            ) : (
                              <Check className="h-3 w-3 shrink-0 text-primary dark:text-emerald-400" />
                            )}
                            <span>{step}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {prompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => void ask(prompt)}
                  disabled={loading || pending}
                  className="rounded-full border bg-white/70 dark:bg-slate-800/70 dark:border-slate-700 dark:text-slate-200 dark:hover:border-primary/50 dark:hover:text-primary px-3 py-1.5 text-xs font-bold text-foreground/75 transition-colors hover:border-primary/30 hover:text-primary disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void ask();
              }}
              className="mt-4 flex gap-2"
            >
              <Input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Ask your coach what to eat…"
                aria-label="Message your nutrition coach"
                className="h-11 rounded-xl bg-white dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 dark:placeholder:text-slate-500 focus-visible:dark:ring-primary"
              />
              <Button
                type="submit"
                disabled={loading || pending || !message.trim()}
                className="h-11 rounded-xl px-4 font-bold"
                aria-label="Send message"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </form>

            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-amber-400/60 bg-amber-50/70 px-3 py-2 text-xs dark:border-amber-500/40 dark:bg-amber-950/20">
              <span className="font-extrabold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                Test time
              </span>
              <label className="flex items-center gap-1 font-bold text-muted-foreground">
                Hour
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={devHour}
                  placeholder="now"
                  onChange={(event) => setDevHour(event.target.value)}
                  aria-label="Simulated hour for the coach (0-23)"
                  className="h-8 w-16 rounded-lg text-center text-xs font-bold dark:bg-slate-900 dark:border-slate-700"
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runDevTip()}
                disabled={devRunning || loading || pending}
                className="h-8 rounded-lg text-xs font-bold dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
              >
                {devRunning ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Running…
                  </>
                ) : (
                  "Run coach tip"
                )}
              </Button>
              {devHour !== "" && (
                <button
                  type="button"
                  onClick={() => setDevHour("")}
                  className="font-semibold text-muted-foreground underline-offset-2 hover:underline"
                >
                  use real clock
                </button>
              )}
              <span className="text-muted-foreground">simulates time of day (chat too)</span>
            </div>
          </div>

          <aside className="rounded-2xl border bg-white/85 dark:bg-slate-900/85 dark:border-slate-800 p-5 shadow-sm transition-colors">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-sun/20 dark:bg-sun/15 text-amber-700 dark:text-amber-400">
                <Utensils className="h-4 w-4" />
              </span>
              <div>
                <div className="text-xs font-extrabold uppercase tracking-[0.14em] text-primary dark:text-emerald-400">
                  Recommended foods
                </div>
                <p className="max-w-44 truncate text-[11px] text-muted-foreground">
                  For: “{recommendationContext}”
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {recommendations.length ? (
                recommendations.map((food) => (
                  <div
                    key={food.name}
                    className="rounded-xl border bg-background dark:bg-slate-800/60 dark:border-slate-700/60 p-3 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-extrabold leading-tight text-foreground">
                        {food.name}
                      </div>
                      <span className="shrink-0 rounded-full bg-primary/10 dark:bg-primary/20 px-2 py-0.5 text-[10px] font-bold text-primary dark:text-emerald-400">
                        {food.serving}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                      {food.reason}
                    </p>
                    {food.grams != null && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-bold text-muted-foreground">
                        <span>
                          {Math.round(food.calories ?? 0)} kcal · P {round1(food.protein)} · C{" "}
                          {round1(food.carbs)} · F {round1(food.fat)}
                        </span>
                        {sourceLabel(food.source) && (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-primary dark:bg-primary/20 dark:text-emerald-400">
                            {sourceLabel(food.source)}
                          </span>
                        )}
                      </div>
                    )}
                    {food.grams != null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openLog(food)}
                        disabled={loggedNames.includes(food.name)}
                        className="mt-2.5 h-8 w-full rounded-lg text-xs font-bold dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700 dark:text-slate-100"
                      >
                        {loggedNames.includes(food.name) ? (
                          <>
                            <Check className="mr-1.5 h-3.5 w-3.5" /> Logged
                          </>
                        ) : (
                          <>
                            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
                          </>
                        )}
                      </Button>
                    ) : (
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        className="mt-2.5 h-8 w-full rounded-lg text-xs font-bold dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700 dark:text-slate-100"
                      >
                        <Link to="/log-food">
                          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
                        </Link>
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed dark:border-slate-800 p-5 text-center text-xs text-muted-foreground">
                  Log a meal or ask your coach for ideas — its food suggestions show up here.
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>

      <Dialog
        open={logTarget !== null}
        onOpenChange={(open) => {
          if (!open && !logSaving) setLogTarget(null);
        }}
      >
        <DialogContent className="max-w-sm rounded-3xl dark:bg-slate-900 dark:border-slate-800">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg">Log {logTarget?.name}</DialogTitle>
            <DialogDescription>
              Adjust the serving — macros update from the coach’s preloaded nutrition.
            </DialogDescription>
          </DialogHeader>
          {logTarget && (
            <div className="space-y-4">
              {sourceLabel(logTarget.source) && (
                <span className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary dark:bg-primary/20 dark:text-emerald-400">
                  {sourceLabel(logTarget.source)}
                </span>
              )}
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Serving (grams)
                </span>
                <Input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={logGrams}
                  onChange={(event) => setLogGrams(event.target.value)}
                  onFocus={(event) => event.target.select()}
                  className="mt-1 h-11 rounded-xl dark:bg-slate-950 dark:border-slate-700 dark:text-slate-100"
                  aria-label="Serving size in grams"
                />
              </label>
              <div className="grid grid-cols-4 gap-2 rounded-2xl border bg-muted/40 p-3 text-center dark:border-slate-700 dark:bg-slate-800/60">
                {(
                  [
                    ["kcal", logPreview?.calories ?? 0],
                    ["Protein", round1(logPreview?.protein)],
                    ["Carbs", round1(logPreview?.carbs)],
                    ["Fat", round1(logPreview?.fat)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <div className="text-sm font-black tabular-nums text-foreground">{value}</div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {label}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 rounded-xl font-bold dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
                  onClick={() => setLogTarget(null)}
                  disabled={logSaving}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1 rounded-xl font-bold"
                  onClick={() => void confirmLog()}
                  disabled={logSaving}
                >
                  {logSaving ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Logging…
                    </>
                  ) : (
                    <>
                      <Plus className="mr-1.5 h-4 w-4" /> Log it
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
