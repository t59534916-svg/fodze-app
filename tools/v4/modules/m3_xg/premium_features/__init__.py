"""
m3_xg.premium_features — 9 Sofa-extras-derived rolling-window features for
the dev-06 specialist model.

Each calculator reads from `tools/sofascore/data/local_extras.db` and emits a
single scalar per (game_id, side='home'|'away'). All calculators share the
same contract via the `PremiumFeature` ABC.

Per the 2026-05-20 coverage probe, only these 9 features have ≥80% coverage
on the always-premium 7-league × 3-season subset:

  1. mean_shot_xg_for_diff       (shotmap.xg, EWMA-5)            96.4%
  2. big_chance_rate_diff        (match_stats.big_chances, RM-5) 82.1% [impute]
  3. key_pass_quality_diff       (player_match_stats, top-11)    98.1%
  4. xa_creator_concentration    (player_match_stats.xa)         98.1%
  5. attack_position_y_diff      (avg_positions, FW players)     96.0%
  6. defense_line_height_diff    (avg_positions, DEF players)    96.0%
  7. tactical_width_diff         (avg_positions, std-x)          96.0%
  8. manager_tenure_match_idx    (match_managers diff)           98.2%
  9. setpiece_xg_share_diff      (shotmap.situation)             96.4%

(fast_break_rate dropped — 63% coverage triggered the Sparsity-Trap pattern
that killed dev-04 + dev-05.)
"""
from v4.modules.m3_xg.premium_features.base import PremiumFeature, TacticalWidthDiff
# Stubs (Sprint 2 follow-ups — interfaces locked, implementations TODO):
from v4.modules.m3_xg.premium_features.base import (
    MeanShotXgDiff,
    BigChanceRateDiff,
    KeyPassQualityDiff,
    XaCreatorConcentration,
    AttackPositionYDiff,
    DefenseLineHeightDiff,
    ManagerTenureMatchIdx,
    SetpieceXgShareDiff,
)

__all__ = [
    "PremiumFeature",
    "TacticalWidthDiff",
    "MeanShotXgDiff",
    "BigChanceRateDiff",
    "KeyPassQualityDiff",
    "XaCreatorConcentration",
    "AttackPositionYDiff",
    "DefenseLineHeightDiff",
    "ManagerTenureMatchIdx",
    "SetpieceXgShareDiff",
]

# Locked ordering for feature_builder_premium.py — DO NOT reshuffle.
# Adding/removing a feature requires re-training m3_premium with a new tag.
PREMIUM_FEATURE_ORDER = [
    "mean_shot_xg_for_diff",
    "big_chance_rate_diff",
    "key_pass_quality_diff",
    "xa_creator_concentration",
    "attack_position_y_diff",
    "defense_line_height_diff",
    "tactical_width_diff",
    "manager_tenure_match_idx",
    "setpiece_xg_share_diff",
]
