import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPlayerPropsPosteriors,
  predictPlayerProps,
  fairOdds,
  isPlayerPropsLoaded,
  resetPlayerProps,
  type PlayerPropsJSON,
} from "@/lib/player-props-engine";
import { canonicalMarket, marketLabel, MARKET_LABELS_SHORT } from "@/lib/market-labels";

// ─── Fixture: one league, two teams, a handful of players ──────────
// Hand-picked log-scale rates so the exp() math is easy to verify by hand.
//   α=0.0  → λ = 1/90 goals per minute when offset=0 (i.e. 1 goal / match)
//   α=-2.0 → λ ≈ 0.135 goals / match at 90 minutes → Kane-ish but not Kane.
const fixture: PlayerPropsJSON = {
  _version: 1,
  _meta: { method: "hierarchical_poisson" },
  teams: {
    "Bayern":   { team_attack:  0.20, league_baseline: 0 },
    "Dortmund": { team_attack:  0.10, league_baseline: 0 },
    "Stuttgart":{ team_attack: -0.05, league_baseline: 0 },
  },
  players: {
    "harry kane":  { alpha_mean: -0.7, beta_mean:  1.3, gamma_mean: -4.0, minutes_share: 0.90, team: "Bayern", league: "bundesliga", season: "2526" },
    "kane":        { alpha_mean: -0.7, beta_mean:  1.3, gamma_mean: -4.0, minutes_share: 0.90, team: "Bayern", league: "bundesliga", season: "2526" },
    "leroy sane":  { alpha_mean: -2.2, beta_mean:  0.8, gamma_mean: -4.0, minutes_share: 0.55, team: "Bayern", league: "bundesliga", season: "2526" },
    "thomas mueller": { alpha_mean: -2.5, beta_mean: 0.4, gamma_mean: -3.5, minutes_share: 0.35, team: "Bayern", league: "bundesliga", season: "2526" },
    // A defender with near-zero goal rate but frequent cards.
    "joshua kimmich": { alpha_mean: -3.5, beta_mean: 0.2, gamma_mean: -2.8, minutes_share: 0.95, team: "Bayern", league: "bundesliga", season: "2526" },
  },
};

describe("loadPlayerPropsPosteriors", () => {
  beforeEach(() => resetPlayerProps());

  it("throws on missing _version", () => {
    expect(() => loadPlayerPropsPosteriors({} as any)).toThrow();
    expect(() => loadPlayerPropsPosteriors({ _version: 2, teams: {}, players: {} } as any)).toThrow();
  });

  it("accepts empty-but-valid payload (dormant)", () => {
    loadPlayerPropsPosteriors({ _version: 1, teams: {}, players: {} });
    expect(isPlayerPropsLoaded()).toBe(false);
  });

  it("marks loaded when players present", () => {
    loadPlayerPropsPosteriors(fixture);
    expect(isPlayerPropsLoaded()).toBe(true);
  });
});

describe("predictPlayerProps", () => {
  beforeEach(() => {
    resetPlayerProps();
    loadPlayerPropsPosteriors(fixture);
  });

  it("returns null when nothing loaded", () => {
    resetPlayerProps();
    const out = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true,
    });
    expect(out).toBeNull();
  });

  it("returns null when player not in posteriors", () => {
    const out = predictPlayerProps("Random Guy", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true,
    });
    expect(out).toBeNull();
  });

  it("last-name-only lookup works (TM vs FBref spelling tolerance)", () => {
    const out = predictPlayerProps("Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true,
    });
    expect(out).not.toBeNull();
    expect(out?.source).toBe("player-props-bayes");
  });

  it("anytime-scorer P is in (0, 1)", () => {
    const out = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 90,
    });
    expect(out?.p_anytime_scorer).toBeGreaterThan(0);
    expect(out?.p_anytime_scorer).toBeLessThan(1);
  });

  it("star striker has higher anytime-scorer than defender", () => {
    const kane = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 90,
    });
    const kimmich = predictPlayerProps("Joshua Kimmich", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 90,
    });
    expect(kane!.p_anytime_scorer!).toBeGreaterThan(kimmich!.p_anytime_scorer!);
  });

  it("home-advantage lifts anytime-scorer prob", () => {
    const home = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Stuttgart", isHome: true, expectedMinutes: 90,
    });
    const away = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Stuttgart", awayTeam: "Bayern", isHome: false, expectedMinutes: 90,
    });
    expect(home!.p_anytime_scorer!).toBeGreaterThan(away!.p_anytime_scorer!);
  });

  it("expected-minutes offset scales λ correctly (half minutes → ~half λ)", () => {
    const full = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 90,
    });
    const half = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 45,
    });
    // λ ∝ minutes/90, so halving minutes halves λ.
    expect(half!.lambda_goals).toBeCloseTo(full!.lambda_goals / 2, 3);
  });

  it("default expectedMinutes is 70 when not provided", () => {
    const out = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true,
    });
    expect(out?.expectedMinutes).toBe(70);
  });

  it("shots-over thresholds are monotonically decreasing (1.5 > 2.5 > 3.5)", () => {
    const out = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 90,
    });
    const o15 = out!.p_shots_over(1.5);
    const o25 = out!.p_shots_over(2.5);
    const o35 = out!.p_shots_over(3.5);
    expect(o15).toBeGreaterThan(o25!);
    expect(o25!).toBeGreaterThan(o35!);
  });

  it("yellow-card prob is low for forwards, higher for Kimmich-like defenders", () => {
    const kane = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 90,
    });
    const kimmich = predictPlayerProps("Joshua Kimmich", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 90,
    });
    expect(kimmich!.p_yellow_card!).toBeGreaterThan(kane!.p_yellow_card!);
  });

  it("clamps expected-minutes into [0, 95]", () => {
    const neg = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: -5,
    });
    const huge = predictPlayerProps("Harry Kane", "Bayern", {
      homeTeam: "Bayern", awayTeam: "Dortmund", isHome: true, expectedMinutes: 400,
    });
    expect(neg?.expectedMinutes).toBe(0);
    expect(huge?.expectedMinutes).toBe(95);
  });
});

describe("fairOdds", () => {
  it("inverts P into decimal odds", () => {
    expect(fairOdds(0.5)).toBe(2.0);
    expect(fairOdds(0.25)).toBe(4.0);
    expect(fairOdds(0.1)).toBeCloseTo(10, 3);
  });

  it("returns null for edge-case inputs", () => {
    expect(fairOdds(null)).toBeNull();
    expect(fairOdds(0)).toBeNull();
    expect(fairOdds(1)).toBeNull();
    expect(fairOdds(-0.2)).toBeNull();
    expect(fairOdds(1.5)).toBeNull();
  });
});

describe("market-labels player-props", () => {
  it("canonicalMarket accepts all six new player-prop keys + aliases", () => {
    expect(canonicalMarket("anytime_scorer")).toBe("anytime_scorer");
    expect(canonicalMarket("Anytime Goalscorer")).toBe("anytime_scorer");
    expect(canonicalMarket("AGS")).toBe("anytime_scorer");
    expect(canonicalMarket("first_scorer")).toBe("first_scorer");
    expect(canonicalMarket("First Goalscorer")).toBe("first_scorer");
    expect(canonicalMarket("shots over 2.5")).toBe("shots_o25");
    expect(canonicalMarket("player_yellow")).toBe("player_yellow");
    expect(canonicalMarket("player yellow card")).toBe("player_yellow");
  });

  it("MARKET_LABELS_SHORT has German entries for every key", () => {
    for (const k of ["anytime_scorer", "first_scorer", "shots_o15", "shots_o25", "shots_o35", "player_yellow"] as const) {
      expect(MARKET_LABELS_SHORT[k]).toBeTruthy();
    }
  });

  it("marketLabel renders the short form", () => {
    expect(marketLabel("anytime_scorer")).toBe("Torschütze");
    expect(marketLabel("player_yellow", "long")).toBe("GELBE KARTE (SPIELER)");
  });
});
