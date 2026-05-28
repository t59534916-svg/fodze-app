"""v4.modules.m3_xg — LightGBM Tweedie head + 5-seed Bayesian Ensemble.

Pipeline: features → (λ_h_mean, λ_a_mean, σ²_h, σ²_a) → Dixon-Coles → 1X2/O25/BTTS.

Public API:
  BayesianEnsemble — 5-seed bagged LightGBM (the model-side variance source)
  XGPredictor       — orchestrator combining ensemble + m1_score Dixon-Coles
  build_features_for_match    — single-match feature dict
  build_features_for_corpus   — bulk feature DataFrame with league-constants cache
  NUMERIC_FEATURES, ALL_FEATURES — locked feature schema

Typical training flow:
    history = load_team_xg_history()
    matches = load_match_pairs(cutoff="2025-07-31")
    features = build_features_for_corpus(matches, history)
    X = features[NUMERIC_FEATURES + ['league']]
    ens_h = BayesianEnsemble().fit(X, features['home_goals'].values,
                                    categorical_columns=['league'])
    ens_a = BayesianEnsemble().fit(X, features['away_goals'].values,
                                    categorical_columns=['league'])
    predictor = XGPredictor(ensemble_home=ens_h, ensemble_away=ens_a)

Typical inference flow:
    result = predictor.predict_one(
        home_team="Bayern", away_team="Dortmund",
        league="bundesliga", match_date=date(2026, 4, 5),
        history=team_xg_df,
    )
"""
from v4.modules.m3_xg.bayesian_ensemble import (
    DEFAULT_BOOTSTRAP_FRACTION,
    DEFAULT_LGB_PARAMS,
    DEFAULT_N_MODELS,
    BayesianEnsemble,
)
from v4.modules.m3_xg.feature_builder import (
    ALL_FEATURES,
    CATEGORICAL_FEATURES,
    METADATA_COLUMNS,
    NUMERIC_FEATURES,
    TARGET_COLUMNS,
    build_features_for_corpus,
    build_features_for_match,
    extract_X,
)
from v4.modules.m3_xg.predictor import DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator
from v4.modules.m3_xg.market_disagreement import MarketDisagreementCalculator
from v4.modules.m3_xg.player_lineup import PlayerLineupCalculator

__all__ = [
    "BayesianEnsemble",
    "DEFAULT_LGB_PARAMS",
    "DEFAULT_N_MODELS",
    "DEFAULT_BOOTSTRAP_FRACTION",
    "XGPredictor",
    "DEFAULT_RHO",
    "build_features_for_match",
    "build_features_for_corpus",
    "extract_X",
    "NUMERIC_FEATURES",
    "CATEGORICAL_FEATURES",
    "ALL_FEATURES",
    "METADATA_COLUMNS",
    "TARGET_COLUMNS",
    "TeamMomentumCalculator",
    "MarketDisagreementCalculator",
    "PlayerLineupCalculator",
]
