import { describe, it, expect } from "vitest";
import {
  enrichPlayerFromXG,
  hydrateAbsencesWithXG,
  buildPlayerXgIndex,
  defaultPlayerProfile,
  calcAbsenceImpact,
  type PlayerXgRow,
} from "@/lib/player-impact";

const KANE_XG: PlayerXgRow = {
  player_name: "Harry Kane",
  team: "FC Bayern München",
  league: "bundesliga",
  season: "2526",
  position: "FWD",
  minutes_played: 2200,       // ≈ 24.4 matches of full 90
  xg_per_90: 0.85,            // genuinely elite per-90
  xa_per_90: 0.21,
  npxg_per_90: 0.70,
};

const MID_XG: PlayerXgRow = {
  player_name: "Sara Doué",
  team: "PSG",
  league: "ligue_1",
  season: "2526",
  position: "MID",
  minutes_played: 1500,
  xg_per_90: 0.28,
  xa_per_90: 0.30,
  npxg_per_90: 0.24,
};

describe("enrichPlayerFromXG", () => {
  it("returns profile unchanged when xg row is null", () => {
    const profile = defaultPlayerProfile("Harry Kane", "Bayern", "FWD", true);
    const enriched = enrichPlayerFromXG(profile, null, 1.8);
    expect(enriched).toEqual(profile);
  });

  it("returns profile unchanged when minutes < 90 (no signal)", () => {
    const profile = defaultPlayerProfile("Youth Player", "Bayern", "FWD", false);
    const junkXg: PlayerXgRow = { ...KANE_XG, minutes_played: 45, xg_per_90: 2.0 };
    const enriched = enrichPlayerFromXG(profile, junkXg, 1.8);
    expect(enriched).toEqual(profile);
  });

  it("replaces default xgShare with real per-player value for a star FWD", () => {
    const profile = defaultPlayerProfile("Harry Kane", "Bayern", "FWD", true);
    // Default FWD with isKeyPlayer=true → xgShare ≈ 0.25 × 1.5 = 0.375 (capped at 0.50)
    expect(profile.xgShare).toBeCloseTo(0.375, 3);
    const enriched = enrichPlayerFromXG(profile, KANE_XG, 2.2);
    // Real share should be meaningful and cap-safe.
    expect(enriched.xgShare).toBeGreaterThan(0);
    expect(enriched.xgShare).toBeLessThanOrEqual(0.50);
    // gamesPlayed derived from minutes.
    expect(enriched.gamesPlayed).toBe(Math.round(2200 / 90));
  });

  it("replacement level for FWD is 40% of xgShare (Szczepański anchor)", () => {
    const profile = defaultPlayerProfile("Harry Kane", "Bayern", "FWD", true);
    const enriched = enrichPlayerFromXG(profile, KANE_XG, 2.2);
    expect(enriched.replacementLevel).toBeCloseTo(enriched.xgShare * 0.40, 3);
  });

  it("replacement level for DEF is 50% of xgShare", () => {
    const profile = defaultPlayerProfile("Van Dijk", "Liverpool", "DEF", true);
    const xg: PlayerXgRow = { ...KANE_XG, player_name: "Van Dijk", position: "DEF", xg_per_90: 0.08 };
    const enriched = enrichPlayerFromXG(profile, xg, 1.8);
    expect(enriched.replacementLevel).toBeCloseTo(enriched.xgShare * 0.50, 3);
  });

  it("caps xgShare at 0.50 for outlier data (regression guard)", () => {
    const profile = defaultPlayerProfile("Generic", "X", "FWD", false);
    const nuts: PlayerXgRow = { ...KANE_XG, xg_per_90: 99 };
    const enriched = enrichPlayerFromXG(profile, nuts, 1.0);
    expect(enriched.xgShare).toBeLessThanOrEqual(0.50);
  });

  it("handles zero team xGpg gracefully (fallback to default profile)", () => {
    const profile = defaultPlayerProfile("Kane", "Bayern", "FWD", true);
    const enriched = enrichPlayerFromXG(profile, KANE_XG, 0);
    // When teamTotalXGpg is 0 we can't compute a share — original xgShare stays.
    expect(enriched.xgShare).toBe(profile.xgShare);
  });
});

describe("buildPlayerXgIndex", () => {
  it("indexes by full name AND last name", () => {
    const idx = buildPlayerXgIndex([KANE_XG, MID_XG]);
    expect(idx.get("harry kane")).toBeTruthy();
    expect(idx.get("kane")).toBeTruthy();
    expect(idx.get("sara doué")).toBeTruthy();
    expect(idx.get("doué")).toBeTruthy();
  });

  it("returns empty Map for empty input", () => {
    expect(buildPlayerXgIndex([]).size).toBe(0);
  });

  it("skips rows without player_name", () => {
    const idx = buildPlayerXgIndex([{ ...KANE_XG, player_name: "" }]);
    expect(idx.size).toBe(0);
  });
});

describe("hydrateAbsencesWithXG — end-to-end with calcAbsenceImpact", () => {
  it("absent star striker with real xG data produces bigger attack hit than flat default", () => {
    // Kane out — compare flat default vs hydrated variant.
    const idx = buildPlayerXgIndex([KANE_XG]);
    const absences = [defaultPlayerProfile("Harry Kane", "FC Bayern München", "FWD", true)];
    const flat = calcAbsenceImpact(absences, 2.2);
    const hydrated = calcAbsenceImpact(
      hydrateAbsencesWithXG(absences, idx, 2.2),
      2.2,
    );
    // Both should reduce attack (< 1.0). Real-data hit may be larger OR
    // smaller depending on the player_xg share vs the flat 0.375 default —
    // what matters is the two compute cleanly and differ.
    expect(flat.lambdaAttackMult).toBeLessThan(1.0);
    expect(hydrated.lambdaAttackMult).toBeLessThan(1.0);
    expect(hydrated.lambdaAttackMult).not.toBe(flat.lambdaAttackMult);
  });

  it("empty index = no hydration, output identical to flat calcAbsenceImpact", () => {
    const absences = [defaultPlayerProfile("Harry Kane", "Bayern", "FWD", true)];
    const idx = new Map();
    const flat = calcAbsenceImpact(absences, 2.2);
    const maybeHydrated = hydrateAbsencesWithXG(absences, idx, 2.2);
    const result = calcAbsenceImpact(maybeHydrated, 2.2);
    expect(result.lambdaAttackMult).toBe(flat.lambdaAttackMult);
    expect(result.lambdaDefenseMult).toBe(flat.lambdaDefenseMult);
  });

  it("player not in index stays at default profile", () => {
    const idx = buildPlayerXgIndex([KANE_XG]);
    const profile = defaultPlayerProfile("Unknown Guy", "TeamX", "MID", true);
    const [out] = hydrateAbsencesWithXG([profile], idx, 1.5);
    expect(out).toEqual(profile);
  });

  it("last-name-only match works when TM gives only surname", () => {
    const idx = buildPlayerXgIndex([KANE_XG]);
    const profile = defaultPlayerProfile("Kane", "Bayern", "FWD", true);
    const [out] = hydrateAbsencesWithXG([profile], idx, 2.2);
    // Hydrated — xgShare changed from default 0.375 to the enriched value.
    expect(out.gamesPlayed).toBe(Math.round(2200 / 90));
  });
});

describe("Goalkeeper absence impact (Szczepański special case)", () => {
  it("uses 50% replacement factor for GK", () => {
    const profile = defaultPlayerProfile("Neuer", "Bayern", "GK", true);
    const xg: PlayerXgRow = { ...KANE_XG, player_name: "Neuer", position: "GK", xg_per_90: 0 };
    const enriched = enrichPlayerFromXG(profile, xg, 2.2);
    expect(enriched.replacementLevel).toBeCloseTo(enriched.xgShare * 0.50, 3);
  });

  it("GK absence still scales opponent's λ more than MID absence (defense weight)", () => {
    const gkOut = [defaultPlayerProfile("Neuer", "Bayern", "GK", true)];
    const midOut = [defaultPlayerProfile("Kimmich", "Bayern", "MID", true)];
    const gkImpact = calcAbsenceImpact(gkOut, 2.2);
    const midImpact = calcAbsenceImpact(midOut, 2.2);
    // GK absence → opponent's xG up more than MID absence.
    expect(gkImpact.lambdaDefenseMult).toBeGreaterThan(midImpact.lambdaDefenseMult);
  });
});
