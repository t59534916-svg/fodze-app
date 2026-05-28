"""
high_confidence_feature_diagnostic.py
=====================================
Kombinierte High-Confidence + Feature-Diagnose auf v4 dev-02-elo Holdout.

Definitionen (parallel):
  - High-Confidence: p_blended ≥ 0.68
  - High-Edge:       edge_pinnacle ≥ 3.5%
  - High-Conf + Sharp: p_blended ≥ 0.68 UND tier="sharp"

Output: TEIL A (Tabelle), TEIL B (Edge-vs-ROI plot + crossover), TEIL C (Feature),
        TEIL D (max-5-Satz Empfehlung).

Bootstrap: 10.000 Resamples, SEED=42 — same as bet365_analysis.py.

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/high_confidence_feature_diagnostic.py
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
from v4.modules.m3_xg.feature_builder import (
    NUMERIC_FEATURES,
    build_features_for_corpus,
)
from v4.modules.m6_market import BenterBlender, remove_vig
from v4.modules.m7_kelly.goldilocks import DEFAULT_LIGA_TIERS

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
PLOT_DIR = REPO_ROOT / "tools" / "v4" / "reports"
PLOT_DIR.mkdir(parents=True, exist_ok=True)

SEED = 42
BOOT = 10_000
KELLY_CAP = 0.04

P_THRESH = 0.68         # High-Confidence
EDGE_THRESH = 0.035     # High-Edge
LOWPOWER_N = 80         # warn if subgroup has fewer than this


# ─────────────────────────────────────────────────────────────────────────
# Stats helpers (same conventions as bet365_analysis.py)
# ─────────────────────────────────────────────────────────────────────────

def _outcome_label(h: float, a: float) -> str:
    if h > a: return "H"
    if h < a: return "A"
    return "D"


def _clopper_pearson(k: int, n: int, alpha: float = 0.05) -> Tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    lo = scipy_beta.ppf(alpha / 2, k, n - k + 1) if k > 0 else 0.0
    hi = scipy_beta.ppf(1 - alpha / 2, k + 1, n - k) if k < n else 1.0
    return float(lo), float(hi)


def _bootstrap_roi_ci(profits: np.ndarray, stakes: np.ndarray,
                      n_boot: int = BOOT, seed: int = SEED) -> Tuple[float, float, float]:
    if len(profits) == 0:
        return (float("nan"), float("nan"), float("nan"))
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


def _kelly_stake(edge: float, odds: float) -> float:
    return min(edge / (odds - 1.0), KELLY_CAP) if edge > 0 else 0.0


# ─────────────────────────────────────────────────────────────────────────
# Step 1 — Load holdout + predict
# ─────────────────────────────────────────────────────────────────────────

def load_holdout() -> pd.DataFrame:
    print("=" * 78)
    print("Step 1 — Load holdout odds-close-25-26.parquet")
    print("=" * 78)
    df = pd.read_parquet(HOLDOUT)
    # Holdout uses psch/pscd/psca (no underscore). Rename to psc_h/d/a for consistency.
    df = df.rename(columns={"psch": "psc_h", "pscd": "psc_d", "psca": "psc_a"})
    print(f"  Holdout rows: {len(df):,}")
    print(f"  Columns (after rename): {list(df.columns)[:14]}")
    print(f"  Leagues: {df['league'].nunique()}  Date range: "
          f"{df['match_date'].min()} → {df['match_date'].max()}")
    # Filter to rows that have closing odds and outcomes
    need = ["psc_h", "psc_d", "psc_a", "ft_goals_h", "ft_goals_a"]
    df = df.dropna(subset=need).copy()
    df["match_date"] = pd.to_datetime(df["match_date"]).dt.tz_localize(None)
    print(f"  After dropna({need}): {len(df):,}")
    return df


def build_predictions_df(df_holdout: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Run v4 dev-02-elo on holdout. Also keep per-match features for SHAP."""
    print()
    print("=" * 78)
    print("Step 2 — Generate v4 dev-02-elo predictions on holdout")
    print("=" * 78)
    pred = XGPredictor.from_artifacts(
        home_path=ARTIFACTS / "m3_xg-home-dev-02-elo.pkl",
        away_path=ARTIFACTS / "m3_xg-away-dev-02-elo.pkl",
    )
    blender = BenterBlender.load(ARTIFACTS / "m6_benter-dev-02-elo.pkl")
    history = load_team_xg_history()

    match_pairs = df_holdout[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    ).reset_index(drop=True)

    # Build features separately so we can do SHAP later
    print("  Building features (for SHAP) ...")
    t0 = time.time()
    features = build_features_for_corpus(
        match_pairs, history,
        estimator=pred.lambda_estimator,
        elo_calculator=pred._get_elo(history),
        include_targets=False,
        verbose=False,
    )
    print(f"  Features built in {time.time()-t0:.1f}s — shape {features.shape}")

    # Predictions
    t0 = time.time()
    preds = pred.predict_batch(match_pairs, history)
    print(f"  Predictions in {time.time()-t0:.1f}s")

    # Benter blend per league
    model = preds[["prob_h", "prob_d", "prob_a"]].values
    model = model / model.sum(axis=1, keepdims=True)
    pinn_arr = df_holdout[["psc_h", "psc_d", "psc_a"]].values
    market_pinn = np.array([remove_vig(o, method="shin") for o in pinn_arr])

    blend = np.zeros_like(model)
    for liga in df_holdout["league"].unique():
        m = df_holdout["league"].values == liga
        blend[m] = blender.blend(model[m], market_pinn[m], liga)

    # Per-(match, outcome) decision rows
    rows = []
    df_holdout = df_holdout.reset_index(drop=True)
    for i, row in df_holdout.iterrows():
        actual = _outcome_label(row["ft_goals_h"], row["ft_goals_a"])
        tier = DEFAULT_LIGA_TIERS.get(row["league"], "moderate")
        for outcome_idx, (label, psc_col) in enumerate([
            ("H", "psc_h"), ("D", "psc_d"), ("A", "psc_a"),
        ]):
            p = float(blend[i, outcome_idx])
            o = float(row[psc_col])
            p_mk = float(market_pinn[i, outcome_idx])
            won = (actual == label)
            edge = p * o - 1.0
            rows.append({
                "match_idx": int(i),
                "match_date": row["match_date"],
                "league": row["league"],
                "tier": tier,
                "outcome_label": label,
                "p_blended": p,
                "decimal_odds": o,
                "p_implied": p_mk,
                "edge": edge,
                "won": 1 if won else 0,
            })
    df_dec = pd.DataFrame(rows)
    print(f"  Decisions: {len(df_dec):,}  (matches × 3 outcomes)")
    return df_dec, features


# ─────────────────────────────────────────────────────────────────────────
# TEIL A — Performance table
# ─────────────────────────────────────────────────────────────────────────

def _subgroup_stats(sub: pd.DataFrame, name: str) -> Dict:
    n = len(sub)
    if n == 0:
        return {"name": name, "n": 0}
    won = sub["won"].values
    odds = sub["decimal_odds"].values
    edge = sub["edge"].values
    p = sub["p_blended"].values
    win_rate = won.mean()
    wr_lo, wr_hi = _clopper_pearson(int(won.sum()), n)
    stakes = np.array([_kelly_stake(e, o) for e, o in zip(edge, odds)])
    profits = np.where(won == 1, stakes * (odds - 1.0), -stakes)
    if stakes.sum() > 0:
        roi_point = profits.sum() / stakes.sum()
        roi_ci_lo, roi_ci_med, roi_ci_hi = _bootstrap_roi_ci(profits, stakes)
    else:
        roi_point = float("nan")
        roi_ci_lo = roi_ci_med = roi_ci_hi = float("nan")
    return {
        "name": name,
        "n": n,
        "win_rate": float(win_rate),
        "wr_lo": float(wr_lo), "wr_hi": float(wr_hi),
        "edge_avg": float(edge.mean()),
        "p_avg": float(p.mean()),
        "gap": float(p.mean() - win_rate),
        "roi": float(roi_point),
        "roi_lo": float(roi_ci_lo),
        "roi_hi": float(roi_ci_hi),
        "stakes_sum": float(stakes.sum()),
    }


def teil_a_performance_table(df_dec: pd.DataFrame) -> List[Dict]:
    print()
    print("=" * 78)
    print("TEIL A — High-Confidence Performance Table")
    print("=" * 78)

    # Baseline = all positive-edge decisions (consistent with bet365_analysis.py)
    pos = df_dec[df_dec["edge"] > 0].copy()

    subgroups = [
        ("Baseline (alle pos-edge)", pos),
        (f"High-Confidence (p ≥ {P_THRESH:.2f})", pos[pos["p_blended"] >= P_THRESH]),
        (f"High-Edge (edge ≥ {EDGE_THRESH*100:.1f}%)",
            pos[pos["edge"] >= EDGE_THRESH]),
        (f"High-Conf + Sharp (p ≥ {P_THRESH:.2f} & tier=sharp)",
            pos[(pos["p_blended"] >= P_THRESH) & (pos["tier"] == "sharp")]),
    ]

    results = []
    for name, sub in subgroups:
        r = _subgroup_stats(sub, name)
        results.append(r)

    # Print table
    print()
    hdr = f"  {'Gruppe':<48} {'n':>5} {'Win%':>8} {'(CI95)':>17}  {'Edge%':>7} {'p_avg':>7} {'Gap':>7} {'ROI%':>8} {'ROI CI95':>22}"
    print(hdr)
    print("  " + "─" * (len(hdr) - 2))
    for r in results:
        if r["n"] == 0:
            print(f"  {r['name']:<48} {0:>5}  [no data]")
            continue
        ci_str = f"[{r['wr_lo']*100:.1f}, {r['wr_hi']*100:.1f}]"
        roi_ci = f"[{r['roi_lo']*100:+.2f}, {r['roi_hi']*100:+.2f}]"
        warn = "  ⚠ low-power" if r["n"] < LOWPOWER_N else ""
        print(f"  {r['name']:<48} {r['n']:>5}  {r['win_rate']*100:>6.2f}% {ci_str:>17}  "
              f"{r['edge_avg']*100:>6.2f}% {r['p_avg']*100:>6.2f}% {r['gap']*100:>+6.2f}  "
              f"{r['roi']*100:>+7.2f}% {roi_ci:>22}{warn}")
    return results


# ─────────────────────────────────────────────────────────────────────────
# TEIL B — Edge vs ROI on High-Confidence only
# ─────────────────────────────────────────────────────────────────────────

def teil_b_edge_roi_highconf(df_dec: pd.DataFrame) -> Dict:
    print()
    print("=" * 78)
    print("TEIL B — Edge vs ROI auf High-Confidence (p ≥ 0.68)")
    print("=" * 78)
    sub = df_dec[(df_dec["edge"] > 0) & (df_dec["p_blended"] >= P_THRESH)].copy()
    n_hc = len(sub)
    print(f"  n positive-edge & high-conf: {n_hc}")
    if n_hc == 0:
        print("  → empty subgroup; skipping plot")
        return {"n": 0}

    edges = sub["edge"].values
    odds = sub["decimal_odds"].values
    won = sub["won"].values
    stakes = np.array([_kelly_stake(e, o) for e, o in zip(edges, odds)])
    profits = np.where(won == 1, stakes * (odds - 1.0), -stakes)

    # High-conf has only n≈56 → use 1%-wide bins to keep at least 3-5 per bin
    bin_edges = np.arange(0.0, 0.25, 0.01)
    bin_centers = bin_edges[:-1] + 0.005
    point_roi = np.full(len(bin_centers), np.nan)
    ci_lo = np.full(len(bin_centers), np.nan)
    ci_hi = np.full(len(bin_centers), np.nan)
    bin_n = np.zeros(len(bin_centers), dtype=int)

    for i in range(len(bin_centers)):
        mask = (edges >= bin_edges[i]) & (edges < bin_edges[i + 1])
        bin_n[i] = int(mask.sum())
        if bin_n[i] < 3:
            continue
        s = stakes[mask]
        p = profits[mask]
        if s.sum() == 0:
            continue
        point_roi[i] = p.sum() / s.sum()
        ci_lo[i], _, ci_hi[i] = _bootstrap_roi_ci(p, s)

    crossover = float("nan")
    for i in range(len(bin_centers)):
        if not np.isnan(ci_lo[i]) and ci_lo[i] < 0:
            crossover = float(bin_centers[i])
            break

    print(f"\n  Edge bins (high-conf only, 1%-wide):")
    print(f"  {'edge_center':>12}  {'n':>4}  {'roi%':>7}  {'ci_lo%':>8}  {'ci_hi%':>8}")
    for i, c in enumerate(bin_centers):
        if bin_n[i] < 3: continue
        ci_lo_str = "n/a" if np.isnan(ci_lo[i]) else f"{ci_lo[i]*100:+8.2f}"
        ci_hi_str = "n/a" if np.isnan(ci_hi[i]) else f"{ci_hi[i]*100:+8.2f}"
        roi_str = "n/a" if np.isnan(point_roi[i]) else f"{point_roi[i]*100:+7.2f}"
        print(f"  {c*100:>+12.2f}  {bin_n[i]:>4}  {roi_str}  {ci_lo_str}  {ci_hi_str}")
    print(f"\n  Crossover (lower CI first negative) on high-conf: "
          f"{crossover*100 if not np.isnan(crossover) else float('nan'):+.2f}%")

    # Plot
    fig, ax = plt.subplots(figsize=(11, 6))
    valid = ~np.isnan(point_roi)
    ax.fill_between(bin_centers[valid] * 100, ci_lo[valid] * 100, ci_hi[valid] * 100,
                    alpha=0.25, color="#4a8c3a", label="95% Bootstrap CI")
    ax.plot(bin_centers[valid] * 100, point_roi[valid] * 100, "o-",
            color="#4a8c3a", linewidth=2, label="ROI point estimate")
    ax.axhline(0, color="red", linestyle="--", linewidth=1, label="Break-even")
    if not np.isnan(crossover):
        ax.axvline(crossover * 100, color="orange", linestyle=":", linewidth=1.5,
                   label=f"Crossover {crossover*100:+.2f}%")
    ax.set_xlabel("Edge bin center (%)")
    ax.set_ylabel("Realized ROI (%)")
    ax.set_title(f"v4 dev-02-elo: Edge vs ROI on High-Confidence subset (p ≥ {P_THRESH:.2f}, n={n_hc})")
    ax.legend(loc="lower right")
    ax.grid(alpha=0.3)
    out_path = PLOT_DIR / "highconf_edge_roi.png"
    plt.tight_layout()
    plt.savefig(out_path, dpi=110)
    plt.close()
    print(f"\n  Plot saved: {out_path}")

    return {"n": n_hc, "crossover": crossover, "bin_centers": bin_centers,
            "point_roi": point_roi, "ci_lo": ci_lo, "ci_hi": ci_hi, "bin_n": bin_n}


# ─────────────────────────────────────────────────────────────────────────
# TEIL C — Feature insights via SHAP on m3_xg LightGBM ensemble
# ─────────────────────────────────────────────────────────────────────────

def _compute_shap(ensemble, X: pd.DataFrame) -> np.ndarray:
    """Mean per-model SHAP across all 5 ensemble members.
    Returns array of shape (n_samples, n_features) — one row per match,
    one column per feature (in NUMERIC_FEATURES + categorical-encoded order).
    """
    X_aligned = X[ensemble.feature_names].copy()
    shap_sum = None
    for m in ensemble.models:
        # LightGBM pred_contrib: returns (n_samples, n_features + 1) — last column is base value
        booster = m.booster_
        contribs = booster.predict(X_aligned, pred_contrib=True)
        if shap_sum is None:
            shap_sum = contribs
        else:
            shap_sum = shap_sum + contribs
    return shap_sum / len(ensemble.models)


def teil_c_feature_insights(df_dec: pd.DataFrame, features: pd.DataFrame) -> Dict:
    print()
    print("=" * 78)
    print("TEIL C — Feature-Insights auf High-Confidence (SHAP basiert)")
    print("=" * 78)

    pred = XGPredictor.from_artifacts(
        home_path=ARTIFACTS / "m3_xg-home-dev-02-elo.pkl",
        away_path=ARTIFACTS / "m3_xg-away-dev-02-elo.pkl",
    )

    feature_names_used = list(pred.ensemble_home.feature_names)
    print(f"  Features in model: {len(feature_names_used)} → {feature_names_used}")

    # Compute SHAP per-match for both home & away targets
    print("  Computing SHAP values (avg across 5 ensemble members × 2 targets) ...")
    t0 = time.time()
    shap_h = _compute_shap(pred.ensemble_home, features)
    shap_a = _compute_shap(pred.ensemble_away, features)
    print(f"  Done in {time.time()-t0:.1f}s — shape home {shap_h.shape}, away {shap_a.shape}")

    # |SHAP| at match level (drop bias column)
    # Combine home + away contributions per feature: max(|h|, |a|) captures
    # max influence on either λ
    abs_shap = np.maximum(np.abs(shap_h[:, :len(feature_names_used)]),
                          np.abs(shap_a[:, :len(feature_names_used)]))

    # Per-match: is this match a "high-conf match"? = any of its 3 outcomes has p≥0.68
    # OR alternative: avg of max p over outcomes per match
    max_p_per_match = df_dec.groupby("match_idx")["p_blended"].max().to_dict()
    is_highconf_match = np.array([
        max_p_per_match.get(i, 0.0) >= P_THRESH for i in range(len(features))
    ])
    n_hc = int(is_highconf_match.sum())
    n_lc = int((~is_highconf_match).sum())
    print(f"\n  High-conf matches: {n_hc} (with any p≥{P_THRESH:.2f})")
    print(f"  Low-conf matches:  {n_lc}")
    if n_hc < LOWPOWER_N:
        print(f"  ⚠ LOW STATISTICAL POWER: high-conf subgroup has n={n_hc} < {LOWPOWER_N}")

    # Mean |SHAP| per feature on each subset + Δ
    rows = []
    for j, fname in enumerate(feature_names_used):
        mean_hc = float(abs_shap[is_highconf_match, j].mean()) if n_hc > 0 else float("nan")
        mean_lc = float(abs_shap[~is_highconf_match, j].mean()) if n_lc > 0 else float("nan")
        # Mean feature value on each subset (distribution shift) — numeric only
        mu_hc = mu_lc = float("nan")
        if fname in features.columns:
            try:
                x = pd.to_numeric(features[fname], errors="coerce").values
                if np.isfinite(x).any():
                    mu_hc = float(np.nanmean(x[is_highconf_match])) if n_hc > 0 else float("nan")
                    mu_lc = float(np.nanmean(x[~is_highconf_match])) if n_lc > 0 else float("nan")
            except (TypeError, ValueError):
                pass
        # Correlation with prediction error on each subset (per-outcome view)
        # For each decision row, look up |SHAP| at its match's row j (home shap for H+D, away for A)
        # Simplification: use abs_shap regardless of outcome
        # Compute corr(residual, abs_shap) on each subset of DECISIONS
        # residual = won - p_blended
        rows.append({
            "feature": fname,
            "mean_abs_shap_hc": mean_hc,
            "mean_abs_shap_lc": mean_lc,
            "delta_shap_hc_minus_lc": mean_hc - mean_lc,
            "shap_ratio_hc_over_lc": (mean_hc / mean_lc) if mean_lc > 1e-12 else float("nan"),
            "mean_value_hc": mu_hc,
            "mean_value_lc": mu_lc,
        })
    feat_df = pd.DataFrame(rows).sort_values("mean_abs_shap_hc", ascending=False)

    print("\n  Feature explanatory power (|SHAP| → λ predictions):")
    print(f"  {'feature':<28} {'|SHAP|_HC':>10} {'|SHAP|_LC':>10} {'Δ_HC-LC':>10} "
          f"{'ratio':>8} {'val_HC':>10} {'val_LC':>10}")
    print("  " + "─" * 92)
    for _, r in feat_df.iterrows():
        ratio = "n/a" if np.isnan(r["shap_ratio_hc_over_lc"]) else f"{r['shap_ratio_hc_over_lc']:.2f}"
        print(f"  {r['feature']:<28} {r['mean_abs_shap_hc']:>10.4f} "
              f"{r['mean_abs_shap_lc']:>10.4f} {r['delta_shap_hc_minus_lc']:>+10.4f} "
              f"{ratio:>8} {r['mean_value_hc']:>10.3f} {r['mean_value_lc']:>10.3f}")

    # Specifically check the user-requested features
    print(f"\n  Spotlight on user-requested features:")
    spotlight = ["elo_diff", "home_attack_ratio", "home_defense_ratio",
                 "away_attack_ratio", "away_defense_ratio", "league_home_advantage"]
    for f in spotlight:
        match = feat_df[feat_df["feature"] == f]
        if len(match) == 0:
            print(f"    {f:<28} → NOT FOUND in feature set")
            continue
        r = match.iloc[0]
        print(f"    {f:<28} |SHAP|_HC={r['mean_abs_shap_hc']:.4f}  "
              f"|SHAP|_LC={r['mean_abs_shap_lc']:.4f}  "
              f"Δ={r['delta_shap_hc_minus_lc']:+.4f}  "
              f"ratio={r['shap_ratio_hc_over_lc']:.2f}")

    # Residual analysis at decision level
    print(f"\n  Feature ↔ prediction-error correlation (decision-level, n_hc_dec):")
    pos = df_dec[df_dec["edge"] > 0].copy()
    pos["residual"] = pos["won"] - pos["p_blended"]
    # Map each decision to its match index's feature values
    pos = pos.merge(
        features[feature_names_used].reset_index().rename(columns={"index": "match_idx"}),
        on="match_idx", how="left"
    )
    hc_dec = pos[pos["p_blended"] >= P_THRESH]
    lc_dec = pos[pos["p_blended"] < P_THRESH]
    print(f"  HC decisions n={len(hc_dec)}, LC decisions n={len(lc_dec)}")

    corr_rows = []
    for f in feature_names_used:
        if f not in pos.columns:
            continue
        if len(hc_dec) > 10 and hc_dec[f].nunique() > 1:
            r_hc, p_hc = pearsonr(hc_dec[f].values, hc_dec["residual"].values)
        else:
            r_hc, p_hc = float("nan"), float("nan")
        if len(lc_dec) > 10 and lc_dec[f].nunique() > 1:
            r_lc, p_lc = pearsonr(lc_dec[f].values, lc_dec["residual"].values)
        else:
            r_lc, p_lc = float("nan"), float("nan")
        corr_rows.append({"feature": f, "corr_hc": r_hc, "p_hc": p_hc,
                          "corr_lc": r_lc, "p_lc": p_lc})

    corr_df = pd.DataFrame(corr_rows).sort_values(
        "corr_hc", key=lambda s: s.abs(), ascending=False
    )
    print(f"\n  {'feature':<28} {'corr_HC':>9} {'p_HC':>8} {'corr_LC':>9} {'p_LC':>8}")
    print("  " + "─" * 70)
    for _, r in corr_df.iterrows():
        p_hc_str = f"{r['p_hc']:.4f}" if not np.isnan(r['p_hc']) else "n/a"
        p_lc_str = f"{r['p_lc']:.4f}" if not np.isnan(r['p_lc']) else "n/a"
        corr_hc_str = f"{r['corr_hc']:+.4f}" if not np.isnan(r['corr_hc']) else "n/a"
        corr_lc_str = f"{r['corr_lc']:+.4f}" if not np.isnan(r['corr_lc']) else "n/a"
        print(f"  {r['feature']:<28} {corr_hc_str:>9} {p_hc_str:>8} "
              f"{corr_lc_str:>9} {p_lc_str:>8}")

    return {
        "feat_df": feat_df,
        "corr_df": corr_df,
        "n_hc_match": n_hc,
        "n_lc_match": n_lc,
        "n_hc_dec": len(hc_dec),
        "n_lc_dec": len(lc_dec),
    }


# ─────────────────────────────────────────────────────────────────────────
# TEIL extra — Calibration (ECE/MCE) on high-confidence subset
# ─────────────────────────────────────────────────────────────────────────

def teil_calibration(df_dec: pd.DataFrame):
    print()
    print("=" * 78)
    print("Kalibrierung & Overconfidence auf High-Confidence (p ≥ 0.68)")
    print("=" * 78)
    # Use all decisions (not just positive-edge), since calibration is a property
    # of the probability distribution, not bet-selection
    full = df_dec.copy()
    full_hc = full[full["p_blended"] >= P_THRESH]
    if len(full_hc) == 0:
        print("  → empty high-conf subset")
        return None

    # Reliability bins from 0.68 to 1.0 in 0.04-wide bins
    bin_edges = np.arange(P_THRESH, 1.01, 0.04)
    centers = bin_edges[:-1] + 0.02
    ece, mce, total = 0.0, 0.0, len(full_hc)
    print(f"  {'bin':>12}  {'n':>5}  {'pred_avg':>9}  {'actual':>9}  {'|gap|':>8}")
    print("  " + "─" * 50)
    for i in range(len(centers)):
        m = (full_hc["p_blended"] >= bin_edges[i]) & (full_hc["p_blended"] < bin_edges[i + 1])
        n_i = int(m.sum())
        if n_i == 0:
            continue
        pred_avg = float(full_hc.loc[m, "p_blended"].mean())
        actual = float(full_hc.loc[m, "won"].mean())
        gap = abs(pred_avg - actual)
        ece += (n_i / total) * gap
        mce = max(mce, gap)
        print(f"  [{bin_edges[i]:.2f},{bin_edges[i+1]:.2f})  {n_i:>5}  "
              f"{pred_avg:>9.4f}  {actual:>9.4f}  {gap:>8.4f}")
    overall_pred = float(full_hc["p_blended"].mean())
    overall_act = float(full_hc["won"].mean())
    print(f"\n  ECE (high-conf only): {ece:.4f}")
    print(f"  MCE (high-conf only): {mce:.4f}")
    print(f"  Overall pred avg:     {overall_pred:.4f}")
    print(f"  Overall actual:       {overall_act:.4f}")
    print(f"  Gap (pred − actual):  {overall_pred - overall_act:+.4f}  "
          f"= {(overall_pred - overall_act)*100:+.2f}pp")
    return {"ece": ece, "mce": mce, "pred_avg": overall_pred, "actual": overall_act,
            "gap": overall_pred - overall_act}


# ─────────────────────────────────────────────────────────────────────────
# TEIL D — Final recommendation
# ─────────────────────────────────────────────────────────────────────────

def teil_d_final(teil_a_results, teil_b_result, teil_c_result, calib_result):
    print()
    print("=" * 78)
    print("TEIL D — Finale Empfehlung")
    print("=" * 78)

    # Pick out the relevant subgroups
    hc = next(r for r in teil_a_results if r["name"].startswith("High-Confidence"))
    hc_sharp = next(r for r in teil_a_results if r["name"].startswith("High-Conf + Sharp"))
    he = next(r for r in teil_a_results if r["name"].startswith("High-Edge"))
    base = next(r for r in teil_a_results if r["name"].startswith("Baseline"))

    print(f"\n  Key numbers:")
    print(f"    Baseline (alle pos-edge): n={base['n']}, ROI={base['roi']*100:+.2f}%  "
          f"CI [{base['roi_lo']*100:+.2f}, {base['roi_hi']*100:+.2f}]")
    print(f"    High-Confidence:          n={hc['n']}, ROI={hc['roi']*100:+.2f}%  "
          f"CI [{hc['roi_lo']*100:+.2f}, {hc['roi_hi']*100:+.2f}]  "
          f"Gap={hc['gap']*100:+.2f}pp")
    print(f"    High-Edge (≥3.5%):        n={he['n']}, ROI={he['roi']*100:+.2f}%  "
          f"CI [{he['roi_lo']*100:+.2f}, {he['roi_hi']*100:+.2f}]")
    if hc_sharp["n"] > 0:
        print(f"    High-Conf + Sharp:        n={hc_sharp['n']}, ROI={hc_sharp['roi']*100:+.2f}%  "
              f"CI [{hc_sharp['roi_lo']*100:+.2f}, {hc_sharp['roi_hi']*100:+.2f}]")
        if hc_sharp["n"] < LOWPOWER_N:
            print(f"    ⚠ High-Conf+Sharp ist LOW POWER (n={hc_sharp['n']} < {LOWPOWER_N})")

    # Final verdict
    print()
    deploy_ok = (hc["n"] >= LOWPOWER_N and hc["roi_lo"] > 0)
    deploy_ok_sharp = (hc_sharp["n"] >= LOWPOWER_N and hc_sharp["roi_lo"] > 0)
    if deploy_ok or deploy_ok_sharp:
        print("  ✅ High-Confidence subset zeigt signifikant positive ROI — Deployment möglich")
    else:
        print("  ❌ High-Confidence subset NICHT statistisch signifikant profitabel")

    # Sort features for recommendation
    feat_df = teil_c_result["feat_df"]
    print(f"\n  Top-5 Features mit höchstem |SHAP| auf High-Conf-Matches:")
    for _, r in feat_df.head(5).iterrows():
        print(f"    {r['feature']:<28} |SHAP|_HC={r['mean_abs_shap_hc']:.4f}  "
              f"Δ={r['delta_shap_hc_minus_lc']:+.4f}")
    print(f"\n  Top-3 Features wo HC stärker als LC nutzt (Δ_HC-LC):")
    for _, r in feat_df.sort_values("delta_shap_hc_minus_lc", ascending=False).head(3).iterrows():
        print(f"    {r['feature']:<28} Δ={r['delta_shap_hc_minus_lc']:+.4f}  "
              f"ratio={r['shap_ratio_hc_over_lc']:.2f}")

    return {"deploy_ok": deploy_ok, "deploy_ok_sharp": deploy_ok_sharp}


# ─────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────

def main() -> int:
    np.random.seed(SEED)
    df_holdout = load_holdout()
    df_dec, features = build_predictions_df(df_holdout)

    teil_a = teil_a_performance_table(df_dec)
    teil_b = teil_b_edge_roi_highconf(df_dec)
    teil_c = teil_c_feature_insights(df_dec, features)
    calib = teil_calibration(df_dec)
    teil_d = teil_d_final(teil_a, teil_b, teil_c, calib)

    print()
    print("=" * 78)
    print("Done.")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
