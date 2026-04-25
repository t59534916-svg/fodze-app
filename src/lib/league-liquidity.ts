// ═══════════════════════════════════════════════════════════════════════
// FODZE — Per-League Goldilocks/Trap Liquidity Tiers
// ═══════════════════════════════════════════════════════════════════════
//
// Marktbasierte Edge-Schwellen pro Liga. Die globale Default 2.5%/7.5%/10%
// behandelt eine "+3% edge" gegen Pinnacle EPL identisch zu "+3% edge" in
// der dritten österreichischen Liga. Realität:
//
//   - Tier-1 (sharp markets, Pinnacle limit $50k+): jeder Edge >= 1.5% ist
//     verlässlich, weil sharp money die Linie pre-game zerlegt. Trap-Risk
//     erst >= 8% (echter Insider-Info-Indikator).
//   - Tier-2 (moderate markets, Pinnacle limit $5-15k): >= 3.5% nötig
//     wegen Spread-Noise. Trap erst >= 12%.
//   - Tier-3 (soft markets, Pinnacle limit $500-2k): brauchen >= 4.5%
//     bevor eine Edge statistisch signifikant ist. Trap erst >= 15%.
//
// Tier-Zuordnung basiert auf:
//   1) Pinnacle limit / Bookmaker-Volumen (qualitativ aus 2026-04 Beobachtung)
//   2) Anzahl Sharp-Bookmaker im Market (Pinnacle, Sbobet, IBC)
//   3) Liga-Saison-Volumen (Top-5 ~380 Spiele/Saison vs. Liga 3 ~380 etc.)
//
// Default = TIER_2 für unbekannte Ligas — defensiv konservativ.
// ═══════════════════════════════════════════════════════════════════════

export interface LiquidityTier {
  /** Untere Edge-Grenze: darunter = Rauschen, kein Bet. */
  goldilocksMin: number;
  /** Obere Edge-Grenze normaler Goldilocks-Zone. */
  goldilocksMax: number;
  /** Soft-Trap (silent skip): edge > Max aber < TrapHard. Kein Alarm aber kein Bet. */
  trapSoft: number;
  /** Hard-Trap (loud warning): edge > TrapHard, Markt weiß was wir nicht wissen. */
  trapHard: number;
}

const TIER_1: LiquidityTier = {
  goldilocksMin: 0.015,
  goldilocksMax: 0.05,
  trapSoft: 0.08,
  trapHard: 0.10,
};

const TIER_2: LiquidityTier = {
  goldilocksMin: 0.025,
  goldilocksMax: 0.075,
  trapSoft: 0.10,
  trapHard: 0.12,
};

const TIER_3: LiquidityTier = {
  goldilocksMin: 0.035,
  goldilocksMax: 0.085,
  trapSoft: 0.12,
  trapHard: 0.15,
};

/** Default fallback for unknown leagues — TIER_2 (moderate). */
export const DEFAULT_TIER: LiquidityTier = TIER_2;

/**
 * Per-League tier mapping. Keys MUST match `LEAGUES` keys in dixon-coles.ts.
 *
 * Tier-1: Sharp markets, hohe Liquidity, post-vig Pinnacle ist der Goldstandard.
 * Tier-2: Moderate markets, Standard-Goldilocks (gleich der pre-Phase-4 Default).
 * Tier-3: Soft markets, weite Spreads, Trap-Risk höher in absoluten Edge-Zahlen.
 */
export const LEAGUE_LIQUIDITY_TIERS: Record<string, LiquidityTier> = {
  // ── TIER-1 (sharp top-5 + UEFA) ─────────────────────────────────
  epl: TIER_1,
  la_liga: TIER_1,
  serie_a: TIER_1,
  bundesliga: TIER_1,
  ligue_1: TIER_1,
  cl: TIER_1,
  el: TIER_1,
  // ── TIER-2 (moderate: zweite Top-Ligen + große Nebenligen) ──────
  championship: TIER_2,
  bundesliga2: TIER_2,
  la_liga2: TIER_2,
  serie_b: TIER_2,
  ligue_2: TIER_2,
  eredivisie: TIER_2,
  primeira_liga: TIER_2,
  jupiler_pro: TIER_2,
  super_lig: TIER_2,
  swiss_sl: TIER_2,
  austria_bl: TIER_2,
  scottish_prem: TIER_2,
  // ── TIER-3 (soft: dritte Divisionen + dünne Märkte) ─────────────
  liga3: TIER_3,
  league_one: TIER_3,
  league_two: TIER_3,
  greek_sl: TIER_3,
  eerste_divisie: TIER_3,
};

/**
 * Returns the liquidity tier for a league key, falling back to DEFAULT_TIER
 * (TIER_2) for unknown leagues. Defensive — never throws, never returns undefined.
 */
export function getLeagueLiquidityTier(leagueKey: string | undefined): LiquidityTier {
  if (!leagueKey) return DEFAULT_TIER;
  return LEAGUE_LIQUIDITY_TIERS[leagueKey] ?? DEFAULT_TIER;
}

/**
 * Convenience: 4-state classification of an edge against a league's tier.
 *
 * "noise"      — edge < goldilocksMin (no bet, too small to be reliable)
 * "value"      — goldilocksMin <= edge <= goldilocksMax (place bet)
 * "trap-soft"  — goldilocksMax < edge <= trapHard (silent skip, no alarm)
 * "trap-hard"  — edge > trapHard (loud warning, market knows something)
 */
export type EdgeClass = "noise" | "value" | "trap-soft" | "trap-hard";

export function classifyEdgeForLeague(
  edge: number,
  leagueKey: string | undefined,
): EdgeClass {
  const t = getLeagueLiquidityTier(leagueKey);
  if (edge < t.goldilocksMin) return "noise";
  if (edge <= t.goldilocksMax) return "value";
  if (edge <= t.trapHard) return "trap-soft";
  return "trap-hard";
}
