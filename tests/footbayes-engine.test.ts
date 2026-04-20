import { describe, it, expect, beforeEach } from "vitest";
import {
  loadFootBayesPosteriors,
  calcMatchFootBayesLambdas,
  isFootBayesLoaded,
  resetFootBayesPosteriors,
  type FootBayesPosteriors,
} from "@/lib/footbayes-engine";

// A hand-built fixture: two leagues, four teams. Intercepts + home_advantage
// chosen so tests can verify the additive log-linear form explicitly.
const fixture: FootBayesPosteriors = {
  _version: 1,
  _meta: { method: "biv_pois_dynamic" },
  leagues: {
    bundesliga: { intercept: 0.25, home_advantage: 0.19, n_matches: 612 },
    liga3:      { intercept: 0.20, home_advantage: 0.22, n_matches: 380 },
  },
  teams: {
    "FC Bayern München":       { league: "bundesliga", attack_mean: 0.45, attack_sd: 0.08, defense_mean: -0.32, defense_sd: 0.09 },
    "Borussia Dortmund":       { league: "bundesliga", attack_mean: 0.30, attack_sd: 0.10, defense_mean: -0.15, defense_sd: 0.10 },
    "VfB Stuttgart":           { league: "bundesliga", attack_mean: 0.10, attack_sd: 0.12, defense_mean: -0.05, defense_sd: 0.11 },
    "Dynamo Dresden":          { league: "liga3",      attack_mean: 0.18, attack_sd: 0.14, defense_mean: -0.10, defense_sd: 0.13 },
  },
};

describe("loadFootBayesPosteriors", () => {
  beforeEach(() => resetFootBayesPosteriors());

  it("throws on missing _version", () => {
    expect(() => loadFootBayesPosteriors({} as any)).toThrow();
    expect(() => loadFootBayesPosteriors({ _version: 2, leagues: {}, teams: {} } as any)).toThrow();
  });

  it("accepts an empty but schema-valid payload (dormant state)", () => {
    loadFootBayesPosteriors({ _version: 1, leagues: {}, teams: {} });
    // Valid schema but nothing to serve → isFootBayesLoaded returns false.
    expect(isFootBayesLoaded()).toBe(false);
  });

  it("accepts a populated fixture and reports loaded", () => {
    loadFootBayesPosteriors(fixture);
    expect(isFootBayesLoaded()).toBe(true);
  });
});

describe("calcMatchFootBayesLambdas", () => {
  beforeEach(() => resetFootBayesPosteriors());

  it("returns null when nothing loaded", () => {
    const out = calcMatchFootBayesLambdas({
      homeTeam: "FC Bayern München", awayTeam: "Borussia Dortmund", league: "bundesliga",
    });
    expect(out).toBeNull();
  });

  it("returns null for unknown team", () => {
    loadFootBayesPosteriors(fixture);
    const out = calcMatchFootBayesLambdas({
      homeTeam: "Random FC", awayTeam: "Borussia Dortmund", league: "bundesliga",
    });
    expect(out).toBeNull();
  });

  it("returns null for unknown league", () => {
    loadFootBayesPosteriors(fixture);
    const out = calcMatchFootBayesLambdas({
      homeTeam: "FC Bayern München", awayTeam: "Borussia Dortmund", league: "fake_liga",
    });
    expect(out).toBeNull();
  });

  it("computes expected λ with additive log-linear form (home)", () => {
    loadFootBayesPosteriors(fixture);
    const out = calcMatchFootBayesLambdas({
      homeTeam: "FC Bayern München", awayTeam: "Borussia Dortmund", league: "bundesliga",
    });
    expect(out).not.toBeNull();
    // log λ_H = intercept + home_advantage + attack_home - defense_away
    //        = 0.25 + 0.19 + 0.45 - (-0.15) = 1.04
    // λ_H = exp(1.04) ≈ 2.829
    expect(out!.lambdaH).toBeCloseTo(Math.exp(1.04), 3);
  });

  it("computes expected λ with additive log-linear form (away)", () => {
    loadFootBayesPosteriors(fixture);
    const out = calcMatchFootBayesLambdas({
      homeTeam: "FC Bayern München", awayTeam: "Borussia Dortmund", league: "bundesliga",
    });
    expect(out).not.toBeNull();
    // log λ_A = intercept + attack_away - defense_home
    //        = 0.25 + 0.30 - (-0.32) = 0.87
    expect(out!.lambdaA).toBeCloseTo(Math.exp(0.87), 3);
  });

  it("clamps extreme λ to [0.1, 5.0]", () => {
    loadFootBayesPosteriors({
      _version: 1,
      leagues: { bundesliga: { intercept: 10, home_advantage: 10 } }, // exp → 500M
      teams: {
        "Big":   { league: "bundesliga", attack_mean: 5,  defense_mean: 0 },
        "Small": { league: "bundesliga", attack_mean: -5, defense_mean: 0 },
      },
    });
    const out = calcMatchFootBayesLambdas({ homeTeam: "Big", awayTeam: "Small", league: "bundesliga" });
    expect(out).not.toBeNull();
    expect(out!.lambdaH).toBeLessThanOrEqual(5.0);
    expect(out!.lambdaH).toBeGreaterThanOrEqual(0.1);
    expect(out!.lambdaA).toBeLessThanOrEqual(5.0);
    expect(out!.lambdaA).toBeGreaterThanOrEqual(0.1);
  });

  it("is asymmetric: home ↔ away swap changes both lambdas", () => {
    loadFootBayesPosteriors(fixture);
    const a = calcMatchFootBayesLambdas({
      homeTeam: "FC Bayern München", awayTeam: "VfB Stuttgart", league: "bundesliga",
    });
    const b = calcMatchFootBayesLambdas({
      homeTeam: "VfB Stuttgart", awayTeam: "FC Bayern München", league: "bundesliga",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Home-team attack flavour in λH — swapping gives different values.
    expect(a!.lambdaH).not.toBe(b!.lambdaH);
    expect(a!.lambdaA).not.toBe(b!.lambdaA);
  });

  it("source field set to 'footbayes' for downstream tracing", () => {
    loadFootBayesPosteriors(fixture);
    const out = calcMatchFootBayesLambdas({
      homeTeam: "Dynamo Dresden", awayTeam: "Dynamo Dresden", league: "liga3", // self-match edge
    });
    expect(out).not.toBeNull();
    expect(out!.source).toBe("footbayes");
  });
});
