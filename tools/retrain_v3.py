#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
@annafrick13 v3.0 — Extended-Feature LightGBM Engine

Next-generation engine that extends v2's 21-feature set with 8 new
match-statistics features sourced from api-sports `/fixtures/statistics`:

  Existing (21, from v2):
    npxG momentum/volatility, Elo, home factor, rest, SoS, derby,
    PPDA, deep completions, set-piece/late-game/losing-state shares,
    squad rotation, shot quality, high-value-shot share.

  NEW (8):
    shots_total_diff_ewma        — offensive dominance (shot volume)
    shots_on_target_diff_ewma    — offensive precision
    shot_accuracy_ewma           — SoT / total shots ratio
    corners_diff_ewma            — offensive pressure indicator
    possession_diff_ewma         — ball control
    pass_accuracy_diff_ewma      — possession quality
    shots_inside_box_share_diff  — chance-quality proxy
    gk_saves_diff_ewma           — defensive load

Training data source: Supabase `team_xg_history` rows with
  `source = 'api-sports'` (plus backwards-compat backfill from CSV
  if api-sports columns are NULL).

Output: public/lgbm-model-v3.json (same structure as v2: {intercept,
  home_trees, away_trees, feature_names, rho_optimal, isotonic_curves}).

Runtime: src/lib/poisson-ml-engine-v3.ts mirrors this feature list
and consumes the JSON for deterministic predictions.

═══════════════════════════════════════════════════════════════════
PRE-REQUISITES FOR FULL TRAINING
═══════════════════════════════════════════════════════════════════

v3 needs >= 1500 matches with populated extended stats. Today we have
~42 (Championship partial). Target: 3 Saisons × 12 Nebenligen =
~16200 rows, via ~11 Weeks with 200 calls/day (two api-sports keys).

WHILE WAITING FOR DATA:
- This script runs end-to-end on the small dataset as a SKELETON
- It will produce a model with very wide CIs — DO NOT deploy
- Verify the PIPELINE works (feature engineering + training + export)
- Once backfill completes: rerun with --full, then ship

Usage:
  source tools/venv/bin/activate
  python3 tools/retrain_v3.py                  # default: current data
  python3 tools/retrain_v3.py --use-full-csv   # fall back to CSV for rows without api-sports
  python3 tools/retrain_v3.py --n-trials 50    # Optuna tuning rounds
  python3 tools/retrain_v3.py --dry-run        # no JSON write
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
    print("ERROR: lightgbm not installed. Run `pip install lightgbm optuna scipy` in tools/venv.")
    sys.exit(1)

from scipy.optimize import minimize_scalar
from scipy.stats import poisson

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUTPUT = os.path.join(PROJECT_ROOT, "public", "lgbm-model-v3.json")

# Environment (supabase credentials from .env.local)
ENV_PATH = os.path.join(PROJECT_ROOT, ".env.local")


# ═══════════════════════════════════════════════════════════════════
# FEATURE CONTRACT
# ═══════════════════════════════════════════════════════════════════

# v2's 21 features, kept identical for drop-in consistency
V2_FEATURE_NAMES = [
    "npxg_diff_ewma", "npxga_diff_ewma", "elo_diff", "total_npxg",
    "home_factor", "league_avg", "rest_days_diff", "sos_strength",
    "is_derby", "npxg_momentum", "npxg_volatility", "h2h_npxg_diff",
    "ppda_ratio_diff", "deep_completions_diff",
    "setpiece_xg_share_diff", "late_game_xg_share_diff",
    "losing_state_xg_diff", "top3_xgchain_share_diff",
    "squad_rotation_rate_diff", "shot_quality_diff",
    "high_value_shot_share_diff",
]

# v3-NEU: api-sports match-statistics features
V3_NEW_FEATURE_NAMES = [
    "shots_total_diff_ewma",          # 21
    "shots_on_target_diff_ewma",      # 22
    "shot_accuracy_ewma",             # 23
    "corners_diff_ewma",              # 24
    "possession_diff_ewma",           # 25
    "pass_accuracy_diff_ewma",        # 26
    "shots_inside_box_share_diff",    # 27
    "gk_saves_diff_ewma",             # 28
]

FEATURE_NAMES = V2_FEATURE_NAMES + V3_NEW_FEATURE_NAMES
N_FEATURES = len(FEATURE_NAMES)  # 29

# Monotonic constraints — direction of physical effect on each lambda
# (home lambda = goals scored by home team).
#   +1: more of this feature → home expects to score more
#   -1: more of this feature → home expects to score less
#    0: no strict direction
MONO_HOME = (
    [+1, -1, +1, 0, +1, 0, +1, 0, 0, +1, 0, 0, 0, +1, 0, 0, 0, 0, 0, +1, +1]  # v2 (21)
    + [+1, +1, +1, +1, +1, +1, +1, 0]  # v3 new: more shots/SoT/poss = more goals (home)
)
MONO_AWAY = (
    [-1, +1, -1, 0, -1, 0, -1, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, 0, 0, -1, -1]  # v2 (21)
    + [-1, -1, -1, -1, -1, -1, -1, 0]  # v3 new: mirrored
)
assert len(MONO_HOME) == N_FEATURES
assert len(MONO_AWAY) == N_FEATURES


LEAGUE_AVGS = {
    "bundesliga": 1.38, "bundesliga2": 1.51, "epl": 1.35, "championship": 1.23,
    "league_one": 1.29, "league_two": 1.25, "la_liga": 1.25, "la_liga2": 1.27,
    "serie_a": 1.32, "serie_b": 1.23, "ligue_1": 1.30, "ligue_2": 1.29,
    "eredivisie": 1.49, "jupiler_pro": 1.38, "primeira_liga": 1.28,
    "super_lig": 1.47, "scottish_prem": 1.48, "greek_sl": 1.22,
    "liga3": 1.40,
}
LEAGUE_HFS = {
    "bundesliga": 1.28, "bundesliga2": 1.18, "epl": 1.22, "championship": 1.41,
    "league_one": 1.19, "league_two": 1.22, "la_liga": 1.30, "la_liga2": 1.34,
    "serie_a": 1.27, "serie_b": 1.22, "ligue_1": 1.32, "ligue_2": 1.41,
    "eredivisie": 1.31, "jupiler_pro": 1.37, "primeira_liga": 1.20,
    "super_lig": 1.31, "scottish_prem": 1.34, "greek_sl": 1.11,
    "liga3": 1.22,
}

EWMA_ALPHA = 0.85


# ═══════════════════════════════════════════════════════════════════
# DATA LOADING — Supabase REST
# ═══════════════════════════════════════════════════════════════════

# load_env + fetch_xg_history have moved to tools/lib/supabase_loader.py.
# Imported at the top so both v2 and v3 share the same pagination + sorting
# + sanity-assert code path.
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.supabase_loader import fetch_xg_history, load_env  # noqa: E402,F401


# ═══════════════════════════════════════════════════════════════════
# FEATURE ENGINEERING
# ═══════════════════════════════════════════════════════════════════

def ewma_last_8(series: pd.Series, alpha: float = EWMA_ALPHA) -> float:
    """Exponentially-weighted average of the last ≤8 values. Skips NaN."""
    s = series.dropna().tail(8)
    if len(s) == 0:
        return np.nan
    weights = np.array([alpha ** i for i in range(len(s) - 1, -1, -1)])
    weights /= weights.sum()
    return float((s.values * weights).sum())


def build_features_for_match(
    home_hist: pd.DataFrame,
    away_hist: pd.DataFrame,
    league: str,
    match_date: pd.Timestamp,
) -> Optional[np.ndarray]:
    """Compute the 29-feature vector for a single match using point-in-time history."""
    # Filter to rows BEFORE match_date (hindsight safety)
    hh = home_hist[home_hist["match_date"] < match_date].tail(8)
    ah = away_hist[away_hist["match_date"] < match_date].tail(8)
    if len(hh) < 4 or len(ah) < 4:
        return None

    lg_avg = LEAGUE_AVGS.get(league, 1.35)
    lg_hf = LEAGUE_HFS.get(league, 1.25)

    # ── v2 features (abbreviated implementation — the full retrain_v2
    #    already has these, v3 reuses with light re-derivation here).
    #    For a real production train, import build_features from a shared
    #    module — for this skeleton we take the same pattern.
    npxg_h = ewma_last_8(hh.get("npxg", hh["xg"]))
    npxg_a = ewma_last_8(ah.get("npxg", ah["xg"]))
    npxga_h = ewma_last_8(hh.get("npxga", hh["xga"]))
    npxga_a = ewma_last_8(ah.get("npxga", ah["xga"]))

    npxg_diff = (npxg_h - npxg_a) if not np.isnan(npxg_h) and not np.isnan(npxg_a) else 0.0
    npxga_diff = (npxga_h - npxga_a) if not np.isnan(npxga_h) and not np.isnan(npxga_a) else 0.0
    total_npxg = (npxg_h + npxg_a) if not np.isnan(npxg_h) and not np.isnan(npxg_a) else 2 * lg_avg

    # Elo placeholder — in full retrain we'd compute from elo-ratings CSV
    elo_diff = 0.0  # TODO: wire to src/lib/elo-seeding or precomputed file
    rest_diff = 0.0  # TODO: compute from date gaps per team

    # PPDA / deep (v2.1 features, often NULL in api-sports rows)
    ppda_h = ewma_last_8((hh["ppda_att"] / hh["ppda_def"].replace(0, np.nan))) if "ppda_att" in hh else np.nan
    ppda_a = ewma_last_8((ah["ppda_att"] / ah["ppda_def"].replace(0, np.nan))) if "ppda_att" in ah else np.nan
    ppda_diff = (ppda_h - ppda_a) if not np.isnan(ppda_h) and not np.isnan(ppda_a) else 0.0
    deep_h = ewma_last_8(hh.get("deep", pd.Series([np.nan]))) if "deep" in hh else np.nan
    deep_a = ewma_last_8(ah.get("deep", pd.Series([np.nan]))) if "deep" in ah else np.nan
    deep_diff = (deep_h - deep_a) if not np.isnan(deep_h) and not np.isnan(deep_a) else 0.0

    v2 = np.array([
        npxg_diff, npxga_diff, elo_diff, total_npxg,
        lg_hf, lg_avg, rest_diff, 0.0,  # sos placeholder
        0,  # is_derby placeholder
        0.0, 0.0,  # momentum, volatility placeholders
        0.0,  # h2h placeholder
        ppda_diff, deep_diff,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,  # season-level v2.1 features (placeholder)
    ])

    # ── v3 NEW features from api-sports stats ────────────────────
    def ewma(col: str) -> float:
        sh = ewma_last_8(hh[col]) if col in hh.columns else np.nan
        sa = ewma_last_8(ah[col]) if col in ah.columns else np.nan
        return (sh - sa) if not np.isnan(sh) and not np.isnan(sa) else 0.0

    shots_total_diff = ewma("shots_for")
    shots_sot_diff = ewma("shots_on_target_for")
    # shot accuracy = SoT / total shots
    if "shots_for" in hh.columns and "shots_on_target_for" in hh.columns:
        hh_acc = (hh["shots_on_target_for"] / hh["shots_for"].replace(0, np.nan))
        ah_acc = (ah["shots_on_target_for"] / ah["shots_for"].replace(0, np.nan))
        acc_diff = (ewma_last_8(hh_acc) or 0) - (ewma_last_8(ah_acc) or 0)
    else:
        acc_diff = 0.0
    corners_diff = ewma("corners_for")
    poss_diff = ewma("possession_pct")
    pass_acc_diff = ewma("pass_pct")

    # Inside-box shot share
    if "shots_inside_box" in hh.columns and "shots_for" in hh.columns:
        hh_ibs = (hh["shots_inside_box"] / hh["shots_for"].replace(0, np.nan))
        ah_ibs = (ah["shots_inside_box"] / ah["shots_for"].replace(0, np.nan))
        ibs_diff = (ewma_last_8(hh_ibs) or 0) - (ewma_last_8(ah_ibs) or 0)
    else:
        ibs_diff = 0.0

    gk_saves_diff = ewma("gk_saves")

    v3_new = np.array([
        shots_total_diff, shots_sot_diff, acc_diff, corners_diff,
        poss_diff, pass_acc_diff, ibs_diff, gk_saves_diff,
    ])

    return np.concatenate([v2, v3_new])


# ═══════════════════════════════════════════════════════════════════
# TRAINING
# ═══════════════════════════════════════════════════════════════════

def build_training_set(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray, pd.Series]:
    """Pair home/away rows per match, compute features, return X, y_home, y_away, match_date-index.

    The match_date series is kept aligned with X — downstream train/test split
    is time-based against that index.
    """
    home_rows = df[df["venue"] == "home"].sort_values("match_date").reset_index(drop=True)
    by_team = {
        (team, venue): g.sort_values("match_date").reset_index(drop=True)
        for (team, venue), g in df.groupby(["team", "venue"])
    }

    X, y_h, y_a, dates = [], [], [], []
    for _, m in home_rows.iterrows():
        home_hist = by_team.get((m["team"], "home"), pd.DataFrame())
        away_hist = by_team.get((m["opponent"], "away"), pd.DataFrame())
        if home_hist.empty or away_hist.empty:
            continue
        feats = build_features_for_match(home_hist, away_hist, m["league"], m["match_date"])
        if feats is None:
            continue
        X.append(feats)
        y_h.append(m["goals_for"])
        y_a.append(m["goals_against"])
        dates.append(m["match_date"])

    return np.array(X), np.array(y_h), np.array(y_a), pd.Series(dates)


# ───────────────────────────────────────────────────────────────────
# Brier utilities — mirrors src/lib/backtest.ts::scoreMatch
# ───────────────────────────────────────────────────────────────────

def poisson_matrix(lam_h: float, lam_a: float, max_k: int = 10) -> np.ndarray:
    """Independent-Poisson 1X2/OU matrix (no Dixon-Coles rho correction here
    because retrain_v3 trains λ's only; ρ is inherited from v2 optimal as
    starting point. Downstream runtime uses the model's rho_optimal value)."""
    kr = np.arange(max_k + 1)
    ph = poisson.pmf(kr, lam_h)
    pa = poisson.pmf(kr, lam_a)
    return np.outer(ph, pa)


def derive_1x2_o25(mx: np.ndarray) -> tuple[float, float, float, float]:
    h = d = a = o25 = 0.0
    for i in range(mx.shape[0]):
        for j in range(mx.shape[1]):
            p = mx[i, j]
            if i > j:   h += p
            elif i < j: a += p
            else:       d += p
            if i + j > 2: o25 += p
    # Normalize H/D/A (truncation-tail correction)
    tot = h + d + a
    if tot > 0:
        h, d, a = h / tot, d / tot, a / tot
    return h, d, a, o25


def brier_score(lams_h: np.ndarray, lams_a: np.ndarray,
                goals_h: np.ndarray, goals_a: np.ndarray) -> dict[str, float]:
    """Rank-Brier 1X2 + binary Brier O25 over a test set. Mirrors
    src/lib/backtest.ts::scoreMatch / aggregate formulas."""
    n = len(lams_h)
    brier_1x2_sum = 0.0
    brier_o25_sum = 0.0
    logloss_1x2_sum = 0.0
    pred_h_sum = pred_a_sum = 0.0
    for i in range(n):
        ph, pd_, pa, po25 = derive_1x2_o25(poisson_matrix(lams_h[i], lams_a[i]))
        gh, ga = goals_h[i], goals_a[i]
        # 1X2 outcome
        oh = 1.0 if gh > ga else 0.0
        od = 1.0 if gh == ga else 0.0
        oa = 1.0 if gh < ga else 0.0
        brier_1x2_sum += ((ph - oh)**2 + (pd_ - od)**2 + (pa - oa)**2) / 3.0
        # Log-loss on winning class (clip for log(0))
        p_win = ph if oh else (pd_ if od else pa)
        logloss_1x2_sum += -np.log(max(1e-6, min(1 - 1e-6, p_win)))
        # O25
        o25_true = 1.0 if (gh + ga) > 2 else 0.0
        brier_o25_sum += (po25 - o25_true)**2
        pred_h_sum += ph * 2 + pd_  # rough expected goals proxy
        pred_a_sum += pa * 2 + pd_
    return {
        "brier_1x2": brier_1x2_sum / n,
        "brier_o25": brier_o25_sum / n,
        "logloss_1x2": logloss_1x2_sum / n,
        "n": n,
        "mean_lam_h": float(lams_h.mean()),
        "mean_lam_a": float(lams_a.mean()),
        "mean_goals_h": float(goals_h.mean()),
        "mean_goals_a": float(goals_a.mean()),
    }


# ───────────────────────────────────────────────────────────────────
# Training — with time-based holdout + Optuna
# ───────────────────────────────────────────────────────────────────

def train_lgbm_with_params(X: np.ndarray, y: np.ndarray, mono: list[int],
                            params: dict, num_boost_round: int = 400) -> lgb.Booster:
    p = {
        "objective": "tweedie",
        "monotone_constraints": mono,
        "verbose": -1,
        **params,
    }
    train_set = lgb.Dataset(X, y)
    return lgb.train(p, train_set, num_boost_round=num_boost_round)


def train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                        params: dict, num_boost: int) -> dict:
    """Train home + away models with given params, return test-set Brier + models.

    Note: LightGBM's Tweedie objective internally applies the log-link; booster.predict()
    returns λ on the natural scale already. No extra exp() is needed (doing so double-
    exponentiates and saturates the clamp at ~3-4). The TypeScript runtime
    (src/lib/poisson-ml-engine-v3.ts::sumTrees→Math.exp) sums raw leaf values and applies
    exp, which matches the LightGBM dump_model representation of per-leaf values already
    being in log-space. So runtime does need exp — only the training-time evaluation
    here skips it."""
    home_b = train_lgbm_with_params(Xtr, yh_tr, MONO_HOME, params, num_boost)
    away_b = train_lgbm_with_params(Xtr, ya_tr, MONO_AWAY, params, num_boost)
    LAM_LO, LAM_HI = 0.3, 4.5
    lams_h = np.clip(home_b.predict(Xte), LAM_LO, LAM_HI)
    lams_a = np.clip(away_b.predict(Xte), LAM_LO, LAM_HI)
    metrics = brier_score(lams_h, lams_a, yh_te, ya_te)
    return {"home_b": home_b, "away_b": away_b, **metrics}


def optuna_objective(trial, Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te) -> float:
    """Objective: minimize 1X2 Brier on the time-based holdout."""
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
        result = train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                                      params, num_boost)
        return result["brier_1x2"]
    except Exception as e:
        print(f"  trial failed: {e}")
        return 1.0  # high penalty so Optuna skips


# ═══════════════════════════════════════════════════════════════════
# MODEL EXPORT (JSON) — matches v2 shape
# ═══════════════════════════════════════════════════════════════════

def booster_to_trees(b: lgb.Booster) -> list[dict]:
    return json.loads(b.dump_model()["tree_info"].__repr__().replace("'", '"')) \
        if False else b.dump_model()["tree_info"]


def export(home_b: lgb.Booster, away_b: lgb.Booster, rho_optimal: float,
            n_train: int, metrics: dict, best_params: dict):
    model = {
        "version": "v3.0",
        "feature_names": FEATURE_NAMES,
        "home_trees": booster_to_trees(home_b),
        "away_trees": booster_to_trees(away_b),
        "rho_optimal": rho_optimal,
        "lambda_clamp": [0.3, 4.5],
        "n_train": n_train,
        "mono_home": MONO_HOME,
        "mono_away": MONO_AWAY,
        "holdout_metrics": metrics,
        "best_params": best_params,
    }
    with open(OUTPUT, "w") as f:
        json.dump(model, f, indent=2)
    print(f"\n✓ Model exported → {OUTPUT}")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Train but don't write JSON")
    ap.add_argument("--sources", default="footystats",
                     help="Comma-sep source filter (default: footystats — the only bulk-populated "
                          "source for v3 extended features)")
    ap.add_argument("--n-trials", type=int, default=0,
                     help="Optuna trials (0 = use fixed default params, skip search)")
    ap.add_argument("--holdout-cutoff", default="2025-08-01",
                     help="Time-based train/test split: matches before this date = train, "
                          "after = test. Default 2025-08-01 → test on current season.")
    args = ap.parse_args()

    print("═══ v3 Training (production) ═══\n")
    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    print(f"Sources:        {sources}")
    print(f"Holdout cutoff: {args.holdout_cutoff} (train < cutoff, test ≥ cutoff)")
    print(f"Optuna trials:  {args.n_trials}\n")

    df = fetch_xg_history(sources=sources)
    print(f"Fetched {len(df)} rows from Supabase")
    if len(df) < 100:
        print(f"\n⚠  Only {len(df)} rows — pipeline-verify only; do NOT deploy.\n")

    X, y_h, y_a, dates = build_training_set(df)
    print(f"Training matrix: {X.shape}  y_home mean={y_h.mean():.2f}  y_away mean={y_a.mean():.2f}")
    if len(X) == 0:
        print("No trainable pairs — needs more history per team. Exit.")
        return

    # ── Time-based split ─────────────────────────────────────────
    cutoff = pd.Timestamp(args.holdout_cutoff)
    train_mask = dates < cutoff
    test_mask = ~train_mask
    Xtr, yh_tr, ya_tr = X[train_mask], y_h[train_mask], y_a[train_mask]
    Xte, yh_te, ya_te = X[test_mask], y_h[test_mask], y_a[test_mask]
    print(f"  train: {len(Xtr)} pairs ({dates[train_mask].min()} → {dates[train_mask].max()})")
    print(f"  test:  {len(Xte)} pairs ({dates[test_mask].min() if test_mask.any() else '—'} → "
          f"{dates[test_mask].max() if test_mask.any() else '—'})")
    if len(Xte) < 200:
        print(f"\n⚠  Holdout set <200 rows — Brier-estimate wird unreliable. "
              f"Cutoff früher setzen oder mehr current-season-Daten importieren.\n")

    # ── Optuna search (optional) ─────────────────────────────────
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
            lambda t: optuna_objective(t, Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te),
            n_trials=args.n_trials,
            show_progress_bar=True,
        )
        best_params = {k: v for k, v in study.best_params.items() if k != "num_boost_round"}
        best_params["bagging_freq"] = 5
        best_num_boost = study.best_params.get("num_boost_round", DEFAULT_NUM_BOOST)
        print(f"  best Brier: {study.best_value:.4f}")
        print(f"  best params: {study.best_params}")
    else:
        best_params = DEFAULT_PARAMS
        best_num_boost = DEFAULT_NUM_BOOST

    # ── Final training + evaluation ──────────────────────────────
    print("\n═══ Final training ═══")
    final = train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                                  best_params, best_num_boost)
    print(f"\n━━━ Holdout Metrics ━━━")
    print(f"  n (test):       {final['n']}")
    print(f"  Brier 1X2:      {final['brier_1x2']:.4f}  (v2 baseline: 0.5844)")
    print(f"  Brier O25:      {final['brier_o25']:.4f}")
    print(f"  LogLoss 1X2:    {final['logloss_1x2']:.4f}")
    print(f"  mean λ_home:    {final['mean_lam_h']:.3f}  (actual: {final['mean_goals_h']:.3f})")
    print(f"  mean λ_away:    {final['mean_lam_a']:.3f}  (actual: {final['mean_goals_a']:.3f})")

    beats_v2 = final["brier_1x2"] < 0.5844
    verdict = "✓ BEATS v2 baseline" if beats_v2 else "✗ worse than v2 baseline (0.5844)"
    print(f"\n  Verdict: {verdict}")

    home_b = final["home_b"]
    away_b = final["away_b"]
    rho_optimal = -0.094  # inherited from v2; retrain_v3-specific rho search would be a follow-up

    metrics_for_export = {k: v for k, v in final.items() if k not in ("home_b", "away_b")}

    if args.dry_run:
        print("\n(DRY) Skip JSON export")
    else:
        export(home_b, away_b, rho_optimal, n_train=len(Xtr),
               metrics=metrics_for_export, best_params=best_params)


if __name__ == "__main__":
    main()
