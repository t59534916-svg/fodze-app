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
// (0.619→0.604); MITTEL/NIEDRIG/TOSS-UP hold within ±3pp of their claim. CORE
// MESSAGE: only HOCH (≥65%) is clearly above-average; below it is only just
// over 50%. Validated 2026-05-28, see docs/FORECAST-QUALITY-ANALYSIS.md.
//
// HOCH=0.73 IS THE CROSS-SEASON FLOOR — DO NOT RAISE IT (re-validated
// 2026-06-01, validate_confidence_production_path.py). The full HOCH grid across
// {season} × {display path} is:
//        25/26 blended(+odds) 78.7%  ·  25/26 raw(no-odds) 73.7%
//        24/25 blended(+odds) 73.5%  ·  24/25 raw(no-odds) 68.9%
//   → mean 73.7% · median 73.6% · MIN 68.9% (24/25 raw OOT).
// 0.73 is the median and the with-odds cross-season floor (min 73.5%). The
// 78.7% is the SINGLE BEST CELL (25/26 + odds only) — a diagnostic verdict that
// reads "HOCH 78.7% > claim → fix badge" is ONE-SIDED (it checks only that one
// cell). Raising the claim to ~76% would OVER-claim three of four cells: the
// no-odds fallback path (73.7%/68.9%), the wired Blend engine (shows the RAW
// λ-blend — Benter touches only bets, not the badge), and the whole 24/25
// cross-season holdout. The badge is honest precisely because 0.73 sits at the
// central/floor of the spread, not at its peak.
//
// ALSO VALIDATED FOR THE λ-BLENDS (2026-05-31, blend_confidence_calibration.py):
// the wired "Blend (dev-03⊕v2)" engine shows the RAW λ-blend as its badge mk
// (Benter adjusts only its bets, not the display — see the blendCalc branch in
// MatchdayContext), and on 25/26 OOT every tier meets/exceeds these claims —
// HOCH 76.4% (n=386), MITTEL 61.9% (n=651) — so the dev-03 claims are a safe,
// mildly conservative approximation for it. The research blend dev-03⊕dev-09
// reproduces FORECAST §5 (HOCH 74.5% 25/26 · 70.7% 24/25). Claims stay
// dev-03-anchored: the badge reads calc.mk for ANY selected engine, so they
// must not be re-tuned per engine.
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
