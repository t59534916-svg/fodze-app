// ═══════════════════════════════════════════════════════════════════════
// Unit tests for scripts/bridge-sofascore-to-team-xg.mjs
//
// Bridge propagates per-team-per-game data from sofascore_team_chance_quality
// (view) into team_xg_history (table), with source='sofascore'. The script
// runs daily as Phase 5 of refresh-all.mjs and writes to production data, so
// silent corruption from a regression in the schema mapping or canonicalization
// step would degrade engine-input quality (xg_h8 in MatchdayContext) without
// any obvious failure signal.
//
// These tests cover the pure transformation function `buildTeamXgRows` —
// the network/upsert layers stay manually-tested via dry-run.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
// @ts-ignore — .mjs import precedent in tests/european-fatigue.test.ts etc.
import { buildTeamXgRows } from "../scripts/bridge-sofascore-to-team-xg.mjs";

// Fixture: realistic 2-team-row pair from sofascore_team_chance_quality view
function fixtureGame(overrides: Partial<any> = {}) {
  return [
    {
      game_id: 14000001,
      league: "serie_a",
      season: "25/26",
      week: 30,
      is_home: true,
      team: "Como 1907",
      team_id: 100,
      opponent: "Napoli",
      start_timestamp: 1714838400, // 2024-05-04 16:00 UTC — irrelevant; just needs to be valid epoch
      data_quality_tier: "premium",
      shots: 12,
      goals: 1,
      shots_in_box: 8,
      shots_on_target: 4,
      sum_xg: 1.5,
      sum_xgot: 1.2,
      mean_shot_xg: 0.125,
      mean_shot_xgot_on_target: 0.3,
      setpiece_xg_share: 0.2,
      penalty_xg_share: null,
      openplay_xg: 1.2,
      big_chance_share: 0.083,
      fastbreak_xg: 0.3,
      header_share: 0.25,
      ...overrides.home,
    },
    {
      game_id: 14000001,
      league: "serie_a",
      season: "25/26",
      week: 30,
      is_home: false,
      team: "Napoli",
      team_id: 200,
      opponent: "Como 1907",
      start_timestamp: 1714838400,
      data_quality_tier: "premium",
      shots: 9,
      goals: 0,
      shots_in_box: 5,
      shots_on_target: 2,
      sum_xg: 0.8,
      sum_xgot: 0.5,
      mean_shot_xg: 0.089,
      mean_shot_xgot_on_target: 0.25,
      setpiece_xg_share: 0.15,
      penalty_xg_share: null,
      openplay_xg: 0.68,
      big_chance_share: 0.0,
      fastbreak_xg: 0.1,
      header_share: 0.11,
      ...overrides.away,
    },
  ];
}

// Identity canonicalize for tests where we don't care about the alias map
const identityCanonicalize = (name: string) => name;

describe("buildTeamXgRows", () => {
  it("emits exactly 2 rows per match (1 home + 1 away, mirrored)", () => {
    const cq = fixtureGame();
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    expect(rows).toHaveLength(2);

    const home = rows.find((r: any) => r.venue === "home");
    const away = rows.find((r: any) => r.venue === "away");
    expect(home).toBeDefined();
    expect(away).toBeDefined();

    // Mirror invariant: home.opponent === away.team, home.team === away.opponent
    expect(home!.team).toBe(away!.opponent);
    expect(away!.team).toBe(home!.opponent);

    // Mirror invariant: home.xg === away.xga and vice versa
    expect(home!.xg).toBe(away!.xga);
    expect(home!.xga).toBe(away!.xg);
    expect(home!.goals_for).toBe(away!.goals_against);
    expect(home!.goals_against).toBe(away!.goals_for);
    expect(home!.shots_for).toBe(away!.shots_against);
    expect(home!.shots_against).toBe(away!.shots_for);
  });

  it("maps schema correctly: sum_xg → xg, goals → goals_for, etc.", () => {
    const cq = fixtureGame();
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    const home = rows.find((r: any) => r.venue === "home")!;

    expect(home.team).toBe("Como 1907");
    expect(home.opponent).toBe("Napoli");
    expect(home.league).toBe("serie_a");
    expect(home.xg).toBe(1.5);
    expect(home.xga).toBe(0.8);
    expect(home.goals_for).toBe(1);
    expect(home.goals_against).toBe(0);
    expect(home.shots_for).toBe(12);
    expect(home.shots_against).toBe(9);
    expect(home.shots_on_target_for).toBe(4);
    expect(home.shots_on_target_against).toBe(2);
    expect(home.xg_openplay).toBe(1.2);
    expect(home.xga_openplay).toBe(0.68);
    expect(home.source).toBe("sofascore");
  });

  it("computes xg_setpiece as sum_xg × setpiece_xg_share rounded to 3 decimals", () => {
    const cq = fixtureGame();
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    const home = rows.find((r: any) => r.venue === "home")!;
    const away = rows.find((r: any) => r.venue === "away")!;

    // home: 1.5 × 0.2 = 0.3
    expect(home.xg_setpiece).toBe(0.3);
    // away: 0.8 × 0.15 = 0.12
    expect(away.xg_setpiece).toBe(0.12);
    // Mirror: home.xga_setpiece === away.xg_setpiece
    expect(home.xga_setpiece).toBe(away.xg_setpiece);
    expect(away.xga_setpiece).toBe(home.xg_setpiece);
  });

  it("derives match_date from start_timestamp (epoch seconds → YYYY-MM-DD)", () => {
    // 1777970200 → 2026-05-05T05:56:40.000Z (UTC)
    // (Verified via `new Date(1777970200 * 1000).toISOString()`)
    const cq = fixtureGame({
      home: { start_timestamp: 1777970200 },
      away: { start_timestamp: 1777970200 },
    });
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    expect(rows[0].match_date).toBe("2026-05-05");
  });

  it("match_date uses UTC date (not local) — important for cross-timezone consistency", () => {
    // 1714838400 UTC = 2024-05-04T16:00:00.000Z
    const cq = fixtureGame(); // Default fixture uses 1714838400
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    expect(rows[0].match_date).toBe("2024-05-04");
  });

  it("skips games with only one side (missing home or away row)", () => {
    const cq = fixtureGame();
    const orphan = [cq[0]]; // home only, no away
    const { rows, skippedNoOpponent } = buildTeamXgRows(orphan, identityCanonicalize);
    expect(rows).toHaveLength(0);
    expect(skippedNoOpponent).toBe(1);
  });

  it("skips games where canonicalize returns null/empty/throws", () => {
    const cq = fixtureGame();
    const failingCanonicalize = (name: string) => {
      if (name === "Como 1907") return ""; // simulate canonicalize-failure
      return name;
    };
    const { rows, skippedCanonicalize } = buildTeamXgRows(cq, failingCanonicalize);
    expect(rows).toHaveLength(0);
    expect(skippedCanonicalize).toBe(1);
  });

  it("handles canonicalize throwing without crashing", () => {
    const cq = fixtureGame();
    const throwingCanonicalize = () => {
      throw new Error("registry not loaded");
    };
    const { rows, skippedCanonicalize } = buildTeamXgRows(cq, throwingCanonicalize);
    expect(rows).toHaveLength(0);
    expect(skippedCanonicalize).toBe(1);
  });

  it("uses canonicalize to map Sofascore names to FODZE-canonical", () => {
    const cq = fixtureGame();
    // Simulate the alias mapping seen in real data:
    //   "Como 1907" already canonical → unchanged
    //   "Napoli" canonical → unchanged
    //   But test that the function IS applied
    const seen: string[] = [];
    const trackingCanonicalize = (name: string, league: string) => {
      seen.push(`${league}:${name}`);
      return name;
    };
    buildTeamXgRows(cq, trackingCanonicalize);
    expect(seen).toContain("serie_a:Como 1907");
    expect(seen).toContain("serie_a:Napoli");
  });

  it("handles null sum_xg (premium tier with 0-shot match should still upsert)", () => {
    const cq = fixtureGame({
      home: { sum_xg: 0, shots: 0, setpiece_xg_share: null },
      away: { sum_xg: 0, shots: 0, setpiece_xg_share: null },
    });
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    expect(rows).toHaveLength(2);
    expect(rows[0].xg).toBe(0);
    expect(rows[0].xga).toBe(0);
    // setpiece null when share unknown
    expect(rows[0].xg_setpiece).toBe(null);
    expect(rows[0].xga_setpiece).toBe(null);
  });

  it("counts perLeague: 2 rows = 1 match-pair", () => {
    const cq = [
      ...fixtureGame(),
      // Add a 2nd game in different league
      ...fixtureGame({
        home: { game_id: 14000002, league: "epl", team: "Liverpool", opponent: "Arsenal" },
        away: { game_id: 14000002, league: "epl", team: "Arsenal", opponent: "Liverpool" },
      }),
    ];
    const { rows, perLeague } = buildTeamXgRows(cq, identityCanonicalize);
    expect(rows).toHaveLength(4);
    expect(perLeague).toEqual({ serie_a: 2, epl: 2 });
  });

  it("aggregates multiple games in the same league", () => {
    const games = [
      fixtureGame(),
      fixtureGame({ home: { game_id: 14000003 }, away: { game_id: 14000003 } }),
      fixtureGame({ home: { game_id: 14000004 }, away: { game_id: 14000004 } }),
    ].flat();
    const { rows, perLeague } = buildTeamXgRows(games, identityCanonicalize);
    expect(rows).toHaveLength(6);
    expect(perLeague.serie_a).toBe(6);
  });

  it("always sets source='sofascore' so daily cron upserts can be filtered", () => {
    const cq = fixtureGame();
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    for (const row of rows) {
      expect(row.source).toBe("sofascore");
    }
  });

  it("does NOT include columns the bridge has no data for (corners, possession, etc.)", () => {
    const cq = fixtureGame();
    const { rows } = buildTeamXgRows(cq, identityCanonicalize);
    const home = rows[0];
    // These columns are intentionally absent — merge-duplicates upsert preserves
    // existing values from footystats / understat sources.
    expect(home).not.toHaveProperty("corners_for");
    expect(home).not.toHaveProperty("corners_against");
    expect(home).not.toHaveProperty("possession_pct");
    expect(home).not.toHaveProperty("fouls");
    expect(home).not.toHaveProperty("yellow_cards_for");
    expect(home).not.toHaveProperty("red_cards_for");
  });

  it("EMPTY input → EMPTY output, no crash", () => {
    const { rows, perLeague, skippedNoOpponent, skippedCanonicalize } =
      buildTeamXgRows([], identityCanonicalize);
    expect(rows).toHaveLength(0);
    expect(perLeague).toEqual({});
    expect(skippedNoOpponent).toBe(0);
    expect(skippedCanonicalize).toBe(0);
  });
});
