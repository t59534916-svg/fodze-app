import { describe, it, expect } from "vitest";
import {
  convictionForPick,
  selectHighConviction,
  aggregateExpectedHitFloor,
  type SelectablePick,
} from "@/lib/selective-prediction";

describe("convictionForPick — tier → conviction (validated axis only)", () => {
  it("maps each confidence tier to its conviction level + hit-floor", () => {
    expect(convictionForPick({ topProb: 0.80 })).toMatchObject({ level: "TOP", tierKey: "HOCH", expectedHitFloor: 0.73 });
    expect(convictionForPick({ topProb: 0.65 })).toMatchObject({ level: "TOP", tierKey: "HOCH" });
    expect(convictionForPick({ topProb: 0.60 })).toMatchObject({ level: "SOLIDE", tierKey: "MITTEL", expectedHitFloor: 0.53 });
    expect(convictionForPick({ topProb: 0.50 })).toMatchObject({ level: "SPEKULATIV", tierKey: "NIEDRIG", expectedHitFloor: 0.48 });
    expect(convictionForPick({ topProb: 0.40 })).toMatchObject({ level: "SKIP", tierKey: "TOSS_UP" });
  });

  it("boundary values land in the right tier (>= semantics)", () => {
    expect(convictionForPick({ topProb: 0.6499 }).level).toBe("SOLIDE");
    expect(convictionForPick({ topProb: 0.65 }).level).toBe("TOP");
    expect(convictionForPick({ topProb: 0.4499 }).level).toBe("SKIP");
    expect(convictionForPick({ topProb: 0.45 }).level).toBe("SPEKULATIV");
  });

  it("null / NaN / no-odds picks are SKIP with zero floor", () => {
    expect(convictionForPick({ topProb: null })).toMatchObject({ level: "SKIP", expectedHitFloor: 0 });
    expect(convictionForPick({ topProb: NaN })).toMatchObject({ level: "SKIP", expectedHitFloor: 0 });
  });

  it("marketConfirmed mirrors the input but NEVER changes level or floor", () => {
    const withMarket = convictionForPick({ topProb: 0.70, marketAgrees: true });
    const without = convictionForPick({ topProb: 0.70, marketAgrees: false });
    const unknown = convictionForPick({ topProb: 0.70, marketAgrees: null });
    expect(withMarket.marketConfirmed).toBe(true);
    expect(without.marketConfirmed).toBe(false);
    expect(unknown.marketConfirmed).toBe(false);
    // Same tier, same floor regardless of market — honesty invariant.
    expect(withMarket.expectedHitFloor).toBe(without.expectedHitFloor);
    expect(withMarket.level).toBe(without.level);
  });
});

describe("selectHighConviction — the selective filter", () => {
  const picks: SelectablePick[] = [
    { topProb: 0.80, marketAgrees: true },   // 0 TOP, market-confirmed
    { topProb: 0.42 },                        // 1 SKIP
    { topProb: 0.58, marketAgrees: false },   // 2 SOLIDE
    { topProb: 0.68, marketAgrees: null },    // 3 TOP, market unknown
    { topProb: null },                        // 4 SKIP (no odds)
    { topProb: 0.50, marketAgrees: true },    // 5 SPEKULATIV
  ];

  it("defaults to TOP-only and sorts by topProb desc, preserving original index", () => {
    const sel = selectHighConviction(picks);
    expect(sel.map(s => s.index)).toEqual([0, 3]); // 0.80 then 0.68
    expect(sel.every(s => s.conviction.level === "TOP")).toBe(true);
  });

  it("minLevel widens the net", () => {
    const sel = selectHighConviction(picks, { minLevel: "SOLIDE" });
    expect(sel.map(s => s.index)).toEqual([0, 3, 2]); // 0.80, 0.68, 0.58
  });

  it("minLevel SPEKULATIV includes everything except SKIP / no-odds", () => {
    const sel = selectHighConviction(picks, { minLevel: "SPEKULATIV" });
    expect(sel.map(s => s.index)).toEqual([0, 3, 2, 5]); // 0.80,0.68,0.58,0.50
    expect(sel.map(s => s.index)).not.toContain(1);
    expect(sel.map(s => s.index)).not.toContain(4);
  });

  it("requireMarketConsensus excludes unknown + disagreeing picks", () => {
    const sel = selectHighConviction(picks, { minLevel: "SOLIDE", requireMarketConsensus: true });
    // Of TOP/SOLIDE picks: 0 (true) kept; 3 (null) dropped; 2 (false) dropped.
    expect(sel.map(s => s.index)).toEqual([0]);
  });

  it("empty input → empty selection", () => {
    expect(selectHighConviction([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const snapshot = JSON.stringify(picks);
    selectHighConviction(picks, { minLevel: "SPEKULATIV" });
    expect(JSON.stringify(picks)).toBe(snapshot);
  });
});

describe("aggregateExpectedHitFloor — honest subset hit floor", () => {
  it("averages the validated per-tier floors", () => {
    const sel = selectHighConviction([{ topProb: 0.80 }, { topProb: 0.66 }]); // both HOCH → 0.73
    expect(aggregateExpectedHitFloor(sel)).toBeCloseTo(0.73, 10);
  });

  it("mixed tiers average their floors", () => {
    const sel = selectHighConviction(
      [{ topProb: 0.70 }, { topProb: 0.58 }], // HOCH 0.73 + MITTEL 0.53
      { minLevel: "SOLIDE" },
    );
    expect(aggregateExpectedHitFloor(sel)).toBeCloseTo((0.73 + 0.53) / 2, 10);
  });

  it("empty subset → null (no claim)", () => {
    expect(aggregateExpectedHitFloor([])).toBeNull();
  });

  it("is independent of market confirmation (honesty invariant)", () => {
    const a = selectHighConviction([{ topProb: 0.70, marketAgrees: true }]);
    const b = selectHighConviction([{ topProb: 0.70, marketAgrees: false }]);
    expect(aggregateExpectedHitFloor(a)).toBe(aggregateExpectedHitFloor(b));
  });
});
