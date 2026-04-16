import { describe, it, expect } from "vitest";
import { resolveTeam, fuzzyTeamMatch, toCsvName, toUnderstatName } from "@/lib/team-resolver";

// ─── fuzzyTeamMatch ──────────────────────────────────────────────
// Critical: this helper is now called from 3 places (team-resolver,
// MatchdayContext live-odds matching, snapshot-closing-odds.mjs).
// A bug here silently pollutes CLV calculations.

describe("fuzzyTeamMatch", () => {
  it("exact case-sensitive match", () => {
    expect(fuzzyTeamMatch("Bayern", "Bayern")).toBe(true);
  });

  it("case-insensitive match", () => {
    expect(fuzzyTeamMatch("BAYERN", "bayern")).toBe(true);
    expect(fuzzyTeamMatch("Bayern Munich", "BAYERN MUNICH")).toBe(true);
  });

  it("substring match either direction", () => {
    expect(fuzzyTeamMatch("FC Bayern München", "Bayern")).toBe(true);
    expect(fuzzyTeamMatch("Bayern", "FC Bayern München")).toBe(true);
  });

  it("shared word (length > 3) match", () => {
    expect(fuzzyTeamMatch("VfB Stuttgart", "Stuttgart FC")).toBe(true);
    expect(fuzzyTeamMatch("Borussia Dortmund", "BVB Dortmund")).toBe(true);
  });

  it("rejects unrelated teams", () => {
    expect(fuzzyTeamMatch("Hamburg", "Munich")).toBe(false);
    expect(fuzzyTeamMatch("Arsenal", "Chelsea")).toBe(false);
  });

  it("rejects short-word-only overlap (≤3 chars)", () => {
    // "fc" is 2 chars — too short to be distinctive
    expect(fuzzyTeamMatch("FC Bayern", "FC Chelsea")).toBe(false);
  });

  it("handles empty strings defensively", () => {
    expect(fuzzyTeamMatch("", "Bayern")).toBe(false);
    expect(fuzzyTeamMatch("Bayern", "")).toBe(false);
    expect(fuzzyTeamMatch("", "")).toBe(false);
  });

  it("symmetric for complex names", () => {
    const a = "Borussia Mönchengladbach";
    const b = "Borussia M.Gladbach";
    expect(fuzzyTeamMatch(a, b)).toBe(fuzzyTeamMatch(b, a));
  });
});

// ─── resolveTeam ─────────────────────────────────────────────────

describe("resolveTeam", () => {
  it("returns null for empty name", () => {
    expect(resolveTeam("")).toBeNull();
  });

  it("finds team by exact FODZE name", () => {
    const r = resolveTeam("FC Bayern München");
    expect(r).not.toBeNull();
    expect(r?.fodze).toBe("FC Bayern München");
    expect(r?.league).toBe("bundesliga");
  });

  it("finds team by CSV name", () => {
    const r = resolveTeam("Bayern Munich");
    expect(r).not.toBeNull();
    expect(r?.csv).toBe("Bayern Munich");
  });

  it("is case-insensitive on fallback", () => {
    const a = resolveTeam("fc bayern münchen");
    expect(a).not.toBeNull();
    expect(a?.fodze).toBe("FC Bayern München");
  });
});

// ─── toCsvName + toUnderstatName ─────────────────────────────────

describe("toCsvName", () => {
  it("maps FODZE to CSV name (for Elo lookup)", () => {
    expect(toCsvName("FC Bayern München")).toBe("Bayern Munich");
    expect(toCsvName("Borussia Dortmund")).toBe("Dortmund");
  });

  it("returns input unchanged for unknown team", () => {
    expect(toCsvName("Unknown Team XYZ")).toBe("Unknown Team XYZ");
  });
});

describe("toUnderstatName", () => {
  it("maps FODZE to Understat name (for xG history)", () => {
    expect(toUnderstatName("FC Bayern München")).toBe("Bayern Munich");
  });

  it("returns input unchanged for unknown team", () => {
    expect(toUnderstatName("Unknown Team XYZ")).toBe("Unknown Team XYZ");
  });
});
