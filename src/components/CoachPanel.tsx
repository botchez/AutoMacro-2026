import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, Plus, Send, Sparkles, Utensils } from "lucide-react";
import coachHero from "@/assets/bicepsflex.png";
import { api, type CoachMessage, type CoachRecommendation } from "@/lib/api";
import { useApp } from "@/lib/store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const prompts = ["What should I eat next?", "How is my protein?", "Help me balance dinner"];

export function CoachPanel() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [recommendations, setRecommendations] = useState<CoachRecommendation[]>([]);
  const [recommendationContext, setRecommendationContext] = useState("today’s macro gaps");
  const [loading, setLoading] = useState(true);
  const threadRef = useRef<HTMLDivElement>(null);
  const { mealsLogged } = useApp();

  useEffect(() => {
    const loadConversation = async () => {
      setLoading(true);
      try {
        const history = await api.coachHistory();
        const savedMessages = Array.isArray(history.messages) ? history.messages : [];
        setRecommendations(Array.isArray(history.recommendations) ? history.recommendations : []);
        if (savedMessages.length) {
          setMessages(savedMessages);
          const latestQuestion = [...savedMessages]
            .reverse()
            .find((item) => item.role === "user")?.content;
          if (latestQuestion) setRecommendationContext(latestQuestion);
        } else {
          const tip = await api.coachTip();
          setMessages([
            {
              role: "assistant",
              content: tip.message,
              createdAt: new Date().toISOString(),
            },
          ]);
          setRecommendations(Array.isArray(tip.recommendations) ? tip.recommendations : []);
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
  }, [messages, loading]);

  const ask = async (question = message) => {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    setMessage("");
    setMessages((current) => [
      ...current,
      { role: "user", content: trimmed, createdAt: new Date().toISOString() },
    ]);
    setLoading(true);
    try {
      const response = await api.coachMessage(trimmed);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: response.message,
          createdAt: new Date().toISOString(),
        },
      ]);
      // Sidebar is agent-driven: show the coach's suggestions for this answer, or
      // keep the previous ones when it didn't name any (the backend returns the
      // stored set unchanged in that case).
      if (Array.isArray(response.recommendations)) setRecommendations(response.recommendations);
      setRecommendationContext(trimmed);
    } catch (error) {
      // Surface the real failure instead of a soothing non-answer — the coach fails
      // loud now, so show why (e.g. the 502 detail from the agent) for diagnosis.
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            error instanceof Error
              ? `⚠️ Coach unavailable: ${error.message}`
              : "⚠️ Coach unavailable.",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Run the automatic batch endpoint after a meal is logged. It coaches the
  // just-logged batch without injecting a fake user turn into the chat thread.
  const runBatchCheck = async () => {
    if (loading) return;
    // Clear the thread immediately so the reset is visible even when the fresh tip
    // repeats the previous message's text; the server clears its copy too (below).
    setMessages([]);
    setLoading(true);
    try {
      const tip = await api.coachTip();
      // A new batch resets the conversation (the server clears it too), so replace the
      // thread with only this batch's coaching rather than appending to it.
      setMessages([
        { role: "assistant", content: tip.message, createdAt: new Date().toISOString() },
      ]);
      // A new batch fully resets the sidebar: show the coach's picks for this batch,
      // or clear it when the batch is on track and the coach suggested nothing.
      setRecommendations(Array.isArray(tip.recommendations) ? tip.recommendations : []);
      setRecommendationContext("your latest logged meal");
    } catch {
      // The normal chat error state remains available if the user asks a question.
    } finally {
      setLoading(false);
    }
  };

  // Keep the latest runBatchCheck in a ref so the meal-log effect can call it without
  // re-firing on every render (the function is recreated each render).
  const runBatchCheckRef = useRef(runBatchCheck);
  runBatchCheckRef.current = runBatchCheck;

  // Auto-ping the coach whenever a new batch of food is logged. Initialised to the
  // current count so it never fires on mount — only on genuine in-session increments.
  const seenMealsRef = useRef(mealsLogged);
  useEffect(() => {
    if (mealsLogged === seenMealsRef.current) return;
    seenMealsRef.current = mealsLogged;
    void runBatchCheckRef.current();
  }, [mealsLogged]);

  return (
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
            {loading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted dark:bg-slate-800/90 dark:border dark:border-slate-700/60 px-4 py-3 text-xs font-bold text-muted-foreground dark:text-slate-300">
                  <Loader2 className="h-4 w-4 animate-spin text-primary dark:text-emerald-400" />{" "}
                  Thinking about today’s log…
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {prompts.map((prompt) => (
              <button
                key={prompt}
                onClick={() => void ask(prompt)}
                disabled={loading}
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
              disabled={loading || !message.trim()}
              className="h-11 rounded-xl px-4 font-bold"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
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
  );
}
