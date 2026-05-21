// ═══════════════════════════════════════════════════════════════════════
// src/lib/triggers/coachingChange.ts
//
// Fires when home OR away team has a manager change within [3, 45] day
// window — the "honeymoon boost" zone. Augments narrative with per-Liga
// historical boost-rate if available.
//
// Data source (production): sofascore_match_managers + sofa_team_manager_history view
// ═══════════════════════════════════════════════════════════════════════

import type { TriggerResult } from "./types";

export interface ManagerChange {
  managerName: string;
  daysSinceChange: number;
}

export interface CoachingChangeInput {
  league: string;
  homeChange?: ManagerChange;
  awayChange?: ManagerChange;
  /** Historical: out of `total` BL trainer-changes in this window,
   *  how many produced a "boost match" in match 3-5? */
  ligaBoostRate?: { boostCount: number; total: number };
  /** Optional match-number-after-change for narrative subline (e.g. "Match #3"). */
  matchNumberAfterChange?: number;
}

const WINDOW_MIN = 3;
const WINDOW_MAX = 45;

export function detectCoachingChange(input: CoachingChangeInput): TriggerResult | null {
  const inWindow = (c?: ManagerChange) =>
    !!c && c.daysSinceChange >= WINDOW_MIN && c.daysSinceChange <= WINDOW_MAX;

  // Prefer the side with the more-recent change (stronger signal).
  const home = inWindow(input.homeChange) ? input.homeChange! : null;
  const away = inWindow(input.awayChange) ? input.awayChange! : null;
  const candidate =
    home && away ? (home.daysSinceChange < away.daysSinceChange ? home : away) : (home ?? away);
  if (!candidate) return null;

  const parts: TriggerResult["parts"] = [
    { kind: "highlight", value: "NEUER TRAINER" },
    { kind: "text", value: ` ${candidate.managerName} · ${candidate.daysSinceChange} Tage` },
  ];
  if (input.ligaBoostRate && input.ligaBoostRate.total > 0) {
    parts.push({
      kind: "text",
      value: ` · ${input.ligaBoostRate.boostCount}/${input.ligaBoostRate.total} ${input.league}-changes hatten Boost-Match in Spiel 3-5`,
    });
  }
  if (input.matchNumberAfterChange) {
    parts.push({
      kind: "sub",
      value: `→ this = Match #${input.matchNumberAfterChange} nach Wechsel`,
    });
  }

  return {
    type: "coaching_change",
    severity: 0.6,
    parts,
    data: {
      managerName: candidate.managerName,
      daysSinceChange: candidate.daysSinceChange,
      ligaBoostRate: input.ligaBoostRate ?? null,
      matchNumberAfterChange: input.matchNumberAfterChange ?? null,
      side: candidate === home ? "home" : "away",
    },
  };
}

export { WINDOW_MIN, WINDOW_MAX };
