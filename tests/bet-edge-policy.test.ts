// ═══════════════════════════════════════════════════════════════════════
// tests/bet-edge-policy.test.ts
// Hybrid Engine-Selector Policy — re-validated 2026-05-25 under 5-Gate
// Falsification Protocol. Previous policy (5 leagues) shrunken to 4
// Holm-Bonferroni-survivors after multi-season walk-forward audit.
// See: tools/v4/diagnostics/bet_edge_policy_audit.{py,json}
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

describe("bet-edge-policy · 4 Holm-Bonferroni-validated leagues (2026-05-25)", () => {
  it("la_liga + scottish_prem + bundesliga + primeira_liga ALL use dev-03", () => {
    expect(validatedEngineFor("la_liga")).toBe("dev-03");
    expect(validatedEngineFor("scottish_prem")).toBe("dev-03");
    expect(validatedEngineFor("bundesliga")).toBe("dev-03");
    expect(validatedEngineFor("primeira_liga")).toBe("dev-03");
  });

  it("validatedLeagues() returns exactly 4 entries", () => {
    const vs = validatedLeagues();
    expect(vs).toHaveLength(4);
    const slugs = vs.map((v) => v.league);
    expect(slugs.sort()).toEqual(
      ["bundesliga", "la_liga", "primeira_liga", "scottish_prem"].sort(),
    );
  });

  it("all 4 use dev-03 (no v2 entries in current policy)", () => {
    const vs = validatedLeagues();
    expect(vs.every((v) => v.engine === "dev-03")).toBe(true);
  });
});

describe("bet-edge-policy · REMOVED leagues (pre-2026-05-25 'validated' that failed audit)", () => {
  it.each(["epl", "serie_a", "serie_b"])(
    "%s is now engine=null (REVERSED under fresh walk-forward)",
    (lg) => {
      expect(validatedEngineFor(lg)).toBeNull();
      expect(hasValidatedEdge(lg)).toBe(false);
      const r = leagueEdgeRecord(lg);
      expect(r).not.toBeNull();
      expect(r!.reason.toLowerCase()).toContain("removed");
    },
  );

  it("epl record documents catastrophic reversal", () => {
    const r = leagueEdgeRecord("epl");
    expect(r!.reason.toLowerCase()).toContain("catastrophic reversal");
  });

  it("REMOVED leagues retain their audit ROI numbers for transparency", () => {
    for (const lg of ["epl", "serie_a", "serie_b"]) {
      const r = leagueEdgeRecord(lg)!;
      expect(r.roi_walkfwd_24_25).not.toBeNull();
      expect(r.roi_holdout_25_26).not.toBeNull();
      expect(r.holm_p_adj).toBeGreaterThan(0.05); // failed Holm correction
    }
  });
});

describe("bet-edge-policy · borderline leagues (positive but failed Holm)", () => {
  it("eredivisie has both-positive ROI but engine=null (fails Holm at p_adj=0.139)", () => {
    const r = leagueEdgeRecord("eredivisie");
    expect(r).not.toBeNull();
    expect(r!.engine).toBeNull();
    expect(r!.roi_walkfwd_24_25).toBeGreaterThan(0);
    expect(r!.roi_holdout_25_26).toBeGreaterThan(0);
    expect(r!.holm_p_adj).toBeGreaterThan(0.05);
  });

  it("greek_sl has small sample size flag in reason", () => {
    const r = leagueEdgeRecord("greek_sl");
    expect(r!.reason.toLowerCase()).toContain("small");
  });
});

describe("bet-edge-policy · explicitly NOT validated leagues", () => {
  it.each(["bundesliga2", "championship", "jupiler_pro", "ligue_1", "super_lig"])(
    "%s returns engine=null",
    (lg) => {
      expect(validatedEngineFor(lg)).toBeNull();
      expect(hasValidatedEdge(lg)).toBe(false);
    },
  );
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
    expect(validatedEngineFor("LA_LIGA")).toBe("dev-03");
    expect(validatedEngineFor("Scottish_Prem")).toBe("dev-03");
    expect(validatedEngineFor("  bundesliga  ")).toBe("dev-03");
  });
});

describe("bet-edge-policy · expectedROIperStake (mean of walkfwd 24/25 + holdout 25/26)", () => {
  it("la_liga returns (66.36% + 6.18%) / 2 ≈ 36.27%", () => {
    const v = expectedROIperStake("la_liga");
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(0.3627, 3);
  });

  it("bundesliga returns (6.55% + 53.75%) / 2 ≈ 30.15%", () => {
    const v = expectedROIperStake("bundesliga");
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(0.3015, 3);
  });

  it("non-validated leagues return null", () => {
    expect(expectedROIperStake("epl")).toBeNull();
    expect(expectedROIperStake("serie_a")).toBeNull();
    expect(expectedROIperStake("bundesliga2")).toBeNull();
  });

  it("la_liga has the highest expected ROI of the 4 survivors", () => {
    const all = validatedLeagues().map((v) => ({
      league: v.league,
      eroi: expectedROIperStake(v.league)!,
    }));
    const sorted = [...all].sort((a, b) => b.eroi - a.eroi);
    expect(sorted[0].league).toBe("la_liga");
  });
});

describe("bet-edge-policy · audit metadata (Holm-Bonferroni evidence)", () => {
  it("all 4 validated leagues have Holm-adj p < 0.05", () => {
    for (const v of validatedLeagues()) {
      const r = leagueEdgeRecord(v.league)!;
      expect(r.holm_p_adj).not.toBeNull();
      expect(r.holm_p_adj!).toBeLessThan(0.05);
    }
  });

  it("all 4 validated leagues have BOTH holdout ROIs positive", () => {
    for (const v of validatedLeagues()) {
      const r = leagueEdgeRecord(v.league)!;
      expect(r.roi_walkfwd_24_25).not.toBeNull();
      expect(r.roi_holdout_25_26).not.toBeNull();
      expect(r.roi_walkfwd_24_25!).toBeGreaterThan(0);
      expect(r.roi_holdout_25_26!).toBeGreaterThan(0);
    }
  });

  it("all 4 validated leagues have mean ROI > 2.5% (Pinnacle vig threshold)", () => {
    for (const v of validatedLeagues()) {
      const eroi = expectedROIperStake(v.league)!;
      expect(eroi).toBeGreaterThan(0.025);
    }
  });

  it("all 4 validated leagues have combined sample size ≥ 40", () => {
    for (const v of validatedLeagues()) {
      const r = leagueEdgeRecord(v.league)!;
      const n = (r.sampleSize_walkfwd_24_25 ?? 0) + (r.sampleSize_holdout_25_26 ?? 0);
      expect(n).toBeGreaterThanOrEqual(40);
    }
  });
});
