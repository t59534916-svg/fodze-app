"""
player_lineup.py — PlayerLineupCalculator: real player-level lineup quality
for Top-5 leagues using Understat player-match stats.

Architecture:
  - Top-5 (EPL, BL, La Liga, Serie A, Ligue 1): player-level signal
    from understat_player_match_stats (8 seasons, 424k rows, 21k players)
  - Lower-17 leagues: returns lineup_quality_player_available=0 →
    feature defaults to 0.0 (caller relies on team-level proxy from
    TeamMomentumCalculator's lineup_quality_diff).

Feature definition (per team, pre-match):
  1. Find team's last N=5 matches strictly before match_date
  2. Identify "likely starters" = top 11 player_ids by total minutes
     across those 5 matches (engagement-proxy for upcoming XI)
  3. For each starter, compute rolling-5-match per-90 stats from
     their OWN match history strictly before match_date
  4. Per-player composite (weighted):
       0.40 × xg_chain_per_90    (player's chain involvement)
     + 0.30 × key_passes_per_90 / 10  (chance creation, scaled)
     + 0.15 × xg_per_90          (own shot quality)
     + 0.15 × xa_per_90          (assist xG)
  5. Team lineup_quality = mean of valid per-player composites
  6. Feature = (home_z - away_z), per-Liga z-score from fit-time
     distribution, clipped to [-3, 3]

Returns lineup_quality_player_diff = 0.0, _available = 0 when:
  - League not in Top-5 (no Understat coverage)
  - Either team has < 3 prior matches in Understat
  - Fewer than 7 of 11 starters have rolling-5 history

Fit-once / query-many pattern (analog EloCalculator + TeamMomentumCalculator).
"""
from __future__ import annotations

import bisect
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

TOP5_LEAGUES = {"bundesliga", "epl", "la_liga", "ligue_1", "serie_a"}
N_MATCH_WINDOW = 5
N_STARTERS = 11
MIN_PRIOR_MATCHES = 3
MIN_VALID_STARTERS = 7

# Understat → FODZE canonical team-name aliases (mirror bridge_understat_24-25.py)
UNDERSTAT_NAME_TO_CANONICAL = {
    "Borussia M.Gladbach":     "Borussia Mönchengladbach",
    "RasenBallsport Leipzig":  "RB Leipzig",
    "VfL Wolfsburg":           "Wolfsburg",
    "1.FC Heidenheim 1846":    "Heidenheim",
    "1.FC Union Berlin":       "Union Berlin",
    "TSG Hoffenheim":          "Hoffenheim",
    "VfL Bochum":              "Bochum",
}
CANONICAL_TO_UNDERSTAT = {v: k for k, v in UNDERSTAT_NAME_TO_CANONICAL.items()}


@dataclass(frozen=True)
class _PlayerSnapshot:
    """Per-match player performance row."""
    match_id: int
    match_date: pd.Timestamp
    minutes: int
    xg: float
    xa: float
    xg_chain: float
    key_passes: int


class PlayerLineupCalculator:
    """Build + query per-team-per-date player-level lineup quality."""

    def __init__(self, sqlite_path: Path):
        self.sqlite_path = Path(sqlite_path)
        self._fitted = False
        # (team_canonical, league) → sorted [(date, match_id), ...]
        self._team_match_index: Dict[Tuple[str, str], List[Tuple[pd.Timestamp, int]]] = {}
        # (team_canonical, league, match_id) → [(player_id, minutes), ...]
        self._team_match_roster: Dict[Tuple[str, str, int], List[Tuple[int, int]]] = {}
        # player_id → sorted [PlayerSnapshot, ...]
        self._player_history: Dict[int, List[_PlayerSnapshot]] = {}
        # league → (mean, std) for z-normalization
        self._norms: Dict[str, Tuple[float, float]] = {}

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def _canonical(self, name: str) -> str:
        return UNDERSTAT_NAME_TO_CANONICAL.get(name, name)

    def fit(self) -> "PlayerLineupCalculator":
        """Load understat_player_match_stats from SQLite + build indexes."""
        if not self.sqlite_path.exists():
            raise FileNotFoundError(f"SQLite mirror not found: {self.sqlite_path}")
        con = sqlite3.connect(str(self.sqlite_path))
        df = pd.read_sql("""
            SELECT match_id, league, match_date, home_team, away_team, is_home,
                   player_id, time_minutes, xg, xa, xg_chain, key_passes
            FROM understat_player_match_stats
            WHERE time_minutes > 0
            ORDER BY match_date
        """, con)
        con.close()

        df["match_date"] = pd.to_datetime(df["match_date"])
        df["home_canonical"] = df["home_team"].map(self._canonical)
        df["away_canonical"] = df["away_team"].map(self._canonical)
        df["team_canonical"] = np.where(df["is_home"] == 1,
                                         df["home_canonical"],
                                         df["away_canonical"])

        # 1. _team_match_index: per-team chronological match list
        team_matches: Dict[Tuple[str, str], List[Tuple[pd.Timestamp, int]]] = defaultdict(list)
        unique_match_team = df[["match_id", "match_date", "team_canonical", "league"]].drop_duplicates()
        for _, r in unique_match_team.iterrows():
            team_matches[(r["team_canonical"], r["league"])].append(
                (r["match_date"], int(r["match_id"]))
            )
        for key, lst in team_matches.items():
            lst.sort(key=lambda x: x[0])
            self._team_match_index[key] = lst

        # 2. _team_match_roster: per-(team, league, match_id) player roster
        for (team_can, league_v, mid), grp in df.groupby(
            ["team_canonical", "league", "match_id"]
        ):
            self._team_match_roster[(team_can, league_v, int(mid))] = [
                (int(r["player_id"]), int(r["time_minutes"]))
                for _, r in grp.iterrows()
            ]

        # 3. _player_history: per-player chronological snapshots
        for player_id, grp in df.groupby("player_id"):
            self._player_history[int(player_id)] = [
                _PlayerSnapshot(
                    match_id=int(r["match_id"]),
                    match_date=r["match_date"],
                    minutes=int(r["time_minutes"]),
                    xg=float(r["xg"]),
                    xa=float(r["xa"]),
                    xg_chain=float(r["xg_chain"]),
                    key_passes=int(r["key_passes"]),
                )
                # Stable mergesort + player_id secondary so two starters of
                # the same team on the same date sort identically across runs
                for _, r in grp.sort_values(
                    ["match_date", "player_id"] if "player_id" in grp.columns else ["match_date"],
                    kind="mergesort",
                ).iterrows()
            ]

        # 4. Pre-compute per-Liga z-score norms from fit-time distribution
        per_liga_vals: Dict[str, List[float]] = defaultdict(list)
        for (team_can, league_v), match_list in self._team_match_index.items():
            if league_v not in TOP5_LEAGUES:
                continue
            for i, (date, _) in enumerate(match_list):
                if i < MIN_PRIOR_MATCHES:
                    continue
                raw_q = self._compute_raw_quality(team_can, league_v, date)
                if raw_q is not None:
                    per_liga_vals[league_v].append(raw_q)
        for league_v, vals in per_liga_vals.items():
            arr = np.array(vals)
            mu = float(np.nanmean(arr))
            sd = float(np.nanstd(arr, ddof=0))
            if sd < 1e-6: sd = 1.0
            self._norms[league_v] = (mu, sd)

        self._fitted = True
        return self

    def _player_rolling_per90(self, player_id: int,
                                target_date: pd.Timestamp) -> Optional[Dict[str, float]]:
        """Rolling-5-match per-90 stats for player, strictly before target_date."""
        snaps = self._player_history.get(player_id)
        if not snaps:
            return None
        dates = [s.match_date for s in snaps]
        idx = bisect.bisect_left(dates, target_date)
        if idx == 0:
            return None
        window = snaps[max(0, idx - N_MATCH_WINDOW):idx]
        if not window:
            return None
        total_min = sum(s.minutes for s in window)
        if total_min < 30:
            return None
        return {
            "xg_per_90":         sum(s.xg for s in window) / total_min * 90,
            "xa_per_90":         sum(s.xa for s in window) / total_min * 90,
            "xg_chain_per_90":   sum(s.xg_chain for s in window) / total_min * 90,
            "key_passes_per_90": sum(s.key_passes for s in window) / total_min * 90,
        }

    @staticmethod
    def _player_composite(p_stats: Dict[str, float]) -> float:
        return (
            0.40 * p_stats["xg_chain_per_90"]
            + 0.30 * p_stats["key_passes_per_90"] / 10.0
            + 0.15 * p_stats["xg_per_90"]
            + 0.15 * p_stats["xa_per_90"]
        )

    def _compute_raw_quality(self, team_canonical: str, league: str,
                              target_date: pd.Timestamp) -> Optional[float]:
        """Compute raw (un-normalized) team lineup quality at target_date.

        Returns None when insufficient data.
        """
        match_list = self._team_match_index.get((team_canonical, league))
        if not match_list:
            return None
        dates = [d for d, _ in match_list]
        idx = bisect.bisect_left(dates, target_date)
        if idx < MIN_PRIOR_MATCHES:
            return None
        recent_match_ids = [mid for _, mid in match_list[max(0, idx - N_MATCH_WINDOW):idx]]
        if not recent_match_ids:
            return None

        # Aggregate player-minutes across recent matches
        player_minutes: Dict[int, int] = defaultdict(int)
        for mid in recent_match_ids:
            roster = self._team_match_roster.get((team_canonical, league, mid), [])
            for player_id, minutes in roster:
                player_minutes[player_id] += minutes
        if not player_minutes:
            return None

        # Top-N likely starters by total minutes
        starters = sorted(player_minutes.items(), key=lambda x: -x[1])[:N_STARTERS]

        # For each starter, get rolling-5 per-90 + composite
        composites = []
        for player_id, _tm in starters:
            p_stats = self._player_rolling_per90(player_id, target_date)
            if p_stats is not None:
                composites.append(self._player_composite(p_stats))
        if len(composites) < MIN_VALID_STARTERS:
            return None
        return float(np.mean(composites))

    def get_features(
        self, *,
        home_team: str,
        away_team: str,
        league: str,
        match_date: pd.Timestamp,
    ) -> Dict[str, float]:
        """Compute lineup_quality_player_diff + availability flag.

        For Lower-17 leagues OR insufficient data: returns
        {diff: 0.0, available: 0.0} — caller's feature_builder will then
        emit 0.0 (neutral) for this new feature, falling back to dev-03's
        team-level lineup_quality_diff which still works in those cases.
        """
        if not self._fitted:
            raise RuntimeError("PlayerLineupCalculator not fitted")
        if league not in TOP5_LEAGUES:
            return {"lineup_quality_player_diff": 0.0,
                    "lineup_quality_player_available": 0.0}

        h_can = self._canonical(home_team)
        a_can = self._canonical(away_team)
        target = pd.Timestamp(match_date)
        h_q = self._compute_raw_quality(h_can, league, target)
        a_q = self._compute_raw_quality(a_can, league, target)
        if h_q is None or a_q is None:
            return {"lineup_quality_player_diff": 0.0,
                    "lineup_quality_player_available": 0.0}

        mu, sd = self._norms.get(league, (0.0, 1.0))
        diff = float(np.clip((h_q - mu) / sd - (a_q - mu) / sd, -3.0, 3.0))
        return {"lineup_quality_player_diff": diff,
                "lineup_quality_player_available": 1.0}

    def stats(self) -> Dict:
        if not self._fitted:
            return {"n_players": 0}
        return {
            "n_players": len(self._player_history),
            "n_team_match_pairs": len(self._team_match_roster),
            "n_team_league_keys": len(self._team_match_index),
            "leagues_with_norms": list(self._norms.keys()),
            "norms": {k: {"mean": round(v[0], 4), "std": round(v[1], 4)}
                      for k, v in self._norms.items()},
        }
