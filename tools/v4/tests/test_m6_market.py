"""Pytest cases for m6_market — math correctness of Shin + Benter.

Stage 1.m6 (Brier improvement gates) is separate and lives in
pipeline/stage_1_m6_market.py — it's a measurement, not a unit gate.

These pytest cases verify the math is correct independent of whether
the blend currently beats market.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import pytest

from v4.modules.m6_market import (
    BenterBlender,
    remove_vig,
    remove_vig_proportional,
    remove_vig_shin,
)


# ─────────────────────────────────────────────────────────────────────
# Shin vig-removal
# ─────────────────────────────────────────────────────────────────────


def test_proportional_sums_to_one():
    odds = np.array([1.65, 4.21, 5.30])
    fair = remove_vig_proportional(odds)
    assert abs(fair.sum() - 1.0) < 1e-9


def test_proportional_rejects_non_positive_odds():
    with pytest.raises(ValueError):
        remove_vig_proportional(np.array([1.5, -1.0]))
    with pytest.raises(ValueError):
        remove_vig_proportional(np.array([1.5, 0.0]))


def test_shin_recovers_fair_probs_when_no_vig():
    """When odds are already fair (sum 1/odds = 1.0), Shin returns identity."""
    fair_probs = np.array([0.5, 0.3, 0.2])
    odds = 1.0 / fair_probs
    recovered, z = remove_vig_shin(odds)
    assert np.allclose(recovered, fair_probs, atol=1e-6)
    assert z == 0.0


def test_shin_sums_to_one_with_vig():
    """Real Pinnacle odds with ~3% vig — Shin output sums to 1."""
    odds = np.array([1.65, 4.21, 5.30])
    fair, z = remove_vig_shin(odds)
    assert abs(fair.sum() - 1.0) < 1e-6
    # z should be > 0 (vig exists) but reasonable (< 0.1 for Pinnacle)
    assert 0.0 < z < 0.1


def test_shin_differs_from_proportional_with_vig():
    """Shin and proportional give different fair probs when vig > 0."""
    odds = np.array([2.20, 3.30, 3.20])  # ~7% vig
    prop = remove_vig_proportional(odds)
    shin = remove_vig(odds, method="shin")
    # Not identical (Shin shifts mass)
    assert not np.allclose(prop, shin)
    # But both sum to 1
    assert abs(prop.sum() - 1.0) < 1e-9
    assert abs(shin.sum() - 1.0) < 1e-6


def test_remove_vig_dispatcher_rejects_unknown_method():
    with pytest.raises(ValueError, match="unknown method"):
        remove_vig(np.array([2.0, 2.0]), method="xyz")


# ─────────────────────────────────────────────────────────────────────
# BenterBlender — math + structure
# ─────────────────────────────────────────────────────────────────────


def _synthetic_per_liga_data(seed=42):
    """Build synthetic (model probs, market probs, outcomes) per Liga."""
    rng = np.random.default_rng(seed)
    data = {}
    for liga in ["lg_a", "lg_b", "lg_c"]:
        n = 200
        # Sample true probs from Dirichlet
        true_probs = rng.dirichlet([2, 2, 2], size=n)
        outcomes = np.array([rng.choice(3, p=p) for p in true_probs], dtype=int)
        # Noisy model preds (perturbed true probs)
        model = np.clip(true_probs + rng.normal(0, 0.05, true_probs.shape), 0.01, 0.99)
        model = model / model.sum(axis=1, keepdims=True)
        # Slightly less noisy market preds
        market = np.clip(true_probs + rng.normal(0, 0.03, true_probs.shape), 0.01, 0.99)
        market = market / market.sum(axis=1, keepdims=True)
        data[liga] = (model, market, outcomes)
    return data


def test_blender_unfitted_rejects_blend():
    b = BenterBlender()
    with pytest.raises(RuntimeError, match="not fitted"):
        b.blend(np.array([0.5, 0.3, 0.2]), np.array([0.5, 0.3, 0.2]), "lg_a")


def test_blender_fit_assigns_per_liga_weights():
    data = _synthetic_per_liga_data()
    b = BenterBlender(min_liga_samples=50).fit(data)
    assert b.is_fitted
    assert set(b.liga_weights.keys()) == {"lg_a", "lg_b", "lg_c"}
    for liga in data:
        w = b.liga_weights[liga]
        assert 0.0 <= w["beta_model"] <= 2.0
        assert 0.0 <= w["beta_market"] <= 2.0
        assert w["fit_success"]


def test_blender_falls_back_to_global_for_small_liga():
    """A Liga with n < min_liga_samples should use global pooled weights."""
    data = _synthetic_per_liga_data()
    # Inject tiny Liga
    data["tiny_lg"] = (
        np.array([[0.5, 0.3, 0.2]] * 10),
        np.array([[0.5, 0.3, 0.2]] * 10),
        np.zeros(10, dtype=int),
    )
    b = BenterBlender(min_liga_samples=50).fit(data)
    assert "fallback" in b.liga_weights["tiny_lg"]["source"]
    assert b.liga_weights["tiny_lg"]["beta_model"] == b.global_weights[0]


def test_blender_blend_output_sums_to_one():
    data = _synthetic_per_liga_data()
    b = BenterBlender(min_liga_samples=50).fit(data)
    # Single row
    p_m = np.array([0.5, 0.3, 0.2])
    p_mk = np.array([0.4, 0.4, 0.2])
    blended = b.blend(p_m, p_mk, "lg_a")
    assert blended.shape == (3,)
    assert abs(blended.sum() - 1.0) < 1e-9


def test_blender_blend_batch_shape_preserved():
    data = _synthetic_per_liga_data()
    b = BenterBlender(min_liga_samples=50).fit(data)
    p_m = np.array([[0.5, 0.3, 0.2], [0.3, 0.4, 0.3]])
    p_mk = np.array([[0.4, 0.4, 0.2], [0.35, 0.4, 0.25]])
    blended = b.blend(p_m, p_mk, "lg_a")
    assert blended.shape == (2, 3)
    assert np.allclose(blended.sum(axis=1), 1.0)


def test_blender_rejects_mismatched_shapes():
    data = _synthetic_per_liga_data()
    b = BenterBlender(min_liga_samples=50).fit(data)
    with pytest.raises(ValueError, match="shape mismatch"):
        b.blend(
            np.array([0.5, 0.3, 0.2]),
            np.array([[0.5, 0.3, 0.2]]),
            "lg_a",
        )


def test_blender_fit_rejects_empty():
    with pytest.raises(ValueError, match="empty"):
        BenterBlender().fit({})


def test_blender_save_load_roundtrip():
    data = _synthetic_per_liga_data()
    b = BenterBlender(min_liga_samples=50).fit(data)
    with tempfile.NamedTemporaryFile(suffix=".pkl", delete=False) as f:
        b.save(Path(f.name))
        loaded = BenterBlender.load(Path(f.name))
    p_m = np.array([0.4, 0.4, 0.2])
    p_mk = np.array([0.5, 0.3, 0.2])
    bl_original = b.blend(p_m, p_mk, "lg_a")
    bl_loaded = loaded.blend(p_m, p_mk, "lg_a")
    assert np.allclose(bl_original, bl_loaded)


def test_blender_unknown_liga_uses_global():
    """A Liga unseen at fit-time should use global pooled weights."""
    data = _synthetic_per_liga_data()
    b = BenterBlender(min_liga_samples=50).fit(data)
    # Blend in an unknown Liga
    p_m = np.array([0.5, 0.3, 0.2])
    p_mk = np.array([0.4, 0.4, 0.2])
    result = b.blend(p_m, p_mk, "unseen_lg")
    assert result.shape == (3,)
    assert abs(result.sum() - 1.0) < 1e-9


def test_blender_validates_input_probs_sum_to_one():
    """fit() should reject probs that don't sum to ~1."""
    bad_data = {
        "lg_x": (
            np.array([[0.5, 0.3, 0.5]] * 200),  # rows sum to 1.3
            np.array([[0.4, 0.4, 0.2]] * 200),
            np.zeros(200, dtype=int),
        )
    }
    with pytest.raises(ValueError, match="sum to ~1"):
        BenterBlender(min_liga_samples=50).fit(bad_data)


def test_blender_rejects_negative_probabilities():
    """fit() must reject negative probabilities even if rows sum to 1.0.

    Regression test for bug found 2026-05-12: previously, [-0.1, 0.5, 0.6]
    (sums to 1.0 but has a negative) passed validation. Internal log-clip
    at 1e-12 then silently fitted on garbage, returning β_market=2.0 (hit
    upper bound trying to explain the corrupted input).
    """
    bad_data = {
        "lg_x": (
            np.array([[-0.1, 0.5, 0.6]] * 200),  # sums to 1.0 but has -0.1
            np.array([[0.4, 0.4, 0.2]] * 200),
            np.zeros(200, dtype=int),
        )
    }
    with pytest.raises(ValueError, match=r"outside \[0, 1\]"):
        BenterBlender(min_liga_samples=50).fit(bad_data)


def test_blender_rejects_probs_above_one():
    """fit() must reject probs > 1 even with valid row sums."""
    bad_data = {
        "lg_x": (
            np.array([[1.5, -0.3, -0.2]] * 200),  # sums to 1.0 but [0]=1.5
            np.array([[0.4, 0.4, 0.2]] * 200),
            np.zeros(200, dtype=int),
        )
    }
    with pytest.raises(ValueError, match=r"outside \[0, 1\]"):
        BenterBlender(min_liga_samples=50).fit(bad_data)
