import { describe, it, expect } from "vitest";
import {
  computeEngineProbs,
  classifyEdgeSource,
} from "@/lib/goldilocks-engine";
import type { RawMatch } from "@/types/match";

// ─── Fixtures ──────────────────────────────────────────────────────

const validHistory = Array.from({ length: 8 }, (_, i) => ({
  opponent: `Opp${i}`,
  venue: "home" as const,
  xg: 1.5,
  xga: 1.0,
  goals_for: 2,
  goals_against: 1,
  match_date: `2025-01-${String(i + 1).padStart(2, "0")}`,
}));

const makeMatch = (overrides: Partial<RawMatch["home"]> = {}): RawMatch => ({
  home: {
    name: "Bayern München",
    xg_h8: 16,       // 2.0/game
    xga_h8: 8,       // 1.0/game
    games: 8,
    form: "W W W D L",
    xg_h_history: validHistory as any,
    ...overrides,
  },
  away: {
    name: "Dortmund",
    xg_a8: 10,       // 1.25/game
    xga_a8: 12,      // 1.5/game
    games: 8,
    form: "W L W W D",
    xg_a_history: validHistory.map(h => ({ ...h, venue: "away" as const })) as any,
  },
  kickoff: "2025-02-15 18:30",
  tags: [],
});

// ─── computeEngineProbs ──────────────────────────────────────────

describe("computeEngineProbs", () => {
  it("returns valid probs for a fully-populated match", () => {
    const result = computeEngineProbs({
      match: makeMatch(),
      league: "bundesliga",
      leagueAvg: 1.38,
      leagueHf: 1.28,
    });
    expect(result).not.toBeNull();
    expect(result!.h + result!.d + result!.a).toBeCloseTo(1, 2);
    expect(result!.h).toBeGreaterThan(0);
    expect(result!.h).toBeLessThan(1);
    expect(result!.o25).toBeGreaterThan(0);
    expect(result!.o25).toBeLessThan(1);
    expect(result!.o25 + result!.u25).toBeCloseTo(1, 5);
  });

  it("stronger home team has higher H probability", () => {
    // Bayern (2.0 xG/game, concedes 1.0) at home vs weak away team (0.8 xG,
    // concedes 2.0) should push H well above market default 0.45.
    const strongMatch = makeMatch();
    strongMatch.away = {
      ...strongMatch.away!,
      xg_a8: 6.4,    // 0.8/game
      xga_a8: 16,    // 2.0/game
    };
    const result = computeEngineProbs({
      match: strongMatch,
      league: "bundesliga",
      leagueAvg: 1.38,
      leagueHf: 1.28,
    });
    expect(result).not.toBeNull();
    expect(result!.h).toBeGreaterThan(result!.a);
    expect(result!.h).toBeGreaterThan(0.5);
  });

  it("returns null when home has no xg_h8 summary", () => {
    const match = makeMatch({ xg_h8: 0 as any });
    const result = computeEngineProbs({
      match,
      league: "bundesliga",
      leagueAvg: 1.38,
      leagueHf: 1.28,
    });
    expect(result).toBeNull();
  });

  it("returns null when away has no xg_a8 summary", () => {
    const match = makeMatch();
    match.away!.xg_a8 = undefined as any;
    const result = computeEngineProbs({
      match,
      league: "bundesliga",
      leagueAvg: 1.38,
      leagueHf: 1.28,
    });
    expect(result).toBeNull();
  });

  it("returns null when home team name is missing", () => {
    const match = makeMatch();
    match.home!.name = "";
    const result = computeEngineProbs({
      match,
      league: "bundesliga",
      leagueAvg: 1.38,
      leagueHf: 1.28,
    });
    expect(result).toBeNull();
  });

  it("does NOT mutate the input match", () => {
    const match = makeMatch();
    const beforeXg = match.home!.xg_h8;
    const beforeHist = match.home!.xg_h_history?.length;
    computeEngineProbs({
      match,
      league: "bundesliga",
      leagueAvg: 1.38,
      leagueHf: 1.28,
    });
    expect(match.home!.xg_h8).toBe(beforeXg);
    expect(match.home!.xg_h_history?.length).toBe(beforeHist);
  });

  it("works without per-match history (xg_h8 summaries only)", () => {
    // League-avg fallback path: no history, only the synthesised summaries
    const match = makeMatch();
    match.home!.xg_h_history = [];
    match.away!.xg_a_history = [];
    const result = computeEngineProbs({
      match,
      league: "bundesliga",
      leagueAvg: 1.38,
      leagueHf: 1.28,
    });
    // Should still produce valid probs — calcMatchEnhanced falls back to
    // the xg_h8/hGames ratio when history is empty.
    expect(result).not.toBeNull();
    expect(result!.h + result!.d + result!.a).toBeCloseTo(1, 2);
  });
});

// ─── classifyEdgeSource ──────────────────────────────────────────

describe("classifyEdgeSource", () => {
  it("returns 'consensus' when both sources agree", () => {
    expect(classifyEdgeSource(true, true)).toBe("consensus");
  });

  it("returns 'market' when only market detects edge", () => {
    expect(classifyEdgeSource(true, false)).toBe("market");
  });

  it("returns 'engine' when only engine detects edge", () => {
    expect(classifyEdgeSource(false, true)).toBe("engine");
  });

  it("returns null when neither detects edge", () => {
    expect(classifyEdgeSource(false, false)).toBeNull();
  });
});
