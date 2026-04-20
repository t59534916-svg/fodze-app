import { describe, it, expect } from "vitest";
import {
  classifySituation,
  aggregateXgBySituation,
  applySituationRatioPrior,
  SITUATION_RATIO_PRIOR as MJS_PRIOR,
} from "../scripts/_lib/game-state-xg.mjs";
import { fillSituationShareWithPrior, SITUATION_RATIO_PRIOR as TS_PRIOR } from "@/lib/supabase";
import { summarizeMatchShots } from "../scripts/backfill-xg-by-state.mjs";

describe("classifySituation", () => {
  it("maps OpenPlay variants to openplay", () => {
    expect(classifySituation("OpenPlay")).toBe("openplay");
    expect(classifySituation("open play")).toBe("openplay");
  });

  it("collapses all four set-piece-family situations to setpiece", () => {
    expect(classifySituation("SetPiece")).toBe("setpiece");
    expect(classifySituation("FromCorner")).toBe("setpiece");
    expect(classifySituation("DirectFreekick")).toBe("setpiece");
    expect(classifySituation("Penalty")).toBe("setpiece");
  });

  it("defaults unknown / empty to openplay (conservative)", () => {
    expect(classifySituation("")).toBe("openplay");
    expect(classifySituation(null as unknown as string)).toBe("openplay");
    expect(classifySituation("WhoKnows")).toBe("openplay");
  });
});

describe("aggregateXgBySituation", () => {
  it("splits team's own shots between openplay and setpiece", () => {
    const shots = [
      { xG: 0.20, shootingSide: "home", situation: "OpenPlay", homeGoalsBefore: 0, awayGoalsBefore: 0 },
      { xG: 0.15, shootingSide: "home", situation: "FromCorner", homeGoalsBefore: 0, awayGoalsBefore: 0 },
      { xG: 0.78, shootingSide: "home", situation: "Penalty", homeGoalsBefore: 1, awayGoalsBefore: 0 },
    ];
    const out = aggregateXgBySituation("home", shots);
    expect(out.xg_openplay).toBeCloseTo(0.20, 4);
    expect(out.xg_setpiece).toBeCloseTo(0.93, 4);
    expect(out.xga_openplay).toBe(0);
    expect(out.xga_setpiece).toBe(0);
  });

  it("mirrors for opponent → xga_* from team's perspective", () => {
    const shots = [
      { xG: 0.30, shootingSide: "away", situation: "SetPiece", homeGoalsBefore: 0, awayGoalsBefore: 0 },
      { xG: 0.12, shootingSide: "away", situation: "OpenPlay", homeGoalsBefore: 0, awayGoalsBefore: 0 },
    ];
    const home = aggregateXgBySituation("home", shots);
    expect(home.xga_setpiece).toBeCloseTo(0.30, 4);
    expect(home.xga_openplay).toBeCloseTo(0.12, 4);
    // Reversed view: away team has xg_* in corresponding buckets.
    const away = aggregateXgBySituation("away", shots);
    expect(away.xg_setpiece).toBeCloseTo(0.30, 4);
    expect(away.xg_openplay).toBeCloseTo(0.12, 4);
  });

  it("ignores non-finite / negative xG shots", () => {
    const shots = [
      { xG: NaN,  shootingSide: "home", situation: "OpenPlay", homeGoalsBefore: 0, awayGoalsBefore: 0 },
      { xG: -0.1, shootingSide: "home", situation: "FromCorner", homeGoalsBefore: 0, awayGoalsBefore: 0 },
    ];
    const out = aggregateXgBySituation("home", shots);
    expect(out.xg_openplay).toBe(0);
    expect(out.xg_setpiece).toBe(0);
  });
});

describe("applySituationRatioPrior", () => {
  it("splits season xG in the documented 73/27", () => {
    const out = applySituationRatioPrior(10);
    expect(out.xg_openplay).toBeCloseTo(7.3, 3);
    expect(out.xg_setpiece).toBeCloseTo(2.7, 3);
  });

  it("returns zeros for zero / null / NaN input", () => {
    expect(applySituationRatioPrior(0)).toEqual({ xg_openplay: 0, xg_setpiece: 0 });
    expect(applySituationRatioPrior(null)).toEqual({ xg_openplay: 0, xg_setpiece: 0 });
    expect(applySituationRatioPrior(NaN)).toEqual({ xg_openplay: 0, xg_setpiece: 0 });
  });
});

describe("Browser runtime mirror (src/lib/supabase.ts)", () => {
  it("SITUATION_RATIO_PRIOR matches between .mjs (scripts) and .ts (browser)", () => {
    expect(TS_PRIOR.openplay).toBe(MJS_PRIOR.openplay);
    expect(TS_PRIOR.setpiece).toBe(MJS_PRIOR.setpiece);
  });

  it("fillSituationShareWithPrior preserves real values, fills nulls", () => {
    const row: any = {
      team: "Arsenal", opponent: "Chelsea", venue: "home", match_date: "2025-09-01",
      xg: 2.0, xga: 1.0, npxg: null, npxga: null,
      ppda_att: null, ppda_def: null, deep: null, deep_allowed: null,
      goals_for: 2, goals_against: 1,
      xg_openplay: 1.35,        // real
      xg_setpiece: null,         // fill
      xga_openplay: null,        // fill
      xga_setpiece: 0.10,        // real
    };
    const filled = fillSituationShareWithPrior(row);
    expect(filled.xg_openplay).toBe(1.35);           // real preserved
    expect(filled.xg_setpiece).toBeCloseTo(0.54, 3); // 2.0 × 0.27
    expect(filled.xga_openplay).toBeCloseTo(0.73, 3); // 1.0 × 0.73
    expect(filled.xga_setpiece).toBe(0.10);          // real preserved
  });

  it("fills all four from scratch when all nullable", () => {
    const row: any = {
      team: "X", opponent: "Y", venue: "home", match_date: "2025-09-01",
      xg: 2.0, xga: 1.0, npxg: null, npxga: null,
      ppda_att: null, ppda_def: null, deep: null, deep_allowed: null,
      goals_for: 0, goals_against: 0,
      xg_openplay: null, xg_setpiece: null, xga_openplay: null, xga_setpiece: null,
    };
    const filled = fillSituationShareWithPrior(row);
    expect(filled.xg_openplay! + filled.xg_setpiece!).toBeCloseTo(2.0, 3);
    expect(filled.xga_openplay! + filled.xga_setpiece!).toBeCloseTo(1.0, 3);
  });
});

describe("End-to-end: summarizeMatchShots exposes situation breakdown", () => {
  it("splits home-team xG across openplay and setpiece", () => {
    // Two home shots: 0.20 OpenPlay at min 10, 0.70 Penalty at min 40.
    // One away shot: 0.15 FromCorner at min 25.
    const shots = {
      h: [
        { minute: "10", xG: "0.20", result: "MissedShots", h_a: "h", situation: "OpenPlay", h_team: "Arsenal", a_team: "Chelsea", date: "2025-09-01 15:00:00" },
        { minute: "40", xG: "0.70", result: "Goal",        h_a: "h", situation: "Penalty",  h_team: "Arsenal", a_team: "Chelsea", date: "2025-09-01 15:00:00" },
      ],
      a: [
        { minute: "25", xG: "0.15", result: "MissedShots", h_a: "a", situation: "FromCorner", h_team: "Arsenal", a_team: "Chelsea", date: "2025-09-01 15:00:00" },
      ],
    };
    const summary = summarizeMatchShots(shots);
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.home.xg_openplay).toBeCloseTo(0.20, 3);
    expect(summary.home.xg_setpiece).toBeCloseTo(0.70, 3);
    // Arsenal's defensive view of Chelsea's corner chance.
    expect(summary.home.xga_setpiece).toBeCloseTo(0.15, 3);
    expect(summary.home.xga_openplay).toBe(0);
    // Reversed view for away team.
    expect(summary.away.xg_setpiece).toBeCloseTo(0.15, 3);
    expect(summary.away.xga_setpiece).toBeCloseTo(0.70, 3);
  });

  it("defaults missing situation to openplay (conservative)", () => {
    const shots = {
      h: [
        { minute: "10", xG: "0.20", result: "MissedShots", h_a: "h", h_team: "X", a_team: "Y", date: "2025-09-01 15:00:00" },
        // no `situation` key
      ],
      a: [],
    };
    const summary = summarizeMatchShots(shots);
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.home.xg_openplay).toBeCloseTo(0.20, 3);
    expect(summary.home.xg_setpiece).toBe(0);
  });
});
