"""CSD veto threshold calibration — empirical pre-step.

Tests whether CSD (Critical-Slowing-Down) autocorrelation signal can identify
match-states where our v2 model's probability output is systematically
miscalibrated, justifying a Kelly stake haircut (veto).

Context (2026-05-21):
  dev-08 archive tested csd_autocorr_lag1 as a FEATURE on goal_diff. Result:
  Brier delta +0.00127 (hurt), bootstrap mean Δ=-0.0016±0.0013 (1.2σ noise).
  Archived as info-redundant.

  HOWEVER — the question for VETO use-case is different:
    Feature use: "does this signal predict score better on average?"
    Veto use:   "does this signal identify TAIL cases where the model is
                systematically worse, justifying stake reduction?"

  These are different questions because the veto only fires in extremes.
  If 5% of matches trigger a veto with 2× higher Brier, the average-effect
  test would miss it (drowned by 95% unaffected). We need conditional analysis.

Two signal variants tested:
  GOAL_DIFF (dev-08 original):
      r_i = goals_for_i - goals_against_i      (signed goal differential)
  RESIDUALS (new hypothesis):
      r_i = goals_for_i - xg_i                  (finishing-process residual)

  Hypothesis: residuals better isolate "model-relevant" instability since the
  underlying xG process is what feeds our v2 EWMA features.

Methodology:
  1. Load v2-oot-predictions (6525 OOT matches, 18 leagues, 2025-08 → 2026-05).
  2. For each match, compute lag-1 ACF + (recent_mean - prior_mean) + sign_flip
     for BOTH teams using last 10 same-team matches before kickoff (4h offset
     for intra-day safety).
  3. For each candidate threshold set, classify each team as one of:
       catastrophic | soft | persistent_reversal | stable
  4. Bucket matches by classification (any-team-in-state triggers).
  5. Per bucket, compute multi-class Brier vs ft_result.
  6. Bootstrap 1000 resamples → 95% CI on Brier-lift vs stable-baseline.

Acceptance gate (per signal × threshold-set):
  PASS if Brier(in-state) - Brier(stable) > +0.030 AND CI_lower > 0
       AND n_in_state >= 100 (statistical power)

Output:
  tools/v4/diagnostics/csd_veto_calibration.json
    {
      "version": "1.0",
      "input_n": 6525,
      "signals_tested": ["goal_diff", "residuals"],
      "threshold_sets": [...],
      "results": [
        {"signal": "...", "threshold_set": "...", "regime": "...",
         "n_in_state": int, "brier_in_state": float, "brier_stable": float,
         "brier_lift": float, "ci_lower_95": float, "ci_upper_95": float,
         "passes_gate": bool}
      ],
      "recommendation": {
        "ship_csd_veto": bool,
        "thresholds": {...} | null,
        "rationale": str,
      }
    }

Usage:
  tools/venv/bin/python3 tools/v4/diagnostics/csd_veto_threshold_calibration.py

Runtime: ~3-5 min (6525 × 2 teams × 10-match-lookback = ~130k history queries).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

from v4.data.loaders import load_team_xg_history  # noqa: E402


# ─────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────

WINDOW = 10                  # last-N matches for CSD calc (matches dev-08)
MIN_OBS = 8                  # minimum observations to compute ACF reliably
RECENT_BLOCK = 3             # last-3 matches form "recent" block
BOOTSTRAP_N = 1000
RNG_SEED = 20260521
BRIER_LIFT_GATE = 0.030      # required absolute Brier increase in tail
MIN_N_IN_STATE = 100         # statistical-power floor

INPUT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
OUTPUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "csd_veto_calibration.json"


# Threshold candidate sets — span the "plausible" range.
# Each tuple defines (catastrophic, soft, persistent_reversal) regime cuts.
THRESHOLD_SETS = [
    # (label, acf_catastrophic, delta_catastrophic, acf_soft, delta_soft,
    #         acf_persistent, sign_flip_required_recent_prior_min_abs)
    {
        "label": "loose",
        "catastrophic": {"acf_max": 0.30, "delta_min": 0.50},
        "soft":         {"acf_max": 0.40, "delta_min": 0.30},
        "persistent":   {"acf_max": -0.30},
        "sign_flip_min_abs": 0.10,
    },
    {
        "label": "moderate",
        "catastrophic": {"acf_max": 0.15, "delta_min": 0.80},
        "soft":         {"acf_max": 0.25, "delta_min": 0.40},
        "persistent":   {"acf_max": -0.40},
        "sign_flip_min_abs": 0.15,
    },
    {
        "label": "tight",
        "catastrophic": {"acf_max": 0.10, "delta_min": 1.20},
        "soft":         {"acf_max": 0.20, "delta_min": 0.60},
        "persistent":   {"acf_max": -0.50},
        "sign_flip_min_abs": 0.25,
    },
    {
        "label": "very_tight",
        "catastrophic": {"acf_max": 0.05, "delta_min": 1.50},
        "soft":         {"acf_max": 0.15, "delta_min": 0.80},
        "persistent":   {"acf_max": -0.60},
        "sign_flip_min_abs": 0.40,
    },
]


# ─────────────────────────────────────────────────────────────────────
# CSD feature computation
# ─────────────────────────────────────────────────────────────────────


@dataclass
class CsdFeatures:
    """Per-team CSD diagnostics computed from last-N residuals/diffs."""
    rho_1: float
    delta_mu: float          # recent_block_mean - prior_block_mean
    sign_flipped: bool
    n_obs: int


def _compute_csd(series: np.ndarray, recent_block: int = RECENT_BLOCK,
                 sign_flip_min_abs: float = 0.15) -> CsdFeatures:
    """Compute lag-1 ACF + recent-vs-prior delta + sign-flip from a series."""
    n = len(series)
    if n < MIN_OBS:
        return CsdFeatures(rho_1=0.0, delta_mu=0.0, sign_flipped=False, n_obs=n)

    # Lag-1 Pearson autocorrelation
    lead = series[1:]
    lag = series[:-1]
    if np.std(lead) < 1e-9 or np.std(lag) < 1e-9:
        rho_1 = 0.0
    else:
        rho_1 = float(np.corrcoef(lag, lead)[0, 1])
    rho_1 = float(np.clip(rho_1, -1.0, 1.0))

    # Block means (most-recent vs prior)
    recent = series[-recent_block:]
    prior = series[:-recent_block]
    if len(prior) == 0:
        return CsdFeatures(rho_1=rho_1, delta_mu=0.0, sign_flipped=False, n_obs=n)

    mu_recent = float(recent.mean())
    mu_prior = float(prior.mean())
    delta_mu = mu_recent - mu_prior

    sign_flipped = (
        abs(mu_recent) > sign_flip_min_abs
        and abs(mu_prior) > sign_flip_min_abs
        and np.sign(mu_recent) != np.sign(mu_prior)
    )

    return CsdFeatures(rho_1=rho_1, delta_mu=delta_mu,
                       sign_flipped=sign_flipped, n_obs=n)


def _classify(features: CsdFeatures, thresholds: dict) -> str:
    """Map (rho, delta, flip) → regime label using a threshold set."""
    if features.n_obs < MIN_OBS:
        return "insufficient_n"
    abs_rho = abs(features.rho_1)
    abs_delta = abs(features.delta_mu)

    if (abs_rho < thresholds["catastrophic"]["acf_max"]
        and features.sign_flipped
        and abs_delta > thresholds["catastrophic"]["delta_min"]):
        return "catastrophic"

    if (abs_rho < thresholds["soft"]["acf_max"]
        and features.sign_flipped
        and abs_delta > thresholds["soft"]["delta_min"]):
        return "soft"

    if features.rho_1 < thresholds["persistent"]["acf_max"] and features.sign_flipped:
        return "persistent_reversal"

    return "stable"


# ─────────────────────────────────────────────────────────────────────
# Per-match CSD feature extraction
# ─────────────────────────────────────────────────────────────────────


def _build_team_history_index(team_xg: pd.DataFrame) -> dict:
    """Pre-index team_xg_history by (league, team) → sorted array of
    (match_date_unix, goals_for, goals_against, xg) tuples for fast lookup."""
    print(f"[index] building team-history index for {len(team_xg):,} rows...")
    team_xg = team_xg.copy()
    team_xg["match_ts"] = (team_xg["match_date"].astype("int64") // 10**9).astype(int)

    out: dict = {}
    grouped = team_xg.groupby(["league", "team"], sort=False)
    for (league, team), g in grouped:
        g_sorted = g.sort_values("match_ts", kind="mergesort")
        out[(league, team)] = {
            "ts": g_sorted["match_ts"].values,
            "goals_for": g_sorted["goals_for"].fillna(0).values.astype(float),
            "goals_against": g_sorted["goals_against"].fillna(0).values.astype(float),
            "xg": g_sorted["xg"].fillna(g_sorted["goals_for"]).values.astype(float),
        }
    print(f"[index] {len(out):,} (league, team) keys indexed")
    return out


def _lookup_series(history_idx: dict, league: str, team: str,
                   focal_ts: int, signal: str) -> np.ndarray:
    """Get last-WINDOW values BEFORE focal_ts (4h leakage offset) for one team."""
    key = (league, team)
    if key not in history_idx:
        return np.array([], dtype=float)

    rec = history_idx[key]
    cutoff = focal_ts - 14400  # 4h offset (M6 strict-lagging)
    mask = rec["ts"] <= cutoff
    if not mask.any():
        return np.array([], dtype=float)

    last_idx = np.where(mask)[0][-WINDOW:]
    if signal == "goal_diff":
        return rec["goals_for"][last_idx] - rec["goals_against"][last_idx]
    elif signal == "residuals":
        return rec["goals_for"][last_idx] - rec["xg"][last_idx]
    else:
        raise ValueError(f"unknown signal: {signal!r}")


# ─────────────────────────────────────────────────────────────────────
# Brier + bootstrap
# ─────────────────────────────────────────────────────────────────────


def _match_brier(row: pd.Series) -> float:
    """Multi-class Brier score for a single (H/D/A) prediction vs realized."""
    realized = {"H": 0, "D": 0, "A": 0}
    realized[row["ft_result"]] = 1
    return float(
        (row["prob_h_raw"] - realized["H"]) ** 2
        + (row["prob_d_raw"] - realized["D"]) ** 2
        + (row["prob_a_raw"] - realized["A"]) ** 2
    )


def _bootstrap_brier_ci(brier_in: np.ndarray, brier_stable: np.ndarray,
                       n_boot: int = BOOTSTRAP_N) -> tuple[float, float, float]:
    """Return (mean_lift, ci_lower_95, ci_upper_95) for Brier(in) - Brier(stable)."""
    rng = np.random.default_rng(RNG_SEED)
    if len(brier_in) == 0 or len(brier_stable) == 0:
        return (0.0, 0.0, 0.0)

    lifts = np.empty(n_boot, dtype=float)
    for i in range(n_boot):
        bi = rng.choice(brier_in, size=len(brier_in), replace=True)
        bs = rng.choice(brier_stable, size=len(brier_stable), replace=True)
        lifts[i] = bi.mean() - bs.mean()

    return (
        float(brier_in.mean() - brier_stable.mean()),
        float(np.percentile(lifts, 2.5)),
        float(np.percentile(lifts, 97.5)),
    )


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────


def main():
    print(f"[load] reading {INPUT_PARQUET.name}")
    preds = pd.read_parquet(INPUT_PARQUET)
    preds["match_date"] = pd.to_datetime(preds["match_date"])
    preds["match_ts"] = (preds["match_date"].astype("int64") // 10**9).astype(int)
    print(f"[load] {len(preds):,} predictions across {preds['league'].nunique()} leagues")

    # Load team_xg_history covering all needed history (2 years back from earliest pred)
    earliest = preds["match_date"].min() - pd.Timedelta(days=730)
    print(f"[load] team_xg_history since {earliest.date()}")
    team_xg = load_team_xg_history(since=earliest.strftime("%Y-%m-%d"))
    print(f"[load] {len(team_xg):,} team-rows")

    history_idx = _build_team_history_index(team_xg)

    # PASS 1: Cache raw series ONCE per (signal, league, team, match_ts).
    # Storing series (not features) lets us reuse across all threshold sets
    # which vary sign_flip_min_abs and thus require re-computing features.
    print("[compute] caching raw CSD series per match × side × signal...")
    series_cache: dict = {}
    preds_records = preds[["league", "home_team", "away_team", "match_ts"]].to_dict("records")
    for sig in ("goal_diff", "residuals"):
        for rec in preds_records:
            for side in ("home_team", "away_team"):
                team = rec[side]
                key = (sig, rec["league"], team, int(rec["match_ts"]))
                if key in series_cache:
                    continue
                series_cache[key] = _lookup_series(
                    history_idx, rec["league"], team, int(rec["match_ts"]), sig
                )
    print(f"[compute] {len(series_cache):,} series cached "
          f"({sum(1 for v in series_cache.values() if len(v) >= MIN_OBS):,} usable)")

    # Compute Brier per match (independent of CSD)
    preds["brier"] = preds.apply(_match_brier, axis=1)

    # PASS 2: For each (signal × threshold_set × regime), classify matches and compare Brier
    regime_severity = {"insufficient_n": -1, "stable": 0,
                      "persistent_reversal": 1, "soft": 2, "catastrophic": 3}
    results = []
    for sig in ("goal_diff", "residuals"):
        for ts_def in THRESHOLD_SETS:
            regime_for_match = []
            for rec in preds_records:
                worst_severity = -1
                worst_regime = "insufficient_n"
                for side in ("home_team", "away_team"):
                    team = rec[side]
                    series = series_cache[(sig, rec["league"], team, int(rec["match_ts"]))]
                    if len(series) < MIN_OBS:
                        continue
                    f_local = _compute_csd(series, sign_flip_min_abs=ts_def["sign_flip_min_abs"])
                    label = _classify(f_local, ts_def)
                    sev = regime_severity.get(label, -1)
                    if sev > worst_severity:
                        worst_severity = sev
                        worst_regime = label
                regime_for_match.append(worst_regime)

            preds["_regime"] = regime_for_match
            brier_stable = preds.loc[preds["_regime"] == "stable", "brier"].values

            for regime in ("catastrophic", "soft", "persistent_reversal"):
                mask = preds["_regime"] == regime
                n_in = int(mask.sum())
                if n_in == 0:
                    results.append({
                        "signal": sig,
                        "threshold_set": ts_def["label"],
                        "regime": regime,
                        "n_in_state": 0,
                        "brier_in_state": None,
                        "brier_stable": float(brier_stable.mean()) if len(brier_stable) else None,
                        "brier_lift": None,
                        "ci_lower_95": None,
                        "ci_upper_95": None,
                        "passes_gate": False,
                    })
                    continue
                brier_in = preds.loc[mask, "brier"].values
                lift, ci_lo, ci_hi = _bootstrap_brier_ci(brier_in, brier_stable)
                passes = (
                    n_in >= MIN_N_IN_STATE
                    and lift > BRIER_LIFT_GATE
                    and ci_lo > 0
                )
                results.append({
                    "signal": sig,
                    "threshold_set": ts_def["label"],
                    "regime": regime,
                    "n_in_state": n_in,
                    "brier_in_state": float(brier_in.mean()),
                    "brier_stable": float(brier_stable.mean()),
                    "brier_lift": lift,
                    "ci_lower_95": ci_lo,
                    "ci_upper_95": ci_hi,
                    "passes_gate": passes,
                })

    # Determine recommendation
    passing = [r for r in results if r["passes_gate"]]
    if passing:
        # Pick highest brier_lift with adequate n
        best = max(passing, key=lambda r: r["brier_lift"])
        recommendation = {
            "ship_csd_veto": True,
            "signal": best["signal"],
            "threshold_set": best["threshold_set"],
            "regime": best["regime"],
            "n_in_state": best["n_in_state"],
            "brier_lift": best["brier_lift"],
            "ci_lower_95": best["ci_lower_95"],
            "rationale": (
                f"{best['regime']} regime on {best['signal']} signal with "
                f"{best['threshold_set']} thresholds: n={best['n_in_state']}, "
                f"Brier lift +{best['brier_lift']:.4f} "
                f"(CI [{best['ci_lower_95']:.4f}, {best['ci_upper_95']:.4f}]) "
                f"clears gate (>{BRIER_LIFT_GATE} + CI_lower > 0)."
            ),
        }
    else:
        # Find closest-to-passing for diagnostic
        adequately_powered = [r for r in results if r["n_in_state"] >= MIN_N_IN_STATE]
        if adequately_powered:
            closest = max(adequately_powered,
                         key=lambda r: r["brier_lift"] if r["brier_lift"] is not None else -1)
            rationale = (
                f"NO veto-config passes gate. Closest: {closest['signal']}/"
                f"{closest['threshold_set']}/{closest['regime']} n={closest['n_in_state']}, "
                f"lift={closest['brier_lift']:.4f}, CI=[{closest['ci_lower_95']:.4f}, "
                f"{closest['ci_upper_95']:.4f}]. Either insufficient lift or CI crosses 0."
            )
        else:
            rationale = (
                f"NO veto-config has n >= {MIN_N_IN_STATE}. Tail-regime detection too "
                "rare with all tested thresholds — signal does not support a veto-layer."
            )
        recommendation = {
            "ship_csd_veto": False,
            "rationale": rationale,
        }

    output = {
        "version": "1.0",
        "input_n": len(preds),
        "input_path": str(INPUT_PARQUET.relative_to(REPO_ROOT)),
        "params": {
            "window": WINDOW,
            "min_obs": MIN_OBS,
            "recent_block": RECENT_BLOCK,
            "bootstrap_n": BOOTSTRAP_N,
            "brier_lift_gate": BRIER_LIFT_GATE,
            "min_n_in_state": MIN_N_IN_STATE,
        },
        "signals_tested": ["goal_diff", "residuals"],
        "threshold_sets": THRESHOLD_SETS,
        "results": results,
        "recommendation": recommendation,
    }

    OUTPUT_JSON.write_text(json.dumps(output, indent=2, default=str))
    print(f"\n[write] {OUTPUT_JSON}")
    print(f"[recommendation] ship_csd_veto = {recommendation['ship_csd_veto']}")
    print(f"[rationale] {recommendation['rationale']}")


if __name__ == "__main__":
    main()
