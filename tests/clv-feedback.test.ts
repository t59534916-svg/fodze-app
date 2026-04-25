import { describe, it, expect } from "vitest";
import {
  CLV_FEEDBACK_WINDOW,
  CLV_FEEDBACK_MULTIPLIER,
  extractLeagueFromMatchKey,
  computeLeagueKellyMultiplier,
  computeLeagueCLVBreakdown,
} from "@/lib/clv-feedback";
import type { PlacedBet } from "@/types/match";

// Test fixture builder. Defaults make a settled won bet at clv=0.
function bet(p: Partial<PlacedBet> = {}): PlacedBet {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    match_key: p.match_key ?? "epl:Arsenal-Chelsea",
    home_team: "Arsenal",
    away_team: "Chelsea",
    market: "H",
    odds_placed: 2.0,
    stake: 10,
    result: p.result ?? "won",
    settled_at: p.settled_at ?? "2026-04-01T12:00:00Z",
    placed_at: p.placed_at ?? "2026-04-01T11:00:00Z",
    clv: p.clv,
    created_by: "user",
    ...p,
  };
}

describe("extractLeagueFromMatchKey", () => {
  it("extracts league from a canonical match_key", () => {
    expect(extractLeagueFromMatchKey("epl:Arsenal-Chelsea")).toBe("epl");
    expect(extractLeagueFromMatchKey("bundesliga:FC Bayern München-Borussia Dortmund")).toBe("bundesliga");
  });

  it("returns null for malformed input", () => {
    expect(extractLeagueFromMatchKey("")).toBeNull();
    expect(extractLeagueFromMatchKey(undefined)).toBeNull();
    expect(extractLeagueFromMatchKey("no-colon-here")).toBeNull();
    expect(extractLeagueFromMatchKey(":leading-colon")).toBeNull();
  });
});

describe("computeLeagueKellyMultiplier — volume gate", () => {
  it("returns 1.0 when no bets exist", () => {
    expect(computeLeagueKellyMultiplier("epl", [])).toBe(1.0);
  });

  it("returns 1.0 for unknown league", () => {
    expect(computeLeagueKellyMultiplier(undefined, [])).toBe(1.0);
    expect(computeLeagueKellyMultiplier("", [])).toBe(1.0);
  });

  it("returns 1.0 with 39 bets even if mean CLV is strongly negative (volume gate)", () => {
    // 39 bets in EPL, all with very negative CLV (strong drift signal)
    // — but volume is below threshold, so no dampening.
    const bets: PlacedBet[] = Array.from({ length: 39 }, (_, i) =>
      bet({ id: `${i}`, match_key: "epl:A-B", clv: -10 - i * 0.1 }),
    );
    expect(computeLeagueKellyMultiplier("epl", bets)).toBe(1.0);
  });

  it("triggers at exactly 40 bets when z-score < -1.0", () => {
    // 40 bets with negative CLV and small variation (sd > 0 required for z-score)
    // mean ≈ -5.0, sd ≈ 0.5 → z = -5/(0.5/sqrt(40)) ≈ -63 → far below -1.0
    const bets: PlacedBet[] = Array.from({ length: 40 }, (_, i) =>
      bet({
        id: `${i}`,
        match_key: "epl:A-B",
        clv: -5.0 + (i % 3 - 1) * 0.5,  // values: -5.5, -5.0, -4.5 cycling
        settled_at: `2026-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    expect(computeLeagueKellyMultiplier("epl", bets)).toBe(CLV_FEEDBACK_MULTIPLIER);
  });

  it("returns 1.0 with 40 bets when CLV is around 0 (z-score near 0)", () => {
    // Mean=0, no drift → no dampening
    const bets: PlacedBet[] = Array.from({ length: 40 }, (_, i) =>
      bet({ id: `${i}`, match_key: "epl:A-B", clv: i % 2 === 0 ? 1.0 : -1.0 }),
    );
    expect(computeLeagueKellyMultiplier("epl", bets)).toBe(1.0);
  });

  it("returns 1.0 with 40 bets when z-score is between -1.0 and 0 (mild drift, no trigger)", () => {
    // Mean ~ -0.5, sd ~ 5 → z = -0.5/(5/sqrt(40)) ≈ -0.63 → above threshold
    const bets: PlacedBet[] = Array.from({ length: 40 }, (_, i) =>
      bet({ id: `${i}`, match_key: "epl:A-B", clv: i % 2 === 0 ? -5.5 : 4.5 }),
    );
    const m = computeLeagueKellyMultiplier("epl", bets);
    expect(m).toBe(1.0);
  });
});

describe("computeLeagueKellyMultiplier — filtering", () => {
  it("ignores pending bets even if they have CLV", () => {
    const settled: PlacedBet[] = Array.from({ length: 39 }, (_, i) =>
      bet({ id: `s${i}`, match_key: "epl:A-B", clv: -5 }),
    );
    const pending: PlacedBet[] = Array.from({ length: 10 }, (_, i) =>
      bet({ id: `p${i}`, match_key: "epl:A-B", clv: -10, result: "pending" }),
    );
    // 39 settled + 10 pending = 49 total, but only 39 settled count → no trigger
    expect(computeLeagueKellyMultiplier("epl", [...settled, ...pending])).toBe(1.0);
  });

  it("ignores bets where clv is null/undefined", () => {
    const withClv: PlacedBet[] = Array.from({ length: 30 }, (_, i) =>
      bet({ id: `w${i}`, match_key: "epl:A-B", clv: -5 }),
    );
    const noClv: PlacedBet[] = Array.from({ length: 20 }, (_, i) =>
      bet({ id: `n${i}`, match_key: "epl:A-B" }),  // clv: undefined
    );
    // 30 with clv + 20 without = 30 valid → still under threshold
    expect(computeLeagueKellyMultiplier("epl", [...withClv, ...noClv])).toBe(1.0);
  });

  it("filters by exact league key (does not bleed across leagues)", () => {
    const eplDrift: PlacedBet[] = Array.from({ length: 40 }, (_, i) =>
      bet({ id: `e${i}`, match_key: "epl:A-B", clv: -5 + (i % 3 - 1) * 0.5 }),
    );
    // Querying bundesliga should be unaffected by EPL's drift
    expect(computeLeagueKellyMultiplier("bundesliga", eplDrift)).toBe(1.0);
    // EPL itself triggers
    expect(computeLeagueKellyMultiplier("epl", eplDrift)).toBe(CLV_FEEDBACK_MULTIPLIER);
  });

  it("uses only the most recent CLV_FEEDBACK_WINDOW bets — older history ignored", () => {
    // 40 RECENT bets at CLV=+5 (positive), 100 OLD bets at CLV=-10 (negative)
    // The recent positive ones should win out — no dampening.
    const recentPositive: PlacedBet[] = Array.from({ length: 40 }, (_, i) =>
      bet({
        id: `r${i}`,
        match_key: "epl:A-B",
        clv: 5,
        settled_at: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const oldNegative: PlacedBet[] = Array.from({ length: 100 }, (_, i) =>
      bet({
        id: `o${i}`,
        match_key: "epl:A-B",
        clv: -10,
        settled_at: `2025-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    expect(computeLeagueKellyMultiplier("epl", [...recentPositive, ...oldNegative])).toBe(1.0);
  });
});

describe("computeLeagueCLVBreakdown", () => {
  it("returns empty array for no bets", () => {
    expect(computeLeagueCLVBreakdown([])).toEqual([]);
  });

  it("groups bets by league and reports basic stats", () => {
    const bets: PlacedBet[] = [
      bet({ id: "1", match_key: "epl:A-B", clv: 2 }),
      bet({ id: "2", match_key: "epl:A-B", clv: -1 }),
      bet({ id: "3", match_key: "bundesliga:C-D", clv: 5 }),
    ];
    const rows = computeLeagueCLVBreakdown(bets);
    expect(rows.length).toBe(2);
    const epl = rows.find(r => r.league === "epl")!;
    expect(epl.count).toBe(2);
    expect(epl.meanClv).toBeCloseTo(0.5, 5);
    const bl = rows.find(r => r.league === "bundesliga")!;
    expect(bl.count).toBe(1);
    expect(bl.meanClv).toBe(5);
    expect(bl.sdClv).toBeNull();  // only 1 sample → undefined sd
  });

  it("ranks dampened leagues first, then by count", () => {
    const triggered: PlacedBet[] = Array.from({ length: 40 }, (_, i) =>
      bet({ id: `t${i}`, match_key: "epl:A-B", clv: -5 + (i % 3 - 1) * 0.5 }),
    );
    const safe: PlacedBet[] = Array.from({ length: 100 }, (_, i) =>
      bet({ id: `s${i}`, match_key: "bundesliga:C-D", clv: i % 2 === 0 ? 0.5 : -0.5 }),
    );
    const rows = computeLeagueCLVBreakdown([...triggered, ...safe]);
    // EPL with multiplier 0.5 should sort first despite having fewer bets
    expect(rows[0].league).toBe("epl");
    expect(rows[0].kellyMultiplier).toBe(CLV_FEEDBACK_MULTIPLIER);
    expect(rows[1].league).toBe("bundesliga");
    expect(rows[1].kellyMultiplier).toBe(1.0);
  });
});

describe("CLV_FEEDBACK_WINDOW constant", () => {
  it("is 40 — picked because it's the smallest N where z-test is statistically meaningful", () => {
    expect(CLV_FEEDBACK_WINDOW).toBe(40);
  });

  it("multiplier is 0.5 — halve Kelly without going to zero (still trade through drift)", () => {
    expect(CLV_FEEDBACK_MULTIPLIER).toBe(0.5);
  });
});
