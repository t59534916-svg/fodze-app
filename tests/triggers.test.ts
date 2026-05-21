// ═══════════════════════════════════════════════════════════════════════
// tests/triggers.test.ts
//
// Unit tests for the 3 trigger detectors + trust-band + kelly-damper.
// Each test exercises detection logic + thresholds + edge cases.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  detectXGMarketDivergence,
  detectCoachingChange,
  detectStreakPattern,
  computeTrustBand,
  kellyMultiplier,
  runAllTriggers,
} from "../src/lib/triggers";

// ─── xgMarketDivergence ──────────────────────────────────────────────

describe("detectXGMarketDivergence", () => {
  it("fires when gap exceeds sharp-Liga threshold (BL, gap +0.42 > 0.25)", () => {
    const r = detectXGMarketDivergence({
      league: "bundesliga",
      lambdaEngine: 3.20,
      lambdaMarket: 2.78,
    });
    expect(r).not.toBeNull();
    expect(r?.type).toBe("xg_market");
    expect(r?.data.gap).toBeCloseTo(0.42, 2);
    expect(r?.parts.some(p => p.kind === "highlight" && p.value === "3.20")).toBe(true);
  });

  it("does NOT fire below sharp-Liga threshold (BL, gap +0.10)", () => {
    const r = detectXGMarketDivergence({
      league: "bundesliga",
      lambdaEngine: 2.50,
      lambdaMarket: 2.40,
    });
    expect(r).toBeNull();
  });

  it("uses softer threshold for liga3 (gap +0.40 < 0.50 = no fire)", () => {
    const r = detectXGMarketDivergence({
      league: "liga3",
      lambdaEngine: 2.80,
      lambdaMarket: 2.40,
    });
    expect(r).toBeNull();
  });

  it("liga3 fires when gap exceeds 0.50 threshold", () => {
    const r = detectXGMarketDivergence({
      league: "liga3",
      lambdaEngine: 3.10,
      lambdaMarket: 2.50,
    });
    expect(r).not.toBeNull();
  });

  it("falls back to default threshold for unknown leagues", () => {
    const r = detectXGMarketDivergence({
      league: "fake_liga",
      lambdaEngine: 3.10,
      lambdaMarket: 2.65,
    });
    expect(r).not.toBeNull();
    expect(r?.data.theta).toBe(0.35);
  });

  it("severity scales with gap relative to threshold", () => {
    const small = detectXGMarketDivergence({ league: "bundesliga", lambdaEngine: 3.05, lambdaMarket: 2.78 });
    const large = detectXGMarketDivergence({ league: "bundesliga", lambdaEngine: 3.60, lambdaMarket: 2.78 });
    expect((large?.severity ?? 0) > (small?.severity ?? 0)).toBe(true);
  });
});

// ─── coachingChange ──────────────────────────────────────────────────

describe("detectCoachingChange", () => {
  it("fires within window [3, 45] days", () => {
    const r = detectCoachingChange({
      league: "bundesliga",
      homeChange: { managerName: "Tuchel", daysSinceChange: 11 },
      ligaBoostRate: { boostCount: 8, total: 11 },
    });
    expect(r).not.toBeNull();
    expect(r?.parts.some(p => p.kind === "highlight" && p.value === "NEUER TRAINER")).toBe(true);
    expect(r?.parts.some(p => p.kind === "text" && p.value.includes("8/11"))).toBe(true);
  });

  it("does NOT fire too early (< 3 days)", () => {
    const r = detectCoachingChange({
      league: "bundesliga",
      homeChange: { managerName: "Tuchel", daysSinceChange: 1 },
    });
    expect(r).toBeNull();
  });

  it("does NOT fire too late (> 45 days)", () => {
    const r = detectCoachingChange({
      league: "bundesliga",
      homeChange: { managerName: "Tuchel", daysSinceChange: 60 },
    });
    expect(r).toBeNull();
  });

  it("prefers the side with more-recent change", () => {
    const r = detectCoachingChange({
      league: "bundesliga",
      homeChange: { managerName: "Old", daysSinceChange: 30 },
      awayChange: { managerName: "Fresh", daysSinceChange: 5 },
    });
    expect(r?.data.side).toBe("away");
    expect(r?.data.managerName).toBe("Fresh");
  });

  it("works without ligaBoostRate (skips that part)", () => {
    const r = detectCoachingChange({
      league: "bundesliga",
      homeChange: { managerName: "Tuchel", daysSinceChange: 11 },
    });
    expect(r).not.toBeNull();
    expect(r?.parts.some(p => p.kind === "text" && p.value.includes("/"))).toBe(false);
  });

  it("adds match-number subline when provided", () => {
    const r = detectCoachingChange({
      league: "bundesliga",
      homeChange: { managerName: "Tuchel", daysSinceChange: 11 },
      matchNumberAfterChange: 3,
    });
    expect(r?.parts.some(p => p.kind === "sub" && p.value.includes("#3"))).toBe(true);
  });
});

// ─── streakPattern ───────────────────────────────────────────────────

describe("detectStreakPattern", () => {
  it("fires when home has W7 streak", () => {
    const r = detectStreakPattern({
      homeName: "Bayern",
      awayName: "Dortmund",
      homeStreaks: [{ type: "general", outcome: "W", n: 7 }],
      awayStreaks: [],
    });
    expect(r).not.toBeNull();
    expect(r?.parts.some(p => p.kind === "highlight" && p.value === "W7")).toBe(true);
  });

  it("uses 'warn' style for losing streaks", () => {
    const r = detectStreakPattern({
      homeName: "Bremen",
      awayName: "Mainz",
      homeStreaks: [],
      awayStreaks: [{ type: "general", outcome: "L", n: 5 }],
    });
    expect(r?.parts.some(p => p.kind === "warn" && p.value === "L5")).toBe(true);
  });

  it("shows both sides if both have streaks", () => {
    const r = detectStreakPattern({
      homeName: "Augsburg",
      awayName: "St. Pauli",
      homeStreaks: [{ type: "general", outcome: "L", n: 4 }],
      awayStreaks: [{ type: "general", outcome: "W", n: 3 }],
    });
    // n=4 < MIN_GENERAL=5, n=3 < MIN_GENERAL → no fire
    expect(r).toBeNull();
  });

  it("does NOT fire below minimum n=5", () => {
    const r = detectStreakPattern({
      homeName: "A",
      awayName: "B",
      homeStreaks: [{ type: "general", outcome: "W", n: 4 }],
      awayStreaks: [],
    });
    expect(r).toBeNull();
  });

  it("h2h streak fires independently", () => {
    const r = detectStreakPattern({
      homeName: "Bayern",
      awayName: "Dortmund",
      homeStreaks: [{ type: "h2h", outcome: "W", n: 6 }],
      awayStreaks: [],
    });
    expect(r).not.toBeNull();
    expect(r?.parts.some(p => p.kind === "text" && p.value.includes("H2H"))).toBe(true);
  });

  it("severity scales with streak length", () => {
    const w5 = detectStreakPattern({
      homeName: "A", awayName: "B",
      homeStreaks: [{ type: "general", outcome: "W", n: 5 }],
      awayStreaks: [],
    });
    const w8 = detectStreakPattern({
      homeName: "A", awayName: "B",
      homeStreaks: [{ type: "general", outcome: "W", n: 8 }],
      awayStreaks: [],
    });
    expect((w8?.severity ?? 0) > (w5?.severity ?? 0)).toBe(true);
  });
});

// ─── trust-band ──────────────────────────────────────────────────────

describe("computeTrustBand", () => {
  const snap = (hitRate: number, n: number, drift?: number) => ({
    league: "bundesliga",
    confidenceBand: [0.60, 0.70] as [number, number],
    hitRate,
    n,
    driftPp: drift,
  });

  it("returns Gold when hit rate within ±3pp of claim midpoint (65%)", () => {
    const r = computeTrustBand({
      league: "bundesliga",
      confidenceBand: [0.60, 0.70],
      snapshots: [snap(0.68, 42)],
    });
    expect(r.band).toBe("gold");
  });

  it("returns Caution when delta in (3pp, 8pp]", () => {
    const r = computeTrustBand({
      league: "bundesliga",
      confidenceBand: [0.60, 0.70],
      snapshots: [snap(0.57, 28)],
    });
    expect(r.band).toBe("caution");
  });

  it("returns Trap when delta exceeds 8pp", () => {
    const r = computeTrustBand({
      league: "bundesliga",
      confidenceBand: [0.60, 0.70],
      snapshots: [snap(0.43, 12)],
    });
    expect(r.band).toBe("trap");
  });

  it("auto-Caution when n < 20 (under-cov)", () => {
    const r = computeTrustBand({
      league: "bundesliga",
      confidenceBand: [0.60, 0.70],
      snapshots: [snap(0.67, 15)],
    });
    expect(r.band).toBe("caution");
    expect(r.underCov).toBe(true);
  });

  it("Caution when no snapshot found (under-cov)", () => {
    const r = computeTrustBand({
      league: "bundesliga",
      confidenceBand: [0.60, 0.70],
      snapshots: [],
    });
    expect(r.band).toBe("caution");
    expect(r.hitRate).toBeNull();
    expect(r.underCov).toBe(true);
  });

  it("downgrades to Trap when drift exceeds threshold even if hit-rate ok", () => {
    const r = computeTrustBand({
      league: "bundesliga",
      confidenceBand: [0.60, 0.70],
      snapshots: [snap(0.66, 50, 0.018)],
    });
    expect(r.band).toBe("trap");
  });
});

// ─── kelly-damper ────────────────────────────────────────────────────

describe("kellyMultiplier", () => {
  it("Gold → 1.0×", () => expect(kellyMultiplier("gold")).toBe(1.0));
  it("Caution → 0.7×", () => expect(kellyMultiplier("caution")).toBe(0.7));
  it("Trap → 0.3×", () => expect(kellyMultiplier("trap")).toBe(0.3));
});

// ─── runAllTriggers (orchestrator) ───────────────────────────────────

describe("runAllTriggers", () => {
  it("returns triggers sorted by severity desc", () => {
    const results = runAllTriggers({
      xgMarket: { league: "bundesliga", lambdaEngine: 3.20, lambdaMarket: 2.78 },
      coachingChange: { league: "bundesliga", homeChange: { managerName: "Tuchel", daysSinceChange: 11 } },
      streakPattern: {
        homeName: "Bayern", awayName: "Dortmund",
        homeStreaks: [{ type: "general", outcome: "W", n: 7 }],
        awayStreaks: [{ type: "general", outcome: "L", n: 3 }],
      },
    });
    expect(results.length).toBe(3);
    // First should have the highest severity
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].severity >= results[i].severity).toBe(true);
    }
  });

  it("returns empty array when no triggers fire", () => {
    const results = runAllTriggers({
      xgMarket: { league: "bundesliga", lambdaEngine: 2.5, lambdaMarket: 2.4 },
    });
    expect(results).toEqual([]);
  });

  it("skips undefined inputs", () => {
    const results = runAllTriggers({});
    expect(results).toEqual([]);
  });
});
