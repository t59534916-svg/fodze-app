// ═══════════════════════════════════════════════════════════════════════
// FODZE Bet Metrics — Shared P&L + Brier/LogLoss/Calibration math
//
// Single source of truth for:
//   - betProfit(bet)          per-bet win/loss euros
//   - computeBetStats(bets)   aggregate P&L, ROI, win rate, avg edge
//   - computeCalibration(bets)  Brier, LogLoss, CalError, 10-bucket bins
//
// Callers: performance/page.tsx (LivePerformance), LiveCalibration,
// BetHistoryShare, BetTracker, bet-share-card.
// ═══════════════════════════════════════════════════════════════════════

import type { PlacedBet } from "@/types/match";

// ─── Per-bet helpers ────────────────────────────────────────────────

/**
 * Net P/L on a settled bet in euros.
 * Returns 0 for pending bets (caller should filter first if they only want
 * settled rows).
 */
export function betProfit(bet: PlacedBet): number {
  const stake = Number(bet.stake) || 0;
  const odds = Number(bet.odds_placed) || 0;
  if (bet.result === "won") return (odds - 1) * stake;
  if (bet.result === "lost") return -stake;
  return 0;
}

export function isSettled(bet: PlacedBet): boolean {
  return bet.result === "won" || bet.result === "lost";
}

// ─── Aggregate stats ────────────────────────────────────────────────

export interface BetStats {
  settled: PlacedBet[];
  won: PlacedBet[];
  lost: PlacedBet[];
  wonCount: number;
  lostCount: number;
  pnl: number;
  totalStake: number;
  roi: number; // percent, signed
  winRate: number; // percent [0, 100]
  avgEdge: number; // fraction [0, 1]
}

/**
 * One-pass aggregate over a bet list. Filters to settled bets.
 * Empty-input safe: returns zeroed stats with empty arrays.
 */
export function computeBetStats(bets: PlacedBet[]): BetStats {
  const settled: PlacedBet[] = [];
  const won: PlacedBet[] = [];
  const lost: PlacedBet[] = [];
  let pnl = 0;
  let totalStake = 0;
  let edgeSum = 0;

  for (const b of bets) {
    if (!isSettled(b)) continue;
    settled.push(b);
    const stake = Number(b.stake) || 0;
    totalStake += stake;
    edgeSum += b.edge || 0;
    if (b.result === "won") {
      won.push(b);
      pnl += (Number(b.odds_placed) - 1) * stake;
    } else {
      lost.push(b);
      pnl -= stake;
    }
  }

  const n = settled.length;
  return {
    settled,
    won,
    lost,
    wonCount: won.length,
    lostCount: lost.length,
    pnl,
    totalStake,
    roi: totalStake > 0 ? (pnl / totalStake) * 100 : 0,
    winRate: n > 0 ? (won.length / n) * 100 : 0,
    avgEdge: n > 0 ? edgeSum / n : 0,
  };
}

// ─── Calibration (Brier / LogLoss / per-bucket) ─────────────────────

export interface CalibrationBucket {
  count: number;
  won: number;
  predSum: number;
}

export interface CalibrationResult {
  n: number;
  brier: number;
  logLoss: number;
  /** Bucket-weighted mean |predicted − actual|, in [0, 1]. */
  calError: number;
  /** 10 fixed bins: [0-10%, 10-20%, …, 90-100%]. */
  buckets: CalibrationBucket[];
}

/**
 * Live calibration metrics from settled bets with `model_prob` populated.
 * Returns `null` if no usable rows (caller can render an empty state).
 */
export function computeCalibration(bets: PlacedBet[]): CalibrationResult | null {
  const rows = bets.filter(
    (b) =>
      isSettled(b) &&
      b.model_prob != null &&
      b.model_prob > 0 &&
      b.model_prob < 1,
  );
  if (rows.length === 0) return null;

  const buckets: CalibrationBucket[] = Array.from({ length: 10 }, () => ({
    count: 0,
    won: 0,
    predSum: 0,
  }));

  let brierSum = 0;
  let logLossSum = 0;

  for (const b of rows) {
    const p = b.model_prob!;
    const y = b.result === "won" ? 1 : 0;
    // Clamp for log to avoid log(0)
    const pc = Math.max(0.001, Math.min(0.999, p));
    brierSum += (p - y) ** 2;
    logLossSum += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
    const binIdx = Math.min(9, Math.floor(p * 10));
    const bucket = buckets[binIdx];
    bucket.count++;
    bucket.won += y;
    bucket.predSum += p;
  }

  const n = rows.length;
  let calErrorWeighted = 0;
  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const predAvg = bucket.predSum / bucket.count;
    const actAvg = bucket.won / bucket.count;
    calErrorWeighted += bucket.count * Math.abs(predAvg - actAvg);
  }

  return {
    n,
    brier: brierSum / n,
    logLoss: logLossSum / n,
    calError: calErrorWeighted / n,
    buckets,
  };
}
