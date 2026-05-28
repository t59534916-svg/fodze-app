"""
train_pipeline.py — dev-06 ML pipeline (Asymmetric Negation Protocol v1.1)

This is a research-grade pipeline scaffold. dev-03 remains the production
artifact; dev-06 is the v1.1 reformulation that obeys 4 of the 8 audit mandates
on the Python side:

  M1  Elastic-Net shrinkage (LightGBM `lambda_l1` + `lambda_l2`)
       — kills the 0.5 sign-flip heuristic. Let regularization shrink noise.

  M3  Trees over linear tensors
       — 0/15 linear interactions survived Holm-Bonferroni in v1.0. We pivot
         to LightGBM and extract organic non-linear manifolds via SHAP
         `TreeExplainer.shap_interaction_values()`.

  M4  No parametric Gaussian
       — manager-bounce honeymoon is a discrete process. Use a Penalized
         B-Spline GAM (`pygam.LinearGAM(s(0, …, lam=…))`), let GCV pick λ.

  M6  Strict 4-hour anti-leakage timestamping is enforced upstream in
      `tools/v4/queries/strict_lagging.sql`. This script consumes its output.

PREREQUISITES (one-time):
    tools/venv/bin/pip install shap pygam
    # lightgbm, numpy, pandas, scikit-learn are already in venv

USAGE:
    tools/venv/bin/python3 -I tools/v4/train_pipeline.py
    tools/venv/bin/python3 -I tools/v4/train_pipeline.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import pickle
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

# ─── LightGBM (M1: Elastic-Net regularization) ──────────────────────────

import lightgbm as lgb

# Tunable: when shap or pygam are missing, instruct the user instead of failing.
try:
    import shap                                # M3
except ImportError:
    shap = None                                # type: ignore

try:
    from pygam import LinearGAM, s             # M4
except ImportError:
    LinearGAM = None                            # type: ignore
    s = None                                    # type: ignore

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"


# ───────────────────────────────────────────────────────────────────────
# HYPERPARAMETERS · Mandates M1 + M3
# ───────────────────────────────────────────────────────────────────────

DEV_06_PARAMS: dict = {
    # ── Target ────────────────────────────────────────────────────────
    "objective": "tweedie",
    # tweedie_variance_power tunable in [1.0, 2.0]:
    #   1.0 = pure Poisson (count-like) · 2.0 = Gamma (continuous)
    # Goal-scoring has zero-inflation; empirically 1.3-1.5 is optimal.
    # SET EXPLICITLY (default is 1.5) so it is logged + tunable.
    "tweedie_variance_power": 1.5,
    "metric": "rmse",

    # ── M1: Elastic-Net regularization ────────────────────────────────
    # Drops the manual 0.5 sign-flip heuristic; lets the model organically
    # shrink noisy coefficients based on empirical variance.
    "lambda_l1": 0.5,                # L1: sparsity (shrinks irrelevant → 0)
    "lambda_l2": 1.0,                # L2: ridge (shrinks correlated evenly)

    # ── Tree architecture (capacity tuned against overfit) ───────────
    "boosting_type": "gbdt",
    "num_leaves": 31,
    "max_depth": 6,
    "min_data_in_leaf": 100,         # robust against sparse-leaf overfit
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "learning_rate": 0.02,
    "n_estimators": 2000,

    # ── Defensive ─────────────────────────────────────────────────────
    "extra_trees": False,
    "verbose": -1,
}


# ───────────────────────────────────────────────────────────────────────
# TRAIN  (M1 + M3)
# ───────────────────────────────────────────────────────────────────────

def train_dev_06(
    X_train: pd.DataFrame,
    y_train: np.ndarray,
    X_val: pd.DataFrame,
    y_val: np.ndarray,
    categorical: list[str] | None = None,
) -> lgb.Booster:
    """Train a regularized LightGBM Tweedie regressor.

    The categorical_feature param lets us pass `league` as a string column —
    LightGBM optimal-split-finding handles categoricals natively.
    """
    train_set = lgb.Dataset(
        X_train, y_train,
        categorical_feature=categorical or [],
        free_raw_data=False,
    )
    val_set = lgb.Dataset(
        X_val, y_val,
        categorical_feature=categorical or [],
        reference=train_set,
        free_raw_data=False,
    )
    booster = lgb.train(
        params=DEV_06_PARAMS,
        train_set=train_set,
        num_boost_round=DEV_06_PARAMS["n_estimators"],
        valid_sets=[val_set],
        valid_names=["val"],
        callbacks=[
            lgb.early_stopping(stopping_rounds=100, verbose=False),
            lgb.log_evaluation(period=200),
        ],
    )
    return booster


# ───────────────────────────────────────────────────────────────────────
# MANIFOLD DISCOVERY  (M3 SHAP — with hard-bounded sampling)
# ───────────────────────────────────────────────────────────────────────

def discover_manifolds(
    booster: lgb.Booster,
    X_sample: pd.DataFrame,
    max_rows: int = 1500,
    strat_col: str | None = "league",
) -> tuple[pd.DataFrame, np.ndarray]:
    """Extract pairwise non-linear interactions via SHAP TreeExplainer.

    M3 RATIONALE: v1.0's FWER-corrected linear interaction tests had zero
    power in our sparse high-dimensional space (0/15 survived). Tree-based
    SHAP interactions are far more sensitive to non-linear manifolds.

    COMPUTE BUDGET — CRITICAL:
        `shap_interaction_values` is O(T·D·L²) in tree-leaf count; the inner
        leaf factor blows up even at max_depth=6/num_leaves=31. Above ~2000
        rows the call can hang for hours. We HARD-BOUND the sample.

        Marginal SHAP values (`shap_values()`) are cheap — O(T·D·L) — and
        can be computed on the full set if needed for feature-importance.
        Only the pairwise interaction matrix has the leaf² explosion.

    Returns:
        (df_interactions, raw_interaction_array)
        df_interactions sorted desc by mean |interaction|.
    """
    if shap is None:
        raise RuntimeError(
            "shap not installed. Run: tools/venv/bin/pip install shap"
        )

    # ── Hard-bound the sample (M3 compute safety) ─────────────────────
    if len(X_sample) > max_rows:
        if strat_col and strat_col in X_sample.columns:
            # Stratified sample for balanced league coverage
            X_sub = (
                X_sample.groupby(strat_col, group_keys=False)
                .apply(lambda g: g.sample(min(len(g),
                                              max(1, max_rows // X_sample[strat_col].nunique())),
                                          random_state=42))
            )
            if len(X_sub) > max_rows:
                X_sub = X_sub.sample(max_rows, random_state=42)
        else:
            X_sub = X_sample.sample(max_rows, random_state=42)
        print(f"  [shap] stratified sample {len(X_sample):,} → {len(X_sub):,} rows (compute bound)")
    else:
        X_sub = X_sample.copy()
        print(f"  [shap] using full {len(X_sub):,} rows (under {max_rows:,} bound)")

    # ── SHAP interaction matrix ───────────────────────────────────────
    t0 = time.time()
    explainer = shap.TreeExplainer(booster)
    interaction_values = explainer.shap_interaction_values(X_sub)
    print(f"  [shap] interaction values computed in {time.time()-t0:.1f}s")

    # interaction_values shape: (n_rows, n_features, n_features)
    interaction_strength = np.abs(interaction_values).mean(axis=0)
    feature_names = X_sub.columns.tolist()

    rows: list[dict] = []
    n_feat = len(feature_names)
    for i in range(n_feat):
        for j in range(i + 1, n_feat):       # upper triangle only — symmetric
            rows.append({
                "feat_a": feature_names[i],
                "feat_b": feature_names[j],
                "mean_abs_interaction": float(interaction_strength[i, j]),
            })

    df = (
        pd.DataFrame(rows)
        .sort_values("mean_abs_interaction", ascending=False)
        .reset_index(drop=True)
    )
    return df, interaction_values


# ───────────────────────────────────────────────────────────────────────
# MANAGER-BOUNCE GAM  (M4 — Penalized B-Splines, no Gaussian)
# ───────────────────────────────────────────────────────────────────────

def fit_manager_bounce_gam(df: pd.DataFrame) -> "LinearGAM":
    """Fit a Penalized B-Spline GAM on (match_since_change, bounce_residual).

    M4 RATIONALE: v1.0 forced `Math.exp(-0.5 * ((m - μ) / σ)²)` Gaussian on
    discrete match counts. Real coaching-change effects are step-changes
    plus decay — a flexible GAM with smoothness penalty discovers the true
    shape without overfitting.

    df REQUIRES:
        - match_since_change: int  (matches played since manager arrived)
        - bounce_residual: float   (observed_perf − pre-change baseline)

    Returns the FITTED GAM. Use `predict_manager_bounce(gam, x)` for inference.
    """
    if LinearGAM is None:
        raise RuntimeError(
            "pygam not installed. Run: tools/venv/bin/pip install pygam"
        )

    # Window: only the relevant 0-30 match honeymoon range
    fit_df = df[
        (df["match_since_change"] >= 0) & (df["match_since_change"] <= 30)
    ].copy()
    if len(fit_df) < 20:
        raise ValueError(f"too few observations in manager-bounce window: {len(fit_df)}")

    X = fit_df[["match_since_change"]].values
    y = fit_df["bounce_residual"].values

    # Penalized B-Spline GAM. lam high = more shrinkage (smoother).
    gam = LinearGAM(s(0, n_splines=10, spline_order=3, lam=10.0)).fit(X, y)

    # GCV gridsearch for λ across 5 orders of magnitude
    lams = np.logspace(-2, 3, 20)
    gam.gridsearch(X, y, lam=lams, return_scores=False)

    edof = float(gam.statistics_["edof"])
    try:
        pr2 = float(gam.statistics_["pseudo_r2"]["McFadden"])
    except KeyError:
        pr2 = float("nan")
    print(f"  [gam] manager-bounce · EDoF={edof:.2f} (low = more shrinkage)")
    print(f"  [gam] pseudo R² (McFadden) = {pr2:.3f}")

    return gam


def predict_manager_bounce(gam, match_since_change: int) -> float:
    """Inference helper. Clips to defensive [0.0, 1.5] range."""
    x = np.array([[match_since_change]])
    pred = float(gam.predict(x)[0])
    return max(0.0, min(1.5, pred))


# ───────────────────────────────────────────────────────────────────────
# MAIN  (data load + train + explain + GAM + save artifacts)
# ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="dev-06 ML training pipeline (v1.1)")
    p.add_argument("--cutoff", default="2025-08-01",
                   help="Train on matches with match_date < cutoff (default 2025-08-01)")
    p.add_argument("--since", default="2017-01-01",
                   help="Train on matches with match_date >= since (default 2017-01-01)")
    p.add_argument("--leagues", default=None,
                   help="Comma-separated list of leagues (default: all 22)")
    p.add_argument("--tag", default=None,
                   help="Artifact tag (default: timestamp YYYYMMDD-HHMM)")
    p.add_argument("--shap-max-rows", type=int, default=1500,
                   help="Hard bound on rows passed to shap_interaction_values (M3 compute)")
    p.add_argument("--dry-run", action="store_true",
                   help="Load data + verify imports; skip training + save")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    leagues = args.leagues.split(",") if args.leagues else None
    tag = args.tag or datetime.now().strftime("%Y%m%d-%H%M")

    print("=" * 70)
    print(f"dev-06 · v1.1 Asymmetric Negation · tag={tag}")
    print("=" * 70)
    print(f"  cutoff:        {args.cutoff}")
    print(f"  since:         {args.since}")
    print(f"  leagues:       {leagues if leagues else 'ALL 22'}")
    print(f"  shap_max_rows: {args.shap_max_rows}")
    print(f"  dry_run:       {args.dry_run}")
    print()

    # Verify M3/M4 deps before loading data
    if shap is None:
        print("⚠ shap not installed — install before non-dry runs:")
        print("    tools/venv/bin/pip install shap")
    if LinearGAM is None:
        print("⚠ pygam not installed — install before non-dry runs:")
        print("    tools/venv/bin/pip install pygam")

    # ─── Load data ──────────────────────────────────────────────────
    from v4.data.loaders import load_team_xg_history, load_match_pairs

    t0 = time.time()
    history = load_team_xg_history(leagues=leagues)
    matches = load_match_pairs(cutoff=args.cutoff, since=args.since, leagues=leagues)
    matches = matches.dropna(subset=["home_goals", "away_goals"])
    print(f"  Loaded: {len(history):,} history rows, {len(matches):,} settled matches  "
          f"({time.time()-t0:.1f}s)")

    if len(matches) < 500:
        print(f"  ✗ ERROR: only {len(matches)} settled matches — need ≥ 500 to train")
        return 1

    if args.dry_run:
        print("  --dry-run: data load OK; skipping training + save")
        return 0

    # ─── Feature build (placeholder — reuse m3_xg pattern) ──────────
    # In a full integration this would call build_features_for_corpus
    # from v4.modules.m3_xg, identical to train_m3_xg.py. The minimal
    # placeholder below assumes home_goals + a small feature set; replace
    # with the real builder on integration.
    #
    # from v4.modules.m3_xg import build_features_for_corpus, extract_X
    # features = build_features_for_corpus(matches, history, ...)
    # X = extract_X(features)
    # y_h = features["home_goals"].values
    # y_a = features["away_goals"].values
    raise NotImplementedError(
        "feature builder must be wired to v4.modules.m3_xg.build_features_for_corpus "
        "before non-dry runs. The DEV_06_PARAMS + train_dev_06 + discover_manifolds + "
        "fit_manager_bounce_gam scaffolding is ready — wire X/y/cats and uncomment "
        "the orchestration block below."
    )

    # ─── Orchestration (commented until feature builder is wired) ───
    # cats = ["league"]
    # # Temporal-split for train vs val
    # cutoff_idx = ... # build via match_date
    # X_train, y_train = X.iloc[cutoff_idx], y_h[cutoff_idx]
    # X_val,   y_val   = X.iloc[~cutoff_idx], y_h[~cutoff_idx]
    #
    # booster_h = train_dev_06(X_train, y_train, X_val, y_val, categorical=cats)
    # df_inter, raw_inter = discover_manifolds(booster_h, X_val,
    #                                          max_rows=args.shap_max_rows,
    #                                          strat_col="league")
    # print("\n  Top 20 non-linear interactions (SHAP):")
    # print(df_inter.head(20).to_string(index=False))
    #
    # # Manager-bounce GAM expects a DataFrame with match_since_change + bounce_residual
    # mgr_df = build_manager_bounce_table(history, matches)   # implement separately
    # gam = fit_manager_bounce_gam(mgr_df)
    #
    # ─── Save artifacts ─────────────────────────────────────────────
    # ARTIFACTS_DIR.mkdir(exist_ok=True)
    # booster_h.save_model(str(ARTIFACTS_DIR / f"dev-06-home-{tag}.txt"))
    # df_inter.to_csv(ARTIFACTS_DIR / f"dev-06-interactions-{tag}.csv", index=False)
    # with open(ARTIFACTS_DIR / f"dev-06-gam-{tag}.pkl", "wb") as f:
    #     pickle.dump(gam, f)
    # manifest = {
    #     "tag": tag, "trained_at": datetime.now().isoformat(),
    #     "lgb_params": DEV_06_PARAMS, "shap_max_rows": args.shap_max_rows,
    # }
    # with open(ARTIFACTS_DIR / f"dev-06-{tag}.json", "w") as f:
    #     json.dump(manifest, f, indent=2)


if __name__ == "__main__":
    sys.exit(main())
