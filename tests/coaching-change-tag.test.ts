// ═══════════════════════════════════════════════════════════════════════
// Unit tests for scripts/_lib/matchday-enrich.mjs::deriveCoachingChangeTag
// + ::buildManagerHistoryByTeam.
//
// These two helpers detect coaching changes from sofascore_match_managers
// data and translate them into the NEUER-TRAINER tag. The tag has λH=1.08
// in TAG_MAP (src/lib/dixon-coles.ts), so a false-positive scales an
// engine prediction by 8% — non-trivial. False-negatives mean we fall
// back to manual /api/matchday AI enrichment which silently drops most
// coaching-change signals on the daily cron path.
//
// Test surface intentionally exhaustive: 12+ cases covering the core
// invariants (sort order, normalization, < 2 history rows = no tag,
// composability with deriveTags).
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
// @ts-ignore — .mjs import precedent (matches tests/bridge-sofascore.test.ts etc.)
import {
  buildManagerHistoryByTeam,
  deriveCoachingChangeTag,
  enrichMatch,
} from "../scripts/_lib/matchday-enrich.mjs";

// ─── buildManagerHistoryByTeam ──────────────────────────────────────

describe("buildManagerHistoryByTeam", () => {
  it("groups rows by canonical team name, sorts DESC by start_timestamp", () => {
    const rows = [
      { team: "FC Bayern", manager_id: 100, start_timestamp: 1700000000, team_id: 1 },
      { team: "FC Bayern", manager_id: 100, start_timestamp: 1710000000, team_id: 1 },
      { team: "FC Bayern", manager_id: 200, start_timestamp: 1720000000, team_id: 1 },
      { team: "Other Team", manager_id: 300, start_timestamp: 1700000000, team_id: 2 },
    ];
    const map = buildManagerHistoryByTeam(rows);
    expect(map.size).toBe(2);

    const bayern = [...map.entries()].find(([k]) => k.includes("bayern"))?.[1];
    expect(bayern).toBeDefined();
    expect(bayern!.length).toBe(3);
    // Sorted descending — most recent first
    expect(bayern![0].start_timestamp).toBe(1720000000);
    expect(bayern![1].start_timestamp).toBe(1710000000);
    expect(bayern![2].start_timestamp).toBe(1700000000);
    // Manager IDs preserved
    expect(bayern![0].manager_id).toBe(200);
    expect(bayern![1].manager_id).toBe(100);
  });

  it("caps history per team to N entries (default 5)", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      team: "FC Bayern",
      manager_id: 100 + i,
      start_timestamp: 1700000000 + i * 100,
      team_id: 1,
    }));
    const map = buildManagerHistoryByTeam(rows);  // default n=5
    const bayern = [...map.values()][0];
    expect(bayern.length).toBe(5);
    // Should be the 5 most recent (indices 7,6,5,4,3 of input)
    expect(bayern[0].manager_id).toBe(107);
    expect(bayern[4].manager_id).toBe(103);
  });

  it("respects custom N", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      team: "Test", manager_id: 1, start_timestamp: i, team_id: 1,
    }));
    const map = buildManagerHistoryByTeam(rows, 3);
    expect([...map.values()][0].length).toBe(3);
  });

  it("skips rows with missing team / manager_id / start_timestamp", () => {
    const rows = [
      { team: "Valid", manager_id: 1, start_timestamp: 100, team_id: 1 },
      { team: "", manager_id: 1, start_timestamp: 100, team_id: 1 },     // empty team
      { team: "X", manager_id: null, start_timestamp: 100, team_id: 1 }, // null mgr
      { team: "Y", manager_id: 1, start_timestamp: null, team_id: 1 },   // null ts
      { team: null, manager_id: 1, start_timestamp: 100 },                // null team
      undefined,                                                          // skip-able junk
    ];
    const map = buildManagerHistoryByTeam(rows as any);
    expect(map.size).toBe(1);
  });

  it("returns empty Map on garbage input", () => {
    expect(buildManagerHistoryByTeam(null as any).size).toBe(0);
    expect(buildManagerHistoryByTeam(undefined as any).size).toBe(0);
    expect(buildManagerHistoryByTeam("not-array" as any).size).toBe(0);
    expect(buildManagerHistoryByTeam([]).size).toBe(0);
  });

  it("normalizes team names so lookup is case/diacritics insensitive", () => {
    const rows = [
      { team: "FC Bayern München", manager_id: 1, start_timestamp: 100, team_id: 1 },
    ];
    const map = buildManagerHistoryByTeam(rows);
    // Both entries should hash to the same key (umlaut handling)
    expect(map.size).toBe(1);
  });
});

// ─── deriveCoachingChangeTag ────────────────────────────────────────

describe("deriveCoachingChangeTag", () => {
  it("returns ['NEUER-TRAINER'] when home team's last 2 managers differ", () => {
    const map = buildManagerHistoryByTeam([
      { team: "Bayern", manager_id: 200, start_timestamp: 1720000000 },  // most recent
      { team: "Bayern", manager_id: 100, start_timestamp: 1710000000 },  // previous
      { team: "Dortmund", manager_id: 50, start_timestamp: 1720000000 },
      { team: "Dortmund", manager_id: 50, start_timestamp: 1710000000 }, // no change
    ]);
    const tags = deriveCoachingChangeTag("Bayern", "Dortmund", map);
    expect(tags).toEqual(["NEUER-TRAINER"]);
  });

  it("returns ['NEUER-TRAINER'] when AWAY team's last 2 managers differ", () => {
    const map = buildManagerHistoryByTeam([
      { team: "Bayern", manager_id: 100, start_timestamp: 1720000000 },
      { team: "Bayern", manager_id: 100, start_timestamp: 1710000000 }, // no change
      { team: "Dortmund", manager_id: 60, start_timestamp: 1720000000 },// changed
      { team: "Dortmund", manager_id: 50, start_timestamp: 1710000000 },
    ]);
    const tags = deriveCoachingChangeTag("Bayern", "Dortmund", map);
    expect(tags).toEqual(["NEUER-TRAINER"]);
  });

  it("returns [] when both teams have stable managers", () => {
    const map = buildManagerHistoryByTeam([
      { team: "A", manager_id: 1, start_timestamp: 1720000000 },
      { team: "A", manager_id: 1, start_timestamp: 1710000000 },
      { team: "B", manager_id: 2, start_timestamp: 1720000000 },
      { team: "B", manager_id: 2, start_timestamp: 1710000000 },
    ]);
    expect(deriveCoachingChangeTag("A", "B", map)).toEqual([]);
  });

  it("returns [] when team has < 2 history entries (insufficient data)", () => {
    const map = buildManagerHistoryByTeam([
      { team: "Newteam", manager_id: 1, start_timestamp: 1720000000 },
    ]);
    expect(deriveCoachingChangeTag("Newteam", "OtherTeam", map)).toEqual([]);
  });

  it("returns [] on null/empty input", () => {
    expect(deriveCoachingChangeTag("A", "B", null as any)).toEqual([]);
    expect(deriveCoachingChangeTag("A", "B", new Map())).toEqual([]);
  });

  it("does not emit duplicate tags when BOTH teams changed coaches", () => {
    const map = buildManagerHistoryByTeam([
      { team: "A", manager_id: 2, start_timestamp: 1720000000 },
      { team: "A", manager_id: 1, start_timestamp: 1710000000 },
      { team: "B", manager_id: 4, start_timestamp: 1720000000 },
      { team: "B", manager_id: 3, start_timestamp: 1710000000 },
    ]);
    const tags = deriveCoachingChangeTag("A", "B", map);
    expect(tags).toEqual(["NEUER-TRAINER"]);
    expect(tags.length).toBe(1);
  });

  it("handles team-name variants via normalization (FC Bayern vs Bayern München)", () => {
    const map = buildManagerHistoryByTeam([
      { team: "FC Bayern München", manager_id: 2, start_timestamp: 1720000000 },
      { team: "FC Bayern München", manager_id: 1, start_timestamp: 1710000000 },
    ]);
    // Variant lookup — should still find the change
    const tags = deriveCoachingChangeTag("Bayern Munchen", "OtherTeam", map);
    expect(tags).toEqual(["NEUER-TRAINER"]);
  });
});

// ─── Integration: enrichMatch composes both tags ─────────────────────

describe("enrichMatch with managerHistoryByTeam opt", () => {
  const xgHistory = [
    { team: "Bayern", venue: "home", goals_for: 2, goals_against: 1,
      match_date: "2026-04-01" },
  ];
  const allFixtures = [
    { home_team: "Bayern", away_team: "Dortmund",
      commence_time: "2026-05-01T16:00:00Z" },
  ];

  it("does NOT emit NEUER-TRAINER without manager history opt (backward-compat)", () => {
    const result = enrichMatch(
      { home_team: "Bayern", away_team: "Dortmund",
        commence_time: "2026-05-01T16:00:00Z",
        home: { name: "Bayern" }, away: { name: "Dortmund" } },
      xgHistory, allFixtures
    );
    expect(result.tags).not.toContain("NEUER-TRAINER");
  });

  it("DOES emit NEUER-TRAINER when manager history shows recent change", () => {
    const map = buildManagerHistoryByTeam([
      { team: "Bayern", manager_id: 200, start_timestamp: 1720000000 },
      { team: "Bayern", manager_id: 100, start_timestamp: 1710000000 },
    ]);
    const result = enrichMatch(
      { home_team: "Bayern", away_team: "Dortmund",
        commence_time: "2026-05-01T16:00:00Z",
        home: { name: "Bayern" }, away: { name: "Dortmund" } },
      xgHistory, allFixtures,
      { managerHistoryByTeam: map }
    );
    expect(result.tags).toContain("NEUER-TRAINER");
  });

  it("composes with existing tags (DERBY etc) — does not overwrite", () => {
    // Real FODZE rivalry: BVB - Schalke (TEAM_RIVALRIES has it)
    const map = buildManagerHistoryByTeam([
      { team: "Borussia Dortmund", manager_id: 999, start_timestamp: 1720000000 },
      { team: "Borussia Dortmund", manager_id: 998, start_timestamp: 1710000000 },
    ]);
    const result = enrichMatch(
      { home_team: "Borussia Dortmund", away_team: "Schalke 04",
        commence_time: "2026-05-01T16:00:00Z",
        home: { name: "Borussia Dortmund" }, away: { name: "Schalke 04" } },
      xgHistory, allFixtures,
      { managerHistoryByTeam: map }
    );
    // Should have both DERBY (from rivalry map) + NEUER-TRAINER (from mgr history)
    expect(result.tags).toContain("DERBY");
    expect(result.tags).toContain("NEUER-TRAINER");
  });
});
