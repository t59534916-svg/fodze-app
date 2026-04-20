import { describe, it, expect } from "vitest";
import {
  inferGameState,
  computeMinutesPerState,
  aggregateXgByState,
  applyStateRatioPrior,
  STATE_RATIO_PRIOR,
} from "../scripts/_lib/game-state-xg.mjs";
import { fillStateXGWithPrior, STATE_RATIO_PRIOR as BROWSER_PRIOR } from "@/lib/supabase";
import { extractShotsData, summarizeMatchShots } from "../scripts/backfill-xg-by-state.mjs";

describe("inferGameState", () => {
  it("classifies from the home perspective", () => {
    expect(inferGameState("home", 0, 0)).toBe("level");
    expect(inferGameState("home", 1, 0)).toBe("leading");
    expect(inferGameState("home", 0, 1)).toBe("trailing");
    expect(inferGameState("home", 2, 2)).toBe("level");
  });

  it("inverts correctly from the away perspective", () => {
    expect(inferGameState("away", 0, 0)).toBe("level");
    expect(inferGameState("away", 1, 0)).toBe("trailing");
    expect(inferGameState("away", 0, 1)).toBe("leading");
  });
});

describe("computeMinutesPerState", () => {
  it("returns all level when no goals are scored", () => {
    const out = computeMinutesPerState("home", [], 90);
    expect(out).toEqual({ level: 90, leading: 0, trailing: 0 });
  });

  it("sums to matchLength for any sequence", () => {
    const events = [
      { minute: 30, scoringSide: "home" },
      { minute: 60, scoringSide: "away" },
      { minute: 80, scoringSide: "home" },
    ];
    const out = computeMinutesPerState("home", events, 90);
    expect(out.level + out.leading + out.trailing).toBe(90);
  });

  it("switches buckets after a decisive goal (home perspective)", () => {
    const events = [{ minute: 45, scoringSide: "home" }];
    const out = computeMinutesPerState("home", events, 90);
    // Minutes 1..45 level (goal-at-45 applies to m=46 and later),
    // minutes 46..90 leading → 45 level + 45 leading.
    expect(out.level).toBe(45);
    expect(out.leading).toBe(45);
    expect(out.trailing).toBe(0);
  });

  it("handles goal-exchange resulting in level finish", () => {
    const events = [
      { minute: 20, scoringSide: "home" },
      { minute: 70, scoringSide: "away" },
    ];
    const home = computeMinutesPerState("home", events, 90);
    // 1..20 level (20), 21..70 leading (50), 71..90 level (20) = 90
    expect(home).toEqual({ level: 40, leading: 50, trailing: 0 });
    const away = computeMinutesPerState("away", events, 90);
    expect(away).toEqual({ level: 40, leading: 0, trailing: 50 });
  });

  it("handles unsorted input deterministically", () => {
    const events = [
      { minute: 70, scoringSide: "away" },
      { minute: 20, scoringSide: "home" },
    ];
    const out = computeMinutesPerState("home", events, 90);
    expect(out).toEqual({ level: 40, leading: 50, trailing: 0 });
  });
});

describe("aggregateXgByState", () => {
  it("buckets a team's own shots (xg_*) by pre-shot score state", () => {
    const shots = [
      { minute: 10, xG: 0.12, shootingSide: "home", homeGoalsBefore: 0, awayGoalsBefore: 0 }, // level
      { minute: 40, xG: 0.30, shootingSide: "home", homeGoalsBefore: 1, awayGoalsBefore: 0 }, // leading
      { minute: 75, xG: 0.08, shootingSide: "home", homeGoalsBefore: 1, awayGoalsBefore: 2 }, // trailing
    ];
    const out = aggregateXgByState("home", shots);
    expect(out.xg_level).toBeCloseTo(0.12, 4);
    expect(out.xg_leading).toBeCloseTo(0.30, 4);
    expect(out.xg_trailing).toBeCloseTo(0.08, 4);
  });

  it("buckets opponent shots into xga_* from the team's perspective", () => {
    const shots = [
      { minute: 60, xG: 0.22, shootingSide: "away", homeGoalsBefore: 0, awayGoalsBefore: 0 }, // level (home view)
    ];
    const out = aggregateXgByState("home", shots);
    expect(out.xga_level).toBeCloseTo(0.22, 4);
    expect(out.xg_level).toBe(0);
  });

  it("inverts assignment when analysing the away team", () => {
    const shots = [
      { minute: 60, xG: 0.22, shootingSide: "away", homeGoalsBefore: 0, awayGoalsBefore: 0 }, // level (away view: their shot)
    ];
    const out = aggregateXgByState("away", shots);
    expect(out.xg_level).toBeCloseTo(0.22, 4);
    expect(out.xga_level).toBe(0);
  });

  it("skips non-finite or negative xG", () => {
    const shots = [
      { minute: 10, xG: NaN, shootingSide: "home", homeGoalsBefore: 0, awayGoalsBefore: 0 },
      { minute: 20, xG: -0.1, shootingSide: "home", homeGoalsBefore: 0, awayGoalsBefore: 0 },
    ];
    const out = aggregateXgByState("home", shots);
    expect(out.xg_level).toBe(0);
  });
});

describe("applyStateRatioPrior", () => {
  it("splits season total into 58/19/23", () => {
    const out = applyStateRatioPrior(10);
    expect(out.xg_level).toBeCloseTo(5.8, 3);
    expect(out.xg_leading).toBeCloseTo(1.9, 3);
    expect(out.xg_trailing).toBeCloseTo(2.3, 3);
    const sum = out.xg_level + out.xg_leading + out.xg_trailing;
    expect(sum).toBeCloseTo(10, 3);
  });

  it("returns zeros for 0, null, or NaN input", () => {
    expect(applyStateRatioPrior(0)).toEqual({ xg_level: 0, xg_leading: 0, xg_trailing: 0 });
    expect(applyStateRatioPrior(null)).toEqual({ xg_level: 0, xg_leading: 0, xg_trailing: 0 });
    expect(applyStateRatioPrior(NaN)).toEqual({ xg_level: 0, xg_leading: 0, xg_trailing: 0 });
  });
});

describe("fillStateXGWithPrior (browser runtime mirror)", () => {
  it("mirrors STATE_RATIO_PRIOR from game-state-xg.mjs", () => {
    expect(BROWSER_PRIOR.level).toBe(STATE_RATIO_PRIOR.level);
    expect(BROWSER_PRIOR.leading).toBe(STATE_RATIO_PRIOR.leading);
    expect(BROWSER_PRIOR.trailing).toBe(STATE_RATIO_PRIOR.trailing);
  });

  it("fills null state columns using the season totals", () => {
    const row: any = {
      team: "Bayern", opponent: "Dortmund", venue: "home", match_date: "2025-09-01",
      xg: 2.0, xga: 1.0,
      npxg: null, npxga: null, ppda_att: null, ppda_def: null, deep: null, deep_allowed: null,
      goals_for: 2, goals_against: 1,
      xg_while_level: null, xg_while_leading: null, xg_while_trailing: null,
      xga_while_level: null, xga_while_leading: null, xga_while_trailing: null,
      minutes_level: null, minutes_leading: null, minutes_trailing: null,
    };
    const filled = fillStateXGWithPrior(row);
    expect(filled.xg_while_level).toBeCloseTo(1.16, 3);   // 2.0 × 0.58
    expect(filled.xg_while_leading).toBeCloseTo(0.38, 3);
    expect(filled.xg_while_trailing).toBeCloseTo(0.46, 3);
    expect(filled.xga_while_level).toBeCloseTo(0.58, 3);
    expect(filled.minutes_level).toBe(52);
    expect(filled.minutes_leading).toBe(17);
  });

  it("preserves real values when columns are already populated", () => {
    const row: any = {
      team: "X", opponent: "Y", venue: "home", match_date: "2025-09-01",
      xg: 2.0, xga: 1.0, npxg: null, npxga: null,
      ppda_att: null, ppda_def: null, deep: null, deep_allowed: null,
      goals_for: 0, goals_against: 0,
      xg_while_level: 1.50,        // explicit real value
      xg_while_leading: 0.30,
      xg_while_trailing: 0.20,
      xga_while_level: 0.40,
      xga_while_leading: 0.15,
      xga_while_trailing: 0.45,
      minutes_level: 60, minutes_leading: 20, minutes_trailing: 10,
    };
    const filled = fillStateXGWithPrior(row);
    expect(filled.xg_while_level).toBe(1.50);   // unchanged
    expect(filled.minutes_level).toBe(60);       // unchanged
  });
});

describe("extractShotsData + summarizeMatchShots (end-to-end)", () => {
  it("returns null when HTML doesn't contain shotsData", () => {
    expect(extractShotsData("<html><body>no data</body></html>")).toBeNull();
  });

  it("roundtrips a minimal shotsData blob", () => {
    // Build a fake Understat-style HTML with JSON.parse-escaped shotsData.
    const fakeShots = {
      h: [{ minute: "10", xG: "0.15", result: "Goal", h_a: "h", h_team: "Bayern", a_team: "Dortmund", date: "2025-09-01 18:30:00" }],
      a: [{ minute: "40", xG: "0.22", result: "MissedShots", h_a: "a", h_team: "Bayern", a_team: "Dortmund", date: "2025-09-01 18:30:00" }],
    };
    // Understat escapes { → \x7B, " → \x22 etc.; we emit plain quote escapes
    // here which extractShotsData also handles via its \\" replacement step.
    const escaped = JSON.stringify(fakeShots).replace(/"/g, '\\"');
    const html = `<script>var shotsData = JSON.parse('${escaped}');</script>`;
    const parsed = extractShotsData(html);
    expect(parsed).not.toBeNull();
    expect(parsed.h).toHaveLength(1);
    expect(parsed.h[0].result).toBe("Goal");

    const summary = summarizeMatchShots(parsed);
    expect(summary).not.toBeNull();
    if (!summary) return; // type-narrow for TS (runtime: guaranteed by expect above)
    expect(summary.home_team).toBe("Bayern");
    expect(summary.away_team).toBe("Dortmund");
    expect(summary.match_date).toBe("2025-09-01");
    // Home's goal at min 10 → home.xg_level covers it (pre-shot 0-0).
    expect(summary.home.xg_while_level).toBeCloseTo(0.15, 3);
    // Away's shot at min 40 happens while they're trailing (0-1 home).
    expect(summary.away.xg_while_trailing).toBeCloseTo(0.22, 3);
    // Minute totals should sum to 90.
    const homeTotal = summary.home.minutes_level + summary.home.minutes_leading + summary.home.minutes_trailing;
    expect(homeTotal).toBe(90);
  });

  it("returns null when shotsData has no shots", () => {
    expect(summarizeMatchShots({ h: [], a: [] })).toBeNull();
    expect(summarizeMatchShots(null)).toBeNull();
  });
});
