"""
compare_dev02_vs_dev03.py — Side-by-side dev-02-elo vs dev-03 on 25/26 holdout.

Computes for each artifact tag:
  - Brier (multiclass 1X2)
  - Stage 5 ROI (USER_GOLDILOCKS: tier-aware edge band) with Pinnacle closing odds
  - High-Confidence ROI + CI (p ≥ 0.68)
  - Calibration in [0.68, 0.72) bin
  - SHAP on new dev-03 features on HC matches

Bootstrap: 10.000 resamples, SEED=42.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd
from scipy.stats import beta as scipy_beta

from v4.data.loaders import load_team_xg_history
from v4.modules.m3_xg import XGPredictor
from v4.modules.m3_xg.feature_builder import (
    NUMERIC_FEATURES,
    build_features_for_corpus,
)
from v4.modules.m6_market import BenterBlender, remove_vig
from v4.modules.m7_kelly.goldilocks import DEFAULT_LIGA_TIERS

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"

SEED = 42
BOOT = 10_000
KELLY_CAP = 0.04

P_THRESH = 0.68
EDGE_THRESH = 0.035

GOLDILOCKS = {
    "sharp":    (0.015, 0.050),
    "moderate": (0.025, 0.075),
    "soft":     (0.035, 0.085),
}
FALLBACK_TIER = "moderate"

TAGS = ["dev-02-elo", "dev-03"]


def _outcome_label(h, a):
    if h > a: return "H"
    if h < a: return "A"
    return "D"


def _bootstrap_roi_ci(profits, stakes, n_boot=BOOT, seed=SEED):
    if len(profits) == 0:
        return float("nan"), float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    n = len(profits)
    boot = np.empty(n_boot)
    for i in range(n_boot):
        idx = rng.integers(0, n, n)
        s = stakes[idx].sum()
        boot[i] = profits[idx].sum() / s if s > 0 else 0.0
    return (float(np.percentile(boot, 2.5)),
            float(np.median(boot)),
            float(np.percentile(boot, 97.5)))


def _kelly_stake(edge, odds):
    return min(edge / (odds - 1.0), KELLY_CAP) if edge > 0 else 0.0


def _clopper_pearson(k, n, alpha=0.05):
    if n == 0: return float("nan"), float("nan")
    lo = scipy_beta.ppf(alpha / 2, k, n - k + 1) if k > 0 else 0.0
    hi = scipy_beta.ppf(1 - alpha / 2, k + 1, n - k) if k < n else 1.0
    return float(lo), float(hi)


def brier_multiclass(p, y):
    """p: (n, 3) prob; y: (n,) labels 'H'/'D'/'A'."""
    label_to_idx = {"H": 0, "D": 1, "A": 2}
    y_idx = np.array([label_to_idx[v] for v in y])
    n = len(y)
    oh = np.zeros_like(p)
    oh[np.arange(n), y_idx] = 1.0
    return float(((p - oh) ** 2).sum(axis=1).mean())


def run_for_tag(tag, df_holdout, history):
    print(f"\n{'=' * 70}\n  Running pipeline for tag={tag}\n{'=' * 70}")
    pred = XGPredictor.from_artifacts(
        home_path=ARTIFACTS / f"m3_xg-home-{tag}.pkl",
        away_path=ARTIFACTS / f"m3_xg-away-{tag}.pkl",
    )
    blender = BenterBlender.load(ARTIFACTS / f"m6_benter-{tag}.pkl")
    match_pairs = df_holdout[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    ).reset_index(drop=True)

    t0 = time.time()
    # Pass calculators that match this artifact's schema
    features_kwargs = dict(
        estimator=pred.lambda_estimator,
        elo_calculator=pred._get_elo(history),
        include_targets=False,
        verbose=False,
    )
    # Only pass momentum_calculator if predictor has the method (dev-03+)
    if hasattr(pred, "_get_momentum"):
        features_kwargs["momentum_calculator"] = pred._get_momentum(history)

    features = build_features_for_corpus(match_pairs, history, **features_kwargs)
    preds = pred.predict_batch(match_pairs, history)
    print(f"  Features+preds in {time.time()-t0:.1f}s")

    model = preds[["prob_h", "prob_d", "prob_a"]].values
    model = model / model.sum(axis=1, keepdims=True)
    pinn_arr = df_holdout[["psc_h", "psc_d", "psc_a"]].values
    market = np.array([remove_vig(o, method="shin") for o in pinn_arr])
    blend = np.zeros_like(model)
    for liga in df_holdout["league"].unique():
        m = df_holdout["league"].values == liga
        blend[m] = blender.blend(model[m], market[m], liga)

    y_labels = np.array([_outcome_label(h, a) for h, a in
                         zip(df_holdout["ft_goals_h"], df_holdout["ft_goals_a"])])
    brier = brier_multiclass(blend, y_labels)

    rows = []
    df_h = df_holdout.reset_index(drop=True)
    for i, row in df_h.iterrows():
        actual = _outcome_label(row["ft_goals_h"], row["ft_goals_a"])
        tier = DEFAULT_LIGA_TIERS.get(row["league"], FALLBACK_TIER)
        for outcome_idx, (label, col) in enumerate(
            [("H", "psc_h"), ("D", "psc_d"), ("A", "psc_a")]
        ):
            p = float(blend[i, outcome_idx])
            o = float(row[col])
            edge = p * o - 1.0
            won = (actual == label)
            rows.append({
                "match_idx": int(i),
                "league": row["league"],
                "tier": tier,
                "outcome": label,
                "p_blended": p,
                "decimal_odds": o,
                "edge": edge,
                "won": 1 if won else 0,
            })
    df_dec = pd.DataFrame(rows)
    return {
        "tag": tag,
        "predictor": pred,
        "features": features,
        "df_dec": df_dec,
        "brier": brier,
    }


def subgroup_metrics(sub, label):
    n = len(sub)
    if n == 0:
        return {"label": label, "n": 0}
    won = sub["won"].values
    odds = sub["decimal_odds"].values
    edge = sub["edge"].values
    p = sub["p_blended"].values
    win_rate = float(won.mean())
    wr_lo, wr_hi = _clopper_pearson(int(won.sum()), n)
    stakes = np.array([_kelly_stake(e, o) for e, o in zip(edge, odds)])
    profits = np.where(won == 1, stakes * (odds - 1.0), -stakes)
    if stakes.sum() > 0:
        roi = profits.sum() / stakes.sum()
        roi_lo, _, roi_hi = _bootstrap_roi_ci(profits, stakes)
    else:
        roi = roi_lo = roi_hi = float("nan")
    return {
        "label": label, "n": n,
        "win_rate": win_rate, "wr_lo": wr_lo, "wr_hi": wr_hi,
        "edge_avg": float(edge.mean()),
        "p_avg": float(p.mean()),
        "gap": float(p.mean() - win_rate),
        "roi": roi, "roi_lo": roi_lo, "roi_hi": roi_hi,
    }


def stage5_filter(df_dec):
    out = []
    for tier, (lo, hi) in GOLDILOCKS.items():
        sub = df_dec[(df_dec["tier"] == tier) &
                     (df_dec["edge"] >= lo) & (df_dec["edge"] <= hi)]
        out.append(sub)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def calibration_bin(sub, p_lo, p_hi):
    m = (sub["p_blended"] >= p_lo) & (sub["p_blended"] < p_hi)
    n = int(m.sum())
    if n == 0:
        return {"n": 0}
    pred = float(sub.loc[m, "p_blended"].mean())
    actual = float(sub.loc[m, "won"].mean())
    return {"n": n, "pred": pred, "actual": actual, "gap": pred - actual}


def _compute_shap_for_features(ensemble, X):
    X_aligned = X[ensemble.feature_names].copy()
    shap_sum = None
    for m in ensemble.models:
        booster = m.booster_
        contribs = booster.predict(X_aligned, pred_contrib=True)
        if shap_sum is None:
            shap_sum = contribs
        else:
            shap_sum = shap_sum + contribs
    shap_mean = shap_sum / len(ensemble.models)
    return shap_mean[:, :-1]  # drop base value column


def main():
    print("=" * 70)
    print("dev-02-elo vs dev-03 — Side-by-side Holdout Comparison")
    print("=" * 70)

    df_h = pd.read_parquet(HOLDOUT)
    df_h = df_h.rename(columns={"psch": "psc_h", "pscd": "psc_d", "psca": "psc_a"})
    df_h = df_h.dropna(subset=["psc_h", "psc_d", "psc_a", "ft_goals_h", "ft_goals_a"]).copy()
    df_h["match_date"] = pd.to_datetime(df_h["match_date"]).dt.tz_localize(None)
    print(f"  Holdout: {len(df_h):,} matches")

    history = load_team_xg_history()

    results = {}
    for tag in TAGS:
        results[tag] = run_for_tag(tag, df_h, history)

    print()
    print("=" * 80)
    print("Comparison Summary")
    print("=" * 80)

    print(f"\n  Brier (multiclass 1X2, all 2,274 matches × blended probs):")
    for tag in TAGS:
        print(f"    {tag:<12} → {results[tag]['brier']:.4f}")
    delta = results['dev-03']['brier'] - results['dev-02-elo']['brier']
    sign = "✓ better" if delta < 0 else ("✗ worse" if delta > 0 else "= same")
    print(f"    Δ (dev-03 − dev-02-elo): {delta:+.4f}  {sign}")

    print(f"\n  Subgroup metrics:")
    print(f"  {'tag':<12} {'group':<22} {'n':>5} {'win%':>7} {'ROI%':>9} {'CI lo':>9} {'CI hi':>9} {'gap':>9}")
    print("  " + "─" * 92)
    subgroup_results = {}
    for tag in TAGS:
        df_dec = results[tag]["df_dec"]
        pos = df_dec[df_dec["edge"] > 0]
        hc = pos[pos["p_blended"] >= P_THRESH]
        hc_sharp = hc[hc["tier"] == "sharp"]
        stage5 = stage5_filter(df_dec)
        subgroup_results[tag] = {
            "all_pos":   subgroup_metrics(pos, "all_pos"),
            "stage5":    subgroup_metrics(stage5, "stage5_goldilocks"),
            "high_conf": subgroup_metrics(hc, "high_conf"),
            "hc_sharp":  subgroup_metrics(hc_sharp, "hc_sharp"),
        }
        for key in ["all_pos", "stage5", "high_conf", "hc_sharp"]:
            r = subgroup_results[tag][key]
            if r["n"] == 0: continue
            print(f"  {tag:<12} {r['label']:<22} {r['n']:>5} "
                  f"{r['win_rate']*100:>6.2f}% {r['roi']*100:>+8.2f}% "
                  f"{r['roi_lo']*100:>+8.2f}% {r['roi_hi']*100:>+8.2f}% "
                  f"{r['gap']*100:>+7.2f}pp")

    print(f"\n  Calibration in [0.68, 0.72) bin (HC trap zone):")
    for tag in TAGS:
        df_dec = results[tag]["df_dec"]
        pos = df_dec[df_dec["edge"] > 0]
        cal = calibration_bin(pos, P_THRESH, 0.72)
        if cal["n"] == 0:
            print(f"    {tag:<12} → [0.68, 0.72) is empty")
        else:
            print(f"    {tag:<12} → n={cal['n']}, pred={cal['pred']:.4f}, "
                  f"actual={cal['actual']:.4f}, gap={cal['gap']*100:+.2f}pp")

    print(f"\n  SHAP on dev-03 features (HC vs LC matches):")
    res = results["dev-03"]
    features = res["features"]
    df_dec = res["df_dec"]
    max_p_match = df_dec.groupby("match_idx")["p_blended"].max()
    hc_match_idx = max_p_match[max_p_match >= P_THRESH].index.tolist()
    pred = res["predictor"]
    feat_names = list(pred.ensemble_home.feature_names)
    shap_h = _compute_shap_for_features(pred.ensemble_home, features)
    shap_a = _compute_shap_for_features(pred.ensemble_away, features)
    abs_shap = np.maximum(np.abs(shap_h), np.abs(shap_a))
    hc_mask = np.zeros(len(features), dtype=bool)
    hc_mask[hc_match_idx] = True
    lc_mask = ~hc_mask
    print(f"    HC matches: {hc_mask.sum()}, LC matches: {lc_mask.sum()}")
    print(f"\n    {'feature':<28} {'|SHAP|_HC':>10} {'|SHAP|_LC':>10} {'ratio':>8}")
    print("    " + "─" * 60)
    feat_sorted = sorted(
        [(f, abs_shap[hc_mask, j].mean() if hc_mask.sum() > 0 else 0.0,
          abs_shap[lc_mask, j].mean() if lc_mask.sum() > 0 else 0.0)
         for j, f in enumerate(feat_names)],
        key=lambda x: x[1], reverse=True
    )
    for f, hc_v, lc_v in feat_sorted:
        if lc_v > 1e-12:
            ratio_str = f"{hc_v/lc_v:.2f}"
        else:
            ratio_str = "inf"
        marker = " ← new" if f in ("lineup_quality_diff", "form_streak_diff") else ""
        print(f"    {f:<28} {hc_v:>10.4f} {lc_v:>10.4f} {ratio_str:>8}{marker}")

    print()
    return results, subgroup_results


if __name__ == "__main__":
    main()
