import { describe, it, expect } from "vitest";
import {
  LEAGUE_LIQUIDITY_TIERS,
  DEFAULT_TIER,
  getLeagueLiquidityTier,
  classifyEdgeForLeague,
} from "@/lib/league-liquidity";
import { LEAGUES } from "@/lib/dixon-coles";

// All leagues that the live engine actually predicts on (not CL/EL placeholders).
const ACTIVE_LEAGUES = Object.keys(LEAGUES).filter(k => k !== "cl" && k !== "el");

describe("LEAGUE_LIQUIDITY_TIERS coverage", () => {
  it("every active LEAGUES entry has a tier mapping", () => {
    const missing = ACTIVE_LEAGUES.filter(k => !(k in LEAGUE_LIQUIDITY_TIERS));
    expect(missing, `missing tier for: ${missing.join(", ")}`).toEqual([]);
  });

  it("CL + EL are explicitly mapped to TIER_1 (sharp UEFA odds markets)", () => {
    expect(LEAGUE_LIQUIDITY_TIERS.cl).toBeDefined();
    expect(LEAGUE_LIQUIDITY_TIERS.el).toBeDefined();
  });

  it("all tier values satisfy goldilocksMin < goldilocksMax < trapSoft <= trapHard", () => {
    for (const [key, t] of Object.entries(LEAGUE_LIQUIDITY_TIERS)) {
      expect(t.goldilocksMin, `${key}.goldilocksMin`).toBeGreaterThan(0);
      expect(t.goldilocksMin, `${key} min<max`).toBeLessThan(t.goldilocksMax);
      expect(t.goldilocksMax, `${key} max<trapSoft`).toBeLessThan(t.trapSoft);
      expect(t.trapSoft, `${key} soft<=hard`).toBeLessThanOrEqual(t.trapHard);
    }
  });

  it("Tier-1 leagues are tighter than Tier-3 leagues", () => {
    const epl = LEAGUE_LIQUIDITY_TIERS.epl;
    const liga3 = LEAGUE_LIQUIDITY_TIERS.liga3;
    expect(epl.goldilocksMin).toBeLessThan(liga3.goldilocksMin);
    expect(epl.goldilocksMax).toBeLessThan(liga3.goldilocksMax);
    expect(epl.trapHard).toBeLessThan(liga3.trapHard);
  });

  it("Top-5 (epl/la_liga/serie_a/bundesliga/ligue_1) all share the same tier", () => {
    const t = LEAGUE_LIQUIDITY_TIERS.epl;
    expect(LEAGUE_LIQUIDITY_TIERS.la_liga).toEqual(t);
    expect(LEAGUE_LIQUIDITY_TIERS.serie_a).toEqual(t);
    expect(LEAGUE_LIQUIDITY_TIERS.bundesliga).toEqual(t);
    expect(LEAGUE_LIQUIDITY_TIERS.ligue_1).toEqual(t);
  });

  it("Tier-3 includes liga3, league_one, league_two, greek_sl, eerste_divisie", () => {
    const t3 = LEAGUE_LIQUIDITY_TIERS.liga3;
    expect(LEAGUE_LIQUIDITY_TIERS.league_one).toEqual(t3);
    expect(LEAGUE_LIQUIDITY_TIERS.league_two).toEqual(t3);
    expect(LEAGUE_LIQUIDITY_TIERS.greek_sl).toEqual(t3);
    expect(LEAGUE_LIQUIDITY_TIERS.eerste_divisie).toEqual(t3);
  });
});

describe("getLeagueLiquidityTier", () => {
  it("returns the tier for a known league", () => {
    expect(getLeagueLiquidityTier("epl")).toEqual(LEAGUE_LIQUIDITY_TIERS.epl);
  });

  it("falls back to DEFAULT_TIER for unknown league", () => {
    expect(getLeagueLiquidityTier("imaginary_liga")).toEqual(DEFAULT_TIER);
  });

  it("falls back to DEFAULT_TIER for undefined league", () => {
    expect(getLeagueLiquidityTier(undefined)).toEqual(DEFAULT_TIER);
  });

  it("never throws on empty string or null-y input", () => {
    expect(() => getLeagueLiquidityTier("")).not.toThrow();
    expect(getLeagueLiquidityTier("")).toEqual(DEFAULT_TIER);
  });
});

describe("classifyEdgeForLeague", () => {
  it("EPL: 1% edge = noise, 3% edge = value, 9% edge = trap-soft, 12% edge = trap-hard", () => {
    expect(classifyEdgeForLeague(0.01, "epl")).toBe("noise");
    expect(classifyEdgeForLeague(0.03, "epl")).toBe("value");
    expect(classifyEdgeForLeague(0.09, "epl")).toBe("trap-soft");
    expect(classifyEdgeForLeague(0.12, "epl")).toBe("trap-hard");
  });

  it("Liga 3: 3% edge = noise, 5% edge = value, 12% edge = trap-soft, 16% edge = trap-hard", () => {
    expect(classifyEdgeForLeague(0.03, "liga3")).toBe("noise");
    expect(classifyEdgeForLeague(0.05, "liga3")).toBe("value");
    expect(classifyEdgeForLeague(0.12, "liga3")).toBe("trap-soft");
    expect(classifyEdgeForLeague(0.16, "liga3")).toBe("trap-hard");
  });

  it("a 3% edge is a Value-Bet in EPL but noise in Liga 3 — exactly the per-Liga adaptation we want", () => {
    expect(classifyEdgeForLeague(0.03, "epl")).toBe("value");
    expect(classifyEdgeForLeague(0.03, "liga3")).toBe("noise");
  });

  it("an 8% edge is value in Liga 3 but trap-soft in EPL — exactly the per-Liga adaptation we want", () => {
    expect(classifyEdgeForLeague(0.08, "liga3")).toBe("value");
    expect(classifyEdgeForLeague(0.08, "epl")).toBe("trap-soft");
  });

  it("boundary inclusivity: edge == goldilocksMin/Max → still value (closed interval)", () => {
    const t = LEAGUE_LIQUIDITY_TIERS.epl;
    expect(classifyEdgeForLeague(t.goldilocksMin, "epl")).toBe("value");
    expect(classifyEdgeForLeague(t.goldilocksMax, "epl")).toBe("value");
  });

  it("unknown league falls back to DEFAULT_TIER (Tier-2) thresholds", () => {
    expect(classifyEdgeForLeague(0.02, "imaginary_liga")).toBe("noise");
    expect(classifyEdgeForLeague(0.05, "imaginary_liga")).toBe("value");
    expect(classifyEdgeForLeague(0.13, "imaginary_liga")).toBe("trap-hard");
  });
});
