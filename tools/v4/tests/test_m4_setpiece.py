"""Pytest cases for m4_set_pieces.

Same two-layer testing pattern as test_m3_xg:
  1. Unit tests on feature_builder + SetPiecePredictor using SYNTHETIC data
     (no DB / no artifact dependency)
  2. Integration tests that load the dev-01 artifact (skip-if-missing) and
     verify the full predictor returns schema-correct outputs

Heavy Stage 1 evaluation lives in pipeline/stage_1_m4_setpiece.py.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from v4.modules.m4_set_pieces import (
    ALL_FEATURES,
    BODY_PARTS,
    MINUTE_BUCKETS,
    SETPIECE_SITUATIONS,
    SITUATION_FEATURES,
    SetPiecePredictor,
    build_shot_features,
    extract_X,
    filter_setpieces,
)
from v4.modules.m4_set_pieces.feature_builder import (
    BODY_PART_FEATURES,
    MINUTE_FEATURES,
    NUMERIC_FEATURES_RAW,
    TARGET_COLUMN,
    _bucket_minute,
    normalize_coords,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"


# ─────────────────────────────────────────────────────────────────────
# Synthetic data helpers
# ─────────────────────────────────────────────────────────────────────


def _make_synthetic_shots(n: int = 200, seed: int = 42) -> pd.DataFrame:
    """Build a deterministic synthetic shotmap for tests."""
    rng = np.random.default_rng(seed)
    rows = []
    situations = SETPIECE_SITUATIONS + ["regular", "assisted"]
    for i in range(n):
        sit = situations[i % len(situations)]
        rows.append({
            "shot_id": i,
            "game_id": 1000 + i // 20,
            "league": "synthetic_lg",
            "season": "25/26",
            "is_home": int(i % 2 == 0),
            "situation": sit,
            "body_part": rng.choice(BODY_PARTS + [None]),
            "shooter_x": rng.uniform(0, 100),
            "shooter_y": rng.uniform(0, 100),
            "minute": int(rng.integers(1, 90)),
            "goal_type": "goal" if rng.uniform() < (0.5 if sit == "penalty" else 0.1) else None,
            "xg": float(rng.uniform(0, 1)),
            "xgot": float(rng.uniform(0, 1)),
            "match_date": pd.Timestamp("2025-08-01") + pd.Timedelta(days=i // 5),
        })
    return pd.DataFrame(rows)


# ─────────────────────────────────────────────────────────────────────
# Feature builder unit tests
# ─────────────────────────────────────────────────────────────────────


def test_feature_schema_locked():
    """ALL_FEATURES is a stable list (changes break trained models)."""
    expected = (
        NUMERIC_FEATURES_RAW + SITUATION_FEATURES + BODY_PART_FEATURES + MINUTE_FEATURES
    )
    assert ALL_FEATURES == expected, "Feature schema changed — re-train all models"
    assert len(ALL_FEATURES) == 16  # 2 numeric + 4 situation + 4 body_part + 6 minute


def test_filter_setpieces_drops_non_setpiece():
    shots = _make_synthetic_shots(200)
    sp = filter_setpieces(shots)
    assert (sp["situation"].isin(SETPIECE_SITUATIONS)).all()
    # Of 200 synthetic with 6 situations cycling, ~67% should be setpiece (4/6)
    assert len(sp) > 100  # ~133 expected


def test_bucket_minute_boundaries():
    assert _bucket_minute(0) == "00-15"
    assert _bucket_minute(14) == "00-15"
    assert _bucket_minute(15) == "15-30"
    assert _bucket_minute(44) == "30-45"
    assert _bucket_minute(45) == "45-60"
    assert _bucket_minute(74) == "60-75"
    assert _bucket_minute(75) == "75+"
    assert _bucket_minute(120) == "75+"  # added time


def test_normalize_coords_clips_and_centers():
    x, y = normalize_coords(50.0, 50.0)
    assert x == 0.5 and y == 0.5
    x, y = normalize_coords(150.0, -10.0)
    assert x == 1.0 and y == 0.0
    x, y = normalize_coords(np.nan, np.nan)
    assert x == 0.5 and y == 0.5


def test_build_shot_features_schema():
    shots = filter_setpieces(_make_synthetic_shots(100))
    features = build_shot_features(shots)
    # All feature columns present
    for col in ALL_FEATURES:
        assert col in features.columns, f"missing {col}"
    # Target present
    assert TARGET_COLUMN in features.columns
    # Target is 0/1
    assert set(features[TARGET_COLUMN].unique()).issubset({0, 1})
    # One-hot situation: exactly one of 4 is 1 per row
    sit_sum = features[SITUATION_FEATURES].sum(axis=1)
    assert (sit_sum == 1).all()


def test_build_shot_features_no_target():
    shots = filter_setpieces(_make_synthetic_shots(50))
    # Drop goal_type to simulate predict-time
    shots_no_target = shots.drop(columns=["goal_type"])
    features = build_shot_features(shots_no_target, include_target=False)
    assert TARGET_COLUMN not in features.columns
    # Features still work
    for col in ALL_FEATURES:
        assert col in features.columns


def test_build_shot_features_empty():
    empty = pd.DataFrame(columns=["situation", "body_part", "shooter_x",
                                    "shooter_y", "minute", "goal_type"])
    features = build_shot_features(empty)
    # Should have all expected columns even if empty
    for col in ALL_FEATURES:
        assert col in features.columns
    assert len(features) == 0


def test_extract_X_rejects_missing_features():
    incomplete = pd.DataFrame({"shooter_x_norm": [0.5]})
    with pytest.raises(ValueError, match="missing required features"):
        extract_X(incomplete)


# ─────────────────────────────────────────────────────────────────────
# SetPiecePredictor unit tests (FAST — minimal training)
# ─────────────────────────────────────────────────────────────────────


def _trained_predictor():
    """Quickly-trained predictor on synthetic shots."""
    shots = filter_setpieces(_make_synthetic_shots(2000))
    features = build_shot_features(shots)
    X = extract_X(features)
    y = features[TARGET_COLUMN].values
    fast_params = {"n_estimators": 30, "learning_rate": 0.1, "verbosity": 0}
    predictor = SetPiecePredictor(base_params=fast_params, early_stopping_rounds=None)
    predictor.fit(X, y)
    return predictor


def test_predictor_rejects_unfitted_predict():
    p = SetPiecePredictor()
    with pytest.raises(RuntimeError, match="not fitted"):
        p.predict_proba(pd.DataFrame({f: [0.5] for f in ALL_FEATURES}))


def test_predictor_rejects_non_binary_y():
    p = SetPiecePredictor()
    X = pd.DataFrame({f: np.random.rand(200) for f in ALL_FEATURES})
    # Use integer values clearly outside {0, 1} after int-cast
    y = np.array([2] * 100 + [3] * 100, dtype=int)
    with pytest.raises(ValueError, match="binary"):
        p.fit(X, y)


def test_predictor_rejects_too_small_corpus():
    p = SetPiecePredictor()
    X = pd.DataFrame({f: np.random.rand(50) for f in ALL_FEATURES})
    y = (np.random.rand(50) > 0.5).astype(int)
    with pytest.raises(ValueError, match="insufficient"):
        p.fit(X, y)


def test_predictor_fit_predict_smoketest():
    predictor = _trained_predictor()
    assert predictor.is_fitted
    # Predict on small batch
    X_pred = pd.DataFrame({f: [0.5] * 5 for f in ALL_FEATURES})
    # Override one-hot to indicate corner shot for sample
    X_pred["situation_corner"] = 1
    X_pred["situation_free-kick"] = 0
    X_pred["situation_set-piece"] = 0
    X_pred["situation_penalty"] = 0
    proba = predictor.predict_proba(X_pred)
    assert proba.shape == (5,)
    assert np.all(np.isfinite(proba))
    assert np.all((proba >= 0) & (proba <= 1))


def test_predictor_predict_rejects_missing_features():
    predictor = _trained_predictor()
    X_incomplete = pd.DataFrame({"shooter_x_norm": [0.5]})
    with pytest.raises(ValueError, match="missing required features"):
        predictor.predict_proba(X_incomplete)


def test_predictor_save_load_roundtrip():
    predictor = _trained_predictor()
    with tempfile.NamedTemporaryFile(suffix=".pkl", delete=False) as f:
        predictor.save(Path(f.name))
        loaded = SetPiecePredictor.load(Path(f.name))
    # Same predictions
    X = pd.DataFrame({f: [0.5] * 3 for f in ALL_FEATURES})
    X["situation_corner"] = 1
    p_original = predictor.predict_proba(X)
    p_loaded = loaded.predict_proba(X)
    assert np.allclose(p_original, p_loaded)


def test_expected_goals_per_match_aggregation():
    predictor = _trained_predictor()
    shots = filter_setpieces(_make_synthetic_shots(500))
    features = build_shot_features(shots)
    agg = predictor.expected_goals_per_match(shots, features)
    # Returns Series indexed by (game_id, is_home)
    assert isinstance(agg, pd.Series)
    assert len(agg) > 0
    # All values positive (sum of probs)
    assert (agg >= 0).all()
    assert np.all(np.isfinite(agg.values))


def test_expected_goals_rejects_length_mismatch():
    predictor = _trained_predictor()
    shots = filter_setpieces(_make_synthetic_shots(500))
    features = build_shot_features(shots)
    # Drop some rows from features to create mismatch
    features_short = features.iloc[:-10]
    with pytest.raises(ValueError, match="length mismatch"):
        predictor.expected_goals_per_match(shots, features_short)


# ─────────────────────────────────────────────────────────────────────
# Integration tests (skip if dev-01 artifact missing)
# ─────────────────────────────────────────────────────────────────────


def _artifact_exists() -> bool:
    return (ARTIFACTS_DIR / "m4_setpiece-dev-01.pkl").exists()


@pytest.mark.skipif(not _artifact_exists(), reason="dev-01 m4 artifact not present")
def test_artifact_loads_with_correct_schema():
    predictor = SetPiecePredictor.load(ARTIFACTS_DIR / "m4_setpiece-dev-01.pkl")
    assert predictor.is_fitted
    assert set(predictor.feature_names) == set(ALL_FEATURES)


@pytest.mark.skipif(not _artifact_exists(), reason="dev-01 m4 artifact not present")
@pytest.mark.requires_data
def test_artifact_predicts_realistic_rates():
    """On TRUE OOS shots (late-25/26, after test_frac=0.25 split boundary), model
    should predict ~0.78 for penalty and ~0.09 for corner. Uses post-2026-02-22
    shots which are in the held-out test slice (model never saw them).
    """
    from v4.data.loaders import load_shotmap

    predictor = SetPiecePredictor.load(ARTIFACTS_DIR / "m4_setpiece-dev-01.pkl")
    # since=2026-02-22 ≈ chronological tail-25% of the 25/26 setpiece corpus,
    # matching the held-out test slice from training. Loader date-filters by
    # joined sofa_match.start_timestamp, so this is real OOS.
    shots = load_shotmap(
        situations=["penalty", "corner"],
        since="2026-02-22",
    )
    if len(shots) < 100:
        pytest.skip(f"insufficient OOS shots ({len(shots)}) — may be pre-train data")
    features = build_shot_features(shots)
    X = extract_X(features)
    proba = predictor.predict_proba(X)

    pen_mask = (features["situation_penalty"] == 1).values
    cor_mask = (features["situation_corner"] == 1).values
    if pen_mask.sum() >= 10:
        pen_avg = proba[pen_mask].mean()
        assert 0.65 < pen_avg < 0.90, f"OOS penalty avg {pen_avg:.3f} outside [0.65, 0.90]"
    if cor_mask.sum() >= 100:
        cor_avg = proba[cor_mask].mean()
        assert 0.04 < cor_avg < 0.14, f"OOS corner avg {cor_avg:.3f} outside [0.04, 0.14]"
