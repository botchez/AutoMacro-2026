export function Mascot({ size = 96, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={className} aria-hidden="true">
      {/* leaf body */}
      <defs>
        <radialGradient id="mbody" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="oklch(0.9 0.18 145)" />
          <stop offset="100%" stopColor="oklch(0.65 0.2 145)" />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="66" rx="44" ry="42" fill="url(#mbody)" />
      {/* leaf tip */}
      <path d="M60 6 C74 18 78 30 70 40 C62 34 58 22 60 6Z" fill="oklch(0.78 0.19 145)" />
      {/* cheeks */}
      <circle cx="38" cy="76" r="7" fill="oklch(0.85 0.18 25 / 0.7)" />
      <circle cx="82" cy="76" r="7" fill="oklch(0.85 0.18 25 / 0.7)" />
      {/* eyes */}
      <circle cx="47" cy="62" r="6" fill="white" />
      <circle cx="73" cy="62" r="6" fill="white" />
      <circle cx="48" cy="63" r="3" fill="#1b1b2c" />
      <circle cx="74" cy="63" r="3" fill="#1b1b2c" />
      <circle cx="49" cy="62" r="1" fill="white" />
      <circle cx="75" cy="62" r="1" fill="white" />
      {/* smile */}
      <path
        d="M50 82 Q60 92 70 82"
        stroke="#1b1b2c"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
