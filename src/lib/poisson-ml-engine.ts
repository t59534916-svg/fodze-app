// ═══════════════════════════════════════════════════════════════════════
// FODZE Poisson-ML Engine (@annafrick13)
//
// ML-Driven λ → Dixon-Coles Matrix → ALL Markets
//
// Pipeline: Supabase xG History → EWMA → SoS → Absences → Rest Days
//           → 9 Features → Poisson GLM → λH, λA
//           → Tags → ρ + NegBin → 15×15 Matrix → 1X2/O25/BTTS/CS/AH
//
// Principles:
// - ONE matrix, ZERO ensemble blending (Elo is a feature, not a model)
// - LLM data never trusted (no history → refuse to predict)
// - Value Cap: >8% edge vs Pinnacle = Value Trap
// - Poisson Deviance loss on real goals (not xG)
// ═══════════════════════════════════════════════════════════════════════

import {
  buildMatrix, deriveAllMarkets,
  ewmaXGPerGame,
  calculateBetsEnhanced, vigAdjustBest, validateXGData,
  getHomeFactor,
  type Markets, type EnhancedResult, type XGHistoryEntry,
  type ConfidenceInterval,
} from "./dixon-coles";
import { predictRho, buildRhoFeatures, type RhoModelCoefficients } from "./dynamic-rho";
import { getAlpha, type OverdispersionConfig } from "./neg-binomial";
import { eloPrediction } from "./ensemble";
import { poissonLambdaPredict } from "./poisson-regression";
import { applySoSAdjustment, type SoSRatings } from "./sos";
import { calcAbsenceImpact, type PlayerProfile } from "./player-impact";
import type { MatchCalc, MarketProbs, BetCalc } from "@/types/match";

// ─── Feature Builder ────────────────────────────────────────────────


// ─── Value Cap Guardrail ─────────────────────────────────────────────
// Pre-match edges > 8% against vig-free Pinnacle odds don't exist on
// top leagues. They indicate missing information (injuries, red cards,
// manager changes) that the market already priced in → Value Trap.
const VALUE_CAP_EDGE = 0.08;

/**
 * Compute days since last competitive match from xG history dates.
 * History is chronological (oldest first), so the last entry is the most recent.
 * Returns clamped value [1, 30]. Default 7 if no date available.
 */
function computeRestDays(history?: XGHistoryEntry[]): number {
  if (!history?.length) return 7;
  const lastDate = history[history.length - 1]?.date;
  if (!lastDate) return 7;
  const daysSince = (Date.now() - new Date(lastDate).getTime()) / (86400 * 1000);
  return Math.max(1, Math.min(30, Math.round(daysSince)));
}

interface PoissonMLInput {
  // Team data
  xgHS: number; xgaHC: number; hGames: number;
  xgAS: number; xgaAC: number; aGames: number;
  // League
  leagueAvg: number; homeFactor: number; league: string;
  // Context
  tags: string[];
  // History (for EWMA)
  hHistory?: XGHistoryEntry[];
  aHistory?: XGHistoryEntry[];
  // Team names (for Elo + display)
  homeTeam: string; awayTeam: string;
  // Odds
  odds?: Record<string, number>;
  // Sharp/Pinnacle odds for Value Cap guardrail (vig-free reference)
  sharpOdds?: { h: number | null; d: number | null; a: number | null };
  // Kelly
  fraction: number;
  // Strength of Schedule (league-wide opponent quality ratings)
  sosRatings?: SoSRatings;
  // Player absences (xG share-weighted impact on lambda)
  absences?: { home: PlayerProfile[]; away: PlayerProfile[] };
  // Advanced options
  options?: {
    rhoModel?: RhoModelCoefficients;
    overdispersion?: OverdispersionConfig;
    restDaysDiff?: number;
  };
}

// ─── Main Engine ────────────────────────────────────────────────────

export function calcMatchPoissonML(input: PoissonMLInput): MatchCalc | null {
  const {
    xgHS, xgaHC, hGames,
    xgAS, xgaAC, aGames,
    leagueAvg, homeFactor, league, tags,
    hHistory, aHistory,
    homeTeam, awayTeam,
    odds, fraction, sosRatings, options,
  } = input;

  if (hGames <= 0 || aGames <= 0) return null;

  // ── 1. EWMA time-decay from Supabase per-match history ──────────
  // @annafrick13 ONLY uses structured Supabase data (team_xg_history).
  // LLM-provided xg_h8 sums are NEVER trusted — they can be hallucinated.
  // If no per-match history is available, we refuse to predict rather than
  // feed garbage into a precision engine.
  const hHasHistory = hHistory && hHistory.length > 0;
  const aHasHistory = aHistory && aHistory.length > 0;

  if (!hHasHistory || !aHasHistory) {
    // No structured xG data → refuse to predict (no GIGO)
    return null;
  }

  const hEwma = ewmaXGPerGame(hHistory, xgHS, hGames);
  const aEwma = ewmaXGPerGame(aHistory, xgAS, aGames);
  let hXGpg = hEwma.xgPg;
  let hXGApg = hEwma.xgaPg;
  let aXGpg = aEwma.xgPg;
  let aXGApg = aEwma.xgaPg;

  // ── 1b. SoS-Adjusted xG (Opponent Quality Correction) ──────────
  // Adjusts EWMA xG by opponent defensive quality BEFORE feature building.
  // 2.0 xG against Bayern's defense is worth more than 2.0 xG against Darmstadt.
  let sosApplied = false;
  if (sosRatings) {
    const hAdj = applySoSAdjustment(hXGpg, hXGApg, sosRatings[homeTeam], leagueAvg);
    const aAdj = applySoSAdjustment(aXGpg, aXGApg, sosRatings[awayTeam], leagueAvg);
    hXGpg = hAdj.xgPg;
    hXGApg = hAdj.xgaPg;
    aXGpg = aAdj.xgPg;
    aXGApg = aAdj.xgaPg;
    sosApplied = true;
  }

  // ── 1c. SoS Strength Signal (computed BEFORE absences to avoid contamination)
  // Measures how much the SoS adjustment shifted xG — pure opponent quality signal.
  const sosStrength = sosApplied
    ? (hXGpg - hEwma.xgPg) - (aXGpg - aEwma.xgPg)
    : 0;

  // ── 1d. Player Absences (xG Share Reduction) ─────────────────
  // Kane out (32% xG share, 10% replacement) → hXGpg *= 0.78
  // Applied BEFORE feature building so the ML sees the weakened team.
  let absenceApplied = false;
  if (input.absences) {
    if (input.absences.home.length > 0) {
      const hImpact = calcAbsenceImpact(input.absences.home, hXGpg);
      hXGpg *= hImpact.lambdaAttackMult;
      aXGpg *= hImpact.lambdaDefenseMult;
      absenceApplied = true;
    }
    if (input.absences.away.length > 0) {
      const aImpact = calcAbsenceImpact(input.absences.away, aXGpg);
      aXGpg *= aImpact.lambdaAttackMult;
      hXGpg *= aImpact.lambdaDefenseMult;
      absenceApplied = true;
    }
  }

  // ── 1e. Rest Days (Fatigue) ─────────────────────────────────────
  const restDaysHome = computeRestDays(hHistory);
  const restDaysAway = computeRestDays(aHistory);
  const restDaysDiff = (restDaysHome - restDaysAway) / 7;

  // ── 2. Build Poisson features (10 features) ────────────────────
  const elo = eloPrediction(homeTeam, awayTeam, league);
  const eloDiffApprox = elo.H > 0 ? Math.log(elo.H / Math.max(0.01, elo.A)) / 2.3 : 0;

  // DERBY as binary feature (trained, not post-hoc multiplier)
  // ROTATION/SANDWICH are already captured by restDaysDiff
  const isDerby = tags.some(t => t.toUpperCase().replace(/\s+/g, "-") === "DERBY") ? 1 : 0;

  const poissonFeatures = [
    hXGpg - aXGpg,                          // 0: xg_diff (SoS-adjusted)
    hXGApg - aXGApg,                         // 1: xga_diff (SoS-adjusted)
    eloDiffApprox,                           // 2: elo_diff
    hXGpg + aXGpg,                           // 3: total_xg (SoS-adjusted)
    homeFactor,                              // 4: home_factor
    leagueAvg,                               // 5: league_avg
    restDaysDiff,                            // 6: rest_days_diff (normalized by 7)
    sosStrength,                             // 7: sos_strength_diff
    isDerby,                                 // 8: is_derby (binary)
  ];

  // ── 3. ML Lambda Prediction ─────────────────────────────────────
  const mlResult = poissonLambdaPredict(poissonFeatures);

  // No fallback. Without a trained Poisson model, this engine refuses to predict.
  // The xG formula without tag corrections and ensemble dampening produces
  // inflated lambdas — garbage predictions are worse than no predictions.
  if (!mlResult) return null;

  const lambdaH_ml = mlResult.lambdaH;
  const lambdaA_ml = mlResult.lambdaA;

  const lambdaH_raw = lambdaH_ml;
  const lambdaA_raw = lambdaA_ml;

  // ── 4. Light Bayesian Shrinkage (reduced — ML already regularized)
  // Only apply if sample size very small (< 4 games)
  const shrinkageStrength = Math.min(hGames, aGames) < 4 ? 3 : 0; // weaker prior
  let lambdaH_reg = lambdaH_ml;
  let lambdaA_reg = lambdaA_ml;
  if (shrinkageStrength > 0) {
    const sH = hGames / (hGames + shrinkageStrength);
    const sA = aGames / (aGames + shrinkageStrength);
    lambdaH_reg = leagueAvg * homeFactor + sH * (lambdaH_ml - leagueAvg * homeFactor);
    lambdaA_reg = leagueAvg + sA * (lambdaA_ml - leagueAvg);
  }

  // ── 5. No post-ML tag corrections ──────────────────────────────
  // DERBY is now a trained feature (index 9). ROTATION/SANDWICH are
  // captured by rest_days_diff. No heuristic multipliers on top of ML.
  const lambdaH = lambdaH_reg;
  const lambdaA = lambdaA_reg;

  // ── 6. Dynamic ρ + NegBin ───────────────────────────────────────
  let dynamicRho: number | undefined;
  const rhoModel = options?.rhoModel;
  if (rhoModel) {
    const rhoFeatures = buildRhoFeatures(lambdaH, lambdaA, homeFactor, leagueAvg, tags, options?.restDaysDiff);
    dynamicRho = predictRho(rhoModel, rhoFeatures);
  }
  const effectiveRho = dynamicRho ?? -0.05;

  const alphaUsed = league
    ? getAlpha(league, options?.overdispersion)
    : 0;

  // ── 7. Build THE matrix (single source of truth) ────────────────
  const matrix = buildMatrix(lambdaH, lambdaA, effectiveRho, alphaUsed);
  const matrixMk = deriveAllMarkets(matrix);

  // ── 8. Confidence intervals ─────────────────────────────────────
  const se = (lam: number, n: number) => lam * 0.45 / Math.sqrt(n);
  const z = 1.645;
  const ciH = { low: Math.max(0.1, lambdaH - z * se(lambdaH, hGames)), mid: lambdaH, high: lambdaH + z * se(lambdaH, hGames), se: se(lambdaH, hGames) };
  const ciA = { low: Math.max(0.1, lambdaA - z * se(lambdaA, aGames)), mid: lambdaA, high: lambdaA + z * se(lambdaA, aGames), se: se(lambdaA, aGames) };
  const mk_low = deriveAllMarkets(buildMatrix(ciH.low, ciA.high, effectiveRho, alphaUsed));
  const mk_high = deriveAllMarkets(buildMatrix(ciH.high, ciA.low, effectiveRho, alphaUsed));

  // ── 9. Matrix IS the prediction ─────────────────────────────────
  // No ensemble blending. The ML-Poisson λ already incorporates Elo
  // (as a feature) and SoS. Mixing Elo again would double-count.
  // Mixing market odds would smooth away the edge before Kelly sees it.
  // 1X2, O25, BTTS, CS — everything comes from the matrix.
  const mk: MarketProbs = matrixMk;

  // ── 10. Bayesian Bootstrap CI (real matrix, no sigmoid approximation)
  // Resample xG history → recompute λ via ML → build full matrix → extract 1X2/O25.
  // Accuracy > speed: ~50ms for 200 matrix builds is acceptable.
  const N_BOOT = 200;
  const bootH: number[] = [], bootD: number[] = [], bootA: number[] = [], bootO25: number[] = [];

  if (hHistory && aHistory && hHistory.length >= 4 && aHistory.length >= 4) {
    for (let b = 0; b < N_BOOT; b++) {
      const hSample = Array.from({ length: hHistory.length }, () =>
        hHistory[Math.floor(Math.random() * hHistory.length)]);
      const aSample = Array.from({ length: aHistory.length }, () =>
        aHistory[Math.floor(Math.random() * aHistory.length)]);

      const bHxg = hSample.reduce((s, m) => s + m.xg, 0) / hSample.length;
      const bHxga = hSample.reduce((s, m) => s + m.xga, 0) / hSample.length;
      const bAxg = aSample.reduce((s, m) => s + m.xg, 0) / aSample.length;
      const bAxga = aSample.reduce((s, m) => s + m.xga, 0) / aSample.length;

      // Recompute features with bootstrap sample → ML predict
      const bFeatures = [
        bHxg - bAxg, bHxga - bAxga, eloDiffApprox,
        bHxg + bAxg, homeFactor, leagueAvg,
        restDaysDiff, sosStrength, isDerby,
      ];
      const bML = poissonLambdaPredict(bFeatures);
      const bLamH = bML ? bML.lambdaH : Math.max(0.3, leagueAvg * (bHxg / leagueAvg) * (bAxga / leagueAvg) * homeFactor);
      const bLamA = bML ? bML.lambdaA : Math.max(0.3, leagueAvg * (bAxg / leagueAvg) * (bHxga / leagueAvg));

      // Build real matrix — no sigmoid shortcuts
      const bMatrix = buildMatrix(bLamH, bLamA, effectiveRho, alphaUsed);
      const bMk = deriveAllMarkets(bMatrix);

      bootH.push(bMk.H);
      bootD.push(bMk.D);
      bootA.push(bMk.A);
      bootO25.push(bMk.O25);
    }
  } else {
    for (let b = 0; b < N_BOOT; b++) {
      const noise = () => 1 + (Math.random() - 0.5) * 0.2;
      bootH.push(mk.H * noise());
      bootD.push(mk.D * noise());
      bootA.push(mk.A * noise());
      bootO25.push(mk.O25 * noise());
    }
  }

  bootH.sort((a, b) => a - b);
  bootD.sort((a, b) => a - b);
  bootA.sort((a, b) => a - b);
  bootO25.sort((a, b) => a - b);

  const ci5 = Math.floor(N_BOOT * 0.05);
  const ci95 = Math.floor(N_BOOT * 0.95);
  const H_ci: [number, number] = [bootH[ci5], bootH[ci95]];
  const D_ci: [number, number] = [bootD[ci5], bootD[ci95]];
  const A_ci: [number, number] = [bootA[ci5], bootA[ci95]];
  const O25_ci: [number, number] = [bootO25[ci5], bootO25[ci95]];
  const uncertainty = ((H_ci[1] - H_ci[0]) + (D_ci[1] - D_ci[0]) + (A_ci[1] - A_ci[0])) / 3;

  // ── 11. Build EnhancedResult (for enh field compatibility) ──────
  const enh: EnhancedResult = {
    lambdaH_raw, lambdaA_raw,
    lambdaH_regressed: lambdaH_reg, lambdaA_regressed: lambdaA_reg,
    lambdaH_formed: lambdaH_reg, lambdaA_formed: lambdaA_reg, // no form mult
    lambdaH, lambdaA,
    shrinkageH: shrinkageStrength > 0 ? hGames / (hGames + shrinkageStrength) : 1,
    shrinkageA: shrinkageStrength > 0 ? aGames / (aGames + shrinkageStrength) : 1,
    formH: { mult: 1, label: "—" }, formA: { mult: 1, label: "—" },
    tagCorrections: [], tagMultH: 1, tagMultA: 1,
    ciH, ciA, matrix, mk: matrixMk, mk_low, mk_high,
    sosApplied, absenceApplied, dynamicRho, alphaUsed: alphaUsed > 0 ? alphaUsed : undefined,
  };

  // ── 12. Bet calculation ─────────────────────────────────────────
  const no: Record<string, number> = {};
  if (odds) {
    for (const k of ["h", "d", "a", "o25", "u25", "btts"]) {
      const v = odds[k]; if (v > 0) no[k] = v;
    }
  }
  const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;
  const bets = calculateBetsEnhanced(mk, mk_low, mk_high, no, fraction);

  // ── 12b. Value Cap Guardrail ──────────────────────────────────
  // Compare model edge against vig-free Pinnacle odds (if available).
  // Edges > 8% are almost certainly Value Traps — flag them hard.
  const sharp = input.sharpOdds;
  if (sharp?.h && sharp?.d && sharp?.a) {
    const rawH = 1 / sharp.h, rawD = 1 / sharp.d, rawA = 1 / sharp.a;
    const total = rawH + rawD + rawA;
    const pinnVigFree = { H: rawH / total, D: rawD / total, A: rawA / total };

    for (const bet of bets) {
      const pinnP = bet.label === "Heim" ? pinnVigFree.H
                  : bet.label === "Unent." ? pinnVigFree.D
                  : bet.label === "Ausw." ? pinnVigFree.A
                  : null;
      if (pinnP !== null) {
        const edgeVsPinnacle = bet.pModel - pinnP;
        if (edgeVsPinnacle > VALUE_CAP_EDGE) {
          bet.valueTrap = true;
          bet.valueTrapEdge = edgeVsPinnacle;
          bet.valueTrapReason = `Edge ${(edgeVsPinnacle * 100).toFixed(1)}% vs Pinnacle — wahrscheinlich fehlende Info (Verletzung/Sperre/Trainerwechsel)`;
          bet.confidence = "NONE";
          bet.isValue = false;
          bet.kelly = 0;
        }
      }
    }
  }

  // ── 13. Top scores ──────────────────────────────────────────────
  const topScores: { s: string; p: number }[] = [];
  for (let i = 0; i <= 5; i++)
    for (let j = 0; j <= 5; j++)
      if (matrix[i]?.[j] > 0.005) topScores.push({ s: `${i}:${j}`, p: matrix[i][j] });
  topScores.sort((a, b) => b.p - a.p);

  // ── 14. Model details (pure matrix, no ensemble) ────────────────
  const ensemble = {
    H: mk.H, D: mk.D, A: mk.A, O25: mk.O25,
    models: {
      matrix: { H: mk.H, D: mk.D, A: mk.A, O25: mk.O25, lambdaH, lambdaA, weight: 1.0 },
    },
    confidence: { H_ci, D_ci, A_ci, O25_ci, uncertainty },
    nBootstrap: N_BOOT,
  };

  // ── 15. Assemble MatchCalc ──────────────────────────────────────
  const warnings = validateXGData(
    input.xgHS, input.xgaHC, input.hGames, input.xgAS, input.xgaAC, input.aGames, input.leagueAvg
  );

  return {
    lambdaH, lambdaA,
    lambdaH_raw, lambdaA_raw,
    mk, bets, enh: enh as any,
    topScores: topScores.slice(0, 5),
    ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
    hasValue: bets.some(b => b.isValue),
    hasOdds, warnings, ensemble,
  } as MatchCalc;
}
