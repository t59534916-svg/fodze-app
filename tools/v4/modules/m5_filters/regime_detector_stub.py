"""
m5_filters.regime_detector_stub — pre-match regime detector (always returns pre_kickoff).

Per V4-BACKTESTING-PROTOCOL §"Stub Modules — Interface Contract":
v4 is hybrid (pre-match active + live stubs). This stub guarantees the live-mode
interface so a future PDMP/regime-detector swap is plug-in.

Future implementation: Piecewise-Deterministic Markov Process detecting regime
shifts (e.g. "leading-defensive", "trailing-pressing", "red-card-down") from
live match-state and modifying λ(t) accordingly.
"""
from __future__ import annotations

from typing import Any, Dict


def detect_regime(match_state: Dict[str, Any]) -> Dict[str, Any]:
    """Pre-match: always returns the 'pre_kickoff' regime.

    Args:
        match_state: dict with at least {minute, score_h, score_a, red_cards_h, red_cards_a}.
            Ignored in stub mode.

    Returns:
        dict with:
          regime_id: str — one of {"pre_kickoff", "open_play", "leading", "trailing",
                                    "red_card_down", "late_game_chasing"}
          regime_strength: float ∈ [0, 1] — confidence in regime classification
          last_shift_minute: int | None — minute of last regime transition
          shift_probability_next_5min: float ∈ [0, 1] — predicted P(regime shift)
    """
    return {
        "regime_id": "pre_kickoff",
        "regime_strength": 1.0,
        "last_shift_minute": None,
        "shift_probability_next_5min": 0.0,
    }


# Interface contract test — verify stub returns shape downstream expects
if __name__ == "__main__":
    result = detect_regime({"minute": 0, "score_h": 0, "score_a": 0})
    assert result["regime_id"] == "pre_kickoff"
    assert 0.0 <= result["regime_strength"] <= 1.0
    assert result["last_shift_minute"] is None
    assert 0.0 <= result["shift_probability_next_5min"] <= 1.0
    print("✓ regime_detector_stub interface contract verified")
