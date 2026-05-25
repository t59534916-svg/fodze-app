// ═══════════════════════════════════════════════════════════════════════
// src/lib/bet-edge-policy.ts
// Hybrid Engine-Selector Policy — cross-season + cross-engine validated
// edge map for production betting recommendations.
//
// ─── 2026-05-25 REWRITE under 5-Gate Falsification Protocol ─────────────
// Previous policy (2026-05-21) used 23/24 OOT + 25/26 holdout, claimed 5
// validated leagues: serie_a, scottish_prem, epl, la_liga, serie_b. Audit
// (`tools/v4/diagnostics/bet_edge_policy_audit.{py,json}`) under fresh
// walk-forward data (24/25 walkfwd + 25/26 holdout from multi-season
// dev-03 retrain) found:
//   * 3 of 5 'validated' leagues REVERSED: epl/serie_a/serie_b → REMOVED
//   * 2 NEW leagues added: bundesliga, primeira_liga (Holm-adj p<0.005)
//   * Only la_liga + scottish_prem survive from previous policy
//
// All 4 surviving leagues use dev-03 (the multi-season-retrained engine
// is now production-default per /matchday). The previous policy mixed v2
// for la_liga + serie_b; this is consolidated to dev-03 for consistency.
//
// AUDIT EVIDENCE (per-league walk-forward ROI):
//
//   League         24/25 walkfwd  25/26 holdout  mean    Holm p_adj
//   ------------   -------------  -------------  ------  ----------
//   la_liga         +66.36%        +6.18%         +36.27%  0.0000  ✅
//   scottish_prem   +7.05%         +65.30%        +36.17%  0.0000  ✅
//   bundesliga      +6.55%         +53.75%        +30.15%  0.0033  ✅
//   primeira_liga   +51.27%        +3.37%         +27.32%  0.0028  ✅
//   eredivisie      +7.96%         +27.85%        +17.91%  0.1386  ❌ (fails Holm)
//   greek_sl        +16.18%        +10.84%        +13.51%  1.0000  ❌
//   --- below: previous policy REMOVED ---
//   epl             -34.54%        +1.01%         -16.77%  REVERSED
//   serie_a         -14.46%        +16.27%        +0.90%   REVERSED
//   serie_b         -13.13%        +31.81%        +9.34%   REVERSED
//
// STRATEGIC NOTES:
//   * Per-league rankings remain VOLATILE between holdouts. The 4
//     surviving leagues passed Holm-Bonferroni correction across 15
//     comparable leagues — statistically the most robust selection
//     possible with current data.
//   * Even surviving leagues could fail in 26/27. RE-AUDIT EVERY SEASON.
//   * Aggregate dev-03 model fails 2 of 4 Stage 5 ship-gates (bootstrap
//     CI lower bound includes 0 in both holdouts). This policy filter is
//     therefore the RISK MITIGATION layer — restrict betting to the
//     leagues where statistical evidence is strongest.
//
// UPDATE PROCESS:
//   Re-run `tools/v4/diagnostics/bet_edge_policy_audit.py` after each
//   multi-season retrain. If a league drops below Holm-Bonferroni
//   threshold, remove it. If a new league enters, add it. Field names
//   are season-agnostic (roi_walkfwd / roi_holdout) so future audits
//   don't require schema changes.
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
 * Validation snapshot for a league.
 *
 * `roi_walkfwd_24_25`: ROI/stake observed on 24/25 holdout when dev-03 was
 *   trained on 22/23+23/24 only (proper walk-forward, no leakage).
 * `roi_holdout_25_26`: ROI/stake observed on 25/26 holdout when dev-03 was
 *   trained on 22/23+23/24+24/25 (the production-default model).
 * `sampleSize_*`: bet count per holdout. Used as confidence-floor.
 * `holm_p_adj`: Holm-Bonferroni adjusted p-value from the 15-league
 *   audit (lower = more robust). `null` = not in active audit pool.
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
  holm_p_adj: number | null;
  reason: string;
}

/**
 * The complete production policy map. Lookup key is the FODZE league slug
 * (matches the convention in dixon-coles.ts LEAGUES + matchdays JSONB).
 */
export const LEAGUE_EDGE_POLICY: Readonly<Record<string, LeagueEdgeRecord>> = {
  // ─── 4 leagues validated under 5-Gate Falsification (2026-05-25) ────────
  // All use dev-03 (multi-season-retrained, production-default engine).
  la_liga: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.6636,
    roi_holdout_25_26: 0.0618,
    sampleSize_walkfwd_24_25: 46,
    sampleSize_holdout_25_26: 59,
    holm_p_adj: 0.0000,
    reason: "STRONGEST Holm-survivor (p_adj=0.000); both holdouts positive, mean ROI +36.27%; n=105 combined",
  },
  scottish_prem: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.0705,
    roi_holdout_25_26: 0.6530,
    sampleSize_walkfwd_24_25: 16,
    sampleSize_holdout_25_26: 34,
    holm_p_adj: 0.0000,
    reason: "Holm-survivor (p_adj=0.000); both positive but small-n risk (combined n=50)",
  },
  bundesliga: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.0655,
    roi_holdout_25_26: 0.5375,
    sampleSize_walkfwd_24_25: 18,
    sampleSize_holdout_25_26: 24,
    holm_p_adj: 0.0033,
    reason: "NEW addition (was 'reversed' pre-audit; multi-season retrain stabilized it). Holm-survivor.",
  },
  primeira_liga: {
    engine: "dev-03",
    roi_walkfwd_24_25: 0.5127,
    roi_holdout_25_26: 0.0337,
    sampleSize_walkfwd_24_25: 22,
    sampleSize_holdout_25_26: 31,
    holm_p_adj: 0.0028,
    reason: "NEW addition (not in pre-audit policy). Holm-survivor (p_adj=0.003).",
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
