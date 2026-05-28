"""
m3_xg.feature_builder — convert team_xg_history match pairs to feature matrix.

API:
  build_features_for_match(home, away, league, match_date, history, [estimator]) → dict
  build_features_for_corpus(match_pairs_df, history_df, [estimator]) → pd.DataFrame

Each feature row contains:
  - 10 numeric features from m2_lambda (attack/defense ratios, ESS, league context)
  - 1 derived numeric: lambda product (home_attack × away_defense × league_avg)
  - 1 categorical: league_code (LightGBM handles natively when dtype='category')
  - target: home_goals, away_goals (only when goals are observed)

Feature naming convention: snake_case, no leading underscores. Order is stable
across all rows so DataFrames concat cleanly and trained models stay compatible.

Critical invariant: build_features_for_corpus respects temporal ordering —
for each match m at date d, only history rows with match_date < d are used.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from v4.modules.m2_lambda import (
    LambdaEstimator,
    compute_league_constants_batch,
)
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator
from v4.modules.m3_xg.market_disagreement import MarketDisagreementCalculator
from v4.modules.m3_xg.player_lineup import PlayerLineupCalculator


# Locked feature column order — DO NOT shuffle. Trained models depend on it.
# Adding a feature requires:
#   1. Append the new column name AT THE END (preserve old positions)
#   2. Re-train m3 with a new tag (e.g., dev-02-feature-name)
#   3. Update tests/test_m3_xg.py::test_feature_schema_locked
NUMERIC_FEATURES: List[str] = [
    "home_attack_ratio",
    "home_defense_ratio",
    "away_attack_ratio",
    "away_defense_ratio",
    "home_ess",
    "away_ess",
    "league_home_avg",
    "league_away_avg",
    "league_home_advantage",
    "lambda_h_naive",      # from m2_lambda direct
    "lambda_a_naive",      # from m2_lambda direct
    "attack_defense_ratio_h",  # home_attack_ratio × away_defense_ratio
    "attack_defense_ratio_a",  # away_attack_ratio × home_defense_ratio
    # ── Path B feature additions (β6 sprint, 2026-05-13) ──
    "elo_diff",            # home_elo - away_elo (per-league Elo, K=20, MOV-adj)
    # ── dev-03 additions (β7 sprint, 2026-05-14) ──
    "lineup_quality_diff", # rolling-5 (gf+xg)/2 - (ga+xga)/2, per-liga z-scored, diff
    "form_streak_diff",    # weighted-3 points (3×L+2×PL+1×3rdL), per-liga z-scored, diff
    # ── dev-04 additions (β8 sprint, 2026-05-14) ──
    "market_disagreement_flag",  # mean(|p_proxy - p_market|/p_market) over H/D/A; 0 if no odds
    "market_disagreement_high",  # 1 if flag > 0.08, else 0
    # ── dev-05 additions (β9 sprint, 2026-05-14) ──
    "lineup_quality_player_diff",       # Top-5 only: rolling-5 top-11 starters composite z-diff
    "lineup_quality_player_available",  # 1 if Top-5 + enough data, else 0
]
CATEGORICAL_FEATURES: List[str] = ["league"]
TARGET_COLUMNS: List[str] = ["home_goals", "away_goals"]
# Metadata columns are NOT features — kept for chronological CV / debugging but
# MUST be excluded from any X matrix passed to a model. Use extract_X() helper.
METADATA_COLUMNS: List[str] = ["match_date"]

ALL_FEATURES: List[str] = NUMERIC_FEATURES + CATEGORICAL_FEATURES


def extract_X(features_df: pd.DataFrame) -> pd.DataFrame:
    """Project a feature DataFrame to ONLY the model-input columns.

    This is the canonical way to build X for training / inference. Use this
    instead of `features.drop(['home_goals', 'away_goals'])` — drop-based
    selection silently includes match_date and any future columns we add.

    Raises ValueError if any required feature is missing.
    """
    missing = [c for c in ALL_FEATURES if c not in features_df.columns]
    if missing:
        raise ValueError(
            f"features_df missing required columns: {missing}. "
            f"Expected: {ALL_FEATURES}"
        )
    return features_df[ALL_FEATURES].copy()


def build_features_for_match(
    *,
    home_team: str,
    away_team: str,
    league: str,
    match_date: datetime,
    history: pd.DataFrame,
    estimator: Optional[LambdaEstimator] = None,
    league_constants: Optional[Dict[str, float]] = None,
    elo_calculator: Optional[EloCalculator] = None,
    momentum_calculator: Optional[TeamMomentumCalculator] = None,
    disagreement_calculator: Optional[MarketDisagreementCalculator] = None,
    player_lineup_calculator: Optional[PlayerLineupCalculator] = None,
) -> Dict[str, Any]:
    """Build feature dict for ONE match.

    Args:
        home_team, away_team: canonical team names
        league: league code
        match_date: match date (history strictly before this)
        history: full team_xg_history DataFrame
        estimator: pre-instantiated LambdaEstimator (saves construction cost in loops)
        league_constants: pre-computed for this league/date (saves recompute)
        elo_calculator: pre-fitted EloCalculator. If None, computed on-the-fly
                        (slow — pass an instance for batch operations).

    Returns:
        dict with all NUMERIC_FEATURES + CATEGORICAL_FEATURES keys, all finite.
        For predict-time use, no target columns. Add target separately for training.
    """
    if estimator is None:
        estimator = LambdaEstimator()

    m2_features = estimator.compute_features(
        home_team=home_team,
        away_team=away_team,
        league=league,
        match_date=match_date,
        history=history,
        league_constants=league_constants,
    )

    # Elo diff: positive = home is stronger. If no calculator passed, fit
    # one on-the-fly (expensive — only safe for single-match queries).
    if elo_calculator is None:
        elo_calculator = EloCalculator().fit(history)
    elo_diff = elo_calculator.get_elo_diff(
        home_team=home_team, away_team=away_team,
        league=league, match_date=pd.Timestamp(match_date),
    )

    # Momentum features (lineup_quality_diff + form_streak_diff) — dev-03
    if momentum_calculator is None:
        momentum_calculator = TeamMomentumCalculator().fit(history)
    momentum = momentum_calculator.get_features(
        home_team=home_team, away_team=away_team,
        league=league, match_date=pd.Timestamp(match_date),
    )

    # Market disagreement features — dev-04
    if disagreement_calculator is None:
        # Lazy-fit empty calculator (returns 0.0 for all matches — neutral signal)
        disagreement_calculator = MarketDisagreementCalculator()
        disagreement_calculator._fitted = True  # empty lookup, all matches → 0.0
    disagreement = disagreement_calculator.get_features(
        home_team=home_team, away_team=away_team,
        league=league, match_date=pd.Timestamp(match_date),
        lambda_h=m2_features["lambda_h"],
        lambda_a=m2_features["lambda_a"],
    )

    # Player-level lineup quality (dev-05) — Top-5 only
    if player_lineup_calculator is not None and player_lineup_calculator.is_fitted:
        plq = player_lineup_calculator.get_features(
            home_team=home_team, away_team=away_team,
            league=league, match_date=pd.Timestamp(match_date),
        )
    else:
        plq = {"lineup_quality_player_diff": 0.0,
               "lineup_quality_player_available": 0.0}

    return {
        # From m2_lambda
        "home_attack_ratio": m2_features["home_attack_ratio"],
        "home_defense_ratio": m2_features["home_defense_ratio"],
        "away_attack_ratio": m2_features["away_attack_ratio"],
        "away_defense_ratio": m2_features["away_defense_ratio"],
        "home_ess": m2_features["home_ess"],
        "away_ess": m2_features["away_ess"],
        "league_home_avg": m2_features["league_home_avg"],
        "league_away_avg": m2_features["league_away_avg"],
        "league_home_advantage": m2_features["league_home_advantage"],
        "lambda_h_naive": m2_features["lambda_h"],
        "lambda_a_naive": m2_features["lambda_a"],
        # Interaction terms (LightGBM can learn these but explicit helps small-data)
        "attack_defense_ratio_h": (
            m2_features["home_attack_ratio"] * m2_features["away_defense_ratio"]
        ),
        "attack_defense_ratio_a": (
            m2_features["away_attack_ratio"] * m2_features["home_defense_ratio"]
        ),
        # Elo (Path B β6 sprint)
        "elo_diff": float(elo_diff),
        # Momentum (β7 sprint, dev-03)
        "lineup_quality_diff": float(momentum["lineup_quality_diff"]),
        "form_streak_diff": float(momentum["form_streak_diff"]),
        # Market disagreement (β8 sprint, dev-04)
        "market_disagreement_flag": float(disagreement["market_disagreement_flag"]),
        "market_disagreement_high": float(disagreement["market_disagreement_high"]),
        # Player-level lineup (β9 sprint, dev-05)
        "lineup_quality_player_diff": float(plq["lineup_quality_player_diff"]),
        "lineup_quality_player_available": float(plq["lineup_quality_player_available"]),
        # Categorical
        "league": league,
    }


def build_features_for_corpus(
    match_pairs: pd.DataFrame,
    history: pd.DataFrame,
    *,
    estimator: Optional[LambdaEstimator] = None,
    elo_calculator: Optional[EloCalculator] = None,
    momentum_calculator: Optional[TeamMomentumCalculator] = None,
    disagreement_calculator: Optional[MarketDisagreementCalculator] = None,
    player_lineup_calculator: Optional[PlayerLineupCalculator] = None,
    include_targets: bool = True,
    cache_league_constants: bool = True,
    verbose: bool = False,
) -> pd.DataFrame:
    """Build feature matrix for a corpus of matches.

    Args:
        match_pairs: DataFrame from load_match_pairs(). Required columns:
                     league, match_date (datetime), home, away, home_goals, away_goals
        history: full team_xg_history DataFrame (loaded via load_team_xg_history)
        estimator: pre-instantiated LambdaEstimator. None → default config.
        elo_calculator: pre-fitted EloCalculator. None → fit on `history` once.
        include_targets: if True, append home_goals + away_goals columns.
                         Set False for predict-time (live matches).
        cache_league_constants: per-league constants are SLOW to recompute. Cache by
                                (league, year-month) — recomputed at month boundaries
                                so the time-windowed average doesn't drift mid-season.
        verbose: print progress every 1000 matches.

    Returns:
        pd.DataFrame with columns: ALL_FEATURES + (TARGET_COLUMNS if include_targets).
        Same row count as match_pairs (no drops). Categorical column is dtype='category'.
    """
    if estimator is None:
        estimator = LambdaEstimator()
    if elo_calculator is None:
        if verbose:
            print(f"  feature_builder: fitting EloCalculator on {len(history):,} history rows...")
        elo_calculator = EloCalculator().fit(history)
    if momentum_calculator is None:
        if verbose:
            print(f"  feature_builder: fitting TeamMomentumCalculator on {len(history):,} history rows...")
        momentum_calculator = TeamMomentumCalculator().fit(history)
    if disagreement_calculator is None:
        if verbose:
            print(f"  feature_builder: no disagreement_calculator passed — using empty (all 0.0)")
        disagreement_calculator = MarketDisagreementCalculator()
        disagreement_calculator._fitted = True
    # player_lineup_calculator is OPTIONAL — when None, features default to 0/0
    # (this is the correct fallback for non-dev-05 model artifacts)

    # Build league-constants cache keyed by (league, year-month)
    # The window for any match's constants ends at match_date with 540-day lookback.
    # We bucket by month so each match within a month gets the same constants —
    # OK approximation since league avgs shift slowly.
    constants_cache: Dict[tuple, Dict[str, float]] = {}

    def _get_constants(league: str, match_date: pd.Timestamp) -> Dict[str, float]:
        if not cache_league_constants:
            return compute_league_constants_batch(
                history, leagues=[league], before_date=match_date
            )[league]
        key = (league, match_date.year, match_date.month)
        if key not in constants_cache:
            constants_cache[key] = compute_league_constants_batch(
                history, leagues=[league], before_date=match_date
            )[league]
        return constants_cache[key]

    rows: List[Dict[str, Any]] = []
    n_total = len(match_pairs)
    for i, (_, m) in enumerate(match_pairs.iterrows()):
        if verbose and i > 0 and i % 1000 == 0:
            print(f"  feature_builder: {i:,}/{n_total:,}")

        constants = _get_constants(m["league"], m["match_date"])
        feat = build_features_for_match(
            home_team=m["home"],
            away_team=m["away"],
            league=m["league"],
            match_date=m["match_date"].to_pydatetime(),
            history=history,
            estimator=estimator,
            league_constants=constants,
            elo_calculator=elo_calculator,
            momentum_calculator=momentum_calculator,
            disagreement_calculator=disagreement_calculator,
            player_lineup_calculator=player_lineup_calculator,
        )
        if include_targets:
            feat["home_goals"] = float(m["home_goals"]) if pd.notna(m["home_goals"]) else np.nan
            feat["away_goals"] = float(m["away_goals"]) if pd.notna(m["away_goals"]) else np.nan
        feat["match_date"] = m["match_date"]  # for chronological CV later
        rows.append(feat)

    df = pd.DataFrame(rows)

    # Categorical dtype for LightGBM native categorical support
    df["league"] = df["league"].astype("category")

    # Sanity: all numeric features should be finite (m2_lambda + clamping ensure this)
    bad = df[NUMERIC_FEATURES].apply(lambda col: ~np.isfinite(col).all())
    if bad.any():
        bad_cols = bad[bad].index.tolist()
        raise ValueError(
            f"feature_builder produced non-finite values in: {bad_cols}. "
            "This shouldn't happen — m2_lambda guards against NaN/inf."
        )

    return df
