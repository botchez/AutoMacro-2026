import { useEffect, useState } from "react";
import { Mascot } from "./Mascot";
import { X, MessageCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

export function FloatingCoach() {
  const [open, setOpen] = useState(true);
  const [tip, setTip] = useState("Checking today’s progress…");
  const [loading, setLoading] = useState(false);

  const getTip = async () => {
    setLoading(true);
    try {
      const response = await api.coachTip();
      setTip(response.message);
    } catch {
      setTip("Log your next meal and I’ll help you balance the rest of the day.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void getTip();
    const id = window.setInterval(getTip, 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-end gap-2 pointer-events-none">
      {open && (
        <div className="pointer-events-auto max-w-[280px] rounded-2xl bg-white shadow-xl border border-primary/20 p-3 pr-8 text-sm font-semibold animate-pop relative">
          <div className="text-[10px] uppercase tracking-wider text-primary font-bold mb-0.5">
            Coach
          </div>
          {tip}
          <button
            onClick={() => setOpen(false)}
            aria-label="Dismiss coach"
            className="absolute top-1.5 right-1.5 rounded-full p-1 hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="absolute -bottom-1.5 right-6 h-3 w-3 rotate-45 bg-white border-r border-b border-primary/20" />
        </div>
      )}
      <button
        onClick={() => (open ? void getTip() : setOpen(true))}
        aria-label={open ? "Get another coach tip" : "Open coach"}
        className={cn(
          "pointer-events-auto relative grid place-items-center h-16 w-16 rounded-full bg-white shadow-xl border border-primary/20 bounce-tap hover:scale-105 transition-transform",
        )}
      >
        {loading ? (
          <RefreshCw className="h-6 w-6 animate-spin text-primary" />
        ) : (
          <Mascot size={54} className="animate-float" />
        )}
        {!open && (
          <span className="absolute -top-1 -right-1 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
            <MessageCircle className="h-3 w-3" />
          </span>
        )}
      </button>
    </div>
  );
}
