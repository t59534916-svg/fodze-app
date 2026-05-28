#!/usr/bin/env python3
"""
Diagnostic: blend-weight sweep over dev-06 to find the optimal mixture.

Stage 1 result (2026-05-21) showed default weight=0.7 makes Brier WORSE
than lean (Δ=+0.0042). This sweep tries [0.0, 0.1, 0.2, 0.3, 0.5, 0.7]
to find the weight (if any) where blended beats lean.

If best weight = 0.0 → premium adds pure noise → archive dev-06-premium.
If best weight ∈ (0, 0.3] → small specialist contribution → re-evaluate with
  the dampened router weights.

Run: tools/venv/bin/python3 tools/v4/diagnostics/dev06_weight_sweep.py
"""
import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.eval.metrics import brier_multiclass
from v4.modules.m3_xg import XGPredictor
from v4.modules.m3_xg.bayesian_ensemble import BayesianEnsemble
from v4.modules.m3_xg.blended_predictor import BlendedPredictor

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts"
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"

TIER_A = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "championship", "liga3")
WEIGHTS_TO_TRY = [0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7]


def fuzzy_team_normalize(s):
    import unicodedata
    if not s: return ""
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    tokens = s.lower().split()
    PREFIXES = {"afc", "fc", "sc", "ac", "vfl", "vfb", "tsg", "rb", "1.",
                "rcd", "sd", "ud", "ca", "us", "ssc", "as", "ssd"}
    while tokens and tokens[0] in PREFIXES:
        tokens.pop(0)
    return "".join(tokens)


def bridge_game_ids(pairs):
    with sqlite3.connect(LOCAL_DB) as con:
        sofa = pd.read_sql_query(
            "SELECT game_id, league, DATE(start_timestamp,'unixepoch') AS md, "
            "home_team, away_team FROM sofascore_match "
            "WHERE season='25/26' AND status='Ended'", con,
        )
    idx = {
        (r.league, r.md, fuzzy_team_normalize(r.home_team), fuzzy_team_normalize(r.away_team)):
        r.game_id for r in sofa.itertuples()
    }
    out = pairs.copy()
    out["match_date_str"] = out["match_date"].dt.strftime("%Y-%m-%d")
    out["game_id"] = out.apply(lambda r: idx.get(
        (r["league"], r["match_date_str"],
         fuzzy_team_normalize(r["home"]), fuzzy_team_normalize(r["away"]))
    ), axis=1)
    return out.drop(columns=["match_date_str"])


def main():
    print("=" * 70)
    print("dev-06 blend-weight sweep")
    print("=" * 70)

    # Load artifacts
    lean_h = BayesianEnsemble.load(ARTIFACTS / "m3_xg-home-dev-03.pkl")
    lean_a = BayesianEnsemble.load(ARTIFACTS / "m3_xg-away-dev-03.pkl")
    prem_h = BayesianEnsemble.load(ARTIFACTS / "m3_xg-home-dev-06-premium.pkl")
    prem_a = BayesianEnsemble.load(ARTIFACTS / "m3_xg-away-dev-06-premium.pkl")
    lean = XGPredictor(ensemble_home=lean_h, ensemble_away=lean_a)
    blender = BlendedPredictor(lean=lean, premium_home=prem_h, premium_away=prem_a)
    print("  artifacts loaded ✓")

    # Holdout
    history = load_team_xg_history()
    holdout = load_match_pairs(since="2025-08-01", leagues=list(TIER_A)).dropna(
        subset=["home_goals", "away_goals"]
    )
    holdout = bridge_game_ids(holdout).reset_index(drop=True)
    print(f"  holdout: {len(holdout):,} matches  ({holdout['game_id'].notna().sum():,} with game_id)")

    # Predict ONCE — gives us lean + premium per-match probs
    print("  running predict_batch ...")
    pred = blender.predict_batch(holdout, history).reset_index(drop=True)

    # Build y_true
    def y_idx(h, a):
        return 0 if h > a else (2 if h < a else 1)
    y_true = np.array([y_idx(h, a) for h, a in zip(holdout["home_goals"], holdout["away_goals"])])

    lean_probs = pred[["prob_h_lean", "prob_d_lean", "prob_a_lean"]].values
    prem_probs_raw = pred[["prob_h_premium", "prob_d_premium", "prob_a_premium"]].values

    # For rows where premium was NaN (no game_id), fall back to lean for the blend
    premium_mask = pred["game_id"].notna() if "game_id" in pred.columns else pd.notna(prem_probs_raw[:, 0])
    if hasattr(premium_mask, "values"):
        premium_mask = premium_mask.values
    # Replace NaN rows in premium with lean (so blend at weight=0.7 doesn't NaN)
    prem_probs = np.where(np.isnan(prem_probs_raw), lean_probs, prem_probs_raw)

    brier_lean = brier_multiclass(y_true, lean_probs)
    print()
    print(f"Baseline lean Brier on Tier-A 25/26: {brier_lean:.4f}")
    print()
    print(f"{'weight':>8s} {'Brier':>10s} {'Δ vs lean':>12s} {'verdict':<20s}")
    print("-" * 56)
    best_w, best_brier = 0.0, brier_lean
    for w in WEIGHTS_TO_TRY:
        blended = w * prem_probs + (1 - w) * lean_probs
        # Only apply blend where premium was available (else stay lean)
        blended[~premium_mask] = lean_probs[~premium_mask]
        b = brier_multiclass(y_true, blended)
        delta = b - brier_lean
        if b < best_brier:
            best_brier, best_w = b, w
        verdict = "✅ best so far" if w == best_w and b < brier_lean else (
            "= lean" if w == 0 else ("⚠ worse" if delta > 0 else "ok"))
        print(f"  {w:>5.2f}   {b:.4f}     {delta:+.4f}    {verdict}")

    print()
    print("=" * 70)
    if best_w == 0.0:
        print(f"  ✗ BEST = lean alone (weight 0.0). Premium adds noise on this holdout.")
        print(f"    Recommend: archive dev-06-premium + revisit feature engineering")
    elif best_brier < brier_lean - 0.001:
        print(f"  ✅ BEST = weight {best_w} → Brier {best_brier:.4f} "
              f"(Δ {best_brier - brier_lean:+.4f})")
        print(f"    Recommend: re-calibrate coverage_router weights to ~{best_w:.2f} for premium-stable tier")
    else:
        print(f"  ⚠ BEST = weight {best_w} → Brier {best_brier:.4f} "
              f"(Δ {best_brier - brier_lean:+.4f}) — improvement < 0.001 gate")
        print(f"    Recommend: archive (improvement too small to justify complexity)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
