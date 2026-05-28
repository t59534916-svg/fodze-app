"""Pytest cases for m3_xg.

Two layers of testing:
  1. Unit tests on feature_builder + BayesianEnsemble using SYNTHETIC data
     (no training, no artifact dependency — pure-function logic)
  2. Integration tests that load the dev-01 artifact (skip if missing) and
     verify the full predictor pipeline returns schema-correct outputs

Heavy Stage-1 evaluation lives in pipeline/stage_1_m3_xg.py (slow, runs
LightGBM training; not appropriate for pytest CI).
"""
from __future__ import annotations

import pickle
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from v4.modules.m3_xg import (
    ALL_FEATURES,
    BayesianEnsemble,
    CATEGORICAL_FEATURES,
    NUMERIC_FEATURES,
    XGPredictor,
    build_features_for_corpus,
    build_features_for_match,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"


# ─────────────────────────────────────────────────────────────────────
# Synthetic data helpers (no DB dependency)
# ─────────────────────────────────────────────────────────────────────


def _make_history(n_teams: int = 6, n_per_team: int = 30) -> pd.DataFrame:
    """Build a deterministic synthetic team_xg_history for tests."""
    rows = []
    rng = np.random.default_rng(seed=42)
    start = datetime(2024, 1, 1)
    for t in range(n_teams):
        team = f"Team_{t}"
        for i in range(n_per_team):
            opp_idx = (t + 1 + i % (n_teams - 1)) % n_teams
            rows.append({
                "team": team,
                "league": "synthetic_lg",
                "opponent": f"Team_{opp_idx}",
                "venue": "home" if i % 2 == 0 else "away",
                "match_date": start + timedelta(days=7 * i + t),
                "xg": float(rng.uniform(0.5, 2.5)),
                "xga": float(rng.uniform(0.5, 2.5)),
                "goals_for": int(rng.integers(0, 4)),
                "goals_against": int(rng.integers(0, 4)),
                "source": "synthetic",
            })
    df = pd.DataFrame(rows)
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


def _make_match_pairs(history: pd.DataFrame, n_matches: int = 50) -> pd.DataFrame:
    """Build a match_pairs DataFrame from synthetic history."""
    home_rows = history[history["venue"] == "home"].head(n_matches).copy()
    rows = []
    for _, m in home_rows.iterrows():
        rows.append({
            "league": m["league"],
            "match_date": m["match_date"],
            "home": m["team"],
            "away": m["opponent"],
            "home_xg": m["xg"],
            "away_xg": float(np.random.uniform(0.5, 2.5)),
            "home_goals": float(m["goals_for"]),
            "away_goals": float(m["goals_against"]),
            "home_source": m["source"],
            "away_source": m["source"],
        })
    df = pd.DataFrame(rows)
    df["match_date"] = pd.to_datetime(df["match_date"])
    return df


# ─────────────────────────────────────────────────────────────────────
# Feature builder tests (no training)
# ─────────────────────────────────────────────────────────────────────


def test_feature_schema_locked():
    """NUMERIC_FEATURES is a stable list (changes break trained models).

    Schema versions (locked):
      v1 (dev-01, 2026-05-12): 13 features (m2_lambda + interactions)
      v2 (dev-02-elo, 2026-05-13): +elo_diff = 14 features
      v3 (dev-03, 2026-05-14): +lineup_quality_diff + form_streak_diff = 16
      v4 (dev-04, 2026-05-14): +market_disagreement_flag/high = 18
      v5 (dev-05, 2026-05-14): +lineup_quality_player_diff/available = 20  ← CURRENT
    """
    expected = [
        "home_attack_ratio", "home_defense_ratio",
        "away_attack_ratio", "away_defense_ratio",
        "home_ess", "away_ess",
        "league_home_avg", "league_away_avg", "league_home_advantage",
        "lambda_h_naive", "lambda_a_naive",
        "attack_defense_ratio_h", "attack_defense_ratio_a",
        "elo_diff",  # added 2026-05-13 (Path B, β6 sprint)
        "lineup_quality_diff",  # added 2026-05-14 (β7 sprint, dev-03)
        "form_streak_diff",     # added 2026-05-14 (β7 sprint, dev-03)
        "market_disagreement_flag",  # added 2026-05-14 (β8 sprint, dev-04)
        "market_disagreement_high",  # added 2026-05-14 (β8 sprint, dev-04)
        "lineup_quality_player_diff",       # added 2026-05-14 (β9 sprint, dev-05)
        "lineup_quality_player_available",  # added 2026-05-14 (β9 sprint, dev-05)
    ]
    assert NUMERIC_FEATURES == expected, "Feature schema changed — re-train all models"
    assert CATEGORICAL_FEATURES == ["league"]
    assert ALL_FEATURES == NUMERIC_FEATURES + CATEGORICAL_FEATURES


def test_build_features_single_match():
    history = _make_history()
    feat = build_features_for_match(
        home_team="Team_0", away_team="Team_1",
        league="synthetic_lg",
        match_date=datetime(2024, 12, 1),
        history=history,
    )
    for col in NUMERIC_FEATURES:
        assert col in feat, f"missing {col}"
        assert np.isfinite(feat[col]), f"{col} non-finite: {feat[col]}"
    assert feat["league"] == "synthetic_lg"


def test_build_features_corpus_returns_dataframe():
    history = _make_history()
    matches = _make_match_pairs(history, n_matches=20)
    df = build_features_for_corpus(matches, history)
    assert len(df) == 20
    for col in NUMERIC_FEATURES + CATEGORICAL_FEATURES:
        assert col in df.columns
    assert df["league"].dtype.name == "category"
    # Targets included by default
    assert "home_goals" in df.columns
    assert "away_goals" in df.columns


def test_build_features_corpus_no_targets():
    history = _make_history()
    matches = _make_match_pairs(history, n_matches=10)
    df = build_features_for_corpus(matches, history, include_targets=False)
    assert "home_goals" not in df.columns
    assert "away_goals" not in df.columns


# ─────────────────────────────────────────────────────────────────────
# BayesianEnsemble unit tests (FAST — minimal training)
# ─────────────────────────────────────────────────────────────────────


def _trained_ensemble() -> BayesianEnsemble:
    """Build a quickly-trained ensemble on synthetic data for tests."""
    rng = np.random.default_rng(42)
    n = 500
    X = pd.DataFrame({
        "f1": rng.normal(0, 1, n),
        "f2": rng.normal(0, 1, n),
        "f3": rng.normal(0, 1, n),
        "league": pd.Categorical(["a"] * (n // 2) + ["b"] * (n // 2)),
    })
    y = np.clip(X["f1"] * 0.5 + X["f2"] * 0.3 + 1.4 + rng.normal(0, 0.2, n), 0, 5)
    # Use fast params
    fast_params = {"n_estimators": 30, "learning_rate": 0.1, "verbose": -1}
    ens = BayesianEnsemble(n_models=3, base_params=fast_params)
    ens.fit(X, y, categorical_columns=["league"])
    return ens


def _synth_xy(n=500, seed=42):
    rng = np.random.default_rng(seed)
    X = pd.DataFrame({"f1": rng.normal(0, 1, n), "f2": rng.normal(0, 1, n),
                      "league": pd.Categorical(["a"] * (n // 2) + ["b"] * (n // 2))})
    y = np.clip(X["f1"] * 0.5 + 1.4 + rng.normal(0, 0.2, n), 0, 5).to_numpy()
    return X, y


def test_ensemble_sample_weight_length_check():
    X, y = _synth_xy()
    ens = BayesianEnsemble(n_models=2, base_params={"n_estimators": 20, "verbose": -1})
    with pytest.raises(ValueError, match="sample_weight length"):
        ens.fit(X, y, categorical_columns=["league"], sample_weight=np.ones(len(y) - 1))


def test_ensemble_sample_weight_changes_fit():
    # Non-uniform weights must change the learned model (effect, not no-op);
    # default None must equal explicit uniform-ones (backward-compatible).
    X, y = _synth_xy()
    fp = {"n_estimators": 30, "learning_rate": 0.1, "verbose": -1}
    base = BayesianEnsemble(n_models=3, base_params=fp).fit(X, y, categorical_columns=["league"])
    w = 1.0 + 5.0 * (np.abs(X["f1"].to_numpy()) / np.abs(X["f1"].to_numpy()).std())
    wt = BayesianEnsemble(n_models=3, base_params=fp).fit(X, y, categorical_columns=["league"], sample_weight=w)
    Xp, _ = _synth_xy(n=100, seed=7)
    pb, _ = base.predict(Xp); pw, _ = wt.predict(Xp)
    assert np.mean(np.abs(pb - pw)) > 1e-4  # weighting had an effect


def test_ensemble_rejects_unfitted_predict():
    ens = BayesianEnsemble(n_models=2)
    with pytest.raises(RuntimeError, match="not yet fitted"):
        ens.predict(pd.DataFrame({"f1": [1.0]}))


def test_ensemble_rejects_n_models_below_2():
    with pytest.raises(ValueError):
        BayesianEnsemble(n_models=1)


def test_ensemble_rejects_invalid_bootstrap_fraction():
    with pytest.raises(ValueError):
        BayesianEnsemble(bootstrap_fraction=0.4)
    with pytest.raises(ValueError):
        BayesianEnsemble(bootstrap_fraction=1.5)


def test_ensemble_fit_predict_smoketest():
    ens = _trained_ensemble()
    assert ens.is_fitted
    # Predict on small batch
    X = pd.DataFrame({
        "f1": [0.5, 1.0],
        "f2": [0.3, -0.5],
        "f3": [0.0, 0.0],
        "league": pd.Categorical(["a", "b"]),
    })
    mean, var = ens.predict(X)
    assert mean.shape == (2,)
    assert var.shape == (2,)
    assert np.all(np.isfinite(mean))
    assert np.all(np.isfinite(var))
    assert np.all(var >= 0)  # variance is non-negative


def test_ensemble_predict_rejects_missing_features():
    ens = _trained_ensemble()
    X_incomplete = pd.DataFrame({"f1": [1.0], "f2": [0.0]})  # missing f3 + league
    with pytest.raises(ValueError, match="missing required features"):
        ens.predict(X_incomplete)


def test_ensemble_save_load_roundtrip():
    ens = _trained_ensemble()
    with tempfile.NamedTemporaryFile(suffix=".pkl", delete=False) as f:
        ens.save(Path(f.name))
        loaded = BayesianEnsemble.load(Path(f.name))
    X = pd.DataFrame({
        "f1": [0.5], "f2": [0.3], "f3": [0.0],
        "league": pd.Categorical(["a"], categories=["a", "b"]),
    })
    mean_original, var_original = ens.predict(X)
    mean_loaded, var_loaded = loaded.predict(X)
    assert np.allclose(mean_original, mean_loaded)
    assert np.allclose(var_original, var_loaded)


def test_ensemble_rejects_negative_targets():
    ens = BayesianEnsemble(n_models=2, base_params={"n_estimators": 10, "verbose": -1})
    X = pd.DataFrame({"f1": np.random.rand(100)})
    y_with_neg = np.random.rand(100) - 0.5  # contains negative values
    with pytest.raises(ValueError, match="y ≥ 0"):
        ens.fit(X, y_with_neg)


def test_ensemble_rejects_nan_targets():
    ens = BayesianEnsemble(n_models=2, base_params={"n_estimators": 10, "verbose": -1})
    X = pd.DataFrame({"f1": np.random.rand(100)})
    y_with_nan = np.random.rand(100)
    y_with_nan[3] = np.nan
    with pytest.raises(ValueError, match="non-finite"):
        ens.fit(X, y_with_nan)


# ─────────────────────────────────────────────────────────────────────
# Integration tests (skip if dev-01 artifact missing)
# ─────────────────────────────────────────────────────────────────────


def _dev_artifacts_exist() -> bool:
    return (
        (ARTIFACTS_DIR / "m3_xg-home-dev-02-elo.pkl").exists()
        and (ARTIFACTS_DIR / "m3_xg-away-dev-02-elo.pkl").exists()
    )


@pytest.mark.skipif(
    not _dev_artifacts_exist(),
    reason="dev-02-elo artifacts not present (run train_m3_xg.py first)",
)
def test_predictor_loads_from_artifacts():
    predictor = XGPredictor.from_artifacts(
        home_path=ARTIFACTS_DIR / "m3_xg-home-dev-02-elo.pkl",
        away_path=ARTIFACTS_DIR / "m3_xg-away-dev-02-elo.pkl",
    )
    assert predictor.ensemble_home.is_fitted
    assert predictor.ensemble_away.is_fitted
    assert len(predictor.ensemble_home.models) == 5
    assert len(predictor.ensemble_away.models) == 5


@pytest.mark.skipif(
    not _dev_artifacts_exist(),
    reason="dev-02-elo artifacts not present",
)
@pytest.mark.requires_data
def test_predictor_predict_one_returns_schema():
    """Live predictor on a real BL match — verify output schema."""
    from v4.data.loaders import load_team_xg_history

    predictor = XGPredictor.from_artifacts(
        home_path=ARTIFACTS_DIR / "m3_xg-home-dev-02-elo.pkl",
        away_path=ARTIFACTS_DIR / "m3_xg-away-dev-02-elo.pkl",
    )
    history = load_team_xg_history(leagues=["bundesliga"])
    result = predictor.predict_one(
        home_team="Bayern Munich", away_team="Borussia Dortmund",
        league="bundesliga",
        match_date=datetime(2026, 4, 5),
        history=history,
    )
    # Schema checks
    assert "lambda_h" in result
    assert "lambda_a" in result
    assert "lambda_h_variance" in result
    assert "lambda_a_variance" in result
    assert "probabilities_1x2" in result
    assert "probabilities_o25" in result
    assert "probabilities_btts" in result
    # Range checks
    assert 0.3 <= result["lambda_h"] <= 4.5
    assert 0.3 <= result["lambda_a"] <= 4.5
    assert result["lambda_h_variance"] >= 0
    p1x2 = result["probabilities_1x2"]
    assert abs(p1x2["H"] + p1x2["D"] + p1x2["A"] - 1.0) < 1e-6


@pytest.mark.skipif(
    not _dev_artifacts_exist(),
    reason="dev-02-elo artifacts not present",
)
@pytest.mark.requires_data
def test_predictor_predict_batch_returns_dataframe():
    """Predictor batch path on a 5-match sample."""
    from v4.data.loaders import load_match_pairs, load_team_xg_history

    predictor = XGPredictor.from_artifacts(
        home_path=ARTIFACTS_DIR / "m3_xg-home-dev-02-elo.pkl",
        away_path=ARTIFACTS_DIR / "m3_xg-away-dev-02-elo.pkl",
    )
    history = load_team_xg_history(leagues=["bundesliga"])
    matches = load_match_pairs(
        leagues=["bundesliga"], since="2025-08-01"
    ).head(5)
    preds = predictor.predict_batch(matches, history)
    assert len(preds) == 5
    for col in ["lambda_h", "lambda_a", "lambda_h_variance",
                "prob_h", "prob_d", "prob_a", "prob_over25",
                "used_poisson_fallback"]:
        assert col in preds.columns, f"missing column: {col}"
    # 1X2 sums to 1
    sums = preds["prob_h"] + preds["prob_d"] + preds["prob_a"]
    assert np.all(np.abs(sums - 1.0) < 1e-6)
    # used_poisson_fallback is boolean (or 0/1 numpy bool array)
    assert preds["used_poisson_fallback"].dtype == bool, (
        f"used_poisson_fallback should be bool, got {preds['used_poisson_fallback'].dtype}"
    )
    # Aggregate rate is exposed via DataFrame attrs
    assert "poisson_fallback_rate" in preds.attrs
    fallback_rate = preds.attrs["poisson_fallback_rate"]
    assert 0.0 <= fallback_rate <= 1.0, f"fallback rate {fallback_rate} out of [0,1]"
    # Rate should equal column mean (consistency invariant)
    assert abs(fallback_rate - preds["used_poisson_fallback"].mean()) < 1e-9
