"""
team_momentum.py — TeamMomentumCalculator: rolling team-quality + form-streak.

Two features:
  - lineup_quality:  rolling-5-game team strength proxy
                     = mean((goals_for + xg_for) / 2 - (goals_against + xg_against) / 2)
                     over last 5 matches per team. Normalized within league.
  - form_streak:     weighted points over last 3 matches
                     (3×P_last + 2×P_penult + 1×P_3rd-last); P = 3/1/0 for W/D/L.
                     Normalized within league.

Both are leakage-safe: query at match_date returns ONLY matches strictly before.

Why these proxies?
  - Sofa's avg_rating (per-team pre-match rating) only exists for 25/26 season,
    so direct player-level lineup-quality features cannot train on 23/24 history.
  - lineup_quality combines goals AND xG over a different window (5 games, not
    EWMA decay) than existing `home_attack_ratio` — captures recent form spike
    that EWMA-smoothing dampens.
  - form_streak is autocorrelated by design (streak ≠ mean) and not directly
    captured by any existing feature.

Fit-once query-many pattern (same as EloCalculator).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import bisect
import numpy as np
import pandas as pd


# Window sizes
LINEUP_WINDOW = 5      # last-N games for lineup_quality
FORM_WINDOW = 3        # last-N games for form_streak

# Weights for form_streak (last → first)
FORM_WEIGHTS = [3.0, 2.0, 1.0]


@dataclass(frozen=True)
class _MomentumSnapshot:
    """Per-team rolling state as-of a given match_date (strictly BEFORE the match).

    raw_lineup: float, raw rolling-5 (gf+xg)/2 - (ga+xga)/2 metric
    raw_form:   float, weighted-3 points sum (max 18, min 0)
    n_seen:     int,   how many matches this team has in history before this date
    """
    date: pd.Timestamp
    raw_lineup: float
    raw_form: float
    n_seen: int


class TeamMomentumCalculator:
    """Build + query per-team rolling features from team_xg_history.

    Usage:
        mc = TeamMomentumCalculator().fit(history)
        feats = mc.get_features(
            home_team="Bayern", away_team="Dortmund",
            league="bundesliga", match_date=pd.Timestamp("2026-04-05"),
        )
        # feats["lineup_quality_diff"], feats["form_streak_diff"]
    """

    def __init__(
        self,
        *,
        lineup_window: int = LINEUP_WINDOW,
        form_window: int = FORM_WINDOW,
    ):
        self.lineup_window = int(lineup_window)
        self.form_window = int(form_window)
        # Snapshots: {(league, team): [_MomentumSnapshot, ...]} sorted ascending date
        self._snapshots: Dict[Tuple[str, str], List[_MomentumSnapshot]] = {}
        # Per-(league, date) normalization: rolling mean+std of raw values
        # Computed once at fit time using a 365-day lookback window.
        # Stored as: {(league, key): [(date, mean_lineup, std_lineup, mean_form, std_form), ...]}
        self._norms: Dict[str, List[Tuple[pd.Timestamp, float, float, float, float]]] = {}
        self._fitted = False

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def _key(self, team: str, league: str) -> Tuple[str, str]:
        return (league, team)

    def fit(self, history: pd.DataFrame) -> "TeamMomentumCalculator":
        """Build per-team rolling snapshots from team_xg_history.

        Args:
            history: must have columns: team, league, match_date, goals_for,
                     goals_against, xg, xga.

        Returns: self (for chaining).
        """
        required = {"team", "league", "match_date", "goals_for", "goals_against", "xg", "xga"}
        missing = required - set(history.columns)
        if missing:
            raise ValueError(f"history missing required columns: {missing}")

        df = history.dropna(subset=["goals_for", "goals_against"]).copy()
        # xg/xga can be null for older rows — use goals as fallback
        df["xg"] = df["xg"].fillna(df["goals_for"])
        df["xga"] = df["xga"].fillna(df["goals_against"])
        df["match_date"] = pd.to_datetime(df["match_date"])
        # Determinism: stable mergesort + canonical (date, opponent) secondary
        # to break ties in a way that doesn't depend on input row order. See
        # equivalent comment in EloCalculator.fit() — same bug class.
        df = df.sort_values(
            ["league", "team", "match_date", "opponent"], kind="mergesort"
        ).reset_index(drop=True)

        # Per-(league, team) rolling: walk in order, snapshot BEFORE each match
        self._snapshots.clear()
        # For league-normalization we need ALL raw snapshots per (league, date) → build
        # a list per league.
        per_league_raw: Dict[str, List[Tuple[pd.Timestamp, float, float]]] = {}

        for (league, team), grp in df.groupby(["league", "team"], sort=False):
            # Stable sort + secondary opponent key — same determinism reason
            grp = grp.sort_values(["match_date", "opponent"], kind="mergesort")
            gf = grp["goals_for"].values.astype(float)
            ga = grp["goals_against"].values.astype(float)
            xg = grp["xg"].values.astype(float)
            xga_v = grp["xga"].values.astype(float)
            dates = pd.to_datetime(grp["match_date"]).values

            key = self._key(team, league)
            self._snapshots[key] = []
            per_league_raw.setdefault(league, [])

            # Pre-compute per-row "strength" and "points"
            strength = (gf + xg) / 2.0 - (ga + xga_v) / 2.0  # signed quality
            # Points: 3/1/0
            points = np.where(gf > ga, 3.0, np.where(gf == ga, 1.0, 0.0))

            for i in range(len(grp)):
                # Snapshot is the team's state JUST BEFORE this match — use ROWS i-1, i-2, ...
                # Lineup: last `lineup_window` matches before this one
                lo = max(0, i - self.lineup_window)
                lineup_vals = strength[lo:i]
                raw_lineup = float(np.mean(lineup_vals)) if len(lineup_vals) > 0 else 0.0

                # Form: weighted last `form_window` matches before this one
                # FORM_WEIGHTS[0] = last (most recent), FORM_WEIGHTS[-1] = oldest in window
                if i > 0:
                    # most recent first → traverse points[i-1], points[i-2], ...
                    recent_pts = points[max(0, i - self.form_window):i][::-1]
                    weights = FORM_WEIGHTS[:len(recent_pts)]
                    raw_form = float(np.dot(recent_pts, weights))
                else:
                    raw_form = 0.0

                snapshot_date = pd.Timestamp(dates[i])
                self._snapshots[key].append(
                    _MomentumSnapshot(
                        date=snapshot_date,
                        raw_lineup=raw_lineup,
                        raw_form=raw_form,
                        n_seen=i,
                    )
                )
                per_league_raw[league].append((snapshot_date, raw_lineup, raw_form))

        # Pre-compute per-league rolling-365d normalization stats
        # For each unique date in league, compute mean+std of raw values in
        # window [date-365d, date). We approximate by sorting and using all
        # snapshots within the lookback window — O(L * D) where L = leagues,
        # D = distinct dates per league.
        self._norms.clear()
        for league, raws in per_league_raw.items():
            arr = sorted(raws, key=lambda x: x[0])
            dates_arr = np.array([r[0] for r in arr])
            lineup_arr = np.array([r[1] for r in arr])
            form_arr = np.array([r[2] for r in arr])

            # Use distinct dates to avoid recomputing
            unique_dates = np.unique(dates_arr)
            stats_list: List[Tuple[pd.Timestamp, float, float, float, float]] = []
            for d in unique_dates:
                lookback_lo = d - pd.Timedelta(days=365)
                mask = (dates_arr >= lookback_lo) & (dates_arr < d)
                if mask.sum() < 5:
                    # Too little data — use full league history up to d
                    mask = dates_arr < d
                if mask.sum() < 2:
                    stats_list.append((pd.Timestamp(d), 0.0, 1.0, 0.0, 1.0))
                    continue
                mu_l = float(np.mean(lineup_arr[mask]))
                sd_l = float(np.std(lineup_arr[mask], ddof=0))
                if sd_l < 1e-6: sd_l = 1.0
                mu_f = float(np.mean(form_arr[mask]))
                sd_f = float(np.std(form_arr[mask], ddof=0))
                if sd_f < 1e-6: sd_f = 1.0
                stats_list.append((pd.Timestamp(d), mu_l, sd_l, mu_f, sd_f))
            self._norms[league] = stats_list

        self._fitted = True
        return self

    def _lookup_snapshot(
        self, league: str, team: str, match_date: pd.Timestamp
    ) -> Optional[_MomentumSnapshot]:
        """Most recent snapshot strictly BEFORE match_date for this team."""
        key = self._key(team, league)
        snaps = self._snapshots.get(key)
        if not snaps:
            return None
        dates = [s.date for s in snaps]
        # bisect_left returns insertion point — snapshots strictly before match_date
        idx = bisect.bisect_left(dates, match_date)
        if idx == 0:
            return None
        return snaps[idx - 1]

    def _get_norm(
        self, league: str, match_date: pd.Timestamp
    ) -> Tuple[float, float, float, float]:
        """Return (mu_lineup, sd_lineup, mu_form, sd_form) for normalization."""
        stats = self._norms.get(league)
        if not stats:
            return (0.0, 1.0, 0.0, 1.0)
        dates = [s[0] for s in stats]
        idx = bisect.bisect_left(dates, match_date)
        if idx == 0:
            return (0.0, 1.0, 0.0, 1.0)
        # use stats just before match_date
        _, mu_l, sd_l, mu_f, sd_f = stats[idx - 1]
        return mu_l, sd_l, mu_f, sd_f

    def get_features(
        self,
        *,
        home_team: str,
        away_team: str,
        league: str,
        match_date: pd.Timestamp,
    ) -> Dict[str, float]:
        """Return dict with lineup_quality_diff + form_streak_diff (per-liga z-normalized).

        If a team has no history → returns 0.0 for both (neutral signal).
        """
        if not self._fitted:
            raise RuntimeError("TeamMomentumCalculator not fitted. Call .fit(history) first.")

        match_date = pd.Timestamp(match_date)
        snap_h = self._lookup_snapshot(league, home_team, match_date)
        snap_a = self._lookup_snapshot(league, away_team, match_date)
        mu_l, sd_l, mu_f, sd_f = self._get_norm(league, match_date)

        h_lineup_raw = snap_h.raw_lineup if snap_h is not None else mu_l
        a_lineup_raw = snap_a.raw_lineup if snap_a is not None else mu_l
        h_form_raw = snap_h.raw_form if snap_h is not None else mu_f
        a_form_raw = snap_a.raw_form if snap_a is not None else mu_f

        h_lineup_z = (h_lineup_raw - mu_l) / sd_l
        a_lineup_z = (a_lineup_raw - mu_l) / sd_l
        h_form_z = (h_form_raw - mu_f) / sd_f
        a_form_z = (a_form_raw - mu_f) / sd_f

        # Clip to [-3, 3] for numerical safety (z-scores can blow up in low-data leagues)
        clip = lambda v: float(np.clip(v, -3.0, 3.0))
        return {
            "lineup_quality_diff": clip(h_lineup_z - a_lineup_z),
            "form_streak_diff": clip(h_form_z - a_form_z),
        }

    def stats(self) -> Dict[str, float]:
        """Sanity-check distribution of stored snapshots."""
        all_lineup = []
        all_form = []
        for snaps in self._snapshots.values():
            for s in snaps:
                all_lineup.append(s.raw_lineup)
                all_form.append(s.raw_form)
        if not all_lineup:
            return {"n_snapshots": 0}
        return {
            "n_snapshots": len(all_lineup),
            "n_team_league_pairs": len(self._snapshots),
            "lineup_mean": float(np.mean(all_lineup)),
            "lineup_std": float(np.std(all_lineup)),
            "lineup_min": float(np.min(all_lineup)),
            "lineup_max": float(np.max(all_lineup)),
            "form_mean": float(np.mean(all_form)),
            "form_std": float(np.std(all_form)),
            "form_min": float(np.min(all_form)),
            "form_max": float(np.max(all_form)),
        }
