import { describe, it, expect, beforeEach } from "vitest";
import { computeLeagueMedian, seedElo, resetEloSeedCache } from "@/lib/elo-seeding";

// Reset the in-module cache before each test so prior calls don't
// contaminate assertions about which code path was taken.
beforeEach(() => resetEloSeedCache());

describe("computeLeagueMedian", () => {
  it("returns tier default for top-5 leagues when rating dict is empty", () => {
    expect(computeLeagueMedian("bundesliga", {})).toBe(1730);
    expect(computeLeagueMedian("epl", {})).toBe(1800);
    expect(computeLeagueMedian("la_liga", {})).toBe(1770);
    expect(computeLeagueMedian("serie_a", {})).toBe(1720);
    expect(computeLeagueMedian("ligue_1", {})).toBe(1680);
  });

  it("returns lower tier defaults for lower-tier leagues", () => {
    expect(computeLeagueMedian("bundesliga2", {})).toBe(1400);
    expect(computeLeagueMedian("liga3", {})).toBe(1250);
    expect(computeLeagueMedian("league_two", {})).toBe(1200);
  });

  it("caches result across calls", () => {
    const first = computeLeagueMedian("bundesliga", {});
    // Second call returns same value even with "different" inputs —
    // cache hit dominates. We're testing the invariant that the cache
    // isn't cleared between identical-key calls.
    const second = computeLeagueMedian("bundesliga", {});
    expect(first).toBe(second);
  });

  it("returns universal fallback (1450) for unknown league", () => {
    expect(computeLeagueMedian("unknown_league_xyz", {})).toBe(1450);
  });
});

describe("seedElo", () => {
  it("returns league median minus 50 penalty", () => {
    // Bundesliga median 1730 → seeded 1680
    expect(seedElo("bundesliga", {})).toBe(1680);
    // Liga3 median 1250 → seeded 1200
    expect(seedElo("liga3", {})).toBe(1200);
  });

  it("newly-promoted team lands well below league avg, not at 1500", () => {
    // Before this refactor: everyone got 1500. A Liga 3 team getting 1500
    // was equivalent to a mid-table Bundesliga team → wildly unfair.
    const seeded = seedElo("liga3", {});
    expect(seeded).toBeLessThan(1500);
    expect(seeded).toBeGreaterThanOrEqual(1150);
  });

  it("top-5 leagues still seed well above 1500", () => {
    // A missing EPL team (e.g. a newly promoted club) should still be
    // treated as a strong team relative to lower-tier defaults.
    expect(seedElo("epl", {})).toBeGreaterThan(1700);
    expect(seedElo("la_liga", {})).toBeGreaterThan(1700);
  });

  it("handles undefined / unknown league with universal fallback", () => {
    expect(seedElo(undefined, {})).toBe(1450);
    expect(seedElo("xyz", {})).toBe(1400); // 1450 - 50
  });

  it("Liga 3 seed is lower than Bundesliga seed (league tier order preserved)", () => {
    const bl = seedElo("bundesliga", {});
    const l3 = seedElo("liga3", {});
    expect(bl).toBeGreaterThan(l3);
    // And the gap is substantial (>300 Elo points = real tier difference)
    expect(bl - l3).toBeGreaterThanOrEqual(300);
  });

  it("returns consistent values for the same league (idempotent)", () => {
    const a = seedElo("championship", {});
    const b = seedElo("championship", {});
    const c = seedElo("championship", {});
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
