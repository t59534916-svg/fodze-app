"use client";
import { useEffect, useState } from "react";
import { color, fontSize, fontWeight, fontFamily, space, radius } from "@/styles/tokens";

// ═══════════════════════════════════════════════════════════════════════
// EngineLoader — cool wait-animation for the Dixon-Coles / Ensemble engine.
//
// Visual: a 15×15 grid matching the actual Dixon-Coles score matrix the
// engine is building. Each cell pulses gold with a diagonal-wave delay so
// the whole grid feels "alive" — like watching probability mass propagate.
// Cells near (1,1) are brightest because that's where the Poisson density
// peaks for a typical λ≈1.3 match.
//
// Copy rotates every 2.5s with phase-aware technical lingo ("Bayesian
// Shrinkage…", "Shin-Vig-Removal…") so the user can see FODZE is actually
// working on meaningful math, not just spinning.
//
// Pure CSS keyframes (no rAF, no JS timers in the animation loop) —
// hardware-accelerated, near-zero CPU cost even during the compute phase.
// ═══════════════════════════════════════════════════════════════════════

const GRID_SIZE = 15;
const CELL = 10;      // px per cell
const GAP = 2;        // px gap between cells

// Technical lingo that rotates — splits data vs. compute so the label
// reflects what's genuinely happening. Copy drawn from actual engine
// steps in src/lib/{dixon-coles, ensemble, calibration, poisson-ml-engine*}.
const DATA_TICKS = [
  "Lade xG-Historien aus Supabase…",
  "Synchronisiere Elo-Ratings (655 Teams)…",
  "Fetche Live-Sharp-Quoten von Pinnacle…",
  "Team-Form aus letzten 5 Matches…",
  "Absences + Verletzungen parsen…",
  "Strength of Schedule berechnet…",
  "Matchday-Kontext sync…",
  "Home-Faktoren pro Liga laden…",
];

const COMPUTE_TICKS = [
  "15 × 15 Dixon-Coles Matrix wird aufgebaut…",
  "λ_home wird kalibriert (EWMA α=0.85)…",
  "λ_away wird kalibriert…",
  "Bayesian Shrinkage glättet xG-Rauschen…",
  "Elo-Ensemble blendiert (w_dc + w_elo + w_log)…",
  "Dixon-Coles ρ-Korrektur auf niedrigen Scores…",
  "Shin-Vig-Removal auf Pinnacle-Sharps…",
  "Isotonische Kalibrierung pro Liga…",
  "Goldilocks Edge-Zone filtert 2.5–7.5%…",
  "Kelly-Fraktionen für Bankroll-Staking…",
  "Markov-Chain für HT/FT-Zustände…",
  "Asian Handicap-Linien aus Matrix…",
];

type Phase = "idle" | "data" | "compute" | "done";

interface EngineLoaderProps {
  phase: Phase;
  leaguesDone: number;
  totalLeagues: number;
  inFlight?: string[];
  failed?: string[];
  /** Override for a custom title; default is phase-dependent. */
  title?: string;
}

export default function EngineLoader({
  phase,
  leaguesDone,
  totalLeagues,
  inFlight = [],
  failed = [],
  title,
}: EngineLoaderProps) {
  const [tickIdx, setTickIdx] = useState(0);

  // Cycle through phase-appropriate tech-lingo every 2.5s.
  // The array changes with phase, so the index naturally refers to the
  // right list at render time.
  useEffect(() => {
    const iv = setInterval(() => setTickIdx((i) => i + 1), 2500);
    return () => clearInterval(iv);
  }, []);

  const ticks = phase === "compute" ? COMPUTE_TICKS : DATA_TICKS;
  const subtitle = ticks[tickIdx % ticks.length];

  const titleText =
    title ??
    (phase === "compute"
      ? "Ensemble konvergiert"
      : phase === "done"
      ? "Fertig"
      : "Engine lädt");

  const progressPct =
    phase === "compute"
      ? 100
      : totalLeagues > 0
      ? (leaguesDone / totalLeagues) * 100
      : 0;

  return (
    <div style={styles.container}>
      {/* Scoped keyframes — no global CSS pollution. */}
      <style>{keyframes}</style>

      <DixonMatrixAnimation />

      <div style={styles.title}>{titleText}</div>
      <div style={styles.subtitle}>{subtitle}</div>

      {/* Progress bar */}
      <div style={styles.barOuter}>
        <div style={{ ...styles.barInner, width: `${progressPct}%` }} />
        {/* Subtle shimmer that sweeps across the filled portion */}
        <div style={styles.barShimmer} />
      </div>

      <div style={styles.count}>
        {phase === "compute"
          ? "Letzter Schritt — Matrizen werden gebaut"
          : `${leaguesDone} von ${totalLeagues} Ligen bereit`}
      </div>

      {phase === "data" && inFlight.length > 0 && (
        <div style={styles.inFlight}>
          Läuft noch: {inFlight.join(" · ")}
        </div>
      )}
      {failed.length > 0 && (
        <div style={styles.failed}>
          Übersprungen: {failed.join(" · ")}
        </div>
      )}
    </div>
  );
}

// ─── Dixon-Coles Matrix Animation ───────────────────────────────────

function DixonMatrixAnimation() {
  // Build 225 cells (15 × 15). Each gets a delay proportional to its
  // diagonal distance from the top-left so the wave travels from (0,0)
  // toward (14,14). Base intensity peaks at (1,1) where typical match
  // outcome probability is highest — that's the Poisson mode for λ≈1.3.
  const cells = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      // Poisson-like intensity peak: brightest near 1:1, 2:1, 1:2 scores
      const dxH = i - 1.3;
      const dxA = j - 1.1;
      const intensity = Math.exp(-0.35 * (dxH * dxH + dxA * dxA));
      const baseOpacity = 0.18 + intensity * 0.55;
      // Wave delay: diagonal traversal + slight per-cell jitter so it
      // doesn't look like a rigid sweep.
      const delay = (i + j) * 0.08 + (i * 0.013 - j * 0.009);
      const duration = 2.6 + intensity * 0.3;
      cells.push({
        key: `${i}-${j}`,
        style: {
          width: CELL,
          height: CELL,
          borderRadius: 1.5,
          background: `rgba(212, 184, 106, ${baseOpacity.toFixed(2)})`,
          boxShadow: intensity > 0.7 ? "0 0 4px rgba(212, 184, 106, 0.6)" : "none",
          animation: `dixonPulse ${duration.toFixed(2)}s ease-in-out infinite`,
          animationDelay: `-${delay.toFixed(2)}s`,
        } as React.CSSProperties,
      });
    }
  }

  return (
    <div style={styles.matrix}>
      {cells.map((c) => (
        <div key={c.key} style={c.style} />
      ))}
    </div>
  );
}

// ─── Keyframes ──────────────────────────────────────────────────────

const keyframes = `
  @keyframes dixonPulse {
    0%, 100% {
      opacity: 0.35;
      transform: scale(0.94);
      filter: brightness(0.9);
    }
    50% {
      opacity: 1;
      transform: scale(1.12);
      filter: brightness(1.3);
    }
  }
  @keyframes engineShimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  @keyframes engineTick {
    0% { opacity: 0; transform: translateY(4px); }
    15%, 85% { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-4px); }
  }
`;

// ─── Styles ─────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    textAlign: "center",
    padding: `${space[5]}px ${space[4]}px`,
    color: color.textMuted,
    userSelect: "none",
  },
  matrix: {
    display: "grid",
    gridTemplateColumns: `repeat(${GRID_SIZE}, ${CELL}px)`,
    gap: GAP,
    width: GRID_SIZE * CELL + (GRID_SIZE - 1) * GAP,
    margin: "0 auto",
    marginBottom: space[5],
    padding: space[3],
    background:
      "radial-gradient(ellipse at center, rgba(212, 184, 106, 0.05), transparent 70%)",
    borderRadius: radius.md,
  },
  title: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    fontFamily: fontFamily.serif,
    color: color.gold,
    letterSpacing: "0.03em",
    marginBottom: space[2],
  },
  subtitle: {
    fontSize: fontSize.xs,
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    marginBottom: space[4],
    minHeight: 16, // prevent layout shift on text change
    // Each new tick fades in smoothly thanks to animation-key reset via text
    animation: "engineTick 2.5s ease-in-out infinite",
  },
  barOuter: {
    position: "relative",
    maxWidth: 300,
    height: 6,
    margin: "0 auto",
    background: color.leather3,
    borderRadius: 3,
    overflow: "hidden",
    border: `1px solid ${color.border}`,
  },
  barInner: {
    height: "100%",
    background: `linear-gradient(90deg, ${color.goldDark}, ${color.gold}, ${color.goldLight}, ${color.goldShine})`,
    transition: "width 0.4s ease",
  },
  barShimmer: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "40%",
    height: "100%",
    background:
      "linear-gradient(90deg, transparent, rgba(255, 235, 180, 0.6), transparent)",
    animation: "engineShimmer 2.2s ease-in-out infinite",
    pointerEvents: "none",
  },
  count: {
    fontSize: fontSize.xs,
    color: color.textFaint,
    marginTop: space[3],
  },
  inFlight: {
    fontSize: 10,
    color: `${color.textMuted}aa`,
    marginTop: space[3],
    lineHeight: 1.5,
  },
  failed: {
    fontSize: 10,
    color: `${color.warn}aa`,
    marginTop: space[2],
    lineHeight: 1.5,
  },
};
