import { describe, it, expect } from "vitest";
import {
  engineCacheKey,
  engineCacheVersionKey,
  favouredSide,
  parseOddsMap,
  type CacheVersionInputs,
} from "@/lib/matchday-cache";

describe("engineCacheKey — per-match cache identity", () => {
  it("keys on team names + odds, NOT array index (re-sort safety)", () => {
    // Two matches with different teams must never collide even at the same idx.
    const a = engineCacheKey("Bayern", "Dortmund", { h: "1.5" });
    const b = engineCacheKey("Leipzig", "Köln", { h: "1.5" });
    expect(a).not.toBe(b);
  });

  it("same teams + same odds → same key (cache hit)", () => {
    expect(engineCacheKey("Bayern", "Dortmund", { h: "1.5", a: "5.0" }))
      .toBe(engineCacheKey("Bayern", "Dortmund", { h: "1.5", a: "5.0" }));
  });

  it("editing one match's odds changes ONLY that key", () => {
    const before = engineCacheKey("Bayern", "Dortmund", { h: "1.5" });
    const after = engineCacheKey("Bayern", "Dortmund", { h: "1.6" });
    expect(before).not.toBe(after);
  });

  it("missing odds is stable (empty object serialization)", () => {
    expect(engineCacheKey("A", "B", undefined)).toBe(engineCacheKey("A", "B", {}));
  });

  it("undefined team names don't throw", () => {
    expect(() => engineCacheKey(undefined, undefined, {})).not.toThrow();
  });
});

describe("engineCacheVersionKey — global invalidation", () => {
  const base: CacheVersionInputs = {
    league: "bundesliga", leagueAvg: 1.5, homeFactor: 1.1, fraction: 0.33,
    calLoaded: true, filterShieldLoaded: true, sosTeamCount: 18,
    playerXgSize: 100, leagueKellyMultiplier: 1.0, matchIds: ["A:B", "C:D"],
  };

  it("identical inputs → identical key (stable cache)", () => {
    expect(engineCacheVersionKey(base)).toBe(engineCacheVersionKey({ ...base }));
  });

  // Each field MUST invalidate — these are the race-condition guards.
  const mutations: [string, Partial<CacheVersionInputs>][] = [
    ["league", { league: "epl" }],
    ["leagueAvg", { leagueAvg: 1.6 }],
    ["homeFactor", { homeFactor: 1.2 }],
    ["fraction", { fraction: 0.25 }],
    ["calLoaded", { calLoaded: false }],
    ["filterShieldLoaded", { filterShieldLoaded: false }],   // the 2026-05-22 race
    ["sosTeamCount", { sosTeamCount: 20 }],
    ["playerXgSize", { playerXgSize: 101 }],                  // post-hydration re-enrich
    ["leagueKellyMultiplier", { leagueKellyMultiplier: 0.8 }],
    ["matchIds (set)", { matchIds: ["A:B"] }],
    ["matchIds (order)", { matchIds: ["C:D", "A:B"] }],       // re-sort must invalidate
  ];
  for (const [name, patch] of mutations) {
    it(`changing ${name} invalidates the key`, () => {
      expect(engineCacheVersionKey({ ...base, ...patch })).not.toBe(engineCacheVersionKey(base));
    });
  }

  it("sosTeamCount null vs 0 both render as sos0 (presence-flag parity)", () => {
    const a = engineCacheVersionKey({ ...base, sosTeamCount: null });
    const b = engineCacheVersionKey({ ...base, sosTeamCount: 0 });
    expect(a).toBe(b);
  });

  it("sosTeamCount content change (not just presence) invalidates", () => {
    // The bug the comment describes: old code only caught null→present.
    const c18 = engineCacheVersionKey({ ...base, sosTeamCount: 18 });
    const c20 = engineCacheVersionKey({ ...base, sosTeamCount: 20 });
    expect(c18).not.toBe(c20);
  });
});

describe("favouredSide — 1X2 pick from market probs", () => {
  it("picks the max outcome", () => {
    expect(favouredSide({ H: 0.6, D: 0.25, A: 0.15 })).toBe("1");
    expect(favouredSide({ H: 0.2, D: 0.3, A: 0.5 })).toBe("2");
    expect(favouredSide({ H: 0.25, D: 0.5, A: 0.25 })).toBe("X");
  });

  it("ties break H > A > X (home-advantage prior)", () => {
    expect(favouredSide({ H: 0.4, D: 0.4, A: 0.2 })).toBe("1"); // H==D → H
    expect(favouredSide({ H: 0.2, D: 0.4, A: 0.4 })).toBe("2"); // A==D, A>H → 2
    expect(favouredSide({ H: 0.34, D: 0.33, A: 0.33 })).toBe("1");
  });
});

describe("parseOddsMap — raw odds → numeric, positive-only", () => {
  it("keeps positive recognised markets, drops the rest", () => {
    expect(parseOddsMap({ h: "1.5", d: "4.0", a: "6.0", o25: "1.9", u25: "1.9", btts: "1.8" }))
      .toEqual({ h: 1.5, d: 4.0, a: 6.0, o25: 1.9, u25: 1.9, btts: 1.8 });
  });

  it("drops zero / negative / non-numeric / unknown keys", () => {
    expect(parseOddsMap({ h: "0", d: "-1", a: "abc", foo: "2.0" })).toEqual({});
  });

  it("partial odds keep only the present markets", () => {
    expect(parseOddsMap({ h: "1.5" })).toEqual({ h: 1.5 });
  });

  it("undefined / empty input → empty map", () => {
    expect(parseOddsMap(undefined)).toEqual({});
    expect(parseOddsMap({})).toEqual({});
  });
});

// ── Byte-identical equivalence with the PRE-extraction inline format ──
// Guards against silently changing the cache key (which would invalidate every
// cached engine result on deploy, or worse, alias keys that shouldn't match).
describe("equivalence with the original inline MatchdayContext format", () => {
  it("version key matches the old template string exactly", () => {
    const league = "bundesliga", avg = 1.5, hf = 1.1, frac = 0.33;
    const calLoaded = true, filterShieldLoaded = true;
    const sos = { A: 1, B: 2, C: 3 }, pxgSize = 42, lkm = 0.9;
    const matches = [{ h: "Bayern", a: "Köln" }, { h: "BVB", a: "S04" }];
    const matchIdsCsv = matches.map(m => `${m.h}:${m.a}`).join(",");
    const sosKey = `sos${Object.keys(sos).length}`;
    const OLD = `${league}|${avg}|${hf}|${frac}|${calLoaded}|${filterShieldLoaded}|${sosKey}|pxg${pxgSize}|lkm${lkm}|${matchIdsCsv}`;
    const NEW = engineCacheVersionKey({
      league, leagueAvg: avg, homeFactor: hf, fraction: frac,
      calLoaded, filterShieldLoaded, sosTeamCount: Object.keys(sos).length,
      playerXgSize: pxgSize, leagueKellyMultiplier: lkm,
      matchIds: matches.map(m => `${m.h}:${m.a}`),
    });
    expect(NEW).toBe(OLD);
  });

  it("per-match key matches the old template string exactly", () => {
    const OLD = `${"Bayern"}|${"Köln"}|${JSON.stringify({ h: "1.5" })}`;
    expect(engineCacheKey("Bayern", "Köln", { h: "1.5" })).toBe(OLD);
  });
});
