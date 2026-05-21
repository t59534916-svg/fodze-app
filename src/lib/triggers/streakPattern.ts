// ═══════════════════════════════════════════════════════════════════════
// src/lib/triggers/streakPattern.ts
//
// Fires when either team has a general win/loss streak ≥ 5 games, OR a
// head-to-head streak ≥ 5. Both teams' streaks are shown side-by-side
// (Home W7 · Away L3) when applicable.
//
// Data source (production): sofa_team_streaks (89k rows)
// ═══════════════════════════════════════════════════════════════════════

import type { TriggerResult } from "./types";

export type StreakType = "general" | "h2h";
export type StreakOutcome = "W" | "L" | "D";

export interface Streak {
  type: StreakType;
  outcome: StreakOutcome;
  n: number;
}

export interface StreakPatternInput {
  homeName: string;
  awayName: string;
  homeStreaks: Streak[];
  awayStreaks: Streak[];
  /** Optional flavor — e.g. "Auswärts-Derby", "vs Top-3" */
  homeContext?: string;
  awayContext?: string;
}

const MIN_GENERAL = 5;
const MIN_H2H = 5;

function pickLongest(streaks: Streak[], type: StreakType, minN: number): Streak | null {
  return streaks
    .filter(s => s.type === type && s.n >= minN)
    .sort((a, b) => b.n - a.n)[0] ?? null;
}

export function detectStreakPattern(input: StreakPatternInput): TriggerResult | null {
  const homeGeneral = pickLongest(input.homeStreaks, "general", MIN_GENERAL);
  const awayGeneral = pickLongest(input.awayStreaks, "general", MIN_GENERAL);
  const homeH2H = pickLongest(input.homeStreaks, "h2h", MIN_H2H);
  // (awayH2H would mirror homeH2H — skip duplicate)

  if (!homeGeneral && !awayGeneral && !homeH2H) return null;

  const parts: TriggerResult["parts"] = [];

  if (homeGeneral) {
    parts.push({ kind: "text", value: `${input.homeName} ` });
    parts.push({
      kind: homeGeneral.outcome === "L" ? "warn" : "highlight",
      value: `${homeGeneral.outcome}${homeGeneral.n}`,
    });
    if (input.homeContext) parts.push({ kind: "text", value: ` ${input.homeContext}` });
  }
  if (homeGeneral && awayGeneral) {
    parts.push({ kind: "text", value: " · " });
  }
  if (awayGeneral) {
    parts.push({ kind: "text", value: `${input.awayName} ` });
    parts.push({
      kind: awayGeneral.outcome === "L" ? "warn" : "highlight",
      value: `${awayGeneral.outcome}${awayGeneral.n}`,
    });
    if (input.awayContext) parts.push({ kind: "text", value: ` ${input.awayContext}` });
  }
  if (homeH2H) {
    if (parts.length > 0) parts.push({ kind: "text", value: " · " });
    parts.push({ kind: "text", value: `H2H: ${input.homeName} ` });
    parts.push({
      kind: homeH2H.outcome === "L" ? "warn" : "highlight",
      value: `${homeH2H.outcome}${homeH2H.n}`,
    });
    parts.push({ kind: "text", value: ` vs ${input.awayName}` });
  }

  return {
    type: "streak_pattern",
    severity: Math.min(
      1,
      Math.max(homeGeneral?.n ?? 0, awayGeneral?.n ?? 0, homeH2H?.n ?? 0) / 8
    ),
    parts,
    data: {
      homeGeneral,
      awayGeneral,
      homeH2H,
    },
  };
}

export { MIN_GENERAL, MIN_H2H };
