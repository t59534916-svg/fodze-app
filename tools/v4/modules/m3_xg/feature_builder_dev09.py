"""feature_builder_dev09 — pure bottom-up TABULA RASA feature matrix.

Architecture per FODZE-Optimal-Blueprint audit revision (2026-05-27):
  - NO dev-03 macro borrows (no Elo from team_xg_history, no momentum,
    no league-constants from EWMA, no lambda_h_naive).
  - Sofa-native: game_id as primary key, lineups from
    sofascore_player_match_stats WHERE is_starter=1.
  - Targets: sofascore_match.home_score / away_score (NOT team_xg_history.goals_for).

Day-2 feature vector (10 columns):
  8 bottom-up diff features (BottomUpCalculator output) +
  bottom_up_available + n_starters_with_history_min +
  league (categorical).

Future Day-3 may add: elo_diff_sofa (computed over Sofa results),
rest_days_diff (from start_timestamp). Held back to keep Day-2 G2 Holm
correction tractable (m=8 features → α_corrected = 0.05/8 = 0.00625).

Leakage contract:
  - BottomUpCalculator.fit() loads full corpus, but shift(1).rolling(N)
    ensures focal-match-exclusion at row level. Fitting on full corpus
    is leakage-safe; the cache for game G is independent of post-G rows.
  - Walk-forward CV: train on 22/23 + 23/24, test on 24/25 — temporal split.

Usage:
    fb = FeatureBuilderDev09(sqlite_path)
    fb.fit()  # internally fits BottomUpCalculator
    train_df = fb.build_corpus(seasons=("22/23", "23/24"), leagues=TOP5)
    test_df  = fb.build_corpus(seasons=("24/25",),         leagues=TOP5)
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from v4.modules.m3_xg.bottom_up_features import (
    DEV_09_BOTTOM_UP_FEATURES,
    MIN_STARTERS_WITH_HISTORY,
    BottomUpCalculator,
)

# Day-2 feature schema (LOCKED — see train_dev09.py::DEV_09_LOCKED_FEATURES)
DEV_09_NUMERIC_FEATURES: List[str] = [
    "bottom_up_xg_diff",
    "bottom_up_xa_diff",
    "bottom_up_shots_diff",
    "bottom_up_key_passes_diff",
    "attack_concentration_diff",
    "defense_block_sum_diff",
    "gk_saves_per_90_diff",
    "minutes_rate_diff",
    "bottom_up_available",
]
DEV_09_CATEGORICAL_FEATURES: List[str] = ["league"]
DEV_09_ALL_FEATURES: List[str] = DEV_09_NUMERIC_FEATURES + DEV_09_CATEGORICAL_FEATURES

# Targets are Sofa-native (home_score, away_score from sofascore_match)
DEV_09_TARGETS: List[str] = ["home_goals", "away_goals"]


class FeatureBuilderDev09:
    """Builds feature matrix for dev-09 training/eval.

    Internally fits a BottomUpCalculator on the full Sofa corpus, then
    queries lineups + outcomes per match to assemble the feature DataFrame.
    """

    def __init__(self, sqlite_path: Path):
        self.sqlite_path = Path(sqlite_path)
        self._bc: Optional[BottomUpCalculator] = None

    def fit(self) -> "FeatureBuilderDev09":
        """Fit the BottomUpCalculator (loads + computes full-corpus rolling)."""
        self._bc = BottomUpCalculator(self.sqlite_path).fit()
        return self

    def build_corpus(
        self,
        *,
        seasons: Sequence[str],
        leagues: Optional[Sequence[str]] = None,
        require_finished: bool = True,
        verbose: bool = False,
    ) -> pd.DataFrame:
        """Build feature matrix for matches in given seasons (+ optional league filter).

        Args:
            seasons: tuple of season strings, e.g. ("22/23", "23/24")
            leagues: optional league filter — None = all leagues in Sofa
            require_finished: only include matches with both home_score AND away_score
                              non-NULL (default True for training)
            verbose: print progress

        Returns:
            DataFrame with columns:
              DEV_09_NUMERIC_FEATURES + ["league"] + ["home_goals", "away_goals"] +
              ["game_id", "match_date", "season", "home_team", "away_team",
               "n_starters_with_history_min"]
        """
        if self._bc is None:
            raise RuntimeError("FeatureBuilderDev09 must be fit() before build_corpus()")

        # 1. Load matches with metadata
        con = sqlite3.connect(str(self.sqlite_path))
        season_placeholders = ",".join("?" * len(seasons))
        sql = f"""
            SELECT game_id, league, season, start_timestamp,
                   home_team, away_team, home_team_id, away_team_id,
                   home_score, away_score, status
            FROM sofascore_match
            WHERE season IN ({season_placeholders})
        """
        params = list(seasons)
        if leagues:
            league_placeholders = ",".join("?" * len(leagues))
            sql += f" AND league IN ({league_placeholders})"
            params.extend(leagues)
        if require_finished:
            sql += " AND home_score IS NOT NULL AND away_score IS NOT NULL"

        matches = pd.read_sql_query(sql, con, params=params)
        if verbose:
            print(f"  Loaded {len(matches):,} matches ({seasons}, leagues={leagues})")

        if len(matches) == 0:
            con.close()
            return pd.DataFrame(columns=DEV_09_ALL_FEATURES + DEV_09_TARGETS +
                                ["game_id", "match_date", "season", "home_team",
                                 "away_team", "n_starters_with_history_min"])

        # 2. Load starter lineups in bulk
        game_id_placeholders = ",".join("?" * len(matches))
        starters_df = pd.read_sql_query(f"""
            SELECT game_id, is_home, player_id
            FROM sofascore_player_match_stats
            WHERE is_starter = 1 AND game_id IN ({game_id_placeholders})
        """, con, params=matches["game_id"].tolist())
        con.close()
        if verbose:
            print(f"  Loaded {len(starters_df):,} starter-rows across {starters_df['game_id'].nunique():,} games")

        # Group lineups by (game_id, side)
        lineups: dict = {}
        for (gid, is_home), grp in starters_df.groupby(["game_id", "is_home"]):
            side = "home" if is_home else "away"
            lineups.setdefault(int(gid), {})[side] = grp["player_id"].tolist()

        # 3. Per-match: compute features
        rows: List[dict] = []
        n_no_lineup = 0
        n_no_history = 0
        for _, m in matches.iterrows():
            gid = int(m["game_id"])
            game_lineups = lineups.get(gid, {})
            starting_xi_home = game_lineups.get("home", [])
            starting_xi_away = game_lineups.get("away", [])

            if not starting_xi_home or not starting_xi_away:
                # No lineup data at all — Layer-3 degradation row
                feats = self._bc.get_features_for_match(
                    game_id=gid, starting_xi_home=[], starting_xi_away=[],
                )
                n_no_lineup += 1
            else:
                feats = self._bc.get_features_for_match(
                    game_id=gid,
                    starting_xi_home=starting_xi_home,
                    starting_xi_away=starting_xi_away,
                )
                if feats["bottom_up_available"] == 0:
                    n_no_history += 1

            # Ensure all DEV_09_NUMERIC_FEATURES are present (drop n_starters_with_history_min
            # from the model feature vector — it's metadata, not a model input)
            row = {f: float(feats[f]) for f in DEV_09_NUMERIC_FEATURES}
            row["league"] = m["league"]
            row["home_goals"] = float(m["home_score"])
            row["away_goals"] = float(m["away_score"])
            row["game_id"] = gid
            # Sofa start_timestamp is Unix seconds → naive datetime for join-friendliness
            row["match_date"] = pd.Timestamp(int(m["start_timestamp"]), unit="s")
            row["season"] = m["season"]
            row["home_team"] = m["home_team"]
            row["away_team"] = m["away_team"]
            row["n_starters_with_history_min"] = int(feats["n_starters_with_history_min"])
            rows.append(row)

        df = pd.DataFrame(rows)
        df["league"] = df["league"].astype("category")

        if verbose:
            n_available = int(df["bottom_up_available"].sum())
            print(f"  Built {len(df):,} feature rows  "
                  f"(available={n_available:,}={100*n_available/len(df):.1f}%, "
                  f"no-lineup={n_no_lineup:,}, no-history={n_no_history:,})")

        return df


def extract_X_dev09(features_df: pd.DataFrame) -> pd.DataFrame:
    """Extract LightGBM-ready feature matrix from build_corpus output.

    Drops metadata columns (game_id, match_date, season, etc.) — keeps only
    the actual model inputs in DEV_09_ALL_FEATURES order.
    """
    return features_df[DEV_09_ALL_FEATURES].copy()
