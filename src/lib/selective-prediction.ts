// ═══════════════════════════════════════════════════════════════════════
// Selective Prediction — turn the (validated) confidence tier into an active
// selection mechanism, not just a passive badge.
//
// WHY THIS EXISTS
// The forecast-quality analysis found the highest-ROI lever is NOT a better λ
// — it's choosing WHICH matches to act on. The only empirically VALIDATED
// selection axis is the calibrated confidence tier:
//   ≥65% top-pick prob → ~73% actual hit (24/25 OOT conservative floor)
//   (validate_confidence_production_path.py, 2026-05-29; see confidence-tier.ts)
// So this module ranks/filters matches by that validated tier and reports an
// HONEST expected-hit floor for the selected subset.
//
// WHAT THIS DELIBERATELY DOES *NOT* DO
// docs/HC-PRECISION-PLAYBOOK.md found that of 16 candidate trap-modulators only
// ONE (xg_regression_to_mean) survived Holm-Bonferroni, and even that is an
// AUROC-0.58 discriminator — useful research, but NOT a fitted production model,
// and validating/combining such signals needs the gitignored backtest corpus
// (parquets / SQLite mirror) which isn't available at runtime. Per the project's
// 5-Gate falsification protocol we therefore do NOT fold any unvalidated signal
// into the hit-rate claim. Market consensus is offered ONLY as an optional,
// clearly-labeled refinement FILTER — it can gate selection when the caller
// opts in, but it never changes the reported expected-hit floor.
// ═══════════════════════════════════════════════════════════════════════

import { confidenceTier, type ConfTierKey } from "./confidence-tier";

/** Conviction level for a single match's top 1X2 pick. Derived purely from
 *  the validated confidence tier (+ an optional, non-scoring market filter). */
export type ConvictionLevel = "TOP" | "SOLIDE" | "SPEKULATIV" | "SKIP";

export interface SelectablePick {
  /** Benter-blended max(H,D,A) — the SAME number the confidence badge shows.
   *  Null/NaN (e.g. no-odds match) ⇒ SKIP. */
  topProb: number | null;
  /** OPTIONAL refinement only: does the sharp (Pinnacle vig-removed) top pick
   *  agree with the model's top pick? `null`/`undefined` = unknown (no sharp
   *  odds). NEVER affects `expectedHitFloor` — it can only gate selection when
   *  the caller opts in via `requireMarketConsensus`. */
  marketAgrees?: boolean | null;
}

export interface ConvictionResult {
  level: ConvictionLevel;
  /** Stable confidence-tier key (HOCH/MITTEL/NIEDRIG/TOSS_UP) for color reuse. */
  tierKey: ConfTierKey;
  /** The validated hit-rate floor for this pick's tier (for honest display). */
  expectedHitFloor: number;
  /** Mirror of the input — true only when sharp odds confirm the model pick. */
  marketConfirmed: boolean;
}

const TIER_TO_LEVEL: Record<ConfTierKey, ConvictionLevel> = {
  HOCH: "TOP",
  MITTEL: "SOLIDE",
  NIEDRIG: "SPEKULATIV",
  TOSS_UP: "SKIP",
};

/**
 * Classify one pick's conviction from its (validated) confidence tier.
 *
 * Pure mapping: tier → level + the tier's empirical hit-floor (`claim`). The
 * optional market-agreement flag is surfaced as `marketConfirmed` for the UI
 * but does NOT change the level or the hit-floor (statistical honesty).
 */
export function convictionForPick(pick: SelectablePick): ConvictionResult {
  if (pick.topProb == null || !Number.isFinite(pick.topProb)) {
    return { level: "SKIP", tierKey: "TOSS_UP", expectedHitFloor: 0, marketConfirmed: false };
  }
  const tier = confidenceTier(pick.topProb);
  return {
    level: TIER_TO_LEVEL[tier.key],
    tierKey: tier.key,
    expectedHitFloor: tier.claim,
    marketConfirmed: pick.marketAgrees === true,
  };
}

export interface SelectOptions {
  /** Minimum conviction level to include. Default "TOP" (the validated ≥65%
   *  / ~73% bucket — the whole point of selective prediction). */
  minLevel?: Exclude<ConvictionLevel, "SKIP">;
  /** When true, additionally require sharp-market agreement. Heuristic
   *  refinement (NOT validated as a hit-rate multiplier) — picks with unknown
   *  market agreement (`null`) are EXCLUDED under this flag. Default false. */
  requireMarketConsensus?: boolean;
}

const LEVEL_RANK: Record<ConvictionLevel, number> = {
  SKIP: 0,
  SPEKULATIV: 1,
  SOLIDE: 2,
  TOP: 3,
};

/**
 * Select the high-conviction subset from a list of picks, preserving each
 * pick's original index (so callers can map back to their match array).
 *
 * Selection = conviction level ≥ minLevel, optionally AND market-confirmed.
 * Results are sorted by topProb descending (strongest forecast first).
 */
export function selectHighConviction<T extends SelectablePick>(
  picks: T[],
  opts: SelectOptions = {},
): { pick: T; index: number; conviction: ConvictionResult }[] {
  const minRank = LEVEL_RANK[opts.minLevel ?? "TOP"];
  const out: { pick: T; index: number; conviction: ConvictionResult }[] = [];
  picks.forEach((pick, index) => {
    const conviction = convictionForPick(pick);
    if (LEVEL_RANK[conviction.level] < minRank) return;
    if (opts.requireMarketConsensus && !conviction.marketConfirmed) return;
    out.push({ pick, index, conviction });
  });
  out.sort((a, b) => (b.pick.topProb ?? 0) - (a.pick.topProb ?? 0));
  return out;
}

/**
 * Honest blended expected-hit floor across a selected subset: the mean of the
 * per-pick validated tier floors. Returns null for an empty set (no claim).
 * Built ONLY from validated tier floors, never from the market heuristic.
 */
export function aggregateExpectedHitFloor(
  selected: { conviction: ConvictionResult }[],
): number | null {
  if (selected.length === 0) return null;
  const sum = selected.reduce((s, x) => s + x.conviction.expectedHitFloor, 0);
  return sum / selected.length;
}
