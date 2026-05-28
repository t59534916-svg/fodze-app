"""
m4_set_pieces.feature_builder — convert shotmap rows to model feature matrix.

Per V4-BACKTESTING-PROTOCOL §"m4_set_pieces", 5 features per shot:
  1. situation     (categorical: corner / free-kick / set-piece / penalty)
  2. body_part     (categorical: head / right-foot / left-foot / other)
  3. shooter_x     (normalized [0, 1] — distance from goal)
  4. shooter_y     (normalized [0, 1] — angle/lateral)
  5. minute_bucket (categorical: 0-15 / 15-30 / 30-45 / 45-60 / 60-75 / 75-90+)

Target: goal_outcome ∈ {0, 1} (derived from goal_type IS NOT NULL).

Output feature matrix uses one-hot encoding for the categoricals (XGBoost
handles native categorical via DMatrix but one-hot is simpler/portable).
"""
from __future__ import annotations

from typing import List, Optional

import numpy as np
import pandas as pd


# Setpiece-situation categories we model (per protocol Fix 6)
SETPIECE_SITUATIONS: List[str] = ["corner", "free-kick", "set-piece", "penalty"]

# Body parts found in Sofa data (verified via reconnaissance)
BODY_PARTS: List[str] = ["head", "right-foot", "left-foot", "other"]

# Minute buckets (6 bins of 15min, last includes added time)
MINUTE_BUCKETS: List[str] = ["00-15", "15-30", "30-45", "45-60", "60-75", "75+"]


# Final feature column order — DO NOT shuffle (trained models depend on this).
# After one-hot:
#   shooter_x_norm, shooter_y_norm  — numeric
#   situation_{c}                   — 4 binary indicators (one-hot)
#   body_part_{c}                   — 4 binary indicators (one-hot)
#   minute_bucket_{c}               — 6 binary indicators (one-hot)
# Total: 2 + 4 + 4 + 6 = 16 features
NUMERIC_FEATURES_RAW: List[str] = ["shooter_x_norm", "shooter_y_norm"]
SITUATION_FEATURES: List[str] = [f"situation_{s}" for s in SETPIECE_SITUATIONS]
BODY_PART_FEATURES: List[str] = [f"body_part_{b}" for b in BODY_PARTS]
MINUTE_FEATURES: List[str] = [f"minute_bucket_{m}" for m in MINUTE_BUCKETS]

ALL_FEATURES: List[str] = (
    NUMERIC_FEATURES_RAW + SITUATION_FEATURES + BODY_PART_FEATURES + MINUTE_FEATURES
)
TARGET_COLUMN: str = "goal_outcome"


def _bucket_minute(minute: int) -> str:
    """Map a minute (1-90+) to its bucket label."""
    if minute < 15:
        return "00-15"
    if minute < 30:
        return "15-30"
    if minute < 45:
        return "30-45"
    if minute < 60:
        return "45-60"
    if minute < 75:
        return "60-75"
    return "75+"


def filter_setpieces(shots: pd.DataFrame) -> pd.DataFrame:
    """Subset to setpiece-type shots only."""
    mask = shots["situation"].isin(SETPIECE_SITUATIONS)
    return shots[mask].reset_index(drop=True)


def normalize_coords(shooter_x: float, shooter_y: float) -> tuple[float, float]:
    """Normalize Sofa coords to [0, 1]. Sofa's frame: 0 = home goalmouth,
    100 = away goalmouth. Lateral y ∈ [0, 100]. We use as-is /100.

    Returns (x_norm, y_norm) both in [0, 1]. NaN → 0.5 (center).
    """
    x = shooter_x / 100.0 if pd.notna(shooter_x) else 0.5
    y = shooter_y / 100.0 if pd.notna(shooter_y) else 0.5
    return float(np.clip(x, 0, 1)), float(np.clip(y, 0, 1))


def build_shot_features(
    shots: pd.DataFrame,
    *,
    include_target: bool = True,
) -> pd.DataFrame:
    """Convert raw shotmap DataFrame to feature matrix.

    Args:
        shots: DataFrame with columns at minimum:
          situation, body_part, shooter_x, shooter_y, minute
          (plus goal_type if include_target=True; plus optionally
          goal_outcome if already derived).
        include_target: if True, include 'goal_outcome' column in output.

    Returns:
        pd.DataFrame with columns ALL_FEATURES (+ goal_outcome if target).
        Plus passthrough columns: game_id, league, season, is_home, match_date
        (preserved for downstream aggregation but NOT model inputs).
    """
    if len(shots) == 0:
        cols = ALL_FEATURES + ([TARGET_COLUMN] if include_target else [])
        return pd.DataFrame(columns=cols)

    df = shots.copy()

    # Derive goal_outcome if not present
    if include_target and TARGET_COLUMN not in df.columns:
        if "goal_type" not in df.columns:
            raise ValueError(
                "include_target=True but neither 'goal_outcome' nor 'goal_type' "
                "in shots DataFrame"
            )
        df[TARGET_COLUMN] = df["goal_type"].notna().astype(int)

    # Normalize coords (vectorized)
    df["shooter_x_norm"] = (df["shooter_x"].fillna(50.0) / 100.0).clip(0, 1)
    df["shooter_y_norm"] = (df["shooter_y"].fillna(50.0) / 100.0).clip(0, 1)

    # Minute bucket (vectorized)
    df["minute_bucket"] = df["minute"].fillna(45).astype(int).apply(_bucket_minute)

    # One-hot encode situation
    for sit in SETPIECE_SITUATIONS:
        df[f"situation_{sit}"] = (df["situation"] == sit).astype(int)

    # One-hot encode body_part (map missing/unknown → 'other')
    df["body_part_clean"] = df["body_part"].apply(
        lambda b: b if b in BODY_PARTS else "other"
    )
    for bp in BODY_PARTS:
        df[f"body_part_{bp}"] = (df["body_part_clean"] == bp).astype(int)

    # One-hot encode minute_bucket
    for mb in MINUTE_BUCKETS:
        df[f"minute_bucket_{mb}"] = (df["minute_bucket"] == mb).astype(int)

    # Select output columns
    output_cols = ALL_FEATURES.copy()
    if include_target:
        output_cols.append(TARGET_COLUMN)
    # Preserve passthrough metadata (for downstream per-team aggregation)
    metadata_cols = [c for c in ["game_id", "league", "season", "is_home",
                                  "match_date", "situation", "body_part", "minute"]
                     if c in df.columns]
    output_cols += metadata_cols

    return df[output_cols].copy()


def extract_X(features_df: pd.DataFrame) -> pd.DataFrame:
    """Project feature DataFrame to ONLY the model-input columns (ALL_FEATURES).
    Defends against accidental inclusion of metadata or target.
    """
    missing = [c for c in ALL_FEATURES if c not in features_df.columns]
    if missing:
        raise ValueError(
            f"features_df missing required features: {missing}. "
            f"Expected: {ALL_FEATURES}"
        )
    return features_df[ALL_FEATURES].copy()
