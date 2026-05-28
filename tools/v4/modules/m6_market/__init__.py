"""v4.modules.m6_market — Shin vig-removal + per-Liga Benter blend.

Pipeline: m3 probs + market odds → vig-removed market probs → Benter log-pool blend.

Public API:
  remove_vig_proportional, remove_vig_shin, remove_vig — vig-removal kernels
  BenterBlender                                         — per-Liga log-pool fit + apply

Typical fitting flow:
    # For each Liga: pair m3 OOF preds with vig-removed market probs + outcomes
    per_liga_data = {
        "bundesliga": (p_model_arr, p_market_arr, outcomes),
        ...
    }
    blender = BenterBlender().fit(per_liga_data)
    blender.save("artifacts/m6_benter-dev-01.pkl")

Typical inference flow:
    market_probs = remove_vig(np.array([psch, pscd, psca]), method="shin")
    blended = blender.blend(p_m3, market_probs, league="bundesliga")
"""
from v4.modules.m6_market.benter import (
    BETA_BOUNDS,
    DEFAULT_BETAS,
    MIN_LIGA_SAMPLES,
    BenterBlender,
)
from v4.modules.m6_market.shin import (
    remove_vig,
    remove_vig_proportional,
    remove_vig_shin,
)

__all__ = [
    "BenterBlender",
    "DEFAULT_BETAS",
    "BETA_BOUNDS",
    "MIN_LIGA_SAMPLES",
    "remove_vig",
    "remove_vig_proportional",
    "remove_vig_shin",
]
