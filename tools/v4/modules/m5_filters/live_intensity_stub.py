"""
m5_filters.live_intensity_stub — pre-match intensity model (returns constant λ/90).

Per V4-BACKTESTING-PROTOCOL §"Stub Modules — Interface Contract":
v4 hybrid mode: pre-match assumes uniform goal-arrival rate over 90 minutes.
Future live implementation: PDMP + Neural-Hawkes self-exciting point process
producing λ(t | match_state) that captures momentum / late-game effects.
"""
from __future__ import annotations

from typing import Any, Dict, Tuple


def get_intensity(
    match_state: Dict[str, Any],
    lambda_pregame: Tuple[float, float],
) -> Dict[str, Any]:
    """Pre-match: returns constant intensity = pregame λ / 90.

    Args:
        match_state: dict (ignored in stub mode). Live impl would read:
            minute, score_h, score_a, possession, last_shot_minute, etc.
        lambda_pregame: (λ_h, λ_a) full-match expected goals from m3_xg.

    Returns:
        dict with:
          lambda_h_per_min: float — home expected goals per minute (constant in stub)
          lambda_a_per_min: float — away expected goals per minute
          uncertainty: float ∈ [0, 1] — confidence (0.0 = pre-match, no live data)
    """
    lambda_h, lambda_a = lambda_pregame
    if lambda_h < 0 or lambda_a < 0:
        raise ValueError(
            f"pregame λ must be non-negative, got h={lambda_h}, a={lambda_a}"
        )
    return {
        "lambda_h_per_min": lambda_h / 90,
        "lambda_a_per_min": lambda_a / 90,
        "uncertainty": 0.0,  # No live observation in stub mode
    }


# Interface contract test
if __name__ == "__main__":
    result = get_intensity({"minute": 0}, (1.4, 1.1))
    assert abs(result["lambda_h_per_min"] - 1.4 / 90) < 1e-9
    assert abs(result["lambda_a_per_min"] - 1.1 / 90) < 1e-9
    assert result["uncertainty"] == 0.0
    print("✓ live_intensity_stub interface contract verified")
