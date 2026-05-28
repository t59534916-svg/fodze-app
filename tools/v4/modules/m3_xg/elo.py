"""
m3_xg.elo — per-team Elo rating system for football.

Standard Elo with margin-of-victory adjustment, per-league isolation.

Algorithm:
  Each match m at date d updates Home and Away ratings:
    expected_home = 1 / (1 + 10^((R_a - R_h - HOME_FIELD) / 400))
    actual_home   = 1 if home_goals > away_goals, 0 if <, 0.5 if =
    margin_mult   = log(|home_goals - away_goals| + 1) × 2.2 / ((R_h - R_a) × 0.001 + 2.2)
    ΔR = K × margin_mult × (actual_home - expected_home)
    R_h_new = R_h + ΔR
    R_a_new = R_a - ΔR

Hyperparameters (FIFA + 538 hybrid):
  K            = 20.0     — sensitivity per match
  HOME_FIELD   = 100.0    — points added to home prior
  INITIAL      = 1500.0   — neutral starting rating
  CROSS_LEAGUE_PENALTY = 50.0 — newly-promoted teams lose this on entry

Critical invariant: NO future-leakage. EloCalculator processes matches in
strict chronological order; the rating used for prediction is the rating
BEFORE that match was processed (snapshot at match start, not after).

API:
  calculator = EloCalculator()
  calculator.fit(history_df)              # one-pass build, takes ~2s on 87k rows
  rating = calculator.get_rating(team, league, before_date=match_date)
  diff = calculator.get_elo_diff(home, away, league, match_date)
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


# Tuned defaults — Football-tournament-style Elo
K_FACTOR: float = 20.0
HOME_FIELD_ADVANTAGE: float = 100.0
INITIAL_RATING: float = 1500.0
# Newly-seen teams (promoted / cup-only) start at INITIAL_RATING; we don't
# apply a cross-league penalty since per-league isolation prevents cross-tier
# rating contamination. Promoted-team adjustment is a separate concern.


@dataclass
class _RatingSnapshot:
    """One historical (team, league, date) → rating tuple.

    Sorted chronologically per (team, league). For lookup at date D,
    binary-search for largest date < D and return that rating.
    """
    date: pd.Timestamp
    rating: float


def _expected_score(r_home: float, r_away: float,
                    home_field: float = HOME_FIELD_ADVANTAGE) -> float:
    """Expected probability that home wins."""
    diff = r_away - (r_home + home_field)
    return 1.0 / (1.0 + 10.0 ** (diff / 400.0))


def _margin_multiplier(goal_diff: int, rating_diff: float) -> float:
    """538-style margin-of-victory multiplier.

    Bigger goal margins are evidence of bigger strength gap, but with
    diminishing returns. Adjustment for rating-diff prevents giant teams
    from gaining too much from blowouts against weak opponents.
    """
    if goal_diff <= 0:
        return 1.0
    return math.log(abs(goal_diff) + 1) * 2.2 / (rating_diff * 0.001 + 2.2)


class EloCalculator:
    """Build + lookup per-team Elo ratings from historical match data.

    Fit-once, query-many pattern:
      - .fit(history) processes 87k rows in ~2s, stores all snapshots
      - .get_rating() binary-searches by date (O(log n) per call)
    """

    def __init__(
        self,
        *,
        k_factor: float = K_FACTOR,
        home_field: float = HOME_FIELD_ADVANTAGE,
        initial_rating: float = INITIAL_RATING,
        per_league: bool = True,
    ):
        self.k_factor = float(k_factor)
        self.home_field = float(home_field)
        self.initial_rating = float(initial_rating)
        self.per_league = bool(per_league)
        # Storage: {(league, team): [_RatingSnapshot, ...]} sorted ascending date
        self._history: Dict[Tuple[str, str], List[_RatingSnapshot]] = {}
        # Current ratings during fit: {(league, team): current_rating}
        self._current: Dict[Tuple[str, str], float] = {}
        self._fitted = False

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def _key(self, team: str, league: str) -> Tuple[str, str]:
        """Storage key. If per_league=False, league is collapsed to empty."""
        return ((league if self.per_league else ""), team)

    def fit(self, history: pd.DataFrame) -> "EloCalculator":
        """Build Elo history from team_xg_history.

        Args:
            history: must have columns: team, opponent, league, venue,
                     match_date, goals_for, goals_against.

        Pre-condition:
            history is processable in chronological order. Internally we
            sort by (match_date, venue) so each match (home + away rows)
            is treated as a single event.

        Returns: self (for chaining).
        """
        if not isinstance(history, pd.DataFrame):
            raise TypeError(f"history must be DataFrame, got {type(history).__name__}")
        required = {"team", "opponent", "league", "venue", "match_date",
                    "goals_for", "goals_against"}
        missing = required - set(history.columns)
        if missing:
            raise ValueError(f"history missing required columns: {missing}")

        # Filter to rows with valid goal data + venue
        df = history.dropna(subset=["goals_for", "goals_against"]).copy()
        df = df[df["venue"].isin(["home", "away"])]
        # Use only HOME-venue rows to define each match (avoid double-counting
        # home + away versions of the same match in our update loop)
        home_rows = df[df["venue"] == "home"].copy()
        # ── Determinism guard ─────────────────────────────────────────
        # `sort_values` defaults to kind='quicksort' which is UNSTABLE.
        # When multiple matches share the same match_date (every weekend of
        # every league), pandas may swap them — and crucially does so in a
        # way that depends on the INPUT row order. SQL returns rows ordered
        # by (match_date, team) but a downstream pd.to_datetime() + resort
        # by match_date ALONE can scramble the secondary order.
        #
        # Different secondary order → Elo updates fire in different order →
        # cumulative ratings drift up to ~10 Elo points by season-end.
        # Detected 2026-05-21 via dev03-features.test.ts golden parity:
        # cache exporter (which resorted internally) and Python golden
        # (which didn't) produced 597/800 mismatched team-league pairs.
        #
        # Fix: sort by (match_date, team, opponent) so the order is
        # CANONICAL regardless of how the caller pre-sorted. (team, opponent)
        # is the actual match identity — guaranteed unique per date.
        home_rows = home_rows.sort_values(
            ["match_date", "team", "opponent"], kind="mergesort"
        ).reset_index(drop=True)

        self._history.clear()
        self._current.clear()

        # One-pass update
        for _, row in home_rows.iterrows():
            league = row["league"]
            home_team = row["team"]
            away_team = row["opponent"]
            match_date = pd.Timestamp(row["match_date"])
            goals_h = int(row["goals_for"])
            goals_a = int(row["goals_against"])

            # Snapshot CURRENT ratings BEFORE this match (used for prediction)
            r_h = self._current.get(
                self._key(home_team, league), self.initial_rating
            )
            r_a = self._current.get(
                self._key(away_team, league), self.initial_rating
            )

            # Record snapshot (rating as-of just before this match)
            self._history.setdefault(self._key(home_team, league), []).append(
                _RatingSnapshot(date=match_date, rating=r_h)
            )
            self._history.setdefault(self._key(away_team, league), []).append(
                _RatingSnapshot(date=match_date, rating=r_a)
            )

            # Compute expected + actual
            expected_h = _expected_score(r_h, r_a, home_field=self.home_field)
            if goals_h > goals_a:
                actual_h = 1.0
            elif goals_h < goals_a:
                actual_h = 0.0
            else:
                actual_h = 0.5

            # Margin multiplier
            goal_diff = goals_h - goals_a
            # rating_diff is from winner's perspective
            if goal_diff > 0:
                rd = r_h - r_a
            elif goal_diff < 0:
                rd = r_a - r_h
            else:
                rd = 0
            mult = _margin_multiplier(abs(goal_diff), rd)

            # Symmetric update
            delta = self.k_factor * mult * (actual_h - expected_h)
            self._current[self._key(home_team, league)] = r_h + delta
            self._current[self._key(away_team, league)] = r_a - delta

        # Final state — sort snapshots ascending by date (insertion order
        # should already be sorted but be safe)
        for key, snapshots in self._history.items():
            snapshots.sort(key=lambda s: s.date)

        self._fitted = True
        return self

    def get_rating(
        self,
        team: str,
        league: str,
        before_date: pd.Timestamp,
    ) -> float:
        """Return Elo rating for team in league as-of-just-before before_date.

        If team has no prior matches → initial_rating.
        Binary search through snapshots for largest date < before_date.
        """
        if not self._fitted:
            raise RuntimeError("EloCalculator not fitted — call .fit() first")
        snapshots = self._history.get(self._key(team, league))
        if not snapshots:
            return self.initial_rating

        # Binary search: largest date STRICTLY less than before_date
        # (we want the rating as-of just-before the prediction match)
        target = pd.Timestamp(before_date)
        lo, hi = 0, len(snapshots)
        while lo < hi:
            mid = (lo + hi) // 2
            if snapshots[mid].date < target:
                lo = mid + 1
            else:
                hi = mid

        if lo == 0:
            # All snapshots are on/after target → team's first match is the
            # target itself, so we use initial_rating
            return self.initial_rating

        return snapshots[lo - 1].rating

    def get_elo_diff(
        self,
        home_team: str,
        away_team: str,
        league: str,
        match_date: pd.Timestamp,
    ) -> float:
        """Convenience: home_elo - away_elo at match_date.

        Returns 0.0 if either team has no prior matches (both at initial_rating).
        Note: This does NOT add HOME_FIELD_ADVANTAGE — that's applied in
        expected_score during fit. The diff returned is the pure rating delta.
        """
        r_h = self.get_rating(home_team, league, match_date)
        r_a = self.get_rating(away_team, league, match_date)
        return r_h - r_a

    def stats(self) -> Dict[str, float]:
        """Diagnostic: rating distribution stats across all teams (final state)."""
        if not self._fitted:
            return {}
        ratings = np.array(list(self._current.values()))
        return {
            "n_team_league_pairs": int(len(ratings)),
            "mean": float(ratings.mean()),
            "std": float(ratings.std()),
            "min": float(ratings.min()),
            "max": float(ratings.max()),
            "p25": float(np.percentile(ratings, 25)),
            "p75": float(np.percentile(ratings, 75)),
        }
