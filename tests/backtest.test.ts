import { describe, it, expect } from "vitest";
import {
  scoreMatch,
  aggregate,
  aggregateWithCI,
  calibration,
  type MatchScore,
} from "@/lib/backtest";

// ─── scoreMatch — per-match brier + log-loss ──────────────────────

describe("scoreMatch", () => {
  const perfectH = { prob_h: 1, prob_d: 0, prob_a: 0, prob_o25: 1, prob_btts: 1 };
  const uniform  = { prob_h: 1 / 3, prob_d: 1 / 3, prob_a: 1 / 3, prob_o25: 0.5, prob_btts: 0.5 };

  it("perfect H prediction → brier 0, log-loss ~0", () => {
    const s = scoreMatch(perfectH, { outcome_1x2: "H", over25: true, btts: true });
    // 3-class rank-brier: H=(1-1)^2 + D=(0-0)^2 + A=(0-0)^2 divided by 3
    expect(s.brier_1x2).toBeCloseTo(0, 10);
    // log-loss clips at 1-1e-6 — so -log(1-1e-6) is tiny but non-zero
    expect(s.logloss_1x2).toBeLessThan(1e-5);
    expect(s.correct_favorite).toBe(true);
  });

  it("uniform prediction brier = 2/9 across 1X2", () => {
    // For outcome H: (1/3-1)^2 + (1/3-0)^2 + (1/3-0)^2 = 4/9 + 1/9 + 1/9 = 6/9
    // divided by 3 → 2/9
    const s = scoreMatch(uniform, { outcome_1x2: "H", over25: true, btts: true });
    expect(s.brier_1x2).toBeCloseTo(2 / 9, 10);
    expect(s.logloss_1x2).toBeCloseTo(Math.log(3), 10);
  });

  it("clips log-loss at p=0 (would otherwise be +Infinity)", () => {
    const degenerate = { prob_h: 0, prob_d: 0.5, prob_a: 0.5, prob_o25: 0, prob_btts: 0 };
    const s = scoreMatch(degenerate, { outcome_1x2: "H", over25: true, btts: true });
    // -log(1e-6) ≈ 13.82 — finite, not +Infinity
    expect(Number.isFinite(s.logloss_1x2)).toBe(true);
    expect(s.logloss_1x2).toBeLessThan(14);
    expect(s.logloss_1x2).toBeGreaterThan(13);
  });

  it("correct_favorite picks the max-prob class", () => {
    const favH = { prob_h: 0.5, prob_d: 0.3, prob_a: 0.2, prob_o25: null, prob_btts: null };
    expect(scoreMatch(favH, { outcome_1x2: "H", over25: false, btts: false }).correct_favorite).toBe(true);
    expect(scoreMatch(favH, { outcome_1x2: "A", over25: false, btts: false }).correct_favorite).toBe(false);
  });

  it("handles null O25 / BTTS predictions gracefully", () => {
    const partial = { prob_h: 0.5, prob_d: 0.3, prob_a: 0.2, prob_o25: null, prob_btts: null };
    const s = scoreMatch(partial, { outcome_1x2: "H", over25: true, btts: true });
    expect(s.brier_o25).toBeNull();
    expect(s.brier_btts).toBeNull();
    expect(s.logloss_o25).toBeNull();
    expect(s.logloss_btts).toBeNull();
  });
});

// ─── aggregate — mean across matches ─────────────────────────────

describe("aggregate", () => {
  it("returns null on empty input", () => {
    expect(aggregate([])).toBeNull();
  });

  it("averages per-match scores; skips null markets", () => {
    const scores: MatchScore[] = [
      {
        brier_1x2: 0.1, brier_o25: 0.2, brier_btts: null,
        logloss_1x2: 0.5, logloss_o25: 0.6, logloss_btts: null,
        correct_favorite: true,
      },
      {
        brier_1x2: 0.3, brier_o25: null, brier_btts: 0.4,
        logloss_1x2: 0.7, logloss_o25: null, logloss_btts: 0.8,
        correct_favorite: false,
      },
    ];
    const agg = aggregate(scores)!;
    expect(agg.n).toBe(2);
    expect(agg.brier_1x2).toBeCloseTo(0.2, 10);
    expect(agg.brier_o25).toBeCloseTo(0.2, 10);   // single value
    expect(agg.brier_btts).toBeCloseTo(0.4, 10);  // single value
    expect(agg.favorite_accuracy).toBe(0.5);
  });
});

// ─── aggregateWithCI — bootstrap 95% intervals ───────────────────

describe("aggregateWithCI", () => {
  const mkScore = (brier: number, logloss: number, correct = true): MatchScore => ({
    brier_1x2: brier, brier_o25: null, brier_btts: null,
    logloss_1x2: logloss, logloss_o25: null, logloss_btts: null,
    correct_favorite: correct,
  });

  it("returns null on empty input", () => {
    expect(aggregateWithCI([])).toBeNull();
  });

  it("point estimate equals aggregate()", () => {
    const scores: MatchScore[] = [mkScore(0.1, 0.5), mkScore(0.3, 0.7), mkScore(0.2, 0.6, false)];
    const point = aggregate(scores)!;
    const ci = aggregateWithCI(scores, { iterations: 500, seed: 42 })!;
    expect(ci.brier_1x2.mean).toBeCloseTo(point.brier_1x2, 10);
    expect(ci.logloss_1x2.mean).toBeCloseTo(point.logloss_1x2, 10);
    expect(ci.favorite_accuracy.mean).toBeCloseTo(point.favorite_accuracy, 10);
  });

  it("CI brackets the mean (lo95 ≤ mean ≤ hi95)", () => {
    const scores: MatchScore[] = Array.from({ length: 30 }, (_, i) =>
      mkScore(0.1 + (i % 5) * 0.02, 0.5 + (i % 7) * 0.03, i % 2 === 0),
    );
    const ci = aggregateWithCI(scores, { iterations: 1000, seed: 1 })!;
    expect(ci.brier_1x2.lo95).toBeLessThanOrEqual(ci.brier_1x2.mean);
    expect(ci.brier_1x2.hi95).toBeGreaterThanOrEqual(ci.brier_1x2.mean);
    expect(ci.logloss_1x2.lo95).toBeLessThanOrEqual(ci.logloss_1x2.mean);
    expect(ci.logloss_1x2.hi95).toBeGreaterThanOrEqual(ci.logloss_1x2.mean);
  });

  it("CI narrows as sample size grows", () => {
    const small: MatchScore[] = Array.from({ length: 15 }, (_, i) => mkScore(0.1 + i * 0.01, 0.5));
    const large: MatchScore[] = Array.from({ length: 300 }, (_, i) => mkScore(0.1 + (i % 15) * 0.01, 0.5));
    const ciSmall = aggregateWithCI(small, { iterations: 1000, seed: 7 })!;
    const ciLarge = aggregateWithCI(large, { iterations: 1000, seed: 7 })!;
    const widthSmall = ciSmall.brier_1x2.hi95 - ciSmall.brier_1x2.lo95;
    const widthLarge = ciLarge.brier_1x2.hi95 - ciLarge.brier_1x2.lo95;
    expect(widthLarge).toBeLessThan(widthSmall);
  });

  it("degenerate case n=1 returns zero-width CI around the point", () => {
    const ci = aggregateWithCI([mkScore(0.25, 0.6)])!;
    expect(ci.brier_1x2.lo95).toBe(ci.brier_1x2.hi95);
    expect(ci.brier_1x2.mean).toBe(ci.brier_1x2.lo95);
  });

  it("is reproducible with same seed", () => {
    const scores: MatchScore[] = Array.from({ length: 50 }, (_, i) => mkScore(0.1 + (i % 10) * 0.01, 0.5));
    const a = aggregateWithCI(scores, { iterations: 500, seed: 123 })!;
    const b = aggregateWithCI(scores, { iterations: 500, seed: 123 })!;
    expect(a.brier_1x2.lo95).toBe(b.brier_1x2.lo95);
    expect(a.brier_1x2.hi95).toBe(b.brier_1x2.hi95);
  });

  it("returns null for a market with no data", () => {
    const scores: MatchScore[] = [mkScore(0.2, 0.5), mkScore(0.3, 0.6)];
    const ci = aggregateWithCI(scores, { iterations: 100, seed: 0 })!;
    expect(ci.brier_o25).toBeNull();
    expect(ci.brier_btts).toBeNull();
  });
});

// ─── calibration bins ──────────────────────────────────────────

describe("calibration", () => {
  it("groups predictions into 10 bins by default", () => {
    const pairs = [
      { prob: 0.05, hit: false },
      { prob: 0.15, hit: false },
      { prob: 0.55, hit: true },
      { prob: 0.95, hit: true },
    ];
    const bins = calibration(pairs);
    expect(bins).toHaveLength(10);
    // Bin [0.5, 0.6): the 0.55 goes here; it hit → realized_freq 1.0
    const mid = bins.find(b => b.bin_lower === 0.5)!;
    expect(mid.count).toBe(1);
    expect(mid.realized_freq).toBe(1);
  });

  it("0.0 goes into bin [0, 0.1) and 1.0 into [0.9, 1.0]", () => {
    const bins = calibration([{ prob: 0.0, hit: false }, { prob: 1.0, hit: true }]);
    expect(bins[0].count).toBe(1);
    expect(bins[9].count).toBe(1);
  });
});
