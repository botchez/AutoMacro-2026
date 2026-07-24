import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, FlaskConical, Loader2, Plus, Send, Sparkles, Utensils } from "lucide-react";
import coachHero from "@/assets/bicepsflex.png";
import { api, type CoachMessage, type CoachRecommendation } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const prompts = ["What should I eat next?", "How is my protein?", "Help me balance dinner"];

export function CoachPanel() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [recommendations, setRecommendations] = useState<CoachRecommendation[]>([]);
  const [recommendationContext, setRecommendationContext] = useState("today’s macro gaps");
  const [loading, setLoading] = useState(true);
  const [testStatus, setTestStatus] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const threadRef = useRef<HTMLDivElement>(null);

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

  const ask = async (question = message, isTest = false) => {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    if (isTest) setTestStatus("running");
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
      setRecommendations(
        Array.isArray(response.recommendations)
          ? response.recommendations
          : fallbackRecommendations(trimmed),
      );
      setRecommendationContext(trimmed);
      if (isTest) setTestStatus("passed");
    } catch {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: "I couldn’t refresh that answer. Try again after your next meal.",
          createdAt: new Date().toISOString(),
        },
      ]);
      if (isTest) setTestStatus("failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-primary/20 bg-gradient-to-br from-primary/15 via-white to-sun/15 p-5 shadow-lg shadow-primary/5 md:p-7">
      <div
        aria-hidden="true"
        className="absolute -right-16 -top-16 h-52 w-52 rounded-full bg-sky/20 blur-3xl"
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
              <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.16em] text-primary">
                <Sparkles className="h-4 w-4" /> AI nutrition coach
              </div>
              <h2 className="mt-1 text-2xl font-black">Ask your coach</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Your conversation is saved and updates with every meal.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() =>
                void ask(
                  "This is a coach connection test. Give me one short food recommendation based on today’s log.",
                  true,
                )
              }
              className="shrink-0 rounded-full bg-white px-3 font-bold"
            >
              {testStatus === "running" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : testStatus === "passed" ? (
                <CheckCircle2 className="mr-2 h-4 w-4 text-primary" />
              ) : (
                <FlaskConical className="mr-2 h-4 w-4" />
              )}
              <span className="hidden md:inline">
                {testStatus === "passed"
                  ? "Coach working"
                  : testStatus === "failed"
                    ? "Test again"
                    : "Test coach"}
              </span>
              <span className="md:hidden">Test</span>
            </Button>
          </div>

          <div
            ref={threadRef}
            aria-live="polite"
            className="mt-5 h-64 space-y-3 overflow-y-auto rounded-2xl border border-white bg-white/80 p-4 pr-2 shadow-sm"
          >
            {messages.map((item, index) => (
              <div
                key={`${item.createdAt}-${index}`}
                className={item.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={
                    item.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm font-semibold leading-5 text-primary-foreground"
                      : "max-w-[88%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm font-semibold leading-5"
                  }
                >
                  {item.role === "assistant" && (
                    <div className="mb-1 text-[10px] font-extrabold uppercase tracking-wider text-primary">
                      Coach
                    </div>
                  )}
                  {item.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-4 py-3 text-xs font-bold text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" /> Thinking about today’s
                  log…
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
                className="rounded-full border bg-white/70 px-3 py-1.5 text-xs font-bold text-foreground/75 transition-colors hover:border-primary/30 hover:text-primary disabled:opacity-50"
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
              className="h-11 rounded-xl bg-white"
            />
            <Button
              type="submit"
              disabled={loading || !message.trim()}
              className="h-11 rounded-xl px-4"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>

        <aside className="rounded-2xl border bg-white/85 p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-sun/20 text-amber-700">
              <Utensils className="h-4 w-4" />
            </span>
            <div>
              <div className="text-xs font-extrabold uppercase tracking-[0.14em] text-primary">
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
                <div key={food.name} className="rounded-xl border bg-background p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-extrabold leading-tight">{food.name}</div>
                    <span className="shrink-0 rounded-full bg-primary/8 px-2 py-0.5 text-[10px] font-bold text-primary">
                      {food.serving}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                    {food.reason}
                  </p>
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed p-5 text-center text-xs text-muted-foreground">
                Ask your coach to get food ideas for today.
              </div>
            )}
          </div>

          <Button asChild variant="outline" className="mt-4 w-full rounded-xl font-bold">
            <Link to="/log-food">
              <Plus className="mr-2 h-4 w-4" /> Log a recommended food
            </Link>
          </Button>
        </aside>
      </div>
    </section>
  );
}

function fallbackRecommendations(question: string): CoachRecommendation[] {
  const query = question.toLowerCase();
  const foods = query.includes("protein")
    ? [
        ["Greek yogurt", "A quick protein-focused option", "200 g"],
        ["Grilled chicken breast", "Lean protein for a main meal", "150 g"],
        ["Salmon fillet", "Protein with omega-3 fats", "150 g"],
      ]
    : query.includes("dinner")
      ? [
          ["Salmon fillet", "A balanced dinner protein", "150 g"],
          ["Sweet potato", "Fiber-rich dinner carbohydrates", "1 medium"],
          ["Steamed broccoli", "A light vegetable side", "1½ cups"],
        ]
      : query.includes("snack")
        ? [
            ["Greek yogurt", "A convenient protein snack", "200 g"],
            ["Banana", "Quick portable energy", "1 medium"],
            ["Almonds", "Healthy fats in a measured portion", "30 g"],
          ]
        : [
            ["Brown rice", "Steady carbohydrates for energy", "1 cup cooked"],
            ["Greek yogurt", "An easy protein addition", "200 g"],
            ["Avocado", "Unsaturated fats for balance", "½ avocado"],
          ];

  return foods.map(([name, reason, serving]) => ({ name, reason, serving }));
}
