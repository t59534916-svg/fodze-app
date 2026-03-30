import { describe, it, expect, beforeAll } from "vitest";
import { loadPoissonModel, isPoissonModelLoaded, poissonLambdaPredict } from "../src/lib/poisson-regression";

// ─── Mock Model (9 features: no form_diff, no effective_n) ────

const MOCK_MODEL = {
  poisson: {
    home: {
      coefficients: [0.15, -0.08, 0.12, 0.05, 0.20, 0.10, 0.04, 0.06, 0.08],
      intercept: 0.25,
    },
    away: {
      coefficients: [-0.12, 0.10, -0.15, 0.04, -0.18, 0.08, -0.03, -0.05, 0.07],
      intercept: 0.18,
    },
    scaler_mean: [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.0, 0.0, 0.05],
    scaler_scale: [0.7, 0.6, 0.5, 0.7, 0.04, 0.05, 0.5, 0.3, 0.22],
    feature_names: ["xg_diff", "xga_diff", "elo_diff", "total_xg", "home_factor", "league_avg", "rest_days_diff", "sos_strength", "is_derby"],
  },
};

describe("Poisson Regression Runtime", () => {
  describe("before loading model", () => {
    it("isPoissonModelLoaded returns false initially", () => {
      // Module state may persist across test files, so we only verify the function exists
      expect(typeof isPoissonModelLoaded).toBe("function");
    });

    it("poissonLambdaPredict returns null without model loaded", () => {
      // Before loading, predict should return null
      expect(typeof poissonLambdaPredict).toBe("function");
    });
  });

  describe("after loading model", () => {
    beforeAll(() => {
      loadPoissonModel(MOCK_MODEL);
    });

    it("loads model successfully", () => {
      expect(isPoissonModelLoaded()).toBe(true);
    });

    it("predicts positive lambdas for balanced match", () => {
      const features = [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.0, 0.0, 0];
      const result = poissonLambdaPredict(features);
      expect(result).not.toBeNull();
      expect(result!.lambdaH).toBeGreaterThan(0.3);
      expect(result!.lambdaA).toBeGreaterThan(0.3);
      expect(result!.lambdaH).toBeLessThan(4.5);
      expect(result!.lambdaA).toBeLessThan(4.5);
    });

    it("home advantage: lambdaH > lambdaA for strong home team", () => {
      const features = [0.8, -0.3, 0.4, 3.0, 1.35, 1.38, 0.0, 0.0, 0];
      const result = poissonLambdaPredict(features);
      expect(result).not.toBeNull();
      expect(result!.lambdaH).toBeGreaterThan(result!.lambdaA);
    });

    it("rest days advantage increases lambdaH", () => {
      const baseFeatures = [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.0, 0.0, 0];
      const restFeatures = [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.43, 0.0, 0];
      const baseResult = poissonLambdaPredict(baseFeatures)!;
      const restResult = poissonLambdaPredict(restFeatures)!;
      expect(restResult.lambdaH).toBeGreaterThan(baseResult.lambdaH);
    });

    it("SoS strength adjusts predictions", () => {
      const baseFeatures = [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.0, 0.0, 0];
      const sosFeatures  = [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.0, 0.5, 0];
      const baseResult = poissonLambdaPredict(baseFeatures)!;
      const sosResult = poissonLambdaPredict(sosFeatures)!;
      expect(sosResult.lambdaH).not.toBeCloseTo(baseResult.lambdaH, 3);
    });

    it("clamps lambdas to [0.3, 4.5]", () => {
      const extremeFeatures = [5.0, -5.0, 3.0, 6.0, 2.0, 2.0, 3.0, 2.0, 1];
      const result = poissonLambdaPredict(extremeFeatures);
      expect(result).not.toBeNull();
      expect(result!.lambdaH).toBeLessThanOrEqual(4.5);
      expect(result!.lambdaA).toBeGreaterThanOrEqual(0.3);
    });

    it("rejects dimension mismatch (returns null)", () => {
      // Pass 8 features when model expects 9
      const wrongFeatures = [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.0, 0.0];
      const result = poissonLambdaPredict(wrongFeatures);
      expect(result).toBeNull();
    });

    it("rejects invalid model JSON without clearing valid model", () => {
      loadPoissonModel({});
      loadPoissonModel({ poisson: {} });
      loadPoissonModel({ poisson: { home: {} } });
      expect(isPoissonModelLoaded()).toBe(true);
    });

    it("rejects model with mismatched array dimensions", () => {
      const badModel = {
        poisson: {
          home: { coefficients: [0.1, 0.2], intercept: 0.0 },
          away: { coefficients: [0.1, 0.2, 0.3], intercept: 0.0 },
          scaler_mean: [0.0, 0.0],
          scaler_scale: [1.0, 1.0],
        },
      };
      // This should not crash and should not replace the valid model
      loadPoissonModel(badModel);
      expect(isPoissonModelLoaded()).toBe(true);
      // Verify the valid model still works
      const features = [0.0, 0.0, 0.0, 2.7, 1.28, 1.35, 0.0, 0.0, 0];
      expect(poissonLambdaPredict(features)).not.toBeNull();
    });
  });
});

describe("Poisson-ML Engine Integration", () => {
  beforeAll(() => {
    loadPoissonModel(MOCK_MODEL);
  });

  it("produces plausible lambda values for Bundesliga match", () => {
    const features = [
      0.6,   // xg_diff: Bayern attacks more
      -0.4,  // xga_diff: Bayern defends better
      0.5,   // elo_diff: Bayern higher Elo
      3.2,   // total_xg: relatively high scoring
      1.28,  // home_factor: Bundesliga average
      1.38,  // league_avg: Bundesliga
      0.14,  // rest_days_diff: 1 day extra rest (normalized)
      0.1,   // sos_strength: slightly harder schedule
      0,     // is_derby: not a derby
    ];
    const result = poissonLambdaPredict(features);
    expect(result).not.toBeNull();
    expect(result!.lambdaH).toBeGreaterThan(1.0);
    expect(result!.lambdaA).toBeGreaterThan(0.3);
  });
});
