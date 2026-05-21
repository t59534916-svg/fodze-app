/**
 * Filter-Shield · TS browser-runtime mirror of tools/v4/modules/m9_filter_shield/.
 *
 * Pure functions — no React, no fetch. Loads its config from
 * public/filter-shield-config.json (single source of truth shared with Python).
 *
 * Parity contract: same inputs → bit-identical outputs (within 1e-9) as
 * Python compute_csd_veto. Verified in tests/filter-shield.test.ts.
 *
 * Empirical provenance:
 *   CSD veto thresholds calibrated on n=6525 v2-OOT predictions (2026-05-21).
 *   See tools/v4/diagnostics/csd_veto_calibration.json for full audit trail.
 *
 *   * persistent_reversal (active): rho_1 < -0.30 + sign_flip
 *       → Brier-lift +0.0427 (CI [+0.017, +0.069]), n=355 in calibration set
 *   * catastrophic (shadow until 200-firing burn-in completes):
 *       |rho_1| < 0.30 + sign_flip + |Δμ| > 0.50
 *       → Brier-lift +0.0203 (CI [+0.005, +0.034]), n=2173
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type BetSide =
  | "home" | "away" | "draw"
  | "over" | "under"
  | "btts_yes" | "btts_no";

export interface RegimeConfig {
  name: string;
  acf_max: number | null;       // for persistent_reversal: max value of rho_1
  acf_max_abs: number | null;   // for catastrophic: max |rho_1|
  delta_min_abs: number | null; // for catastrophic: min |delta_mu|
  multiplier: number;
  active: boolean;              // if false → SHADOW_LOG_ONLY
}

export interface CsdVetoConfig {
  signal: "goal_diff" | "residuals";
  window: number;
  min_obs: number;
  recent_block: number;
  leakage_offset_sec: number;
  sign_flip_min_abs: number;
  regimes: Record<string, RegimeConfig>;
}

export interface FilterShieldConfig {
  version: string;
  csd_veto: CsdVetoConfig;
}

export interface CsdVetoResult {
  regime: "persistent_reversal" | "catastrophic" | "stable" | "insufficient_n";
  multiplier: number;            // [0.5, 1.0]
  shadow: boolean;               // true if SHADOW_LOG_ONLY (regime active=false)
  rho_1: number | null;
  delta_mu: number | null;
  sign_flipped: boolean;
  n_obs: number;
  raw_series: number[];          // for epistemic_trails logging
}

export interface ShieldVeto {
  name: string;
  multiplier: number;            // [0.0, 1.0]
  reason: string;
  appliesTo: BetSide[];
  rawDiagnostic: Record<string, unknown>;
  shadow: boolean;
}

export interface ShieldResult {
  effectiveMultiplier: number;
  haircutPct: number;
  appliedVetoes: ShieldVeto[];
  shadowVetoes: ShieldVeto[];
  betSide: BetSide;
}

// ──────────────────────────────────────────────────────────────────────
// Config loader (module-level cache — same pattern as calibration.ts)
// ──────────────────────────────────────────────────────────────────────

let CONFIG: FilterShieldConfig | null = null;

/**
 * Load filter-shield-config.json into module-level state.
 * Called from AppContext bootstrap (alongside calibration_curves.json load).
 *
 * Returns true on success, false on failure (logged via modelErrors).
 * Failure-safe: if not loaded, compute functions return passthrough multiplier 1.0.
 *
 * Validates nested types — without this, malformed JSON (e.g. multiplier as
 * string, acf_max missing) compiles fine via `as` cast but crashes at runtime
 * during downstream computeCsdVeto evaluation.
 */
export function loadFilterShieldConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "string") return false;

  const csd = obj.csd_veto as Record<string, unknown> | undefined;
  if (!csd || typeof csd !== "object") return false;

  // Required numeric fields on csd_veto root
  const numFields = ["window", "min_obs", "recent_block",
                     "leakage_offset_sec", "sign_flip_min_abs"] as const;
  for (const f of numFields) {
    if (typeof csd[f] !== "number" || !Number.isFinite(csd[f] as number)) {
      return false;
    }
  }
  if (typeof csd.signal !== "string") return false;

  // Regimes: at least persistent_reversal + catastrophic must exist with correct shape
  const regimes = csd.regimes as Record<string, unknown> | undefined;
  if (!regimes || typeof regimes !== "object") return false;

  for (const regimeName of Object.keys(regimes)) {
    const r = regimes[regimeName] as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") return false;
    if (typeof r.multiplier !== "number" || !Number.isFinite(r.multiplier as number)) return false;
    if (typeof r.active !== "boolean") return false;
    // acf_max / acf_max_abs / delta_min_abs: number-or-null (regime-specific)
    for (const optField of ["acf_max", "acf_max_abs", "delta_min_abs"] as const) {
      const v = r[optField];
      if (v !== undefined && v !== null && typeof v !== "number") return false;
    }
  }

  CONFIG = raw as FilterShieldConfig;
  return true;
}

export function getFilterShieldConfig(): FilterShieldConfig | null {
  return CONFIG;
}

export function isFilterShieldLoaded(): boolean {
  return CONFIG !== null;
}

// ──────────────────────────────────────────────────────────────────────
// Core math — pure functions, parity-tested with Python at 1e-9 tolerance
// ──────────────────────────────────────────────────────────────────────

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Lag-1 Pearson autocorrelation. Numerically identical to numpy.corrcoef.
 */
function lag1Acf(series: readonly number[]): number {
  const n = series.length;
  if (n < 2) return 0;
  const lead = series.slice(1);
  const lag = series.slice(0, n - 1);
  const meanLead = lead.reduce((a, b) => a + b, 0) / lead.length;
  const meanLag = lag.reduce((a, b) => a + b, 0) / lag.length;

  let num = 0;
  let varLead = 0;
  let varLag = 0;
  for (let i = 0; i < lead.length; i++) {
    const dLead = lead[i] - meanLead;
    const dLag = lag[i] - meanLag;
    num += dLag * dLead;
    varLead += dLead * dLead;
    varLag += dLag * dLag;
  }
  if (varLead < 1e-18 || varLag < 1e-18) return 0;
  const denom = Math.sqrt(varLead * varLag);
  const rho = num / denom;
  return Math.max(-1, Math.min(1, rho));
}

/**
 * Compute (rho_1, delta_mu, sign_flipped, n_obs) from a chronological series.
 * Internal helper — exported only for testing.
 */
export function _computeCsdFeatures(
  series: readonly number[],
  opts: { minObs: number; recentBlock: number; signFlipMinAbs: number },
): { rho_1: number; delta_mu: number; sign_flipped: boolean; n_obs: number } {
  const n = series.length;
  if (n < opts.minObs) {
    return { rho_1: 0, delta_mu: 0, sign_flipped: false, n_obs: n };
  }
  const rho_1 = lag1Acf(series);
  const recent = series.slice(n - opts.recentBlock);
  const prior = series.slice(0, n - opts.recentBlock);
  if (prior.length === 0) {
    return { rho_1, delta_mu: 0, sign_flipped: false, n_obs: n };
  }
  const muRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const muPrior = prior.reduce((a, b) => a + b, 0) / prior.length;
  const delta_mu = muRecent - muPrior;

  const sign_flipped = (
    Math.abs(muRecent) > opts.signFlipMinAbs
    && Math.abs(muPrior) > opts.signFlipMinAbs
    && Math.sign(muRecent) !== Math.sign(muPrior)
  );

  return { rho_1, delta_mu, sign_flipped, n_obs: n };
}

/**
 * Classify a team's last-N goal_diff series into a CSD regime.
 *
 * series: chronological [oldest, ..., most_recent], length >= 1.
 *         Element_i = goals_for_i - goals_against_i for that match.
 *
 * Returns CsdVetoResult with regime label + multiplier (active or shadow).
 *
 * If config is not loaded → returns insufficient_n with multiplier 1.0 (passthrough).
 */
export function computeCsdVeto(series: readonly number[]): CsdVetoResult {
  if (!CONFIG) {
    return {
      regime: "insufficient_n", multiplier: 1.0, shadow: false,
      rho_1: null, delta_mu: null, sign_flipped: false, n_obs: series.length,
      raw_series: [...series],
    };
  }
  const cfg = CONFIG.csd_veto;
  const features = _computeCsdFeatures(series, {
    minObs: cfg.min_obs,
    recentBlock: cfg.recent_block,
    signFlipMinAbs: cfg.sign_flip_min_abs,
  });

  if (features.n_obs < cfg.min_obs) {
    return {
      regime: "insufficient_n", multiplier: 1.0, shadow: false,
      rho_1: null, delta_mu: null, sign_flipped: false, n_obs: features.n_obs,
      raw_series: [...series],
    };
  }

  // Priority: persistent_reversal > catastrophic > stable (stronger empirical signal first)
  const pr = cfg.regimes["persistent_reversal"];
  if (pr && pr.acf_max !== null
      && features.rho_1 < pr.acf_max && features.sign_flipped) {
    return {
      regime: "persistent_reversal",
      multiplier: pr.active ? pr.multiplier : 1.0,
      shadow: !pr.active,
      rho_1: features.rho_1,
      delta_mu: features.delta_mu,
      sign_flipped: features.sign_flipped,
      n_obs: features.n_obs,
      raw_series: [...series],
    };
  }

  const cat = cfg.regimes["catastrophic"];
  if (cat && cat.acf_max_abs !== null && cat.delta_min_abs !== null
      && Math.abs(features.rho_1) < cat.acf_max_abs
      && features.sign_flipped
      && Math.abs(features.delta_mu) > cat.delta_min_abs) {
    return {
      regime: "catastrophic",
      multiplier: cat.active ? cat.multiplier : 1.0,
      shadow: !cat.active,
      rho_1: features.rho_1,
      delta_mu: features.delta_mu,
      sign_flipped: features.sign_flipped,
      n_obs: features.n_obs,
      raw_series: [...series],
    };
  }

  return {
    regime: "stable", multiplier: 1.0, shadow: false,
    rho_1: features.rho_1,
    delta_mu: features.delta_mu,
    sign_flipped: features.sign_flipped,
    n_obs: features.n_obs,
    raw_series: [...series],
  };
}

/**
 * Convert per-team CSD result → ShieldVeto for orchestrator consumption.
 *
 * Maps team-side asymmetrically:
 *   home team in regime → veto applies to "home" + "draw" markets
 *   away team in regime → veto applies to "away" + "draw" markets
 *
 * Returns null if regime is stable/insufficient_n (no veto needed).
 */
export function csdVetoToShieldVeto(
  result: CsdVetoResult,
  teamSide: "home" | "away",
  matchKey: string,
): ShieldVeto | null {
  if (result.regime === "stable" || result.regime === "insufficient_n") {
    return null;
  }
  const affected: BetSide[] = teamSide === "home"
    ? ["home", "draw"]
    : ["away", "draw"];

  return {
    name: `CSD_REGIME_SHIFT:${result.regime}:${teamSide}`,
    multiplier: result.multiplier,
    reason: `CSD ${result.regime} on ${teamSide}-side: `
      + `rho_1=${(result.rho_1 ?? 0).toFixed(3)}, `
      + `delta_mu=${(result.delta_mu ?? 0).toFixed(2)}, `
      + `sign_flip=${result.sign_flipped}, n=${result.n_obs}`,
    appliesTo: affected,
    rawDiagnostic: {
      regime: result.regime,
      rho_1: result.rho_1,
      delta_mu: result.delta_mu,
      sign_flipped: result.sign_flipped,
      n_obs: result.n_obs,
      team_side: teamSide,
      match_key: matchKey,
    },
    shadow: result.shadow,
  };
}

/**
 * Min-pool veto orchestrator. MIN over multipliers (worst-veto wins).
 * NOT product, NOT sum, NOT mean — see v1.1 Asymmetric Negation Protocol M7.
 *
 * Shadow vetoes are returned separately (for epistemic_trails logging)
 * but DO NOT alter the effective multiplier.
 */
export function applyFilterShield(
  vetoes: readonly ShieldVeto[],
  betSide: BetSide,
): ShieldResult {
  const relevantActive = vetoes.filter(
    v => v.appliesTo.includes(betSide) && !v.shadow,
  );
  const relevantShadow = vetoes.filter(
    v => v.appliesTo.includes(betSide) && v.shadow,
  );

  if (relevantActive.length === 0) {
    return {
      effectiveMultiplier: 1.0,
      haircutPct: 0.0,
      appliedVetoes: [],
      shadowVetoes: relevantShadow,
      betSide,
    };
  }

  // Defensive clamp before min-pool
  const minMult = relevantActive.reduce(
    (m, v) => Math.min(m, clamp01(v.multiplier)),
    1.0,
  );
  return {
    effectiveMultiplier: minMult,
    haircutPct: (1.0 - minMult) * 100.0,
    appliedVetoes: relevantActive,
    shadowVetoes: relevantShadow,
    betSide,
  };
}

/**
 * Convenience: given last-N goal_diff series for both teams, produce
 * vetoes ready to feed into applyFilterShield. Returns [] if config not loaded.
 *
 * Use this from MatchdayContext or Goldilocks page:
 *   const vetoes = buildCsdVetoes(homeSeries, awaySeries, matchKey);
 *   const home = applyFilterShield(vetoes, "home");
 *   const final = baseKelly * home.effectiveMultiplier;
 */
export function buildCsdVetoes(
  homeGoalDiffSeries: readonly number[],
  awayGoalDiffSeries: readonly number[],
  matchKey: string,
): ShieldVeto[] {
  if (!isFilterShieldLoaded()) return [];
  const out: ShieldVeto[] = [];
  const homeResult = computeCsdVeto(homeGoalDiffSeries);
  const homeVeto = csdVetoToShieldVeto(homeResult, "home", matchKey);
  if (homeVeto) out.push(homeVeto);
  const awayResult = computeCsdVeto(awayGoalDiffSeries);
  const awayVeto = csdVetoToShieldVeto(awayResult, "away", matchKey);
  if (awayVeto) out.push(awayVeto);
  return out;
}

/**
 * Convert a ShieldVeto into the EpistemicTrail JSON shape expected by
 * `epistemic_trails` table + `/api/persist-trails` route.
 *
 * Schema-contract details (see migration-epistemic-trails.sql + v1.1 protocol):
 *   - `trapKind`: derived from veto.name by stripping the per-instance
 *     team-side suffix so burn-in cron can aggregate by trap-class.
 *     "CSD_REGIME_SHIFT:persistent_reversal:home" → "CSD_REGIME_SHIFT:persistent_reversal"
 *   - `matchKey`: canonical FODZE format (caller passes this)
 *   - `matchKickoff`: Unix epoch SECONDS (NOT ms — CLV-decay cron filters on this)
 *   - `detectedAt`: Unix epoch MILLISECONDS (UNIQUE part)
 *   - `rawSignals`: numeric-only. We extract rho_1/delta_mu/n_obs/sign_flip(as 0/1)
 *     from rawDiagnostic + add multiplier as audit. Bools coerced to 0/1.
 *
 * Used by /goldilocks page-load batched POST and any other persistence path.
 */
export function shieldVetoToTrail(
  veto: ShieldVeto,
  matchKey: string,
  matchKickoffSec: number,
  predictedHWRate: number,
): {
  trapKind: string;
  matchKey: string;
  matchKickoff: number;
  detectedAt: number;
  rawSignals: Record<string, number>;
  predictedHWRate: number;
  shadow: boolean;
} {
  // "CSD_REGIME_SHIFT:persistent_reversal:home" → "CSD_REGIME_SHIFT:persistent_reversal"
  const parts = veto.name.split(":");
  const trapKind = parts.length >= 2 ? parts.slice(0, 2).join(":") : veto.name;

  // Convert raw_diagnostic to numeric-only — required by JSONB contract for
  // burn-in cron's mean/sum aggregation. Non-numeric fields (team_side,
  // match_key, regime label) are dropped here; trapKind carries the same info.
  const diag = veto.rawDiagnostic as Record<string, unknown>;
  const numFields: Record<string, number> = {};
  for (const [k, v] of Object.entries(diag)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      numFields[k] = v;
    } else if (typeof v === "boolean") {
      numFields[k] = v ? 1 : 0;
    }
  }
  numFields.multiplier = veto.multiplier;

  return {
    trapKind,
    matchKey,
    matchKickoff: Math.floor(matchKickoffSec),  // defensive: enforce SECONDS
    detectedAt: Date.now(),                      // MILLISECONDS
    rawSignals: numFields,
    predictedHWRate: Math.max(0, Math.min(1, predictedHWRate)),
    shadow: veto.shadow,
  };
}
