"""Interface-contract tests for m5_filters stubs.

Ensures the stub interfaces don't drift from V4-BACKTESTING-PROTOCOL §"Stub Modules".
When the stubs are replaced with real implementations, these contract tests
should continue passing (otherwise downstream code that uses the stubs breaks).
"""
from __future__ import annotations

import pytest

from v4.modules.m5_filters.live_intensity_stub import get_intensity
from v4.modules.m5_filters.regime_detector_stub import detect_regime


def test_regime_detector_returns_pre_kickoff():
    result = detect_regime({"minute": 0, "score_h": 0, "score_a": 0})
    assert result["regime_id"] == "pre_kickoff"
    assert 0.0 <= result["regime_strength"] <= 1.0
    assert result["last_shift_minute"] is None
    assert 0.0 <= result["shift_probability_next_5min"] <= 1.0


def test_live_intensity_returns_constant():
    result = get_intensity({"minute": 0}, (1.4, 1.1))
    assert abs(result["lambda_h_per_min"] - 1.4 / 90) < 1e-9
    assert abs(result["lambda_a_per_min"] - 1.1 / 90) < 1e-9
    assert result["uncertainty"] == 0.0


def test_live_intensity_rejects_negative_lambda():
    with pytest.raises(ValueError):
        get_intensity({"minute": 0}, (-0.5, 1.0))


def test_live_intensity_handles_zero_lambda():
    # Zero λ is mathematically valid (just means no expected goals)
    result = get_intensity({"minute": 0}, (0.0, 1.0))
    assert result["lambda_h_per_min"] == 0.0
