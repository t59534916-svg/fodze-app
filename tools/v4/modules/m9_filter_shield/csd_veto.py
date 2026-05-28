"""CSD (Critical Slowing Down) regime-shift veto.

Empirically validated 2026-05-21 on n=6525 v2-OOT predictions.

Classification rules (loose threshold-set from calibration sweep):
  - persistent_reversal: rho_1 < -0.30 AND sign_flip
        → multiplier 0.50, Brier-lift +0.0427 (CI +0.017, +0.069)
  - catastrophic:        |rho_1| < 0.30 AND sign_flip AND |delta_mu| > 0.50
        → multiplier 0.75, but SHADOW until 200 firing burn-in completed
  - stable: everything else → multiplier 1.00 (no veto)

Asymmetric application (team-side aware):
  - Compute CSD per team independently from last-10 goal_diff series.
  - Veto fires PER TEAM. Map to bet-side:
      home team in catastrophic/persistent_reversal → home + draw bets affected
      away team in catastrophic/persistent_reversal → away + draw bets affected
  - Draw is doubly-affected (worst-multiplier wins regardless of which team).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd

from .config import CsdVetoConfig
from .schemas import ShieldVeto


@dataclass(frozen=True)
class CsdVetoResult:
    """Per-team CSD diagnostic — used both for stake adjustment and trail logging."""
    regime: str                      # "persistent_reversal" | "catastrophic" | "stable" | "insufficient_n"
    multiplier: float                # in [0.5, 1.0]
    shadow: bool                     # True if SHADOW_LOG_ONLY regime (catastrophic during burn-in)
    rho_1: float | None
    delta_mu: float | None
    sign_flipped: bool
    n_obs: int
    raw_series: list[float]          # for trail logging


def _compute_csd_features(
    series: np.ndarray,
    *,
    min_obs: int,
    recent_block: int,
    sign_flip_min_abs: float,
) -> tuple[float, float, bool, int]:
    """Return (rho_1, delta_mu, sign_flipped, n_obs)."""
    n = len(series)
    if n < min_obs:
        return (0.0, 0.0, False, n)

    # Lag-1 Pearson autocorrelation
    lead = series[1:]
    lag = series[:-1]
    if np.std(lead) < 1e-9 or np.std(lag) < 1e-9:
        rho_1 = 0.0
    else:
        rho_1 = float(np.corrcoef(lag, lead)[0, 1])
    rho_1 = float(np.clip(rho_1, -1.0, 1.0))

    recent = series[-recent_block:]
    prior = series[:-recent_block]
    if len(prior) == 0:
        return (rho_1, 0.0, False, n)

    mu_recent = float(recent.mean())
    mu_prior = float(prior.mean())
    delta_mu = mu_recent - mu_prior

    sign_flipped = bool(
        abs(mu_recent) > sign_flip_min_abs
        and abs(mu_prior) > sign_flip_min_abs
        and np.sign(mu_recent) != np.sign(mu_prior)
    )

    return (rho_1, delta_mu, sign_flipped, n)


def compute_csd_veto(
    series: np.ndarray,
    cfg: CsdVetoConfig,
) -> CsdVetoResult:
    """
    Classify a team's last-N goal_diff series into a CSD regime.

    series: chronological [oldest, ..., most_recent], length >= 1.
            Element_i = goals_for_i - goals_against_i for that match.

    Returns CsdVetoResult with regime label + multiplier (active or shadow).
    """
    rho_1, delta_mu, sign_flipped, n = _compute_csd_features(
        series,
        min_obs=cfg.min_obs,
        recent_block=cfg.recent_block,
        sign_flip_min_abs=cfg.sign_flip_min_abs,
    )

    if n < cfg.min_obs:
        return CsdVetoResult(
            regime="insufficient_n",
            multiplier=1.0,
            shadow=False,
            rho_1=None,
            delta_mu=None,
            sign_flipped=False,
            n_obs=n,
            raw_series=series.tolist() if len(series) > 0 else [],
        )

    # Check regimes in priority order: persistent_reversal > catastrophic
    # (persistent has stronger empirical signal +0.043 vs +0.020)
    pr = cfg.regimes.get("persistent_reversal")
    if (pr is not None and pr.acf_max is not None
        and rho_1 < pr.acf_max and sign_flipped):
        return CsdVetoResult(
            regime="persistent_reversal",
            multiplier=pr.multiplier if pr.active else 1.0,
            shadow=not pr.active,
            rho_1=rho_1,
            delta_mu=delta_mu,
            sign_flipped=sign_flipped,
            n_obs=n,
            raw_series=series.tolist(),
        )

    cat = cfg.regimes.get("catastrophic")
    if (cat is not None
        and cat.acf_max_abs is not None
        and cat.delta_min_abs is not None
        and abs(rho_1) < cat.acf_max_abs
        and sign_flipped
        and abs(delta_mu) > cat.delta_min_abs):
        return CsdVetoResult(
            regime="catastrophic",
            multiplier=cat.multiplier if cat.active else 1.0,
            shadow=not cat.active,
            rho_1=rho_1,
            delta_mu=delta_mu,
            sign_flipped=sign_flipped,
            n_obs=n,
            raw_series=series.tolist(),
        )

    return CsdVetoResult(
        regime="stable",
        multiplier=1.0,
        shadow=False,
        rho_1=rho_1,
        delta_mu=delta_mu,
        sign_flipped=sign_flipped,
        n_obs=n,
        raw_series=series.tolist(),
    )


def fetch_goal_diff_series(
    team_history: pd.DataFrame,
    focal_kickoff_ts: int,
    *,
    window: int,
    leakage_offset_sec: int,
) -> np.ndarray:
    """
    Slice team_xg_history for one team to last-window chronological goal_diffs
    with strict 4h-offset before focal kickoff (M6 anti-leakage).

    team_history must be PRE-FILTERED to a single (league, team) and have
    'match_ts' (int unix seconds) + 'goals_for' + 'goals_against' columns.
    """
    if team_history.empty:
        return np.array([], dtype=float)
    cutoff = focal_kickoff_ts - leakage_offset_sec
    past = team_history[team_history["match_ts"] <= cutoff].copy()
    if past.empty:
        return np.array([], dtype=float)
    past = past.sort_values("match_ts", kind="mergesort").tail(window)
    return (
        past["goals_for"].fillna(0).astype(float).values
        - past["goals_against"].fillna(0).astype(float).values
    )


def csd_veto_to_shield_veto(
    result: CsdVetoResult,
    *,
    team_side: str,  # "home" | "away"
    match_key: str,
) -> ShieldVeto | None:
    """Convert per-team CSD result → ShieldVeto for orchestrator consumption."""
    if result.regime in ("stable", "insufficient_n"):
        return None
    # Map team-side → affected bet markets
    if team_side == "home":
        affected = ["home", "draw"]  # negative for home-team affects home + draw bets
    elif team_side == "away":
        affected = ["away", "draw"]
    else:
        raise ValueError(f"unknown team_side: {team_side!r}")

    return ShieldVeto(
        name=f"CSD_REGIME_SHIFT:{result.regime}:{team_side}",
        multiplier=result.multiplier,
        reason=(
            f"CSD {result.regime} on {team_side}-side: "
            f"rho_1={result.rho_1:.3f}, delta_mu={result.delta_mu:.2f}, "
            f"sign_flip={result.sign_flipped}, n={result.n_obs}"
        ),
        applies_to=affected,
        raw_diagnostic={
            "regime": result.regime,
            "rho_1": result.rho_1,
            "delta_mu": result.delta_mu,
            "sign_flipped": result.sign_flipped,
            "n_obs": result.n_obs,
            "team_side": team_side,
            "match_key": match_key,
        },
        shadow=result.shadow,
    )
