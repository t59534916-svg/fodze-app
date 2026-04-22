// ═══════════════════════════════════════════════════════════════════════
// FODZE — Historical Replay (Hindsight-Free)
// ═══════════════════════════════════════════════════════════════════════
//
// For each historical match M at date T, reconstructs ONLY features
// that were available before T, runs the engines, scores against actual
// outcome. No odds involved — pure prediction-quality replay.
//
// Hindsight-safety rules:
//   1. Every feature read from team_xg_history is filtered
//      `match_date < T_M` — no leakage from subsequent matches
//   2. Odds-dependent paths skipped (engines called with odds=undefined)
//   3. Training-data leakage for LGBM acknowledged — caller should
//      filter to matches AFTER the model's training cutoff
//
// Output is a list of {match, prediction, outcome, score} rows that
// aggregate.ts can reduce into per-engine / per-league / per-bucket
// calibration metrics.
// ═══════════════════════════════════════════════════════════════════════

import type { TeamXGMatch } from "@/lib/supabase";
import type { XGHistoryEntry } from "@/types/match";
import { calcMatchEnhanced, type EnhancedResult, LEAGUES } from "@/lib/dixon-coles";
import { calcMatchPoissonML } from "@/lib/poisson-ml-engine";
import { calcMatchPoissonMLv2 } from "@/lib/poisson-ml-engine-v2";
import { scoreMatch, type MatchScore } from "@/lib/backtest";

export interface ReplayInput {
  /** All team_xg_history rows for the league, both venues. */
  allRows: TeamXGMatch[];
  league: string;
  /** Minimum prior matches required per team before we score. Below
      this we skip the match entirely — engines refuse to predict. */
  minPriorGames?: number;
  /** Only replay matches after this ISO date. Use the LightGBM model's
      training cutoff to exclude training-set matches. */
  afterDate?: string;
  /** Max matches to replay — client-side budget guard. */
  limit?: number;
}

export interface ReplayRow {
  match_date: string;
  home_team: string;
  away_team: string;
  league: string;
  goals_h: number;
  goals_a: number;
  xg_h: number;
  xg_a: number;
  outcome_1x2: "H" | "D" | "A";
  over25: boolean;
  btts: boolean;
  // Engine predictions
  ensemble: { prob_h: number; prob_d: number; prob_a: number; prob_o25: number; prob_btts: number | null } | null;
  v1: { prob_h: number; prob_d: number; prob_a: number; prob_o25: number; prob_btts: number | null } | null;
  v2: { prob_h: number; prob_d: number; prob_a: number; prob_o25: number; prob_btts: number | null } | null;
  // Scores per engine
  score_ensemble: MatchScore | null;
  score_v1: MatchScore | null;
  score_v2: MatchScore | null;
}

// ─── Per-team chronological index ────────────────────────────────

/**
 * Build per-team venue-specific history lookup: for each (team, venue)
 * return rows sorted ascending by match_date. Call once upfront so the
 * O(N·M) per-match slicing stays cheap.
 */
function buildTeamIndex(rows: TeamXGMatch[]): Map<string, TeamXGMatch[]> {
  const idx = new Map<string, TeamXGMatch[]>();
  for (const r of rows) {
    const key = `${r.team}|${r.venue}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key)!.push(r);
  }
  for (const [, arr] of idx) {
    arr.sort((a, b) => a.match_date.localeCompare(b.match_date));
  }
  return idx;
}

function toHistoryEntries(rows: TeamXGMatch[]): XGHistoryEntry[] {
  return rows.map(m => ({
    xg: m.xg,
    xga: m.xga,
    npxg: m.npxg ?? undefined,
    npxga: m.npxga ?? undefined,
    ppda_att: m.ppda_att ?? undefined,
    ppda_def: m.ppda_def ?? undefined,
    deep: m.deep ?? undefined,
    deep_allowed: m.deep_allowed ?? undefined,
    goals_for: m.goals_for ?? undefined,
    goals_against: m.goals_against ?? undefined,
    date: m.match_date,
    opponent: m.opponent || undefined,
  }));
}

// ─── Replay ──────────────────────────────────────────────────────

export function replayLeague(input: ReplayInput): ReplayRow[] {
  const { allRows, league, minPriorGames = 6, afterDate, limit = 2000 } = input;
  const leagueCfg = LEAGUES[league];
  if (!leagueCfg) {
    console.warn(`[replay] Unknown league ${league}, using bundesliga defaults`);
  }
  const leagueAvg = leagueCfg?.avg ?? 1.38;
  const homeFactor = leagueCfg?.hf ?? 1.25;

  const idx = buildTeamIndex(allRows);
  const homeMatches = allRows
    .filter(r => r.venue === "home")
    .filter(r => !afterDate || r.match_date >= afterDate)
    .sort((a, b) => a.match_date.localeCompare(b.match_date));

  const results: ReplayRow[] = [];

  for (const m of homeMatches) {
    if (results.length >= limit) break;
    // Guard: each home-venue row in team_xg_history has goals_for/against
    // (the actual match). If missing, skip.
    if (m.goals_for == null || m.goals_against == null) continue;

    // Point-in-time slicing: only rows strictly BEFORE this match's date.
    // Same-date matches can't inform: we treat them as concurrent.
    const homeHist = (idx.get(`${m.team}|home`) ?? [])
      .filter(r => r.match_date < m.match_date)
      .slice(-8);
    const awayHist = (idx.get(`${m.opponent}|away`) ?? [])
      .filter(r => r.match_date < m.match_date)
      .slice(-8);

    if (homeHist.length < minPriorGames || awayHist.length < minPriorGames) continue;

    // Build engine input shape — mirrors MatchdayContext.loadCached's
    // fallback-fill logic (sum last-8 xG + xGA for the summary fields).
    const homeXG8 = homeHist.reduce((s, r) => s + r.xg, 0);
    const homeXGA8 = homeHist.reduce((s, r) => s + r.xga, 0);
    const awayXG8 = awayHist.reduce((s, r) => s + r.xg, 0);
    const awayXGA8 = awayHist.reduce((s, r) => s + r.xga, 0);

    const outcome_1x2: "H" | "D" | "A" =
      m.goals_for > m.goals_against ? "H"
      : m.goals_for < m.goals_against ? "A"
      : "D";
    const over25 = m.goals_for + m.goals_against > 2;
    const btts = m.goals_for > 0 && m.goals_against > 0;

    // ── Engines ──
    // Ensemble: calcMatchEnhanced delivers λ + mk.H/D/A/O25 + BTTS.
    let ensemble: ReplayRow["ensemble"] = null;
    try {
      const enh: EnhancedResult = calcMatchEnhanced(
        homeXG8, homeXGA8, homeHist.length, undefined,
        awayXG8, awayXGA8, awayHist.length, undefined,
        leagueAvg, homeFactor, [],
        toHistoryEntries(homeHist), toHistoryEntries(awayHist),
        undefined, m.team, m.opponent, undefined,
        { league },
      );
      if (enh?.mk) {
        ensemble = {
          prob_h: enh.mk.H, prob_d: enh.mk.D, prob_a: enh.mk.A,
          prob_o25: enh.mk.O25,
          prob_btts: (enh.mk as any).BTTS ?? null,
        };
      }
    } catch (e) {
      // Engine failures are part of the test — noted as null, score skipped
    }

    let v1: ReplayRow["v1"] = null;
    try {
      const r = calcMatchPoissonML({
        xgHS: homeXG8, xgaHC: homeXGA8, hGames: homeHist.length,
        xgAS: awayXG8, xgaAC: awayXGA8, aGames: awayHist.length,
        leagueAvg, homeFactor, league, tags: [],
        hHistory: toHistoryEntries(homeHist), aHistory: toHistoryEntries(awayHist),
        homeTeam: m.team, awayTeam: m.opponent,
        odds: undefined, fraction: 0.33,
        options: { league } as any,
      });
      if (r?.mk) {
        v1 = {
          prob_h: r.mk.H, prob_d: r.mk.D, prob_a: r.mk.A,
          prob_o25: r.mk.O25,
          prob_btts: (r.mk as any).BTTS ?? null,
        };
      }
    } catch { /* skip */ }

    let v2: ReplayRow["v2"] = null;
    try {
      const r = calcMatchPoissonMLv2({
        xgHS: homeXG8, xgaHC: homeXGA8, hGames: homeHist.length,
        xgAS: awayXG8, xgaAC: awayXGA8, aGames: awayHist.length,
        leagueAvg, homeFactor, league, tags: [],
        hHistory: toHistoryEntries(homeHist), aHistory: toHistoryEntries(awayHist),
        homeTeam: m.team, awayTeam: m.opponent,
        odds: undefined, fraction: 0.33,
        options: { league } as any,
      });
      if (r?.mk) {
        v2 = {
          prob_h: r.mk.H, prob_d: r.mk.D, prob_a: r.mk.A,
          prob_o25: r.mk.O25,
          prob_btts: (r.mk as any).BTTS ?? null,
        };
      }
    } catch { /* skip */ }

    const outShape = { outcome_1x2, over25, btts };
    const score = (p: NonNullable<ReplayRow["ensemble"]> | null) =>
      p ? scoreMatch(
        { prob_h: p.prob_h, prob_d: p.prob_d, prob_a: p.prob_a, prob_o25: p.prob_o25, prob_btts: p.prob_btts },
        outShape,
      ) : null;

    results.push({
      match_date: m.match_date,
      home_team: m.team, away_team: m.opponent,
      league,
      goals_h: m.goals_for, goals_a: m.goals_against,
      xg_h: m.xg, xg_a: m.xga,
      outcome_1x2, over25, btts,
      ensemble, v1, v2,
      score_ensemble: score(ensemble),
      score_v1: score(v1),
      score_v2: score(v2),
    });
  }

  return results;
}

// ─── Refinement Analysis ─────────────────────────────────────────
//
// Given the replay rows, surface WHICH hyperparameters look off:
//   - Home overpredicted    → homeFactor too high
//   - Draws under            → rho too negative
//   - O25 over               → lambda shrinkage too weak
//   - Overconfidence at 70%+ → increase shrinkage or add temperature

export interface BiasReport {
  engine: "ensemble" | "v1" | "v2";
  n: number;
  // Mean predicted minus realized freq, per binary event. Positive =
  // engine overpredicts the event; negative = underpredicts.
  bias_h: number;
  bias_d: number;
  bias_a: number;
  bias_o25: number;
  // Calibration buckets for the 1X2-favorite decile.
  // Entries align with 0.3-0.4, 0.4-0.5, ..., 0.9-1.0.
  calibration_fav: Array<{ bin: string; predicted: number; realized: number; n: number }>;
  // Short human-readable suggestions
  suggestions: string[];
}

function computeBias(
  rows: ReplayRow[],
  pick: (r: ReplayRow) => ReplayRow["ensemble"],
): Pick<BiasReport, "n" | "bias_h" | "bias_d" | "bias_a" | "bias_o25" | "calibration_fav"> {
  const withPred = rows.filter(r => pick(r) != null);
  const n = withPred.length;
  if (n === 0) {
    return { n, bias_h: 0, bias_d: 0, bias_a: 0, bias_o25: 0, calibration_fav: [] };
  }
  let sumPredH = 0, sumPredD = 0, sumPredA = 0, sumPredO25 = 0;
  let countH = 0, countD = 0, countA = 0, countO25 = 0;
  for (const r of withPred) {
    const p = pick(r)!;
    sumPredH += p.prob_h;
    sumPredD += p.prob_d;
    sumPredA += p.prob_a;
    sumPredO25 += p.prob_o25;
    if (r.outcome_1x2 === "H") countH++;
    if (r.outcome_1x2 === "D") countD++;
    if (r.outcome_1x2 === "A") countA++;
    if (r.over25) countO25++;
  }
  const bias_h = sumPredH / n - countH / n;
  const bias_d = sumPredD / n - countD / n;
  const bias_a = sumPredA / n - countA / n;
  const bias_o25 = sumPredO25 / n - countO25 / n;

  // Favorite-decile calibration
  const bins: Array<{ bin: string; preds: number[]; hits: boolean[] }> = [
    { bin: "30-40%", preds: [], hits: [] },
    { bin: "40-50%", preds: [], hits: [] },
    { bin: "50-60%", preds: [], hits: [] },
    { bin: "60-70%", preds: [], hits: [] },
    { bin: "70-80%", preds: [], hits: [] },
    { bin: "80-100%", preds: [], hits: [] },
  ];
  for (const r of withPred) {
    const p = pick(r)!;
    const favP = Math.max(p.prob_h, p.prob_d, p.prob_a);
    const favSide =
      p.prob_h === favP ? "H"
      : p.prob_a === favP ? "A"
      : "D";
    const hit = r.outcome_1x2 === favSide;
    const idx =
      favP < 0.4 ? 0 : favP < 0.5 ? 1 : favP < 0.6 ? 2 : favP < 0.7 ? 3 : favP < 0.8 ? 4 : 5;
    bins[idx].preds.push(favP);
    bins[idx].hits.push(hit);
  }
  const calibration_fav = bins
    .filter(b => b.preds.length > 0)
    .map(b => ({
      bin: b.bin,
      predicted: b.preds.reduce((s, v) => s + v, 0) / b.preds.length,
      realized: b.hits.filter(Boolean).length / b.hits.length,
      n: b.preds.length,
    }));

  return { n, bias_h, bias_d, bias_a, bias_o25, calibration_fav };
}

function suggestionsFor(bias: ReturnType<typeof computeBias>): string[] {
  const out: string[] = [];
  const abs = Math.abs;
  if (abs(bias.bias_h) > 0.02) {
    out.push(`${bias.bias_h > 0 ? "Home überschätzt" : "Home unterschätzt"} um ${(bias.bias_h * 100).toFixed(1)}pp → homeFactor ${bias.bias_h > 0 ? "−" : "+"}${(abs(bias.bias_h) * 4).toFixed(1)}% erwägen`);
  }
  if (abs(bias.bias_d) > 0.015) {
    out.push(`${bias.bias_d > 0 ? "Unentschieden überschätzt" : "Unentschieden unterschätzt"} um ${(bias.bias_d * 100).toFixed(1)}pp → rho ${bias.bias_d > 0 ? "−0.02" : "+0.02"} erwägen`);
  }
  if (abs(bias.bias_a) > 0.02) {
    out.push(`Ausw. ${bias.bias_a > 0 ? "überschätzt" : "unterschätzt"} um ${(bias.bias_a * 100).toFixed(1)}pp`);
  }
  if (abs(bias.bias_o25) > 0.03) {
    out.push(`Ü2.5 ${bias.bias_o25 > 0 ? "überschätzt" : "unterschätzt"} um ${(bias.bias_o25 * 100).toFixed(1)}pp → lambda-Shrinkage ${bias.bias_o25 > 0 ? "verstärken" : "lockern"}`);
  }
  // Overconfidence check on top bucket (predicted 70%+ vs actual hit rate)
  const topBucket = bias.calibration_fav.find(b => b.bin === "70-80%" || b.bin === "80-100%");
  if (topBucket && topBucket.n >= 10) {
    const gap = topBucket.predicted - topBucket.realized;
    if (gap > 0.04) {
      out.push(`Überkonfidenz im ${topBucket.bin}-Bucket: sagt ${(topBucket.predicted * 100).toFixed(1)}%, trifft ${(topBucket.realized * 100).toFixed(1)}% (Δ ${(gap * 100).toFixed(1)}pp) → Temperature-Scaling erwägen`);
    }
  }
  if (out.length === 0) out.push("Keine nennenswerten systematischen Bias — Model konsistent mit Realität");
  return out;
}

export function analyzeRefinement(rows: ReplayRow[]): BiasReport[] {
  return [
    { engine: "ensemble" as const, pick: (r: ReplayRow) => r.ensemble },
    { engine: "v1" as const, pick: (r: ReplayRow) => r.v1 },
    { engine: "v2" as const, pick: (r: ReplayRow) => r.v2 },
  ].map(({ engine, pick }) => {
    const bias = computeBias(rows, pick);
    return { engine, ...bias, suggestions: suggestionsFor(bias) };
  });
}
