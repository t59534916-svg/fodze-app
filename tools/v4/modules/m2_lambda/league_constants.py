"""
m2_lambda.league_constants — per-league average xG + home-advantage.

Computed from `team_xg_history` historical rows. Used as denominators in the
attack/defense decomposition:

    team_attack_strength = team_xg_ewma / league_avg_xg
    team_defense_weakness = team_xga_ewma / league_avg_xg

…and as the multiplicative base when reconstructing λ:

    λ_h = league_home_avg × home_attack × away_defense
    λ_a = league_away_avg × away_attack × home_defense

Empirical home-advantage delta (FODZE leagues, 25/26):
    Bundesliga +0.31  ·  EPL +0.30  ·  La Liga +0.35
    Serie A +0.23     ·  Ligue 1 +0.37  ·  Austria BL +0.24
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, Optional

import numpy as np
import pandas as pd


# Fallback constants for leagues with insufficient history.
# Calibrated from current-season 25/26 means (see reconnaissance above).
DEFAULT_HOME_XG_AVG = 1.55
DEFAULT_AWAY_XG_AVG = 1.30
DEFAULT_HOME_ADVANTAGE = 0.25
MIN_MATCHES_FOR_LEAGUE_AVG = 30  # below this, fall back to defaults


def compute_league_constants(
    history: pd.DataFrame,
    *,
    league: str,
    before_date: Optional[datetime] = None,
    lookback_days: int = 540,  # ~1.5 seasons of historical context
) -> Dict[str, float]:
    """Compute league-wide average xG + home-advantage from historical data.

    Args:
        history: DataFrame with columns league, match_date, venue, xg.
                 Must have already been loaded via data.loaders.
        league: target league code (e.g. 'bundesliga')
        before_date: only use matches strictly before this date (prevents leakage).
                     None = use all rows.
        lookback_days: max history depth (default 540 = ~1.5 seasons). Older
                       data biases the average toward a different competitive
                       environment.

    Returns:
        dict with keys:
          home_xg_avg, away_xg_avg, home_advantage, total_avg, n_matches
          n_matches < MIN_MATCHES_FOR_LEAGUE_AVG → defaults returned
    """
    if not isinstance(history, pd.DataFrame):
        raise TypeError(f"history must be DataFrame, got {type(history).__name__}")

    df = history[history["league"] == league].copy()
    if before_date is not None:
        df = df[df["match_date"] < pd.Timestamp(before_date)]
    if lookback_days is not None and before_date is not None:
        cutoff = pd.Timestamp(before_date) - pd.Timedelta(days=lookback_days)
        df = df[df["match_date"] >= cutoff]

    # Drop rows with missing xG (some sources don't populate it)
    df = df[df["xg"].notna()]

    n_matches = len(df)
    if n_matches < MIN_MATCHES_FOR_LEAGUE_AVG:
        return {
            "home_xg_avg": DEFAULT_HOME_XG_AVG,
            "away_xg_avg": DEFAULT_AWAY_XG_AVG,
            "home_advantage": DEFAULT_HOME_ADVANTAGE,
            "total_avg": DEFAULT_HOME_XG_AVG + DEFAULT_AWAY_XG_AVG,
            "n_matches": n_matches,
            "source": "default_fallback",
        }

    home_rows = df[df["venue"] == "home"]
    away_rows = df[df["venue"] == "away"]
    if len(home_rows) == 0 or len(away_rows) == 0:
        # League has data but venue-asymmetric → degenerate, fall back
        return {
            "home_xg_avg": DEFAULT_HOME_XG_AVG,
            "away_xg_avg": DEFAULT_AWAY_XG_AVG,
            "home_advantage": DEFAULT_HOME_ADVANTAGE,
            "total_avg": DEFAULT_HOME_XG_AVG + DEFAULT_AWAY_XG_AVG,
            "n_matches": n_matches,
            "source": "venue_asymmetric_fallback",
        }

    home_avg = float(home_rows["xg"].mean())
    away_avg = float(away_rows["xg"].mean())
    return {
        "home_xg_avg": home_avg,
        "away_xg_avg": away_avg,
        "home_advantage": home_avg - away_avg,
        "total_avg": home_avg + away_avg,
        "n_matches": n_matches,
        "source": "computed",
    }


def compute_league_constants_batch(
    history: pd.DataFrame,
    *,
    leagues: list,
    before_date: Optional[datetime] = None,
    lookback_days: int = 540,
) -> Dict[str, Dict[str, float]]:
    """Compute constants for multiple leagues in one pass — more efficient
    than calling compute_league_constants() per match in a training loop.

    Returns: {league_code: constants_dict}
    """
    return {
        league: compute_league_constants(
            history, league=league, before_date=before_date, lookback_days=lookback_days
        )
        for league in leagues
    }
