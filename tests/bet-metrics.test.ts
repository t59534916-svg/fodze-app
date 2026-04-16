import { describe, it, expect } from "vitest";
import {
  betProfit,
  isSettled,
  computeBetStats,
  computeCalibration,
  computeClvStats,
} from "@/lib/bet-metrics";
import type { PlacedBet } from "@/types/match";

// ─── Test fixtures ────────────────────────────────────────────────

const makeBet = (overrides: Partial<PlacedBet> = {}): PlacedBet => ({
  id: "bet-" + Math.random().toString(36).slice(2, 9),
  match_key: "bundesliga:bayern-dortmund",
  home_team: "Bayern",
  away_team: "Dortmund",
  market: "1",
  odds_placed: 2.0,
  stake: 50,
  result: "won",
  created_by: "test-user",
  ...overrides,
});

// ─── betProfit ────────────────────────────────────────────────────

describe("betProfit", () => {
  it("returns (odds-1) * stake for won bets", () => {
    // 1.85 × 50 → net profit (1.85 - 1) × 50 = 42.5
    expect(betProfit(makeBet({ odds_placed: 1.85, stake: 50, result: "won" })))
      .toBeCloseTo(42.5);
    // 3.5 × 10 → 25
    expect(betProfit(makeBet({ odds_placed: 3.5, stake: 10, result: "won" })))
      .toBeCloseTo(25);
  });

  it("returns -stake for lost bets", () => {
    expect(betProfit(makeBet({ stake: 30, result: "lost" }))).toBe(-30);
    expect(betProfit(makeBet({ stake: 100, result: "lost" }))).toBe(-100);
  });

  it("returns 0 for pending bets (regardless of odds)", () => {
    expect(betProfit(makeBet({ odds_placed: 10, stake: 50, result: "pending" })))
      .toBe(0);
  });

  it("handles string-typed odds/stake (DB returns strings sometimes)", () => {
    const b = makeBet({
      odds_placed: "2.5" as unknown as number,
      stake: "40" as unknown as number,
      result: "won",
    });
    expect(betProfit(b)).toBeCloseTo(60);
  });

  it("returns 0 when stake or odds are NaN", () => {
    const b = makeBet({
      odds_placed: NaN as unknown as number,
      stake: 50,
      result: "won",
    });
    // (NaN - 1) * 50 = NaN. But Number(NaN) || 0 makes it safe.
    // Actual: Number(NaN) is NaN, || 0 = 0, so (0 - 1) * 0 = 0
    expect(betProfit(b)).toBe(0);
  });
});

// ─── isSettled ───────────────────────────────────────────────────

describe("isSettled", () => {
  it("is true for won and lost", () => {
    expect(isSettled(makeBet({ result: "won" }))).toBe(true);
    expect(isSettled(makeBet({ result: "lost" }))).toBe(true);
  });
  it("is false for pending", () => {
    expect(isSettled(makeBet({ result: "pending" }))).toBe(false);
  });
});

// ─── computeBetStats ─────────────────────────────────────────────

describe("computeBetStats", () => {
  it("returns zeroed stats for empty input", () => {
    const s = computeBetStats([]);
    expect(s.settled).toEqual([]);
    expect(s.pnl).toBe(0);
    expect(s.roi).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.totalStake).toBe(0);
    expect(s.wonCount).toBe(0);
    expect(s.lostCount).toBe(0);
    expect(s.avgEdge).toBe(0);
  });

  it("ignores pending bets in all aggregates", () => {
    const bets = [
      makeBet({ result: "won", odds_placed: 2.0, stake: 50 }),
      makeBet({ result: "pending", odds_placed: 10, stake: 1000 }), // big number, should be ignored
    ];
    const s = computeBetStats(bets);
    expect(s.settled).toHaveLength(1);
    expect(s.pnl).toBe(50);
    expect(s.totalStake).toBe(50);
  });

  it("computes correct P&L for a mix", () => {
    // W @ 1.85 × 50 = +42.5
    // L @ 2.10 × 30 = -30
    // W @ 3.40 × 20 = +48 ((3.40-1) × 20)
    // L @ 1.95 × 25 = -25
    const bets = [
      makeBet({ result: "won",  odds_placed: 1.85, stake: 50, edge: 0.08 }),
      makeBet({ result: "lost", odds_placed: 2.10, stake: 30, edge: 0.07 }),
      makeBet({ result: "won",  odds_placed: 3.40, stake: 20, edge: 0.02 }),
      makeBet({ result: "lost", odds_placed: 1.95, stake: 25, edge: 0.01 }),
    ];
    const s = computeBetStats(bets);
    expect(s.wonCount).toBe(2);
    expect(s.lostCount).toBe(2);
    expect(s.pnl).toBeCloseTo(42.5 - 30 + 48 - 25, 5); // = 35.5
    expect(s.totalStake).toBe(125);
    expect(s.roi).toBeCloseTo((35.5 / 125) * 100, 3); // = 28.4%
    expect(s.winRate).toBe(50);
    // Avg edge = (0.08 + 0.07 + 0.02 + 0.01) / 4 = 0.045
    expect(s.avgEdge).toBeCloseTo(0.045, 5);
  });

  it("handles missing edge gracefully (treats as 0)", () => {
    const bets = [makeBet({ result: "won", edge: undefined })];
    const s = computeBetStats(bets);
    expect(s.avgEdge).toBe(0);
  });

  it("roi is 0 when totalStake is 0 (no division by zero)", () => {
    // All bets pending → totalStake=0
    const bets = [makeBet({ result: "pending" })];
    const s = computeBetStats(bets);
    expect(s.roi).toBe(0);
  });
});

// ─── computeCalibration ──────────────────────────────────────────

describe("computeCalibration", () => {
  it("returns null for empty input", () => {
    expect(computeCalibration([])).toBeNull();
  });

  it("returns null when no bets have model_prob", () => {
    const bets = [makeBet({ result: "won", model_prob: undefined })];
    expect(computeCalibration(bets)).toBeNull();
  });

  it("skips model_prob values at 0 or 1 (log would blow up)", () => {
    const bets = [
      makeBet({ result: "won", model_prob: 0 }),       // excluded
      makeBet({ result: "won", model_prob: 1 }),       // excluded
      makeBet({ result: "won", model_prob: 0.5 }),     // included
    ];
    const r = computeCalibration(bets);
    expect(r?.n).toBe(1);
  });

  it("Brier for perfect prediction = 0", () => {
    // Won bet, model said 99.9% → almost 0 error
    const bets = [makeBet({ result: "won", model_prob: 0.999 })];
    const r = computeCalibration(bets);
    expect(r?.brier).toBeCloseTo((0.999 - 1) ** 2, 5);
    expect(r?.brier).toBeLessThan(0.001);
  });

  it("Brier for worst prediction ≈ 1", () => {
    // Lost bet, model said 99.9% → big error
    const bets = [makeBet({ result: "lost", model_prob: 0.999 })];
    const r = computeCalibration(bets);
    expect(r?.brier).toBeCloseTo(0.999 ** 2, 5);
  });

  it("10-bucket binning maps 0.05 → bin 0, 0.95 → bin 9", () => {
    const bets = [
      makeBet({ result: "won", model_prob: 0.05 }), // bin 0
      makeBet({ result: "won", model_prob: 0.95 }), // bin 9
      makeBet({ result: "won", model_prob: 0.5 }),  // bin 5
    ];
    const r = computeCalibration(bets);
    expect(r?.buckets[0].count).toBe(1);
    expect(r?.buckets[9].count).toBe(1);
    expect(r?.buckets[5].count).toBe(1);
    // Empty bins stay empty
    expect(r?.buckets[2].count).toBe(0);
  });

  it("calibration error is low when predictions match reality", () => {
    // 10 bets at 50% model prob, 5 won (50% actual rate) → perfectly calibrated
    const bets: PlacedBet[] = [];
    for (let i = 0; i < 10; i++) {
      bets.push(makeBet({
        result: i < 5 ? "won" : "lost",
        model_prob: 0.5,
      }));
    }
    const r = computeCalibration(bets);
    expect(r?.calError).toBeLessThan(0.01); // near-zero drift
  });

  it("calibration error high when predictions are biased", () => {
    // Model says 80% for all, but only 40% actually win
    const bets: PlacedBet[] = [];
    for (let i = 0; i < 10; i++) {
      bets.push(makeBet({
        result: i < 4 ? "won" : "lost",
        model_prob: 0.8,
      }));
    }
    const r = computeCalibration(bets);
    // bucket 8 has 10 rows, avg pred 0.8, actual 0.4 → diff 0.4
    // calError = (10 × 0.4) / 10 = 0.4
    expect(r?.calError).toBeCloseTo(0.4, 2);
  });

  it("filters out pending bets", () => {
    const bets = [
      makeBet({ result: "won", model_prob: 0.6 }),
      makeBet({ result: "pending", model_prob: 0.7 }), // ignored
    ];
    const r = computeCalibration(bets);
    expect(r?.n).toBe(1);
  });
});

// ─── computeClvStats ─────────────────────────────────────────────

describe("computeClvStats", () => {
  it("returns null for empty input", () => {
    expect(computeClvStats([])).toBeNull();
  });

  it("returns null when no bets have clv", () => {
    const bets = [
      makeBet({ result: "won", clv: undefined }),
      makeBet({ result: "lost", clv: undefined }),
    ];
    expect(computeClvStats(bets)).toBeNull();
  });

  it("ignores pending bets even if they have clv set", () => {
    // Pending bet with clv shouldn't happen in practice (clv is computed at
    // settlement), but if a row is in that state, we refuse to count it.
    const bets = [
      makeBet({ result: "won", clv: 2.0 }),
      makeBet({ result: "pending", clv: 999 }), // excluded
    ];
    const r = computeClvStats(bets);
    expect(r?.count).toBe(1);
    expect(r?.avgClv).toBeCloseTo(2.0);
  });

  it("all-positive sample: avgClv > 0, positiveRate = 1", () => {
    const bets = [
      makeBet({ result: "won", clv: 1.5 }),
      makeBet({ result: "lost", clv: 2.5 }),
      makeBet({ result: "won", clv: 3.0 }),
    ];
    const r = computeClvStats(bets);
    expect(r?.count).toBe(3);
    expect(r?.avgClv).toBeCloseTo((1.5 + 2.5 + 3.0) / 3, 5);
    expect(r?.positiveRate).toBe(1);
    expect(r?.totalClv).toBeCloseTo(7.0, 5);
  });

  it("all-negative sample: avgClv < 0, positiveRate = 0", () => {
    const bets = [
      makeBet({ result: "won", clv: -1.0 }),
      makeBet({ result: "lost", clv: -2.0 }),
    ];
    const r = computeClvStats(bets);
    expect(r?.avgClv).toBeCloseTo(-1.5);
    expect(r?.positiveRate).toBe(0);
  });

  it("mixed sample: zero CLV is NOT counted as positive", () => {
    const bets = [
      makeBet({ result: "won", clv: 0 }),   // not positive
      makeBet({ result: "won", clv: 1.0 }), // positive
      makeBet({ result: "lost", clv: -1.0 }), // negative
    ];
    const r = computeClvStats(bets);
    expect(r?.count).toBe(3);
    expect(r?.avgClv).toBeCloseTo(0, 5); // 0 + 1 - 1 = 0
    expect(r?.positiveRate).toBeCloseTo(1 / 3, 5); // only the 1.0
  });

  it("treats missing clv as 'no data', NOT as 0 (preserves signal honesty)", () => {
    const bets = [
      makeBet({ result: "won", clv: 3.0 }),
      makeBet({ result: "lost", clv: undefined }), // excluded, not averaged as 0
      makeBet({ result: "won", clv: 5.0 }),
    ];
    const r = computeClvStats(bets);
    expect(r?.count).toBe(2); // only the two with real CLV
    expect(r?.avgClv).toBeCloseTo(4.0, 5);
  });

  it("skips NaN clv without crashing", () => {
    const bets = [
      makeBet({ result: "won", clv: NaN as unknown as number }), // excluded
      makeBet({ result: "won", clv: 2.0 }),
    ];
    const r = computeClvStats(bets);
    expect(r?.count).toBe(1);
    expect(r?.avgClv).toBeCloseTo(2.0);
  });
});
