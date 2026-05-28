// ═══════════════════════════════════════════════════════════════════════
// engine-dispatch — Single-source-of-truth engine-cascade for predictions
//
// Why: MatchdayContext, fuck-betting, and any future "compute λ for a
// match" call-site historically inlined their own
//   "try v2 → fall back to standard"
// pattern. This file centralises that cascade so:
//   1. Adding a new engine (e.g. dev-09 if ever shipped) touches one file
//   2. Engine-availability gating is uniform (model loaded? history available?)
//   3. The PredictionEngine type from engine-registry is the canonical id
//
// Public API:
//   dispatchLambdas(preferred, inputs, fallback)
//     → returns { lambdaH, lambdaA, engineUsed, rho }
//   Where engineUsed is the SAME literal id used in engine-registry — so
//   call sites can build EngineComparison rows + analytics tags uniformly.
//
// This is a NARROW dispatcher — it returns just λ + ρ. Callers that want
// the full MatchCalc envelope (with Kelly bets, CI bands, etc.) should
// use MatchdayContext's `computeAllEngines` instead. fuck-betting only
// needs λ + ρ because it derives its own market-by-market envelope.
// ═══════════════════════════════════════════════════════════════════════

import { calcMatchPoissonMLv2 } from "./poisson-ml-engine-v2";
import { isLGBMModelLoaded, getLGBMRho } from "./lgbm-runtime";
import { calcLambdas, type XGHistoryEntry } from "./dixon-coles";
import type { PlayerProfile } from "./player-impact";
import type { SoSRatings } from "./sos";
import type { PredictionEngine } from "./engine-registry";

/** Minimal inputs needed by the cascade. Mirrors PoissonMLInput's hot fields. */
export interface DispatchInputs {
  xgHS: number; xgaHC: number; hGames: number;
  xgAS: number; xgaAC: number; aGames: number;
  leagueAvg: number; homeFactor: number;
  league: string;
  tags?: string[];
  hHistory?: XGHistoryEntry[];
  aHistory?: XGHistoryEntry[];
  homeTeam: string; awayTeam: string;
  sosRatings?: SoSRatings;
  absences?: { home: PlayerProfile[]; away: PlayerProfile[] };
  /** Kelly fraction — not used by the dispatch itself but kept in the shape
   * so callers can hand the same object to `calcMatchPoissonMLv2` directly. */
  fraction?: number;
}

export interface DispatchResult {
  lambdaH: number;
  lambdaA: number;
  /** The engine that actually fired (post-fallback). One of:
   *  "poisson-ml-v2" | "standard-fallback" — future-ready for dev-03, v3.
   *  Matches PredictionEngine literals or the explicit "standard-fallback". */
  engineUsed: PredictionEngine | "standard-fallback";
  /** Dixon-Coles ρ to use for the score-grid. v2 trains its own; standard
   *  uses a fixed default. */
  rho: number;
}

const STANDARD_DEFAULT_RHO = -0.05;

/**
 * Dispatch λ-computation to the user's preferred engine, with deterministic
 * fallback to standard when:
 *   - The preferred engine's model artifacts aren't loaded
 *   - The match lacks the per-match history the engine requires
 *   - The engine itself returns null (its internal guards refused)
 *
 * `preferred` accepts PredictionEngine ids. For now only "poisson-ml-v2"
 * is supported in the cascade (matches fuck-betting's current behaviour);
 * other engines fall through to standard. Extend `case` block to add v3
 * / dev-03 / dev-09 when their narrow-λ-only paths are needed outside
 * MatchdayContext.
 */
export function dispatchLambdas(
  preferred: PredictionEngine,
  inputs: DispatchInputs,
): DispatchResult {
  // Universal fallback path — used when preferred engine refuses or
  // doesn't apply. Same shape as v1/standard.
  const fallback = (): DispatchResult => {
    const std = calcLambdas(
      inputs.xgHS, inputs.xgaHC, inputs.xgAS, inputs.xgaAC,
      inputs.hGames, inputs.aGames, inputs.leagueAvg, inputs.homeFactor,
    );
    return {
      lambdaH: std.lambdaH,
      lambdaA: std.lambdaA,
      engineUsed: "standard-fallback",
      rho: STANDARD_DEFAULT_RHO,
    };
  };

  switch (preferred) {
    case "poisson-ml-v2": {
      // v2 needs: LightGBM model loaded + per-match xG history for BOTH sides
      const hasModel = isLGBMModelLoaded();
      const hasHist = !!(inputs.hHistory?.length && inputs.aHistory?.length);
      if (!hasModel || !hasHist) return fallback();
      try {
        const result = calcMatchPoissonMLv2({
          xgHS: inputs.xgHS, xgaHC: inputs.xgaHC, hGames: inputs.hGames,
          xgAS: inputs.xgAS, xgaAC: inputs.xgaAC, aGames: inputs.aGames,
          leagueAvg: inputs.leagueAvg, homeFactor: inputs.homeFactor,
          league: inputs.league,
          tags: inputs.tags ?? [],
          hHistory: inputs.hHistory!,
          aHistory: inputs.aHistory!,
          homeTeam: inputs.homeTeam,
          awayTeam: inputs.awayTeam,
          fraction: inputs.fraction ?? 0.25,
          sosRatings: inputs.sosRatings,
          absences: inputs.absences,
        });
        if (!result) return fallback();
        return {
          lambdaH: result.lambdaH,
          lambdaA: result.lambdaA,
          engineUsed: "poisson-ml-v2",
          rho: getLGBMRho(),
        };
      } catch {
        return fallback();
      }
    }
    // Engines not yet wired to the narrow-λ dispatch fall through to standard.
    // MatchdayContext's `computeAllEngines` is the place to evaluate them
    // with full MatchCalc envelope; this narrow dispatcher exists only for
    // callers that just need λ + ρ.
    case "ensemble-v1":
    case "poisson-ml":
    case "poisson-ml-v3":
    case "poisson-ml-dev03":
    case "footbayes-hierarchical":
    default:
      return fallback();
  }
}
