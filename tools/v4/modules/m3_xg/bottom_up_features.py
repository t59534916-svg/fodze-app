"""BottomUpCalculator — pure player-level rolling features for dev-09 architecture.

Architecture per FODZE-Optimal-Blueprint audit revision (2026-05-27):
  - TABULA RASA bottom-up: no dev-03 macro features
  - Only Sofa player_match_stats (100% league coverage; no Understat sparsity trap)
  - 8 bottom-up team-aggregate features + bottom_up_available flag
  - Orthogonal context (Elo, rest_days, league) NOT computed here — done by
    feature_builder_dev09 which composes BottomUpCalculator output with EloCalculator

Critical invariants (audit committee + bug-class A from MVP):
  1. GROUP BY (game_id, is_home) ONLY. NEVER GROUP BY player_match_stats.team_id
     (which is the player's CURRENT-registered team post-transfer, not match-team).
     The match-team derivation uses sofa_match.home_team_id / away_team_id.
  2. Leakage-safe rolling: shift(1).rolling(N, min_periods=3).mean()
     PRIOR matches only, never includes the focal match itself.
  3. xG NULL = treated as 0 (no shots = no expected goals; valid interpretation).

KNOWN feature-design caveats (will be empirically tested by G2 Holm-Bonferroni
in Day 2 training, NOT pre-emptively fixed):
  - `attack_concentration` is a top-3-share ratio, not a magnitude — it captures
    distribution shape (1 elite vs 3-of-equal) but NOT absolute talent. Magnitude
    lives in `bottom_up_xg_diff`. The two features are complementary, NOT redundant.
  - `bottom_up_xg + bottom_up_xa` likely correlate (pass→shot chain credits both
    passer and shooter for the same play). LightGBM's tree-splits will discover
    redundancy and pick the more-informative one. Holm-correction will reject
    spurious doublets.
  - `gk_saves_per_90_diff` is NOT a save-rate (would need opponent SoT). It's a
    raw saves-per-90 differential. A GK facing 10 SoT/saving 7 ranks higher than
    one facing 4/saving 4 — semantically backwards for "quality." The trade-off
    is per-90-saves correlates with team-defensive-quality (more SoT against bad
    teams) but introduces noise. Renamed (was `gk_save_rate`) to avoid pretending.

Position-code empirics (verified 2026-05-27 via sqlite):
  Sofa emits ONLY 4 position codes: M (n=228,644), D (n=178,904), F (n=137,756),
  G (n=38,256). The earlier 11-code-list (DC/DL/DR/DMC/...) was wishful — none
  of those substrings exist in the data. defense_block_sum filters on `D` only
  (true defenders; midfielder defensive work folds into shots+key_passes).

Usage:
    bc = BottomUpCalculator(sqlite_path)
    bc.fit()  # builds full-corpus rolling cache
    features = bc.get_features_for_match(
        game_id=12345,
        starting_xi_home=[p1, p2, ...],
        starting_xi_away=[p1, p2, ...],
    )  # dict with 8 features + bottom_up_available + n_starters_with_history_min

Test contract: tools/v4/tests/test_bottom_up_features.py enforces:
  - GROUP BY (game_id, is_home) invariant (bug-class A regression test)
  - shift(1)+rolling leakage-safety
  - MVP replication: same r=+0.2409 on Top-5 24/25 when summed
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

ROLLING_N = 10  # prior matches per player
MIN_PERIODS = 3  # need at least 3 prior matches for valid rolling
MIN_STARTERS_WITH_HISTORY = 7  # below this → bottom_up_available=0


class BottomUpCalculator:
    """Fit-once/query-many calculator for per-player rolling features.

    Audit-corrected: pure Sofa-only data, GROUP BY (game_id, is_home),
    shift(1)+rolling leakage-safe.
    """

    def __init__(self, sqlite_path: Path):
        self.sqlite_path = Path(sqlite_path)
        self._fitted = False
        # (player_id, game_id) → dict of rolling features
        # Each dict has: xg_per_90, xa_per_90, shots_per_90, key_passes_per_90,
        #               minutes_rate, tackles_per_90, interceptions_per_90, position,
        #               saves_per_90
        self._player_rolling: Dict[Tuple[int, int], Dict[str, float]] = {}

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    def fit(self) -> "BottomUpCalculator":
        """Load Sofa player_match_stats from SQLite + build rolling-features cache.

        Returns self for chaining.
        """
        if not self.sqlite_path.exists():
            raise FileNotFoundError(f"SQLite mirror not found: {self.sqlite_path}")

        con = sqlite3.connect(str(self.sqlite_path))
        df = pd.read_sql_query("""
            SELECT pms.player_id, pms.game_id, pms.position,
                   pms.minutes_played, pms.expected_goals, pms.expected_assists,
                   pms.shots_on_target, pms.shots_off_target, pms.shots_blocked,
                   pms.key_passes,
                   pms.tackles_won, pms.interceptions,
                   pms.saves,
                   sm.start_timestamp, sm.league, sm.season
            FROM sofascore_player_match_stats pms
            JOIN sofascore_match sm ON sm.game_id = pms.game_id
            WHERE pms.minutes_played > 0
        """, con)
        con.close()

        # Treat NULL counts as 0 (no shots/passes/etc = 0 contribution).
        # astype(float) before fillna avoids pandas FutureWarning about object-dtype
        # downcasting deprecation when nullable integer columns contain mixed NULLs.
        for col in ("expected_goals", "expected_assists",
                    "shots_on_target", "shots_off_target", "shots_blocked",
                    "key_passes", "tackles_won", "interceptions", "saves"):
            df[col] = df[col].astype(float).fillna(0.0)

        # Empirically verified (2026-05-27): pms.shots_total is 0% populated in
        # the local SQLite mirror (the ingest pipeline never fills it). The three
        # component columns ARE populated. Derive total at fit time.
        df["shots_total"] = (df["shots_on_target"] + df["shots_off_target"]
                             + df["shots_blocked"])

        # Avoid division-by-zero on minutes_played (clip lower bound at 0.1 → 0.001 hours)
        minutes_factor = (df["minutes_played"] / 90.0).clip(lower=0.1)

        # Per-match per-90 rates (capped at physically-reasonable upper bounds)
        df["xg_per_90"] = (df["expected_goals"] / minutes_factor).clip(0, 3.0)
        df["xa_per_90"] = (df["expected_assists"] / minutes_factor).clip(0, 2.0)
        df["shots_per_90"] = (df["shots_total"] / minutes_factor).clip(0, 12.0)
        df["key_passes_per_90"] = (df["key_passes"] / minutes_factor).clip(0, 8.0)
        df["tackles_per_90"] = (df["tackles_won"] / minutes_factor).clip(0, 15.0)
        df["interceptions_per_90"] = (df["interceptions"] / minutes_factor).clip(0, 12.0)
        df["minutes_rate"] = (df["minutes_played"] / 90.0).clip(0, 1.0)

        # GK-specific: save_rate = saves / (saves + shots_on_target_against)
        # But shots_on_target_against requires opponent join — skip for now,
        # use saves_per_90 as a proxy (will be filtered to GK position in aggregator)
        df["saves_per_90"] = (df["saves"] / minutes_factor).clip(0, 15.0)

        # Critical: sort by (player_id, chronological) for shift(1).rolling()
        df = df.sort_values(["player_id", "start_timestamp"],
                            kind="mergesort").reset_index(drop=True)

        # Leakage-safe rolling (shift(1) excludes focal match)
        rolling_cols = ["xg_per_90", "xa_per_90", "shots_per_90", "key_passes_per_90",
                        "tackles_per_90", "interceptions_per_90", "minutes_rate",
                        "saves_per_90"]
        for col in rolling_cols:
            df[f"rolling_{col}"] = (
                df.groupby("player_id")[col]
                  .transform(lambda s: s.shift(1).rolling(ROLLING_N, min_periods=MIN_PERIODS).mean())
            )

        # Drop rows with no valid rolling (early career, < MIN_PERIODS prior matches)
        df_valid = df.dropna(subset=[f"rolling_{rolling_cols[0]}"]).reset_index(drop=True)

        # Build per-(player_id, game_id) lookup
        for _, r in df_valid.iterrows():
            key = (int(r["player_id"]), int(r["game_id"]))
            self._player_rolling[key] = {
                "xg_per_90": float(r["rolling_xg_per_90"]),
                "xa_per_90": float(r["rolling_xa_per_90"]),
                "shots_per_90": float(r["rolling_shots_per_90"]),
                "key_passes_per_90": float(r["rolling_key_passes_per_90"]),
                "tackles_per_90": float(r["rolling_tackles_per_90"]),
                "interceptions_per_90": float(r["rolling_interceptions_per_90"]),
                "minutes_rate": float(r["rolling_minutes_rate"]),
                "saves_per_90": float(r["rolling_saves_per_90"]),
                "position": str(r["position"]) if pd.notna(r["position"]) else "?",
            }

        self._fitted = True
        return self

    def _aggregate_starters(
        self, game_id: int, starter_ids: List[int]
    ) -> Tuple[Dict[str, float], int]:
        """Aggregate rolling features over starters into team-side aggregates.

        Returns (aggregates_dict, n_starters_with_history).
        """
        with_data = []
        for pid in starter_ids:
            entry = self._player_rolling.get((int(pid), int(game_id)))
            if entry is not None:
                with_data.append(entry)

        n_with_history = len(with_data)
        if n_with_history == 0:
            return ({
                "bottom_up_xg": 0.0,
                "bottom_up_xa": 0.0,
                "bottom_up_shots": 0.0,
                "bottom_up_key_passes": 0.0,
                "attack_concentration": 0.0,
                "defense_block_sum": 0.0,
                "gk_saves_per_90": 0.0,
                "minutes_rate_sum": 0.0,
            }, 0)

        # Sum-based aggregates (assume 90min play per starter)
        sum_xg = sum(p["xg_per_90"] for p in with_data)
        sum_xa = sum(p["xa_per_90"] for p in with_data)
        sum_shots = sum(p["shots_per_90"] for p in with_data)
        sum_key_passes = sum(p["key_passes_per_90"] for p in with_data)
        sum_minutes = sum(p["minutes_rate"] for p in with_data)

        # Attack concentration: top-3 starters' xG share of total
        # NOTE: shape-only feature — captures elite-vs-balanced distribution,
        # NOT magnitude. Magnitude lives in bottom_up_xg_diff. Caveat in module doc.
        xg_values = sorted([p["xg_per_90"] for p in with_data], reverse=True)
        top3_xg = sum(xg_values[:3])
        attack_concentration = (top3_xg / sum_xg) if sum_xg > 1e-6 else 0.0

        # Defense aggregate: tackles + interceptions for true defenders ONLY.
        # Empirically verified (2026-05-27): Sofa only emits 4 position codes
        # (M, D, F, G) — no DC/DMC/etc. variants. Midfielders' defensive work
        # folds into shots+key_passes signals. Cleanest signal: D-only.
        defenders = [p for p in with_data if p["position"] == "D"]
        defense_block_sum = sum(
            p["tackles_per_90"] + p["interceptions_per_90"]
            for p in defenders
        )

        # GK saves-per-90 (NOT a rate — would need opponent SoT). Caveat in module doc.
        # Typically 1 GK per side; defensive against multi-keeper edge case via /len(gks).
        gks = [p for p in with_data if p["position"] == "G"]
        gk_saves_per_90 = (sum(p["saves_per_90"] for p in gks) / len(gks)) if gks else 0.0

        return ({
            "bottom_up_xg": sum_xg,
            "bottom_up_xa": sum_xa,
            "bottom_up_shots": sum_shots,
            "bottom_up_key_passes": sum_key_passes,
            "attack_concentration": attack_concentration,
            "defense_block_sum": defense_block_sum,
            "gk_saves_per_90": gk_saves_per_90,
            "minutes_rate_sum": sum_minutes,
        }, n_with_history)

    def get_features_for_match(
        self,
        *,
        game_id: int,
        starting_xi_home: List[int],
        starting_xi_away: List[int],
    ) -> Dict[str, float]:
        """Compute 8 bottom-up team-aggregate diff features + availability flag.

        Returns dict with feature_names_dev09 expected by feature_builder_dev09:
            bottom_up_xg_diff, bottom_up_xa_diff, bottom_up_shots_diff,
            bottom_up_key_passes_diff, attack_concentration_diff,
            defense_block_sum_diff, gk_save_rate_diff, minutes_rate_diff,
            bottom_up_available, n_starters_with_history_min
        """
        if not self._fitted:
            raise RuntimeError("BottomUpCalculator must be fit() before get_features_for_match()")

        home_agg, n_home = self._aggregate_starters(game_id, starting_xi_home)
        away_agg, n_away = self._aggregate_starters(game_id, starting_xi_away)

        is_available = (n_home >= MIN_STARTERS_WITH_HISTORY and
                        n_away >= MIN_STARTERS_WITH_HISTORY)

        # When NOT available: all bottom-up features → 0 (engine falls back to
        # orthogonal context like Elo). Layer-3 graceful degradation.
        if not is_available:
            return {
                "bottom_up_xg_diff": 0.0,
                "bottom_up_xa_diff": 0.0,
                "bottom_up_shots_diff": 0.0,
                "bottom_up_key_passes_diff": 0.0,
                "attack_concentration_diff": 0.0,
                "defense_block_sum_diff": 0.0,
                "gk_saves_per_90_diff": 0.0,
                "minutes_rate_diff": 0.0,
                "bottom_up_available": 0,
                "n_starters_with_history_min": min(n_home, n_away),
            }

        return {
            "bottom_up_xg_diff": home_agg["bottom_up_xg"] - away_agg["bottom_up_xg"],
            "bottom_up_xa_diff": home_agg["bottom_up_xa"] - away_agg["bottom_up_xa"],
            "bottom_up_shots_diff": home_agg["bottom_up_shots"] - away_agg["bottom_up_shots"],
            "bottom_up_key_passes_diff": home_agg["bottom_up_key_passes"] - away_agg["bottom_up_key_passes"],
            "attack_concentration_diff": home_agg["attack_concentration"] - away_agg["attack_concentration"],
            "defense_block_sum_diff": home_agg["defense_block_sum"] - away_agg["defense_block_sum"],
            "gk_saves_per_90_diff": home_agg["gk_saves_per_90"] - away_agg["gk_saves_per_90"],
            "minutes_rate_diff": home_agg["minutes_rate_sum"] - away_agg["minutes_rate_sum"],
            "bottom_up_available": 1,
            "n_starters_with_history_min": min(n_home, n_away),
        }

    def stats(self) -> Dict[str, int]:
        """Coverage stats for diagnostic logging."""
        return {
            "n_fitted_player_match_pairs": len(self._player_rolling),
            "n_distinct_players": len({k[0] for k in self._player_rolling.keys()}),
            "n_distinct_games": len({k[1] for k in self._player_rolling.keys()}),
            "fitted": self._fitted,
        }


# Feature names exposed for downstream feature_builder_dev09 + train_dev09.
# Order is the canonical column order — keep stable; train_dev09 + dev09-features.ts
# rely on this list verbatim.
DEV_09_BOTTOM_UP_FEATURES: List[str] = [
    "bottom_up_xg_diff",
    "bottom_up_xa_diff",
    "bottom_up_shots_diff",
    "bottom_up_key_passes_diff",
    "attack_concentration_diff",
    "defense_block_sum_diff",
    "gk_saves_per_90_diff",
    "minutes_rate_diff",
    "bottom_up_available",
    "n_starters_with_history_min",
]
