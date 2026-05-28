"""v4.modules.m2_lambda — per-match (λ_h, λ_a) estimator.

Public API:
  LambdaEstimator        — main class. Stateless; pass team_xg_history per call.
  compute_league_constants — per-league home/away averages (cacheable).
  ewma_recent_first      — pure-numpy EWMA kernel.

Typical usage:
    from v4.modules.m2_lambda import LambdaEstimator, compute_league_constants

    est = LambdaEstimator(ewma_halflife=8, lookback_matches=16)
    lambda_h, lambda_a = est.estimate(
        home_team="Bayern Munich", away_team="Borussia Dortmund",
        league="bundesliga", match_date=date(2026, 4, 5),
        history=team_xg_df,
    )

For full feature vector (used by m3_xg):
    features = est.compute_features(...)  # 20+ intermediate values
"""
from v4.modules.m2_lambda.estimator import (
    DEFAULT_EWMA_HALFLIFE,
    DEFAULT_LOOKBACK_MATCHES,
    LAMBDA_MAX,
    LAMBDA_MIN,
    LambdaEstimator,
    TeamStrength,
)
from v4.modules.m2_lambda.ewma import (
    effective_sample_size,
    ewma_recent_first,
    ewma_with_fallback,
)
from v4.modules.m2_lambda.league_constants import (
    DEFAULT_HOME_ADVANTAGE,
    DEFAULT_HOME_XG_AVG,
    compute_league_constants,
    compute_league_constants_batch,
)

__all__ = [
    "LambdaEstimator",
    "TeamStrength",
    "LAMBDA_MIN",
    "LAMBDA_MAX",
    "DEFAULT_EWMA_HALFLIFE",
    "DEFAULT_LOOKBACK_MATCHES",
    "compute_league_constants",
    "compute_league_constants_batch",
    "DEFAULT_HOME_XG_AVG",
    "DEFAULT_HOME_ADVANTAGE",
    "ewma_recent_first",
    "ewma_with_fallback",
    "effective_sample_size",
]

