"""
oos_validation_24-25.py — Out-of-Sample validation of dev-03 on 24/25 holdout.

PURPOSE:
  Quantify Holdout-Contamination bias that may inflate dev-03's claimed
  +3.35% Stage 5 Goldilocks ROI on 25/26 (where iterative feature-engineering
  was done). 24/25 is a separate season where we did NOT iterate features
  during dev-03 design.

DATA:
  - Holdout: tools/backtest/odds-close-24-25.parquet (5.485 rows, 16 leagues)
  - Features: team_xg_history populated for 24/25 (just bridged 3.766 understat rows)
  - Artifacts: m3_xg-{home,away}-dev-03.pkl + m6_benter-dev-03.pkl

METRICS (compared head-to-head with 25/26):
  - Brier (multiclass 1X2)
  - Stage 5 Goldilocks ROI + 95% CI
  - High-Confidence (p ≥ 0.68) ROI + CI
  - Per-league split (Top-5 with Understat features vs Lower-17 without)

Bootstrap: 10k Resamples, SEED=42 (same as prior runs).

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/oos_validation_24-25.py
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
from v4.modules.m3_xg.feature_builder import build_features_for_corpus
from v4.modules.m6_market import BenterBlender, remove_vig
from v4.modules.m7_kelly.goldilocks import DEFAULT_LIGA_TIERS

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT_2425 = REPO_ROOT / "tools" / "backtest" / "odds-close-24-25.parquet"
HOLDOUT_2526 = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"

SEED = 42
BOOT = 10_000
KELLY_CAP = 0.04
P_THRESH = 0.68

GOLDILOCKS = {
    "sharp":    (0.015, 0.050),
    "moderate": (0.025, 0.075),
    "soft":     (0.035, 0.085),
}
FALLBACK_TIER = "moderate"

TOP5 = {"bundesliga", "epl", "la_liga", "ligue_1", "serie_a"}


def _outcome_label(h, a):
    if h > a: return "H"
    if h < a: return "A"
    return "D"


def _kelly_stake(edge, odds):
    return min(edge / (odds - 1.0), KELLY_CAP) if edge > 0 else 0.0


def _clopper_pearson(k, n, alpha=0.05):
    if n == 0: return float("nan"), float("nan")
    lo = scipy_beta.ppf(alpha / 2, k, n - k + 1) if k > 0 else 0.0
    hi = scipy_beta.ppf(1 - alpha / 2, k + 1, n - k) if k < n else 1.0
    return float(lo), float(hi)


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


def brier_multiclass(p_arr, y_labels):
    p_arr = p_arr / p_arr.sum(axis=1, keepdims=True)
    label_to_idx = {"H": 0, "D": 1, "A": 2}
    y_idx = np.array([label_to_idx[v] for v in y_labels])
    n = len(y_labels)
    oh = np.zeros_like(p_arr)
    oh[np.arange(n), y_idx] = 1.0
    return float(((p_arr - oh) ** 2).sum(axis=1).mean())


def load_holdout(path: Path, label: str) -> pd.DataFrame:
    df = pd.read_parquet(path)
    df = df.rename(columns={"psch": "psc_h", "pscd": "psc_d", "psca": "psc_a"})
    df = df.dropna(subset=["psc_h", "psc_d", "psc_a", "ft_goals_h", "ft_goals_a"]).copy()
    df["match_date"] = pd.to_datetime(df["match_date"]).dt.tz_localize(None)
    df = df.reset_index(drop=True)
    print(f"  {label}: {len(df):,} matches from {df['match_date'].min()} → {df['match_date'].max()}")
    print(f"    leagues: {df['league'].nunique()} ({sorted(df['league'].unique())})")
    return df


def run_pipeline(df_holdout: pd.DataFrame, history: pd.DataFrame, tag: str) -> Tuple[pd.DataFrame, float, np.ndarray]:
    """Build features → m3 predict → m6 blend. Returns (decisions_df, brier, blend_probs)."""
    pred = XGPredictor.from_artifacts(
        home_path=ARTIFACTS / f"m3_xg-home-{tag}.pkl",
        away_path=ARTIFACTS / f"m3_xg-away-{tag}.pkl",
    )
    blender = BenterBlender.load(ARTIFACTS / f"m6_benter-{tag}.pkl")
    match_pairs = df_holdout[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    ).reset_index(drop=True)

    t0 = time.time()
    features = build_features_for_corpus(
        match_pairs, history,
        estimator=pred.lambda_estimator,
        elo_calculator=pred._get_elo(history),
        momentum_calculator=pred._get_momentum(history),
        include_targets=False,
        verbose=False,
    )
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
    for i, row in df_holdout.iterrows():
        actual = _outcome_label(row["ft_goals_h"], row["ft_goals_a"])
        tier = DEFAULT_LIGA_TIERS.get(row["league"], FALLBACK_TIER)
        in_top5 = row["league"] in TOP5
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
                "top5": in_top5,
                "outcome": label,
                "p_blended": p,
                "decimal_odds": o,
                "edge": edge,
                "won": 1 if won else 0,
            })
    df_dec = pd.DataFrame(rows)
    return df_dec, brier, blend


def metrics(sub: pd.DataFrame, label: str) -> Dict:
    n = len(sub)
    if n == 0:
        return {"label": label, "n": 0}
    won = sub["won"].values
    odds = sub["decimal_odds"].values
    edge = sub["edge"].values
    p = sub["p_blended"].values
    wr = float(won.mean())
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
        "win_rate": wr, "wr_lo": wr_lo, "wr_hi": wr_hi,
        "edge_avg": float(edge.mean()),
        "p_avg": float(p.mean()),
        "gap": float(p.mean() - wr),
        "roi": roi, "roi_lo": roi_lo, "roi_hi": roi_hi,
    }


def stage5_filter(df_dec: pd.DataFrame) -> pd.DataFrame:
    parts = []
    for tier, (lo, hi) in GOLDILOCKS.items():
        s = df_dec[(df_dec["tier"] == tier) &
                   (df_dec["edge"] >= lo) & (df_dec["edge"] <= hi)]
        parts.append(s)
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()


def print_table(rows: List[Dict]):
    print(f"  {'label':<35} {'n':>5} {'win%':>7} {'ROI':>9} {'CI95':>22} {'gap':>9}")
    print("  " + "─" * 90)
    for r in rows:
        if r["n"] == 0:
            print(f"  {r['label']:<35} {0:>5}  [empty]")
            continue
        ci_str = f"[{r['roi_lo']*100:+6.2f}, {r['roi_hi']*100:+6.2f}]"
        print(f"  {r['label']:<35} {r['n']:>5} "
              f"{r['win_rate']*100:>6.2f}% {r['roi']*100:>+8.2f}% {ci_str:>22} "
              f"{r['gap']*100:>+7.2f}pp")


def main():
    print("=" * 90)
    print("  dev-03 Out-of-Sample Validation: 24/25 vs 25/26 (Holdout-Contamination Bias Check)")
    print("=" * 90)
    print()
    print(f"  Loading 24/25 holdout...")
    df_2425 = load_holdout(HOLDOUT_2425, "24/25")
    print()
    print(f"  Loading 25/26 holdout (reference)...")
    df_2526 = load_holdout(HOLDOUT_2526, "25/26")
    print()

    print(f"  Loading team_xg_history (now with Understat 24/25 augment)...")
    history = load_team_xg_history()
    print(f"    {len(history):,} total rows")
    print()

    # ── Pipeline runs ────────────────────────────────────────
    print("=" * 90)
    print("  Running dev-03 pipeline on 24/25 holdout")
    print("=" * 90)
    dec_2425, brier_2425, _ = run_pipeline(df_2425, history, "dev-03")
    print()

    print("=" * 90)
    print("  Running dev-03 pipeline on 25/26 holdout (reference, contaminated)")
    print("=" * 90)
    dec_2526, brier_2526, _ = run_pipeline(df_2526, history, "dev-03")
    print()

    # ── Summary ──────────────────────────────────────────────
    print("=" * 90)
    print("  Side-by-side: dev-03 on 24/25 (OOS) vs 25/26 (in-sample)")
    print("=" * 90)
    print(f"\n  Brier (all decisions): 24/25 = {brier_2425:.4f}  ·  25/26 = {brier_2526:.4f}  "
          f"·  Δ = {brier_2425-brier_2526:+.4f}")
    print()

    # Subgroup metrics for each season
    for season_label, dec in [("24/25 OOS", dec_2425), ("25/26 in-sample", dec_2526)]:
        print(f"\n  ── {season_label} ──")
        pos = dec[dec["edge"] > 0]
        stage5 = stage5_filter(dec)
        hc = pos[pos["p_blended"] >= P_THRESH]
        hc_sharp = hc[hc["tier"] == "sharp"]
        # Top-5 vs not
        pos_top5 = pos[pos["top5"]]
        pos_nontop5 = pos[~pos["top5"]]
        stage5_top5 = stage5[stage5["top5"]]
        stage5_nontop5 = stage5[~stage5["top5"]]

        rows = [
            metrics(pos, "All positive-edge"),
            metrics(pos_top5, "  → Top-5 only (Understat-augmented)"),
            metrics(pos_nontop5, "  → non-Top-5"),
            metrics(stage5, "Stage 5 Goldilocks"),
            metrics(stage5_top5, "  → Top-5 only"),
            metrics(stage5_nontop5, "  → non-Top-5"),
            metrics(hc, f"High-Confidence (p ≥ {P_THRESH:.2f})"),
            metrics(hc_sharp, "  → HC + sharp tier"),
        ]
        print_table(rows)

    # Final verdict
    print()
    print("=" * 90)
    print("  Verdict: Holdout-Contamination Bias Quantification")
    print("=" * 90)
    pos_2425 = dec_2425[dec_2425["edge"] > 0]
    pos_2526 = dec_2526[dec_2526["edge"] > 0]
    stage5_2425 = stage5_filter(dec_2425)
    stage5_2526 = stage5_filter(dec_2526)
    s5_2425 = metrics(stage5_2425, "")
    s5_2526 = metrics(stage5_2526, "")
    print(f"\n  Stage 5 Goldilocks ROI comparison:")
    print(f"    24/25 OOS:        {s5_2425['roi']*100:+.2f}%  CI [{s5_2425['roi_lo']*100:+.2f}, {s5_2425['roi_hi']*100:+.2f}]  n={s5_2425['n']}")
    print(f"    25/26 in-sample:  {s5_2526['roi']*100:+.2f}%  CI [{s5_2526['roi_lo']*100:+.2f}, {s5_2526['roi_hi']*100:+.2f}]  n={s5_2526['n']}")
    delta = s5_2425['roi'] - s5_2526['roi']
    print(f"    Δ (OOS − in-sample): {delta*100:+.2f}pp")
    if delta < -0.02:
        print(f"  ⚠ OOS ROI substantially LOWER → confirms Holdout-Contamination concern")
    elif delta < -0.01:
        print(f"  ⚠ OOS ROI moderately lower → mild contamination evidence")
    elif abs(delta) < 0.01:
        print(f"  ✓ OOS ROI ≈ in-sample → minimal contamination, claimed numbers robust")
    else:
        print(f"  ? OOS ROI higher than in-sample — unexpected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
