"""
Tests for v4.m3_xg.blended_predictor.

Verifies the routing + probability-space blend math without requiring full
training artifacts. The actual model-quality eval lives in
pipeline/stage_1_m3_blended.py.
"""
from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest

from v4.modules.m3_xg.blended_predictor import BlendedPredictor


def _make_mock_lean():
    """Build a mock XGPredictor that returns deterministic lean output."""
    lean = MagicMock()
    # mock predict_batch returns a DataFrame with lean lambdas + probs
    def fake_predict_batch(match_pairs, history, verbose=False):
        n = len(match_pairs)
        return pd.DataFrame({
            "lambda_h": np.full(n, 1.5),
            "lambda_a": np.full(n, 1.0),
            "prob_h": np.full(n, 0.50),
            "prob_d": np.full(n, 0.25),
            "prob_a": np.full(n, 0.25),
            "prob_over25": np.full(n, 0.55),
            "prob_under25": np.full(n, 0.45),
            "prob_btts_yes": np.full(n, 0.60),
        })
    lean.predict_batch.side_effect = fake_predict_batch
    return lean


def _make_mock_premium_ensemble():
    """Mock BayesianEnsemble with deterministic predict."""
    ens = MagicMock()
    ens.is_fitted = True
    ens.feature_names = ["x"]   # never actually used (we never invoke the premium path in mocked tests)
    return ens


class TestRoutingDecision:
    """Without game_id column → premium path NEVER fires."""

    def test_no_game_id_falls_back_to_lean(self):
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_a = _make_mock_premium_ensemble()
        bp = BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)

        pairs = pd.DataFrame({
            "league": ["epl"] * 2,
            "match_date": pd.to_datetime(["2025-10-01", "2025-10-15"]),
            "home": ["Arsenal", "Liverpool"],
            "away": ["Chelsea", "City"],
        })
        out = bp.predict_batch(pairs, history=pd.DataFrame())
        # premium_weight reflects router decision even without game_id;
        # what matters is the premium ensembles were NOT actually invoked
        # → final probs equal lean probs.
        assert (out["prob_h"] == out["prob_h_lean"]).all()
        # premium ensembles never called (no game_id → no premium path)
        prem_h.predict.assert_not_called()
        prem_a.predict.assert_not_called()
        # lambda_h_premium left as NaN (never populated)
        assert out["lambda_h_premium"].isna().all()

    def test_lean_only_league_skips_premium_even_with_game_id(self):
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_a = _make_mock_premium_ensemble()
        bp = BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)

        pairs = pd.DataFrame({
            "league": ["la_liga2"],   # lean-only tier
            "match_date": pd.to_datetime(["2025-10-15"]),
            "home": ["Mirandés"],
            "away": ["Eldense"],
            "game_id": [12345678],
        })
        out = bp.predict_batch(pairs, history=pd.DataFrame())
        assert out["premium_weight"].iloc[0] == 0.0
        assert out["premium_tier"].iloc[0] == "lean"
        prem_h.predict.assert_not_called()


class TestBlendMath:
    """Verify the prob-space blend formula: blend = w * premium + (1-w) * lean."""

    def test_blend_helper(self):
        """Use the internal helper directly — avoids tripping the feature-builder
        which requires real history."""
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_a = _make_mock_premium_ensemble()
        bp = BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)

        lean_p = {"H": 0.5, "D": 0.3, "A": 0.2}
        prem_p = {"H": 0.6, "D": 0.2, "A": 0.2}
        # weight = 0.5 → halfway
        out = bp._blend_prob_dicts(lean_p, prem_p, 0.5)
        assert out["H"] == pytest.approx(0.55)
        assert out["D"] == pytest.approx(0.25)
        assert out["A"] == pytest.approx(0.20)

    def test_blend_weight_zero_returns_lean(self):
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_a = _make_mock_premium_ensemble()
        bp = BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)

        lean_p = {"H": 0.5, "D": 0.3, "A": 0.2}
        prem_p = {"H": 0.9, "D": 0.05, "A": 0.05}
        out = bp._blend_prob_dicts(lean_p, prem_p, 0.0)
        assert out == lean_p

    def test_blend_weight_one_returns_premium(self):
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_a = _make_mock_premium_ensemble()
        bp = BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)

        lean_p = {"H": 0.5, "D": 0.3, "A": 0.2}
        prem_p = {"H": 0.9, "D": 0.05, "A": 0.05}
        out = bp._blend_prob_dicts(lean_p, prem_p, 1.0)
        assert out == prem_p

    def test_blend_preserves_distribution(self):
        """Blend of two distributions is itself a distribution (sums to 1.0)."""
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_a = _make_mock_premium_ensemble()
        bp = BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)

        lean_p = {"H": 0.55, "D": 0.27, "A": 0.18}
        prem_p = {"H": 0.31, "D": 0.41, "A": 0.28}
        for w in [0.1, 0.3, 0.5, 0.7, 0.9]:
            out = bp._blend_prob_dicts(lean_p, prem_p, w)
            assert abs(sum(out.values()) - 1.0) < 1e-9, f"sum != 1 at weight={w}"


class TestRejectUnfittedEnsemble:
    def test_premium_home_must_be_fitted(self):
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_h.is_fitted = False
        prem_a = _make_mock_premium_ensemble()
        with pytest.raises(ValueError, match="premium_home"):
            BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)

    def test_premium_away_must_be_fitted(self):
        lean = _make_mock_lean()
        prem_h = _make_mock_premium_ensemble()
        prem_a = _make_mock_premium_ensemble()
        prem_a.is_fitted = False
        with pytest.raises(ValueError, match="premium_away"):
            BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)
