// ═══════════════════════════════════════════════════════════════════════
// FODZE Poisson-ML Engine v2 (@annafrick13 v2.0)
//
// LightGBM Tweedie → Monotone Constraints → Dixon-Coles Matrix → ALL Markets
//
// Pipeline: Supabase npxG History → EWMA → SoS → Rest Days
//           → 13 Features → LightGBM Tweedie → λH, λA
//           → Optimized ρ → 15×15 Matrix → Dual-Track Calibration
//           → Goldilocks Guard (2.5%–7.5%) → Kelly
//
// Changes from v1:
// - LightGBM Tweedie replaces Poisson GLM (non-linear, overdispersion-native)
// - 13 features (npxG-based, +momentum, +volatility, +h2h, +motivation)
// - Monotonic constraints on elo_diff & npxg_diff (physics guardrails)
// - Optimized rho from training (not hardcoded -0.05)
// - Dual-track calibration (Track A: raw matrix, Track B: isotonic for Kelly)
// - Goldilocks guard: 2.5%–7.5% edge band (replaces blunt 8% cap)
// ═══════════════════════════════════════════════════════════════════════

import {
  buildMatrix, deriveAllMarkets,
  ewmaXGPerGame,
  calculateBetsEnhanced, vigAdjustBest, validateXGData,
  type Markets, type EnhancedResult, type XGHistoryEntry,
} from "./dixon-coles";
import { getAlpha, type OverdispersionConfig } from "./neg-binomial";
import { eloPrediction } from "./ensemble";
import { lgbmPredict, getLGBMRho, getTeamSeasonFeatures } from "./lgbm-runtime";
import { applySoSAdjustment, type SoSRatings } from "./sos";
import { calcAbsenceImpact, type PlayerProfile } from "./player-impact";
import type { ShieldVeto } from "./filter-shield";
import { dualTrackCalibrate } from "./calibration";
import { getLeagueLiquidityTier } from "./league-liquidity";
import type { MatchCalc, MarketProbs, BetCalc } from "@/types/match";

// ─── Goldilocks Edge Guard ──────────────────────────────────────────
// Bet-Authorisation ist strikt auf 2.5%–7.5% Goldilocks. Aber:
//   < 2.5%       — insufficient edge (Variance, kein Signal) → silent skip
//   2.5% – 7.5%  — Goldilocks: Bet authorisiert
//   7.5% – 10%   — oberhalb Goldilocks, aber nicht absurd. Kein Bet,
//                  aber auch kein Trap-Banner (post-calibrierte Edges
//                  zwischen 8–10% sind in Nicht-Top-5-Ligen normal).
//   > 10%        — Value Trap. Markt weiß etwas was wir nicht wissen.
//                  Bet hard-blockiert + rote Warnung im UI.
//
// Früher löste jede Edge > 7.5% sofort den Trap-Banner aus; in der Praxis
// feuerte das bei fast jedem gut kalibrierten Match → Vertrauen kaputt.
//
// 2026-04-25 (v4.0 Phase 4): Diese globalen Konstanten sind FALLBACKS.
// Die echten Schwellen kommen jetzt per-Liga aus league-liquidity.ts —
// EPL braucht nur 1.5% edge weil sharp money die Linie pre-game zerlegt;
// Liga 3 braucht 4.5% weil dort Spreads breit sind und 3% Edge oft Rauschen.
// Diese Werte hier bleiben als Default-Tier wenn die Liga unbekannt ist.
const EDGE_MIN = 0.025;
const EDGE_MAX = 0.075;
const EDGE_TRAP_HARD = 0.10;

/**
 * Compute days since last match from xG history dates.
 */
function computeRestDays(history?: XGHistoryEntry[]): number {
  if (!history?.length) return 7;
  const lastDate = history[history.length - 1]?.date;
  if (!lastDate) return 7;
  const daysSince = (Date.now() - new Date(lastDate).getTime()) / (86400 * 1000);
  return Math.max(1, Math.min(30, Math.round(daysSince)));
}

/**
 * Compute npxG per game from history entries (uses npxg field if available, fallback to xg).
 */
function npxgPerGame(history: XGHistoryEntry[]): { npxgPg: number; npxgaPg: number } {
  if (!history.length) return { npxgPg: 1.3, npxgaPg: 1.3 };
  const alpha = 0.85; // per-match decay
  let wSum = 0, wXg = 0, wXga = 0;
  for (let i = 0; i < history.length; i++) {
    const w = Math.pow(alpha, history.length - 1 - i);
    wSum += w;
    wXg += w * (history[i].npxg ?? history[i].xg);
    wXga += w * (history[i].npxga ?? history[i].xga);
  }
  return {
    npxgPg: wXg / wSum,
    npxgaPg: wXga / wSum,
  };
}

/**
 * Compute npxG momentum: last 3 matches avg minus season avg.
 * Positive = acute form better than baseline.
 */
function npxgMomentum(history: XGHistoryEntry[]): number {
  if (history.length < 3) return 0;
  const getVal = (e: XGHistoryEntry) => (e.npxg ?? e.xg) - (e.npxga ?? e.xga);
  const last3 = history.slice(-3).reduce((s, e) => s + getVal(e), 0) / 3;
  const season = history.reduce((s, e) => s + getVal(e), 0) / history.length;
  return last3 - season;
}

/**
 * Compute npxG volatility: rolling std of npxg_diff over last 8 matches.
 * High volatility = inconsistent team = harder to predict.
 */
function npxgVolatility(history: XGHistoryEntry[]): number {
  if (history.length < 4) return 0.5;
  const window = history.slice(-8);
  const diffs = window.map(e => (e.npxg ?? e.xg) - (e.npxga ?? e.xga));
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length;
  return Math.sqrt(variance);
}

/**
 * Compute H2H npxG differential from last 5 meetings.
 * Requires history entries with opponent field matching.
 */
function h2hNpxgDiff(
  hHistory: XGHistoryEntry[],
  aHistory: XGHistoryEntry[],
  homeTeam: string,
  awayTeam: string
): number {
  // Find meetings in home team's history where opponent is away team
  const meetings = hHistory.filter(
    e => e.opponent?.toLowerCase() === awayTeam.toLowerCase()
  ).slice(-5);

  if (meetings.length === 0) return 0;

  const diff = meetings.reduce(
    (s, e) => s + (e.npxg ?? e.xg) - (e.npxga ?? e.xga),
    0
  ) / meetings.length;

  return diff;
}

/**
 * PPDA ratio EWMA: Passes Per Defensive Action = pressing intensity.
 * Low PPDA = high press (aggressive). High PPDA = low press (sit back).
 * Uses ppda_att/ppda_def from XGHistoryEntry if available.
 */
function ppdaRatioEwma(history: XGHistoryEntry[]): number {
  const DEFAULT_PPDA = 11.1;  // League average
  if (!history.length) return DEFAULT_PPDA;
  const alpha = 0.85;
  let wSum = 0, wPpda = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].ppda_att == null || history[i].ppda_def == null) continue;
    const w = Math.pow(alpha, history.length - 1 - i);
    wSum += w;
    wPpda += w * (history[i].ppda_att! / Math.max(1, history[i].ppda_def!));
  }
  return wSum > 0 ? wPpda / wSum : DEFAULT_PPDA;
}

/**
 * Deep completions net EWMA: deep - deep_allowed.
 * Positive = team penetrates more than opponent = better final-third quality.
 */
function deepCompletionsEwma(history: XGHistoryEntry[]): number {
  if (!history.length) return 0;
  const alpha = 0.85;
  let wSum = 0, wDeep = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].deep == null) continue;
    const w = Math.pow(alpha, history.length - 1 - i);
    wSum += w;
    wDeep += w * ((history[i].deep ?? 0) - (history[i].deep_allowed ?? 0));
  }
  return wSum > 0 ? wDeep / wSum : 0;
}

export interface PoissonMLv2Input {
  xgHS: number; xgaHC: number; hGames: number;
  xgAS: number; xgaAC: number; aGames: number;
  leagueAvg: number; homeFactor: number; league: string;
  tags: string[];
  hHistory?: XGHistoryEntry[];
  aHistory?: XGHistoryEntry[];
  homeTeam: string; awayTeam: string;
  season?: string;
  odds?: Record<string, number>;
  sharpOdds?: { h: number | null; d: number | null; a: number | null };
  fraction: number;
  sosRatings?: SoSRatings;
  absences?: { home: PlayerProfile[]; away: PlayerProfile[] };
  // v1.2 Filter-Shield: see PoissonMLInput for contract
  shieldVetoes?: readonly ShieldVeto[];
  // motivationDiff removed — leakage risk with reconstructed standings
  options?: {
    overdispersion?: OverdispersionConfig;
    restDaysDiff?: number;
  };
}

// ─── Main Engine ────────────────────────────────────────────────────

export function calcMatchPoissonMLv2(input: PoissonMLv2Input): MatchCalc | null {
  const {
    xgHS, xgaHC, hGames,
    xgAS, xgaAC, aGames,
    leagueAvg, homeFactor, league, tags,
    hHistory, aHistory,
    homeTeam, awayTeam,
    odds, fraction, sosRatings, options,
  } = input;

  if (hGames <= 0 || aGames <= 0) return null;

  // ── 1. EWMA from Supabase per-match history ─────────────────────
  const hHasHistory = hHistory && hHistory.length > 0;
  const aHasHistory = aHistory && aHistory.length > 0;

  if (!hHasHistory || !aHasHistory) {
    return null; // No GIGO
  }

  // Use npxG-based EWMA (fallback to xG if npxg field missing)
  const hNpxg = npxgPerGame(hHistory);
  const aNpxg = npxgPerGame(aHistory);

  let hXGpg = hNpxg.npxgPg;
  let hXGApg = hNpxg.npxgaPg;
  let aXGpg = aNpxg.npxgPg;
  let aXGApg = aNpxg.npxgaPg;

  // ── 1b. SoS Adjustment ──────────────────────────────────────────
  let sosApplied = false;
  const hEwmaRaw = { xgPg: hXGpg, xgaPg: hXGApg };
  const aEwmaRaw = { xgPg: aXGpg, xgaPg: aXGApg };
  if (sosRatings) {
    const hAdj = applySoSAdjustment(hXGpg, hXGApg, sosRatings[homeTeam], leagueAvg);
    const aAdj = applySoSAdjustment(aXGpg, aXGApg, sosRatings[awayTeam], leagueAvg);
    hXGpg = hAdj.xgPg;
    hXGApg = hAdj.xgaPg;
    aXGpg = aAdj.xgPg;
    aXGApg = aAdj.xgaPg;
    sosApplied = true;
  }

  // ── 1c. SoS Strength Signal ────────────────────────────────────
  const sosStrength = sosApplied
    ? (hXGpg - hEwmaRaw.xgPg) - (aXGpg - aEwmaRaw.xgPg)
    : 0;

  // NOTE: Player absences moved to post-inference (after LightGBM prediction)
  // to avoid train/serve skew. Features must match training distribution.

  // ── 1d. Rest Days ─────────────────────────────────────────────
  const restDaysHome = computeRestDays(hHistory);
  const restDaysAway = computeRestDays(aHistory);
  const restDaysDiff = (restDaysHome - restDaysAway) / 7;

  // ── 2. Build 13-feature vector ────────────────────────────────
  const elo = eloPrediction(homeTeam, awayTeam, league);
  const eloDiffApprox = elo.H > 0 ? Math.log(elo.H / Math.max(0.01, elo.A)) / 2.3 : 0;

  const isDerby = tags.some(t => t.toUpperCase().replace(/\s+/g, "-") === "DERBY") ? 1 : 0;

  // New v2 features
  const hMomentum = npxgMomentum(hHistory);
  const aMomentum = npxgMomentum(aHistory);
  const momentumDiff = hMomentum - aMomentum;

  const hVol = npxgVolatility(hHistory);
  const aVol = npxgVolatility(aHistory);
  const volatility = (hVol + aVol) / 2;

  const h2hDiff = h2hNpxgDiff(hHistory, aHistory, homeTeam, awayTeam);

  // motivationDiff removed — ppda + deep replace it as leakage-free features

  // Season-level features (14-20) from model JSON lookup
  const season = input.season || "";
  const hSeason = getTeamSeasonFeatures(league, season, homeTeam);
  const aSeason = getTeamSeasonFeatures(league, season, awayTeam);

  // ── 2b. Bayesian Shrinkage for season-level features (Spieltag 1-8) ──
  // Early in the season, season-level aggregates are based on too few games.
  // Shrink toward league-average defaults using n/(n+K) weighting.
  // K=8: at matchday 8, season features have 50% weight; at matchday 1, ~11%.
  const SEASON_SHRINKAGE_K = 8;
  const matchdayEstimate = Math.min(hGames, aGames); // proxy for how far into season
  const seasonWeight = matchdayEstimate / (matchdayEstimate + SEASON_SHRINKAGE_K);

  // League-average defaults (fallback when no season data or early season)
  const SEASON_DEFAULTS = {
    setpiece_xg_share: 0.15,
    late_game_xg_share: 0.20,
    losing_state_xg_diff: 0.0,
    top3_xgchain_share: 0.35,
    shot_quality_avg: 0.12,
    high_value_shot_share: 0.16,
  };

  // Shrink: value = default + weight × (observed - default)
  const shrinkSeason = (observed: number | undefined, key: keyof typeof SEASON_DEFAULTS) => {
    const def = SEASON_DEFAULTS[key];
    if (observed == null) return def;
    return def + seasonWeight * (observed - def);
  };

  // ── 2c. Absence/Rotation double-counting guard ──
  // If post-inference absence correction will be applied (known absences),
  // dampen Feature 18 (squad_rotation_rate_diff) to avoid counting the same
  // "key player missing" signal twice — once in the tree, once post-inference.
  const hasAbsenceData = !!(input.absences?.home?.length || input.absences?.away?.length);
  const rotationDampener = hasAbsenceData ? 0.3 : 1.0; // 70% reduction when absences known

  const features = [
    hXGpg - aXGpg,          // 0: npxg_diff_ewma
    hXGApg - aXGApg,        // 1: npxga_diff_ewma
    eloDiffApprox,           // 2: elo_diff
    hXGpg + aXGpg,          // 3: total_npxg
    homeFactor,              // 4: home_factor
    leagueAvg,               // 5: league_avg
    restDaysDiff,            // 6: rest_days_diff
    sosStrength,             // 7: sos_strength
    isDerby,                 // 8: is_derby
    momentumDiff,            // 9: npxg_momentum
    volatility,              // 10: npxg_volatility
    h2hDiff,                                                          // 11: h2h_npxg_diff
    ppdaRatioEwma(hHistory) - ppdaRatioEwma(aHistory),               // 12: ppda_ratio_diff
    deepCompletionsEwma(hHistory) - deepCompletionsEwma(aHistory),   // 13: deep_completions_diff
    shrinkSeason(hSeason?.setpiece_xg_share, "setpiece_xg_share") - shrinkSeason(aSeason?.setpiece_xg_share, "setpiece_xg_share"), // 14
    shrinkSeason(hSeason?.late_game_xg_share, "late_game_xg_share") - shrinkSeason(aSeason?.late_game_xg_share, "late_game_xg_share"), // 15
    shrinkSeason(hSeason?.losing_state_xg_diff, "losing_state_xg_diff") - shrinkSeason(aSeason?.losing_state_xg_diff, "losing_state_xg_diff"), // 16
    shrinkSeason(hSeason?.top3_xgchain_share, "top3_xgchain_share") - shrinkSeason(aSeason?.top3_xgchain_share, "top3_xgchain_share"), // 17
    0 * rotationDampener, // 18: squad_rotation_rate_diff — dampened when absences known
    shrinkSeason(hSeason?.shot_quality_avg, "shot_quality_avg") - shrinkSeason(aSeason?.shot_quality_avg, "shot_quality_avg"), // 19
    shrinkSeason(hSeason?.high_value_shot_share, "high_value_shot_share") - shrinkSeason(aSeason?.high_value_shot_share, "high_value_shot_share"), // 20
  ];

  // ── 3. LightGBM Lambda Prediction ─────────────────────────────
  const mlResult = lgbmPredict(features);

  if (!mlResult) return null; // No model loaded → refuse to predict

  const lambdaH_raw = mlResult.lambdaH;
  const lambdaA_raw = mlResult.lambdaA;

  // ── 4. Light Bayesian Shrinkage (reduced) ─────────────────────
  const shrinkageStrength = Math.min(hGames, aGames) < 4 ? 3 : 0;
  let lambdaH = lambdaH_raw;
  let lambdaA = lambdaA_raw;
  if (shrinkageStrength > 0) {
    const sH = hGames / (hGames + shrinkageStrength);
    const sA = aGames / (aGames + shrinkageStrength);
    lambdaH = leagueAvg * homeFactor + sH * (lambdaH_raw - leagueAvg * homeFactor);
    lambdaA = leagueAvg + sA * (lambdaA_raw - leagueAvg);
  }

  // ── 4b. Player Absences (post-inference) ────────────────────
  // Applied AFTER LightGBM to avoid train/serve skew.
  // The model sees in-distribution features; absences scale the output lambdas.
  let absenceApplied = false;
  if (input.absences) {
    if (input.absences.home.length > 0) {
      const hImpact = calcAbsenceImpact(input.absences.home, lambdaH);
      lambdaH *= hImpact.lambdaAttackMult;
      lambdaA *= hImpact.lambdaDefenseMult;
      absenceApplied = true;
    }
    if (input.absences.away.length > 0) {
      const aImpact = calcAbsenceImpact(input.absences.away, lambdaA);
      lambdaA *= aImpact.lambdaAttackMult;
      lambdaH *= aImpact.lambdaDefenseMult;
      absenceApplied = true;
    }
  }

  // ── 5. Build matrix with optimized rho ────────────────────────
  const effectiveRho = getLGBMRho();

  const alphaUsed = league
    ? getAlpha(league, options?.overdispersion)
    : 0;

  const matrix = buildMatrix(lambdaH, lambdaA, effectiveRho, alphaUsed);
  const matrixMk = deriveAllMarkets(matrix);

  // ── 6. Dual-track calibration ─────────────────────────────────
  // Track A: raw matrix probs (market coherence, UI)
  // Track B: isotonic-calibrated (Kelly sizing, edge check)
  const dualTrack = dualTrackCalibrate(matrixMk.H, matrixMk.D, matrixMk.A, league);

  // The displayed market probs use Track A (raw matrix)
  const mk: MarketProbs = matrixMk;

  // ── 7. Confidence intervals ───────────────────────────────────
  const se = (lam: number, n: number) => lam * 0.45 / Math.sqrt(n);
  const z = 1.645;
  const ciH = { low: Math.max(0.1, lambdaH - z * se(lambdaH, hGames)), mid: lambdaH, high: lambdaH + z * se(lambdaH, hGames), se: se(lambdaH, hGames) };
  const ciA = { low: Math.max(0.1, lambdaA - z * se(lambdaA, aGames)), mid: lambdaA, high: lambdaA + z * se(lambdaA, aGames), se: se(lambdaA, aGames) };
  const mk_low = deriveAllMarkets(buildMatrix(ciH.low, ciA.high, effectiveRho, alphaUsed));
  const mk_high = deriveAllMarkets(buildMatrix(ciH.high, ciA.low, effectiveRho, alphaUsed));

  // ── 8. Bayesian Bootstrap CI ──────────────────────────────────
  const N_BOOT = 200;
  const bootH: number[] = [], bootD: number[] = [], bootA: number[] = [], bootO25: number[] = [];

  // Parametric bootstrap: add Gaussian noise proportional to team volatility.
  // This preserves EWMA chronology (no array shuffling) while reflecting
  // each team's consistency. Volatile teams → wider CI, consistent → tighter.
  // Irwin-Hall approximation: sum of 3 uniforms ≈ N(1.5, √0.25) → scaled to N(0, σ)
  for (let b = 0; b < N_BOOT; b++) {
    const noiseScale = 0.5; // dampening factor
    const gaussApprox = () => (Math.random() + Math.random() + Math.random() - 1.5);
    const bLH = Math.max(0.3, Math.min(4.5, lambdaH * (1 + gaussApprox() * hVol * noiseScale)));
    const bLA = Math.max(0.3, Math.min(4.5, lambdaA * (1 + gaussApprox() * aVol * noiseScale)));
    const bMatrix = buildMatrix(bLH, bLA, effectiveRho, alphaUsed);
    const bMk = deriveAllMarkets(bMatrix);
    bootH.push(bMk.H);
    bootD.push(bMk.D);
    bootA.push(bMk.A);
    bootO25.push(bMk.O25);
  }

  bootH.sort((a, b) => a - b);
  bootD.sort((a, b) => a - b);
  bootA.sort((a, b) => a - b);
  bootO25.sort((a, b) => a - b);

  const ci5 = Math.floor(bootH.length * 0.05);
  const ci95 = Math.floor(bootH.length * 0.95);
  const H_ci: [number, number] = [bootH[ci5] ?? mk.H, bootH[ci95] ?? mk.H];
  const D_ci: [number, number] = [bootD[ci5] ?? mk.D, bootD[ci95] ?? mk.D];
  const A_ci: [number, number] = [bootA[ci5] ?? mk.A, bootA[ci95] ?? mk.A];
  const O25_ci: [number, number] = [bootO25[ci5] ?? mk.O25, bootO25[ci95] ?? mk.O25];
  const uncertainty = ((H_ci[1] - H_ci[0]) + (D_ci[1] - D_ci[0]) + (A_ci[1] - A_ci[0])) / 3;

  // ── 9. Bet calculation with dual-track ────────────────────────
  const no: Record<string, number> = {};
  if (odds) {
    for (const k of ["h", "d", "a", "o25", "u25", "btts"]) {
      const v = odds[k]; if (v > 0) no[k] = v;
    }
  }
  const hasOdds = no.h > 0 && no.d > 0 && no.a > 0;
  // Propagate sharpOdds + league + engine="v2" so Benter (Phase 1.3) can
  // blend v2's posterior toward Pinnacle using v2-specific trained weights.
  // Convert the engine's nullable {h,d,a} to PinnacleOdds shape.
  const shV2 = input.sharpOdds;
  const pinOdds = shV2 && shV2.h != null && shV2.d != null && shV2.a != null
    ? { sharp_h: shV2.h, sharp_d: shV2.d, sharp_a: shV2.a }
    : undefined;
  const bets = calculateBetsEnhanced(mk, mk_low, mk_high, no, fraction, pinOdds, undefined, input.league, "v2", 1, input.shieldVetoes);

  // ── 9b. Goldilocks Guard (dual-track) ─────────────────────────
  // Use Track B (isotonic-calibrated) for edge calculation vs Pinnacle.
  // Only authorize bets in the 2.5%–7.5% edge band.
  const sharp = input.sharpOdds;
  if (sharp?.h && sharp?.d && sharp?.a) {
    const rawSH = 1 / sharp.h, rawSD = 1 / sharp.d, rawSA = 1 / sharp.a;
    const total = rawSH + rawSD + rawSA;
    const pinnVigFree = { H: rawSH / total, D: rawSD / total, A: rawSA / total };

    for (const bet of bets) {
      const trackBP = bet.label === "Heim" ? dualTrack.trackB.H
                    : bet.label === "Unent." ? dualTrack.trackB.D
                    : bet.label === "Ausw." ? dualTrack.trackB.A
                    : null;
      const pinnP = bet.label === "Heim" ? pinnVigFree.H
                  : bet.label === "Unent." ? pinnVigFree.D
                  : bet.label === "Ausw." ? pinnVigFree.A
                  : null;

      if (trackBP !== null && pinnP !== null) {
        const edgeVsPinnacle = trackBP - pinnP;
        const tier = getLeagueLiquidityTier(league);

        if (edgeVsPinnacle < tier.goldilocksMin) {
          // Unter Goldilocks: kein Signal (Tier-1=1.5%, Tier-2=2.5%, Tier-3=3.5%)
          bet.isValue = false;
          bet.kelly = 0;
        } else if (edgeVsPinnacle > tier.trapHard) {
          // Harter Trap: per-Liga (Tier-1=10%, Tier-2=12%, Tier-3=15%)
          bet.valueTrap = true;
          bet.valueTrapEdge = edgeVsPinnacle;
          bet.valueTrapReason = `Edge ${(edgeVsPinnacle * 100).toFixed(1)}% vs Pinnacle — wahrscheinlich fehlende Info`;
          bet.confidence = "NONE";
          bet.isValue = false;
          bet.kelly = 0;
        } else if (edgeVsPinnacle > tier.goldilocksMax) {
          // Soft-Trap (silent): zwischen GoldilocksMax und TrapHard.
          // Kein Bet, aber kein Alarm — Toleranz für gut kalibrierte Modelle.
          bet.isValue = false;
          bet.kelly = 0;
        }
        // GoldilocksMin–GoldilocksMax band: bet authorized with Kelly sizing
      }
    }
  }

  // ── 10. Top scores ────────────────────────────────────────────
  const topScores: { s: string; p: number }[] = [];
  for (let i = 0; i <= 5; i++)
    for (let j = 0; j <= 5; j++)
      if (matrix[i]?.[j] > 0.005) topScores.push({ s: `${i}:${j}`, p: matrix[i][j] });
  topScores.sort((a, b) => b.p - a.p);

  // ── 11. EnhancedResult ────────────────────────────────────────
  const enh: EnhancedResult = {
    lambdaH_raw, lambdaA_raw,
    lambdaH_regressed: lambdaH, lambdaA_regressed: lambdaA,
    lambdaH_formed: lambdaH, lambdaA_formed: lambdaA,
    lambdaH, lambdaA,
    shrinkageH: shrinkageStrength > 0 ? hGames / (hGames + shrinkageStrength) : 1,
    shrinkageA: shrinkageStrength > 0 ? aGames / (aGames + shrinkageStrength) : 1,
    formH: { mult: 1, label: "—" }, formA: { mult: 1, label: "—" },
    tagCorrections: [], tagMultH: 1, tagMultA: 1,
    ciH, ciA, matrix, mk: matrixMk, mk_low, mk_high,
    sosApplied, absenceApplied,
    dynamicRho: effectiveRho,
    alphaUsed: alphaUsed > 0 ? alphaUsed : undefined,
  };

  // ── 12. Model details ─────────────────────────────────────────
  const ensemble = {
    H: mk.H, D: mk.D, A: mk.A, O25: mk.O25,
    models: {
      matrix: { H: mk.H, D: mk.D, A: mk.A, O25: mk.O25, lambdaH, lambdaA, weight: 1.0 },
    },
    confidence: { H_ci, D_ci, A_ci, O25_ci, uncertainty },
    nBootstrap: N_BOOT,
    dualTrack, // Expose dual-track for UI display
  };

  // ── 13. Assemble MatchCalc ────────────────────────────────────
  const warnings = validateXGData(
    input.xgHS, input.xgaHC, input.hGames, input.xgAS, input.xgaAC, input.aGames, input.leagueAvg
  );

  return {
    lambdaH, lambdaA,
    lambdaH_raw, lambdaA_raw,
    mk, bets, enh,
    topScores: topScores.slice(0, 5),
    ov: hasOdds ? vigAdjustBest([no.h, no.d, no.a]).overround : null,
    hasValue: bets.some(b => b.isValue),
    hasOdds, warnings, ensemble,
  };
}
