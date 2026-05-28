"""
m3_xg.feature_builder_premium — orchestrates the 9 Sofa-extras premium feature
calculators into one feature row per match.

This is the SPECIALIST side of the Option C architecture (see
coverage_router.py for context). The lean side (m3_lean = dev-03 unchanged)
emits 16 features per match; this module emits 9 more, all derived from the
local SQLite Sofa-extras mirror.

Sprint 1 scope (this file):
  • Wire all 9 calculator classes from premium_features/
  • Provide build_premium_features_for_match() + _for_corpus()
  • Match the public API shape of feature_builder.py for symmetric integration

Sprint 2 scope (TODO downstream):
  • Implement the 8 stub calculators in premium_features/base.py
  • Build train_m3_premium.py — trains LightGBM on lean_16 + premium_9 = 25
    features over the always-premium-7-leagues × 3-seasons subset (~7400 matches)
  • Wire predictor.py with the coverage_router blend logic
"""
from __future__ import annotations

from typing import Dict, List, Optional

import pandas as pd

from v4.modules.m3_xg.premium_features import (
    PREMIUM_FEATURE_ORDER,
    AttackPositionYDiff,
    BigChanceRateDiff,
    DefenseLineHeightDiff,
    KeyPassQualityDiff,
    ManagerTenureMatchIdx,
    MeanShotXgDiff,
    PremiumFeature,
    SetpieceXgShareDiff,
    TacticalWidthDiff,
    XaCreatorConcentration,
)


# Wire-order MUST match PREMIUM_FEATURE_ORDER. Type ABC ensures we don't
# drop one accidentally.
def _build_calculators() -> Dict[str, PremiumFeature]:
    """One instance per feature, in the locked schema-order."""
    calculators: Dict[str, PremiumFeature] = {
        "mean_shot_xg_for_diff":    MeanShotXgDiff(),
        "big_chance_rate_diff":     BigChanceRateDiff(),
        "key_pass_quality_diff":    KeyPassQualityDiff(),
        "xa_creator_concentration": XaCreatorConcentration(),
        "attack_position_y_diff":   AttackPositionYDiff(),
        "defense_line_height_diff": DefenseLineHeightDiff(),
        "tactical_width_diff":      TacticalWidthDiff(),
        "manager_tenure_match_idx": ManagerTenureMatchIdx(),
        "setpiece_xg_share_diff":   SetpieceXgShareDiff(),
    }
    # Sanity: order matches the locked list, no dupes, no missing
    assert list(calculators.keys()) == PREMIUM_FEATURE_ORDER, (
        f"Wire-order drift: {list(calculators.keys())} != {PREMIUM_FEATURE_ORDER}"
    )
    return calculators


# Singleton — calculators are stateless (each call opens its own DB connection).
_CALCULATORS: Optional[Dict[str, PremiumFeature]] = None


def get_calculators() -> Dict[str, PremiumFeature]:
    """Lazy-init singleton."""
    global _CALCULATORS
    if _CALCULATORS is None:
        _CALCULATORS = _build_calculators()
    return _CALCULATORS


def build_premium_features_for_match(
    game_id: int,
    *,
    impute_zero_on_missing: bool = True,
) -> Dict[str, Optional[float]]:
    """Compute the 9 premium features for one match.

    Args:
      game_id: sofascore_match.game_id (must exist in local SQLite or all
        features will be None).
      impute_zero_on_missing: if True, missing per-feature values are imputed
        to 0.0 (matches the LightGBM training expectation — Tweedie objective
        doesn't tolerate NaN). If False, missing → None (useful for diagnostics
        + computing per-feature coverage rates).

    Returns:
      Dict mapping feature_name → scalar, in PREMIUM_FEATURE_ORDER. Length 9.
    """
    out: Dict[str, Optional[float]] = {}
    for name, calc in get_calculators().items():
        val = calc.compute(game_id, "diff")
        if val is None and impute_zero_on_missing:
            val = 0.0
        out[name] = val
    return out


def build_premium_features_for_corpus(
    game_ids: List[int],
    *,
    impute_zero_on_missing: bool = True,
) -> pd.DataFrame:
    """Compute premium features for a list of matches, return a DataFrame.

    Columns: game_id + PREMIUM_FEATURE_ORDER (10 columns total).

    Args:
      game_ids: list of sofascore_match.game_id values.

    Returns:
      pd.DataFrame indexed by row-position, with game_id as the first column.
      Rows where ALL 9 features came back None get a `_skip` boolean column
      = True so callers can drop them before training (the model can't learn
      from rows where no specialist signal is available).
    """
    rows: List[Dict[str, Optional[float]]] = []
    for gid in game_ids:
        feats = build_premium_features_for_match(
            gid, impute_zero_on_missing=impute_zero_on_missing,
        )
        row: Dict[str, Optional[float]] = {"game_id": gid, **feats}
        # _skip detection: if all 9 came back None (NOT imputed), mark.
        # Done by re-running with impute=False on the raw scalars.
        if impute_zero_on_missing:
            # _skip detection requires raw values — re-run with impute=False
            raw = build_premium_features_for_match(gid, impute_zero_on_missing=False)
            row["_skip"] = all(v is None for v in raw.values())
        else:
            row["_skip"] = all(v is None for v in feats.values())
        rows.append(row)
    return pd.DataFrame(rows)


# ── Schema sanity check (for tests + downstream integration) ────────────
def expected_columns(include_skip: bool = False) -> List[str]:
    """The 10 (or 11) columns that a corpus-build emits, in order."""
    cols = ["game_id"] + list(PREMIUM_FEATURE_ORDER)
    if include_skip:
        cols.append("_skip")
    return cols
