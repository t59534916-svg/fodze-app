// ═══════════════════════════════════════════════════════════════════════
// FODZE Goldilocks — Model-based Edge Computation (Option A)
//
// Computes 1X2 + Ü/U 2.5 probabilities from FODZE's own engine on a match,
// bypassing the Pinnacle-vig-removed proxy the current Goldilocks page uses.
//
// Motivation:
// - Market-based (sharp-vs-soft) edge detection assumes Pinnacle's vig-removed
//   prob IS the truth. That's ~optimal for top leagues but weaker in lower-
//   tier markets where Pinnacle's line-maker doesn't know the teams deeply.
// - Engine edges catch mispricings Pinnacle misses — especially in Liga 3,
//   Primeira, Greek SL etc. where FODZE has xG history but Pinnacle doesn't
//   have a dedicated quant modelling those matches.
// - But: if the engine is WRONG on a match (missing absence data, bad xG
//   synthesis), it'll "find" edge everywhere. So we keep market-edge as
//   an independent cross-check and surface both. CONSENSUS (both agree) is
//   the strongest confidence signal.
//
// Deliberately uses the standard `calcMatchEnhanced` + `ensemblePrediction`
// blend instead of v2. v2 needs the LightGBM runtime loaded globally; the
// standard path is pure + dependency-light + what /matchday already uses as
// the default for most users.
// ═══════════════════════════════════════════════════════════════════════

import {
  calcMatchEnhanced,
  getHomeFactor,
  type Markets,
} from "./dixon-coles";
import { ensemblePrediction } from "./ensemble";
import { parseAbsences } from "./absence-parser";
import type { SoSRatings } from "./sos";
import type { RawMatch } from "@/types/match";

export interface EngineProbs {
  /** 1 = home win */
  h: number;
  /** X = draw */
  d: number;
  /** 2 = away win */
  a: number;
  /** Ü 2.5 (over 2.5 goals) */
  o25: number;
  /** U 2.5 (under 2.5 goals) */
  u25: number;
}

export interface ComputeEngineProbsInput {
  match: RawMatch;
  league: string;
  leagueAvg: number;
  leagueHf: number;
  sosRatings?: SoSRatings | null;
}

/**
 * Run FODZE's standard engine blend on a single match and return the 1X2 +
 * Ü/U 2.5 probabilities. Returns `null` when the match lacks usable xG data
 * — the honest "we don't know" signal for the caller, so the Goldilocks
 * page can gracefully fall back to market-edge only.
 *
 * Does NOT mutate `match`.
 */
export function computeEngineProbs(input: ComputeEngineProbsInput): EngineProbs | null {
  const { match, league, leagueAvg, leagueHf, sosRatings } = input;
  const h = match.home;
  const a = match.away;
  if (!h?.name || !a?.name) return null;

  // Refuse when we have no xG summary at all. Synthesised Liga-avg fallbacks
  // upstream DO populate xg_h8 — so `!h.xg_h8` means neither the matchday
  // JSON nor the history loader had anything to say. At that point the
  // engine would produce pure-market output which defeats the purpose.
  if (!h.xg_h8 || !a.xg_a8) return null;

  const hf = getHomeFactor(h.name, leagueHf);

  // Absences — mirrors MatchdayContext.calcMatch / fuck-betting pipeline.
  const homeAbs = parseAbsences(h.injuries, h.name);
  const awayAbs = parseAbsences(a.injuries, a.name);
  const absences =
    homeAbs.length > 0 || awayAbs.length > 0
      ? { home: homeAbs, away: awayAbs }
      : undefined;

  // ── Standard engine ─────────────────────────────────────────────────
  let enhanced;
  try {
    enhanced = calcMatchEnhanced(
      h.xg_h8, h.xga_h8 || 0, h.games || 8, h.form,
      a.xg_a8, a.xga_a8 || 0, a.games || 8, a.form,
      leagueAvg, hf, match.tags || [],
      h.xg_h_history, a.xg_a_history,
      sosRatings || undefined, h.name, a.name, absences,
      { league },
    );
  } catch (err) {
    // Any arithmetic explosion (NaN, bad lambda, etc.) → bail silently so
    // the page falls back to market-edge. We never want a broken engine
    // to kill the whole Goldilocks load.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[Goldilocks] calcMatchEnhanced failed for ${h.name}-${a.name}:`, err);
    }
    return null;
  }

  const mk: Markets = enhanced.mk;

  // ── Ensemble blend (Dixon-Coles + Elo + Logistic + Market) ──────────
  // Same call signature as MatchdayContext:343. For Goldilocks we leave
  // `odds` undefined so the market-model weight drops out — we want the
  // engine's OWN opinion, not one that's already anchored to the market.
  const xgDiffPerGame = (h.xg_h8 / (h.games || 8)) - (a.xg_a8 / (a.games || 8));
  const xgaDiffPerGame = ((h.xga_h8 || 0) / (h.games || 8)) - ((a.xga_a8 || 0) / (a.games || 8));
  const formToPoints = (f: string | undefined) => {
    if (!f) return 7.5;
    return f.split(/\s+/).reduce((s, r) => s + (r === "W" ? 3 : r === "D" ? 1 : 0), 0);
  };

  let ensemble;
  try {
    ensemble = ensemblePrediction(
      { H: mk.H, D: mk.D, A: mk.A, O25: mk.O25 },
      h.name, a.name,
      {
        xgDiffPerGame,
        xgaDiffPerGame,
        formDiff: formToPoints(h.form) - formToPoints(a.form),
        homeFactor: hf,
        totalXG: enhanced.lambdaH + enhanced.lambdaA,
      },
      undefined, // no market anchoring — pure engine opinion
      h.xg_h_history, a.xg_a_history, leagueAvg,
      league,
    );
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[Goldilocks] ensemblePrediction failed for ${h.name}-${a.name}:`, err);
    }
    return null;
  }

  // Validate outputs — if H/D/A don't roughly sum to 1 or any is NaN,
  // we treat it as "no engine opinion" rather than shipping garbage edges.
  const sum = ensemble.H + ensemble.D + ensemble.A;
  if (!Number.isFinite(sum) || sum < 0.95 || sum > 1.05) return null;
  if (!Number.isFinite(ensemble.O25) || ensemble.O25 <= 0 || ensemble.O25 >= 1) {
    return null;
  }

  return {
    h: ensemble.H,
    d: ensemble.D,
    a: ensemble.A,
    o25: ensemble.O25,
    u25: Math.max(0, Math.min(1, 1 - ensemble.O25)),
  };
}

/**
 * Tag describing which edge source detected a value bet in the
 * 2.5-7.5% Goldilocks zone.
 */
export type EdgeSource = "market" | "engine" | "consensus";

/**
 * Classify an edge based on which source (market, engine, or both) detected
 * it in the Goldilocks zone. Edges outside the zone return `null`.
 *
 * - "consensus": BOTH detected → strongest signal, multiplicative confidence.
 * - "market":    only sharp-vs-soft sees it → engine disagrees or is absent.
 * - "engine":    only FODZE's engine sees it → Pinnacle doesn't mark this up,
 *                could be real lower-league edge OR an engine miss. Caller
 *                should surface this clearly so the user can sanity-check.
 */
export function classifyEdgeSource(
  marketInZone: boolean,
  engineInZone: boolean,
): EdgeSource | null {
  if (marketInZone && engineInZone) return "consensus";
  if (marketInZone) return "market";
  if (engineInZone) return "engine";
  return null;
}
