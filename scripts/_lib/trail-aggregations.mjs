// ═══════════════════════════════════════════════════════════════════════
// scripts/_lib/trail-aggregations.mjs
// v1.1 Asymmetric Negation Protocol · pure-function analytics layer
//
// Extracts the analysis logic out of `burn-in-shadow-signals.mjs` and
// `clv-trap-decay.mjs` so it can be unit-tested without hitting Supabase.
// The cron scripts now own only IO (fetch / patch / console) + orchestration;
// every probability or recommendation computation lives here.
//
// All functions in this module are pure: no IO, no globals, no Date.now().
// Tests in tests/trail-aggregations.test.ts cover the contract.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dedupe trails by (trap_kind, match_key) — same trap re-firing on the same
 * match across N page-reloads creates N rows (each with its own detected_at
 * since the table's UNIQUE is (trap_kind, match_key, detected_at)). For
 * STATISTICS we want one observation per (trap, match). Callers should pass
 * the input in `detected_at DESC` order so the first row per pair (= the most
 * recent firing) wins; the engine's predicted_hw_rate at the latest detection
 * is the right one to attribute to the audit.
 *
 * The cron scripts that mutate rows (e.g. CLV-decay setting clv_resolved_at)
 * iterate the RAW list, not this deduped view — per-row audit history is
 * preserved, only aggregation collapses.
 *
 * @param {Array<{trap_kind: string, match_key: string}>} trailsRaw
 * @returns {Array} deduped trails, in input order, one per (trap_kind, match_key)
 */
export function dedupeTrails(trailsRaw) {
  const seen = new Map();
  for (const t of trailsRaw) {
    const k = `${t.trap_kind}:${t.match_key}`;
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()];
}

/**
 * Burn-in analysis: for each trap_kind, compare empirical home-win-rate vs
 * the engine's mean predicted_hw_rate over the same matches. Produces a
 * graduation recommendation when |delta| ≤ eps and n ≥ minN.
 *
 * @param {Array<{trap_kind, match_key, predicted_hw_rate}>} trails
 *   Already deduped + restricted to settled matches by the caller.
 * @param {Map<string, string>} outcomeMap
 *   match_key → 1x2 outcome from match_outcomes ("H" | "D" | "A").
 *   Loose-typed for JSDoc/TS-from-JS friendliness; only `oc === "H"` is read.
 * @param {{ minN: number, eps: number }} opts
 *   minN: minimum sample size before graduation recommendations fire (default 200)
 *   eps:  ±delta in [0,1] within which a signal is considered "calibrated"
 *         (e.g. 0.05 = 5 percentage points).
 * @returns {{ signals: Record<string, object> }} per-trap_kind report.
 */
export function aggregateBurnIn(trails, outcomeMap, { minN, eps }) {
  const byTrap = new Map();
  for (const t of trails) {
    const oc = outcomeMap.get(t.match_key);
    if (!oc) continue; // unresolved match → skip
    const bucket = byTrap.get(t.trap_kind) ?? {
      trap_kind: t.trap_kind,
      n: 0,
      home_wins: 0,
      predicted_hw_rate_sum: 0,
    };
    bucket.n += 1;
    if (oc === "H") bucket.home_wins += 1;
    bucket.predicted_hw_rate_sum += Number(t.predicted_hw_rate);
    byTrap.set(t.trap_kind, bucket);
  }

  const signals = {};
  for (const b of byTrap.values()) {
    const observedHWRate = b.n > 0 ? b.home_wins / b.n : null;
    const meanPredicted = b.n > 0 ? b.predicted_hw_rate_sum / b.n : null;
    const delta =
      observedHWRate !== null && meanPredicted !== null
        ? observedHWRate - meanPredicted
        : null;

    let recommendation;
    if (b.n < minN) {
      recommendation = `INSUFFICIENT_N (need ${minN}, have ${b.n})`;
    } else if (delta === null) {
      recommendation = "MISSING_DATA";
    } else if (Math.abs(delta) <= eps) {
      recommendation = `GRADUATE (delta=${(delta * 100).toFixed(2)}pp ≤ ${eps * 100}pp)`;
    } else if (delta < 0) {
      recommendation = `KEEP_SHADOW (toxic — empirical hwrate ${(observedHWRate * 100).toFixed(1)}% vs predicted ${(meanPredicted * 100).toFixed(1)}%)`;
    } else {
      recommendation = `INVERT_SIGNAL (anti-trap — empirical OUTPERFORMS predicted by ${(delta * 100).toFixed(2)}pp)`;
    }

    signals[b.trap_kind] = {
      n: b.n,
      home_wins: b.home_wins,
      observed_hw_rate: observedHWRate !== null ? Number(observedHWRate.toFixed(4)) : null,
      mean_predicted_hw_rate: meanPredicted !== null ? Number(meanPredicted.toFixed(4)) : null,
      delta_pp: delta !== null ? Number((delta * 100).toFixed(2)) : null,
      recommendation,
    };
  }
  return { signals };
}

/**
 * Compute the implied home-win rate from Pinnacle 1x2 decimal odds, with
 * naive vig-removal (divide each by sum-of-reciprocals). Returns null when
 * the home odds is missing or invalid.
 *
 * Not shin-style (which would be more accurate near 50/50). This intentionally
 * matches the inverse used by `computeEngineProbs` so the comparison against
 * predicted_hw_rate is apples-to-apples (no shin bias asymmetry).
 *
 * @param {{ psch: number|null, pscd?: number|null, psca?: number|null }|null} closing
 * @returns {number|null} implied HW rate in [0, 1], or null
 */
export function computeClosingHwRate(closing) {
  if (!closing || !closing.psch || closing.psch <= 1) return null;
  const invH = 1 / closing.psch;
  const invD = closing.pscd && closing.pscd > 1 ? 1 / closing.pscd : 0;
  const invA = closing.psca && closing.psca > 1 ? 1 / closing.psca : 0;
  const total = invH + invD + invA;
  if (total <= 0) return null;
  return invH / total;
}

/**
 * Status pill for a CLV-decay convergence rate. Encodes the deprecation rules:
 *   convergence ≈ 50%  → sharp markets have priced in this trap → DEPRECATE
 *   convergence < 30%  → trap still alpha, markets disagree → TRAP_ALIVE
 *   30% ≤ x < 45% or 55% ≤ x → CONVERGING (watch)
 *   n < 30             → BURN_IN (premature to judge)
 */
export function clvDecayStatus(convergence, n) {
  if (n < 30) return `BURN_IN (n=${n} < 30)`;
  if (convergence === null) return "MISSING_DATA";
  if (convergence >= 0.45 && convergence <= 0.55) {
    return `MARKET_CONVERGED (${(convergence * 100).toFixed(0)}% match) → DEPRECATE`;
  }
  if (convergence < 0.3) {
    return `TRAP_ALIVE (${(convergence * 100).toFixed(0)}% convergence — sharp markets still disagree)`;
  }
  return `CONVERGING (${(convergence * 100).toFixed(0)}% — watch)`;
}

/**
 * CLV-decay analysis: for each (trap, match), check if the Pinnacle close
 * moved toward the engine's predicted_hw_rate (= market converged → no alpha
 * left) or stayed away (= trap still valid). Output drives the deprecation
 * decision; the cron also patches per-row {closing_odds, moved_against_us,
 * clv_resolved_at} but that's the IO layer's job (see `buildClvUpdates`).
 *
 * @param {Array<{trap_kind, match_key, predicted_hw_rate}>} trails
 *   Raw trails (re-emissions per match preserved for the update loop).
 * @param {Map<string, {psch, pscd?, psca?}>} closingByKey
 *   match_key → Pinnacle closing odds row from odds_closing_history.
 * @param {{ decayEps: number, nowMs?: number }} opts
 *   decayEps: distance-from-prediction threshold below which the market is
 *             considered "converged" (default 0.03 = 3 percentage points).
 *   nowMs:    millis timestamp written to clv_resolved_at on updates
 *             (defaults to Date.now()). Inject in tests for determinism.
 * @returns {{ updates: Array, byTrap: Record<string, object> }}
 *   updates: per-row patches to apply (each with id, closing_odds,
 *            moved_against_us, clv_resolved_at).
 *   byTrap:  aggregated per-trap_kind convergence stats. Aggregation is
 *            deduped on (trap, match) — see comment in burn-in cron for
 *            why this matters under page-reload re-emissions.
 */
export function aggregateClvDecay(trails, closingByKey, { decayEps, nowMs = Date.now() }) {
  const updates = [];
  const aggSeen = new Set();
  const byTrap = new Map();

  for (const t of trails) {
    const closing = closingByKey.get(t.match_key);
    const closingHWRate = computeClosingHwRate(closing);
    if (closingHWRate === null) continue;

    const distance = Math.abs(closingHWRate - Number(t.predicted_hw_rate));
    const movedAgainstUs = distance < decayEps;

    updates.push({
      id: t.id,
      closing_odds: closing.psch,
      moved_against_us: movedAgainstUs,
      clv_resolved_at: nowMs,
    });

    const aggKey = `${t.trap_kind}:${t.match_key}`;
    if (!aggSeen.has(aggKey)) {
      aggSeen.add(aggKey);
      const bucket = byTrap.get(t.trap_kind) ?? {
        trap_kind: t.trap_kind, n: 0, converged: 0,
      };
      bucket.n += 1;
      if (movedAgainstUs) bucket.converged += 1;
      byTrap.set(t.trap_kind, bucket);
    }
  }

  const report = {};
  for (const b of byTrap.values()) {
    const rate = b.n > 0 ? b.converged / b.n : null;
    report[b.trap_kind] = {
      n: b.n,
      converged: b.converged,
      convergence_rate: rate !== null ? Number(rate.toFixed(3)) : null,
      status: clvDecayStatus(rate, b.n),
    };
  }
  return { updates, byTrap: report };
}
