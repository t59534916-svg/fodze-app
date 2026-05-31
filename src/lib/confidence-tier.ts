// ─────────────────────────────────────────────────────────────────────
// Confidence-Tier — single source of truth for the prediction-confidence
// badge (MatchDetail full badge + MatchCard compact list pill).
//
// The top 1X2 probability IS the confidence of the tip. The tier boundaries +
// historical hit-rate claims below are CALIBRATED against the REAL production
// path: dev-03 (default engine) λ→Dixon-Coles, then Benter-blend toward
// Pinnacle once sharp odds exist (= what `calc.mk` carries; NOT isotonic —
// that is Track-B / Kelly-only). Measured on 25/26 (prod artifact, fully OOT)
// + 24/25 (dev-03-2h OOT) via
// tools/v4/diagnostics/validate_confidence_production_path.py.
//
// The `claim` values are CONSERVATIVE FLOORS — the Benter blend IMPROVES Brier
// (0.619→0.604) and lifts the HOCH tier to ~76% mean (25/26 78.7% · 24/25
// 73.5% OOT); MITTEL/NIEDRIG/TOSS-UP hold within ±3pp of their claim. CORE
// MESSAGE: only HOCH (≥65%) is clearly above-average; below it is only just
// over 50%. Validated 2026-05-28, see docs/FORECAST-QUALITY-ANALYSIS.md.
//
// ENGINE-SCOPE CAVEAT (2026-05-31): these claims are validated on the dev-03
// path (the production default). The dev-03 ⊕ dev-09 BLEND engine is the
// validated-best FORECASTER (lower Brier), but it uses a raw λ-average, so
// these tier hit-rates are only an APPROXIMATION for the Blend — not
// blend-specific-validated. The blend-specific re-validation is codified in
// tools/v4/diagnostics/blend_confidence_calibration.py (runnable once the
// 1.13 GB Sofa mirror + Pinnacle parquets are present, i.e. at season start).
// Until then, the Blend badge cites these dev-03 numbers as a labelled proxy.
//
// Colors live in the components (design tokens in MatchDetail, raw hex in
// MatchCard per that file's convention); THIS module owns the drift-prone
// parts — the boundaries and the hit-rate claims — so they cannot diverge.
// ─────────────────────────────────────────────────────────────────────

export type ConfTierKey = "HOCH" | "MITTEL" | "NIEDRIG" | "TOSS_UP";

export interface ConfTier {
  /** Stable key for color mapping in the consuming component. */
  key: ConfTierKey;
  /** Display label (TOSS_UP renders as "TOSS-UP"). */
  label: string;
  /** Historical hit-rate phrase for the badge subtitle / pill tooltip. */
  hist: string;
  /** Calibrated production-path hit-rate floor, in [0, 1]. */
  claim: number;
}

/**
 * Map a top-outcome probability to its calibrated confidence tier.
 * `p` is expected in [0, 1]; values outside are clamped by the boundary
 * comparisons (≥0.65 HOCH … else TOSS-UP), so NaN-safe callers should guard
 * upstream (NaN falls through every `>=` to TOSS-UP).
 */
export function confidenceTier(p: number): ConfTier {
  if (p >= 0.65) return { key: "HOCH", label: "HOCH", hist: "histor. ~73% Treffer", claim: 0.73 };
  if (p >= 0.55) return { key: "MITTEL", label: "MITTEL", hist: "histor. ~53%", claim: 0.53 };
  if (p >= 0.45) return { key: "NIEDRIG", label: "NIEDRIG", hist: "histor. ~48%", claim: 0.48 };
  return { key: "TOSS_UP", label: "TOSS-UP", hist: "offen ~40%", claim: 0.40 };
}
