// ═══════════════════════════════════════════════════════════════════════
// src/components/matchday-card/types.ts
//
// Card-domain types. Each MatchData is fully self-contained — every value
// the card needs to render is on this object. Production code derives these
// from team_metadata + engine.predict() + live_odds + live_brier_snapshots
// + runAllTriggers() (see useMatchdayCards.ts).
// ═══════════════════════════════════════════════════════════════════════

import type { TriggerResult, TrustBand, KellyMult } from "@/lib/triggers";

export type ConfLevel = "high" | "med" | "low";

export interface TeamRef {
  name: string;
  abbr: string;
  logo: string;
  primary: string;
  primaryDark: string;
  /** "#fff" or color.leather — pre-picked by luminance check. */
  textOn: string;
}

export interface MatchData {
  id: string;
  home: TeamRef;
  away: TeamRef;
  kickoff: string;
  league: string;
  archetype?: string;

  // 1X2 + xG (Match Read)
  probH: number;
  probD: number;
  probA: number;
  xgH: number;
  xgA: number;
  xgSum: number;

  // Bet specifics
  marketLabel: string;
  edgePct: number;
  isHomeBet?: boolean;
  isAwayBet?: boolean;
  isDrawBet?: boolean;

  // Trust
  trustBand: TrustBand;
  trustHit: number;
  trustN: number;
  trustUnderCov?: boolean;

  // Dual prob bar (this bet)
  engineProb: number;
  marktProb: number;
  gapPp: number;
  gapWarn?: boolean;

  // Confidence
  sigma2: number;
  confPct: number;
  confLevel: ConfLevel;
  clv?: string;
  driftWarn?: string;
  noTriggers?: boolean;

  // L1 triggers
  triggers: TriggerResult[];

  // Action
  betEuro: number;
  kellyMult: KellyMult;
}

export type { TriggerResult, TrustBand, KellyMult } from "@/lib/triggers";
