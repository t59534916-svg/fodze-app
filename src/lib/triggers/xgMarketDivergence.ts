// ═══════════════════════════════════════════════════════════════════════
// src/lib/triggers/xgMarketDivergence.ts
//
// Fires when |λ_engine_total - λ_market_implied| exceeds per-Liga threshold.
// Sharper markets (Top-5 + sharp EU leagues) have tighter thresholds because
// the market is more efficient — small gaps there are real signal.
// ═══════════════════════════════════════════════════════════════════════

import type { TriggerResult } from "./types";

const THETA_LIGA: Record<string, number> = {
  // Sharp markets (Pinnacle-led, efficient)
  epl: 0.25, la_liga: 0.25, bundesliga: 0.25, serie_a: 0.25, ligue_1: 0.25,
  // Mid-tier
  championship: 0.35, eredivisie: 0.35, primeira_liga: 0.35, bundesliga2: 0.35,
  serie_b: 0.35, la_liga2: 0.35, greek_sl: 0.35, super_lig: 0.35,
  scottish_prem: 0.35, jupiler_pro: 0.35, austria_bl: 0.35, swiss_sl: 0.35,
  // Soft markets (less liquidity → bigger gaps required for signal)
  liga3: 0.50, league_one: 0.50, league_two: 0.50, ligue_2: 0.50, eerste_divisie: 0.50,
};
const DEFAULT_THETA = 0.35;

export interface XGMarketInput {
  league: string;
  lambdaEngine: number;
  lambdaMarket: number;
}

export function detectXGMarketDivergence(input: XGMarketInput): TriggerResult | null {
  const gap = input.lambdaEngine - input.lambdaMarket;
  const theta = THETA_LIGA[input.league] ?? DEFAULT_THETA;
  if (Math.abs(gap) < theta) return null;

  const sign = gap >= 0 ? "+" : "";
  return {
    type: "xg_market",
    severity: Math.min(1, Math.abs(gap) / (theta * 2)),
    parts: [
      { kind: "text", value: "Engine λ " },
      { kind: "highlight", value: input.lambdaEngine.toFixed(2) },
      { kind: "text", value: ` vs Markt ${input.lambdaMarket.toFixed(2)} (${sign}${gap.toFixed(2)} gap)` },
    ],
    data: {
      lambdaEngine: input.lambdaEngine,
      lambdaMarket: input.lambdaMarket,
      gap,
      theta,
      league: input.league,
    },
  };
}

export { THETA_LIGA, DEFAULT_THETA };
