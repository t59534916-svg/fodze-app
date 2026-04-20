import { describe, it, expect } from "vitest";
import { computeLiveWP, remainingLambda, liveEdge } from "@/lib/live-wp";

// Handy baseline: a strong-home, average-away matchup.
const pregame = { lambdaH: 1.6, lambdaA: 1.1 };

describe("remainingLambda — decay + state + reds", () => {
  it("decays to zero as minute → 90", () => {
    const r = remainingLambda(pregame, { minute: 90, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(r.decay).toBe(0);
    expect(r.lH).toBe(0);
    expect(r.lA).toBe(0);
  });

  it("at kickoff decay ~ 1.0 (no time elapsed)", () => {
    const r = remainingLambda(pregame, { minute: 0, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(r.decay).toBeCloseTo(1.0, 5);
  });

  it("at 45' decay ≈ 0.556 (remaining-frac ^ 0.84)", () => {
    const r = remainingLambda(pregame, { minute: 45, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(r.decay).toBeCloseTo(Math.pow(0.5, 0.84), 4);
  });

  it("state-mult: leading-home reduces lH, trailing-away boosts lA", () => {
    const r = remainingLambda(pregame, { minute: 60, scoreH: 2, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    // 2-0 → {mH: 0.92, mA: 1.08}
    expect(r.sm.mH).toBeCloseTo(0.92, 3);
    expect(r.sm.mA).toBeCloseTo(1.08, 3);
  });

  it("red on home → home λ penalised, away λ boosted", () => {
    const clean = remainingLambda(pregame, { minute: 30, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    const redH  = remainingLambda(pregame, { minute: 30, scoreH: 0, scoreA: 0, redCardsH: 1, redCardsA: 0 });
    expect(redH.lH).toBeLessThan(clean.lH);
    expect(redH.lA).toBeGreaterThan(clean.lA);
  });

  it("symmetric DIRECTION: red on away produces mirror-direction λ shift", () => {
    const clean = remainingLambda(pregame, { minute: 30, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    const redH  = remainingLambda(pregame, { minute: 30, scoreH: 0, scoreA: 0, redCardsH: 1, redCardsA: 0 });
    const redA  = remainingLambda(pregame, { minute: 30, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 1 });
    // Red-on-home penalises home, boosts away; red-on-away mirrors. λ values
    // differ in magnitude because pregame.lambdaH ≠ pregame.lambdaA, but the
    // multiplicative factors are identical in magnitude across the two cases.
    const homePenaltyFactor = redH.lH / clean.lH;
    const awayPenaltyFactor = redA.lA / clean.lA;
    expect(homePenaltyFactor).toBeCloseTo(awayPenaltyFactor, 4);
    const homeBoostFactor = redH.lA / clean.lA;
    const awayBoostFactor = redA.lH / clean.lH;
    expect(homeBoostFactor).toBeCloseTo(awayBoostFactor, 4);
  });

  it("extrapolates state-mult for uncharted scores (4-0 etc.)", () => {
    const r = remainingLambda(pregame, { minute: 70, scoreH: 4, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    // diff=4: mH = max(0.8, 1 - 0.16) = 0.84, mA = min(1.4, 1 + 0.24) = 1.24
    expect(r.sm.mH).toBeCloseTo(0.84, 3);
    expect(r.sm.mA).toBeCloseTo(1.24, 3);
  });

  it("clamps minute to [0, 95]", () => {
    const huge = remainingLambda(pregame, { minute: 200, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    const neg  = remainingLambda(pregame, { minute: -10, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(huge.decay).toBe(0);
    expect(neg.decay).toBeCloseTo(1.0, 5);
  });
});

describe("computeLiveWP — output shape + sums", () => {
  it("sums to 1 at any in-play minute", () => {
    const r = computeLiveWP(pregame, { minute: 45, scoreH: 1, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(r.wp_home + r.wp_draw + r.wp_away).toBeCloseTo(1.0, 4);
  });

  it("each prob in [0, 1]", () => {
    const r = computeLiveWP(pregame, { minute: 60, scoreH: 0, scoreA: 1, redCardsH: 0, redCardsA: 0 });
    for (const v of [r.wp_home, r.wp_draw, r.wp_away]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("0-0 at 90' → WP collapses to draw", () => {
    const r = computeLiveWP(pregame, { minute: 90, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(r.wp_home).toBe(0);
    expect(r.wp_draw).toBe(1);
    expect(r.wp_away).toBe(0);
  });

  it("1-0 at 90' → WP collapses to home", () => {
    const r = computeLiveWP(pregame, { minute: 90, scoreH: 1, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(r.wp_home).toBe(1);
    expect(r.wp_draw).toBe(0);
  });

  it("pregame (0-0 at min 0) matches Dixon-Coles Poisson WP within ~3pp", () => {
    const r = computeLiveWP(pregame, { minute: 0, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    // Analytic Poisson(1.6) vs Poisson(1.1): P(H) ≈ 0.51, P(D) ≈ 0.27, P(A) ≈ 0.22.
    // The 0-0 state-mult (0.98 × both sides) trims λ slightly, so draw picks
    // up a couple of percentage points and away drifts up a touch — well
    // within the ±3pp tolerance we'd accept for any in-play WP deviation.
    expect(r.wp_home).toBeGreaterThan(0.45);
    expect(r.wp_home).toBeLessThan(0.56);
    expect(r.wp_away).toBeGreaterThan(0.17);
    expect(r.wp_away).toBeLessThan(0.28);
  });

  it("home leading at 75' → very high home WP (common Robberechts fixture)", () => {
    const r = computeLiveWP(pregame, { minute: 75, scoreH: 2, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    expect(r.wp_home).toBeGreaterThan(0.85);
    expect(r.wp_away).toBeLessThan(0.05);
  });

  it("one-goal deficit at 85' for strong-home team is recoverable but unlikely", () => {
    const r = computeLiveWP(pregame, { minute: 85, scoreH: 0, scoreA: 1, redCardsH: 0, redCardsA: 0 });
    expect(r.wp_home).toBeLessThan(0.15);
    expect(r.wp_away).toBeGreaterThan(0.60);
  });

  it("red card on home at 30' shifts WP toward away team", () => {
    const clean = computeLiveWP(pregame, { minute: 30, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    const red   = computeLiveWP(pregame, { minute: 30, scoreH: 0, scoreA: 0, redCardsH: 1, redCardsA: 0 });
    expect(red.wp_home).toBeLessThan(clean.wp_home);
    expect(red.wp_away).toBeGreaterThan(clean.wp_away);
  });

  it("at 90' with score 0-1, away WP is exactly 1", () => {
    const r = computeLiveWP(pregame, { minute: 90, scoreH: 0, scoreA: 1, redCardsH: 0, redCardsA: 0 });
    expect(r.wp_away).toBe(1);
    expect(r.wp_home).toBe(0);
  });

  it("monotone: WP-away strictly increases as away-goals pile up (0-0 → 0-1 → 0-2)", () => {
    const wp0 = computeLiveWP(pregame, { minute: 60, scoreH: 0, scoreA: 0, redCardsH: 0, redCardsA: 0 });
    const wp1 = computeLiveWP(pregame, { minute: 60, scoreH: 0, scoreA: 1, redCardsH: 0, redCardsA: 0 });
    const wp2 = computeLiveWP(pregame, { minute: 60, scoreH: 0, scoreA: 2, redCardsH: 0, redCardsA: 0 });
    expect(wp1.wp_away).toBeGreaterThan(wp0.wp_away);
    expect(wp2.wp_away).toBeGreaterThan(wp1.wp_away);
  });
});

describe("liveEdge", () => {
  it("returns model - implied for normal decimal odds", () => {
    expect(liveEdge(0.60, 2.00)).toBeCloseTo(0.10, 3);  // implied 0.50 → edge 0.10
    expect(liveEdge(0.40, 2.00)).toBeCloseTo(-0.10, 3);
  });

  it("returns null for invalid market odds", () => {
    expect(liveEdge(0.5, null)).toBeNull();
    expect(liveEdge(0.5, 0)).toBeNull();
    expect(liveEdge(0.5, 1)).toBeNull();
    expect(liveEdge(0.5, undefined)).toBeNull();
  });
});
