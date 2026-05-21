// ═══════════════════════════════════════════════════════════════════════
// src/lib/bet-edge-policy.ts
// Hybrid Engine-Selector Policy — cross-season + cross-engine validated
// edge map for production betting recommendations.
//
// Derived from the 5-test Money-Eval investigation (2026-05-21):
//   • tools/backtest/simulate_v2_production_kelly.py — 23/24 OOT v2
//   • tools/backtest/simulate_v2_vs_dev03_25-26.py — apples-to-apples 25/26
//   • tools/backtest/simulate_v2_dev03_full_validation.py — bootstrap CIs
//   • tools/backtest/validate_concentration_risk.py — Eredivisie reversion
//   • tools/backtest/validate_dev03_23-24.py — dev-03 cross-season check
//
// The validation chain showed:
//   1. v2_production headline ROI nicht signifikant (P=50%, CI [-16%, +19%])
//   2. dev-03+m6_benter headline +5.98% war 76% durch eredivisie-luck dominiert
//   3. eredivisie's +45.6% war 25/26-specific: dev-03 on 23/24 in-sample = -29.85%
//   4. Calibration regimes drift (m6_benter β_model 0.71→0.116 on H1-refit)
//   5. Per-league heterogeneity dominates over global engine performance
//
// Only leagues with positive ROI on BOTH 23/24 AND 25/26 across the best
// engine for that league qualify. This filters out single-season luck and
// regime-driftet calibrations.
//
// Cross-validated edges (n ≥ 30 in both seasons, ROI > 0% in both):
//   dev-03+m6_benter wins:
//     • serie_a       +3.4% → +8.2%   (n=142+64)
//     • scottish_prem +17.0% → +32.3% (n=192+36)
//     • epl           +4.7% → +32.2%  (n=78+44)
//   v2_production wins:
//     • la_liga       +13.6% → +31.7% (n=235+26)
//     • serie_b       +3.9% → +27.7%  (n=268+51)
//
// Everything else: net-zero or net-negative across seasons. DON'T BET.
//
// Update via: re-run the 5 Money-Eval sims with new training data, check
// per-league cross-season stability, edit this map.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Engine that owns the validated edge in this league.
 *
 * `null` = no cross-season-validated edge exists. App should still show the
 * match for users who want to bet anyway, but value-bet recommendations
 * should be suppressed (or warning-badged).
 */
export type ValidatedEngine = "v2" | "dev-03" | null;

/**
 * Validation snapshot for a league. `roi23_24` and `roi25_26` are observed
 * ROI/stake under the WINNING engine + production-Calibration-Stack.
 *
 * Use `sampleSize23_24` + `sampleSize25_26` as confidence-floor — anything
 * with sample < 30 in either season was disqualified from this map.
 */
export interface LeagueEdgeRecord {
  engine: ValidatedEngine;
  roi23_24: number | null;
  roi25_26: number | null;
  sampleSize23_24: number | null;
  sampleSize25_26: number | null;
  reason: string;
}

/**
 * The complete production policy map. Lookup key is the FODZE league slug
 * (matches the convention in dixon-coles.ts LEAGUES + matchdays JSONB).
 */
export const LEAGUE_EDGE_POLICY: Readonly<Record<string, LeagueEdgeRecord>> = {
  // ─── dev-03+m6_benter validated edges ──────────────────────────────────
  serie_a: {
    engine: "dev-03",
    roi23_24: 0.034,
    roi25_26: 0.082,
    sampleSize23_24: 142,
    sampleSize25_26: 64,
    reason: "dev-03+m6_benter cross-season positive (n=142+64)",
  },
  scottish_prem: {
    engine: "dev-03",
    roi23_24: 0.170,
    roi25_26: 0.323,
    sampleSize23_24: 192,
    sampleSize25_26: 36,
    reason: "dev-03+m6_benter strongest cross-season edge",
  },
  epl: {
    engine: "dev-03",
    roi23_24: 0.047,
    roi25_26: 0.322,
    sampleSize23_24: 78,
    sampleSize25_26: 44,
    reason: "dev-03+m6_benter consistent positive — v2 loses EPL both seasons",
  },

  // ─── v2_production validated edges ─────────────────────────────────────
  la_liga: {
    engine: "v2",
    roi23_24: 0.136,
    roi25_26: 0.317,
    sampleSize23_24: 235,
    sampleSize25_26: 26,
    reason: "v2_production cross-season positive — dev-03 loses La Liga both seasons",
  },
  serie_b: {
    engine: "v2",
    roi23_24: 0.039,
    roi25_26: 0.277,
    sampleSize23_24: 268,
    sampleSize25_26: 51,
    reason: "v2_production cross-season positive (largest n in the 5)",
  },

  // ─── No validated edge — listed explicitly so future devs see them ──────
  bundesliga: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "Both engines reversed between seasons (v2 +17%→-45%, dev-03 -35%→-27%)",
  },
  eredivisie: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "REVERSED — dev-03 -30% (23/24 in-sample) → +46% (25/26) was 25/26-luck",
  },
  ligue_1: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "Unstable — dev-03 +67%→-7% (reversed), v2 -17%→+60% (reversed in other direction)",
  },
  super_lig: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "Both engines net-negative on at least one season",
  },
  greek_sl: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "Sample sizes too small + inconsistent direction",
  },
  ligue_2: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "Consistent net-negative for v2 (-18%→-47%)",
  },
  primeira_liga: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "Reversed — v2 -7%→-25%, dev-03 +10%→-12%",
  },
  championship: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "v2 25/26 +56% but only n=16; dev-03 23/24 +35% n=11 — both small samples",
  },
  la_liga2: {
    engine: null,
    roi23_24: null,
    roi25_26: null,
    sampleSize23_24: null,
    sampleSize25_26: null,
    reason: "Insufficient cross-season validation (small n in 25/26)",
  },
  // Tier-C leagues (no cross-season data available)
  liga3: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
           reason: "No cross-season validation data" },
  league_one: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
                reason: "No cross-season validation data" },
  league_two: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
                reason: "No cross-season validation data" },
  eerste_divisie: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
                    reason: "No cross-season validation data" },
  bundesliga2: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
                 reason: "Insufficient cross-season validation" },
  jupiler_pro: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
                 reason: "Reversed +34%→-100% (small 25/26 sample)" },
  austria_bl: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
                reason: "No cross-season validation data" },
  swiss_sl: { engine: null, roi23_24: null, roi25_26: null, sampleSize23_24: null, sampleSize25_26: null,
              reason: "No cross-season validation data" },
} as const;

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Lookup the validated edge engine for a league. Returns null if no edge
 * is validated (caller should suppress / warn-badge value-bet recos).
 */
export function validatedEngineFor(league: string): ValidatedEngine {
  const norm = (league || "").toLowerCase().trim();
  return LEAGUE_EDGE_POLICY[norm]?.engine ?? null;
}

/**
 * True iff this league has any cross-season-validated positive edge.
 * Used by UI filters to show "Validated Bets Only" toggle.
 */
export function hasValidatedEdge(league: string): boolean {
  return validatedEngineFor(league) !== null;
}

/**
 * Diagnostic envelope — for tooltips + audit logging. Returns the full
 * LeagueEdgeRecord (including null-engine cases with reasons), or null
 * if the league is completely unknown.
 */
export function leagueEdgeRecord(league: string): LeagueEdgeRecord | null {
  const norm = (league || "").toLowerCase().trim();
  return LEAGUE_EDGE_POLICY[norm] ?? null;
}

/**
 * Average expected ROI/stake under the validated engine, computed as the
 * arithmetic mean of 23/24 and 25/26 observations. Used for sorting bets
 * in the UI (highest-expected-ROI first) when the user filters to
 * validated-only.
 *
 * Returns null when no edge is validated for this league.
 */
export function expectedROIperStake(league: string): number | null {
  const rec = leagueEdgeRecord(league);
  if (!rec || rec.engine === null) return null;
  const r1 = rec.roi23_24, r2 = rec.roi25_26;
  if (r1 === null || r2 === null) return null;
  return (r1 + r2) / 2;
}

/**
 * Compact list of leagues with validated edges, in deterministic order
 * (by engine, then alphabetical). Useful for UI filter menus + tests.
 */
export function validatedLeagues(): { league: string; engine: ValidatedEngine }[] {
  return Object.entries(LEAGUE_EDGE_POLICY)
    .filter(([, r]) => r.engine !== null)
    .map(([league, r]) => ({ league, engine: r.engine }))
    .sort((a, b) => {
      // dev-03 first, then v2, then alphabetical within engine
      if (a.engine === b.engine) return a.league.localeCompare(b.league);
      const order = { "dev-03": 0, v2: 1 } as const;
      return (order[a.engine as "dev-03" | "v2"] ?? 99) -
             (order[b.engine as "dev-03" | "v2"] ?? 99);
    });
}
