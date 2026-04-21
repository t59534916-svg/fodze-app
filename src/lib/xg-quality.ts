// ═══════════════════════════════════════════════════════════════════════
// xG Quality Signals — derived per-team signals the engine uses internally
// but the UI previously buried. Helps first-glance reading of match cards,
// especially in less-coverage leagues where raw xG can mislead.
// ═══════════════════════════════════════════════════════════════════════

import type { XGHistoryEntry } from "@/types/match";
import type { SoSRatings } from "@/lib/sos";

// ─── Conversion (xG-vs-Goals efficiency) ─────────────────────────────

export type ConversionLabel = "under" | "normal" | "over" | "unknown";

export interface ConversionSignal {
  ratio: number | null;     // goals / xG across the window; null if no data
  label: ConversionLabel;
  goalsSum: number;
  xgSum: number;
  note: string;             // short human-readable interpretation
}

// Threshold picks: ±15% off parity signals real over/under-conversion.
// Below that, sample noise over 8 matches dominates (std err ~12–18%).
const CONV_UNDER = 0.85;
const CONV_OVER = 1.15;
// Sub-window for signal credibility — under 4 games there's not enough
// sample to distinguish finishing skill from luck.
const CONV_MIN_GAMES = 4;

export function conversionFrom(history?: XGHistoryEntry[]): ConversionSignal {
  if (!history || history.length < CONV_MIN_GAMES) {
    return { ratio: null, label: "unknown", goalsSum: 0, xgSum: 0, note: "Nicht genug Spiele" };
  }
  let xgSum = 0, goalsSum = 0, validGames = 0;
  for (const e of history) {
    if (e.goals_for == null || e.xg == null) continue;
    xgSum += e.xg;
    goalsSum += e.goals_for;
    validGames++;
  }
  if (validGames < CONV_MIN_GAMES || xgSum < 0.5) {
    return { ratio: null, label: "unknown", goalsSum, xgSum, note: "Goals in Historie fehlen" };
  }
  const ratio = goalsSum / xgSum;
  if (ratio < CONV_UNDER) {
    return {
      ratio, goalsSum, xgSum, label: "under",
      note: `Chancen vergeben: ${goalsSum.toFixed(0)} Tore aus ${xgSum.toFixed(1)} xG (${(ratio * 100).toFixed(0)}%)`,
    };
  }
  if (ratio > CONV_OVER) {
    return {
      ratio, goalsSum, xgSum, label: "over",
      note: `Überperformt: ${goalsSum.toFixed(0)} Tore aus ${xgSum.toFixed(1)} xG (${(ratio * 100).toFixed(0)}%) — klinisch oder Glück`,
    };
  }
  return {
    ratio, goalsSum, xgSum, label: "normal",
    note: `Normale Verwertung: ${goalsSum.toFixed(0)} Tore / ${xgSum.toFixed(1)} xG`,
  };
}

// ─── Strength of Schedule (opponent-adjusted context) ────────────────

export type SoSLabel = "weak" | "normal" | "strong" | "unknown";

export interface SoSSignal {
  value: number | null;   // average of opponent defensive-strength ratings
  label: SoSLabel;
  note: string;
}

// Interpretation of opponent defenseRating (from computeSoSRatings):
//   defenseRating > 1.0  → opponent concedes MORE than league avg → weak defense
//   defenseRating < 1.0  → opponent concedes LESS than league avg → strong defense
//
// So `label` refers to the Schedule (what the TEAM faced), not the
// opponents individually:
//   - "strong" schedule = faced strong defenses → team's xG is impressive
//   - "weak" schedule   = faced weak defenses → team's xG is inflated
const SCHEDULE_STRONG = 0.93; // opponents' avg defenseRating (low = strong)
const SCHEDULE_WEAK = 1.07;

export function sosFrom(
  history: XGHistoryEntry[] | undefined,
  sosRatings: SoSRatings | null | undefined,
): SoSSignal {
  if (!history || history.length === 0 || !sosRatings) {
    return { value: null, label: "unknown", note: "Keine SoS-Daten" };
  }
  const opponentDefRatings: number[] = [];
  for (const e of history) {
    if (!e.opponent) continue;
    const rating = sosRatings[e.opponent];
    if (rating && typeof rating.defenseRating === "number") {
      opponentDefRatings.push(rating.defenseRating);
    }
  }
  if (opponentDefRatings.length < 3) {
    return { value: null, label: "unknown", note: "Zu wenige Gegner im Rating" };
  }
  const avg = opponentDefRatings.reduce((s, v) => s + v, 0) / opponentDefRatings.length;
  if (avg < SCHEDULE_STRONG) {
    return {
      value: avg, label: "strong",
      note: `xG gegen starke Defensiven — ${(avg * 100).toFixed(0)}% Defense-Rating (<100 = schwieriger)`,
    };
  }
  if (avg > SCHEDULE_WEAK) {
    return {
      value: avg, label: "weak",
      note: `xG gegen schwache Defensiven — ${(avg * 100).toFixed(0)}% Defense-Rating (>100 = leichter)`,
    };
  }
  return {
    value: avg, label: "normal",
    note: `Neutraler Spielplan — ${(avg * 100).toFixed(0)}% Defense-Rating`,
  };
}
