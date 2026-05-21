// ═══════════════════════════════════════════════════════════════════
// tests/dev03-features.test.ts
// TS port of dev-03 feature builder (m2_lambda + Elo + Momentum)
// parity tests against the Python reference pipeline.
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  loadFeatureCache,
  isFeatureCacheLoaded,
  getLeagueConstants,
  getElo,
  getEloDiff,
  getMomentum,
  getMomentumNorms,
  computeTeamStrength,
  buildDev03Features,
  debugFeatureBuild,
  ewmaRecentFirst,
  ewmaWithFallback,
  effectiveSampleSize,
  _resetFeatureCacheForTests,
  type Dev03FeatureCache,
} from "../src/lib/dev03-features";
import type { XGHistoryEntry } from "@/types/match";

// ─── Test fixtures ───────────────────────────────────────────────────

const CACHE_PATH = path.join(__dirname, "..", "public", "dev03-feature-cache.json");
const GOLDEN_PATH = path.join(__dirname, "fixtures", "dev03-features-golden.json");

let realCache: Dev03FeatureCache | null = null;
let goldenFixtures: any = null;

beforeAll(() => {
  if (fs.existsSync(CACHE_PATH)) {
    realCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  }
  if (fs.existsSync(GOLDEN_PATH)) {
    goldenFixtures = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf-8"));
  }
});

beforeEach(() => {
  _resetFeatureCacheForTests();
});

// ─── Mock minimal cache for unit tests ───────────────────────────────

function makeMockCache(): Dev03FeatureCache {
  return {
    version: "dev-03-feature-cache-1",
    exported_at: "2026-05-21T00:00:00Z",
    data_window: {
      history_through: "2026-05-17T00:00:00",
      snapshot_date: "2026-05-18T00:00:00",
      n_history_rows: 90000,
    },
    league_constants: {
      epl: { home_xg_avg: 1.50, away_xg_avg: 1.30, home_advantage: 0.20, total_avg: 2.80, n_matches: 1000, source: "computed" },
      bundesliga: { home_xg_avg: 1.73, away_xg_avg: 1.38, home_advantage: 0.35, total_avg: 3.11, n_matches: 900, source: "computed" },
    },
    elo: {
      "epl|Liverpool": 1700.0,
      "epl|Aston Villa": 1500.0,
      "bundesliga|Bayern Munich": 1800.0,
      "bundesliga|VfB Stuttgart": 1550.0,
    },
    elo_default: 1500.0,
    momentum: {
      "epl|Liverpool": { raw_lineup: 0.8, raw_form: 12.0, n_seen: 30 },
      "epl|Aston Villa": { raw_lineup: 0.1, raw_form: 6.0, n_seen: 30 },
      "bundesliga|Bayern Munich": { raw_lineup: 1.5, raw_form: 15.0, n_seen: 25 },
    },
    momentum_norms: {
      epl: { mu_lineup: 0.0, sd_lineup: 0.5, mu_form: 6.0, sd_form: 4.0 },
      bundesliga: { mu_lineup: 0.0, sd_lineup: 0.7, mu_form: 6.0, sd_form: 4.0 },
    },
    momentum_default: { raw_lineup: 0.0, raw_form: 0.0, n_seen: 0 },
    meta: {},
  };
}

// ─── EWMA primitive tests ────────────────────────────────────────────

describe("dev03-features · EWMA primitives", () => {
  it("ewmaRecentFirst: single value returns that value", () => {
    expect(ewmaRecentFirst([2.5], 8)).toBeCloseTo(2.5, 10);
  });

  it("ewmaRecentFirst: most recent has weight 1, next has weight 0.5^(1/halflife)", () => {
    // halflife=1: weights [1.0, 0.5, 0.25, ...]
    // [2, 1, 0]:  num = 2*1 + 1*0.5 + 0*0.25 = 2.5 / (1+0.5+0.25) = 1.4285...
    const v = ewmaRecentFirst([2, 1, 0], 1);
    expect(v).toBeCloseTo(2.5 / 1.75, 8);
  });

  it("ewmaRecentFirst: returns NaN below min_periods", () => {
    expect(ewmaRecentFirst([1, 2], 8, 5)).toBeNaN();
  });

  it("ewmaRecentFirst: returns NaN on empty input", () => {
    expect(ewmaRecentFirst([], 8)).toBeNaN();
  });

  it("ewmaRecentFirst: throws on non-positive halflife", () => {
    expect(() => ewmaRecentFirst([1, 2, 3], 0)).toThrow();
    expect(() => ewmaRecentFirst([1, 2, 3], -1)).toThrow();
  });

  it("ewmaRecentFirst: NaN values are skipped but their position still counts", () => {
    // [1.0, NaN, 2.0] with halflife=1:
    // weights at finite positions = [1, 0.25], values = [1, 2]
    // → (1*1 + 2*0.25) / (1 + 0.25) = 1.5 / 1.25 = 1.2
    const v = ewmaRecentFirst([1.0, NaN, 2.0], 1);
    expect(v).toBeCloseTo(1.2, 8);
  });

  it("ewmaWithFallback: returns fallback below min_periods", () => {
    expect(ewmaWithFallback([1, 2], 8, 1.55, 5)).toBe(1.55);
  });

  it("ewmaWithFallback: returns real EWMA when enough data", () => {
    expect(ewmaWithFallback([1.5, 1.5, 1.5, 1.5, 1.5], 8, 99, 4)).toBeCloseTo(1.5, 8);
  });

  it("effectiveSampleSize: 0 obs → 0", () => {
    expect(effectiveSampleSize(0, 8)).toBe(0);
  });

  it("effectiveSampleSize: 30 obs with halflife=8 → ~20", () => {
    // For halflife=8 and n=30, decay is slow → effective sample ≈ 20.
    // Verified against Python reference (m2_lambda.ewma.effective_sample_size).
    const ess = effectiveSampleSize(30, 8);
    expect(ess).toBeGreaterThan(18);
    expect(ess).toBeLessThan(22);
  });

  it("effectiveSampleSize: monotonic in n", () => {
    expect(effectiveSampleSize(10, 8)).toBeLessThan(effectiveSampleSize(20, 8));
  });
});

// ─── Cache loading + lookups ─────────────────────────────────────────

describe("dev03-features · cache loading + lookups", () => {
  it("starts unloaded", () => {
    expect(isFeatureCacheLoaded()).toBe(false);
  });

  it("loads mock cache successfully", () => {
    const ok = loadFeatureCache(makeMockCache());
    expect(ok).toBe(true);
    expect(isFeatureCacheLoaded()).toBe(true);
  });

  it("rejects cache missing required keys", () => {
    const bad = { ...makeMockCache(), elo: undefined } as any;
    expect(loadFeatureCache(bad)).toBe(false);
  });

  it("getLeagueConstants returns fallback when cache not loaded", () => {
    const lc = getLeagueConstants("epl");
    expect(lc.source).toBe("cache_not_loaded");
    expect(lc.home_xg_avg).toBe(1.55);
  });

  it("getLeagueConstants returns cached values when loaded", () => {
    loadFeatureCache(makeMockCache());
    const lc = getLeagueConstants("epl");
    expect(lc.home_xg_avg).toBe(1.50);
    expect(lc.total_avg).toBe(2.80);
    expect(lc.source).toBe("computed");
  });

  it("getLeagueConstants handles case-insensitive + trimmed lookup", () => {
    loadFeatureCache(makeMockCache());
    expect(getLeagueConstants("EPL").home_xg_avg).toBe(1.50);
    expect(getLeagueConstants(" epl ").home_xg_avg).toBe(1.50);
  });

  it("getLeagueConstants returns unknown_league_fallback for unknown", () => {
    loadFeatureCache(makeMockCache());
    expect(getLeagueConstants("made_up_liga").source).toBe("unknown_league_fallback");
  });

  it("getElo returns default 1500 when cache not loaded", () => {
    expect(getElo("Liverpool", "epl")).toBe(1500.0);
  });

  it("getElo returns cached rating", () => {
    loadFeatureCache(makeMockCache());
    expect(getElo("Liverpool", "epl")).toBe(1700.0);
    expect(getElo("Bayern Munich", "bundesliga")).toBe(1800.0);
  });

  it("getElo falls back to elo_default for unknown team", () => {
    loadFeatureCache(makeMockCache());
    expect(getElo("Made Up Team", "epl")).toBe(1500.0);
  });

  it("getEloDiff = home - away", () => {
    loadFeatureCache(makeMockCache());
    expect(getEloDiff("Liverpool", "Aston Villa", "epl")).toBe(200.0);
    expect(getEloDiff("Aston Villa", "Liverpool", "epl")).toBe(-200.0);
  });

  it("getMomentum returns default for unknown team", () => {
    loadFeatureCache(makeMockCache());
    const m = getMomentum("Unknown FC", "epl");
    expect(m.raw_lineup).toBe(0.0);
    expect(m.raw_form).toBe(0.0);
  });

  it("getMomentumNorms returns sane defaults when cache not loaded", () => {
    const n = getMomentumNorms("epl");
    expect(n.mu_lineup).toBe(0.0);
    expect(n.sd_lineup).toBe(1.0);
  });

  it("getMomentumNorms returns sane neutrals for unknown league", () => {
    loadFeatureCache(makeMockCache());
    const n = getMomentumNorms("made_up_liga");
    expect(n.sd_lineup).toBe(1.0);
    expect(n.sd_form).toBe(1.0);
  });
});

// ─── Team strength ───────────────────────────────────────────────────

describe("dev03-features · computeTeamStrength", () => {
  function makeHistory(xgValues: number[]): XGHistoryEntry[] {
    return xgValues.map(xg => ({
      xg,
      xga: 1.0, // const for these tests
    }));
  }

  it("falls back to league avg when n < min_matches", () => {
    const s = computeTeamStrength(makeHistory([1.5, 1.5, 1.5]), 1.4); // n=3
    expect(s.is_fallback).toBe(true);
    expect(s.attack_xg).toBe(1.4);
    expect(s.defense_xga).toBe(1.4);
  });

  it("computes real EWMA when n ≥ 4", () => {
    const s = computeTeamStrength(makeHistory([2.0, 2.0, 2.0, 2.0, 2.0]), 1.5);
    expect(s.is_fallback).toBe(false);
    // All 2.0 → EWMA should be 2.0
    expect(s.attack_xg).toBeCloseTo(2.0, 8);
    expect(s.defense_xga).toBeCloseTo(1.0, 8); // makeHistory has xga=1.0
  });

  it("respects lookback_matches cap", () => {
    // 30 matches, lookback=16 — only last 16 should count
    const recentValues = Array(16).fill(2.0);
    const olderValues = Array(14).fill(10.0); // shouldn't matter
    const history = makeHistory([...recentValues, ...olderValues]);
    const s = computeTeamStrength(history, 1.5);
    expect(s.attack_xg).toBeCloseTo(2.0, 8);
    expect(s.n_matches).toBe(16);
  });

  it("ess is approximately effectiveSampleSize(n, halflife)", () => {
    const s = computeTeamStrength(makeHistory(Array(10).fill(1.5)), 1.5);
    const expected = effectiveSampleSize(10, 8);
    expect(s.ess).toBeCloseTo(expected, 6);
  });
});

// ─── Feature building — unit tests ───────────────────────────────────

describe("dev03-features · buildDev03Features unit", () => {
  beforeEach(() => loadFeatureCache(makeMockCache()));

  function makeHistory(xg: number, xga: number, n = 16): XGHistoryEntry[] {
    return Array(n).fill(null).map(() => ({ xg, xga }));
  }

  it("builds all 17 features for a valid input", () => {
    const f = buildDev03Features({
      homeTeam: "Liverpool", awayTeam: "Aston Villa", league: "epl",
      hHistory: makeHistory(2.0, 1.0),
      aHistory: makeHistory(1.0, 2.0),
    });
    expect(f.home_attack_ratio).toBeGreaterThan(1.0); // 2.0 > league avg
    expect(f.away_attack_ratio).toBeLessThan(1.0); // 1.0 < league avg
    expect(f.elo_diff).toBe(200.0); // Liverpool 1700 - Aston Villa 1500
    expect(f.league).toBe("epl");
    expect(f.league_home_avg).toBe(1.50);
    expect(f.lambda_h_naive).toBeGreaterThan(f.lambda_a_naive); // home strong
  });

  it("attack/defense ratios center on 1.0 for league-avg team", () => {
    // total_avg=2.80 → neutral_side_avg=1.40. A team with xg=1.40 EWMA → ratio=1.0
    const f = buildDev03Features({
      homeTeam: "Liverpool", awayTeam: "Aston Villa", league: "epl",
      hHistory: makeHistory(1.40, 1.40),
      aHistory: makeHistory(1.40, 1.40),
    });
    expect(f.home_attack_ratio).toBeCloseTo(1.0, 6);
    expect(f.home_defense_ratio).toBeCloseTo(1.0, 6);
    expect(f.away_attack_ratio).toBeCloseTo(1.0, 6);
    expect(f.away_defense_ratio).toBeCloseTo(1.0, 6);
  });

  it("lambda is clamped to [0.3, 4.5]", () => {
    // Extreme attack with weak defense → λ should clamp at 4.5
    const f = buildDev03Features({
      homeTeam: "Liverpool", awayTeam: "Aston Villa", league: "epl",
      hHistory: makeHistory(5.0, 0.1),
      aHistory: makeHistory(0.1, 5.0),
    });
    expect(f.lambda_h_naive).toBeLessThanOrEqual(4.5);
    expect(f.lambda_a_naive).toBeGreaterThanOrEqual(0.3);
  });

  it("uses fallback when team has < 4 matches", () => {
    const f = buildDev03Features({
      homeTeam: "Liverpool", awayTeam: "Aston Villa", league: "epl",
      hHistory: makeHistory(2.0, 1.0, 2), // < 4 matches → fallback
      aHistory: makeHistory(1.0, 2.0, 16),
    });
    // Home falls back to neutral_side_avg → ratio = 1.0
    expect(f.home_attack_ratio).toBeCloseTo(1.0, 6);
    expect(f.home_defense_ratio).toBeCloseTo(1.0, 6);
  });

  it("momentum z-scoring clipped to [-3, 3]", () => {
    // Mock has Liverpool raw_lineup=0.8, mu=0, sd=0.5 → z=1.6 (Aston Villa raw=0.1 z=0.2)
    // diff = 1.6 - 0.2 = 1.4 (within [-3, 3])
    const f = buildDev03Features({
      homeTeam: "Liverpool", awayTeam: "Aston Villa", league: "epl",
      hHistory: makeHistory(2.0, 1.0),
      aHistory: makeHistory(1.0, 2.0),
    });
    expect(f.lineup_quality_diff).toBeGreaterThan(0); // Liverpool > Aston Villa
    expect(f.lineup_quality_diff).toBeLessThanOrEqual(3.0);
    expect(f.lineup_quality_diff).toBeGreaterThanOrEqual(-3.0);
  });

  it("debugFeatureBuild exposes all intermediates", () => {
    const d = debugFeatureBuild({
      homeTeam: "Liverpool", awayTeam: "Aston Villa", league: "epl",
      hHistory: makeHistory(2.0, 1.0),
      aHistory: makeHistory(1.0, 2.0),
    });
    expect(d.intermediates.league_constants.home_xg_avg).toBe(1.50);
    expect(d.intermediates.home_elo).toBe(1700.0);
    expect(d.intermediates.home_strength.is_fallback).toBe(false);
    expect(d.intermediates.lambda_h_raw).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GOLDEN PARITY: real Python pipeline output vs TS port
// ═══════════════════════════════════════════════════════════════════════

describe("dev03-features · GOLDEN PARITY (Python ↔ TS within 1e-6)", () => {
  it("loads the real public/dev03-feature-cache.json", () => {
    if (!realCache) {
      console.log("[dev03-features] feature-cache.json not found — skipping integration");
      return;
    }
    expect(loadFeatureCache(realCache)).toBe(true);
  });

  if (process.env.SKIP_GOLDEN !== "1") {
    it("has 22 leagues in real cache", () => {
      if (!realCache) return;
      expect(Object.keys(realCache.league_constants)).toHaveLength(22);
    });

    it("processes ALL golden fixtures within practical tolerances", () => {
      if (!realCache || !goldenFixtures) {
        console.log("[dev03-features] cache or golden fixtures missing — skipping");
        return;
      }
      loadFeatureCache(realCache);

      // After the 2026-05-21 fix to EloCalculator + TeamMomentumCalculator
      // (mergesort + canonical (date, team, opponent) secondary key), the
      // Python pipeline is fully deterministic across input row orders.
      // Tolerances now reflect ONLY float64 round-trip noise (JSON encode
      // + parse + arithmetic re-order) — i.e. ~1e-10 in principle, but we
      // allow 1e-6 as a safety margin for accumulated EWMA roundoff.
      const TOLERANCES: Record<string, number> = {
        elo_diff: 1e-6,
        league_home_avg: 1e-6,
        league_away_avg: 1e-6,
        league_home_advantage: 1e-6,
        home_attack_ratio: 1e-6,
        home_defense_ratio: 1e-6,
        away_attack_ratio: 1e-6,
        away_defense_ratio: 1e-6,
        attack_defense_ratio_h: 1e-6,
        attack_defense_ratio_a: 1e-6,
        lambda_h_naive: 1e-6,
        lambda_a_naive: 1e-6,
        home_ess: 1e-6,
        away_ess: 1e-6,
        lineup_quality_diff: 1e-6,
        form_streak_diff: 1e-6,
      };

      const failures: string[] = [];
      for (const fx of goldenFixtures.fixtures) {
        const f = buildDev03Features({
          homeTeam: fx.input.homeTeam,
          awayTeam: fx.input.awayTeam,
          league: fx.input.league,
          hHistory: fx.input.hHistory,
          aHistory: fx.input.aHistory,
        });

        for (const [key, expected] of Object.entries(fx.expected_features)) {
          if (key === "league") {
            if (f.league !== expected) {
              failures.push(`${fx.name}.${key}: got "${f.league}", expected "${expected}"`);
            }
            continue;
          }
          const got = (f as any)[key];
          if (typeof got !== "number" || typeof expected !== "number") {
            failures.push(`${fx.name}.${key}: type mismatch (got=${got}, expected=${expected})`);
            continue;
          }
          const tol = TOLERANCES[key] ?? 1e-6;
          const diff = Math.abs(got - expected);
          if (diff > tol) {
            failures.push(
              `${fx.name}.${key}: got=${got.toFixed(8)}, expected=${expected.toFixed(8)}, diff=${diff.toExponential(2)} (tol=${tol})`
            );
          }
        }
      }
      if (failures.length > 0) {
        console.error("Golden parity failures:\n  " + failures.join("\n  "));
      }
      expect(failures).toEqual([]);
    });

    it("Elo values match cache within float-noise (1e-6) — determinism contract", () => {
      if (!realCache || !goldenFixtures) return;
      loadFeatureCache(realCache);
      // Post-fix (2026-05-21): EloCalculator + TeamMomentum sort by canonical
      // (match_date, team, opponent) with mergesort. Result is fully
      // deterministic across input row orders. Any future regression in the
      // sort-order contract (e.g. someone re-introducing default quicksort)
      // will surface here as Elo-diff > 1e-6.
      for (const fx of goldenFixtures.fixtures) {
        const expected = fx.expected_features.elo_diff;
        const got = buildDev03Features({
          homeTeam: fx.input.homeTeam,
          awayTeam: fx.input.awayTeam,
          league: fx.input.league,
          hHistory: fx.input.hHistory,
          aHistory: fx.input.aHistory,
        }).elo_diff;
        expect(Math.abs(got - expected)).toBeLessThan(1e-6);
      }
    });

    it("EPL Liverpool-style fixture has plausible lambdas", () => {
      if (!realCache || !goldenFixtures) return;
      loadFeatureCache(realCache);
      const eplFx = goldenFixtures.fixtures.find((fx: any) => fx.input.league === "epl");
      if (!eplFx) return;
      const f = buildDev03Features({
        homeTeam: eplFx.input.homeTeam, awayTeam: eplFx.input.awayTeam, league: "epl",
        hHistory: eplFx.input.hHistory, aHistory: eplFx.input.aHistory,
      });
      expect(f.lambda_h_naive).toBeGreaterThan(0.3);
      expect(f.lambda_h_naive).toBeLessThan(4.5);
      expect(f.lambda_a_naive).toBeGreaterThan(0.3);
      expect(f.lambda_a_naive).toBeLessThan(4.5);
      expect(f.elo_diff).not.toBe(0);
    });
  }
});
