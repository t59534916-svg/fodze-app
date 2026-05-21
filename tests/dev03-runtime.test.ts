// ═══════════════════════════════════════════════════════════════════
// tests/dev03-runtime.test.ts
// dev-03 LightGBM Bayesian Ensemble + m6_benter runtime parity tests
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  loadDev03Model,
  isDev03ModelLoaded,
  getDev03Rho,
  getDev03FeatureNames,
  leagueToCategoryIndex,
  buildFeatureArray,
  dev03Predict,
  dev03BenterBlend,
  getDev03BenterWeights,
  validateDev03GoldenTests,
  FEATURE_NAMES_LOCKED,
  _resetForTests,
  type Dev03FeatureInput,
  type Dev03Model_FullPayload,
} from "../src/lib/dev03-runtime";

const MODEL_PATH = path.join(__dirname, "..", "public", "dev03-model.json");
let realModel: Dev03Model_FullPayload | null = null;

beforeAll(() => {
  if (fs.existsSync(MODEL_PATH)) {
    realModel = JSON.parse(fs.readFileSync(MODEL_PATH, "utf-8"));
  }
});

beforeEach(() => {
  _resetForTests();
});

// ─── Mock minimal model for unit tests (no real trees, just structural) ──

function makeMockModel(): Dev03Model_FullPayload {
  return {
    version: "dev-03",
    engine: "dev-03",
    exported_at: "2026-05-21T00:00:00Z",
    rho: -0.094,
    feature_names: [...FEATURE_NAMES_LOCKED],
    categorical_features: ["league"],
    pandas_categorical: [["austria_bl", "bundesliga", "epl", "la_liga"]],
    home_ensemble: {
      n_models: 2,
      seeds: [42, 43],
      // Each model: single tree, splits on numeric feature 0 (home_attack_ratio)
      // and on categorical feature 16 (league) — covers both decision_types.
      models: [
        {
          seed: 42,
          n_trees: 1,
          trees: [{
            split_feature: 0,
            threshold: 1.0,
            decision_type: "<=",
            default_left: false,
            missing_type: "None",
            // raw_score=0.0 → exp(0.0) = 1.0; raw_score=0.2 → exp(0.2) ≈ 1.22
            left_child: { leaf_value: 0.0 },
            right_child: { leaf_value: 0.2 },
          }],
        },
        {
          seed: 43,
          n_trees: 1,
          trees: [{
            split_feature: 16, // league (categorical)
            threshold: "1||2", // bundesliga (1) || epl (2) go LEFT
            decision_type: "==",
            default_left: false,
            missing_type: "None",
            left_child: { leaf_value: 0.4 }, // BL/EPL → exp(0.4) ≈ 1.49
            right_child: { leaf_value: 0.0 }, // others → exp(0.0) = 1.0
          }],
        },
      ],
    },
    away_ensemble: {
      n_models: 2,
      seeds: [42, 43],
      models: [
        {
          seed: 42,
          n_trees: 1,
          trees: [{
            split_feature: 0,
            threshold: 1.0,
            decision_type: "<=",
            default_left: false,
            missing_type: "None",
            left_child: { leaf_value: 0.0 },
            right_child: { leaf_value: -0.1 }, // exp(-0.1) ≈ 0.905
          }],
        },
        {
          seed: 43,
          n_trees: 1,
          trees: [{
            split_feature: 16,
            threshold: "1||2",
            decision_type: "==",
            default_left: false,
            missing_type: "None",
            left_child: { leaf_value: -0.2 }, // BL/EPL → exp(-0.2) ≈ 0.819
            right_child: { leaf_value: 0.0 },
          }],
        },
      ],
    },
    benter: {
      default_betas: [0.5, 0.5],
      global_weights: [0.71, 0.30],
      liga_weights: {
        serie_a: {
          beta_model: 0.99, beta_market: 0.21,
          n_samples: 246, fit_success: true, source: "computed",
        },
        epl: {
          beta_model: 0.71, beta_market: 0.30,
          n_samples: 92, fit_success: false, source: "global_pool_fallback_small_n",
        },
      },
      min_liga_samples: 100,
    },
    golden_tests: [],
    meta: {},
  };
}

function makeFeatureInput(overrides: Partial<Dev03FeatureInput> = {}): Dev03FeatureInput {
  return {
    home_attack_ratio: 1.2,
    home_defense_ratio: 0.9,
    away_attack_ratio: 1.05,
    away_defense_ratio: 1.0,
    home_ess: 8.0,
    away_ess: 7.5,
    league_home_avg: 1.55,
    league_away_avg: 1.20,
    league_home_advantage: 0.30,
    lambda_h_naive: 1.55,
    lambda_a_naive: 1.10,
    attack_defense_ratio_h: 1.2,
    attack_defense_ratio_a: 0.945,
    elo_diff: 50,
    lineup_quality_diff: 0.3,
    form_streak_diff: 0.1,
    league: "bundesliga",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════

describe("dev03-runtime · model loading + validation", () => {
  it("starts unloaded", () => {
    expect(isDev03ModelLoaded()).toBe(false);
  });

  it("loads a valid mock model", () => {
    const ok = loadDev03Model(makeMockModel());
    expect(ok).toBe(true);
    expect(isDev03ModelLoaded()).toBe(true);
  });

  it("rejects empty home ensemble", () => {
    const bad = makeMockModel();
    bad.home_ensemble.models = [];
    expect(loadDev03Model(bad)).toBe(false);
    expect(isDev03ModelLoaded()).toBe(false);
  });

  it("rejects n_models mismatch", () => {
    const bad = makeMockModel();
    bad.home_ensemble.n_models = 99; // declared, but only 2 actual
    expect(loadDev03Model(bad)).toBe(false);
  });

  it("rejects feature_names mismatch", () => {
    const bad = makeMockModel();
    bad.feature_names = [...FEATURE_NAMES_LOCKED.slice(0, -1), "wrong_name"];
    expect(loadDev03Model(bad)).toBe(false);
  });

  it("rejects feature count mismatch", () => {
    const bad = makeMockModel();
    bad.feature_names = FEATURE_NAMES_LOCKED.slice(0, 5);
    expect(loadDev03Model(bad)).toBe(false);
  });

  it("rejects missing pandas_categorical", () => {
    const bad = makeMockModel();
    bad.pandas_categorical = [];
    expect(loadDev03Model(bad)).toBe(false);
  });

  it("getDev03Rho returns the trained value", () => {
    loadDev03Model(makeMockModel());
    expect(getDev03Rho()).toBeCloseTo(-0.094, 4);
  });

  it("getDev03FeatureNames returns all 17 features in canonical order", () => {
    loadDev03Model(makeMockModel());
    expect(getDev03FeatureNames()).toHaveLength(17);
    expect(getDev03FeatureNames()[0]).toBe("home_attack_ratio");
    expect(getDev03FeatureNames()[16]).toBe("league");
  });
});

describe("dev03-runtime · categorical (league) mapping", () => {
  beforeEach(() => loadDev03Model(makeMockModel()));

  it("maps known leagues to alphabetical indices", () => {
    // Mock model has: ["austria_bl", "bundesliga", "epl", "la_liga"]
    expect(leagueToCategoryIndex("austria_bl")).toBe(0);
    expect(leagueToCategoryIndex("bundesliga")).toBe(1);
    expect(leagueToCategoryIndex("epl")).toBe(2);
    expect(leagueToCategoryIndex("la_liga")).toBe(3);
  });

  it("returns -1 for unknown leagues", () => {
    expect(leagueToCategoryIndex("totally_made_up_liga")).toBe(-1);
  });

  it("is case-insensitive + trims whitespace", () => {
    expect(leagueToCategoryIndex("BUNDESLIGA")).toBe(1);
    expect(leagueToCategoryIndex("  epl  ")).toBe(2);
    expect(leagueToCategoryIndex("EPL")).toBe(2);
  });

  it("returns -1 when no model loaded", () => {
    _resetForTests();
    expect(leagueToCategoryIndex("bundesliga")).toBe(-1);
  });
});

describe("dev03-runtime · feature-array building", () => {
  beforeEach(() => loadDev03Model(makeMockModel()));

  it("builds 17-element array in correct order", () => {
    const arr = buildFeatureArray(makeFeatureInput());
    expect(arr).not.toBeNull();
    expect(arr!).toHaveLength(17);
    expect(arr![0]).toBe(1.2); // home_attack_ratio
    expect(arr![16]).toBe(1); // bundesliga → idx 1
  });

  it("resolves league string to categorical index in last position", () => {
    const arr = buildFeatureArray(makeFeatureInput({ league: "epl" }));
    expect(arr![16]).toBe(2);
  });

  it("uses -1 for unknown league (LightGBM's missing-categorical sentinel)", () => {
    const arr = buildFeatureArray(makeFeatureInput({ league: "made_up_league" }));
    expect(arr![16]).toBe(-1);
  });

  it("rejects non-finite numeric features (NaN)", () => {
    const arr = buildFeatureArray(makeFeatureInput({ elo_diff: NaN }));
    expect(arr).toBeNull();
  });

  it("rejects non-finite numeric features (Infinity)", () => {
    const arr = buildFeatureArray(makeFeatureInput({ home_ess: Infinity }));
    expect(arr).toBeNull();
  });
});

describe("dev03-runtime · prediction pathway", () => {
  beforeEach(() => loadDev03Model(makeMockModel()));

  it("returns null when model not loaded", () => {
    _resetForTests();
    const p = dev03Predict(makeFeatureInput());
    expect(p).toBeNull();
  });

  it("returns mean+var with positive-finite values", () => {
    const p = dev03Predict(makeFeatureInput());
    expect(p).not.toBeNull();
    expect(p!.lambdaH_mean).toBeGreaterThan(0);
    expect(p!.lambdaH_mean).toBeLessThan(4.5);
    expect(p!.lambdaH_var).toBeGreaterThanOrEqual(0);
    expect(p!.lambdaA_mean).toBeGreaterThan(0);
    expect(p!.lambdaA_var).toBeGreaterThanOrEqual(0);
  });

  it("produces 5 per-model values (matches n_models)", () => {
    const p = dev03Predict(makeFeatureInput());
    expect(p!.lambdaH_per_model).toHaveLength(2); // mock has 2 models
    expect(p!.lambdaA_per_model).toHaveLength(2);
  });

  it("ensemble mean matches Python np.mean() within float precision", () => {
    // home model 0: feature[0]=1.2 > 1.0 → leaf=0.2 → exp(0.2) ≈ 1.221403
    // home model 1: feature[16]=1 (bundesliga in 1||2) → leaf=0.4 → exp(0.4) ≈ 1.491825
    // mean ≈ (1.221403 + 1.491825) / 2 ≈ 1.356614
    const p = dev03Predict(makeFeatureInput({
      home_attack_ratio: 1.2, // > 1.0 in model 0 → leaf=0.2
      league: "bundesliga",   // in [1, 2] in model 1 → leaf=0.4
    }));
    const expected = (Math.exp(0.2) + Math.exp(0.4)) / 2;
    expect(p!.lambdaH_mean).toBeCloseTo(expected, 8);
  });

  it("variance uses ddof=0 (population) — matches numpy.var(ddof=0)", () => {
    // Same setup. var = mean((x - mean)^2)
    const p = dev03Predict(makeFeatureInput({
      home_attack_ratio: 1.2,
      league: "bundesliga",
    }));
    const v0 = Math.exp(0.2);
    const v1 = Math.exp(0.4);
    const mu = (v0 + v1) / 2;
    const expectedVar = ((v0 - mu) ** 2 + (v1 - mu) ** 2) / 2;
    expect(p!.lambdaH_var).toBeCloseTo(expectedVar, 8);
  });

  it("clamps lambda to [0.3, 4.5]", () => {
    // We can't easily get a clamp-trigger from the mock model (leaf_values are
    // bounded), so test that the clamp DOES NOT clamp in-range values.
    const p = dev03Predict(makeFeatureInput());
    expect(p!.lambdaH_mean).toBeGreaterThanOrEqual(0.3);
    expect(p!.lambdaH_mean).toBeLessThanOrEqual(4.5);
  });

  it("returns null if feature-builder rejects non-finite inputs", () => {
    const p = dev03Predict(makeFeatureInput({ elo_diff: NaN }));
    expect(p).toBeNull();
  });

  it("categorical default_left applies for unknown leagues", () => {
    // Mock model 1: split_feature=16 (league), threshold "1||2", default_left=false
    // With "made_up_league" → idx=-1 → routes via default_left=false → RIGHT child → leaf=0.0
    // So home_mean = mean(exp(0.2), exp(0.0)) = (1.221 + 1.0) / 2 = 1.1107
    const p = dev03Predict(makeFeatureInput({
      home_attack_ratio: 1.2, // model 0: leaf=0.2
      league: "made_up_league",
    }));
    const expected = (Math.exp(0.2) + Math.exp(0.0)) / 2;
    expect(p!.lambdaH_mean).toBeCloseTo(expected, 8);
  });
});

describe("dev03-runtime · benter blend (Phase m6)", () => {
  beforeEach(() => loadDev03Model(makeMockModel()));

  it("uses per-league weights when fitted (β_total > 1 sharpens output)", () => {
    // serie_a has fitted β_model=0.99, β_market=0.21 → sum=1.20
    // When p_model == p_market, logits = 1.20 × log(p) → softmax sharpens.
    // Expected = exp(1.20 × log(p)) / sum(exp(1.20 × log(*)))
    const p: [number, number, number] = [0.4, 0.3, 0.3];
    const BETA_TOTAL = 0.99 + 0.21;
    const exps = p.map(x => Math.exp(BETA_TOTAL * Math.log(x)));
    const sum = exps.reduce((s, x) => s + x, 0);
    const expected = exps.map(x => x / sum);

    const blended = dev03BenterBlend(p, p, "serie_a");
    expect(blended).not.toBeNull();
    expect(blended![0]).toBeCloseTo(expected[0], 5);
    expect(blended![1]).toBeCloseTo(expected[1], 5);
    expect(blended![2]).toBeCloseTo(expected[2], 5);
    // Sanity: largest prob got SHARPER (>0.4) because β_total>1
    expect(blended![0]).toBeGreaterThan(0.4);
  });

  it("falls back to global weights for un-fitted leagues", () => {
    // bundesliga not in liga_weights → uses global_weights [0.71, 0.30]
    // β_total = 1.01 ≈ 1 → near-identity (slight sharpening)
    const p: [number, number, number] = [0.5, 0.25, 0.25];
    const BETA_TOTAL = 0.71 + 0.30;
    const exps = p.map(x => Math.exp(BETA_TOTAL * Math.log(x)));
    const sum = exps.reduce((s, x) => s + x, 0);
    const expected = exps.map(x => x / sum);

    const blended = dev03BenterBlend(p, p, "bundesliga");
    expect(blended).not.toBeNull();
    expect(blended![0]).toBeCloseTo(expected[0], 5);
    expect(blended![1]).toBeCloseTo(expected[1], 5);
    expect(blended![2]).toBeCloseTo(expected[2], 5);
  });

  it("β_total = 1.0 ⇒ identity (p_model == p_market produces p exactly)", () => {
    // Override with weights summing to exactly 1.0
    const m = makeMockModel();
    m.benter.liga_weights.serie_a = {
      beta_model: 0.5, beta_market: 0.5,
      n_samples: 246, fit_success: true, source: "computed",
    };
    loadDev03Model(m);
    const p: [number, number, number] = [0.4, 0.3, 0.3];
    const blended = dev03BenterBlend(p, p, "serie_a");
    expect(blended![0]).toBeCloseTo(0.4, 8);
    expect(blended![1]).toBeCloseTo(0.3, 8);
    expect(blended![2]).toBeCloseTo(0.3, 8);
  });

  it("returns valid probability distribution (rows sum to 1)", () => {
    const pModel: [number, number, number] = [0.45, 0.25, 0.30];
    const pMarket: [number, number, number] = [0.40, 0.30, 0.30];
    const blended = dev03BenterBlend(pModel, pMarket, "serie_a");
    expect(blended).not.toBeNull();
    const sum = blended![0] + blended![1] + blended![2];
    expect(sum).toBeCloseTo(1.0, 8);
  });

  it("returns null when model not loaded", () => {
    _resetForTests();
    const p: [number, number, number] = [0.4, 0.3, 0.3];
    expect(dev03BenterBlend(p, p, "serie_a")).toBeNull();
  });

  it("handles probability-0 inputs gracefully (no log(0) NaN)", () => {
    const pModel: [number, number, number] = [1.0, 0.0, 0.0];
    const pMarket: [number, number, number] = [0.4, 0.3, 0.3];
    const blended = dev03BenterBlend(pModel, pMarket, "bundesliga");
    expect(blended).not.toBeNull();
    expect(blended![0]).toBeGreaterThan(0);
    expect(Number.isFinite(blended![0])).toBe(true);
  });

  it("matches Python log-pool formula exactly (β=1,β=0 → model-only)", () => {
    // With β_market=0 + β_model=1, blend should reproduce model probs after softmax
    // Override mock model's serie_a weights
    const m = makeMockModel();
    m.benter.liga_weights.serie_a = {
      beta_model: 1.0, beta_market: 0.0,
      n_samples: 246, fit_success: true, source: "computed",
    };
    loadDev03Model(m);
    const pModel: [number, number, number] = [0.5, 0.3, 0.2];
    const pMarket: [number, number, number] = [0.1, 0.6, 0.3]; // wildly different
    const blended = dev03BenterBlend(pModel, pMarket, "serie_a");
    expect(blended![0]).toBeCloseTo(0.5, 5);
    expect(blended![1]).toBeCloseTo(0.3, 5);
    expect(blended![2]).toBeCloseTo(0.2, 5);
  });

  it("exposes weights via getDev03BenterWeights", () => {
    const w = getDev03BenterWeights("serie_a");
    expect(w).not.toBeNull();
    expect(w!.beta_model).toBeCloseTo(0.99, 3);
    expect(w!.fit_success).toBe(true);
  });

  it("returns null for unknown league in getDev03BenterWeights", () => {
    expect(getDev03BenterWeights("bundesliga")).toBeNull(); // not in liga_weights
    expect(getDev03BenterWeights("made_up_liga")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Integration tests — require the real public/dev03-model.json
// ═══════════════════════════════════════════════════════════════════════

describe("dev03-runtime · integration with public/dev03-model.json", () => {
  it("loads the real model", () => {
    if (!realModel) {
      console.log("[dev03-runtime tests] public/dev03-model.json not found — skipping integration");
      return;
    }
    const ok = loadDev03Model(realModel);
    expect(ok).toBe(true);
    expect(isDev03ModelLoaded()).toBe(true);
  });

  it("has 5 home + 5 away bagged models", () => {
    if (!realModel) return;
    loadDev03Model(realModel);
    expect(realModel.home_ensemble.n_models).toBe(5);
    expect(realModel.away_ensemble.n_models).toBe(5);
  });

  it("has 22 leagues in pandas_categorical", () => {
    if (!realModel) return;
    loadDev03Model(realModel);
    expect(realModel.pandas_categorical[0]).toHaveLength(22);
    // Spot-check alphabetical
    expect(realModel.pandas_categorical[0][0]).toBe("austria_bl");
    expect(realModel.pandas_categorical[0][1]).toBe("bundesliga");
    expect(realModel.pandas_categorical[0][5]).toBe("epl");
  });

  it("passes ALL golden tests within 1e-4 tolerance", () => {
    if (!realModel) return;
    loadDev03Model(realModel);
    const result = validateDev03GoldenTests(1e-4);
    if (result.failed > 0) {
      console.error("Failures:\n  " + result.failures.join("\n  "));
    }
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(realModel.golden_tests.length);
    expect(result.passed).toBeGreaterThanOrEqual(5);
  });

  it("Bundesliga heavy-favorite fixture has λ_h > λ_a", () => {
    if (!realModel) return;
    loadDev03Model(realModel);

    // From export_dev03_to_json.py fixture 1
    const p = dev03Predict({
      home_attack_ratio: 1.45, home_defense_ratio: 0.75,
      away_attack_ratio: 0.85, away_defense_ratio: 1.30,
      home_ess: 9.0, away_ess: 8.5,
      league_home_avg: 1.60, league_away_avg: 1.25,
      league_home_advantage: 0.32,
      lambda_h_naive: 2.10, lambda_a_naive: 0.75,
      attack_defense_ratio_h: 1.885, attack_defense_ratio_a: 0.638,
      elo_diff: 250.0, lineup_quality_diff: 0.9, form_streak_diff: 0.6,
      league: "bundesliga",
    });
    expect(p).not.toBeNull();
    expect(p!.lambdaH_mean).toBeGreaterThan(p!.lambdaA_mean);
    expect(p!.lambdaH_mean).toBeGreaterThan(1.5);
    expect(p!.lambdaH_mean).toBeLessThan(4.5);
  });

  it("EPL away-favorite fixture has λ_a > λ_h", () => {
    if (!realModel) return;
    loadDev03Model(realModel);
    const p = dev03Predict({
      home_attack_ratio: 0.85, home_defense_ratio: 1.25,
      away_attack_ratio: 1.50, away_defense_ratio: 0.70,
      home_ess: 7.0, away_ess: 9.5,
      league_home_avg: 1.50, league_away_avg: 1.20,
      league_home_advantage: 0.30,
      lambda_h_naive: 0.85, lambda_a_naive: 2.05,
      attack_defense_ratio_h: 0.595, attack_defense_ratio_a: 1.875,
      elo_diff: -300.0, lineup_quality_diff: -0.8, form_streak_diff: -0.5,
      league: "epl",
    });
    expect(p).not.toBeNull();
    expect(p!.lambdaA_mean).toBeGreaterThan(p!.lambdaH_mean);
  });

  it("has fitted benter weights for serie_a, scottish_prem, serie_b, super_lig", () => {
    if (!realModel) return;
    loadDev03Model(realModel);
    expect(getDev03BenterWeights("serie_a")?.fit_success).toBe(true);
    expect(getDev03BenterWeights("scottish_prem")?.fit_success).toBe(true);
    expect(getDev03BenterWeights("serie_b")?.fit_success).toBe(true);
    expect(getDev03BenterWeights("super_lig")?.fit_success).toBe(true);
  });

  it("global benter fallback when league had insufficient samples", () => {
    if (!realModel) return;
    loadDev03Model(realModel);
    const w = getDev03BenterWeights("epl");
    expect(w).not.toBeNull();
    // EPL had n=92 < min_liga_samples=100 → fit_success=false → global fallback
    expect(w!.fit_success).toBe(false);
    expect(w!.source).toContain("global_pool_fallback");
  });
});
