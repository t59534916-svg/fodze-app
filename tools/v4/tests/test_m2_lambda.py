"""Pytest wrapper for m2_lambda Stage 1 sanity tests + dedicated EWMA unit tests.

Stage 1 sanity tests are parametrized from the canonical TESTS list in
pipeline/stage_1_m2_lambda.py. EWMA + league_constants get extra targeted
unit tests below — these are too low-level for the Stage 1 runner but valuable
for regression-locking the math.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from v4.modules.m2_lambda import (
    LAMBDA_MAX,
    LAMBDA_MIN,
    LambdaEstimator,
    TeamStrength,
    compute_league_constants,
    effective_sample_size,
    ewma_recent_first,
    ewma_with_fallback,
)
from v4.pipeline import stage_1_m2_lambda as _runner


# ─────────────────────────────────────────────────────────────────────
# Parametrized Stage 1 runner (reuses canonical TESTS list)
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "label,test_fn",
    _runner.TESTS,
    ids=[label.strip().split()[0].strip("[]") for label, _ in _runner.TESTS],
)
def test_m2_lambda_stage1(label: str, test_fn) -> None:
    try:
        test_fn()
    except _runner.SanityCheckFailed as e:
        pytest.fail(f"{label} — {e}")
    except Exception as e:
        # A subset of stage-1 cases read the local SQLite mirror (not in git).
        # In CI / fresh checkouts the mirror is absent → skip rather than fail.
        # Pure-unit cases (math identities) never hit this branch.
        msg = str(e).lower()
        if ("local_extras" in msg or "no such table" in msg
                or "databaseerror" in type(e).__name__.lower()
                or "unable to open database" in msg):
            pytest.skip(f"{label} — needs local SQLite mirror: {e}")
        raise


# ─────────────────────────────────────────────────────────────────────
# EWMA targeted unit tests
# ─────────────────────────────────────────────────────────────────────


def test_ewma_single_value():
    assert ewma_recent_first(np.array([1.5]), halflife=8) == 1.5


def test_ewma_equal_values_yield_same():
    assert abs(ewma_recent_first(np.array([1.5] * 10), halflife=8) - 1.5) < 1e-9


def test_ewma_recent_dominant():
    """Recent value dominates with short halflife."""
    result = ewma_recent_first(np.array([3.0, 1.0, 1.0, 1.0]), halflife=1.0)
    assert 2.0 < result < 2.2


def test_ewma_empty_returns_nan():
    assert math.isnan(ewma_recent_first(np.array([]), halflife=8))


def test_ewma_handles_nan_in_middle():
    """NaN at position 1 should be skipped, gap-distance preserved."""
    mixed = np.array([2.0, np.nan, 1.0, 1.0])
    result = ewma_recent_first(mixed, halflife=2)
    assert math.isfinite(result)
    # Skip pos 1: weights for pos 0, 2, 3 = 1.0, 0.5, 0.354
    # weighted_sum = 2.0 + 0.5 + 0.354 = 2.854; weight_total = 1.854
    # → 1.54
    assert 1.45 < result < 1.65


def test_ewma_min_periods_enforced():
    result = ewma_recent_first(np.array([1.5, 1.5]), halflife=8, min_periods=3)
    assert math.isnan(result)


def test_ewma_negative_halflife_raises():
    with pytest.raises(ValueError):
        ewma_recent_first(np.array([1.0]), halflife=-1)


def test_ewma_with_fallback_returns_fallback_when_empty():
    assert ewma_with_fallback(np.array([]), halflife=8, fallback=1.2) == 1.2


def test_ess_asymptotic_behavior():
    """ESS approaches 2*halflife/ln(2) as n → ∞."""
    asymptote = 2 * 8 / math.log(2)
    ess_large = effective_sample_size(1000, halflife=8)
    assert abs(ess_large - asymptote) < 0.5


def test_ess_small_n_approaches_n():
    """For n << halflife, ESS ≈ n."""
    ess_n2 = effective_sample_size(2, halflife=8)
    assert 1.8 < ess_n2 < 2.0


# ─────────────────────────────────────────────────────────────────────
# League constants unit tests
# ─────────────────────────────────────────────────────────────────────


def _synthetic_df(rows: list) -> pd.DataFrame:
    """Build a DataFrame with proper dtypes. Handles empty rows correctly."""
    if not rows:
        return pd.DataFrame({
            "league": pd.Series(dtype=str),
            "match_date": pd.Series(dtype="datetime64[ns]"),
            "venue": pd.Series(dtype=str),
            "xg": pd.Series(dtype=float),
        })
    df = pd.DataFrame(rows)
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


def test_league_constants_fallback_on_empty():
    df = _synthetic_df([])
    result = compute_league_constants(df, league="bundesliga")
    assert result["source"] == "default_fallback"
    assert result["home_xg_avg"] > 0
    assert result["away_xg_avg"] > 0


def test_league_constants_computed_path():
    """With enough history, source should be 'computed' and avgs match input."""
    rows = []
    for i in range(40):
        rows.append({
            "league": "bundesliga", "match_date": datetime(2025, 1, 1) + timedelta(days=i),
            "venue": "home" if i < 20 else "away",
            "xg": 1.8 if i < 20 else 1.2,
        })
    df = _synthetic_df(rows)
    result = compute_league_constants(df, league="bundesliga", before_date=datetime(2025, 12, 1))
    assert result["source"] == "computed"
    assert abs(result["home_xg_avg"] - 1.8) < 0.01
    assert abs(result["away_xg_avg"] - 1.2) < 0.01
    assert abs(result["home_advantage"] - 0.6) < 0.01


def test_league_constants_respects_before_date():
    """Rows AFTER before_date must be excluded."""
    rows = [
        # 35 rows with avg 1.5
        {"league": "bundesliga", "match_date": datetime(2025, 1, 1) + timedelta(days=i),
         "venue": "home" if i % 2 == 0 else "away", "xg": 1.5}
        for i in range(35)
    ] + [
        # Poison: 100 future rows with xg=10 — must NOT enter computation
        {"league": "bundesliga", "match_date": datetime(2026, 6, 1) + timedelta(days=i),
         "venue": "home" if i % 2 == 0 else "away", "xg": 10.0}
        for i in range(100)
    ]
    df = _synthetic_df(rows)
    result = compute_league_constants(df, league="bundesliga", before_date=datetime(2026, 1, 1))
    assert result["source"] == "computed"
    # If leakage happened, home_xg_avg would be ~5.0+ not ~1.5
    assert result["home_xg_avg"] < 2.0, "future leakage detected in league_constants"


def test_league_constants_lookback_window():
    """Rows older than lookback_days must be excluded."""
    # 35 rows in 2020 (way before lookback) + 35 rows in 2025 (within lookback)
    rows = [
        {"league": "bundesliga", "match_date": datetime(2020, 1, 1) + timedelta(days=i),
         "venue": "home" if i % 2 == 0 else "away", "xg": 10.0}
        for i in range(35)
    ] + [
        {"league": "bundesliga", "match_date": datetime(2025, 1, 1) + timedelta(days=i),
         "venue": "home" if i % 2 == 0 else "away", "xg": 1.5}
        for i in range(35)
    ]
    df = _synthetic_df(rows)
    result = compute_league_constants(
        df, league="bundesliga",
        before_date=datetime(2026, 1, 1), lookback_days=540,
    )
    assert result["source"] == "computed"
    # The 2020 rows are outside lookback — only 2025 rows count
    assert result["home_xg_avg"] < 2.0


# ─────────────────────────────────────────────────────────────────────
# LambdaEstimator construction edge cases
# ─────────────────────────────────────────────────────────────────────


def test_estimator_rejects_negative_halflife():
    with pytest.raises(ValueError):
        LambdaEstimator(ewma_halflife=-1)


def test_estimator_rejects_zero_lookback():
    with pytest.raises(ValueError):
        LambdaEstimator(lookback_matches=0)


def test_teamstrength_frozen():
    """TeamStrength dataclass should be immutable."""
    s = TeamStrength(attack_xg=1.5, defense_xga=1.2, n_matches=8, ess=6.0, is_fallback=False)
    with pytest.raises((AttributeError, Exception)):  # frozen dataclass raises FrozenInstanceError
        s.attack_xg = 2.0  # type: ignore
