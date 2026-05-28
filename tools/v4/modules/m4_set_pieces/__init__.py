"""v4.modules.m4_set_pieces — XGBoost binary classifier for setpiece-shot goals.

Pipeline: setpiece shot (situation + body_part + coords + minute) → P(goal | shot).

Public API:
  SetPiecePredictor        — XGBoost wrapper, fit/predict/save/load
  build_shot_features      — raw shots → feature matrix (16 cols after one-hot)
  filter_setpieces         — subset shots to corner/free-kick/set-piece/penalty
  extract_X                — defensive projection to model-input columns only

Typical training flow:
    from v4.data.loaders import load_shotmap
    from v4.modules.m4_set_pieces import (
        SetPiecePredictor, build_shot_features, extract_X
    )

    shots = load_shotmap(situations=['corner','free-kick','set-piece','penalty'])
    features = build_shot_features(shots)
    X = extract_X(features)
    y = features['goal_outcome'].values

    predictor = SetPiecePredictor()
    predictor.fit(X, y, eval_set=(X_val, y_val))
    p_goal = predictor.predict_proba(X_test)

Typical aggregation flow (for m3 feature integration):
    # Per-match expected setpiece goals per team
    pred_per_match = predictor.expected_goals_per_match(shots, features)
"""
from v4.modules.m4_set_pieces.feature_builder import (
    ALL_FEATURES,
    BODY_PARTS,
    BODY_PART_FEATURES,
    MINUTE_BUCKETS,
    MINUTE_FEATURES,
    NUMERIC_FEATURES_RAW,
    SETPIECE_SITUATIONS,
    SITUATION_FEATURES,
    TARGET_COLUMN,
    build_shot_features,
    extract_X,
    filter_setpieces,
)
from v4.modules.m4_set_pieces.predictor import (
    DEFAULT_EARLY_STOPPING_ROUNDS,
    DEFAULT_XGB_PARAMS,
    SetPiecePredictor,
)

__all__ = [
    "SetPiecePredictor",
    "DEFAULT_XGB_PARAMS",
    "DEFAULT_EARLY_STOPPING_ROUNDS",
    "build_shot_features",
    "filter_setpieces",
    "extract_X",
    "ALL_FEATURES",
    "SETPIECE_SITUATIONS",
    "BODY_PARTS",
    "MINUTE_BUCKETS",
    "NUMERIC_FEATURES_RAW",
    "SITUATION_FEATURES",
    "BODY_PART_FEATURES",
    "MINUTE_FEATURES",
    "TARGET_COLUMN",
]
