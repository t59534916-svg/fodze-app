"use client";
import { useMemo } from "react";
import { useApp } from "@/contexts/AppContext";
import { computeCalibration } from "@/lib/bet-metrics";
import { color, fontSize, fontWeight, fontFamily, radius, space } from "@/styles/tokens";
import { card, text } from "@/styles/components";

// ─── Live AI Calibration ─────────────────────────────────────────────
//
// Renders live calibration from settled bets with `model_prob`:
// "When the model said 60%, how often did it really happen?"
//
// Computation lives in src/lib/bet-metrics.ts (shared with LivePerformance).

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
    color: color.goldShine,
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

// SVG constants for the bucket chart
const W = 320;
const H = 220;
const P = 32;

export default function LiveCalibration() {
  const { userBets } = useApp();

  const analysis = useMemo(() => computeCalibration(userBets), [userBets]);

  if (!analysis) {
    return (
      <div style={S.card}>
        <div style={S.label}>KI-Vorhersage Genauigkeit</div>
        <div style={S.empty}>
          Sobald du Wetten mit gespeicherten Modell-Wahrscheinlichkeiten
          abrechnest, erscheint hier die Live-Kalibrierung der FODZE Engines
          (Standard & @annafrick13).
        </div>
      </div>
    );
  }

  const { buckets, n, brier, logLoss, calError } = analysis;

  // ─── Build the calibration SVG ─────────────────────────────────────
  const toX = (pct: number) => P + (pct / 100) * (W - 2 * P);
  const toY = (pct: number) => H - P - (pct / 100) * (H - 2 * P);
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div style={S.card}>
      <div style={S.label}>KI-Vorhersage Genauigkeit (Live)</div>
      <div style={S.subtitle}>
        Wie gut treffen die tatsächlichen Ergebnisse die Modell-Wahrscheinlichkeiten
        deiner abgerechneten Wetten? Basis: {n} Wetten mit gespeichertem Modell-Prob.
      </div>

      <div style={S.statsRow}>
        <div style={S.stat}>
          <div style={S.statVal}>{brier.toFixed(4)}</div>
          <div style={S.statLabel}>Brier Score</div>
          <div style={S.statSub}>
            {brier < 0.2 ? "Exzellent" : brier < 0.25 ? "Gut" : "Verbesserbar"}
          </div>
        </div>
        <div style={S.stat}>
          <div style={S.statVal}>{logLoss.toFixed(4)}</div>
          <div style={S.statLabel}>Log Loss</div>
          <div style={S.statSub}>Niedriger = besser</div>
        </div>
        <div style={S.stat}>
          <div
            style={{
              ...S.statVal,
              color: calError < 0.05 ? color.value : color.gold,
            }}
          >
            {(calError * 100).toFixed(1)}%
          </div>
          <div style={S.statLabel}>Cal. Error</div>
          <div style={S.statSub}>|Vorhersage − Realität|</div>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 480 }}>
        {/* Grid */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={`gy${v}`}>
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
              {v}%
            </text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={`gx${v}`}>
            <line
              x1={toX(v)}
              y1={P}
              x2={toX(v)}
              y2={H - P}
              stroke={`${color.gold}10`}
              strokeWidth={0.5}
            />
            <text
              x={toX(v)}
              y={H - P + 12}
              textAnchor="middle"
              fontSize={7}
              fill={`${color.gold}50`}
            >
              {v}%
            </text>
          </g>
        ))}

        {/* Perfect calibration diagonal */}
        <line
          x1={toX(0)}
          y1={toY(0)}
          x2={toX(100)}
          y2={toY(100)}
          stroke={`${color.gold}30`}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <text
          x={toX(100) - 4}
          y={toY(100) - 4}
          textAnchor="end"
          fontSize={7}
          fill={`${color.gold}50`}
        >
          perfekt
        </text>

        {/* Bucket points: x = predicted prob, y = actual win rate, radius = sample count */}
        {buckets.map((b, i) => {
          if (b.count === 0) return null;
          const predPct = (b.predSum / b.count) * 100;
          const actualPct = (b.won / b.count) * 100;
          const r = 3 + (b.count / maxCount) * 9; // 3-12 px
          return (
            <g key={`b${i}`}>
              <circle
                cx={toX(predPct)}
                cy={toY(actualPct)}
                r={r}
                fill={color.gold}
                fillOpacity={0.25}
                stroke={color.gold}
                strokeWidth={1.5}
              />
              <text
                x={toX(predPct)}
                y={toY(actualPct) - r - 3}
                textAnchor="middle"
                fontSize={7}
                fill={color.gold}
              >
                n={b.count}
              </text>
            </g>
          );
        })}

        {/* Axis labels */}
        <text
          x={W / 2}
          y={H - 4}
          textAnchor="middle"
          fontSize={8}
          fill={color.textMuted}
        >
          Modell-Vorhersage
        </text>
        <text
          x={8}
          y={H / 2}
          textAnchor="middle"
          fontSize={8}
          fill={color.textMuted}
          transform={`rotate(-90, 8, ${H / 2})`}
        >
          Tatsächliche Trefferquote
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
        Jeder Kreis = ein 10%-Bucket (z.B. alle Wetten mit Modell-Prob 40–50%).
        Kreis-Größe ∝ Anzahl Wetten. Liegt ein Bucket auf der Diagonale, stimmt
        die Vorhersage mit der Realität überein. Oberhalb = Modell unterschätzt,
        unterhalb = Modell überschätzt.
      </div>
    </div>
  );
}
