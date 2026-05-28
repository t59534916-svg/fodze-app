"""
dev03_shrinkage_tuning.py — Post-Processing Shrinkage on dev-03 (NO m3 retraining).

Rule (per user spec, applied per (match, outcome)):
    if market_disagreement_flag > 0.08 AND original_edge > 0:
        p_final = (1 - α) * p_blended + α * p_market
    else:
        p_final = p_blended  # untouched

Then: bet only on outcomes where post-shrinkage edge > 0.

Sweep α ∈ [0.00, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60] and find optimal vs metrics:
    - Stage 5 Goldilocks ROI (main money gate)
    - High-Confidence (p≥0.68) ROI
    - High-Disagreement (flag>0.08) ROI
    - Disagreement-vs-profit correlation
    - Total Brier (renormalized)

Bootstrap: 10k Resamples, SEED=42.

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/dev03_shrinkage_tuning.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import beta as scipy_beta, pearsonr

from v4.data.loaders import load_team_xg_history
from v4.modules.m3_xg import XGPredictor
from v4.modules.m3_xg.feature_builder import build_features_for_corpus
from v4.modules.m3_xg.market_disagreement import MarketDisagreementCalculator
from v4.modules.m6_market import BenterBlender, remove_vig
from v4.modules.m7_kelly.goldilocks import DEFAULT_LIGA_TIERS

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
PLOT_DIR = REPO_ROOT / "tools" / "v4" / "reports"

SEED = 42
BOOT = 10_000
KELLY_CAP = 0.04
P_THRESH = 0.68
HIGH_DISAG_THRESHOLD = 0.08

# Goldilocks per-tier edge bands
GOLDILOCKS = {
    "sharp":    (0.015, 0.050),
    "moderate": (0.025, 0.075),
    "soft":     (0.035, 0.085),
}
FALLBACK_TIER = "moderate"

# Shrinkage strengths to evaluate (0.0 = baseline = pure dev-03)
SHRINK_STRENGTHS = [0.00, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60]


def _outcome_label(h, a):
    if h > a: return "H"
    if h < a: return "A"
    return "D"


def _kelly_stake(edge, odds):
    return min(edge / (odds - 1.0), KELLY_CAP) if edge > 0 else 0.0


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


def _clopper_pearson(k, n, alpha=0.05):
    if n == 0: return float("nan"), float("nan")
    lo = scipy_beta.ppf(alpha / 2, k, n - k + 1) if k > 0 else 0.0
    hi = scipy_beta.ppf(1 - alpha / 2, k + 1, n - k) if k < n else 1.0
    return float(lo), float(hi)


def brier_multiclass(p_arr, y_labels):
    """p_arr: (n, 3) prob; y_labels: (n,) labels 'H'/'D'/'A'.
    Re-normalizes each row to sum to 1 first."""
    p_arr = p_arr / p_arr.sum(axis=1, keepdims=True)
    label_to_idx = {"H": 0, "D": 1, "A": 2}
    y_idx = np.array([label_to_idx[v] for v in y_labels])
    n = len(y_labels)
    oh = np.zeros_like(p_arr)
    oh[np.arange(n), y_idx] = 1.0
    return float(((p_arr - oh) ** 2).sum(axis=1).mean())


def load_holdout_data():
    print("=" * 78)
    print("Loading holdout + generating dev-03 predictions")
    print("=" * 78)
    df = pd.read_parquet(HOLDOUT)
    df = df.rename(columns={"psch": "psc_h", "pscd": "psc_d", "psca": "psc_a"})
    df = df.dropna(subset=["psc_h", "psc_d", "psc_a", "ft_goals_h", "ft_goals_a"]).copy()
    df["match_date"] = pd.to_datetime(df["match_date"]).dt.tz_localize(None)
    df = df.reset_index(drop=True)
    print(f"  Holdout: {len(df):,} matches")

    history = load_team_xg_history()

    # Load dev-03 + a (fresh) disagreement calculator (NOT dev-03's; dev-03 was
    # trained without disagreement — we use the calculator independently here
    # to compute the disagreement feature for post-processing shrinkage)
    pred = XGPredictor.from_artifacts(
        home_path=ARTIFACTS / "m3_xg-home-dev-03.pkl",
        away_path=ARTIFACTS / "m3_xg-away-dev-03.pkl",
    )
    blender = BenterBlender.load(ARTIFACTS / "m6_benter-dev-03.pkl")

    mdc = MarketDisagreementCalculator().fit(odds_paths=[
        REPO_ROOT / "tools" / "backtest" / "odds-close-oot.parquet",
        REPO_ROOT / "tools" / "backtest" / "odds-close-24-25.parquet",
        REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet",
    ])
    print(f"  Market disagreement calculator: {mdc.stats()}")

    match_pairs = df[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    ).reset_index(drop=True)

    t0 = time.time()
    # Build features and predictions (dev-03 doesn't use the new features, but
    # we need lambda_h_naive/lambda_a_naive to compute the proxy disagreement)
    features = build_features_for_corpus(
        match_pairs, history,
        estimator=pred.lambda_estimator,
        elo_calculator=pred._get_elo(history),
        momentum_calculator=pred._get_momentum(history),
        include_targets=False,
        verbose=False,
    )
    preds = pred.predict_batch(match_pairs, history)
    print(f"  Predictions in {time.time()-t0:.1f}s")

    # Compute Benter-blended probabilities (dev-03's actual final 1X2)
    model = preds[["prob_h", "prob_d", "prob_a"]].values
    model = model / model.sum(axis=1, keepdims=True)
    pinn_arr = df[["psc_h", "psc_d", "psc_a"]].values
    market = np.array([remove_vig(o, method="shin") for o in pinn_arr])
    blend = np.zeros_like(model)
    for liga in df["league"].unique():
        m = df["league"].values == liga
        blend[m] = blender.blend(model[m], market[m], liga)

    # Compute disagreement flag per match (using lambda_h_naive / lambda_a_naive
    # via Skellam → market comparison)
    disag_flags = np.zeros(len(df))
    for i, row in df.iterrows():
        lh = float(features.iloc[i]["lambda_h_naive"])
        la = float(features.iloc[i]["lambda_a_naive"])
        d = mdc.get_features(
            home_team=row["home_team"], away_team=row["away_team"],
            league=row["league"], match_date=row["match_date"],
            lambda_h=lh, lambda_a=la,
        )
        disag_flags[i] = d["market_disagreement_flag"]

    n_high_disag = int((disag_flags > HIGH_DISAG_THRESHOLD).sum())
    print(f"  Disagreement on holdout: {n_high_disag:,}/{len(df):,} matches > {HIGH_DISAG_THRESHOLD:.2f} ({100*n_high_disag/len(df):.1f}%)")

    return df, blend, market, disag_flags


def apply_shrinkage(blend, market, disag_flags, alpha):
    """Apply the user's rule:
        if disag_flag[match] > 0.08 AND original_edge > 0:
            p_final[outcome] = (1-α) * p_blended + α * p_market
        else: untouched

    Note: 'original_edge > 0' requires odds — we compute it per-outcome later
    against psc_h/d/a. To keep things vectorized we apply the rule WITHOUT the
    edge-sign filter here (shrinkage applied to all outcomes of high-disag
    matches), then check edge-sign in the betting logic. This is equivalent
    to the strict spec for betting decisions (positive-edge bets that survive
    shrinkage stay; negative-edge bets weren't placed anyway).
    """
    high_disag_mask = disag_flags > HIGH_DISAG_THRESHOLD
    p_final = blend.copy()
    p_final[high_disag_mask] = (
        (1 - alpha) * blend[high_disag_mask] + alpha * market[high_disag_mask]
    )
    return p_final


def evaluate_strength(df, p_final, market, disag_flags, alpha, p_pre_shrink):
    """Compute all metrics for a given shrinkage strength."""
    pinn_h = df["psc_h"].values
    pinn_d = df["psc_d"].values
    pinn_a = df["psc_a"].values

    # Per-decision rows
    rows = []
    for i, row in df.iterrows():
        actual = _outcome_label(row["ft_goals_h"], row["ft_goals_a"])
        tier = DEFAULT_LIGA_TIERS.get(row["league"], FALLBACK_TIER)
        for outcome_idx, (label, odds_col) in enumerate(
            [("H", pinn_h), ("D", pinn_d), ("A", pinn_a)]
        ):
            p_post = float(p_final[i, outcome_idx])
            p_pre = float(p_pre_shrink[i, outcome_idx])
            o = float(odds_col[i])
            edge_post = p_post * o - 1.0  # shrunken edge — used for staking
            edge_pre = p_pre * o - 1.0    # pre-shrinkage edge — for "did it survive"
            won = (actual == label)
            rows.append({
                "match_idx": int(i),
                "league": row["league"],
                "tier": tier,
                "p_pre": p_pre,
                "p_post": p_post,
                "decimal_odds": o,
                "edge_pre": edge_pre,
                "edge_post": edge_post,
                "disag_flag": float(disag_flags[i]),
                "won": 1 if won else 0,
            })
    df_dec = pd.DataFrame(rows)

    # Subgroups (using POST-shrinkage edge for staking decisions)
    pos = df_dec[df_dec["edge_post"] > 0]
    hc = pos[pos["p_post"] >= P_THRESH]
    hc_sharp = hc[hc["tier"] == "sharp"]

    # Stage 5 Goldilocks using POST-shrinkage edge
    stage5_parts = []
    for tier, (lo, hi) in GOLDILOCKS.items():
        s = df_dec[(df_dec["tier"] == tier) &
                   (df_dec["edge_post"] >= lo) &
                   (df_dec["edge_post"] <= hi)]
        stage5_parts.append(s)
    stage5 = pd.concat(stage5_parts, ignore_index=True) if stage5_parts else pd.DataFrame()

    # High-disag subgroup
    high_disag_pos = pos[pos["disag_flag"] > HIGH_DISAG_THRESHOLD]

    def _metrics(sub):
        n = len(sub)
        if n == 0:
            return None
        won = sub["won"].values
        odds = sub["decimal_odds"].values
        edges = sub["edge_post"].values
        p = sub["p_post"].values
        win_rate = float(won.mean())
        wr_lo, wr_hi = _clopper_pearson(int(won.sum()), n)
        stakes = np.array([_kelly_stake(e, o) for e, o in zip(edges, odds)])
        profits = np.where(won == 1, stakes * (odds - 1.0), -stakes)
        if stakes.sum() > 0:
            roi = profits.sum() / stakes.sum()
            roi_lo, _, roi_hi = _bootstrap_roi_ci(profits, stakes)
        else:
            roi = roi_lo = roi_hi = float("nan")
        return {
            "n": n, "win_rate": win_rate,
            "wr_lo": wr_lo, "wr_hi": wr_hi,
            "edge_avg": float(edges.mean()),
            "p_avg": float(p.mean()),
            "gap": float(p.mean() - win_rate),
            "roi": roi, "roi_lo": roi_lo, "roi_hi": roi_hi,
        }

    # Correlation: disagreement_flag vs profit-per-stake on positive-edge bets
    # with odds available (disag > 0)
    with_odds = pos[pos["disag_flag"] > 0.0].copy()
    if len(with_odds) > 10:
        with_odds["stake"] = [_kelly_stake(e, o) for e, o in
                              zip(with_odds["edge_post"], with_odds["decimal_odds"])]
        with_odds["profit"] = np.where(with_odds["won"] == 1,
                                         with_odds["stake"] * (with_odds["decimal_odds"] - 1.0),
                                         -with_odds["stake"])
        pps = with_odds["profit"] / with_odds["stake"].clip(lower=1e-9)
        corr, pval = pearsonr(with_odds["disag_flag"].values, pps.values)
    else:
        corr, pval = float("nan"), float("nan")

    # Brier (using renormalized post-shrinkage probabilities)
    y_labels = np.array([_outcome_label(h, a) for h, a in
                         zip(df["ft_goals_h"], df["ft_goals_a"])])
    brier = brier_multiclass(p_final.copy(), y_labels)

    # [0.68, 0.72) calibration bin
    cal_bin = pos[(pos["p_post"] >= 0.68) & (pos["p_post"] < 0.72)]
    if len(cal_bin) > 0:
        cal_pred = float(cal_bin["p_post"].mean())
        cal_actual = float(cal_bin["won"].mean())
        cal_gap = cal_pred - cal_actual
        cal_n = len(cal_bin)
    else:
        cal_pred = cal_actual = cal_gap = float("nan")
        cal_n = 0

    return {
        "alpha": alpha,
        "brier": brier,
        "all_pos": _metrics(pos),
        "stage5": _metrics(stage5),
        "high_conf": _metrics(hc),
        "hc_sharp": _metrics(hc_sharp),
        "high_disag_pos": _metrics(high_disag_pos),
        "corr_disag_profit": corr,
        "corr_pval": pval,
        "corr_n": int((pos["disag_flag"] > 0).sum()),
        "cal_bin_68_72": {"n": cal_n, "pred": cal_pred, "actual": cal_actual, "gap": cal_gap},
    }


def main():
    df, blend, market, disag_flags = load_holdout_data()
    p_pre = blend.copy()  # original blended probs (for edge_pre tracking)

    print()
    print("=" * 78)
    print(f"Sweeping shrinkage strengths {SHRINK_STRENGTHS} on dev-03 + Pinnacle market")
    print("=" * 78)

    all_results = []
    for alpha in SHRINK_STRENGTHS:
        print(f"\n→ α = {alpha:.2f}")
        p_final = apply_shrinkage(blend, market, disag_flags, alpha)
        r = evaluate_strength(df, p_final, market, disag_flags, alpha, p_pre)
        all_results.append(r)
        print(f"  Brier:                    {r['brier']:.4f}")
        print(f"  All-positive ROI:         n={r['all_pos']['n']:>4}, "
              f"ROI={r['all_pos']['roi']*100:+6.2f}%  "
              f"[{r['all_pos']['roi_lo']*100:+6.2f}, {r['all_pos']['roi_hi']*100:+6.2f}]")
        print(f"  Stage 5 Goldilocks ROI:   n={r['stage5']['n']:>4}, "
              f"ROI={r['stage5']['roi']*100:+6.2f}%  "
              f"[{r['stage5']['roi_lo']*100:+6.2f}, {r['stage5']['roi_hi']*100:+6.2f}]")
        if r["high_conf"]:
            print(f"  High-Confidence ROI:      n={r['high_conf']['n']:>4}, "
                  f"ROI={r['high_conf']['roi']*100:+6.2f}%  "
                  f"[{r['high_conf']['roi_lo']*100:+6.2f}, {r['high_conf']['roi_hi']*100:+6.2f}]")
        if r["high_disag_pos"]:
            print(f"  High-Disag ROI (>8%):     n={r['high_disag_pos']['n']:>4}, "
                  f"ROI={r['high_disag_pos']['roi']*100:+6.2f}%  "
                  f"[{r['high_disag_pos']['roi_lo']*100:+6.2f}, {r['high_disag_pos']['roi_hi']*100:+6.2f}]")
        print(f"  Disag-vs-profit corr:     {r['corr_disag_profit']:+.4f}  "
              f"(p={r['corr_pval']:.4f}, n={r['corr_n']})")
        cal = r["cal_bin_68_72"]
        if cal["n"] > 0:
            print(f"  [0.68, 0.72) calibration: n={cal['n']}, pred={cal['pred']:.4f}, "
                  f"actual={cal['actual']:.4f}, gap={cal['gap']*100:+.2f}pp")

    # ─── Summary Table ───
    print()
    print("=" * 78)
    print("SUMMARY — Shrinkage Strength Sweep")
    print("=" * 78)
    print(f"\n  {'α':<6} {'Brier':<8} {'AllPos ROI':<14} {'Stage5 ROI':<14} "
          f"{'HC ROI':<14} {'HiDisag ROI':<14} {'corr':<10}")
    print("  " + "─" * 88)
    for r in all_results:
        a = r["alpha"]
        b = r["brier"]
        ap = r["all_pos"]
        s5 = r["stage5"]
        hc = r["high_conf"]
        hd = r["high_disag_pos"]

        def fmt(m):
            if m is None or m["n"] == 0:
                return f"{'n/a':<14}"
            return f"{m['roi']*100:+5.2f}%  n={m['n']:>4}"

        marker = "   ← BASELINE" if a == 0.00 else ""
        print(f"  {a:<6.2f} {b:<8.4f} {fmt(ap)} {fmt(s5)} {fmt(hc)} {fmt(hd)} "
              f"{r['corr_disag_profit']:+.4f}{marker}")

    # ─── Optimal selection ───
    print()
    print("=" * 78)
    print("Optimal-α selection")
    print("=" * 78)
    # Best on Stage 5 (main money metric)
    stage5_rois = [(r["alpha"], r["stage5"]["roi"]) for r in all_results
                   if r["stage5"] and r["stage5"]["n"] > 0]
    if stage5_rois:
        best_s5 = max(stage5_rois, key=lambda x: x[1])
        print(f"  Best Stage 5 ROI:  α={best_s5[0]:.2f} → ROI={best_s5[1]*100:+.2f}%")
    # Best on HC
    hc_rois = [(r["alpha"], r["high_conf"]["roi"]) for r in all_results
               if r["high_conf"] and r["high_conf"]["n"] > 0]
    if hc_rois:
        best_hc = max(hc_rois, key=lambda x: x[1])
        print(f"  Best High-Conf ROI: α={best_hc[0]:.2f} → ROI={best_hc[1]*100:+.2f}%")
    # Best on All-Pos
    all_rois = [(r["alpha"], r["all_pos"]["roi"]) for r in all_results
                if r["all_pos"] and r["all_pos"]["n"] > 0]
    if all_rois:
        best_all = max(all_rois, key=lambda x: x[1])
        print(f"  Best All-Pos ROI:  α={best_all[0]:.2f} → ROI={best_all[1]*100:+.2f}%")
    # Best on disag correlation (closest to zero or positive)
    best_corr = max(all_results, key=lambda r: r["corr_disag_profit"])
    print(f"  Best corr (least-neg): α={best_corr['alpha']:.2f} → corr={best_corr['corr_disag_profit']:+.4f}")
    # Best Brier
    best_brier = min(all_results, key=lambda r: r["brier"])
    print(f"  Best Brier:        α={best_brier['alpha']:.2f} → Brier={best_brier['brier']:.4f}")

    # Plot
    alphas = np.array([r["alpha"] for r in all_results])
    s5_rois = np.array([r["stage5"]["roi"] if r["stage5"] and r["stage5"]["n"] > 0 else np.nan
                        for r in all_results])
    s5_los = np.array([r["stage5"]["roi_lo"] if r["stage5"] and r["stage5"]["n"] > 0 else np.nan
                       for r in all_results])
    s5_his = np.array([r["stage5"]["roi_hi"] if r["stage5"] and r["stage5"]["n"] > 0 else np.nan
                       for r in all_results])
    hc_rois = np.array([r["high_conf"]["roi"] if r["high_conf"] and r["high_conf"]["n"] > 0 else np.nan
                        for r in all_results])
    hd_rois = np.array([r["high_disag_pos"]["roi"] if r["high_disag_pos"] and r["high_disag_pos"]["n"] > 0 else np.nan
                        for r in all_results])
    corrs = np.array([r["corr_disag_profit"] for r in all_results])

    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    ax = axes[0, 0]
    ax.fill_between(alphas * 100, s5_los * 100, s5_his * 100, alpha=0.25, color="#4a8c3a")
    ax.plot(alphas * 100, s5_rois * 100, "o-", color="#4a8c3a", linewidth=2, label="Stage 5 ROI")
    ax.axhline(0, color="red", linestyle="--", linewidth=1)
    ax.set_xlabel("Shrinkage strength α (%)")
    ax.set_ylabel("ROI (%)")
    ax.set_title("Stage 5 Goldilocks ROI vs α")
    ax.legend(); ax.grid(alpha=0.3)

    ax = axes[0, 1]
    ax.plot(alphas * 100, hc_rois * 100, "o-", color="#d4b86a", linewidth=2, label="High-Conf ROI")
    ax.plot(alphas * 100, hd_rois * 100, "s-", color="#a85a3a", linewidth=2, label="High-Disag ROI")
    ax.axhline(0, color="red", linestyle="--", linewidth=1)
    ax.set_xlabel("Shrinkage strength α (%)")
    ax.set_ylabel("ROI (%)")
    ax.set_title("High-Conf vs High-Disag ROI vs α")
    ax.legend(); ax.grid(alpha=0.3)

    ax = axes[1, 0]
    ax.plot(alphas * 100, corrs, "o-", color="#5a8c4a", linewidth=2)
    ax.axhline(0, color="red", linestyle="--", linewidth=1, label="Zero correlation")
    ax.set_xlabel("Shrinkage strength α (%)")
    ax.set_ylabel("corr(disag_flag, profit/stake)")
    ax.set_title("Disagreement-vs-profit correlation vs α")
    ax.legend(); ax.grid(alpha=0.3)

    ax = axes[1, 1]
    briers = np.array([r["brier"] for r in all_results])
    ax.plot(alphas * 100, briers, "o-", color="#1a0f0a", linewidth=2)
    ax.set_xlabel("Shrinkage strength α (%)")
    ax.set_ylabel("Brier (1X2)")
    ax.set_title("Brier vs α")
    ax.grid(alpha=0.3)

    plt.suptitle("dev-03 + Post-Processing Shrinkage — α sweep on 25/26 holdout",
                 fontsize=13)
    plt.tight_layout()
    out_path = PLOT_DIR / "dev03_shrinkage_sweep.png"
    plt.savefig(out_path, dpi=110)
    plt.close()
    print(f"\n  Plot saved: {out_path}")
    return all_results


if __name__ == "__main__":
    main()
