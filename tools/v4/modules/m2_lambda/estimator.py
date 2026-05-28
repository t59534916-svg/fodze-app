"""
m2_lambda.estimator — LambdaEstimator: per-match (λ_h, λ_a) from EWMA history.

Algorithm:
  1. For each team, compute xG-EWMA (attack) and xGA-EWMA (defense) over the
     N most-recent matches BEFORE the match date (no future-leakage).
  2. Combine via attack × defense × league-base decomposition:
        λ_h = league_home_avg × (home_attack / league_total_avg/2)
                              × (away_defense_concedes / league_total_avg/2)
     equivalent for λ_a.
  3. Optional: multiply by form factor (recent/longer EWMA ratio).
  4. Optional: multiply by rest-days factor.
  5. Clamp result to [0.30, 4.50] (Poisson sanity).

Critical invariants enforced:
  • NO FUTURE LEAKAGE: history strictly filtered to match_date < as_of
  • λ ≥ 0.30 always (Poisson degenerates below)
  • λ ≤ 4.50 always (extreme matchups can produce huge raw signals)
  • Small-sample → fall back to league average (no halving of insufficient data)

Output:
  estimate(...) → (λ_h, λ_a)
  compute_features(...) → dict with all intermediates (for m3_xg feature engineering)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Tuple

import numpy as np
import pandas as pd

from v4.modules.m2_lambda.ewma import effective_sample_size, ewma_with_fallback
from v4.modules.m2_lambda.league_constants import (
    DEFAULT_HOME_XG_AVG,
    compute_league_constants,
)


LAMBDA_MIN = 0.30
LAMBDA_MAX = 4.50
DEFAULT_EWMA_HALFLIFE = 8.0
DEFAULT_LOOKBACK_MATCHES = 16  # ~half a season — enough for halflife=8 to converge
MIN_TEAM_MATCHES = 4  # below this, fall back to league avg


@dataclass(frozen=True)
class TeamStrength:
    """Per-team attack + defense strength + diagnostics."""

    attack_xg: float        # EWMA of xg_for
    defense_xga: float      # EWMA of xga (= xg conceded)
    n_matches: int          # raw sample size
    ess: float              # effective sample size (Kish formula)
    is_fallback: bool       # True if sample too small → league avg used


class LambdaEstimator:
    """Per-match (λ_h, λ_a) estimator from team xG history.

    Stateless — all data passed per call. Use compute_features() if you need
    the intermediate values (for feeding into m3_xg as features).
    """

    def __init__(
        self,
        *,
        ewma_halflife: float = DEFAULT_EWMA_HALFLIFE,
        lookback_matches: int = DEFAULT_LOOKBACK_MATCHES,
        min_team_matches: int = MIN_TEAM_MATCHES,
        apply_form_factor: bool = False,
        apply_rest_factor: bool = False,
    ):
        if ewma_halflife <= 0:
            raise ValueError(f"ewma_halflife must be positive, got {ewma_halflife}")
        if lookback_matches < 1:
            raise ValueError(f"lookback_matches must be ≥ 1, got {lookback_matches}")
        self.ewma_halflife = float(ewma_halflife)
        self.lookback_matches = int(lookback_matches)
        self.min_team_matches = int(min_team_matches)
        self.apply_form_factor = bool(apply_form_factor)
        self.apply_rest_factor = bool(apply_rest_factor)

    # ─────────────────────────────────────────────────────────────────
    # Per-team strength
    # ─────────────────────────────────────────────────────────────────

    def _team_strength(
        self,
        history: pd.DataFrame,
        *,
        team: str,
        league: str,
        as_of: datetime,
        league_avg_xg: float,
    ) -> TeamStrength:
        """EWMA attack + defense for one team, using only matches BEFORE as_of.

        Args:
            history: full team_xg_history DataFrame
            team: team name (must match team column exactly)
            league: league code (filter)
            as_of: match date (strictly-less filter to prevent leakage)
            league_avg_xg: per-side league avg (fallback when sample too small)
        """
        # Filter to this team's history, in this league, BEFORE as_of
        df = history[
            (history["team"] == team)
            & (history["league"] == league)
            & (history["match_date"] < pd.Timestamp(as_of))
            & (history["xg"].notna())
        ]
        # Sort newest-first and cap to lookback window. Stable mergesort +
        # opponent as secondary key so EWMA is deterministic if a team ever
        # appears twice on the same date (cup + league matchday clash) —
        # same determinism contract as EloCalculator.fit (2026-05-21 fix).
        df = df.sort_values(
            ["match_date", "opponent"], ascending=[False, True], kind="mergesort"
        ).head(self.lookback_matches)

        n = len(df)
        if n < self.min_team_matches:
            return TeamStrength(
                attack_xg=league_avg_xg,
                defense_xga=league_avg_xg,
                n_matches=n,
                ess=float(n),
                is_fallback=True,
            )

        attack = ewma_with_fallback(
            df["xg"].to_numpy(),
            halflife=self.ewma_halflife,
            fallback=league_avg_xg,
            min_periods=self.min_team_matches,
        )
        defense = ewma_with_fallback(
            df["xga"].to_numpy(),
            halflife=self.ewma_halflife,
            fallback=league_avg_xg,
            min_periods=self.min_team_matches,
        )
        ess = effective_sample_size(n, self.ewma_halflife)
        return TeamStrength(
            attack_xg=attack,
            defense_xga=defense,
            n_matches=n,
            ess=ess,
            is_fallback=False,
        )

    # ─────────────────────────────────────────────────────────────────
    # Form factor (optional)
    # ─────────────────────────────────────────────────────────────────

    def _form_factor(
        self,
        history: pd.DataFrame,
        *,
        team: str,
        league: str,
        as_of: datetime,
    ) -> float:
        """Recent (last-4) vs longer (last-12) EWMA ratio for xG.

        > 1.0 → team in form (recent xG > long-term)
        < 1.0 → team out of form
        Clamped to [0.85, 1.15] so extreme short-term swings don't blow up λ.
        Returns 1.0 (neutral) if insufficient data.
        """
        df = history[
            (history["team"] == team)
            & (history["league"] == league)
            & (history["match_date"] < pd.Timestamp(as_of))
            & (history["xg"].notna())
        ].sort_values(
            ["match_date", "opponent"], ascending=[False, True], kind="mergesort"
        )

        if len(df) < 8:
            return 1.0

        recent_avg = float(df["xg"].head(4).mean())
        longer_avg = float(df["xg"].head(12).mean())
        if longer_avg <= 0:
            return 1.0
        ratio = recent_avg / longer_avg
        return float(np.clip(ratio, 0.85, 1.15))

    # ─────────────────────────────────────────────────────────────────
    # Rest factor (optional, requires last-match date in history)
    # ─────────────────────────────────────────────────────────────────

    def _rest_factor(
        self,
        history: pd.DataFrame,
        *,
        team: str,
        league: str,
        as_of: datetime,
    ) -> float:
        """Rest-days multiplier:
            < 3 days → fatigue penalty 0.95
            3-13 days → neutral 1.0
            > 13 days → mild rust 0.97
        Returns 1.0 if no prior match found.
        """
        df = history[
            (history["team"] == team)
            & (history["league"] == league)
            & (history["match_date"] < pd.Timestamp(as_of))
        ]
        if len(df) == 0:
            return 1.0
        last_match = df["match_date"].max()
        days_rest = (pd.Timestamp(as_of) - last_match).days
        if days_rest < 3:
            return 0.95
        if days_rest > 13:
            return 0.97
        return 1.0

    # ─────────────────────────────────────────────────────────────────
    # Public API
    # ─────────────────────────────────────────────────────────────────

    def estimate(
        self,
        *,
        home_team: str,
        away_team: str,
        league: str,
        match_date: datetime,
        history: pd.DataFrame,
        league_constants: Optional[Dict[str, float]] = None,
    ) -> Tuple[float, float]:
        """Return (λ_h, λ_a) for one match.

        Args:
            home_team, away_team: team names (must match history.team exactly)
            league: league code
            match_date: when match takes place (history strictly before this)
            history: team_xg_history DataFrame
            league_constants: pre-computed (saves recompute on batch calls).
                              Pass None to compute on-the-fly.

        Returns: (λ_h, λ_a), both clamped to [LAMBDA_MIN, LAMBDA_MAX].
        """
        features = self.compute_features(
            home_team=home_team,
            away_team=away_team,
            league=league,
            match_date=match_date,
            history=history,
            league_constants=league_constants,
        )
        return features["lambda_h"], features["lambda_a"]

    def compute_features(
        self,
        *,
        home_team: str,
        away_team: str,
        league: str,
        match_date: datetime,
        history: pd.DataFrame,
        league_constants: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """Full feature vector: λ_h, λ_a + all intermediates (for m3_xg ingestion)."""
        if league_constants is None:
            league_constants = compute_league_constants(
                history, league=league, before_date=match_date
            )

        # Per-side league averages
        league_home_avg = league_constants["home_xg_avg"]
        league_away_avg = league_constants["away_xg_avg"]
        league_total_avg = league_constants["total_avg"]
        # Per-side "neutral baseline" for attack/defense ratios.
        # We use total_avg/2 as the neutral baseline so that a team scoring
        # exactly league-avg gets attack_ratio=1.0.
        neutral_side_avg = league_total_avg / 2.0 if league_total_avg > 0 else DEFAULT_HOME_XG_AVG

        # Per-team raw strengths
        h_strength = self._team_strength(
            history, team=home_team, league=league,
            as_of=match_date, league_avg_xg=neutral_side_avg,
        )
        a_strength = self._team_strength(
            history, team=away_team, league=league,
            as_of=match_date, league_avg_xg=neutral_side_avg,
        )

        # Attack/defense ratios (1.0 = average)
        h_attack_ratio = h_strength.attack_xg / neutral_side_avg
        a_attack_ratio = a_strength.attack_xg / neutral_side_avg
        h_defense_ratio = h_strength.defense_xga / neutral_side_avg
        a_defense_ratio = a_strength.defense_xga / neutral_side_avg

        # Reconstruct λ:
        #   λ_h = league_home_baseline × home_attack × away_defense
        #   λ_a = league_away_baseline × away_attack × home_defense
        lambda_h_raw = league_home_avg * h_attack_ratio * a_defense_ratio
        lambda_a_raw = league_away_avg * a_attack_ratio * h_defense_ratio

        # Optional form/rest multipliers
        form_h = form_a = rest_h = rest_a = 1.0
        if self.apply_form_factor:
            form_h = self._form_factor(history, team=home_team, league=league, as_of=match_date)
            form_a = self._form_factor(history, team=away_team, league=league, as_of=match_date)
        if self.apply_rest_factor:
            rest_h = self._rest_factor(history, team=home_team, league=league, as_of=match_date)
            rest_a = self._rest_factor(history, team=away_team, league=league, as_of=match_date)

        lambda_h_adjusted = lambda_h_raw * form_h * rest_h
        lambda_a_adjusted = lambda_a_raw * form_a * rest_a

        # Clamp to physical sanity range
        lambda_h = float(np.clip(lambda_h_adjusted, LAMBDA_MIN, LAMBDA_MAX))
        lambda_a = float(np.clip(lambda_a_adjusted, LAMBDA_MIN, LAMBDA_MAX))

        return {
            # Final outputs
            "lambda_h": lambda_h,
            "lambda_a": lambda_a,
            # Intermediates (for m3_xg feature consumption)
            "home_attack_ratio": h_attack_ratio,
            "home_defense_ratio": h_defense_ratio,
            "away_attack_ratio": a_attack_ratio,
            "away_defense_ratio": a_defense_ratio,
            "home_form_factor": form_h,
            "away_form_factor": form_a,
            "home_rest_factor": rest_h,
            "away_rest_factor": rest_a,
            # Pre-clamp raw values (for diagnostics — does clamping fire?)
            "lambda_h_raw": float(lambda_h_raw),
            "lambda_a_raw": float(lambda_a_raw),
            "lambda_h_was_clamped": lambda_h != lambda_h_adjusted,
            "lambda_a_was_clamped": lambda_a != lambda_a_adjusted,
            # Sample-size diagnostics
            "home_n_matches": h_strength.n_matches,
            "home_ess": h_strength.ess,
            "home_fallback_used": h_strength.is_fallback,
            "away_n_matches": a_strength.n_matches,
            "away_ess": a_strength.ess,
            "away_fallback_used": a_strength.is_fallback,
            # League context (for downstream features)
            "league_home_avg": league_home_avg,
            "league_away_avg": league_away_avg,
            "league_home_advantage": league_constants["home_advantage"],
            "league_constants_source": league_constants["source"],
        }
