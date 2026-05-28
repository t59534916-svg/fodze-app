"""Walk-forward cross-validation for per-league isotonic calibration.

Chronological 5-fold rolling: initial 60% as base train, then 5 expanding folds
of remaining 40%. This is the right CV for time-series — random k-fold would
leak future data into past calibrator fits.

For each fold, compute Brier + ECE on calibrated vs raw predictions per league.
Returns per-league summary statistics + per-fold details.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss

from .fit import PerLeagueIsotonicCalibrator, CalibratorConfig, OUTCOMES, P_COL


def _ece(y_true: np.ndarray, p_pred: np.ndarray, n_bins: int = 15) -> float:
    """Expected Calibration Error: |mean(p) - mean(y)| weighted by bin-count."""
    bins = np.linspace(0, 1, n_bins + 1)
    inds = np.digitize(p_pred, bins[1:-1])
    ece = 0.0
    n = len(y_true)
    for b in range(n_bins):
        mask = inds == b
        if not mask.any():
            continue
        bin_p = p_pred[mask].mean()
        bin_y = y_true[mask].mean()
        ece += (mask.sum() / n) * abs(bin_p - bin_y)
    return float(ece)


def walk_forward_validate(
    df: pd.DataFrame,
    target_leagues: list[str],
    *,
    initial_train_frac: float = 0.6,
    n_folds: int = 5,
    cfg: CalibratorConfig | None = None,
    bootstrap_n: int = 1000,
    rng_seed: int = 20260521,
) -> dict:
    """
    Returns per-league summary with Brier-delta + ECE-delta + acceptance flag.

    Acceptance gate (per league):
      - Mean Brier-delta < -0.005 across folds
      - Bootstrap CI on Brier-delta: upper bound < 0
      - Mean ECE reduction > 30 %
      - n_total_in_target_league >= 200
    """
    cfg = cfg or CalibratorConfig()
    df = df.sort_values("match_date", kind="mergesort").reset_index(drop=True)
    n = len(df)
    train_init = int(initial_train_frac * n)

    fold_records: dict[str, list[dict]] = {L: [] for L in target_leagues}
    rng = np.random.default_rng(rng_seed)

    # Each fold expands the train set forward; test = next slice of size (n - train_init)/n_folds
    remaining = n - train_init
    fold_size = remaining // n_folds

    for fold in range(n_folds):
        train_end = train_init + fold * fold_size
        test_start = train_end
        test_end = min(test_start + fold_size, n)
        if test_end - test_start < 50:
            continue
        train = df.iloc[:train_end].copy()
        test = df.iloc[test_start:test_end].copy()

        cal = PerLeagueIsotonicCalibrator(cfg).fit(train, target_leagues)

        for league in target_leagues:
            league_test = test[test["league"] == league]
            if len(league_test) < 20:
                continue

            # Per-outcome Brier & ECE on RAW
            briers_raw, eces_raw = {}, {}
            briers_cal, eces_cal = {}, {}
            for outcome in OUTCOMES:
                y = (league_test["ft_result"] == outcome).astype(int).values
                p_raw = league_test[P_COL[outcome]].values.astype(float)
                briers_raw[outcome] = brier_score_loss(y, p_raw)
                eces_raw[outcome] = _ece(y, p_raw)

            # Calibrate one row at a time (isotonic uses interp, not vectorized)
            p_cal_lists = {O: [] for O in OUTCOMES}
            for _, row in league_test.iterrows():
                ph, pd_, pa = cal.predict(
                    league, row["prob_h_raw"], row["prob_d_raw"], row["prob_a_raw"]
                )
                p_cal_lists["H"].append(ph)
                p_cal_lists["D"].append(pd_)
                p_cal_lists["A"].append(pa)

            for outcome in OUTCOMES:
                y = (league_test["ft_result"] == outcome).astype(int).values
                p_cal = np.array(p_cal_lists[outcome])
                briers_cal[outcome] = brier_score_loss(y, p_cal)
                eces_cal[outcome] = _ece(y, p_cal)

            mean_brier_raw = float(np.mean(list(briers_raw.values())))
            mean_brier_cal = float(np.mean(list(briers_cal.values())))
            mean_ece_raw = float(np.mean(list(eces_raw.values())))
            mean_ece_cal = float(np.mean(list(eces_cal.values())))

            fold_records[league].append({
                "fold": fold,
                "n_test": len(league_test),
                "brier_raw": mean_brier_raw,
                "brier_cal": mean_brier_cal,
                "brier_delta": mean_brier_cal - mean_brier_raw,
                "ece_raw": mean_ece_raw,
                "ece_cal": mean_ece_cal,
                "ece_reduction_pct": (
                    (mean_ece_raw - mean_ece_cal) / mean_ece_raw * 100.0
                    if mean_ece_raw > 0 else 0.0
                ),
            })

    # Per-league aggregates with bootstrap CI on Brier-delta
    summary = {}
    for league in target_leagues:
        recs = fold_records[league]
        if not recs:
            summary[league] = {
                "n_folds": 0, "passes_gate": False,
                "reason": "no_folds_with_test_data",
            }
            continue

        deltas = np.array([r["brier_delta"] for r in recs])
        ece_reds = np.array([r["ece_reduction_pct"] for r in recs])
        n_total = int(sum(r["n_test"] for r in recs))

        # Bootstrap CI on mean Brier-delta across folds
        boot_means = np.empty(bootstrap_n)
        for i in range(bootstrap_n):
            boot_means[i] = rng.choice(deltas, size=len(deltas), replace=True).mean()
        ci_lo, ci_hi = np.percentile(boot_means, [2.5, 97.5])

        mean_delta = float(deltas.mean())
        mean_ece_red = float(ece_reds.mean())

        passes = (
            n_total >= 200
            and mean_delta < -0.005
            and ci_hi < 0
            and mean_ece_red > 30.0
        )
        summary[league] = {
            "n_folds": len(recs),
            "n_total_test": n_total,
            "mean_brier_delta": mean_delta,
            "ci_lower_95": float(ci_lo),
            "ci_upper_95": float(ci_hi),
            "mean_ece_reduction_pct": mean_ece_red,
            "passes_gate": passes,
            "fold_details": recs,
        }
    return summary
