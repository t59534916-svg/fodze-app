import { describe, it, expect } from "vitest";
import { sourcePriority, pickWinner, SOURCE_PRIORITY } from "../scripts/dedupe-team-names.mjs";

describe("sourcePriority — data-richness ranking", () => {
  it("orders sources sofascore > footystats > shots-model > goals-proxy", () => {
    expect(sourcePriority("sofascore")).toBeGreaterThan(sourcePriority("footystats"));
    expect(sourcePriority("footystats")).toBeGreaterThan(sourcePriority("shots-model"));
    expect(sourcePriority("shots-model")).toBeGreaterThan(sourcePriority("goals-proxy"));
  });

  it("real-xG sources all outrank goals-proxy (the no-xG source)", () => {
    for (const s of ["sofascore", "understat", "api-sports", "footystats", "shots-model"]) {
      expect(sourcePriority(s)).toBeGreaterThan(sourcePriority("goals-proxy"));
    }
  });

  it("shots-model-<liga> variants map to the generic shots-model rank", () => {
    expect(sourcePriority("shots-model-bundesliga2")).toBe(sourcePriority("shots-model"));
    expect(sourcePriority("shots-model-pooled")).toBeGreaterThanOrEqual(sourcePriority("shots-model"));
  });

  it("unknown / null / empty sources sort lowest (-1)", () => {
    expect(sourcePriority("mystery-source")).toBe(-1);
    expect(sourcePriority(null)).toBe(-1);
    expect(sourcePriority("")).toBe(-1);
    expect(sourcePriority(undefined)).toBe(-1);
  });

  it("every known source has a distinct positive rank", () => {
    const ranks = SOURCE_PRIORITY.map((s: string) => sourcePriority(s));
    expect(new Set(ranks).size).toBe(SOURCE_PRIORITY.length);
    expect(ranks.every((r: number) => r > 0)).toBe(true);
  });
});

describe("pickWinner — conflict resolution (which row survives the merge)", () => {
  it("THE BUG FIX: sofascore alias beats goals-proxy canonical", () => {
    // The exact Dynamo Dresden case: alias=SG Dynamo Dresden (sofascore xG),
    // canonical=Dynamo Dresden (goals-proxy, no xG). The richer data must win.
    expect(pickWinner("sofascore", "goals-proxy")).toBe("alias");
  });

  it("sofascore alias beats footystats/shots-model canonical", () => {
    expect(pickWinner("sofascore", "footystats")).toBe("alias");
    expect(pickWinner("sofascore", "shots-model-pooled")).toBe("alias");
  });

  it("weaker alias loses to richer canonical (alias dropped)", () => {
    expect(pickWinner("goals-proxy", "sofascore")).toBe("canonical");
    expect(pickWinner("shots-model", "footystats")).toBe("canonical");
  });

  it("ties go to canonical (no churn — it already holds the slot)", () => {
    expect(pickWinner("sofascore", "sofascore")).toBe("canonical");
    expect(pickWinner("footystats", "footystats")).toBe("canonical");
  });

  it("unknown alias source never beats a known canonical", () => {
    expect(pickWinner("mystery", "goals-proxy")).toBe("canonical");
    expect(pickWinner(null, "shots-model")).toBe("canonical");
  });

  it("known alias beats unknown canonical", () => {
    expect(pickWinner("goals-proxy", "mystery")).toBe("alias");
  });
});
