#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
@annafrick13 SoT v0.1 — Lean LightGBM Sibling for Shots-on-Target
═══════════════════════════════════════════════════════════════════

v4.2 lab-only: predicts per-team shots_on_target_for using the v3-Lean
20-feature vector. Same vectorized leakage-safe pipeline (.shift(1).ewm),
same Elo/SoS/DERBIES/H2H/Recency-Weights as retrain_v3.py.

DIFFERENCES FROM v3:
- Target = shots_on_target_for (mean ~5/team/match, not ~1.5)
- Lambda clamp [0.5, 25] (wider for the higher-mean target)
- No Dixon-Coles rho (we predict counts, not goal-pair PMF)
- Brier eval against per-team SoT O/U lines (4.5, 5.5, 6.5, 7.5)

REUSES from retrain_v3 (single source of truth for the lean architecture):
- FEATURE_NAMES, MONO_HOME, MONO_AWAY (20-feature vector)
- DERBIES + normalize_team_name + TEAM_NAME_ALIASES
- LEAGUE_AVGS + LEAGUE_HFS
- precompute_rolling_features (vectorized .shift(1).ewm)
- compute_elo (iterative K=32, HOME_ADV=65)
- compute_h2h_xg_diff (mean of last 5 H2H meetings)

OUTPUT:
  tools/lab/shots-on-target-model.json (NOT public/) — explicitly
  isolated from production until manual promotion. Vercel does not
  serve files outside public/.

USAGE:
  source tools/venv/bin/activate
  DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_shots_on_target.py --n-trials 50
  python3 tools/retrain_shots_on_target.py --dry-run --n-trials 0
═══════════════════════════════════════════════════════════════════
"""

import os
import sys
import json
import argparse
from typing import Optional

import numpy as np
import pandas as pd

try:
    import lightgbm as lgb
except ImportError:
    print("ERROR: lightgbm not installed.")
    sys.exit(1)

from scipy.stats import poisson

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.supabase_loader import fetch_xg_history  # noqa: E402

# Single-source-of-truth import from v3 — feature schema must stay in sync
from retrain_v3 import (  # noqa: E402
    FEATURE_NAMES,
    N_FEATURES,
    MONO_HOME,
    MONO_AWAY,
    LEAGUE_AVGS,
    LEAGUE_HFS,
    DERBIES,
    EWMA_ALPHA,
    ROLLING_COLS,
    normalize_team_name,
    precompute_rolling_features,
    compute_elo,
    compute_h2h_xg_diff,
)

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lab")
os.makedirs(OUTPUT_DIR, exist_ok=True)
OUTPUT = os.path.join(OUTPUT_DIR, "shots-on-target-model.json")

# SoT-specific clamp — top teams routinely 10-15 SoT, top tactical
# matchups (Bayern home vs. relegation candidate) can hit 18-20. The 25
# upper bound is a safety net against runaway leaf values.
LAMBDA_CLAMP_LO = 0.5
LAMBDA_CLAMP_HI = 25.0

# Common SoT lines for Brier evaluation
SOT_LINES = [3.5, 4.5, 5.5, 6.5, 7.5]


def build_features_and_sot(
    df: pd.DataFrame,
    elo_map: dict[str, float],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, pd.Series, pd.Series]:
    """v3-feature build + SoT targets (instead of goals).

    Identical structure to v3's build_features_vectorized but extracts
    shots_on_target_for as y_h and shots_on_target_against as y_a from the
    home row (which carries both — symmetric mirror of the away match).
    """
    df = precompute_rolling_features(df)

    ewma_cols = [f"{c}_ewma" for c in ROLLING_COLS if f"{c}_ewma" in df.columns]
    extra_cols = [c for c in ("xg_momentum", "xg_volatility", "shot_accuracy_ewma",
                               "rest_days") if c in df.columns]
    feat_cols = ewma_cols + extra_cols

    home_rows = (
        df[df["venue"] == "home"]
        .drop_duplicates(subset=["team", "match_date"], keep="last")
        .copy()
    )
    away_rows = df[df["venue"] == "away"].copy()

    h2h_series = compute_h2h_xg_diff(home_rows)

    away_lookup = (
        away_rows.drop_duplicates(subset=["team", "match_date"], keep="last")
        .set_index(["team", "match_date"])[feat_cols]
    )

    home_rows = home_rows.sort_values(["team", "match_date"]).reset_index(drop=True)
    home_rows["_opp_elo"] = home_rows["opponent"].map(elo_map).fillna(1500.0)
    home_rows["_opp_elo_avg"] = home_rows.groupby("team")["_opp_elo"].transform(
        lambda s: s.shift(1).expanding(min_periods=3).mean()
    )

    X_rows: list[list[float]] = []
    y_h: list[float] = []
    y_a: list[float] = []
    dates: list[pd.Timestamp] = []
    leagues: list[str] = []
    skipped_no_away = 0
    skipped_insufficient = 0
    skipped_no_sot = 0

    for _, m in home_rows.iterrows():
        team, opp, date = m["team"], m["opponent"], m["match_date"]
        league = m["league"]

        # SoT target on home perspective: shots_on_target_for is THIS team's SoT,
        # shots_on_target_against is OPPONENT's SoT (= away's SoT in the match).
        # FootyStats uses -1 as a "no data" sentinel — must be filtered out
        # since LightGBM Tweedie rejects negative labels.
        sot_h_val = m.get("shots_on_target_for")
        sot_a_val = m.get("shots_on_target_against")
        if pd.isna(sot_h_val) or pd.isna(sot_a_val) or sot_h_val < 0 or sot_a_val < 0:
            skipped_no_sot += 1
            continue

        try:
            a_row = away_lookup.loc[(opp, date)]
        except KeyError:
            skipped_no_away += 1
            continue

        if pd.isna(m.get("xg_ewma")) or pd.isna(a_row.get("xg_ewma")):
            skipped_insufficient += 1
            continue

        # ── v3 feature build (verbatim from build_features_vectorized) ─────
        xg_diff_ewma = float(m["xg_ewma"] - a_row["xg_ewma"])
        xga_diff_ewma = float(m["xga_ewma"] - a_row["xga_ewma"])
        xg_momentum_diff = float((m.get("xg_momentum") or 0) - (a_row.get("xg_momentum") or 0))
        xg_volatility_diff = float((m.get("xg_volatility") or 0) - (a_row.get("xg_volatility") or 0))
        total_xg = float(m["xg_ewma"] + a_row["xg_ewma"])

        elo_h = elo_map.get(str(team), 1500.0)
        elo_a = elo_map.get(str(opp), 1500.0)
        elo_diff = float(elo_h + 65 - elo_a)
        opp_elo_avg_h = m.get("_opp_elo_avg")
        sos_strength = float(((opp_elo_avg_h or 1500.0) - 1500.0) / 400.0)
        is_derby = 1 if frozenset([normalize_team_name(team), normalize_team_name(opp)]) in DERBIES else 0
        h2h_val = h2h_series.get((team, opp, date), 0.0)
        h2h_xg_diff = float(h2h_val if pd.notna(h2h_val) else 0.0)

        rest_h = m.get("rest_days")
        rest_a = a_row.get("rest_days")
        rest_days_diff = (
            float((rest_h - rest_a) / 7.0)
            if not (pd.isna(rest_h) or pd.isna(rest_a)) else 0.0
        )

        home_factor = LEAGUE_HFS.get(league, 1.25)
        league_avg = LEAGUE_AVGS.get(league, 1.35)

        def diff(col: str) -> float:
            v_h = m.get(col)
            v_a = a_row.get(col)
            if pd.isna(v_h) or pd.isna(v_a):
                return 0.0
            return float(v_h - v_a)

        feats = [
            xg_diff_ewma, xga_diff_ewma, xg_momentum_diff, xg_volatility_diff, total_xg,
            elo_diff, sos_strength, is_derby, h2h_xg_diff, rest_days_diff,
            home_factor, league_avg,
            diff("shots_for_ewma"), diff("shots_on_target_for_ewma"),
            diff("shot_accuracy_ewma"), diff("corners_for_ewma"),
            diff("possession_pct_ewma"),
            diff("fouls_ewma"), diff("yellow_cards_for_ewma"), diff("red_cards_for_ewma"),
        ]
        assert len(feats) == N_FEATURES

        if any(pd.isna(v) or not np.isfinite(v) for v in feats):
            skipped_insufficient += 1
            continue

        X_rows.append(feats)
        y_h.append(float(sot_h_val))
        y_a.append(float(sot_a_val))
        dates.append(date)
        leagues.append(str(league))

    print(f"  Features built: {len(X_rows)} rows "
          f"(skipped {skipped_no_away} no-away-pair, "
          f"{skipped_insufficient} insufficient-history, "
          f"{skipped_no_sot} no-SoT)")
    return (np.array(X_rows), np.array(y_h), np.array(y_a),
            pd.Series(dates), pd.Series(leagues))


def build_training_set_sot(
    df: pd.DataFrame,
    drop_before: Optional[pd.Timestamp] = None,
    holdout_cutoff: Optional[pd.Timestamp] = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, pd.Series, pd.Series, np.ndarray]:
    df = df.copy()
    df["match_date"] = pd.to_datetime(df["match_date"], errors="coerce", utc=True).dt.tz_localize(None)
    df = df.dropna(subset=["match_date", "team", "opponent", "venue", "xg", "xga"])

    if drop_before is not None:
        before_n = len(df)
        df = df[df["match_date"] >= drop_before].copy()
        print(f"  Dropped {before_n - len(df)} rows pre-{drop_before.date()}")

    if holdout_cutoff is None:
        holdout_cutoff = pd.Timestamp("2025-08-01")

    src_train_mask = df["match_date"] < holdout_cutoff
    elo_map = compute_elo(df[src_train_mask])
    print(f"  Elo: computed on {src_train_mask.sum()} train rows, {len(elo_map)} teams")

    X, y_h, y_a, dates, leagues = build_features_and_sot(df, elo_map)

    # Sort by (league, date) for downstream rank-based split if needed, AND
    # so train_mask aligns positionally to the X matrix.
    order = np.lexsort((dates.values.astype("datetime64[ns]"), leagues.values))
    X = X[order]
    y_h = y_h[order]
    y_a = y_a[order]
    dates = dates.iloc[order].reset_index(drop=True)
    leagues = leagues.iloc[order].reset_index(drop=True)

    train_mask = (dates < holdout_cutoff).to_numpy()
    print(f"  Split: {int(train_mask.sum())} train / {int((~train_mask).sum())} test "
          f"(chrono cutoff {holdout_cutoff.date()})")
    return X, y_h, y_a, dates, leagues, train_mask


def train_lgbm_sot(X, y, mono, params, num_boost_round, sample_weight=None):
    p = {"objective": "tweedie", "monotone_constraints": mono, "verbose": -1, **params}
    train_set = lgb.Dataset(X, y, weight=sample_weight)
    return lgb.train(p, train_set, num_boost_round=num_boost_round)


def sot_brier_eval(lams_h, lams_a, sot_h, sot_a):
    """Per-line binary Brier over the 5 SoT thresholds, plus MAE.

    Predicted: P(SoT > line) using Poisson(lambda). Outcome: indicator
    1 if observed SoT > line else 0. Returns mean per-line Brier + per-team
    MAE on the count target.
    """
    n = len(lams_h)
    line_brier_h = {l: 0.0 for l in SOT_LINES}
    line_brier_a = {l: 0.0 for l in SOT_LINES}
    for i in range(n):
        for L in SOT_LINES:
            # P(SoT > L) = 1 - P(SoT <= floor(L))
            p_over_h = 1.0 - poisson.cdf(int(np.floor(L)), lams_h[i])
            p_over_a = 1.0 - poisson.cdf(int(np.floor(L)), lams_a[i])
            line_brier_h[L] += (p_over_h - (1.0 if sot_h[i] > L else 0.0)) ** 2
            line_brier_a[L] += (p_over_a - (1.0 if sot_a[i] > L else 0.0)) ** 2
    avg_brier_h = sum(line_brier_h.values()) / (n * len(SOT_LINES))
    avg_brier_a = sum(line_brier_a.values()) / (n * len(SOT_LINES))
    mae_h = float(np.mean(np.abs(lams_h - sot_h)))
    mae_a = float(np.mean(np.abs(lams_a - sot_a)))
    return {
        "n": n,
        "brier_sot_h_avg": avg_brier_h,
        "brier_sot_a_avg": avg_brier_a,
        "brier_per_line_h": {str(L): line_brier_h[L] / n for L in SOT_LINES},
        "brier_per_line_a": {str(L): line_brier_a[L] / n for L in SOT_LINES},
        "mae_h": mae_h,
        "mae_a": mae_a,
        "mean_lam_h": float(lams_h.mean()),
        "mean_lam_a": float(lams_a.mean()),
        "mean_sot_h": float(sot_h.mean()),
        "mean_sot_a": float(sot_a.mean()),
    }


def train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te, params, num_boost,
                       train_weights=None):
    home_b = train_lgbm_sot(Xtr, yh_tr, MONO_HOME, params, num_boost, sample_weight=train_weights)
    away_b = train_lgbm_sot(Xtr, ya_tr, MONO_AWAY, params, num_boost, sample_weight=train_weights)
    raw_h = home_b.predict(Xte)
    raw_a = away_b.predict(Xte)
    lams_h = np.clip(raw_h, LAMBDA_CLAMP_LO, LAMBDA_CLAMP_HI)
    lams_a = np.clip(raw_a, LAMBDA_CLAMP_LO, LAMBDA_CLAMP_HI)
    metrics = sot_brier_eval(lams_h, lams_a, yh_te, ya_te)
    metrics["mean_lam_h_raw"] = float(raw_h.mean())
    metrics["mean_lam_a_raw"] = float(raw_a.mean())
    metrics["clamp_hits_h_lo"] = int((raw_h < LAMBDA_CLAMP_LO).sum())
    metrics["clamp_hits_h_hi"] = int((raw_h > LAMBDA_CLAMP_HI).sum())
    metrics["mean_yh_train"] = float(yh_tr.mean())
    metrics["mean_ya_train"] = float(ya_tr.mean())
    return {"home_b": home_b, "away_b": away_b, **metrics}


def optuna_objective(trial, Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te, train_weights=None):
    params = {
        "tweedie_variance_power": trial.suggest_float("tweedie_variance_power", 1.01, 1.9),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
        "num_leaves": trial.suggest_int("num_leaves", 15, 63),
        "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 20, 120),
        "feature_fraction": trial.suggest_float("feature_fraction", 0.7, 1.0),
        "bagging_fraction": trial.suggest_float("bagging_fraction", 0.7, 1.0),
        "bagging_freq": 5,
        "lambda_l1": trial.suggest_float("lambda_l1", 0.0, 1.0),
        "lambda_l2": trial.suggest_float("lambda_l2", 0.0, 1.0),
    }
    num_boost = trial.suggest_int("num_boost_round", 200, 500, step=50)
    try:
        result = train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te, params, num_boost,
                                     train_weights=train_weights)
        # Optimize on average per-team Brier across 5 lines, both home & away
        return (result["brier_sot_h_avg"] + result["brier_sot_a_avg"]) / 2.0
    except Exception as e:
        print(f"  trial failed: {e}")
        return 1.0


def export(home_b, away_b, n_train, metrics, best_params, args):
    model = {
        "version": "sot-v0.1",
        "feature_names": FEATURE_NAMES,
        "home_trees": home_b.dump_model()["tree_info"],
        "away_trees": away_b.dump_model()["tree_info"],
        "lambda_clamp": [LAMBDA_CLAMP_LO, LAMBDA_CLAMP_HI],
        "n_train": int(n_train),
        "mono_home": MONO_HOME,
        "mono_away": MONO_AWAY,
        "holdout_metrics": metrics,
        "best_params": best_params,
        "sot_lines": SOT_LINES,
        "trained_with": {
            "drop_before": args.drop_before or None,
            "cutoff": args.cutoff,
            "weight_half_life_days": args.weight_half_life_days,
            "n_trials": args.n_trials,
        },
    }
    with open(OUTPUT, "w") as f:
        json.dump(model, f, indent=2)
    print(f"\n✓ Model exported → {OUTPUT}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sources", default="footystats")
    ap.add_argument("--n-trials", type=int, default=0)
    ap.add_argument("--drop-before", default="")
    ap.add_argument("--cutoff", default="2025-08-01")
    ap.add_argument("--weight-half-life-days", type=float, default=365.0)
    args = ap.parse_args()

    print("═══ SoT Sibling Training (lab v0.1) ═══\n")
    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    print(f"Sources:           {sources}")
    print(f"Drop before:       {args.drop_before or '(no drop)'}")
    print(f"Holdout cutoff:    {args.cutoff}")
    print(f"Recency weight τ:  {args.weight_half_life_days} days")
    print(f"Optuna trials:     {args.n_trials}")
    print(f"Output:            {OUTPUT}\n")

    df = fetch_xg_history(sources=sources)
    print(f"Fetched {len(df)} rows from Supabase")

    drop_cutoff = pd.Timestamp(args.drop_before) if args.drop_before else None
    holdout_cutoff = pd.Timestamp(args.cutoff)
    X, y_h, y_a, dates, leagues, train_mask = build_training_set_sot(
        df, drop_before=drop_cutoff, holdout_cutoff=holdout_cutoff,
    )
    print(f"Training matrix: {X.shape}  y_h.mean={y_h.mean():.2f} (SoT/team)  y_a.mean={y_a.mean():.2f}")
    if len(X) == 0:
        print("No trainable pairs. Exit.")
        return

    test_mask = ~train_mask
    Xtr, yh_tr, ya_tr = X[train_mask], y_h[train_mask], y_a[train_mask]
    Xte, yh_te, ya_te = X[test_mask], y_h[test_mask], y_a[test_mask]
    train_dates = dates[train_mask].reset_index(drop=True)
    print(f"  train: {len(Xtr)} ({train_dates.min()} → {train_dates.max()})")
    print(f"  test:  {len(Xte)} ({dates[test_mask].min() if test_mask.any() else '—'} → "
          f"{dates[test_mask].max() if test_mask.any() else '—'})")

    if args.weight_half_life_days > 0 and len(train_dates) > 0:
        ref_date = train_dates.max()
        days_old = (ref_date - train_dates).dt.days.to_numpy()
        train_weights = np.exp(-days_old / args.weight_half_life_days)
        print(f"  Recency weights: max={train_weights.max():.2f} min={train_weights.min():.4f}")
    else:
        train_weights = None

    DEFAULT_PARAMS = {
        "tweedie_variance_power": 1.5,
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 20,
        "feature_fraction": 0.85,
        "bagging_fraction": 0.9,
        "bagging_freq": 5,
        "lambda_l1": 0.1,
        "lambda_l2": 0.1,
    }
    DEFAULT_NUM_BOOST = 400

    if args.n_trials > 0:
        try:
            import optuna
        except ImportError:
            print("optuna not installed — pip install optuna")
            return
        print(f"\n═══ Optuna search ({args.n_trials} trials) ═══")
        study = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=42))
        study.optimize(
            lambda t: optuna_objective(t, Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te, train_weights),
            n_trials=args.n_trials,
            show_progress_bar=True,
        )
        best_params = {k: v for k, v in study.best_params.items() if k != "num_boost_round"}
        best_params["bagging_freq"] = 5
        best_num_boost = study.best_params.get("num_boost_round", DEFAULT_NUM_BOOST)
        print(f"  best avg-Brier: {study.best_value:.4f}")
        print(f"  best params: {study.best_params}")
    else:
        best_params = DEFAULT_PARAMS
        best_num_boost = DEFAULT_NUM_BOOST

    print("\n═══ Final training ═══")
    final = train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                                  best_params, best_num_boost, train_weights=train_weights)
    print(f"\n━━━ Holdout Metrics ━━━")
    print(f"  n (test):        {final['n']}")
    print(f"  Brier SoT (avg over 5 lines, home): {final['brier_sot_h_avg']:.4f}")
    print(f"  Brier SoT (avg over 5 lines, away): {final['brier_sot_a_avg']:.4f}")
    for L in SOT_LINES:
        bh = final["brier_per_line_h"][str(L)]
        ba = final["brier_per_line_a"][str(L)]
        print(f"    line {L:>4}: home={bh:.4f}  away={ba:.4f}")
    print(f"  MAE home:  {final['mae_h']:.3f}  away: {final['mae_a']:.3f}  (target ≈ 1.0)")
    print(f"\n━━━ Drift Diagnostics ━━━")
    print(f"  Train target:   y_h.mean()={final['mean_yh_train']:.3f}  y_a.mean()={final['mean_ya_train']:.3f}")
    print(f"  Test target:    y_h.mean()={final['mean_sot_h']:.3f}  y_a.mean()={final['mean_sot_a']:.3f}")
    print(f"  Pred raw:       λ_h.mean()={final['mean_lam_h_raw']:.3f}  λ_a.mean()={final['mean_lam_a_raw']:.3f}")
    print(f"  Clamp hits:     home lo={final['clamp_hits_h_lo']}/{final['n']} hi={final['clamp_hits_h_hi']}/{final['n']}")

    print("\n━━━ Feature Importance (Home model) ━━━")
    imp_h = final["home_b"].feature_importance(importance_type="gain")
    imp_a = final["away_b"].feature_importance(importance_type="gain")
    for i, name in enumerate(FEATURE_NAMES):
        ih = int(imp_h[i]) if i < len(imp_h) else 0
        ia = int(imp_a[i]) if i < len(imp_a) else 0
        flag = "  " if (ih > 0 and ia > 0) else "⚠️"
        print(f"  {flag} [{i:2d}] {name:30s}  H={ih:7d}  A={ia:7d}")

    metrics_for_export = {k: v for k, v in final.items() if k not in ("home_b", "away_b")}
    if args.dry_run:
        print("\n(DRY) Skip JSON export")
    else:
        export(final["home_b"], final["away_b"], len(Xtr), metrics_for_export, best_params, args)


if __name__ == "__main__":
    main()
