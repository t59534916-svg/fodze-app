// ═══════════════════════════════════════════════════════════════════════
// FODZE Game-State xG Aggregation Helpers
//
// Given a match's shot timeline (each shot has minute + xG + team-side
// + shot outcome), split xG / xGA / minutes-played into three buckets:
//   level     — teams currently tied
//   leading   — team of interest is ahead
//   trailing  — team of interest is behind
//
// Syzygy Analytics (Nov 2025) shows teams in GS(+1) systematically
// under-create per minute (defensive shell), and GS(-1) over-create
// (opening up to chase). Using xG-while-level as the strength prior
// corrects a well-documented bias in season-total xG rankings.
//
// All functions are pure and synchronous — shared between
// scripts/backfill-xg-by-state.mjs and tests/game-state-xg.test.ts.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Score-state classifier from the perspective of a given team.
 *
 *   team = "home" → compares home_goals vs away_goals
 *   team = "away" → compares away_goals vs home_goals (inverted)
 *
 * Returns "level" | "leading" | "trailing".
 */
export function inferGameState(teamSide, homeGoals, awayGoals) {
  const mine = teamSide === "home" ? homeGoals : awayGoals;
  const theirs = teamSide === "home" ? awayGoals : homeGoals;
  if (mine > theirs) return "leading";
  if (mine < theirs) return "trailing";
  return "level";
}

/**
 * Given a sorted-by-minute list of goal events, walk through minutes
 * 1..matchLength and count how many minutes were spent in each score state
 * from the team's perspective.
 *
 * goalEvents = [{ minute, scoringSide: "home"|"away" }]
 * matchLength = typically 90 (or 95+ if you want to include stoppage).
 *
 * Returns { level, leading, trailing } — all ints summing to matchLength.
 */
export function computeMinutesPerState(teamSide, goalEvents, matchLength = 90) {
  const ev = (goalEvents || [])
    .slice()
    .sort((a, b) => (a.minute || 0) - (b.minute || 0));

  let hGoals = 0, aGoals = 0;
  let evIdx = 0;
  const counts = { level: 0, leading: 0, trailing: 0 };

  for (let m = 1; m <= matchLength; m++) {
    // Apply all goals scored at minute <= m (strict-<) before classifying.
    // "Minute m" is the whole 60-second window ending at m'th minute-mark,
    // so a goal at minute 45 affects classifications for m=46 onward.
    while (evIdx < ev.length && (ev[evIdx].minute || 0) < m) {
      if (ev[evIdx].scoringSide === "home") hGoals++;
      else if (ev[evIdx].scoringSide === "away") aGoals++;
      evIdx++;
    }
    counts[inferGameState(teamSide, hGoals, aGoals)]++;
  }
  return counts;
}

/**
 * Aggregate shot-level xG into state-bucketed totals from a team's view.
 *
 * shots = [{ minute, xG, shootingSide: "home"|"away", homeGoalsBefore, awayGoalsBefore }]
 *   homeGoalsBefore / awayGoalsBefore = score at the INSTANT the shot
 *   was taken, before any goal from this shot lands. When unavailable,
 *   pass (0, 0) and wire the caller to compute incrementally via goalEvents.
 *
 * Returns six numbers:
 *   xg_level, xg_leading, xg_trailing       — team's own shots
 *   xga_level, xga_leading, xga_trailing    — opponent's shots against team
 *
 * Convention: "team" is always the team-of-interest. xG scored BY team
 * goes into xg_*, scored AGAINST team goes into xga_*.
 */
export function aggregateXgByState(teamSide, shots) {
  const out = {
    xg_level: 0, xg_leading: 0, xg_trailing: 0,
    xga_level: 0, xga_leading: 0, xga_trailing: 0,
  };
  const oppSide = teamSide === "home" ? "away" : "home";

  for (const s of shots || []) {
    const xg = Number(s.xG || 0);
    if (!Number.isFinite(xg) || xg < 0) continue;

    const state = inferGameState(
      teamSide,
      s.homeGoalsBefore || 0,
      s.awayGoalsBefore || 0,
    );
    const forThem = s.shootingSide === oppSide;
    const prefix = forThem ? "xga_" : "xg_";
    out[prefix + state] += xg;
  }

  // Round to 4 decimals to match team_xg_history storage precision.
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10000) / 10000;
  return out;
}

/**
 * Fallback when state columns are null: decompose a season-total xG
 * into the three state buckets using a literature-derived global ratio.
 *
 * Understat top-5-league mean (2018-2024, ~30k matches): teams spend
 * ~58% of minutes level, ~22% leading, ~20% trailing. Teams create
 * slightly more xG per-minute in trailing state (chasing), slightly
 * less while leading (protecting). Ratios encode both effects:
 *
 *   level:    58% of minutes × 1.00 xG-rate  → 58/60 ≈ 0.58 share
 *   leading:  22% of minutes × 0.88 xG-rate  → 19/60 ≈ 0.19 share
 *   trailing: 20% of minutes × 1.15 xG-rate  → 23/60 ≈ 0.23 share
 *
 * Sum = 1.00 by construction. Runtime loggers flag when this prior
 * fires (vs a real state-xG column) so data-quality audits can track
 * how much of the v2 feature-vector is prior-driven.
 */
export const STATE_RATIO_PRIOR = Object.freeze({
  level:    0.58,
  leading:  0.19,
  trailing: 0.23,
});

export function applyStateRatioPrior(seasonTotalXG) {
  const total = Number(seasonTotalXG || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { xg_level: 0, xg_leading: 0, xg_trailing: 0 };
  }
  return {
    xg_level:    Math.round(total * STATE_RATIO_PRIOR.level    * 10000) / 10000,
    xg_leading:  Math.round(total * STATE_RATIO_PRIOR.leading  * 10000) / 10000,
    xg_trailing: Math.round(total * STATE_RATIO_PRIOR.trailing * 10000) / 10000,
  };
}

// ─── Set-Piece vs Open-Play aggregation (Phase 2.4) ─────────────────
//
// Understat shot-event `situation` taxonomy:
//   "OpenPlay"      — run-of-play chance
//   "SetPiece"      — indirect set-piece (e.g. free kick into the box)
//   "FromCorner"    — headed/pinged chance from a corner
//   "DirectFreekick"— direct free-kick attempt
//   "Penalty"       — spot kick
// All four non-OpenPlay values feed the "setpiece" bucket.
//
// Analytics FC (Oct 2024) shows open-play-xGDiff and set-piece-xG carry
// a Pearson −0.36 — genuinely independent dimensions. Capturing the
// share lets the v2 engine spot mispriced set-piece specialists (Arsenal
// 2025 at ~50% SP share vs weak-SP-defence opponent).

/**
 * Classify an Understat shot situation into the two buckets we store.
 * Defaults to "openplay" for unknown / missing input — conservative
 * since mis-bucketing a shot is worse than dropping it.
 */
export function classifySituation(situation) {
  if (!situation) return "openplay";
  const s = String(situation).toLowerCase();
  if (s === "openplay" || s === "open play") return "openplay";
  if (
    s === "setpiece" || s === "set piece" ||
    s === "fromcorner" || s === "from corner" ||
    s === "directfreekick" || s === "direct freekick" ||
    s === "penalty"
  ) return "setpiece";
  return "openplay";
}

/**
 * Aggregate shot-level xG into open-play vs set-piece buckets from a
 * team's perspective. Mirrors aggregateXgByState — taking the same
 * enriched-shot objects, just keyed by situation instead of score state.
 *
 * shots = [{ xG, shootingSide: "home"|"away", situation: "OpenPlay"|... }]
 *
 * Returns:
 *   xg_openplay  — team's own open-play xG
 *   xg_setpiece  — team's own set-piece + penalty + freekick xG
 *   xga_openplay — opponent's open-play xG against team
 *   xga_setpiece — opponent's set-piece xG against team
 *
 * Numbers round to 4 decimals to match team_xg_history storage.
 */
export function aggregateXgBySituation(teamSide, shots) {
  const out = {
    xg_openplay: 0, xg_setpiece: 0,
    xga_openplay: 0, xga_setpiece: 0,
  };
  const oppSide = teamSide === "home" ? "away" : "home";
  for (const s of shots || []) {
    const xg = Number(s.xG || 0);
    if (!Number.isFinite(xg) || xg < 0) continue;
    const bucket = classifySituation(s.situation);
    const forThem = s.shootingSide === oppSide;
    const prefix = forThem ? "xga_" : "xg_";
    out[prefix + bucket] += xg;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10000) / 10000;
  return out;
}

/**
 * Global ratio prior (top-5 Understat 2018-2024, ~30k matches):
 *   open-play : set-piece ≈ 73 : 27
 * Used when the situation columns are null but we still want a first-
 * order split for engines that insist on the feature.
 */
export const SITUATION_RATIO_PRIOR = Object.freeze({
  openplay: 0.73,
  setpiece: 0.27,
});

export function applySituationRatioPrior(seasonTotalXG) {
  const total = Number(seasonTotalXG || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { xg_openplay: 0, xg_setpiece: 0 };
  }
  return {
    xg_openplay: Math.round(total * SITUATION_RATIO_PRIOR.openplay * 10000) / 10000,
    xg_setpiece: Math.round(total * SITUATION_RATIO_PRIOR.setpiece * 10000) / 10000,
  };
}
