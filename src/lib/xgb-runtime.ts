// ═══════════════════════════════════════════════════════════════════════
// FODZE XGBoost Runtime — Pure TypeScript Decision Tree Evaluator
//
// Evaluates XGBoost models exported as JSON decision trees.
// No ONNX runtime needed — just walks trees and sums leaf values.
//
// For 200 trees with max_depth=4: ~500KB JSON, <1ms evaluation.
// ═══════════════════════════════════════════════════════════════════════

export interface XGBTreeNode {
  split_feature?: number;    // index into feature_names
  split_value?: number;      // threshold value
  left?: XGBTreeNode;        // <= split_value
  right?: XGBTreeNode;       // > split_value
  leaf_value?: number;       // terminal node prediction
}

export interface XGBModel {
  feature_names: string[];
  trees: XGBTreeNode[];
  base_score: number;
  target: string;            // "residual_H", "residual_D", "residual_A", "residual_O25"
  n_estimators?: number;
  max_depth?: number;
  training_rmse?: number;
  oos_rmse?: number;
}

export interface ResidualModels {
  H: XGBModel;
  D: XGBModel;
  A: XGBModel;
  O25?: XGBModel;
  version: string;
  trained_on_n_games: number;
}

/**
 * Evaluate a single decision tree node recursively.
 */
function evaluateTree(node: XGBTreeNode, features: number[]): number {
  // Leaf node — return prediction
  if (node.leaf_value !== undefined) {
    return node.leaf_value;
  }

  // Internal node — branch on feature value
  const featureVal = features[node.split_feature!];
  if (featureVal <= node.split_value!) {
    return evaluateTree(node.left!, features);
  } else {
    return evaluateTree(node.right!, features);
  }
}

/**
 * Predict the residual adjustment for one outcome.
 * Sums all tree predictions + base_score.
 *
 * @param model - Trained XGBoost model (JSON export)
 * @param features - Feature vector (ordered by model.feature_names)
 * @returns Residual adjustment (add to raw probability)
 */
export function xgbPredict(model: XGBModel, features: number[]): number {
  let sum = model.base_score;
  for (const tree of model.trees) {
    sum += evaluateTree(tree, features);
  }
  return sum;
}

/**
 * Build the feature vector for the residual model from match context.
 * Must match the order of feature_names used during training.
 */
export interface ResidualFeatures {
  is_derby: number;
  rest_diff: number;              // home_rest_days - away_rest_days
  is_sandwich_home: number;       // CL/EL midweek for home team
  is_sandwich_away: number;
  is_cup: number;
  home_manager_tenure_days: number;
  away_manager_tenure_days: number;
  league_position_diff: number;   // home_pos - away_pos (negative = home is higher)
  is_relegation_battle: number;   // both teams in bottom 5
  is_title_race: number;          // both teams in top 3
  model_prob_H: number;           // baseline Dixon-Coles probability
  model_prob_D: number;
  model_prob_A: number;
  total_lambda: number;           // lamH + lamA
  lambda_diff: number;            // lamH - lamA
}

/**
 * Convert ResidualFeatures to an ordered array matching model.feature_names.
 */
export function buildFeatureVector(
  model: XGBModel,
  features: ResidualFeatures
): number[] {
  return model.feature_names.map((name) => {
    const val = (features as any)[name];
    return typeof val === "number" ? val : 0;
  });
}

/**
 * Apply residual corrections to 1X2 probabilities.
 * Clamps individual probabilities to [0.01, 0.98] and renormalizes.
 */
export function applyResidualCorrections(
  rawH: number,
  rawD: number,
  rawA: number,
  deltaH: number,
  deltaD: number,
  deltaA: number
): { H: number; D: number; A: number } {
  let H = Math.max(0.01, Math.min(0.98, rawH + deltaH));
  let D = Math.max(0.01, Math.min(0.98, rawD + deltaD));
  let A = Math.max(0.01, Math.min(0.98, rawA + deltaA));

  // Renormalize to sum = 1.0
  const sum = H + D + A;
  if (sum > 0) {
    H /= sum;
    D /= sum;
    A /= sum;
  }

  return { H, D, A };
}

/**
 * Build features from match tags (DERBY, SANDWICH, etc.).
 * Converts FODZE tag strings to numeric features.
 */
export function tagsToResidualFeatures(
  tags: string[],
  modelProbH: number,
  modelProbD: number,
  modelProbA: number,
  totalLambda: number,
  lambdaDiff: number,
  extra?: Partial<ResidualFeatures>
): ResidualFeatures {
  const upperTags = tags.map((t) => t.toUpperCase().replace(/\s+/g, "-"));

  return {
    is_derby: upperTags.includes("DERBY") ? 1 : 0,
    rest_diff: extra?.rest_diff ?? 0,
    is_sandwich_home: upperTags.includes("SANDWICH") ? 1 : 0,
    is_sandwich_away: extra?.is_sandwich_away ?? 0,
    is_cup: upperTags.includes("POKAL") ? 1 : 0,
    home_manager_tenure_days: extra?.home_manager_tenure_days ?? 365,
    away_manager_tenure_days: extra?.away_manager_tenure_days ?? 365,
    league_position_diff: extra?.league_position_diff ?? 0,
    is_relegation_battle: upperTags.includes("ABSTIEGSKAMPF") ? 1 : 0,
    is_title_race: upperTags.includes("MEISTERKAMPF") ? 1 : 0,
    model_prob_H: modelProbH,
    model_prob_D: modelProbD,
    model_prob_A: modelProbA,
    total_lambda: totalLambda,
    lambda_diff: lambdaDiff,
  };
}
