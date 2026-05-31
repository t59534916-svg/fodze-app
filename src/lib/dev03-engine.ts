// ═══════════════════════════════════════════════════════════════════════
// dev-03 Engine (FODZE/v4 cross-season-validated specialist)
//
// MatchCalc-shaped wrapper that combines:
//   - dev03-features.ts        (m2_lambda + Elo + Momentum cache lookup)
//   - dev03-runtime.ts         (5-bagged Bayesian Ensemble → λ_mean + σ²)
//   - dev03 m6_benter blend    (per-Liga log-pool toward Pinnacle)
//   - existing FODZE pipeline  (Dixon-Coles matrix, Goldilocks Kelly,
//                                Bets builder, league-liquidity gate)
//
// Money-Eval status (2026-05-25 audit, REVISED under 5-Gate Falsification):
// dev-03 has Holm-Bonferroni-validated positive ROI in 4 leagues
// (24/25 walkfwd + 25/26 holdout) — see `bet-edge-policy.ts`:
//   • la_liga         mean +36.27%  (n=46+59,  p_adj=0.000)
//   • scottish_prem   mean +36.17%  (n=16+34,  p_adj=0.000)
//   • bundesliga      mean +30.15%  (n=18+24,  p_adj=0.003)  [NEW vs prior]
//   • primeira_liga   mean +27.32%  (n=22+31,  p_adj=0.003)  [NEW vs prior]
// PREVIOUS 'validated' set (serie_a / epl / serie_b) REMOVED after walk-
// forward revealed catastrophic reversals (-14.5% / -34.5% / -13.1% on
// 24/25). For other leagues the engine still produces predictions but
// `bet-edge-policy` warns against actually betting them.
//
// Architecture choice — same MatchCalc + ensemble field shape as v2 so the
// rest of FODZE (Goldilocks UI, ConsensusBadge, /matchday, /performance)
// doesn't need to know it's a different engine. The variance from the
// 5-bagged ensemble feeds the CI bounds (no parametric bootstrap needed —
// the Bayesian Ensemble IS the variance estimate).
// ═══════════════════════════════════════════════════════════════════════

import {
  buildMatrix, deriveAllMarkets,
  calculateBetsEnhanced, vigAdjustBest, validateXGData,
  type EnhancedResult, type XGHistoryEntry,
} from "./dixon-coles";
import { getAlpha, type OverdispersionConfig } from "./neg-binomial";
import { dualTrackCalibrate } from "./calibration";
import { getLeagueLiquidityTier } from "./league-liquidity";
import {
  isDev03ModelLoaded,
  getDev03Rho,
  dev03Predict,
  dev03BenterBlend,
  type Dev03Prediction,
  type Dev03FeatureInput,
} from "./dev03-runtime";
import { dev03PredictAsync } from "./dev03-worker-client";
import {
  isFeatureCacheLoaded,
  buildDev03Features,
} from "./dev03-features";
import type { MatchCalc, MarketProbs } from "@/types/match";
import type { ShieldVeto } from "./filter-shield";

// ─── Input contract (matches MatchdayContext's `mlInputs` shape) ─────

export interface Dev03EngineInput {
  /** Required for fallback behaviour to match v2 */
  xgHS: number; xgaHC: number; hGames: number;
  xgAS: number; xgaAC: number; aGames: number;
  leagueAvg: number; homeFactor: number;
  league: string;
  tags: string[];
  hHistory?: XGHistoryEntry[];
  aHistory?: XGHistoryEntry[];
  homeTeam: string; awayTeam: string;
  season?: string;
  odds?: Record<string, number>;
  sharpOdds?: { h: number | null; d: number | null; a: number | null };
  fraction: number;
  options?: {
    overdispersion?: OverdispersionConfig;
  };
  // v1.2 Filter-Shield: see PoissonMLInput for contract
  shieldVetoes?: readonly ShieldVeto[];
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Compute a MatchCalc for one match using the dev-03 pipeline.
 *
 * Returns null when:
 *   - dev-03 model is not loaded (e.g. /dev03-model.json fetch failed)
 *   - feature cache is not loaded (e.g. /dev03-feature-cache.json missing)
 *   - either team has no xG-history (no GIGO — same as v2/v1)
 *
 * The MatchdayContext fallback wires this to ensemble when null.
 */
export function calcMatchDev03(input: Dev03EngineInput): MatchCalc | null {
  const stage1 = _prepareStage(input);
  if (!stage1) return null;
  const pred = dev03Predict(stage1.features);
  if (!pred) return null;
  return _finishCalc(input, pred);
}

/**
 * Async variant of `calcMatchDev03`. Off-main-thread predict via the
 * dev-03 Web Worker (falls back to sync `dev03Predict` if the worker is
 * unavailable — SSR, tests, CSP-blocked envs).
 *
 * Use this when computing a whole matchday to keep the React render
 * thread responsive. Single-match call sites can also use this safely
 * (postMessage round-trip is microsecond-fast).
 *
 * Identical output to sync `calcMatchDev03` for the same input — the
 * worker hosts the same dev03-runtime module; prediction math is
 * byte-equivalent.
 */
export async function calcMatchDev03Async(
  input: Dev03EngineInput,
): Promise<MatchCalc | null> {
  const stage1 = _prepareStage(input);
  if (!stage1) return null;
  const pred = await dev03PredictAsync(stage1.features);
  if (!pred) return null;
  return _finishCalc(input, pred);
}

interface Stage1 {
  features: Dev03FeatureInput;
}

/** Guards + feature build (sync, fast). Shared by sync + async paths. */
function _prepareStage(input: Dev03EngineInput): Stage1 | null {
  if (!isDev03ModelLoaded() || !isFeatureCacheLoaded()) return null;
  const hHasHistory = input.hHistory && input.hHistory.length > 0;
  const aHasHistory = input.aHistory && input.aHistory.length > 0;
  if (!hHasHistory || !aHasHistory) return null;
  const features = buildDev03Features({
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    league: input.league,
    hHistory: input.hHistory!,
    aHistory: input.aHistory!,
  });
  return { features };
}

/**
 * Given an input + finished prediction, build the full MatchCalc.
 *
 * Called by both `calcMatchDev03` (sync, after `dev03Predict`) and
 * `calcMatchDev03Async` (async, after `dev03PredictAsync`). Single
 * source of truth for the post-prediction pipeline.
 */
function _finishCalc(input: Dev03EngineInput, pred: Dev03Prediction): MatchCalc | null {
  const {
    league, odds, fraction, sharpOdds, options,
    shieldVetoes,
  } = input;

  const lambdaH = pred.lambdaH_mean;
  const lambdaA = pred.lambdaA_mean;
  // Std-dev from ensemble variance (5 bagged models)
  const sigmaH = Math.sqrt(pred.lambdaH_var);
  const sigmaA = Math.sqrt(pred.lambdaA_var);

  // ── 3. Dixon-Coles matrix with trained rho ──────────────────────
  const rho = getDev03Rho(); // -0.094 trained
  const alphaUsed = league ? getAlpha(league, options?.overdispersion) : 0;
  const matrix = buildMatrix(lambdaH, lambdaA, rho, alphaUsed);
  const matrixMk: MarketProbs = deriveAllMarkets(matrix);

  // ── 4. Confidence intervals from ensemble variance ──────────────
  // Use bagged-model variance directly (no parametric bootstrap — the
  // 5-seed ensemble IS the uncertainty estimate, much cleaner than v2's
  // noise-perturbation trick).
  const z = 1.645; // 90% CI (one-sided, consistent with v2)
  const ciH = {
    low: Math.max(0.1, lambdaH - z * sigmaH),
    mid: lambdaH,
    high: lambdaH + z * sigmaH,
    se: sigmaH,
  };
  const ciA = {
    low: Math.max(0.1, lambdaA - z * sigmaA),
    mid: lambdaA,
    high: lambdaA + z * sigmaA,
    se: sigmaA,
  };
  const mk_low = deriveAllMarkets(buildMatrix(ciH.low, ciA.high, rho, alphaUsed));
  const mk_high = deriveAllMarkets(buildMatrix(ciH.high, ciA.low, rho, alphaUsed));

  // ── 5. m6_benter blend (vig-removed market → log-pool) ──────────
  // The dev-03 specialist's published Money-Edge comes from this blend,
  // not from the raw model probs. When sharp odds are unavailable, fall
  // back to raw model probs (still better than nothing for the UI).
  let blendedMk: MarketProbs = matrixMk;
  let benterApplied = false;
  if (sharpOdds?.h && sharpOdds?.d && sharpOdds?.a) {
    const rawSH = 1 / sharpOdds.h;
    const rawSD = 1 / sharpOdds.d;
    const rawSA = 1 / sharpOdds.a;
    const total = rawSH + rawSD + rawSA;
    const pinnVigFree: [number, number, number] = [
      rawSH / total, rawSD / total, rawSA / total,
    ];
    const blended = dev03BenterBlend(
      [matrixMk.H, matrixMk.D, matrixMk.A],
      pinnVigFree,
      league,
    );
    if (blended) {
      blendedMk = { ...matrixMk, H: blended[0], D: blended[1], A: blended[2] };
      benterApplied = true;
    }
  }

  // ── 6. Dual-track calibration (Goldilocks Kelly track-B) ─────────
  // Track A = the BENTER-blended probs (dev-03's production-validated edge
  // source). dev-03 is a bypass engine, so Track B == Track A: the shared
  // ensemble-era isotonic is skipped (it degrades dev-03's blended posterior on
  // both Brier and ECE — see bypassSharedCalibration in calibration.ts). This
  // keeps the Goldilocks edge gate (uses Track B below) consistent with the
  // Kelly pModel from calculateBetsEnhanced (engine="dev-03" → also bypassed).
  const dualTrack = dualTrackCalibrate(blendedMk.H, blendedMk.D, blendedMk.A, league, "dev-03");
  const mk: MarketProbs = blendedMk;

  // ── 7. Bet generation ───────────────────────────────────────────
  const no: Record<string, number> = {};
  if (odds) {
    for (const k of ["h", "d", "a", "o25", "u25", "btts"]) {
      const v = odds[k]; if (v > 0) no[k] = v;
    }
  }
  const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;

  const pinOdds = sharpOdds?.h != null && sharpOdds?.d != null && sharpOdds?.a != null
    ? { sharp_h: sharpOdds.h, sharp_d: sharpOdds.d, sharp_a: sharpOdds.a }
    : undefined;
  // Pass engine="dev-03" so calculateBetsEnhanced's internal benterBlend
  // safely passes through (no "dev-03" key in benter-weights.json → returns
  // applied=false). We MUST NOT pass engine="ensemble" here — that would
  // cause `getBetas(engine="ensemble", league)` to lookup ensemble-trained
  // weights and apply a SECOND blend on top of our already-blended `mk`,
  // silently distorting Goldilocks edges. The dev03BenterBlend above is
  // the SOLE source of benter blending for this engine; calculateBetsEnhanced
  // sees the post-blend probs and operates on them as-is.
  const bets = calculateBetsEnhanced(
    mk, mk_low, mk_high, no, fraction, pinOdds, undefined, league, "dev-03",
    1, shieldVetoes,
  );

  // ── 7b. Goldilocks Edge Guard (per-Liga tier) ───────────────────
  if (sharpOdds?.h && sharpOdds?.d && sharpOdds?.a) {
    const rawSH = 1 / sharpOdds.h;
    const rawSD = 1 / sharpOdds.d;
    const rawSA = 1 / sharpOdds.a;
    const total = rawSH + rawSD + rawSA;
    const pinnVigFree = {
      H: rawSH / total, D: rawSD / total, A: rawSA / total,
    };

    for (const bet of bets) {
      const trackBP = bet.label === "Heim" ? dualTrack.trackB.H
                    : bet.label === "Unent." ? dualTrack.trackB.D
                    : bet.label === "Ausw." ? dualTrack.trackB.A
                    : null;
      const pinnP = bet.label === "Heim" ? pinnVigFree.H
                  : bet.label === "Unent." ? pinnVigFree.D
                  : bet.label === "Ausw." ? pinnVigFree.A
                  : null;
      if (trackBP === null || pinnP === null) continue;

      const edge = trackBP - pinnP;
      const tier = getLeagueLiquidityTier(league);
      if (edge < tier.goldilocksMin) {
        bet.isValue = false;
        bet.kelly = 0;
      } else if (edge > tier.trapHard) {
        bet.valueTrap = true;
        bet.valueTrapEdge = edge;
        bet.valueTrapReason = `Edge ${(edge * 100).toFixed(1)}% vs Pinnacle — wahrscheinlich fehlende Info`;
        bet.confidence = "NONE";
        bet.isValue = false;
        bet.kelly = 0;
      } else if (edge > tier.goldilocksMax) {
        // Soft-trap: skip without alarm
        bet.isValue = false;
        bet.kelly = 0;
      }
    }
  }

  // ── 8. Top scores ───────────────────────────────────────────────
  const topScores: { s: string; p: number }[] = [];
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      if (matrix[i]?.[j] > 0.005) {
        topScores.push({ s: `${i}:${j}`, p: matrix[i][j] });
      }
    }
  }
  topScores.sort((a, b) => b.p - a.p);

  // ── 9. EnhancedResult shell ─────────────────────────────────────
  const enh: EnhancedResult = {
    lambdaH_raw: pred.lambdaH_mean, lambdaA_raw: pred.lambdaA_mean,
    lambdaH_regressed: lambdaH, lambdaA_regressed: lambdaA,
    lambdaH_formed: lambdaH, lambdaA_formed: lambdaA,
    lambdaH, lambdaA,
    shrinkageH: 1, shrinkageA: 1,
    formH: { mult: 1, label: "—" }, formA: { mult: 1, label: "—" },
    tagCorrections: [], tagMultH: 1, tagMultA: 1,
    ciH, ciA, matrix, mk: matrixMk, mk_low, mk_high,
    sosApplied: false, absenceApplied: false,
    dynamicRho: rho,
    alphaUsed: alphaUsed > 0 ? alphaUsed : undefined,
  };

  // ── 10. Diagnostics envelope (for UI parity with other engines) ─
  const H_ci: [number, number] = [mk_low.H, mk_high.H];
  const D_ci: [number, number] = [mk_low.D, mk_high.D];
  const A_ci: [number, number] = [mk_low.A, mk_high.A];
  const O25_ci: [number, number] = [
    Math.min(mk_low.O25, mk_high.O25),
    Math.max(mk_low.O25, mk_high.O25),
  ];
  const uncertainty = (H_ci[1] - H_ci[0]) + (D_ci[1] - D_ci[0]) + (A_ci[1] - A_ci[0]) / 3;

  const ensemble = {
    H: mk.H, D: mk.D, A: mk.A, O25: mk.O25,
    models: {
      matrix: { H: matrixMk.H, D: matrixMk.D, A: matrixMk.A, O25: matrixMk.O25, lambdaH, lambdaA, weight: 1.0 },
    },
    confidence: { H_ci, D_ci, A_ci, O25_ci, uncertainty },
    nBootstrap: 0, // No bootstrap — ensemble variance instead
    dualTrack,
    // dev-03-specific diagnostics
    benterApplied,
    sigmaH, sigmaA,
    perModelH: pred.lambdaH_per_model,
    perModelA: pred.lambdaA_per_model,
  };

  const warnings = validateXGData(
    input.xgHS, input.xgaHC, input.hGames,
    input.xgAS, input.xgaAC, input.aGames,
    input.leagueAvg,
  );

  return {
    lambdaH, lambdaA,
    lambdaH_raw: pred.lambdaH_mean, lambdaA_raw: pred.lambdaA_mean,
    mk, bets, enh,
    topScores: topScores.slice(0, 5),
    ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
    hasValue: bets.some(b => b.isValue),
    hasOdds, warnings, ensemble,
  } as MatchCalc;
}
