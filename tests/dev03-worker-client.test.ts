// dev-03 Web Worker client tests.
//
// The vitest env has no `Worker` global, so `getOrSpawnWorker()` returns
// null and all calls fall through to sync `dev03Predict`. These tests
// verify the FALLBACK contract: the async API behaves identically to the
// sync API when no worker is available. The actual cross-thread parity
// is exercised in the production browser path (e2e); here we just verify
// the bridge does the right thing under SSR/test conditions.
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadDev03Model,
  dev03Predict,
  _resetForTests,
  type Dev03Model_FullPayload,
  type Dev03FeatureInput,
} from "@/lib/dev03-runtime";
import {
  ensureDev03Worker,
  isDev03WorkerReady,
  dev03PredictAsync,
  dev03PredictBatchAsync,
  terminateDev03Worker,
} from "@/lib/dev03-worker-client";

// Minimal valid model JSON for golden-test parity. We use the smallest
// possible tree: a single leaf node with a known value, so predict() is
// deterministic without needing a 7.5 MB fixture in the test bundle.
function makeMinimalModel(): Dev03Model_FullPayload {
  const leafTree = { leaf_value: 0.0 }; // exp(0) = 1.0 lambda
  return {
    home_ensemble: {
      n_models: 1,
      seeds: [42],
      models: [{ seed: 42, n_trees: 1, trees: [leafTree] }],
    },
    away_ensemble: {
      n_models: 1,
      seeds: [42],
      models: [{ seed: 42, n_trees: 1, trees: [leafTree] }],
    },
    feature_names: [
      "home_attack_ratio", "home_defense_ratio",
      "away_attack_ratio", "away_defense_ratio",
      "home_ess", "away_ess",
      "league_home_avg", "league_away_avg",
      "league_home_advantage",
      "lambda_h_naive", "lambda_a_naive",
      "attack_defense_ratio_h", "attack_defense_ratio_a",
      "elo_diff", "lineup_quality_diff", "form_streak_diff",
      "league",
    ],
    categorical_features: ["league"],
    pandas_categorical: [["bundesliga", "epl", "la_liga"]],
    rho: -0.094,
    benter_weights: null,
    golden_tests: [],
  };
}

const sampleInput: Dev03FeatureInput = {
  home_attack_ratio: 1.0, home_defense_ratio: 1.0,
  away_attack_ratio: 1.0, away_defense_ratio: 1.0,
  home_ess: 0.0, away_ess: 0.0,
  league_home_avg: 1.5, league_away_avg: 1.2,
  league_home_advantage: 0.3,
  lambda_h_naive: 1.5, lambda_a_naive: 1.2,
  attack_defense_ratio_h: 1.0, attack_defense_ratio_a: 1.0,
  elo_diff: 0, lineup_quality_diff: 0, form_streak_diff: 0,
  league: "bundesliga",
};

describe("dev03-worker-client (fallback path)", () => {
  beforeEach(() => {
    _resetForTests();
    terminateDev03Worker();
    loadDev03Model(makeMinimalModel());
  });

  it("isDev03WorkerReady() returns false before init in test env", () => {
    expect(isDev03WorkerReady()).toBe(false);
  });

  it("ensureDev03Worker() resolves to false when no Worker global", async () => {
    const ok = await ensureDev03Worker();
    // vitest env has no Worker → rpc throws → resolves false
    expect(ok).toBe(false);
    expect(isDev03WorkerReady()).toBe(false);
  });

  it("dev03PredictAsync() falls back to sync predict when no worker", async () => {
    const asyncResult = await dev03PredictAsync(sampleInput);
    const syncResult = dev03Predict(sampleInput);
    expect(asyncResult).not.toBeNull();
    expect(syncResult).not.toBeNull();
    // exact equality — async path is just a sync call when no worker
    expect(asyncResult).toEqual(syncResult);
  });

  it("dev03PredictAsync() returns null when model not loaded", async () => {
    _resetForTests();
    const r = await dev03PredictAsync(sampleInput);
    expect(r).toBeNull();
  });

  it("dev03PredictBatchAsync() handles empty input array", async () => {
    const r = await dev03PredictBatchAsync([]);
    expect(r).toEqual([]);
  });

  it("dev03PredictBatchAsync() matches sync N-call result element-wise", async () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      ...sampleInput,
      league_home_avg: 1.0 + i * 0.1, // vary one feature
    }));
    const batchResult = await dev03PredictBatchAsync(inputs);
    const syncResults = inputs.map(i => dev03Predict(i));
    expect(batchResult).toHaveLength(syncResults.length);
    for (let i = 0; i < inputs.length; i++) {
      expect(batchResult[i]).toEqual(syncResults[i]);
    }
  });

  it("terminateDev03Worker() is idempotent + safe to call without spawn", () => {
    expect(() => terminateDev03Worker()).not.toThrow();
    expect(() => terminateDev03Worker()).not.toThrow();
    expect(isDev03WorkerReady()).toBe(false);
  });
});
