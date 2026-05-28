"""
Stage 1.m3_blended — Evaluate dev-06 Option C blended predictor on 25/26 holdout.

Architecture comparison:
  • dev-03 lean alone (baseline)
  • dev-06 = lean + premium blended via coverage_router

Pass-criterion (Sprint 3 Money-Gate is in stage_5, this is the Brier-Gate):
  Blended Brier (Tier-A subset, 25/26) ≤ dev-03 Brier - 0.001
  (small improvement required — large would be suspicious given the premium
  side only contributes weight≤0.7 on 7 leagues)

Run:
  tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m3_blended.py
  tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m3_blended.py --tag dev-06-premium
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.eval.metrics import brier_multiclass, log_loss
from v4.modules.m3_xg import XGPredictor
from v4.modules.m3_xg.bayesian_ensemble import BayesianEnsemble
from v4.modules.m3_xg.blended_predictor import BlendedPredictor

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"

# Always-premium 7 leagues — only matches in these route through premium path
TIER_A_LEAGUES = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "championship", "liga3")


def fuzzy_team_normalize(s: str) -> str:
    """Mirror of train_m3_premium.py."""
    import unicodedata
    if not s:
        return ""
    s_norm = "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )
    tokens = s_norm.lower().split()
    PREFIXES = {"afc", "fc", "sc", "ac", "vfl", "vfb", "tsg", "rb", "1.",
                "rcd", "sd", "ud", "ca", "us", "ssc", "as", "ssd"}
    while tokens and tokens[0] in PREFIXES:
        tokens.pop(0)
    return "".join(tokens)


def bridge_game_ids(match_pairs: pd.DataFrame) -> pd.DataFrame:
    """Add a game_id column by joining to sofascore_match on (league, date, home, away).

    Uses the same fuzzy_team_normalize as train_m3_premium.py for consistency
    (else we'd have a train-vs-eval distribution shift on the bridge).
    """
    with sqlite3.connect(LOCAL_DB) as con:
        sql = """
            SELECT game_id, league,
                   DATE(start_timestamp, 'unixepoch') AS md,
                   home_team, away_team
            FROM sofascore_match
            WHERE season IN ('25/26')
              AND status = 'Ended'
        """
        sofa = pd.read_sql_query(sql, con)
    sofa_index = {
        (row.league, row.md,
         fuzzy_team_normalize(row.home_team),
         fuzzy_team_normalize(row.away_team)): row.game_id
        for row in sofa.itertuples()
    }
    out = match_pairs.copy()
    out["match_date_str"] = out["match_date"].dt.strftime("%Y-%m-%d")
    out["home_norm"] = out["home"].apply(fuzzy_team_normalize)
    out["away_norm"] = out["away"].apply(fuzzy_team_normalize)
    out["game_id"] = out.apply(
        lambda r: sofa_index.get(
            (r["league"], r["match_date_str"], r["home_norm"], r["away_norm"])
        ),
        axis=1,
    )
    out = out.drop(columns=["match_date_str", "home_norm", "away_norm"])
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--lean-tag", default="dev-03",
                   help="Tag for lean artifacts (default dev-03)")
    p.add_argument("--premium-tag", default="dev-06-premium",
                   help="Tag for premium artifacts (default dev-06-premium)")
    p.add_argument("--holdout-since", default="2025-08-01",
                   help="Holdout start date (default 2025-08-01 = 25/26 start)")
    p.add_argument("--tier-a-only", action="store_true",
                   help="Restrict eval to the 7 always-premium leagues (default off)")
    args = p.parse_args()

    print("=" * 70)
    print(f"Stage 1.m3_blended · lean={args.lean_tag} + premium={args.premium_tag}")
    print("=" * 70)

    # ── Load artifacts ──
    home_lean = ARTIFACTS_DIR / f"m3_xg-home-{args.lean_tag}.pkl"
    away_lean = ARTIFACTS_DIR / f"m3_xg-away-{args.lean_tag}.pkl"
    home_prem = ARTIFACTS_DIR / f"m3_xg-home-{args.premium_tag}.pkl"
    away_prem = ARTIFACTS_DIR / f"m3_xg-away-{args.premium_tag}.pkl"
    for p_ in (home_lean, away_lean, home_prem, away_prem):
        if not p_.exists():
            print(f"❌ Missing: {p_}")
            return 1
    ens_lean_h = BayesianEnsemble.load(home_lean)
    ens_lean_a = BayesianEnsemble.load(away_lean)
    ens_prem_h = BayesianEnsemble.load(home_prem)
    ens_prem_a = BayesianEnsemble.load(away_prem)
    lean_pred = XGPredictor(ensemble_home=ens_lean_h, ensemble_away=ens_lean_a)
    blended = BlendedPredictor(
        lean=lean_pred, premium_home=ens_prem_h, premium_away=ens_prem_a,
    )
    print(f"  artifacts loaded ✓")

    # ── Load holdout match_pairs (25/26) ──
    history = load_team_xg_history()
    leagues = list(TIER_A_LEAGUES) if args.tier_a_only else None
    holdout = load_match_pairs(
        since=args.holdout_since,
        leagues=leagues,
    ).dropna(subset=["home_goals", "away_goals"])
    print(f"  holdout matches: {len(holdout):,}  "
          f"({'Tier-A only' if args.tier_a_only else 'ALL leagues'})")

    # ── Bridge game_ids ──
    holdout = bridge_game_ids(holdout)
    n_with_gid = int(holdout["game_id"].notna().sum())
    print(f"  game_ids bridged: {n_with_gid:,} / {len(holdout):,} "
          f"({100*n_with_gid/len(holdout):.1f}%)")

    # ── Predict with blended predictor ──
    print(f"\n  Running BlendedPredictor.predict_batch...")
    pred = blended.predict_batch(holdout, history, verbose=True)
    print(f"  predictions: {len(pred):,} rows")
    print(f"  premium_tier breakdown:")
    for tier, n in pred["premium_tier"].value_counts().items():
        print(f"    {tier:<25s} {n:,}")

    # ── Compute Brier 1X2 (lean vs blended) ──
    # Build ground-truth: outcome ∈ {H, D, A} → one-hot index
    def outcome_to_idx(home_goals, away_goals):
        if home_goals > away_goals: return 0  # H
        if home_goals < away_goals: return 2  # A
        return 1  # D
    holdout = holdout.reset_index(drop=True)
    pred = pred.reset_index(drop=True)
    y_true = np.array([outcome_to_idx(h, a) for h, a in zip(
        holdout["home_goals"], holdout["away_goals"]
    )])

    y_pred_lean = pred[["prob_h_lean", "prob_d_lean", "prob_a_lean"]].values
    y_pred_blend = pred[["prob_h", "prob_d", "prob_a"]].values

    brier_lean = brier_multiclass(y_true, y_pred_lean)
    brier_blend = brier_multiclass(y_true, y_pred_blend)
    delta = brier_blend - brier_lean

    # Restrict to premium-routed rows for a "where it matters" view
    prem_mask = pred["premium_weight"] > 0
    if prem_mask.sum() > 0:
        brier_lean_prem = brier_multiclass(
            y_true[prem_mask], y_pred_lean[prem_mask],
        )
        brier_blend_prem = brier_multiclass(
            y_true[prem_mask], y_pred_blend[prem_mask],
        )
        delta_prem = brier_blend_prem - brier_lean_prem
    else:
        brier_lean_prem = brier_blend_prem = delta_prem = float("nan")

    print()
    print("=" * 70)
    print(f"Brier 1X2 results (n={len(holdout):,} matches)")
    print("=" * 70)
    print(f"  {'all matches':<35s}  lean={brier_lean:.4f}  blend={brier_blend:.4f}  Δ={delta:+.4f}")
    print(f"  {'premium-routed only (w>0)':<35s}  lean={brier_lean_prem:.4f}  blend={brier_blend_prem:.4f}  Δ={delta_prem:+.4f}  (n={int(prem_mask.sum())})")
    print()

    # Pass / fail decision
    GATE = 0.001  # protocol: Δ ≤ -0.001 = pass
    passed = delta_prem <= -GATE
    if passed:
        print(f"  ✅ PASS · blended Brier on premium-routed subset improved by "
              f"{abs(delta_prem)*100:.2f}pp (gate: 0.10pp)")
    else:
        print(f"  ⚠ NOT PASSED · delta_prem={delta_prem:+.4f} > -{GATE} threshold")
        if delta_prem >= 0:
            print(f"    Blended is worse than lean on the premium subset.")
        else:
            print(f"    Improvement too small to justify added complexity.")

    print()
    print("Next: Sprint 3.D = Stage 5 Goldilocks ROI eval")
    return 0


if __name__ == "__main__":
    sys.exit(main())
