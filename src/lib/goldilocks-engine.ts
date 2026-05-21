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

// ═══════════════════════════════════════════════════════════════════════
// v1.1 · Asymmetric Negation Protocol
//
// The Epistemic Audit of Inferential Cartography v1.0 surfaced four fatal
// flaws: academic Brier-gain hunting, parametric hallucinations (Gaussian
// pulses on discrete data), MNAR selection traps, and intra-matchday
// look-ahead bias via date-based queries.
//
// v1.1 abandons additive micro-edges (+0.05% ROI gets eaten by the Pinnacle
// spread anyway) and pivots to ASYMMETRIC NEGATION: identifying toxic market
// mispricings (Traps) where our baseline Poisson engine projects, e.g., 65%
// win-rate but empirical reality says 45%. The filter is a SHIELD, not a
// sword — multipliers strictly ≤ 1.0, never above.
//
// ────────────────────────────────────────────────────────────────────────
// Mandate map for this block:
//   M2 — SHADOW_LOG_ONLY quarantine for unverified signals (200-match burn-in)
//   M4 — No Gaussian; piecewise step function for manager-bounce
//   M5 — Heckman MNAR gate: Possession Trap fires only in Tier-A coverage leagues
//   M7 — Asymmetric Negation: stakeMultiplier ∈ [0, 1.0] (never > 1)
//   M8 — CLV-reflexivity tracking: epistemicTrails persisted for sharp-market
//        decay detection. Future cron `scripts/clv-trap-decay.mjs` will join
//        epistemicTrails × odds_closing_history; once sharp markets converge
//        on a given trap (movedAgainstUs rate → 50%) the filter auto-deprecates.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Leagues with historical possession coverage > 95% — only here is the
 * Possession Trap reliable. Heckman MNAR gate: blocking it from sparse
 * leagues prevents selection bias where the trap only fires on the
 * specific subset of matches that happened to have possession data.
 *
 * 56.3% of matches across all 22 FODZE leagues are missing possession.
 * Restricting to Tier-A inverts that: ≥95% present, < 5% MNAR.
 */
const TIER_A_COVERAGE: ReadonlySet<string> = new Set([
  "epl", "la_liga", "bundesliga", "serie_a", "ligue_1",
  "bundesliga2", "championship", "eredivisie", "primeira_liga",
  "serie_b", "la_liga2", "ligue_2",
]);

/**
 * Quarantine list — signals computed but FORBIDDEN from altering the
 * stake multiplier until they have a clean 200-match live-burn-in OOS
 * validation. They write to `epistemicTrails` with `shadow: true` for
 * post-hoc analysis only.
 *
 * Members:
 *   - TACTICAL_WIDTH       — Top-5 only, no 24/25 OOS validation yet
 *   - MANAGER_BOUNCE_RAW   — pending GAM deployment (M4)
 */
const SHADOW_LOG_ONLY: ReadonlySet<string> = new Set([
  "TACTICAL_WIDTH",
  "MANAGER_BOUNCE_RAW",
]);

/**
 * Pre-bet signal bundle that feeds the latent-topology evaluator.
 *
 * Per the audit correction: `xgDiffEwma3` (a *difference*) is what flips
 * negative for "Brentford-style" toxic-dominance teams. Raw xG EWMA is
 * non-negative by construction and cannot be < 0 — `xgEwma3` is used
 * only as a level-check against the league baseline.
 */
export interface LatentSignals {
  /** home_possession_pct − away_possession_pct, in pp. NULL if missing. */
  possessionDiff: number | null;
  /** xG-FOR EWMA(3) minus xG-AGAINST EWMA(3). CAN be negative. */
  xgDiffEwma3: number | null;
  /** Raw xG-FOR EWMA(3). Always ≥ 0; used for level-vs-baseline check. */
  xgEwma3: number | null;
  /** Matches since the team's manager last changed.
   *  Engine clips defensively to window [0, 30] (`managerBounceMultiplier`),
   *  but callers should still pass values in that range. */
  matchSinceManagerChange: number | null;
  /** Top-5-only tactical-width feature. Currently SHADOW_LOG_ONLY. */
  tacticalWidth: number | null;
  /** The baseline engine's home-win-rate prediction for this match.
   *  Range: [0, 1] (probability). */
  engineHWRate: number;
  /** Per-Liga average xG-per-team-per-game baseline.
   *  Range: typically [0.9, 1.9] across the 22 covered leagues. */
  leagueBaselineXg: number;
}

/**
 * Forensic log record for every trap firing.
 *
 * Persisted to a future `epistemic_trails` Supabase table. The MANDATORY
 * `shadow` field separates real vetoes (False) from quarantined-signal
 * shadow-logs (True). Downstream CLV-decay cron uses this to detect when
 * sharp markets price in our edge and we should retire the filter.
 *
 * Future CLV-decay cron (scripts/clv-trap-decay.mjs) — joins this table
 * with odds_closing_history on (match_key, kickoff). For each trap-firing
 * bet, compares user_odds against pinnacle_close: if movedAgainstUs at
 * rate ≈ 50% the trap is no longer alpha → deprecate the filter.
 */
export interface EpistemicTrail {
  trapKind: string;
  /** Canonical FODZE format from `src/lib/format.ts::matchKey(league, home, away)`.
   *  MUST match the string used by `bets.match_key` + `odds_closing_history.match_key`
   *  so the CLV-decay cron's join lands rows. */
  matchKey: string;
  /** Unix epoch SECONDS (NOT milliseconds). Matches the migration column unit
   *  + the CLV-decay cron's `match_kickoff < now/1000` filter. Writing ms here
   *  pushes the row 1000× into the future and the cron skips it forever. */
  matchKickoff: number;
  /** Unix epoch MILLISECONDS (`Date.now()` default). Part of the UNIQUE
   *  `(trap_kind, match_key, detected_at)` so each re-emission gets its own row. */
  detectedAt: number;
  /** Numeric-only signal map by design — burn-in/CLV crons compute means + sums
   *  over the values. The DB column is JSONB and would accept strings/bools, but
   *  any non-numeric value here would NaN out the downstream aggregation. */
  rawSignals: Record<string, number>;
  /** Engine baseline home-win-rate prediction at trap-detection time. Range: [0, 1]. */
  predictedHWRate: number;
  /** True = SHADOW_LOG_ONLY signal (did NOT alter the stake multiplier). */
  shadow: boolean;
  // ── Filled later by CLV-watcher cron (M8) ─────────────────────────
  // Nullable, not just optional: PostgREST returns `null` for unfilled
  // numeric/boolean columns, not `undefined`. Typing as `?: T | null`
  // covers both "row never went through CLV-decay" (server returns null)
  // AND "engine output before persistence" (caller omits the field).
  closingOdds?: number | null;
  movedAgainstUs?: boolean | null;
}

/**
 * Output of `evaluateLatentTopology`.
 *
 * `stakeMultiplier ∈ [0, 1.0]` — Asymmetric Negation guarantees no boosts.
 * If no traps fire, you get a clean 1.0 pass-through. Each trap can only
 * lower (or keep) the multiplier — never raise.
 */
export interface LatentTopology {
  /** Strictly in [0, 1.0]. Multiply your Kelly fraction by this. */
  stakeMultiplier: number;
  /** Ordered list of trap labels that actually altered the multiplier. */
  vetoes: string[];
  /** Quarantined (SHADOW_LOG_ONLY) signals that fired but did NOT alter stake. */
  shadowSignals: string[];
  /** Forensic log records — persist to epistemic_trails for CLV-decay analysis. */
  epistemicTrails: EpistemicTrail[];
}

/**
 * M4: Piecewise constant step function for the manager-bounce regime.
 *
 * Replaces the forbidden Gaussian `Math.exp(-0.5 * ((m - μ) / σ)²)` that the
 * v1.0 cartography forced on discrete `match_since_change` data. The Python
 * GAM (`pygam` Penalized B-Splines) in `tools/v4/train_pipeline.py` will
 * derive a smoothed version once trained — until then this discrete regime
 * matrix is the defensive truth.
 *
 * Empirical regimes from the audit (manager-change windows in 22 leagues):
 *   matches 0–1  → caution (immediate shake-up, performance noise high)
 *   matches 2–3  → honeymoon-fade (new-coach bounce taper)
 *   matches > 3  → settled (no regime effect)
 */
function managerBounceMultiplier(matchesSinceChange: number): number {
  if (matchesSinceChange < 0 || matchesSinceChange > 30) return 1.0;
  if (matchesSinceChange <= 1) return 0.85;
  if (matchesSinceChange <= 3) return 0.92;
  return 1.0;
}

/**
 * Evaluate the latent topology of a match against the v1.1 trap registry.
 *
 * Returns a `LatentTopology` where `stakeMultiplier ∈ [0, 1.0]`. The caller
 * multiplies its Kelly fraction by this value — there are no boosts, only
 * vetoes. Use the `epistemicTrails` for post-hoc CLV-decay analysis (M8).
 *
 * ⚠ UNIT CONTRACT — read this before wiring a new caller:
 *   • `match.kickoff` MUST be Unix epoch **seconds**. The migration column
 *     `match_kickoff BIGINT` stores seconds and the CLV-decay cron filters
 *     with `match_kickoff=lt.${Math.floor(Date.now()/1000)}`. Writing ms
 *     here would push every trail's kickoff ~1000× into the future, so
 *     the cron would never see them as "past kickoff" and would skip
 *     them forever — a silent dead-zone with no error.
 *   • `match.matchKey` MUST match the codebase canonical format from
 *     `src/lib/format.ts::matchKey(league, home, away)`. That's the same
 *     string `odds_closing_history` rows use, so the CLV-decay cron can
 *     join trails × closing-odds. Using a custom format here silently
 *     breaks that join with no schema-level error.
 *
 * The unit tests in `tests/asymmetric-negation.test.ts` happen to pass
 * milliseconds for `kickoff` — that's harmless there because they only
 * assert pass-through, not DB semantics. Don't mirror that in production
 * callers.
 *
 * @param match     A RawMatch with home/away meta + matchKey/kickoff/league
 * @param signals   Pre-computed latent signals (possession diff, xg-EWMA, etc.)
 * @param now       Optional ms-timestamp for the trail's `detectedAt` (defaults to Date.now()).
 *                  This one IS in milliseconds — that's the `detected_at BIGINT  -- ms` migration unit.
 */
export function evaluateLatentTopology(
  match: RawMatch & { matchKey: string; kickoff: number; league: string },
  signals: LatentSignals,
  now: number = Date.now(),
): LatentTopology {
  let mult = 1.0;
  const vetoes: string[] = [];
  const shadowSignals: string[] = [];
  const trails: EpistemicTrail[] = [];

  // ── TRAP 1 · Possession Trap (M5 Heckman MNAR gate) ───────────────────
  //
  // "Brentford-style" toxic-dominance: team dominates possession but creates
  // less xG than they concede AND is performing below the league baseline.
  // Audit recorded -19.8pp deviation from engine HW-rate when triggered.
  //
  // Gates:
  //   1. Tier-A league only (>95% possession coverage → no MNAR selection)
  //   2. possessionDiff > 15 pp (dominance, not minor advantage)
  //   3. xgDiffEwma3 < 0 (inverted quality signal — creates less than concedes)
  //   4. xgEwma3 < 85% of league baseline (level-floor; robust against
  //      strong teams with marginally-negative differential)
  if (
    TIER_A_COVERAGE.has(match.league) &&
    signals.possessionDiff !== null &&
    signals.possessionDiff > 15 &&
    signals.xgDiffEwma3 !== null &&
    signals.xgDiffEwma3 < 0 &&
    signals.xgEwma3 !== null &&
    signals.xgEwma3 < signals.leagueBaselineXg * 0.85
  ) {
    mult = Math.min(mult, 0.3);
    vetoes.push("POSSESSION_TRAP");
    trails.push({
      trapKind: "POSSESSION_TRAP",
      matchKey: match.matchKey,
      matchKickoff: match.kickoff,
      detectedAt: now,
      rawSignals: {
        possessionDiff: signals.possessionDiff,
        xgDiffEwma3: signals.xgDiffEwma3,
        xgEwma3: signals.xgEwma3,
        leagueBaselineXg: signals.leagueBaselineXg,
      },
      predictedHWRate: signals.engineHWRate,
      shadow: false,
    });
  }

  // ── TRAP 2 · Manager-Bounce Regime (M4 discrete steps) ────────────────
  if (signals.matchSinceManagerChange !== null) {
    const bounceMult = managerBounceMultiplier(signals.matchSinceManagerChange);
    if (bounceMult < 1.0) {
      mult = Math.min(mult, bounceMult);
      vetoes.push(`MANAGER_BOUNCE_REGIME_${signals.matchSinceManagerChange}`);
      trails.push({
        trapKind: "MANAGER_BOUNCE_REGIME",
        matchKey: match.matchKey,
        matchKickoff: match.kickoff,
        detectedAt: now,
        rawSignals: {
          matchSinceChange: signals.matchSinceManagerChange,
          bounceMult,
        },
        predictedHWRate: signals.engineHWRate,
        shadow: false,
      });
    }
  }

  // ── SHADOW · Tactical Width (M2 quarantine, 200-match burn-in) ────────
  //
  // Top-5-only feature with no 24/25 OOS validation. We compute its trigger
  // conditions for the audit trail, but STRICTLY do not alter the stake
  // multiplier. A separate cron will analyse epistemicTrails over a 200-
  // match window before this graduates out of SHADOW_LOG_ONLY.
  if (
    SHADOW_LOG_ONLY.has("TACTICAL_WIDTH") &&
    signals.tacticalWidth !== null
  ) {
    const wouldFire = signals.tacticalWidth > 0.4 && signals.engineHWRate > 0.6;
    if (wouldFire) {
      shadowSignals.push("TACTICAL_WIDTH_SHADOW");
      trails.push({
        trapKind: "TACTICAL_WIDTH",
        matchKey: match.matchKey,
        matchKickoff: match.kickoff,
        detectedAt: now,
        rawSignals: {
          tacticalWidth: signals.tacticalWidth,
          engineHWRate: signals.engineHWRate,
        },
        predictedHWRate: signals.engineHWRate,
        shadow: true,
      });
      // INTENTIONALLY does NOT modify `mult` — burn-in only.
    }
  }

  // ── M7 · Asymmetric Negation hard clamp ───────────────────────────────
  // Never above 1.0 (no boosts), never below 0.0 (no anti-bets).
  mult = Math.max(0.0, Math.min(1.0, mult));

  return {
    stakeMultiplier: mult,
    vetoes,
    shadowSignals,
    epistemicTrails: trails,
  };
}
