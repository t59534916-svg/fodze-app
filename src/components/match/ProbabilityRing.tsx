"use client";
import { color } from "@/styles/tokens";

// ─── Math ────────────────────────────────────────────────────────────
//
// Three-arc SVG donut. Each arc is drawn as a path along the ring
// circumference with a stroke-dasharray controlling how much of the
// perimeter it covers. Arcs are offset so they meet at 12 o'clock
// (start) and wrap clockwise — Home (green) → Draw (gold) → Away (warn).
//
// A fixed 2° gap between arcs prevents the colors from bleeding into
// each other and gives the ring an elegant "segmented" look without
// needing multiple SVG layers.

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  // SVG arcs can't render a full 360° path — clamp to 359.9° if needed.
  const sweep = Math.min(Math.max(endDeg - startDeg, 0), 359.9);
  const start = (startDeg - 90) * Math.PI / 180; // -90 so 0° is 12 o'clock
  const end = (startDeg + sweep - 90) * Math.PI / 180;
  const sx = cx + r * Math.cos(start);
  const sy = cy + r * Math.sin(start);
  const ex = cx + r * Math.cos(end);
  const ey = cy + r * Math.sin(end);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

// ─── Component ───────────────────────────────────────────────────────

export default function ProbabilityRing({
  h, d, a,
  size = 140,
  stroke = 12,
  centerLabel,
  centerValue,
  hasValue = false,
}: {
  h: number;      // 0..1
  d: number;
  a: number;
  size?: number;
  stroke?: number;
  /** Small label under the big value (e.g. "HEIM %") */
  centerLabel?: string;
  /** Big number shown in the center; defaults to rounded favorite % */
  centerValue?: string;
  /** Adds a subtle gold glow ring — used when the match has a value bet */
  hasValue?: boolean;
}) {
  const total = h + d + a;
  if (total <= 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - stroke / 2 - 2; // inner padding so glow has room

  // Convert probabilities to degrees; normalize if they don't sum to 1
  const hDeg = (h / total) * 360;
  const dDeg = (d / total) * 360;
  const aDeg = (a / total) * 360;
  const GAP = 2; // degrees of empty space between arcs

  // Pick favorite for the center label
  const maxProb = Math.max(h, d, a);
  const favLabel = centerLabel ?? (maxProb === h ? "HEIM" : maxProb === d ? "REMIS" : "AUSW.");
  const favValue = centerValue ?? `${Math.round(maxProb * 100)}%`;
  const favColor = maxProb === h ? color.value : maxProb === a ? color.warn : color.gold;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Wahrscheinlichkeiten: Heim ${Math.round(h*100)}%, Remis ${Math.round(d*100)}%, Auswärts ${Math.round(a*100)}%`}
      style={{ display: "block" }}
    >
      <defs>
        <radialGradient id="pr-center-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={favColor} stopOpacity="0.12" />
          <stop offset="70%" stopColor={favColor} stopOpacity="0.04" />
          <stop offset="100%" stopColor={favColor} stopOpacity="0" />
        </radialGradient>
        {hasValue && (
          <filter id="pr-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>

      {/* Center fill for soft team-color wash behind the big number */}
      <circle cx={cx} cy={cy} r={r - stroke / 2 - 2} fill="url(#pr-center-glow)" />

      {/* Background ring — very faint, so gaps between arcs don't look hollow */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke={`${color.goldMid}12`}
        strokeWidth={stroke}
      />

      {/* Home arc (green) — starts at 12 o'clock */}
      {hDeg > GAP && (
        <path
          d={arcPath(cx, cy, r, GAP / 2, hDeg - GAP / 2)}
          fill="none"
          stroke={color.value}
          strokeWidth={stroke}
          strokeLinecap="round"
          filter={hasValue ? "url(#pr-glow)" : undefined}
        />
      )}
      {/* Draw arc (muted gold) */}
      {dDeg > GAP && (
        <path
          d={arcPath(cx, cy, r, hDeg + GAP / 2, hDeg + dDeg - GAP / 2)}
          fill="none"
          stroke={`${color.goldMid}95`}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      )}
      {/* Away arc (warn) */}
      {aDeg > GAP && (
        <path
          d={arcPath(cx, cy, r, hDeg + dDeg + GAP / 2, hDeg + dDeg + aDeg - GAP / 2)}
          fill="none"
          stroke={color.warn}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      )}

      {/* Center text */}
      <text
        x={cx} y={cy - 2}
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontSize: size * 0.24,
          fontWeight: 700,
          fill: favColor,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.02em",
        }}
      >
        {favValue}
      </text>
      <text
        x={cx} y={cy + size * 0.15}
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontSize: size * 0.08,
          fontWeight: 600,
          fill: `${color.goldMid}80`,
          letterSpacing: "0.15em",
        }}
      >
        {favLabel}
      </text>
    </svg>
  );
}
