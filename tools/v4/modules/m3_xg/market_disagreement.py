"""
market_disagreement.py — MarketDisagreementCalculator: |p_proxy - p_market| / p_market.

Two new features for dev-04 (β8 sprint):
  - market_disagreement_flag: mean(|p_proxy_o - p_market_o| / p_market_o) over o ∈ {H,D,A}
  - market_disagreement_high:  1 if flag > 0.08 else 0

ARCHITECTURAL CHOICE (transparent):
  The user-spec formula `|p_blended - p_market| / p_market` has a circular dependency:
  p_blended comes from m6 (Benter blend of m3 + market), so m3 can't reference it
  as a feature. We resolve this by using the m2-NAIVE Skellam proxy as the
  "model belief":

    p_proxy_o = Skellam(lambda_h_naive, lambda_a_naive)[o]   for o ∈ {H, D, A}

  This is the raw Poisson 1X2 distribution implied by m2's λ-estimates,
  available BEFORE m3 is trained. The new m3 (dev-04) then sees both the
  proxy disagreement AND the naive lambdas — it can learn to over-ride
  market only when its OTHER features (Elo, attack/defense, lineup, form)
  conflict strongly enough with the market.

  Leakage-safe: p_market comes from Pinnacle CLOSING odds (pre-match by
  definition), lambdas come from team_xg_history strictly before match_date.

DATA COVERAGE:
  Combined Pinnacle closing odds (23/24 + 24/25 + 25/26 parquets):
    ~13.500 matches with odds out of 27.333 training matches (~50% coverage).
  Matches WITHOUT odds → market_disagreement_flag = 0.0, market_disagreement_high = 0
  (neutral signal: "no disagreement information available").

Usage:
    calc = MarketDisagreementCalculator().fit(odds_paths=[...])
    feats = calc.get_features(
        home_team="Bayern", away_team="Dortmund",
        league="bundesliga", match_date=pd.Timestamp("2026-04-05"),
        lambda_h=2.3, lambda_a=0.8,
    )
    # feats["market_disagreement_flag"], feats["market_disagreement_high"]
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy.stats import skellam


# Threshold for "high disagreement" binary flag
HIGH_DISAGREEMENT_THRESHOLD = 0.08

# Shin vig-removal — simplified version (avoid importing m6 to keep modules
# decoupled). Iterative fixed-point on s (insider-trade parameter).
def _shin_vig_remove(odds_arr: np.ndarray) -> np.ndarray:
    """Convert decimal odds [H, D, A] → true probabilities via Shin (1993).

    Args:
        odds_arr: array of shape (3,) with decimal odds.

    Returns:
        array of shape (3,) with true probabilities summing to 1.0.
    """
    raw_p = 1.0 / odds_arr
    if not np.all(np.isfinite(raw_p)) or np.any(raw_p <= 0):
        return np.array([1 / 3.0, 1 / 3.0, 1 / 3.0])
    booksum = raw_p.sum()
    # Solve quadratic for s (insider trader proportion)
    # Approximation: s ≈ (sqrt(booksum^2 - 4*(booksum-1)*max(raw_p)) - 1) / (booksum - 2*max(raw_p))
    # We use the iterative version (more stable for n=3)
    s = 0.01
    for _ in range(50):
        denom = booksum - s
        if denom <= 0:
            return raw_p / booksum
        p_true = (
            np.sqrt(s ** 2 + 4 * (1 - s) * (raw_p ** 2) / denom) - s
        ) / (2 * (1 - s))
        sp = p_true.sum()
        if abs(sp - 1.0) < 1e-7:
            break
        s = s + 0.5 * (sp - 1.0)
        s = float(np.clip(s, 1e-6, 0.5))
    p_true = p_true / p_true.sum()
    return p_true


def _skellam_1x2(lambda_h: float, lambda_a: float) -> Tuple[float, float, float]:
    """1X2 probabilities from Poisson(λ_h), Poisson(λ_a) via Skellam (D = X-Y).

    Returns:
        (p_H, p_D, p_A) where:
            p_H = P(N_h - N_a > 0) = 1 - skellam.cdf(0, λ_h, λ_a)
            p_D = P(N_h - N_a = 0) = skellam.pmf(0, λ_h, λ_a)
            p_A = P(N_h - N_a < 0) = skellam.cdf(-1, λ_h, λ_a)
    """
    lh = max(0.05, float(lambda_h))
    la = max(0.05, float(lambda_a))
    p_d = float(skellam.pmf(0, lh, la))
    p_a = float(skellam.cdf(-1, lh, la))
    p_h = 1.0 - p_d - p_a
    # Guard against numerical issues
    p_h = max(0.001, min(0.999, p_h))
    p_d = max(0.001, min(0.999, p_d))
    p_a = max(0.001, min(0.999, p_a))
    s = p_h + p_d + p_a
    return p_h / s, p_d / s, p_a / s


class MarketDisagreementCalculator:
    """Lookup table for pre-match Pinnacle odds + on-the-fly disagreement compute.

    Lookup key: (league, match_date_date, home_team, away_team)
    """

    def __init__(self, *, threshold: float = HIGH_DISAGREEMENT_THRESHOLD):
        self.threshold = float(threshold)
        self._odds: Dict[Tuple, Tuple[float, float, float]] = {}
        self._fitted = False
        self._n_loaded = 0
        self._n_unique = 0

    @property
    def is_fitted(self) -> bool:
        return self._fitted

    @property
    def n_matches_with_odds(self) -> int:
        return self._n_unique

    def fit(self, odds_paths: List[Path]) -> "MarketDisagreementCalculator":
        """Load market odds from parquet files into the lookup.

        Each parquet must have columns: league, match_date, home_team, away_team,
        psch, pscd, psca.
        """
        self._odds.clear()
        for p in odds_paths:
            if not Path(p).exists():
                continue
            df = pd.read_parquet(p)
            need = {"league", "match_date", "home_team", "away_team",
                    "psch", "pscd", "psca"}
            missing = need - set(df.columns)
            if missing:
                continue
            df = df.dropna(subset=["psch", "pscd", "psca"])
            df["match_date"] = pd.to_datetime(df["match_date"])
            for _, row in df.iterrows():
                key = (
                    str(row["league"]),
                    pd.Timestamp(row["match_date"]).date(),
                    str(row["home_team"]),
                    str(row["away_team"]),
                )
                self._odds[key] = (
                    float(row["psch"]),
                    float(row["pscd"]),
                    float(row["psca"]),
                )
                self._n_loaded += 1
        self._n_unique = len(self._odds)
        self._fitted = True
        return self

    def _lookup_market(
        self, league: str, match_date: pd.Timestamp,
        home_team: str, away_team: str,
    ) -> Optional[np.ndarray]:
        """Find Pinnacle Shin-removed probabilities for this match.

        Returns: array [p_H, p_D, p_A] or None if no odds available.
        """
        key = (str(league), pd.Timestamp(match_date).date(),
               str(home_team), str(away_team))
        odds = self._odds.get(key)
        if odds is None:
            return None
        return _shin_vig_remove(np.array(odds))

    def get_features(
        self,
        *,
        home_team: str,
        away_team: str,
        league: str,
        match_date: pd.Timestamp,
        lambda_h: float,
        lambda_a: float,
    ) -> Dict[str, float]:
        """Compute disagreement features. Returns 0.0/0 if odds unavailable
        (neutral signal — model has no market information for this match).
        """
        if not self._fitted:
            raise RuntimeError("MarketDisagreementCalculator not fitted")

        p_market = self._lookup_market(league, match_date, home_team, away_team)
        if p_market is None:
            return {
                "market_disagreement_flag": 0.0,
                "market_disagreement_high": 0.0,
            }

        # Compute proxy 1X2 from Skellam(λ_h, λ_a)
        p_h, p_d, p_a = _skellam_1x2(lambda_h, lambda_a)
        p_proxy = np.array([p_h, p_d, p_a])

        # Element-wise |Δ|/p_market, then mean over 3 outcomes
        delta = np.abs(p_proxy - p_market) / np.maximum(p_market, 1e-6)
        flag = float(np.clip(delta.mean(), 0.0, 5.0))  # clip extreme values
        high = 1.0 if flag > self.threshold else 0.0

        return {
            "market_disagreement_flag": flag,
            "market_disagreement_high": high,
        }

    def stats(self) -> Dict[str, float]:
        if not self._fitted:
            return {"n_loaded": 0, "n_unique": 0}
        return {
            "n_loaded": self._n_loaded,
            "n_unique": self._n_unique,
            "threshold": self.threshold,
        }
