"use client";
import { useMemo } from "react";
import { useApp } from "@/contexts/AppContext";
import { computeClvStats, isSettled } from "@/lib/bet-metrics";
import { color, fontSize, fontWeight, fontFamily, radius, space } from "@/styles/tokens";
import { card, text } from "@/styles/components";
import type { PlacedBet } from "@/types/match";

// ─── Live CLV Trend Chart ────────────────────────────────────────────
//
// CLV (Closing Line Value) in % per settled bet — chronological X, line chart
// for per-bet CLV plus a moving average that smooths the noise. Positive
// CLV over time is the single least-noisy indicator that the model genuinely
// beats the market; win-rate alone is dominated by variance.
//
// Mirrors the SVG layout from LiveCalibration.tsx for visual consistency.

const S = {
  card: { ...card(), marginBottom: space[4] } as React.CSSProperties,
  label: { ...text.label, marginBottom: space[3] } as React.CSSProperties,
  subtitle: {
    fontSize: fontSize.xs,
    color: color.textMuted,
    marginBottom: space[4],
    lineHeight: 1.5,
  } as React.CSSProperties,
  statsRow: {
    display: "flex",
    gap: space[3],
    flexWrap: "wrap" as const,
    marginBottom: space[4],
  } as React.CSSProperties,
  stat: {
    flex: "1 1 110px",
    minWidth: 110,
    textAlign: "center" as const,
    padding: space[3],
    background: `${color.gold}08`,
    borderRadius: radius.sm,
    border: `1px solid ${color.border}`,
  } as React.CSSProperties,
  statVal: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    fontFamily: fontFamily.serif,
    lineHeight: 1,
  } as React.CSSProperties,
  statLabel: {
    fontSize: fontSize.xs,
    color: color.textMuted,
    marginTop: space[2],
  } as React.CSSProperties,
  statSub: {
    fontSize: 10,
    color: color.textFaint,
    marginTop: 2,
  } as React.CSSProperties,
  empty: {
    textAlign: "center" as const,
    padding: `${space[5]}px ${space[4]}px`,
    color: color.textMuted,
    fontSize: fontSize.sm,
  } as React.CSSProperties,
};

// SVG constants
const W = 320;
const H = 200;
const P = 32;
const MIN_BETS_FOR_TREND = 5;
const WINDOW = 10; // moving-average window

export default function ClvChart() {
  const { userBets } = useApp();

  const { points, stats, yMin, yMax } = useMemo(() => {
    // Keep settled bets with valid clv, sorted by settlement time
    // (falls back to placed_at when settled_at is missing).
    const rows = userBets
      .filter(
        (b): b is PlacedBet & { clv: number } =>
          isSettled(b) &&
          typeof b.clv === "number" &&
          Number.isFinite(b.clv),
      )
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.settled_at || a.placed_at || 0).getTime();
        const tb = new Date(b.settled_at || b.placed_at || 0).getTime();
        return ta - tb;
      });

    const stats = computeClvStats(userBets);

    if (rows.length === 0) return { points: [], stats, yMin: -5, yMax: 5 };

    // Cumulative CLV (running sum) and trailing moving average
    let cum = 0;
    const points = rows.map((b, i) => {
      cum += b.clv;
      const start = Math.max(0, i - WINDOW + 1);
      let wSum = 0;
      for (let k = start; k <= i; k++) wSum += rows[k].clv;
      const ma = wSum / (i - start + 1);
      return { i, clv: b.clv, cum, ma };
    });

    // Y-axis bounds around the moving-average range with some padding —
    // cumulative can run away, so we plot MA as the primary trend signal.
    const mas = points.map((p) => p.ma);
    const lo = Math.min(...mas, 0);
    const hi = Math.max(...mas, 0);
    const pad = Math.max(1, (hi - lo) * 0.2);
    return { points, stats, yMin: lo - pad, yMax: hi + pad };
  }, [userBets]);

  // Empty-state: either zero bets with CLV, or too few for a meaningful trend.
  if (!stats || points.length < MIN_BETS_FOR_TREND) {
    return (
      <div style={S.card}>
        <div style={S.label}>CLV Trend (Live)</div>
        <div style={S.empty}>
          {stats
            ? `Erst ${MIN_BETS_FOR_TREND}+ abgerechnete Wetten mit Closing-Quote für einen Trend nötig (${stats.count} bisher).`
            : "Sobald abgerechnete Wetten Closing-Quoten bekommen (Cron läuft ca. 30min vor Anpfiff), erscheint hier der CLV-Verlauf."}
        </div>
      </div>
    );
  }

  const n = points.length;
  const toX = (i: number) => P + (i / Math.max(1, n - 1)) * (W - 2 * P);
  const toY = (v: number) =>
    H - P - ((v - yMin) / Math.max(0.001, yMax - yMin)) * (H - 2 * P);

  // Build polyline strings
  const maPath = points.map((p) => `${toX(p.i)},${toY(p.ma)}`).join(" ");
  const zeroY = toY(0);

  const avg = stats.avgClv;
  const avgColor = avg > 0 ? color.value : avg < 0 ? color.warn : color.gold;
  const posRate = stats.positiveRate * 100;

  return (
    <div style={S.card}>
      <div style={S.label}>CLV Trend (Live)</div>
      <div style={S.subtitle}>
        Closing Line Value je abgerechneter Wette. Positiv = du hast die
        Closing-Quote geschlagen ⇒ echter Edge-Indikator (win-rate allein
        ist von Varianz dominiert).
      </div>

      <div style={S.statsRow}>
        <div style={S.stat}>
          <div style={{ ...S.statVal, color: avgColor }}>
            {avg >= 0 ? "+" : ""}
            {avg.toFixed(2)}%
          </div>
          <div style={S.statLabel}>Ø CLV</div>
          <div style={S.statSub}>
            {avg > 0.5 ? "Stark positiv" : avg > 0 ? "Positiv" : avg < -0.5 ? "Stark negativ" : "Negativ"}
          </div>
        </div>
        <div style={S.stat}>
          <div style={{ ...S.statVal, color: color.goldShine }}>
            {posRate.toFixed(0)}%
          </div>
          <div style={S.statLabel}>Positive Rate</div>
          <div style={S.statSub}>&gt; 0% CLV</div>
        </div>
        <div style={S.stat}>
          <div style={{ ...S.statVal, color: color.goldShine }}>
            {stats.count}
          </div>
          <div style={S.statLabel}>Wetten</div>
          <div style={S.statSub}>mit Closing-Quote</div>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 480 }}>
        {/* Horizontal grid */}
        {[yMin, (yMin + yMax) / 2, yMax].map((v, i) => (
          <g key={`gy${i}`}>
            <line
              x1={P}
              y1={toY(v)}
              x2={W - P}
              y2={toY(v)}
              stroke={`${color.gold}10`}
              strokeWidth={0.5}
            />
            <text
              x={P - 4}
              y={toY(v) + 3}
              textAnchor="end"
              fontSize={7}
              fill={`${color.gold}50`}
            >
              {v.toFixed(1)}%
            </text>
          </g>
        ))}

        {/* Zero baseline — break-even CLV */}
        {zeroY >= P && zeroY <= H - P && (
          <line
            x1={P}
            y1={zeroY}
            x2={W - P}
            y2={zeroY}
            stroke={`${color.gold}30`}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}

        {/* Per-bet CLV dots (raw signal) */}
        {points.map((p) => (
          <circle
            key={`d${p.i}`}
            cx={toX(p.i)}
            cy={toY(p.clv)}
            r={1.8}
            fill={p.clv >= 0 ? color.value : color.warn}
            fillOpacity={0.55}
          />
        ))}

        {/* Moving-average line (trend signal) */}
        <polyline
          fill="none"
          stroke={color.goldShine}
          strokeWidth={1.6}
          strokeLinejoin="round"
          points={maPath}
        />

        {/* Axis labels */}
        <text
          x={W / 2}
          y={H - 4}
          textAnchor="middle"
          fontSize={8}
          fill={color.textMuted}
        >
          Wett-Nr. chronologisch ({n} Wetten)
        </text>
        <text
          x={8}
          y={H / 2}
          textAnchor="middle"
          fontSize={8}
          fill={color.textMuted}
          transform={`rotate(-90, 8, ${H / 2})`}
        >
          CLV in %
        </text>
      </svg>

      <div
        style={{
          fontSize: fontSize.xs,
          color: color.textFaint,
          marginTop: space[3],
          lineHeight: 1.5,
        }}
      >
        Punkte = einzelne Wetten. Goldene Linie = gleitender Mittelwert über {WINDOW} Wetten.
        Bleibt die Linie dauerhaft über der gepunkteten 0-Linie, schlägt dein Einstieg
        die Schluss-Quote im Schnitt — das robusteste Signal für echten Edge.
      </div>
    </div>
  );
}
