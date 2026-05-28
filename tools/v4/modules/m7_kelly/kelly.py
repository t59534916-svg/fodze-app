"""
m7_kelly.kelly — Robust Bayesian Kelly stake calculator.

Per V4-BACKTESTING-PROTOCOL §"Modul-7 Robust Bayesian Kelly Algorithmus":

  Step 1: Vanilla Kelly (point estimate)
    edge      = p_hat × o - 1
    f_vanilla = edge / (o - 1)   if edge > 0 else 0

  Step 2: Bayesian Variance Shrinkage
    Tighter posterior (low σ²) → trust more → close to vanilla
    Wider posterior (high σ²) → shrink → smaller bet
    shrinkage  = 1 / (1 + α × σ²_hat / p_hat²)
    f_bayesian = f_vanilla × shrinkage

  Step 3: Robust Cap per Profile
    f_cap    = {K: 0.025, M: 0.040, A: 0.060}[profile]
    f_robust = min(f_bayesian, f_cap)

  Step 4: Edge-Gate (Goldilocks)
    if not (goldilocks_min ≤ edge ≤ goldilocks_max):  return 0

  Step 5: CLV-Feedback Dampening (optional)
    if current_clv_zscore(league) < threshold:  f_robust *= dampening_factor

Output (dict): f_robust (∈ [0, f_cap]), f_vanilla, edge, shrinkage,
               expected_value (= f × edge), reasons (list of why bet was
               sized as it was — for diagnostic transparency).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

import numpy as np

from v4.modules.m7_kelly.goldilocks import (
    DEFAULT_LIGA_TIERS,
    PROFILE_CAPS,
    TIER_EDGE_WINDOWS,
    get_edge_window,
    get_kelly_cap,
    get_tier,
)


# Sentinel — caller didn't pass σ²_hat (treat as σ²=0, no shrinkage applied)
NO_VARIANCE = 0.0

# Lambda safety floor — guard against divide-by-zero in variance-shrinkage
# formula `σ²/p²` when p_hat is tiny. If p_hat < this, treat shrinkage as
# heavy (effectively don't bet).
MIN_P_FOR_SHRINKAGE = 1e-6


@dataclass(frozen=True)
class KellyDecision:
    """Immutable result of a Kelly calculation. All fields populated even
    when stake = 0, so downstream consumers can introspect WHY the bet was
    not taken."""

    f_robust: float        # Final stake fraction (∈ [0, f_cap])
    f_vanilla: float       # Step 1 result (point estimate Kelly)
    f_bayesian: float      # Step 2 result (after variance shrinkage)
    edge: float            # p_hat × odds - 1
    shrinkage: float       # 1 / (1 + α × σ²/p²) — multiplicative factor
    expected_value: float  # f_robust × edge (fraction of bankroll expected)
    league_tier: str       # "sharp" / "moderate" / "soft"
    edge_window: Tuple[float, float]  # (min, max) Goldilocks for this Liga
    edge_in_window: bool   # Did the edge clear Goldilocks?
    cap_applied: bool      # Was f_robust limited by profile cap?
    clv_dampened: bool     # Did CLV-feedback halve the stake?
    reasons: Tuple[str, ...]  # Human-readable reasons for the final stake
    # Inputs (for traceability)
    p_hat: float
    sigma_sq: float
    odds: float
    profile: str
    league: str


class RobustBayesianKelly:
    """Stake calculator implementing the 5-step protocol Kelly.

    Stateless — all data passed per call. Constructor configures:
      - profile (K/M/A)            — risk appetite (Kelly cap)
      - alpha (variance-shrinkage) — how aggressively to shrink for variance
      - liga_tiers (Liga→tier)     — Goldilocks tier per Liga (override OK)
      - tier_windows (tier→range)  — edge window per tier
      - profile_caps (profile→cap) — Kelly cap per profile
      - clv_feedback_fn (optional) — callable(league)→float for CLV z-score
      - clv_threshold/factor       — when to dampen and by how much
    """

    def __init__(
        self,
        *,
        profile: str = "M",
        alpha: float = 1.0,
        liga_tiers: Optional[Dict[str, str]] = None,
        tier_windows: Optional[Dict[str, Tuple[float, float]]] = None,
        profile_caps: Optional[Dict[str, float]] = None,
        clv_feedback_fn: Optional[Callable[[str], float]] = None,
        clv_dampening_zscore_threshold: float = -1.0,
        clv_dampening_factor: float = 0.5,
        liga_allow_list: Optional[set] = None,
    ):
        # Validate profile up front (caller-error catches before any compute)
        caps = profile_caps if profile_caps is not None else PROFILE_CAPS
        if profile not in caps:
            raise ValueError(
                f"profile must be one of {list(caps.keys())}, got {profile!r}"
            )
        if alpha < 0:
            raise ValueError(f"alpha must be non-negative, got {alpha}")
        if not (0.0 <= clv_dampening_factor <= 1.0):
            raise ValueError(
                f"clv_dampening_factor must be in [0, 1], got {clv_dampening_factor}"
            )

        self.profile = profile
        self.alpha = float(alpha)
        self.liga_tiers = liga_tiers if liga_tiers is not None else dict(DEFAULT_LIGA_TIERS)
        self.tier_windows = tier_windows if tier_windows is not None else dict(TIER_EDGE_WINDOWS)
        self.profile_caps = caps
        self.clv_feedback_fn = clv_feedback_fn
        self.clv_dampening_zscore_threshold = float(clv_dampening_zscore_threshold)
        self.clv_dampening_factor = float(clv_dampening_factor)
        # liga_allow_list: if not None, only Ligen in this set are allowed to
        # produce non-zero stakes. Used by Path A (Liga-conditional Goldilocks).
        # None = no filter (all Ligen pass through the standard Goldilocks gate).
        self.liga_allow_list = set(liga_allow_list) if liga_allow_list is not None else None

    # ─────────────────────────────────────────────────────────────────
    # Pure math (testable in isolation)
    # ─────────────────────────────────────────────────────────────────

    @staticmethod
    def vanilla_kelly(p_hat: float, odds: float) -> Tuple[float, float]:
        """Step 1: vanilla Kelly. Returns (edge, f_vanilla).
        f_vanilla = 0 if edge ≤ 0.
        """
        if odds <= 1.0:
            raise ValueError(f"odds must be > 1.0, got {odds}")
        if not (0.0 <= p_hat <= 1.0):
            raise ValueError(f"p_hat must be in [0, 1], got {p_hat}")
        edge = p_hat * odds - 1.0
        if edge <= 0:
            return float(edge), 0.0
        f_vanilla = edge / (odds - 1.0)
        return float(edge), float(f_vanilla)

    def variance_shrinkage_factor(self, p_hat: float, sigma_sq: float) -> float:
        """Step 2: shrinkage = 1 / (1 + α × σ² / p²).

        Bounded to (0, 1]:
          - σ² = 0 → shrinkage = 1 (no shrinkage)
          - σ² >> p² → shrinkage → 0 (heavy shrinkage)
          - p tiny → shrinkage → 0 (defensive: don't trust micro probs)
        """
        if sigma_sq < 0:
            raise ValueError(f"sigma_sq must be non-negative, got {sigma_sq}")
        if p_hat < MIN_P_FOR_SHRINKAGE:
            # Tiny p → variance/p² blows up → shrinkage → 0
            return 0.0
        return 1.0 / (1.0 + self.alpha * sigma_sq / (p_hat * p_hat))

    # ─────────────────────────────────────────────────────────────────
    # Full algorithm (orchestrates the 5 steps)
    # ─────────────────────────────────────────────────────────────────

    def stake(
        self,
        *,
        p_hat: float,
        odds: float,
        league: str,
        sigma_sq: float = NO_VARIANCE,
    ) -> KellyDecision:
        """Compute stake fraction for ONE bet.

        Args:
            p_hat: predicted probability of the outcome (from m6 blended)
            odds: decimal odds (vig-removed from market)
            league: Liga code (drives Goldilocks tier lookup)
            sigma_sq: posterior variance from m3 Bayesian Ensemble.
                      Pass 0 to disable variance shrinkage (vanilla Kelly path).

        Returns: KellyDecision dataclass with f_robust + all diagnostics.
        """
        reasons: list = []

        # ─── Step 0: Liga allow-list gate (optional, Path A) ───
        # If liga_allow_list is set and the league is not in it, refuse the
        # bet immediately. This is a Liga-level cull BEFORE edge computation.
        if self.liga_allow_list is not None and league not in self.liga_allow_list:
            reasons.append(f"liga_{league}_not_in_allow_list")
            # Compute edge for diagnostics but return f_robust=0
            try:
                edge, _ = self.vanilla_kelly(p_hat, odds)
            except ValueError:
                edge = 0.0
            return self._build_decision(
                f_robust=0.0,
                f_vanilla=0.0,
                f_bayesian=0.0,
                edge=edge,
                shrinkage=1.0,
                league=league,
                edge_in_window=False,
                cap_applied=False,
                clv_dampened=False,
                reasons=tuple(reasons),
                p_hat=p_hat,
                sigma_sq=sigma_sq,
                odds=odds,
            )

        # ─── Step 1: Vanilla Kelly ───
        edge, f_vanilla = self.vanilla_kelly(p_hat, odds)
        if f_vanilla == 0:
            reasons.append("edge_non_positive")
            return self._build_decision(
                f_robust=0.0,
                f_vanilla=0.0,
                f_bayesian=0.0,
                edge=edge,
                shrinkage=1.0,
                league=league,
                edge_in_window=False,
                cap_applied=False,
                clv_dampened=False,
                reasons=tuple(reasons),
                p_hat=p_hat,
                sigma_sq=sigma_sq,
                odds=odds,
            )

        # ─── Step 2: Variance shrinkage ───
        shrinkage = self.variance_shrinkage_factor(p_hat, sigma_sq)
        f_bayesian = f_vanilla * shrinkage
        if shrinkage < 1.0:
            reasons.append(f"variance_shrinkage_{shrinkage:.3f}")

        # ─── Step 3: Robust cap per profile ───
        f_cap = get_kelly_cap(self.profile, profile_caps=self.profile_caps)
        f_robust = min(f_bayesian, f_cap)
        cap_applied = (f_bayesian > f_cap)
        if cap_applied:
            reasons.append(f"capped_at_{self.profile}_{f_cap:.3f}")

        # ─── Step 4: Goldilocks edge-gate ───
        edge_min, edge_max = get_edge_window(
            league,
            liga_tiers=self.liga_tiers,
            tier_windows=self.tier_windows,
        )
        edge_in_window = (edge_min <= edge <= edge_max)
        if not edge_in_window:
            f_robust = 0.0
            f_bayesian_for_decision = f_bayesian
            f_vanilla_for_decision = f_vanilla
            if edge < edge_min:
                reasons.append(f"edge_below_window_{edge_min:.3f}")
            else:
                reasons.append(f"edge_above_window_{edge_max:.3f}")
            return self._build_decision(
                f_robust=0.0,
                f_vanilla=f_vanilla_for_decision,
                f_bayesian=f_bayesian_for_decision,
                edge=edge,
                shrinkage=shrinkage,
                league=league,
                edge_in_window=False,
                cap_applied=cap_applied,
                clv_dampened=False,
                reasons=tuple(reasons),
                p_hat=p_hat,
                sigma_sq=sigma_sq,
                odds=odds,
            )

        # ─── Step 5: CLV-feedback dampening ───
        clv_dampened = False
        if self.clv_feedback_fn is not None:
            zscore = self.clv_feedback_fn(league)
            if zscore is not None and zscore < self.clv_dampening_zscore_threshold:
                f_robust = f_robust * self.clv_dampening_factor
                clv_dampened = True
                reasons.append(
                    f"clv_dampened_zscore_{zscore:.2f}<{self.clv_dampening_zscore_threshold}"
                )

        if not reasons:
            reasons.append("vanilla_kelly_capped_to_profile")
        return self._build_decision(
            f_robust=f_robust,
            f_vanilla=f_vanilla,
            f_bayesian=f_bayesian,
            edge=edge,
            shrinkage=shrinkage,
            league=league,
            edge_in_window=True,
            cap_applied=cap_applied,
            clv_dampened=clv_dampened,
            reasons=tuple(reasons),
            p_hat=p_hat,
            sigma_sq=sigma_sq,
            odds=odds,
        )

    def _build_decision(
        self,
        *,
        f_robust: float,
        f_vanilla: float,
        f_bayesian: float,
        edge: float,
        shrinkage: float,
        league: str,
        edge_in_window: bool,
        cap_applied: bool,
        clv_dampened: bool,
        reasons: Tuple[str, ...],
        p_hat: float,
        sigma_sq: float,
        odds: float,
    ) -> KellyDecision:
        """Construct a KellyDecision with all fields populated."""
        edge_window = get_edge_window(
            league,
            liga_tiers=self.liga_tiers,
            tier_windows=self.tier_windows,
        )
        return KellyDecision(
            f_robust=float(f_robust),
            f_vanilla=float(f_vanilla),
            f_bayesian=float(f_bayesian),
            edge=float(edge),
            shrinkage=float(shrinkage),
            expected_value=float(f_robust * edge),
            league_tier=get_tier(league, liga_tiers=self.liga_tiers),
            edge_window=edge_window,
            edge_in_window=bool(edge_in_window),
            cap_applied=bool(cap_applied),
            clv_dampened=bool(clv_dampened),
            reasons=reasons,
            p_hat=float(p_hat),
            sigma_sq=float(sigma_sq),
            odds=float(odds),
            profile=self.profile,
            league=league,
        )

    def __repr__(self) -> str:
        n_ligas = len(self.liga_tiers)
        clv = "with-CLV" if self.clv_feedback_fn is not None else "no-CLV"
        return (
            f"RobustBayesianKelly(profile={self.profile}, α={self.alpha}, "
            f"{n_ligas} Ligen, {clv})"
        )
