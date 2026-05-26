#!/usr/bin/env python3
"""
FODZE Mondrian Conformal Prediction Fit for Over/Under 2.5 Market
═══════════════════════════════════════════════════════════════════

Sibling of tools/fit_conformal.py (which handles 1X2). This script
fits per-league quantiles q_g for BINARY conformal classification of
Over 2.5 outcomes, producing prediction sets:

    S(x) = { 0=under, 1=over : p_k(x) >= 1 - q_g }

with (1-α) coverage within each league.

Why this exists now (2026-05-25):
  The 1X2 Conformal Gate fit (2026-04-21) only covered 3-class match
  results. We now have 19,733 Pinnacle-close Over25 rows in match_
  prematch_signals (via commits f53e13f + f87c812). Combined with
  v2 OOT predictions in tools/backtest/v2-oot-predictions.parquet
  (which has prob_o25_raw populated for 6,525 historical matches),
  we can fit a proper O/U conformal layer for future enforce-mode.

Note: O/U conformal will start in warn-mode (same as 1X2), monitoring
coverage. Enforce-mode requires demonstrated production benefit + clean
drift across leagues.

Input:
  tools/backtest/v2-oot-predictions.parquet
    columns: prob_o25_raw, actual_h_goals, actual_a_goals, league

Output:
  Appends "ou25" section to public/conformal-quantiles.json
  (preserves existing 1X2 "leagues" + "global" sections)
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
QUANTILE_FILE = REPO_ROOT / "public" / "conformal-quantiles.json"

ALPHAS = [0.05, 0.10, 0.20]
MIN_N_LEAGUE = 50  # minimum sample size for per-league fit


def fit_binary_conformal(p_pred: np.ndarray, y_true: np.ndarray,
                          alpha: float) -> float:
    """
    Mondrian binary conformal classification.

    Conformity score s_i = 1 - p_i[y_i]
      For y=1 (over): s_i = 1 - p_o25
      For y=0 (under): s_i = p_o25

    Quantile q = ⌈(n+1)(1-α)⌉ / n-quantile of {s_i}.
    At test time, prediction set includes class k iff p[k] ≥ 1 - q.

    Returns q (in [0, 1]).
    """
    n = len(p_pred)
    s = np.where(y_true == 1, 1 - p_pred, p_pred)
    # Order-statistic adjustment per Angelopoulos & Bates eq. 2.1
    k = int(np.ceil((n + 1) * (1 - alpha)))
    if k > n:
        k = n
    q = np.sort(s)[k - 1]  # 0-indexed
    return float(q)


def empirical_coverage(p_pred: np.ndarray, y_true: np.ndarray, q: float) -> float:
    """Coverage = % of cases where true class is in prediction set."""
    # Class 1 (over) in set iff p_o25 >= 1 - q
    # Class 0 (under) in set iff 1 - p_o25 >= 1 - q  →  p_o25 <= q
    in_set_y1 = p_pred >= (1 - q)
    in_set_y0 = p_pred <= q
    in_set = np.where(y_true == 1, in_set_y1, in_set_y0)
    return float(in_set.mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--alphas", default=",".join(map(str, ALPHAS)),
                   help="comma-separated α values (default 0.05,0.10,0.20)")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    print("═" * 70)
    print("Conformal Fit — Over/Under 2.5 (Binary, Mondrian per-league)")
    print("═" * 70)

    if not PARQUET.exists():
        print(f"  ✗ Missing: {PARQUET}")
        return
    df = pd.read_parquet(PARQUET)
    print(f"\n  Loaded: {len(df):,} v2 OOT rows")

    # Compute realized over25
    df["over25"] = (df["actual_h_goals"] + df["actual_a_goals"] > 2.5).astype(int)
    df = df.dropna(subset=["prob_o25_raw", "over25", "league"])
    print(f"  Valid (non-null prob + outcome): {len(df):,}")
    print(f"  Over25 base rate: {df['over25'].mean()*100:.2f}%")
    print(f"  Mean predicted P(Over25): {df['prob_o25_raw'].mean()*100:.2f}%")

    alphas = [float(a) for a in args.alphas.split(",")]
    print(f"\n  Fitting α ∈ {alphas}")

    # Global fit
    global_q = {str(a): round(fit_binary_conformal(
        df["prob_o25_raw"].values, df["over25"].values, a
    ), 4) for a in alphas}
    global_cov = {str(a): round(empirical_coverage(
        df["prob_o25_raw"].values, df["over25"].values, global_q[str(a)]
    ) * 100, 2) for a in alphas}
    print(f"\n  GLOBAL (n={len(df):,}):")
    for a in alphas:
        target = (1 - a) * 100
        emp = global_cov[str(a)]
        gap = emp - target
        flag = "✓" if abs(gap) < 2 else "⚠" if abs(gap) < 5 else "🔴"
        print(f"    α={a:.2f}  q={global_q[str(a)]:.4f}  "
              f"target coverage={target:.0f}%  empirical={emp:.1f}%  Δ={gap:+.1f}pp  {flag}")

    # Per-league fit
    print(f"\n  PER-LEAGUE (min n={MIN_N_LEAGUE}):")
    leagues_out = {}
    print(f"    {'League':<16} {'n':>5}  {'α=0.05':>10}  {'α=0.10':>10}  {'α=0.20':>10}")
    for lg, sub in df.groupby("league"):
        n = len(sub)
        if n < MIN_N_LEAGUE:
            continue
        p_arr = sub["prob_o25_raw"].values
        y_arr = sub["over25"].values
        lg_q = {}
        lg_cov = {}
        for a in alphas:
            q = fit_binary_conformal(p_arr, y_arr, a)
            cov = empirical_coverage(p_arr, y_arr, q) * 100
            lg_q[str(a)] = round(q, 4)
            lg_cov[str(a)] = round(cov, 2)
        leagues_out[lg] = lg_q
        line = f"    {lg:<16} {n:>5,}"
        for a in alphas:
            target = (1 - a) * 100
            emp = lg_cov[str(a)]
            gap = emp - target
            flag = "✓" if abs(gap) < 2 else "⚠" if abs(gap) < 5 else "🔴"
            line += f"  {lg_q[str(a)]:.4f} {flag}"
        print(line)

    # Update public/conformal-quantiles.json
    if not args.dry:
        existing = json.loads(QUANTILE_FILE.read_text()) if QUANTILE_FILE.exists() else {}
        # Append new "ou25" section without disturbing 1X2 sections
        from datetime import datetime, timezone
        existing.setdefault("ou25", {})
        existing["ou25"] = {
            "_meta": {
                "method": "mondrian_conformal_binary_classification",
                "market": "over_under_2_5",
                "engine_source": "v2_raw_predictions",
                "calibration_n_total": int(len(df)),
                "calibration_n_per_league_min": MIN_N_LEAGUE,
                "alphas": alphas,
                "trained_at": datetime.now(timezone.utc).isoformat(),
                "note": "Warn-mode by default; flip to enforce only after coverage drift verified.",
            },
            "global": global_q,
            "leagues": leagues_out,
        }
        QUANTILE_FILE.write_text(json.dumps(existing, indent=2))
        print(f"\n  ✓ Updated: {QUANTILE_FILE}")
    else:
        print("\n  (--dry — not writing)")

    # Coverage summary
    print(f"\n  COVERAGE GAPS (per-league, α=0.10 target=90%):")
    drift_count = 0
    for lg, sub in df.groupby("league"):
        if len(sub) < MIN_N_LEAGUE:
            continue
        q = leagues_out.get(lg, {}).get("0.1") or leagues_out.get(lg, {}).get("0.10")
        if q is None:
            continue
        emp = empirical_coverage(sub["prob_o25_raw"].values,
                                  sub["over25"].values, q) * 100
        gap = emp - 90
        if abs(gap) > 2:
            drift_count += 1
            flag = "⚠" if abs(gap) < 5 else "🔴"
            print(f"    {flag} {lg:<16} empirical={emp:.1f}% (target 90%, Δ={gap:+.1f}pp)")

    print(f"\n  Total leagues fitted: {len(leagues_out)}")
    print(f"  Drift leagues (|Δ| > 2pp): {drift_count}")


if __name__ == "__main__":
    main()
