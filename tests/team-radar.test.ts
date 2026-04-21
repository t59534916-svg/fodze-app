// ═══════════════════════════════════════════════════════════════════════
//  TeamRadar axis-math tests — lock in the 5 scoring formulas so
//  MatchCard renderings stay honest even when the pipeline shifts.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { buildAxes } from "@/components/match/TeamRadar";
import type { TeamData } from "@/types/match";

const LEAGUE_AVG = 1.35;

const make = (overrides: Partial<TeamData> = {}): TeamData => ({
  name: "Test",
  games: 8,
  ...overrides,
});

describe("buildAxes", () => {
  it("empty team → all zeros (nothing to draw)", () => {
    const a = buildAxes(undefined);
    expect(a.attack).toBe(0);
    expect(a.defense).toBe(0);
    expect(a.form).toBe(0);
    expect(a.squad).toBe(0);
    expect(a.xgBalance).toBe(0);
  });

  it("team with no xG falls back to 0.5 on xg-derived axes", () => {
    const a = buildAxes(make({ xg_h8: undefined }), LEAGUE_AVG);
    expect(a.attack).toBe(0.5);
    expect(a.defense).toBe(0.5);
    expect(a.xgBalance).toBe(0.5);
  });

  it("attack: league-avg xG → 0.5 (median)", () => {
    const xg = LEAGUE_AVG * 8;  // 1.35 xG/game over 8 games
    const a = buildAxes(make({ xg_h8: xg }), LEAGUE_AVG);
    expect(a.attack).toBeCloseTo(0.5, 2);
  });

  it("attack: 2× league-avg xG → 1.0 (top-decile cap)", () => {
    const xg = 2 * LEAGUE_AVG * 8;
    const a = buildAxes(make({ xg_h8: xg }), LEAGUE_AVG);
    expect(a.attack).toBeCloseTo(1.0, 2);
  });

  it("attack: 4× league-avg xG is still clamped to 1.0 (no punch-through)", () => {
    const xg = 4 * LEAGUE_AVG * 8;
    const a = buildAxes(make({ xg_h8: xg }), LEAGUE_AVG);
    expect(a.attack).toBe(1.0);
  });

  it("attack: zero xG → 0.0 (empty attack, not fallback)", () => {
    // xg_h8 = 0 is legitimate data for a goal-less team, not missing data.
    const a = buildAxes(make({ xg_h8: 0 }), LEAGUE_AVG);
    expect(a.attack).toBe(0);
  });

  it("defense: zero xGA allowed → 1.0 (perfect)", () => {
    const a = buildAxes(make({ xg_h8: LEAGUE_AVG * 8, xga_h8: 0 }), LEAGUE_AVG);
    expect(a.defense).toBe(1.0);
  });

  it("defense: league-avg xGA → 0.5", () => {
    const a = buildAxes(make({ xg_h8: LEAGUE_AVG * 8, xga_h8: LEAGUE_AVG * 8 }), LEAGUE_AVG);
    expect(a.defense).toBeCloseTo(0.5, 2);
  });

  it("defense: 2× league-avg xGA → 0.0 (terrible)", () => {
    const a = buildAxes(make({ xg_h8: LEAGUE_AVG * 8, xga_h8: 2 * LEAGUE_AVG * 8 }), LEAGUE_AVG);
    expect(a.defense).toBe(0);
  });

  it("form: 'W W W W W' → 1.0", () => {
    expect(buildAxes(make({ form: "W W W W W" })).form).toBe(1.0);
  });

  it("form: 'L L L L L' → 0.0", () => {
    expect(buildAxes(make({ form: "L L L L L" })).form).toBe(0);
  });

  it("form: 'D D D D D' → 0.5", () => {
    expect(buildAxes(make({ form: "D D D D D" })).form).toBe(0.5);
  });

  it("form: mixed 'W D L W W' → 0.7 (3×1.0 + 1×0.5 + 1×0)/5", () => {
    expect(buildAxes(make({ form: "W D L W W" })).form).toBeCloseTo(0.7, 3);
  });

  it("form: missing string → 0.5 neutral", () => {
    expect(buildAxes(make({ form: undefined })).form).toBe(0.5);
  });

  it("form: only uses last 5 even if string is longer", () => {
    // 7-char sequence; only last 5 (D L W W W) count → (0.5+0+1+1+1)/5 = 0.7
    expect(buildAxes(make({ form: "L L D L W W W" })).form).toBeCloseTo(0.7, 3);
  });

  it("squad: no injuries string → 1.0 (assume full)", () => {
    expect(buildAxes(make({ injuries: undefined })).squad).toBe(1.0);
  });

  it("squad: 2 injured players → ~0.909 (1 − 2/22)", () => {
    const s = "Mueller (ST, Verletzung), Kimmich (MF, Sperre)";
    expect(buildAxes(make({ injuries: s })).squad).toBeCloseTo(1 - 2 / 22, 3);
  });

  it("squad: 22 injured players → 0.0 (empty bench)", () => {
    const s = Array.from({ length: 22 }, (_, i) => `Player${i} (POS, Reason)`).join(", ");
    expect(buildAxes(make({ injuries: s })).squad).toBe(0);
  });

  it("xgBalance: zero net → 0.5", () => {
    const a = buildAxes(make({ xg_h8: LEAGUE_AVG * 8, xga_h8: LEAGUE_AVG * 8 }), LEAGUE_AVG);
    expect(a.xgBalance).toBeCloseTo(0.5, 2);
  });

  it("xgBalance: +1.0 net xG/game → ~0.833 (0.5 + 1/3)", () => {
    const a = buildAxes(make({ xg_h8: (LEAGUE_AVG + 1) * 8, xga_h8: LEAGUE_AVG * 8 }), LEAGUE_AVG);
    expect(a.xgBalance).toBeCloseTo(0.5 + 1 / 3, 2);
  });

  it("xgBalance: huge net (+3.0) is clamped to 1.0", () => {
    const a = buildAxes(make({ xg_h8: 10 * LEAGUE_AVG * 8, xga_h8: 0 }), LEAGUE_AVG);
    expect(a.xgBalance).toBe(1.0);
  });

  it("away-venue keys work when home-venue keys are absent", () => {
    // Away fixture — xg_a8/xga_a8 are the relevant fields.
    const a = buildAxes(make({ xg_a8: LEAGUE_AVG * 8, xga_a8: 0 }), LEAGUE_AVG);
    expect(a.attack).toBeCloseTo(0.5, 2);
    expect(a.defense).toBe(1.0);
  });
});
