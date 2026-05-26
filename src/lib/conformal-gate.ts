// ═══════════════════════════════════════════════════════════════════════
// FODZE Conformal Prediction Staking Gate (Phase 2.5)
//
// Angelopoulos & Bates (2023) conformal prediction: given per-league
// calibration quantiles q_g fitted on OOT residuals, the prediction set
// for a new match at confidence (1-α) is
//
//     S(x) = { k : (1 - p_k) ≤ q_g }
//
// where p_k is the model's posterior for outcome k ∈ {H, D, A}.
// Mondrian conformal = compute q per league (the `g` subscript) so a
// volatile League-Two doesn't dilute EPL's coverage guarantee.
//
// Staking-policy use: only place a 1X2 bet when the set is a singleton
// — that's the strongest correctness guarantee conformal gives us.
// Weaker mode: DAMPEN Kelly when set-size > 1 (keep betting, reduce
// stake proportionally). Both modes are feature-flagged; default is OFF
// so the pipeline stays bit-identical to pre-upgrade when nothing is
// loaded / the env var is unset.
//
// Placeholder data (public/conformal-quantiles.json) uses quantile 0.50
// globally which makes the set-of-one-class path the common case — i.e.
// the gate is permissive until real quantiles are trained.
// ═══════════════════════════════════════════════════════════════════════

export interface ConformalQuantilesJSON {
  _version: 1;
  _meta?: { method?: string; alpha_default?: number; trained_at?: string | null };
  // Global fallback: string-keyed by alpha (e.g. "0.10"), value is the q
  // threshold for nonconformity score = 1 - p.
  global: Record<string, number>;
  // Per-league override — { league_code: { "0.10": q, ... } }.
  // Optional: the loader defaults missing leagues to {} so fresh fits
  // can ship a global-only payload before per-league quantiles are
  // reliable (Mondrian falls back to global per the spec).
  leagues?: Record<string, Record<string, number>>;
  // ─── Optional Over/Under 2.5 binary conformal section ────────────
  // Fitted by tools/fit_conformal_ou25.py since 2026-05-25. Schema
  // mirrors the 1X2 section but applies to the binary OU25 market.
  // Scoring: s_i = 1 - p[y_i] where y_i ∈ {0=under, 1=over}.
  // Prediction set at confidence (1-α): { k : p_k >= 1 - q_g }.
  // Absent on legacy fits → consumers fall back to mode="off".
  ou25?: {
    _meta?: { method?: string; market?: string; trained_at?: string | null };
    global?: Record<string, number>;
    leagues?: Record<string, Record<string, number>>;
  };
}

export type Outcome = "H" | "D" | "A";
export type ConformalMode = "off" | "warn" | "enforce" | "dampen";

export interface ConformalGateResult {
  inSet: Outcome[];           // outcomes whose (1-p) ≤ q
  isSingleton: boolean;       // |S| === 1
  setSize: number;
  quantile: number;           // the q actually used
  cluster: "league" | "global" | "default";
  applied: boolean;           // true when real data gated the decision
}

// ─── Module state ──────────────────────────────────────────────────

let QUANTILES: ConformalQuantilesJSON | null = null;
let MODE: ConformalMode = "off";
// Default alpha — can be overridden per-call. Matches the 90% coverage
// convention used almost everywhere in the conformal literature.
const DEFAULT_ALPHA = 0.10;
// Permissive fallback: q=0.50 means only arg-max gets in → always singleton.
// Ensures the gate never blocks a bet when nothing was loaded.
const FALLBACK_QUANTILE = 0.50;

export function loadConformalQuantiles(json: ConformalQuantilesJSON): void {
  if (!json || json._version !== 1 || !json.global) {
    throw new Error("Invalid conformal-quantiles schema (need _version=1 + global)");
  }
  QUANTILES = { ...json, leagues: json.leagues || {} };
}

export function setConformalMode(mode: ConformalMode): void { MODE = mode; }
export function getConformalMode(): ConformalMode { return MODE; }
export function isConformalLoaded(): boolean { return QUANTILES !== null; }
export function resetConformal(): void { QUANTILES = null; MODE = "off"; }

// ─── Core API ──────────────────────────────────────────────────────

function alphaKey(alpha: number): string {
  // Float keys are brittle — standardise to two-decimal string.
  return alpha.toFixed(2);
}

function lookupQuantile(leagueCode: string | undefined, alpha: number): { q: number; cluster: ConformalGateResult["cluster"] } {
  if (!QUANTILES) return { q: FALLBACK_QUANTILE, cluster: "default" };
  const key = alphaKey(alpha);
  const perLeague = leagueCode && QUANTILES.leagues?.[leagueCode];
  if (perLeague && typeof perLeague[key] === "number") {
    return { q: perLeague[key], cluster: "league" };
  }
  if (typeof QUANTILES.global[key] === "number") {
    return { q: QUANTILES.global[key], cluster: "global" };
  }
  return { q: FALLBACK_QUANTILE, cluster: "default" };
}

/**
 * Classify a prediction against the per-league conformal quantile at
 * the requested confidence (1-α). Returns the prediction set + a
 * singleton flag the staking layer can gate on.
 *
 * Never throws. Degrades to singleton-around-argmax when nothing was
 * loaded — caller sees `applied: false` so a shadow-mode UI can
 * highlight "no conformal data".
 */
export function conformalGate(
  probs: { H: number; D: number; A: number },
  leagueCode?: string,
  alpha: number = DEFAULT_ALPHA,
): ConformalGateResult {
  const { q, cluster } = lookupQuantile(leagueCode, alpha);
  const scores: Array<{ k: Outcome; s: number }> = [
    { k: "H", s: 1 - probs.H },
    { k: "D", s: 1 - probs.D },
    { k: "A", s: 1 - probs.A },
  ];
  const inSet = scores.filter(x => x.s <= q).map(x => x.k);
  // Defensive: if quantile is so tight that NO outcome qualifies, keep
  // the arg-max (otherwise every bet would be blocked). This is the
  // standard recourse in MAPIE when q lands below the smallest score.
  let set: Outcome[] = inSet;
  if (set.length === 0) {
    const argmax = scores.reduce((best, x) => (x.s < best.s ? x : best)).k;
    set = [argmax];
  }
  return {
    inSet: set,
    isSingleton: set.length === 1,
    setSize: set.length,
    quantile: q,
    cluster,
    applied: cluster !== "default",
  };
}

/**
 * Kelly-dampening factor derived from the conformal set size. Larger
 * sets = more model uncertainty → smaller Kelly. Linear scaling:
 *   |S|=1 → 1.0   (no change, the model is confident)
 *   |S|=2 → 0.6
 *   |S|=3 → 0.3
 *
 * Mode handling:
 *   "off"     → 1.0 always (feature disabled)
 *   "warn"    → 1.0 (computation happens, but the staking layer ignores it)
 *   "dampen"  → return the scaled factor above
 *   "enforce" → binary: 1.0 if singleton, 0.0 otherwise (refuses the bet)
 *
 * `mode` defaults to getConformalMode() so most callers just pass probs.
 */
export function conformalKellyFactor(
  probs: { H: number; D: number; A: number },
  leagueCode?: string,
  alpha: number = DEFAULT_ALPHA,
  mode: ConformalMode = MODE,
): number {
  if (mode === "off" || mode === "warn") return 1.0;
  const gate = conformalGate(probs, leagueCode, alpha);
  if (mode === "enforce") return gate.isSingleton ? 1.0 : 0.0;
  // dampen mode
  if (gate.setSize <= 1) return 1.0;
  if (gate.setSize === 2) return 0.6;
  return 0.3;
}

// ─── Over/Under 2.5 (binary) conformal gate ─────────────────────────
// Sibling of the 1X2 gate above. Binary case: outcomes are {over25,
// under25} with probabilities {p, 1-p}. Mondrian per-league quantiles
// fitted by tools/fit_conformal_ou25.py.

export interface ConformalGateOU25Result {
  inSet: Array<"over25" | "under25">;
  isSingleton: boolean;
  setSize: number;
  quantile: number;
  cluster: "league" | "global" | "default";
  applied: boolean;
}

function lookupQuantileOU25(leagueCode: string | undefined, alpha: number):
    { q: number; cluster: ConformalGateOU25Result["cluster"] } {
  if (!QUANTILES?.ou25) return { q: FALLBACK_QUANTILE, cluster: "default" };
  const key = alphaKey(alpha);
  // ou25 fitter writes keys as "0.05", "0.1", "0.2" (one digit after 0.1).
  // Tolerate both "0.10" (alphaKey) and "0.1" by checking both forms.
  const altKey = alpha === 0.1 ? "0.1" : alpha === 0.2 ? "0.2" : key;
  const perLeague = leagueCode && QUANTILES.ou25.leagues?.[leagueCode];
  if (perLeague) {
    const v = perLeague[key] ?? perLeague[altKey];
    if (typeof v === "number") return { q: v, cluster: "league" };
  }
  if (QUANTILES.ou25.global) {
    const v = QUANTILES.ou25.global[key] ?? QUANTILES.ou25.global[altKey];
    if (typeof v === "number") return { q: v, cluster: "global" };
  }
  return { q: FALLBACK_QUANTILE, cluster: "default" };
}

/**
 * Binary Over/Under 2.5 conformal gate.
 *
 * Scoring (per Angelopoulos & Bates 2023 sec 2):
 *   s_over = 1 - p_o25  (score for "is over the true class?")
 *   s_under = p_o25
 *
 * Set membership: class k is INCLUDED in S iff s_k ≤ q_g, i.e.
 *   p_o25 ≥ 1 - q  → over25 in set
 *   p_o25 ≤ q       → under25 in set
 *
 * Singleton ⇒ confident → no Kelly dampening. Both-in-set ⇒ uncertain.
 * Defensive: if neither qualifies (q so tight nothing survives), keep
 * arg-max (matches 1X2 fallback).
 */
export function conformalGateOU25(
  probOver25: number,
  leagueCode?: string,
  alpha: number = DEFAULT_ALPHA,
): ConformalGateOU25Result {
  const { q, cluster } = lookupQuantileOU25(leagueCode, alpha);
  const inSet: Array<"over25" | "under25"> = [];
  if (probOver25 >= 1 - q) inSet.push("over25");
  if (probOver25 <= q) inSet.push("under25");
  if (inSet.length === 0) {
    inSet.push(probOver25 >= 0.5 ? "over25" : "under25");
  }
  return {
    inSet,
    isSingleton: inSet.length === 1,
    setSize: inSet.length,
    quantile: q,
    cluster,
    applied: cluster !== "default",
  };
}

/**
 * Kelly-dampening factor for Over/Under 2.5 bets. Same semantics as
 * conformalKellyFactor() for 1X2 but the set has at most 2 outcomes:
 *   isSingleton → 1.0
 *   both in set (uncertain) → mode-dependent:
 *     "dampen" → 0.6 (analog to 1X2 set-size=2)
 *     "enforce" → 0.0
 *
 * Falls back to 1.0 when:
 *   * mode is "off" or "warn"
 *   * QUANTILES.ou25 not loaded (cluster="default")
 */
export function conformalKellyFactorOU25(
  probOver25: number,
  leagueCode?: string,
  alpha: number = DEFAULT_ALPHA,
  mode: ConformalMode = MODE,
): number {
  if (mode === "off" || mode === "warn") return 1.0;
  if (!QUANTILES?.ou25) return 1.0;  // section not loaded → no-op
  const gate = conformalGateOU25(probOver25, leagueCode, alpha);
  if (!gate.applied) return 1.0;
  if (mode === "enforce") return gate.isSingleton ? 1.0 : 0.0;
  // dampen mode
  return gate.isSingleton ? 1.0 : 0.6;
}

export function isConformalOU25Loaded(): boolean {
  return QUANTILES?.ou25 != null;
}
