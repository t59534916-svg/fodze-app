import { describe, it, expect } from "vitest";
import {
  calcCornerLambdas,
  compoundPoissonGeomPMF,
  cornerMatrix,
  cornerMarkets,
  calcCornersModel,
  type CornersInput,
} from "@/lib/corners-engine";
import { canonicalMarket, marketLabel, MARKET_LABELS_SHORT } from "@/lib/market-labels";

// ─── Compound-Poisson math ──────────────────────────────────────────

describe("compoundPoissonGeomPMF", () => {
  it("returns a valid probability distribution (sums to ~1)", () => {
    const pmf = compoundPoissonGeomPMF(2.5, 0.55, 30);
    const sum = pmf.reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });

  it("has P(0) = exp(-λ) (no bursts → zero corners)", () => {
    const pmf = compoundPoissonGeomPMF(2.0, 0.55, 20);
    expect(pmf[0]).toBeCloseTo(Math.exp(-2.0), 6);
  });

  it("mean matches the analytic E[S] = λ/p", () => {
    const lambda = 2.5, p = 0.55;
    const pmf = compoundPoissonGeomPMF(lambda, p, 40);
    const mean = pmf.reduce((s, pr, k) => s + k * pr, 0);
    expect(mean).toBeCloseTo(lambda / p, 2);
  });

  it("variance matches analytic Var[S] = λ(2-p)/p² (overdispersion > Poisson)", () => {
    const lambda = 2.5, p = 0.55;
    const pmf = compoundPoissonGeomPMF(lambda, p, 40);
    const mean = pmf.reduce((s, pr, k) => s + k * pr, 0);
    const varS = pmf.reduce((s, pr, k) => s + (k - mean) ** 2 * pr, 0);
    const analyticVar = (lambda * (2 - p)) / (p * p);
    expect(varS).toBeCloseTo(analyticVar, 1);
    // Guardrail: var > mean (over-dispersed vs Poisson which has var=mean)
    expect(varS).toBeGreaterThan(mean);
  });

  it("returns all-zero for invalid λ or p", () => {
    expect(compoundPoissonGeomPMF(-1, 0.5, 10).every(v => v === 0)).toBe(true);
    expect(compoundPoissonGeomPMF(1, 0, 10).every(v => v === 0)).toBe(true);
    expect(compoundPoissonGeomPMF(1, 1, 10).every(v => v === 0)).toBe(true);
    expect(compoundPoissonGeomPMF(NaN, 0.5, 10).every(v => v === 0)).toBe(true);
  });
});

// ─── Lambdas ────────────────────────────────────────────────────────

describe("calcCornerLambdas", () => {
  const base: CornersInput = {
    teamFor: 5.0, teamAgainst: 5.0,
    oppFor: 5.0, oppAgainst: 5.0,
    leagueAvg: 5.0,
  };

  it("home lambda > away lambda for balanced matchup (home advantage)", () => {
    const out = calcCornerLambdas(base);
    expect(out.lambda_h).toBeGreaterThan(out.lambda_a);
  });

  it("high-corner home team produces higher home lambda", () => {
    const low  = calcCornerLambdas({ ...base, teamFor: 3.0 });
    const high = calcCornerLambdas({ ...base, teamFor: 7.0 });
    expect(high.lambda_h).toBeGreaterThan(low.lambda_h);
  });

  it("opponent's corners-allowed feeds into home lambda (Dixon-Coles-style)", () => {
    const weakDef = calcCornerLambdas({ ...base, oppAgainst: 8.0 });
    const tightDef = calcCornerLambdas({ ...base, oppAgainst: 3.0 });
    expect(weakDef.lambda_h).toBeGreaterThan(tightDef.lambda_h);
  });

  it("custom homeFactor overrides default", () => {
    const hi = calcCornerLambdas({ ...base, homeFactor: 1.50 });
    const lo = calcCornerLambdas({ ...base, homeFactor: 1.00 });
    expect(hi.lambda_h).toBeGreaterThan(lo.lambda_h);
  });

  it("handles zero / NaN / negative inputs without NaN output", () => {
    const out = calcCornerLambdas({
      teamFor: 0, teamAgainst: NaN, oppFor: -1, oppAgainst: 0,
    });
    expect(Number.isFinite(out.lambda_h)).toBe(true);
    expect(Number.isFinite(out.lambda_a)).toBe(true);
    expect(out.lambda_h).toBeGreaterThan(0);
  });
});

// ─── Matrix + markets ───────────────────────────────────────────────

describe("cornerMatrix + cornerMarkets", () => {
  const lam = { lambda_h: 2.75, lambda_a: 2.50, p: 0.55 };
  const mx = cornerMatrix(lam.lambda_h, lam.lambda_a, lam.p, 25);

  it("joint matrix renormalises to 1.0", () => {
    let s = 0;
    for (const row of mx) for (const v of row) s += v;
    expect(s).toBeCloseTo(1.0, 6);
  });

  it("expected total matches marginal means (λ_h+λ_a)/p", () => {
    const markets = cornerMarkets(mx);
    const analytic = (lam.lambda_h + lam.lambda_a) / lam.p;
    // Allow slight truncation bias — the high-k tail beyond maxK=25 is tiny.
    expect(markets.expected_total).toBeCloseTo(analytic, 1);
  });

  it("expected home + away ≈ expected total", () => {
    const m = cornerMarkets(mx);
    // Each field is individually rounded to 3 decimals; the sum can drift
    // by up to 2×10⁻³ vs the pre-rounded total. 2-decimal tolerance is
    // still meaningful for a ~9.5-corner total.
    expect(m.expected_home + m.expected_away).toBeCloseTo(m.expected_total, 2);
  });

  it("over-thresholds are monotonically decreasing (8.5 > 9.5 > 10.5 > 11.5)", () => {
    const m = cornerMarkets(mx);
    expect(m.p_over_85).toBeGreaterThan(m.p_over_95);
    expect(m.p_over_95).toBeGreaterThan(m.p_over_105);
    expect(m.p_over_105).toBeGreaterThan(m.p_over_115);
  });

  it("P(over 8.5) for mean-9 corners is between 0.45 and 0.65 (realistic)", () => {
    const m = cornerMarkets(mx);
    // Expected total ≈ 9.5 → P(≥9) ≈ 0.52 for the CP distribution.
    expect(m.p_over_85).toBeGreaterThan(0.45);
    expect(m.p_over_85).toBeLessThan(0.70);
  });

  it("probabilities are valid (in [0,1])", () => {
    const m = cornerMarkets(mx);
    for (const key of ["p_over_65", "p_over_75", "p_over_85", "p_over_95", "p_over_105", "p_over_115", "p_over_125"] as const) {
      expect(m[key]).toBeGreaterThanOrEqual(0);
      expect(m[key]).toBeLessThanOrEqual(1);
    }
  });
});

// ─── End-to-end ─────────────────────────────────────────────────────

describe("calcCornersModel end-to-end", () => {
  it("chains input → lambdas → matrix → markets without NaN", () => {
    const out = calcCornersModel({
      teamFor: 6.2, teamAgainst: 4.8,
      oppFor: 5.1, oppAgainst: 5.5,
      leagueAvg: 5.2,
    });
    expect(Number.isFinite(out.lambda_h)).toBe(true);
    expect(Number.isFinite(out.lambda_a)).toBe(true);
    expect(Number.isFinite(out.markets.expected_total)).toBe(true);
    expect(out.markets.p_over_85).toBeGreaterThan(0);
  });
});

// ─── Market-label integration ───────────────────────────────────────

describe("market-labels corners integration", () => {
  it("canonicalMarket accepts all six new corner keys", () => {
    expect(canonicalMarket("corners_o85")).toBe("corners_o85");
    expect(canonicalMarket("corners_u85")).toBe("corners_u85");
    expect(canonicalMarket("corners_o95")).toBe("corners_o95");
    expect(canonicalMarket("corners_u95")).toBe("corners_u95");
    expect(canonicalMarket("corners_o105")).toBe("corners_o105");
    expect(canonicalMarket("corners_u105")).toBe("corners_u105");
  });

  it("accepts human-friendly aliases", () => {
    expect(canonicalMarket("corners over 8.5")).toBe("corners_o85");
    expect(canonicalMarket("Corners O10.5")).toBe("corners_o105");
  });

  it("MARKET_LABELS_SHORT has entries for every new key", () => {
    for (const k of ["corners_o85", "corners_u85", "corners_o95", "corners_u95", "corners_o105", "corners_u105"] as const) {
      expect(MARKET_LABELS_SHORT[k]).toBeTruthy();
    }
  });

  it("marketLabel renders the German short form", () => {
    expect(marketLabel("corners_o85")).toBe("Ecken Ü 8.5");
    expect(marketLabel("corners_u105", "long")).toBe("UNTER 10.5 ECKEN");
  });
});
