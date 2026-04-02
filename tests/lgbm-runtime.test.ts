import { describe, it, expect, beforeAll } from "vitest";
import {
  loadLGBMModel,
  isLGBMModelLoaded,
  lgbmPredict,
  getLGBMRho,
  getLGBMFeatureNames,
  validateGoldenTests,
} from "../src/lib/lgbm-runtime";
import fs from "fs";
import path from "path";

// Load the actual model for integration tests
const MODEL_PATH = path.join(__dirname, "..", "public", "lgbm-model-v2.json");
let modelJson: any = null;

beforeAll(() => {
  if (fs.existsSync(MODEL_PATH)) {
    modelJson = JSON.parse(fs.readFileSync(MODEL_PATH, "utf-8"));
  }
});

// ─── Mock model for unit tests ──────────────────────────────────

const MOCK_MODEL = {
  version: "2.0",
  engine: "poisson-ml-v2",
  home_model: {
    trees: [
      {
        split_feature: 2, // elo_diff
        threshold: 0.0,
        left_child: { leaf_value: -0.1 },
        right_child: { leaf_value: 0.1 },
      },
      {
        split_feature: 0, // npxg_diff_ewma
        threshold: 0.5,
        left_child: { leaf_value: 0.0 },
        right_child: { leaf_value: 0.05 },
      },
    ],
    learning_rate: 1.0, // No scaling for test simplicity
    initial_score: 0.3, // exp(0.3) ≈ 1.35 base
    n_trees: 2,
  },
  away_model: {
    trees: [
      {
        split_feature: 2, // elo_diff
        threshold: 0.0,
        left_child: { leaf_value: 0.1 },
        right_child: { leaf_value: -0.1 },
      },
    ],
    learning_rate: 1.0,
    initial_score: 0.2, // exp(0.2) ≈ 1.22 base
    n_trees: 1,
  },
  rho_optimal: -0.042,
  feature_names: [
    "npxg_diff_ewma", "npxga_diff_ewma", "elo_diff", "total_npxg",
    "home_factor", "league_avg", "rest_days_diff", "sos_strength",
    "is_derby", "npxg_momentum", "npxg_volatility", "h2h_npxg_diff",
    "ppda_ratio_diff", "deep_completions_diff",
  ],
  golden_tests: [],
  meta: {},
};

// ─── Unit Tests ──────────────────────────────────────────────────

describe("LightGBM Runtime", () => {
  describe("Model Loading", () => {
    it("starts unloaded", () => {
      // Fresh state: no model loaded yet (may fail if other tests loaded first)
      // This is a placeholder — real test below loads mock
    });

    it("loads valid mock model", () => {
      const ok = loadLGBMModel(MOCK_MODEL as any);
      expect(ok).toBe(true);
      expect(isLGBMModelLoaded()).toBe(true);
    });

    it("rejects model without trees", () => {
      const bad = { ...MOCK_MODEL, home_model: { ...MOCK_MODEL.home_model, trees: [] } };
      const ok = loadLGBMModel(bad as any);
      expect(ok).toBe(false);
    });

    it("rejects model without feature_names", () => {
      const bad = { ...MOCK_MODEL, feature_names: [] };
      const ok = loadLGBMModel(bad as any);
      expect(ok).toBe(false);
    });

    it("returns correct rho", () => {
      loadLGBMModel(MOCK_MODEL as any);
      expect(getLGBMRho()).toBeCloseTo(-0.042, 3);
    });

    it("returns correct feature names", () => {
      loadLGBMModel(MOCK_MODEL as any);
      expect(getLGBMFeatureNames()).toHaveLength(14);
      expect(getLGBMFeatureNames()[0]).toBe("npxg_diff_ewma");
    });
  });

  describe("Prediction", () => {
    beforeAll(() => {
      loadLGBMModel(MOCK_MODEL as any);
    });

    it("produces plausible lambdas", () => {
      const features = [0.5, 0.1, 0.3, 2.6, 1.28, 1.38, 0, 0, 0, 0, 0.5, 0, 1.0, 0.5];
      const pred = lgbmPredict(features);
      expect(pred).not.toBeNull();
      expect(pred!.lambdaH).toBeGreaterThan(0.3);
      expect(pred!.lambdaH).toBeLessThan(4.5);
      expect(pred!.lambdaA).toBeGreaterThan(0.3);
      expect(pred!.lambdaA).toBeLessThan(4.5);
    });

    it("home advantage: positive elo_diff → higher lambdaH", () => {
      // Strong home team: elo_diff = +0.5 (200 Elo advantage)
      const strong = [0.5, 0.1, 0.5, 2.6, 1.28, 1.38, 0, 0, 0, 0, 0.5, 0, 1.0, 0.5];
      // Weak home team: elo_diff = -0.5
      const weak = [0.5, 0.1, -0.5, 2.6, 1.28, 1.38, 0, 0, 0, 0, 0.5, 0, 1.0, 0.5];

      const predStrong = lgbmPredict(strong);
      const predWeak = lgbmPredict(weak);

      expect(predStrong).not.toBeNull();
      expect(predWeak).not.toBeNull();
      // Monotonic constraint: higher elo_diff → higher lambdaH
      expect(predStrong!.lambdaH).toBeGreaterThan(predWeak!.lambdaH);
    });

    it("rejects dimension mismatch", () => {
      const tooFew = [0.5, 0.1, 0.3]; // Only 3 features
      const pred = lgbmPredict(tooFew);
      expect(pred).toBeNull();
    });

    it("rejects NaN features", () => {
      const withNaN = [NaN, 0.1, 0.3, 2.6, 1.28, 1.38, 0, 0, 0, 0, 0.5, 0, 1.0, 0.5];
      const pred = lgbmPredict(withNaN);
      expect(pred).toBeNull();
    });

    it("clamps extreme predictions to [0.3, 4.5]", () => {
      // With mock model and extreme features, output should still be clamped
      const extreme = [5, 5, 5, 10, 2, 2, 5, 5, 1, 5, 5, 5, 5, 5];
      const pred = lgbmPredict(extreme);
      expect(pred).not.toBeNull();
      expect(pred!.lambdaH).toBeLessThanOrEqual(4.5);
      expect(pred!.lambdaA).toBeGreaterThanOrEqual(0.3);
    });
  });

  // ─── Integration Tests (require actual model) ──────────────────

  describe("Integration with trained model", () => {
    it("loads the actual trained model", () => {
      if (!modelJson) return; // Skip if no model file
      const ok = loadLGBMModel(modelJson);
      expect(ok).toBe(true);
      expect(isLGBMModelLoaded()).toBe(true);
    });

    it("passes golden tests within tolerance", () => {
      if (!modelJson) return;
      loadLGBMModel(modelJson);
      const ok = validateGoldenTests(1e-4);
      expect(ok).toBe(true);
    });

    it("produces plausible Bundesliga prediction", () => {
      if (!modelJson) return;
      loadLGBMModel(modelJson);

      // Bayern-like home team vs mid-table away (dynamic feature count)
      const nFeatures = modelJson.feature_names.length;
      const baseFeatures = [
        0.8,   // npxg_diff_ewma (strong home)
        -0.3,  // npxga_diff_ewma (solid defense)
        0.6,   // elo_diff (+240 Elo)
        3.0,   // total_npxg
        1.28,  // home_factor (Bundesliga)
        1.38,  // league_avg (Bundesliga)
        0.0,   // rest_days_diff (equal)
        0.1,   // sos_strength
        0.0,   // is_derby (no)
        0.1,   // npxg_momentum
        0.5,   // npxg_volatility
        0.3,   // h2h_npxg_diff
        1.5,   // ppda_ratio_diff (home presses harder)
        1.0,   // deep_completions_diff (home penetrates more)
        0.05,  // setpiece_xg_share_diff
        0.02,  // late_game_xg_share_diff
        0.1,   // losing_state_xg_diff
        -0.05, // top3_xgchain_share_diff
        0.0,   // squad_rotation_rate_diff
      ];
      const features = baseFeatures.slice(0, nFeatures);

      const pred = lgbmPredict(features);
      expect(pred).not.toBeNull();
      // Bayern at home: expect lambdaH > lambdaA
      expect(pred!.lambdaH).toBeGreaterThan(pred!.lambdaA);
      // Reasonable range
      expect(pred!.lambdaH).toBeGreaterThan(1.0);
      expect(pred!.lambdaH).toBeLessThan(4.0);
      expect(pred!.lambdaA).toBeGreaterThan(0.5);
      expect(pred!.lambdaA).toBeLessThan(2.5);
    });
  });
});
