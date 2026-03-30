// ═══════════════════════════════════════════════════════════════════
// LightGBM Tree Traversal Runtime — @annafrick13 v2.0
//
// Browser-side inference for LightGBM Tweedie models.
// Deterministic tree traversal with exp() log-link.
// No StandardScaler needed — trees handle raw values natively.
// ═══════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────

interface TreeNode {
  split_feature?: number;
  threshold?: number;
  left_child?: TreeNode;
  right_child?: TreeNode;
  leaf_value?: number;
}

interface LGBMModelData {
  trees: TreeNode[];
  learning_rate: number;
  initial_score: number;
  n_trees: number;
}

interface LGBMModelV2 {
  version: string;
  engine: string;
  home_model: LGBMModelData;
  away_model: LGBMModelData;
  rho_optimal: number;
  feature_names: string[];
  golden_tests: GoldenTest[];
  meta: Record<string, unknown>;
}

interface GoldenTest {
  features: number[];
  expected_h: number;
  expected_a: number;
  match: string;
}

// ─── Module State ────────────────────────────────────────────────

let model: LGBMModelV2 | null = null;

// ─── Tree Traversal ──────────────────────────────────────────────

function traverseTree(node: TreeNode, features: number[]): number {
  // Leaf node: return value
  if (node.leaf_value !== undefined) return node.leaf_value;

  // Internal node: split and recurse
  const val = features[node.split_feature!];
  return val <= node.threshold!
    ? traverseTree(node.left_child!, features)
    : traverseTree(node.right_child!, features);
}

function predictSingle(modelData: LGBMModelData, features: number[]): number {
  // LightGBM dump_model() leaf values already include learning_rate and init_score.
  // The raw prediction is simply the sum of all leaf values across all trees.
  let score = 0;
  for (const tree of modelData.trees) {
    score += traverseTree(tree, features);
  }
  // Tweedie log-link: lambda = exp(score)
  return Math.exp(score);
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Load the LightGBM v2 model from JSON.
 * Validates tree structure and feature dimensions.
 */
export function loadLGBMModel(json: LGBMModelV2): boolean {
  // Validate structure
  if (!json.home_model?.trees?.length || !json.away_model?.trees?.length) {
    console.error("[lgbm-runtime] Invalid model: missing trees");
    return false;
  }

  if (!json.feature_names?.length) {
    console.error("[lgbm-runtime] Invalid model: missing feature_names");
    return false;
  }

  // Validate golden tests match (optional but recommended)
  if (json.golden_tests?.length) {
    const g = json.golden_tests[0];
    if (g.features.length !== json.feature_names.length) {
      console.error(
        `[lgbm-runtime] Feature dimension mismatch: golden=${g.features.length} vs names=${json.feature_names.length}`
      );
      return false;
    }
  }

  model = json;
  console.log(
    `[lgbm-runtime] Loaded v2 model: ${json.home_model.n_trees}H + ${json.away_model.n_trees}A trees, ` +
    `${json.feature_names.length} features, rho=${json.rho_optimal}`
  );
  return true;
}

/**
 * Check if the v2 model is loaded.
 */
export function isLGBMModelLoaded(): boolean {
  return model !== null;
}

/**
 * Get the optimal rho from the trained model.
 */
export function getLGBMRho(): number {
  return model?.rho_optimal ?? -0.05;
}

/**
 * Get feature names for debugging.
 */
export function getLGBMFeatureNames(): string[] {
  return model?.feature_names ?? [];
}

/**
 * Predict lambdaH and lambdaA from a 13-feature vector.
 * Returns null if model not loaded or dimension mismatch.
 */
export function lgbmPredict(
  features: number[]
): { lambdaH: number; lambdaA: number } | null {
  if (!model) {
    console.error("[lgbm-runtime] Model not loaded");
    return null;
  }

  // Dimension guard
  if (features.length !== model.feature_names.length) {
    console.error(
      `[lgbm-runtime] Feature dimension mismatch: got ${features.length}, expected ${model.feature_names.length}`
    );
    return null;
  }

  // NaN guard
  if (features.some((f) => isNaN(f) || !isFinite(f))) {
    console.error("[lgbm-runtime] NaN/Infinity in features");
    return null;
  }

  const rawH = predictSingle(model.home_model, features);
  const rawA = predictSingle(model.away_model, features);

  // Clamp to plausible Poisson range
  const lambdaH = Math.max(0.3, Math.min(4.5, rawH));
  const lambdaA = Math.max(0.3, Math.min(4.5, rawA));

  return { lambdaH, lambdaA };
}

/**
 * Validate model against golden test fixtures.
 * Returns true if all predictions match within tolerance.
 */
export function validateGoldenTests(tolerance = 1e-4): boolean {
  if (!model?.golden_tests?.length) return true;

  let allPass = true;
  for (const g of model.golden_tests) {
    const pred = lgbmPredict(g.features);
    if (!pred) {
      console.error(`[lgbm-runtime] Golden test failed: ${g.match} — null prediction`);
      allPass = false;
      continue;
    }

    const diffH = Math.abs(pred.lambdaH - g.expected_h);
    const diffA = Math.abs(pred.lambdaA - g.expected_a);

    if (diffH > tolerance || diffA > tolerance) {
      console.error(
        `[lgbm-runtime] Golden test failed: ${g.match} — ` +
        `H: ${pred.lambdaH.toFixed(4)} vs ${g.expected_h.toFixed(4)} (diff=${diffH.toFixed(6)}), ` +
        `A: ${pred.lambdaA.toFixed(4)} vs ${g.expected_a.toFixed(4)} (diff=${diffA.toFixed(6)})`
      );
      allPass = false;
    }
  }

  if (allPass) {
    console.log(`[lgbm-runtime] All ${model.golden_tests.length} golden tests passed`);
  }
  return allPass;
}
