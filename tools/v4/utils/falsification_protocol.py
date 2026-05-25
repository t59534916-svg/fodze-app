"""
Falsification Protocol — Reusable Hard-Audit Framework

Standard 5-step protocol that ANY new engine feature claim must survive
before being committed to production. Derived from the lineup_aware_mvp
audit (2026-05-25) where a t=2.73 'signal' collapsed under proper
multiple-testing correction + ROI simulation.

USAGE: import these helpers into a per-feature audit script. See
tools/v4/diagnostics/lineup_aware_hard_audit.py as the canonical example.

THE 5 GATES (all must pass for a feature to be production-eligible):

  1. SIGN-AUDIT: Brier comparison convention is unambiguous in code +
     output (positive delta = treatment better, OR explicit comment).
     Catches: silent inverted-evaluation bugs.

  2. MULTIPLE-TESTING: Holm-Bonferroni adjustment over ALL hypotheses
     tested in the same exploration round (not just this single test).
     Catches: p-hacking by trying many features and reporting the lucky one.

  3. LEAKAGE-AUDIT: Inspect feature-engineering code for train/test
     leakage (qcut, scaling, encoding fit on combined data).
     Catches: optimistic out-of-sample estimates due to data peeking.

  4. POWER-ANALYSIS: Compute std of per-match brier-diff empirically,
     then derive required-n for 80% power at corrected α. Reject if
     observed n < required n.
     Catches: underpowered samples where any p<0.05 is essentially
     random (especially after multiple-testing correction).

  5. ROI-SIMULATION: Flat-staking value-bet simulation vs Pinnacle
     closing odds. Require strictly positive ROI after vig.
     Catches: 'Brier-Δ that doesn't translate to profitable edge'
     because the effect is smaller than the bookmaker margin.

EMPIRICAL CALIBRATION (from 17-hypothesis week):
  * Family-wise error rate at α=0.05 across 17 tests: 58.2%
  * sh_diff (best single-test result): p_raw=0.012 → Holm-adj p=0.204
  * Required n for Δ=0.001 at α=0.05/17: ≥ 832 matches
  * Pinnacle vig typical overround: 2.5-3.0%
  * Required sustained Brier-Δ for likely positive ROI: ≥ 0.005

WHEN NOT TO INVOKE THIS PROTOCOL:
  - Not for descriptive statistics or coverage reports.
  - Not for already-deployed features being monitored (different framework).
  - Not for cross-validation hyperparameter tuning within a single fitted
    model (those use nested CV, not separate hypothesis tests).

WHEN TO INVOKE:
  - ANY new feature proposed as engine input.
  - ANY claim of "this looks promising" with raw p < 0.05.
  - ANY decision to add a new column to dev-03's feature vector.
  - ANY new calibration layer being evaluated for activation.
"""

from __future__ import annotations

import numpy as np
from typing import Iterable
from scipy.stats import norm


def holm_bonferroni(hypotheses: list[dict], p_key: str = "p_raw",
                    alpha: float = 0.05) -> list[dict]:
    """Apply Holm-Bonferroni step-down correction.

    Args:
        hypotheses: list of dicts, each with at least the p-value field
        p_key: which key holds the raw p-value
        alpha: family-wise error rate

    Returns:
        Same list, sorted by p_raw ascending, with `p_adj` and
        `significant` keys added.

    Holm step-down: each rank-i (1-indexed sorted) p multiplied by (m - i + 1).
    """
    sorted_h = sorted(hypotheses, key=lambda x: x[p_key])
    m = len(sorted_h)
    for i, h in enumerate(sorted_h):
        h["p_adj"] = min(h[p_key] * (m - i), 1.0)
        h["significant"] = h["p_adj"] < alpha
    return sorted_h


def per_match_brier_stats(p_baseline: np.ndarray, p_treatment: np.ndarray,
                          y: np.ndarray) -> dict:
    """Compute paired per-match brier-diff statistics.

    Required for both power analysis and inference.

    Returns dict with:
      mean_diff, std_diff, se_diff, t_stat, two_sided_p
    """
    p_base = np.asarray(p_baseline)
    p_trt = np.asarray(p_treatment)
    y = np.asarray(y)
    # per-match d_i = treat^2 - base^2 (negative = treatment better)
    d = (p_trt - y) ** 2 - (p_base - y) ** 2
    n = len(d)
    mean_d = float(d.mean())
    std_d = float(d.std(ddof=1))
    se_d = std_d / np.sqrt(n) if n > 1 else float("nan")
    t = mean_d / se_d if se_d > 0 else 0.0
    # Two-sided normal-approx p
    p = 2 * (1 - norm.cdf(abs(t))) if se_d > 0 else 1.0
    return {"n": int(n), "mean_diff": mean_d, "std_diff": std_d,
            "se_diff": se_d, "t_stat": float(t), "two_sided_p": float(p)}


def required_n_for_brier_delta(delta: float, std_diff: float,
                               alpha: float = 0.05,
                               power: float = 0.80,
                               two_sided: bool = True) -> int:
    """How many matches needed to detect `delta` brier improvement
    with `power` probability at significance `alpha`.

    Returns required sample size (rounded up).
    """
    z_alpha = norm.ppf(1 - alpha / 2) if two_sided else norm.ppf(1 - alpha)
    z_beta = norm.ppf(power)
    if delta <= 0:
        return float("inf")
    n_req = ((z_alpha + z_beta) * std_diff / abs(delta)) ** 2
    return int(np.ceil(n_req))


def power_for_brier_delta(delta: float, std_diff: float, n: int,
                          alpha: float = 0.05, two_sided: bool = True) -> float:
    """What's the power to detect `delta` at given n + alpha?

    Returns power ∈ [0, 1].
    """
    if n < 2 or std_diff <= 0 or delta == 0:
        return float("nan")
    se = std_diff / np.sqrt(n)
    z_alpha = norm.ppf(1 - alpha / 2) if two_sided else norm.ppf(1 - alpha)
    z_beta = (abs(delta) / se) - z_alpha
    return float(norm.cdf(z_beta))


def simulate_flat_value_bet(prob_model: np.ndarray, odds: np.ndarray,
                           outcomes: np.ndarray,
                           min_edge_pp: float = 0.0) -> dict:
    """Flat-staking value-bet simulation.

    Bets stake=1 whenever model_prob > market_implied_prob + edge.
    Returns dict with n_bets, total_profit, roi_pct, mean_odds_taken.

    NOTE: market_implied_prob INCLUDES vig (1/odds, not vig-removed).
    A model probability above this implies POSITIVE EV bet under model.
    """
    probs = np.asarray(prob_model)
    odds = np.asarray(odds)
    y = np.asarray(outcomes)
    market_implied = 1 / odds  # includes overround
    edge_filter = probs > (market_implied + min_edge_pp / 100)
    n_bets = int(edge_filter.sum())
    if n_bets == 0:
        return {"n_bets": 0, "total_profit": 0.0, "roi_pct": 0.0,
                "mean_odds_taken": float("nan")}
    profit_per_bet = np.where(y == 1, odds, 0) - 1  # +odds-1 if win, -1 if loss
    total_profit = float(profit_per_bet[edge_filter].sum())
    roi = total_profit / n_bets * 100
    mean_odds = float(odds[edge_filter].mean())
    return {"n_bets": n_bets, "total_profit": round(total_profit, 2),
            "roi_pct": round(roi, 3), "mean_odds_taken": round(mean_odds, 3)}


def gate_summary(audits: dict[str, dict]) -> dict:
    """Aggregate all 5 audit results into a final pass/fail.

    Expects each audit's dict to have a 'pass' boolean or a 'verdict'
    string containing 'PASS' / 'FAIL'.
    """
    gates = ["1_sign", "2_holm", "3_leakage", "4_power", "5_roi"]
    passes = 0
    for g in gates:
        a = audits.get(g) or {}
        is_pass = a.get("pass", False) or "PASS" in str(a.get("verdict", ""))
        if is_pass:
            passes += 1
    return {"gates_passed": passes, "gates_total": len(gates),
            "production_eligible": passes == len(gates)}
