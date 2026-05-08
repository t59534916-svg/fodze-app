// ═══════════════════════════════════════════════════════════════════════
// Unit tests for scripts/bridge-sofascore-extras-to-team-xg.mjs
//
// This bridge propagates ~18 extras columns (possession, big_chances,
// passes, tackles, errors, duels, dribbles, fouls/cards, goals_prevented)
// from sofascore_team_match_stats VIEW into team_xg_history TABLE.
//
// CRITICAL contracts under test:
//   1. PRESERVES the xg/goals/shots columns of the original bridge
//      (we must NOT include them in our output rows — they're the
//      primary bridge's domain. Including them risks race overwrites).
//   2. Conflict-key columns (team, league, match_date, venue) MUST be
//      present so PostgREST upsert can merge rather than insert-and-fail.
//   3. canonicalize() failures must skip the row, not crash.
//   4. Missing match_pair (only home or only away row) → skipped.
//   5. Per-league counts in summary match expectations.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
// @ts-ignore — .mjs import precedent (matches tests/bridge-sofascore.test.ts)
import { buildTeamXgExtrasRows } from "../scripts/bridge-sofascore-extras-to-team-xg.mjs";

// Realistic 2-team-row pair from sofascore_team_match_stats view
function fixtureGame(overrides: Partial<{ home: any; away: any }> = {}) {
  const homeBase = {
    game_id: 14065246,
    league: "bundesliga",
    season: "25/26",
    week: 30,
    is_home: true,
    team: "FC St. Pauli",
    team_id: 2526,
    opponent: "1. FSV Mainz 05",
    start_timestamp: 1777824000, // 2026-05-03 16:00 UTC — sample BL kickoff
    data_quality_tier: "premium",
    // The 18 extras
    ball_possession_pct: 52.0,
    big_chances: 3,
    big_chances_missed: 2,
    passes_total: 494,
    passes_accurate: 413,
    pass_accuracy_pct: 83.6,
    tackles_total: 15,
    tackles_won: 12,
    errors_lead_to_shot: 1,
    errors_lead_to_goal: 1,
    ground_duels_won: 28,
    ground_duels_total: 60,
    aerial_duels_won: 18,
    aerial_duels_total: 41,
    dribbles_won: 6,
    dribbles_attempted: 13,
    fouls: 10,
    yellow_cards: 3,
    red_cards: 0,
    goals_prevented: -0.05,
    // Bonus cols the view exposes but we don't write
    expected_goals: 0.84,
    total_shots: 10,
  };
  const awayBase = {
    ...homeBase,
    is_home: false,
    team: "1. FSV Mainz 05",
    team_id: 1,
    opponent: "FC St. Pauli",
    ball_possession_pct: 48.0,
    big_chances: 5,
    big_chances_missed: 3,
    passes_total: 465,
    passes_accurate: 379,
    pass_accuracy_pct: 81.5,
    tackles_total: 15,
    tackles_won: 10,
    errors_lead_to_shot: 0,
    errors_lead_to_goal: 0,
    ground_duels_won: 32,
    ground_duels_total: 60,
    aerial_duels_won: 23,
    aerial_duels_total: 41,
    dribbles_won: 7,
    dribbles_attempted: 14,
    fouls: 8,
    yellow_cards: 1,
    red_cards: 0,
    goals_prevented: -0.65,
    expected_goals: 2.54,
    total_shots: 17,
  };
  return [
    { ...homeBase, ...(overrides.home || {}) },
    { ...awayBase, ...(overrides.away || {}) },
  ];
}

const identityCanonicalize = (name: string) => name;

describe("buildTeamXgExtrasRows — happy path", () => {
  it("emits 2 rows per game (home + away) with all extras populated", () => {
    const tms = fixtureGame();
    const { rows, perLeague } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    expect(rows).toHaveLength(2);
    expect(perLeague.bundesliga).toBe(2);

    const home = rows.find((r) => r.venue === "home")!;
    const away = rows.find((r) => r.venue === "away")!;

    expect(home.team).toBe("FC St. Pauli");
    expect(home.ball_possession_pct).toBe(52.0);
    expect(home.big_chances).toBe(3);
    expect(home.passes_total).toBe(494);
    expect(home.tackles_won).toBe(12);
    expect(home.errors_lead_to_goal).toBe(1);
    expect(home.goals_prevented).toBe(-0.05);

    expect(away.team).toBe("1. FSV Mainz 05");
    expect(away.ball_possession_pct).toBe(48.0);
    expect(away.big_chances).toBe(5);
    expect(away.yellow_cards).toBe(1);
  });

  it("translates start_timestamp (epoch seconds) to YYYY-MM-DD match_date", () => {
    const tms = fixtureGame();
    const { rows } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    expect(rows[0].match_date).toBe("2026-05-03");
    expect(rows[1].match_date).toBe("2026-05-03");
  });

  it("includes all conflict-key columns (team, league, match_date, venue)", () => {
    const tms = fixtureGame();
    const { rows } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    for (const row of rows) {
      expect(row).toHaveProperty("team");
      expect(row).toHaveProperty("league");
      expect(row).toHaveProperty("match_date");
      expect(row).toHaveProperty("venue");
      expect(["home", "away"]).toContain(row.venue);
    }
  });
});

describe("buildTeamXgExtrasRows — guarantees we don't step on primary bridge", () => {
  // The primary sofascore bridge OWNS xg, xga, goals_for/_against, shots_*
  // Including them here would race-overwrite. This test locks down the contract.
  it("does NOT emit xg / xga / goals_for / goals_against / shots_for / shots_against / source", () => {
    const tms = fixtureGame();
    const { rows } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    for (const row of rows) {
      expect(row).not.toHaveProperty("xg");
      expect(row).not.toHaveProperty("xga");
      expect(row).not.toHaveProperty("goals_for");
      expect(row).not.toHaveProperty("goals_against");
      expect(row).not.toHaveProperty("shots_for");
      expect(row).not.toHaveProperty("shots_against");
      expect(row).not.toHaveProperty("shots_on_target_for");
      expect(row).not.toHaveProperty("shots_on_target_against");
      // Don't write source — primary bridge already sets it to 'sofascore'
      expect(row).not.toHaveProperty("source");
      // Don't write opponent — that's also the primary bridge's column;
      // the conflict-key uses (team, league, match_date, venue), not opponent
      expect(row).not.toHaveProperty("opponent");
    }
  });
});

describe("buildTeamXgExtrasRows — edge cases", () => {
  it("skips a game when only the home row is present (no opponent)", () => {
    const tms = [fixtureGame()[0]]; // only home
    const { rows, skippedNoOpponent } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    expect(rows).toHaveLength(0);
    expect(skippedNoOpponent).toBe(1);
  });

  it("skips when start_timestamp is missing (can't compute match_date)", () => {
    const tms = fixtureGame({
      home: { start_timestamp: null },
      away: { start_timestamp: null },
    });
    const { rows, skippedNoOpponent } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    expect(rows).toHaveLength(0);
    expect(skippedNoOpponent).toBe(1);
  });

  it("handles canonicalize returning null (alias-not-found scenario)", () => {
    const tms = fixtureGame();
    const nullCanonicalize = () => null;
    const { rows, skippedCanonicalize } = buildTeamXgExtrasRows(tms, nullCanonicalize as any);
    expect(rows).toHaveLength(0);
    expect(skippedCanonicalize).toBe(1);
  });

  it("handles canonicalize throwing without crashing", () => {
    const tms = fixtureGame();
    const throwingCanonicalize = () => {
      throw new Error("registry not loaded");
    };
    const { rows, skippedCanonicalize } = buildTeamXgExtrasRows(tms, throwingCanonicalize);
    expect(rows).toHaveLength(0);
    expect(skippedCanonicalize).toBe(1);
  });

  it("uses canonicalize to map Sofascore names to FODZE-canonical", () => {
    const tms = fixtureGame();
    const seen: string[] = [];
    const trackingCanonicalize = (name: string, league: string) => {
      seen.push(`${league}:${name}`);
      return name;
    };
    buildTeamXgExtrasRows(tms, trackingCanonicalize);
    expect(seen).toContain("bundesliga:FC St. Pauli");
    expect(seen).toContain("bundesliga:1. FSV Mainz 05");
  });

  it("propagates null when a stat is missing from the view (e.g. goalkeeper_saves on a 0-save match)", () => {
    const tms = fixtureGame({
      home: { goals_prevented: null, errors_lead_to_shot: null },
      away: { goals_prevented: null, errors_lead_to_shot: null },
    });
    const { rows } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    expect(rows[0].goals_prevented).toBe(null);
    expect(rows[0].errors_lead_to_shot).toBe(null);
  });

  it("handles a stat being undefined (not set) by mapping to null, not undefined", () => {
    // Real Sofascore JSON sometimes omits keys entirely rather than sending null.
    // Postgres will reject undefined; we must send null.
    const homeMissing: any = { ...fixtureGame()[0] };
    delete homeMissing.big_chances_missed;
    delete homeMissing.dribbles_won;
    const tms = [homeMissing, fixtureGame()[1]];
    const { rows } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    const home = rows.find((r) => r.venue === "home")!;
    expect(home.big_chances_missed).toBe(null);
    expect(home.dribbles_won).toBe(null);
    // Ensure no 'undefined' values leak into the output
    for (const v of Object.values(home)) {
      expect(v).not.toBe(undefined);
    }
  });
});

describe("buildTeamXgExtrasRows — multi-game / multi-league", () => {
  it("counts perLeague: 2 rows = 1 match-pair", () => {
    const tms = [
      ...fixtureGame(),
      ...fixtureGame({
        home: { game_id: 14000002, league: "epl", team: "Liverpool", opponent: "Arsenal" },
        away: { game_id: 14000002, league: "epl", team: "Arsenal", opponent: "Liverpool" },
      }),
    ];
    const { rows, perLeague } = buildTeamXgExtrasRows(tms, identityCanonicalize);
    expect(rows).toHaveLength(4);
    expect(perLeague).toEqual({ bundesliga: 2, epl: 2 });
  });

  it("aggregates multiple games in the same league", () => {
    const games = [
      fixtureGame(),
      fixtureGame({ home: { game_id: 14000003 }, away: { game_id: 14000003 } }),
      fixtureGame({ home: { game_id: 14000004 }, away: { game_id: 14000004 } }),
    ].flat();
    const { rows, perLeague } = buildTeamXgExtrasRows(games, identityCanonicalize);
    expect(rows).toHaveLength(6);
    expect(perLeague.bundesliga).toBe(6);
  });
});
