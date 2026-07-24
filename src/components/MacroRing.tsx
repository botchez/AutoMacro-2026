import { Check } from "lucide-react";

type Props = {
  label: string;
  value: number;
  goal: number;
  color: string; // css color
  unit?: string;
  size?: number;
};

export function MacroRing({ label, value, goal, color, unit = "g", size = 120 }: Props) {
  const pct = Math.max(0, Math.min(1, goal > 0 ? value / goal : 0));
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const dash = c * pct;
  const hit = pct >= 0.95 && pct <= 1.1;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="color-mix(in oklab, currentColor 12%, transparent)"
            strokeWidth={10}
            fill="none"
            className="text-foreground"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={10}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${dash} ${c - dash}`}
            style={{ transition: "stroke-dasharray 600ms ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-2xl font-extrabold">{Math.round(value)}</div>
          <div className="text-[11px] text-muted-foreground">
            / {Math.round(goal)}
            {unit}
          </div>
        </div>
        {hit && (
          <div
            className="absolute -top-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow animate-pop"
            aria-label="Target reached"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
        )}
      </div>
      <div className="text-sm font-semibold" style={{ color }}>
        {label}
      </div>
    </div>
  );
}
