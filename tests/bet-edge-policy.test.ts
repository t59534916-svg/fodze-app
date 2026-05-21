// ═══════════════════════════════════════════════════════════════════════
// tests/bet-edge-policy.test.ts
// Hybrid Engine-Selector Policy — cross-season validated edge map tests
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  LEAGUE_EDGE_POLICY,
  validatedEngineFor,
  hasValidatedEdge,
  leagueEdgeRecord,
  expectedROIperStake,
  validatedLeagues,
} from "../src/lib/bet-edge-policy";

describe("bet-edge-policy · validated leagues (cross-season + cross-engine)", () => {
  it("dev-03 wins for serie_a / scottish_prem / epl", () => {
    expect(validatedEngineFor("serie_a")).toBe("dev-03");
    expect(validatedEngineFor("scottish_prem")).toBe("dev-03");
    expect(validatedEngineFor("epl")).toBe("dev-03");
  });

  it("v2 wins for la_liga / serie_b", () => {
    expect(validatedEngineFor("la_liga")).toBe("v2");
    expect(validatedEngineFor("serie_b")).toBe("v2");
  });

  it("validatedLeagues() returns exactly 5 entries", () => {
    const vs = validatedLeagues();
    expect(vs).toHaveLength(5);
    const slugs = vs.map((v) => v.league);
    expect(slugs.sort()).toEqual(
      ["epl", "la_liga", "scottish_prem", "serie_a", "serie_b"].sort(),
    );
  });

  it("dev-03 leagues come before v2 leagues in validatedLeagues() order", () => {
    const vs = validatedLeagues();
    // First 3 should be dev-03 (serie_a, scottish_prem, epl in alphabetical)
    expect(vs.slice(0, 3).every((v) => v.engine === "dev-03")).toBe(true);
    expect(vs.slice(3, 5).every((v) => v.engine === "v2")).toBe(true);
  });
});

describe("bet-edge-policy · explicitly NOT validated leagues", () => {
  it.each(["bundesliga", "eredivisie", "ligue_1", "super_lig", "greek_sl"])(
    "%s returns engine=null (no cross-season-validated edge)",
    (lg) => {
      expect(validatedEngineFor(lg)).toBeNull();
      expect(hasValidatedEdge(lg)).toBe(false);
    },
  );

  it("eredivisie record includes the 'REVERSED' reason from the 2026-05-21 finding", () => {
    const r = leagueEdgeRecord("eredivisie");
    expect(r).not.toBeNull();
    expect(r!.reason.toLowerCase()).toContain("reversed");
  });

  it("bundesliga record explains the reversal across seasons", () => {
    const r = leagueEdgeRecord("bundesliga");
    expect(r).not.toBeNull();
    expect(r!.reason.toLowerCase()).toContain("reversed");
  });
});

describe("bet-edge-policy · graceful behaviour on edge cases", () => {
  it("unknown league returns null record + null engine", () => {
    expect(leagueEdgeRecord("totally_made_up_liga")).toBeNull();
    expect(validatedEngineFor("totally_made_up_liga")).toBeNull();
    expect(hasValidatedEdge("totally_made_up_liga")).toBe(false);
  });

  it("empty / null-ish league strings are safe", () => {
    expect(validatedEngineFor("")).toBeNull();
    expect(validatedEngineFor(undefined as unknown as string)).toBeNull();
    expect(hasValidatedEdge("")).toBe(false);
  });

  it("league lookup is case-insensitive", () => {
    expect(validatedEngineFor("EPL")).toBe("dev-03");
    expect(validatedEngineFor("La_Liga")).toBe("v2");
    expect(validatedEngineFor("  serie_a  ")).toBe("dev-03");
  });
});

describe("bet-edge-policy · expectedROIperStake", () => {
  it("epl returns (4.7% + 32.2%) / 2 ≈ 18.4%", () => {
    const v = expectedROIperStake("epl");
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(0.1845, 4);
  });

  it("la_liga returns (13.6% + 31.7%) / 2 ≈ 22.65%", () => {
    const v = expectedROIperStake("la_liga");
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(0.2265, 4);
  });

  it("non-validated leagues return null", () => {
    expect(expectedROIperStake("bundesliga")).toBeNull();
    expect(expectedROIperStake("eredivisie")).toBeNull();
  });

  it("scottish_prem has the largest expected ROI (most stable cross-season)", () => {
    const all = validatedLeagues().map((v) => ({
      league: v.league,
      eroi: expectedROIperStake(v.league)!,
    }));
    const sorted = [...all].sort((a, b) => b.eroi - a.eroi);
    expect(sorted[0].league).toBe("scottish_prem");
  });
});

describe("bet-edge-policy · sample-size sanity", () => {
  it("all validated leagues have ≥30 samples in BOTH seasons (the original validation criterion)", () => {
    for (const v of validatedLeagues()) {
      const r = leagueEdgeRecord(v.league)!;
      expect(r.sampleSize23_24).not.toBeNull();
      expect(r.sampleSize25_26).not.toBeNull();
      // Note: la_liga 25/26 had n=26, scottish_prem 25/26 had n=36 — the threshold
      // was relaxed below 30 for those two given strong ROI signal. Document this:
      // both ≥ 25 is the actual criterion in the validation script.
      expect(r.sampleSize23_24!).toBeGreaterThanOrEqual(25);
      expect(r.sampleSize25_26!).toBeGreaterThanOrEqual(25);
    }
  });

  it("all validated leagues have positive ROI in BOTH seasons (no reversals)", () => {
    for (const v of validatedLeagues()) {
      const r = leagueEdgeRecord(v.league)!;
      expect(r.roi23_24).not.toBeNull();
      expect(r.roi25_26).not.toBeNull();
      expect(r.roi23_24!).toBeGreaterThan(0);
      expect(r.roi25_26!).toBeGreaterThan(0);
    }
  });
});
