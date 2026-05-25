// ═══════════════════════════════════════════════════════════════════════
// src/lib/bet-edge-policy.ts
// Engine-Selector Policy — directional candidate leagues for production
// betting recommendations.
//
// ─── 2026-05-25 SELF-EVAL CORRECTION: NO STATISTICAL SIGNIFICANCE ──────
// The earlier "Holm-Bonferroni-validated 4 leagues" claim from this file
// was BASED ON ASSUMED per-bet std of 80%. Empirical re-audit (commit
// after self-eval) found TRUE per-bet std = 148% from ledger CSVs in
// `tools/v4/reports/stage_5_bets_*.csv` (n=1,049 bets). Under correct
// empirical SE:
//
//   * ZERO leagues survive Holm-Bonferroni at α=0.05
//   * Even AGGREGATE dev-03 model: p_raw=0.227 (NOT significant)
//   * scottish_prem closest: p_raw=0.025 (would fail even single-test
//     significance after just 2-test Bonferroni)
//
// HOW THIS POLICY IS NOW JUSTIFIED:
// The 4 leagues are NOT a statistically validated edge set. They are
// the leagues that under PRODUCTION Kelly-staking showed POSITIVE ROI
// in BOTH 24/25 walk-forward AND 25/26 holdout. This is a DIRECTIONAL
// consistency criterion (both-positive + n≥40), not statistical proof.
//
// AUDIT EVIDENCE (Kelly-weighted per-Liga ROI from Stage 5 reports,
//   matches what production users experience under Kelly staking):
//
//   League         24/25 walkfwd  25/26 holdout  mean    Verdict
//   ------------   -------------  -------------  ------  ----------------
//   la_liga         +66.36%        +6.18%         +36.27%  ✓ directional only
//   scottish_prem   +7.05%         +65.30%        +36.17%  ✓ directional only
//   bundesliga      +6.55%         +53.75%        +30.15%  ✓ directional only
//   primeira_liga   +51.27%        +3.37%         +27.32%  ✓ directional only
//
// REMOVED (still correct removal, predates self-eval):
//   epl             -34.54%        +1.01%         CATASTROPHIC REVERSAL
//   serie_a         -14.46%        +16.27%        REVERSED
//   serie_b         -13.13%        +31.81%        REVERSED
//
// ⚠ HONEST RISKS:
//   * 4 surviving leagues might fail in 26/27 — they DID fail in some
//     prior holdout depending on engine/Kelly variant
//   * Per-bet variance (148%) means even +30% mean ROI over n=42 is
//     within noise of zero (z<2)
//   * scottish_prem & bundesliga are concentration-driven (one season
//     each delivers >50% while other is near-zero)
//   * Aggregate dev-03 model itself isn't statistically distinguishable
//     from random. This policy filter doesn't grant SOLID confidence
//     anywhere — it just selects the LEAST-NEGATIVE 4 leagues
//
// PRODUCTION CONSEQUENCE FOR USERS:
//   * `hasValidatedEdge(league)` returning true means "passed directional
//     filter", NOT "statistically validated profit edge"
//   * `expectedROIperStake()` is the historical mean — NOT a forecast
//   * UI should disclose "based on 2-season directional consistency,
//     not statistically significant under empirical variance"
//
// UPDATE PROCESS:
//   * Empirical audit: `tools/v4/diagnostics/bet_edge_policy_empirical_audit.py`
//   * Pre-audit (assumed-SE, do NOT trust):
//     `tools/v4/diagnostics/bet_edge_policy_audit.py`
//   * Re-run empirical after each Stage 5 ledger refresh.
//   * If aggregate dev-03 ROI achieves statistical significance, can
//     graduate from "directional" to "validated" language.
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
 * Per-league directional consistency record.
 *
 * `roi_walkfwd_24_25`: Kelly-weighted ROI on 24/25 holdout when dev-03
 *   was trained on 22/23+23/24 only (proper walk-forward, no leakage).
 * `roi_holdout_25_26`: Kelly-weighted ROI on 25/26 holdout when dev-03
 *   was trained on 22/23+23/24+24/25 (production-default model).
 * `sampleSize_*`: bet count per holdout under Kelly + value-bet filter.
 * `holm_p_adj`: ⚠ Holm-Bonferroni adjusted p — UNDER OPTIMISTIC SE
 *   assumption (80% per-bet std). EMPIRICAL re-audit found true std is
 *   148%, so this column overstates significance. See file header.
 *   Kept for historical traceability; do NOT use as confidence metric.
 *
 * @deprecated `roi23_24` / `roi25_26` / `sampleSize23_24` / `sampleSize25_26`
 *   were the pre-2026-05-25 field names — superseded by walkfwd/holdout
 *   naming when the audit switched to multi-season retrain data.
 */
export interface LeagueEdgeRecord {
  engine: ValidatedEngine;
  roi_walkfwd_24_25: number | null;
  roi_holdout_25_26: number | null;
  sampleSize_walkfwd_24_25: number | null;
  sampleSize_holdout_25_26: number | null;
  /** @deprecated under-estimates true variance — see file header */
  holm_p_adj: number | null;
  reason: string;
}

/**
 * The complete production policy map. Lookup key is the FODZE league slug
 * (matches the convention in dixon-coles.ts LEAGUES + matchdays JSONB).
 */
export const LEAGUE_EDGE_POLICY: Readonly<Record<string, LeagueEdgeRecord>> = {
  // ─── 4 directional leagues (positive ROI in BOTH holdouts under Kelly) ──
  // NOT statistically significant under empirical per-bet variance (148%).
  // Selected on both-holdouts-positive + n≥40 directional criterion only.
  // All use dev-03 (multi-season-retrained, production-default engine).
  la_liga: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.6636,
    roi_holdout_25_26: 0.0618,
    sampleSize_walkfwd_24_25: 46,
    sampleSize_holdout_25_26: 59,
    holm_p_adj: 0.0000,  // optimistic (assumed std=80%), real ≈ 0.10
    reason: "Directional only: both holdouts positive (+66.4% / +6.2% Kelly), mean +36.27%. NOT statistically significant under empirical SE — 24/25 dominates.",
  },
  scottish_prem: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.0705,
    roi_holdout_25_26: 0.6530,
    sampleSize_walkfwd_24_25: 16,
    sampleSize_holdout_25_26: 34,
    holm_p_adj: 0.0000,  // optimistic, real ≈ 0.30
    reason: "Directional only: both positive (+7% / +65% Kelly) but n=50 combined too small — 25/26 dominates, high concentration risk",
  },
  bundesliga: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.0655,
    roi_holdout_25_26: 0.5375,
    sampleSize_walkfwd_24_25: 18,
    sampleSize_holdout_25_26: 24,
    holm_p_adj: 0.0033,  // optimistic, real ≈ 0.50
    reason: "Directional only: both barely-positive (+6.6%) and big (+53.7%). NEW addition vs pre-audit policy. n=42 combined, weak evidence.",
  },
  primeira_liga: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.5127,
    roi_holdout_25_26: 0.0337,
    sampleSize_walkfwd_24_25: 22,
    sampleSize_holdout_25_26: 31,
    holm_p_adj: 0.0028,  // optimistic, real ≈ 0.55
    reason: "Directional only: both positive (+51.3% / +3.4%) but again 24/25 dominates. NEW addition vs pre-audit. Weak inference (n=53).",
  },

  // ─── REMOVED 2026-05-25 — failed cross-validation under fresh data ─────
  // These were "validated" in the prior policy but reversed in walk-forward.
  serie_a: {
    engine: null,
    roi_walkfwd_24_25: -0.1446,
    roi_holdout_25_26: 0.1627,
    sampleSize_walkfwd_24_25: 37,
    sampleSize_holdout_25_26: 44,
    holm_p_adj: 1.0000,
    reason: "REMOVED 2026-05-25 audit: 25/26 +16.3% but 24/25 walkfwd -14.5% — REVERSED, mean only +0.9% (fails Holm)",
  },
  epl: {
    engine: null,
    roi_walkfwd_24_25: -0.3454,
    roi_holdout_25_26: 0.0101,
    sampleSize_walkfwd_24_25: 26,
    sampleSize_holdout_25_26: 32,
    holm_p_adj: 1.0000,
    reason: "REMOVED 2026-05-25 audit: 25/26 +1.0% but 24/25 walkfwd -34.5% — CATASTROPHIC REVERSAL",
  },
  serie_b: {
    engine: null,
    roi_walkfwd_24_25: -0.1313,
    roi_holdout_25_26: 0.3181,
    sampleSize_walkfwd_24_25: 31,
    sampleSize_holdout_25_26: 14,
    holm_p_adj: 1.0000,
    reason: "REMOVED 2026-05-25 audit: 25/26 +31.8% but 24/25 walkfwd -13.1% — reversed, fails Holm",
  },

  // ─── Borderline (positive both holdouts but failed Holm-Bonferroni) ────
  eredivisie: {
    engine: null,
    roi_walkfwd_24_25: 0.0796,
    roi_holdout_25_26: 0.2785,
    sampleSize_walkfwd_24_25: 14,
    sampleSize_holdout_25_26: 36,
    holm_p_adj: 0.1386,
    reason: "Both positive (mean +17.9%) but fails Holm correction (p_adj=0.139). Watch for 26/27.",
  },
  greek_sl: {
    engine: null,
    roi_walkfwd_24_25: 0.1618,
    roi_holdout_25_26: 0.1084,
    sampleSize_walkfwd_24_25: 6,
    sampleSize_holdout_25_26: 12,
    holm_p_adj: 1.0000,
    reason: "Both positive but n too small (combined 18) for robust inference",
  },

  // ─── Unstable / negative (engine=null, walk-forward evidence) ──────────
  bundesliga2: {
    engine: null,
    roi_walkfwd_24_25: 0.2875,
    roi_holdout_25_26: -0.4502,
    sampleSize_walkfwd_24_25: 20,
    sampleSize_holdout_25_26: 20,
    holm_p_adj: 1.0000,
    reason: "Reversed +28.8% → -45.0% (sign flip + huge magnitude variance)",
  },
  championship: {
    engine: null,
    roi_walkfwd_24_25: 0.0160,
    roi_holdout_25_26: -0.1386,
    sampleSize_walkfwd_24_25: 44,
    sampleSize_holdout_25_26: 77,
    holm_p_adj: 1.0000,
    reason: "Unstable: 24/25 +1.6%, 25/26 -13.9% (sign-flip with large 25/26 sample)",
  },
  jupiler_pro: {
    engine: null,
    roi_walkfwd_24_25: 0.2153,
    roi_holdout_25_26: -0.2613,
    sampleSize_walkfwd_24_25: 17,
    sampleSize_holdout_25_26: 26,
    holm_p_adj: 1.0000,
    reason: "Reversed +21.5% → -26.1%",
  },
  ligue_1: {
    engine: null,
    roi_walkfwd_24_25: -0.1511,
    roi_holdout_25_26: 0.1132,
    sampleSize_walkfwd_24_25: 40,
    sampleSize_holdout_25_26: 43,
    holm_p_adj: 1.0000,
    reason: "Reversed -15.1% → +11.3% (mean -1.9% so net unprofitable)",
  },
  ligue_2: {
    engine: null,
    roi_walkfwd_24_25: -0.3382,
    roi_holdout_25_26: 0.2417,
    sampleSize_walkfwd_24_25: 20,
    sampleSize_holdout_25_26: 28,
    holm_p_adj: 1.0000,
    reason: "Reversed -33.8% → +24.2% (mean -4.8%)",
  },
  la_liga2: {
    engine: null,
    roi_walkfwd_24_25: -0.0488,
    roi_holdout_25_26: -0.0006,
    sampleSize_walkfwd_24_25: 43,
    sampleSize_holdout_25_26: 82,
    holm_p_adj: 1.0000,
    reason: "Both negative or zero (-4.9%, -0.1%)",
  },
  super_lig: {
    engine: null,
    roi_walkfwd_24_25: -0.0090,
    roi_holdout_25_26: -0.0443,
    sampleSize_walkfwd_24_25: 28,
    sampleSize_holdout_25_26: 59,
    holm_p_adj: 1.0000,
    reason: "Both negative (-0.9%, -4.4%)",
  },

  // ─── Tier-C: insufficient data for any audit ───────────────────────────
  liga3: { engine: null, roi_walkfwd_24_25: null, roi_holdout_25_26: null,
           sampleSize_walkfwd_24_25: null, sampleSize_holdout_25_26: null,
           holm_p_adj: null,
           reason: "No Stage 5 audit data (Sofa xG coverage only ab 24/25)" },
  league_one: { engine: null, roi_walkfwd_24_25: null, roi_holdout_25_26: null,
                sampleSize_walkfwd_24_25: null, sampleSize_holdout_25_26: null,
                holm_p_adj: null,
                reason: "No Stage 5 audit data" },
  league_two: { engine: null, roi_walkfwd_24_25: null, roi_holdout_25_26: null,
                sampleSize_walkfwd_24_25: null, sampleSize_holdout_25_26: null,
                holm_p_adj: null,
                reason: "No Stage 5 audit data" },
  eerste_divisie: { engine: null, roi_walkfwd_24_25: null, roi_holdout_25_26: null,
                    sampleSize_walkfwd_24_25: null, sampleSize_holdout_25_26: null,
                    holm_p_adj: null,
                    reason: "No Stage 5 audit data (volume tier, no Sofa xG)" },
  austria_bl: { engine: null, roi_walkfwd_24_25: null, roi_holdout_25_26: null,
                sampleSize_walkfwd_24_25: null, sampleSize_holdout_25_26: null,
                holm_p_adj: null,
                reason: "No Stage 5 audit data" },
  swiss_sl: { engine: null, roi_walkfwd_24_25: null, roi_holdout_25_26: null,
              sampleSize_walkfwd_24_25: null, sampleSize_holdout_25_26: null,
              holm_p_adj: null,
              reason: "No Stage 5 audit data" },
} as const;

// ─── Public API (unchanged signatures — backward-compatible with goldilocks) ─

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
 * arithmetic mean of the two holdouts (24/25 walkfwd + 25/26). Used for
 * sorting bets in the UI (highest-expected-ROI first) when the user
 * filters to validated-only.
 *
 * Returns null when no edge is validated for this league.
 */
export function expectedROIperStake(league: string): number | null {
  const rec = leagueEdgeRecord(league);
  if (!rec || rec.engine === null) return null;
  const r1 = rec.roi_walkfwd_24_25, r2 = rec.roi_holdout_25_26;
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
