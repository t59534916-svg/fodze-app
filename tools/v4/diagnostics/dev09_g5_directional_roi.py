#!/usr/bin/env python3
"""dev-09 G5 directional ROI on 25/26 Pinnacle holdout.

Phase 4.3 of D4 sprint. Audit committee binding 2026-05-28:
  "Mean ROI > Pinnacle Vig (~2.5-3%). KEINE unlösbare CI > 0% Hürde, nur
   direktionale Profitabilität."

Why directional-only (audit-binding):
  Empirical σ_per_bet = 148% (re-audit 2026-05-25). SE at n=800 = 5.23%,
  95% CI margin = ±10.25%. Requiring CI lower bound > 0% means demanding
  sustained ROI > 10.25% in a hyper-liquid Pinnacle market — false-negative
  trap. Statistical significance lives in G4 (Brier σ=0.000456). G5 becomes
  directional profitability check only.

Algorithm:
  1. Build dev-09 25/26 predictions via FeatureBuilderDev09
  2. Join to tools/backtest/odds-close-25-26.parquet via match_key
  3. Vig-remove Pinnacle odds → fair-market probs
  4. Flat-stake bet whenever dev-09 prob > market_implied (positive-EV vs raw odds)
  5. Compute: total_profit, ROI%, mean_odds_taken, n_bets, win_rate
  6. PASS criterion: mean ROI > Pinnacle vig (~2.5-3%)

Output:
  tools/v4/diagnostics/dev09_g5_directional_roi.json

Run:
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_g5_directional_roi.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_g5_directional_roi.py \
    --dev09-tag dev-09-phase42-seed-000 --min-edge 0.02
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO
from v4.modules.m3_xg.feature_builder_dev09 import (
    DEV_09_NUMERIC_FEATURES,
    FeatureBuilderDev09,
    extract_X_dev09,
)
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
ODDS_PARQUET = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_g5_directional_roi.json"

LAMBDA_MIN = 0.05
LAMBDA_MAX = 6.0

# Audit-binding G5 thresholds
PINNACLE_VIG_FLOOR = 0.025  # 2.5% — lower bound of typical vig
PINNACLE_VIG_CEILING = 0.030  # 3.0%


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def vig_remove_1x2(psch: float, pscd: float, psca: float) -> tuple:
    """Vig-removed Pinnacle 1X2 probabilities + total vig.

    Pinnacle uses proportional vig-removal in our project convention.
    """
    if any(o <= 1 or np.isnan(o) for o in (psch, pscd, psca)):
        return (np.nan, np.nan, np.nan, np.nan)
    raw_h = 1.0 / psch
    raw_d = 1.0 / pscd
    raw_a = 1.0 / psca
    s = raw_h + raw_d + raw_a
    vig = s - 1.0
    return (raw_h / s, raw_d / s, raw_a / s, float(vig))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--dev09-tag", default="dev-09-phase42-seed-000")
    p.add_argument("--test-seasons", default="25/26")
    p.add_argument("--min-edge", type=float, default=0.0,
                   help="Min edge in percentage points (e.g. 0.02 = bet only when "
                        "dev-09 prob exceeds market-implied by ≥ 2pp). Default 0 "
                        "(any positive edge).")
    p.add_argument("--rho", type=float, default=DEFAULT_RHO)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    test_seasons = tuple(args.test_seasons.split(","))

    print("═" * 70)
    print(f"dev-09 G5 DIRECTIONAL ROI · {test_seasons} vs Pinnacle Closing")
    print("═" * 70)
    print(f"  dev-09 tag: {args.dev09_tag}")
    print(f"  Min edge:   {args.min_edge*100:.1f}pp")
    print(f"  ρ:          {args.rho:+.4f}")
    print(f"  PASS criterion: mean ROI > Pinnacle vig (~{PINNACLE_VIG_FLOOR*100}-{PINNACLE_VIG_CEILING*100}%)")
    print()

    # ─── Load dev-09 ───
    d09_home = ARTIFACTS_DIR / f"m3_xg-home-{args.dev09_tag}.pkl"
    d09_away = ARTIFACTS_DIR / f"m3_xg-away-{args.dev09_tag}.pkl"
    if not d09_home.exists() or not d09_away.exists():
        print(f"  ✗ Missing dev-09 pickles for tag={args.dev09_tag}")
        return 1
    d09_h = BayesianEnsemble.load(d09_home)
    d09_a = BayesianEnsemble.load(d09_away)

    # ─── Load Pinnacle closing odds ───
    if not ODDS_PARQUET.exists():
        print(f"  ✗ Missing parquet: {ODDS_PARQUET}")
        return 1
    odds_df = pd.read_parquet(ODDS_PARQUET)
    print(f"  Loaded Pinnacle closing: {len(odds_df):,} rows in {ODDS_PARQUET.name}")

    # ─── Build dev-09 holdout ───
    print(f"  Building dev-09 holdout via FeatureBuilderDev09...")
    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    test_df = fb.build_corpus(seasons=test_seasons, leagues=None, verbose=True)

    # ─── Canonicalize Sofa team names + build match_key for join ───
    test_df["canonical_home"] = test_df.apply(
        lambda r: canonical_team(r["home_team"], r["league"]), axis=1
    )
    test_df["canonical_away"] = test_df.apply(
        lambda r: canonical_team(r["away_team"], r["league"]), axis=1
    )
    test_df["match_date_d"] = pd.to_datetime(test_df["match_date"]).dt.strftime("%Y-%m-%d")
    # match_key convention used in odds-close-25-26.parquet:
    #   "{league}|{home_team}|{away_team}|{YYYY-MM-DD}"
    # (canonical names on both sides — bridge via canonical_team()).
    test_df["match_key"] = (
        test_df["league"].astype(str) + "|" +
        test_df["canonical_home"] + "|" +
        test_df["canonical_away"] + "|" +
        test_df["match_date_d"]
    )

    # ─── Predict dev-09 ───
    print(f"  Predicting dev-09 on n={len(test_df):,}...")
    X_test = extract_X_dev09(test_df)
    X_aligned_h = X_test[d09_h.feature_names]
    X_aligned_a = X_test[d09_a.feature_names]
    mean_h, _ = d09_h.predict(X_aligned_h)
    mean_a, _ = d09_a.predict(X_aligned_a)
    lambda_h = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    lambda_a = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)

    n_total = len(test_df)
    p_h = np.empty(n_total)
    p_d = np.empty(n_total)
    p_a = np.empty(n_total)
    for i in range(n_total):
        try:
            M = DixonColesModel(lambda_h[i], lambda_a[i], rho=args.rho).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lambda_h[i], lambda_a[i]).matrix(normalize=True)
        p1 = get_1x2(M)
        p_h[i] = p1["H"]
        p_d[i] = p1["D"]
        p_a[i] = p1["A"]
    test_df["prob_h"] = p_h
    test_df["prob_d"] = p_d
    test_df["prob_a"] = p_a

    # ─── Canonicalize Pinnacle team names + rebuild match_key on that side ───
    # The parquet's match_key uses RAW Pinnacle team names which differ from
    # Sofa raw names. Canonicalize both sides via canonical_team() so a single
    # canonical key joins everything.
    odds_df = odds_df.copy()
    odds_df["match_date_d"] = pd.to_datetime(odds_df["match_date"]).dt.strftime("%Y-%m-%d")
    odds_df["canonical_home"] = odds_df.apply(
        lambda r: canonical_team(r["home_team"], r["league"]), axis=1
    )
    odds_df["canonical_away"] = odds_df.apply(
        lambda r: canonical_team(r["away_team"], r["league"]), axis=1
    )
    odds_df["canonical_match_key"] = (
        odds_df["league"].astype(str) + "|" +
        odds_df["canonical_home"] + "|" +
        odds_df["canonical_away"] + "|" +
        odds_df["match_date_d"]
    )
    # Rename test_df.match_key for clarity then rename odds to align
    test_df = test_df.rename(columns={"match_key": "canonical_match_key"})

    # ─── Join to Pinnacle via CANONICAL match_key ───
    joined = test_df.merge(
        odds_df[["canonical_match_key", "psch", "pscd", "psca"]],
        on="canonical_match_key", how="inner",
    )
    # Restore .match_key alias for downstream code that references it
    joined["match_key"] = joined["canonical_match_key"]
    print(f"  Joined to Pinnacle: {len(joined):,} of {len(test_df):,} matches "
          f"({len(joined)/len(test_df)*100:.1f}%)")
    if len(joined) < 50:
        print(f"  ✗ Insufficient join (n={len(joined)}). Check match_key convention.")
        return 1

    # ─── Vig-removal + edge calc ───
    vig_results = joined.apply(
        lambda r: vig_remove_1x2(r["psch"], r["pscd"], r["psca"]), axis=1
    )
    joined["fair_h"] = [v[0] for v in vig_results]
    joined["fair_d"] = [v[1] for v in vig_results]
    joined["fair_a"] = [v[2] for v in vig_results]
    joined["vig"] = [v[3] for v in vig_results]

    # Drop any with NaN fair odds
    joined = joined.dropna(subset=["fair_h", "fair_d", "fair_a"]).reset_index(drop=True)

    # Market-implied prob (with vig — i.e. 1/odds, not fair). This is what we bet against.
    joined["market_imp_h"] = 1.0 / joined["psch"]
    joined["market_imp_d"] = 1.0 / joined["pscd"]
    joined["market_imp_a"] = 1.0 / joined["psca"]

    # Edge per outcome = model prob - market implied
    joined["edge_h"] = joined["prob_h"] - joined["market_imp_h"]
    joined["edge_d"] = joined["prob_d"] - joined["market_imp_d"]
    joined["edge_a"] = joined["prob_a"] - joined["market_imp_a"]

    # Outcome (0=H, 1=D, 2=A)
    joined["outcome"] = [_outcome_label(h, a)
                          for h, a in zip(joined["home_goals"], joined["away_goals"])]

    mean_vig = float(joined["vig"].mean())
    print(f"  Mean Pinnacle vig: {mean_vig*100:.2f}%  (range: "
          f"{joined['vig'].min()*100:.2f}-{joined['vig'].max()*100:.2f}%)")
    print()

    # ─── Flat-stake simulation: bet each outcome whenever edge > min-edge ───
    bets = []
    for _, r in joined.iterrows():
        for outcome_idx, (label, prob_col, market_col, odds_col) in enumerate([
            ("H", "prob_h", "market_imp_h", "psch"),
            ("D", "prob_d", "market_imp_d", "pscd"),
            ("A", "prob_a", "market_imp_a", "psca"),
        ]):
            edge = r[prob_col] - r[market_col]
            if edge > args.min_edge:
                profit = (r[odds_col] - 1.0) if r["outcome"] == outcome_idx else -1.0
                bets.append({
                    "match_key": r["match_key"],
                    "league": str(r["league"]),
                    "outcome_bet": label,
                    "model_prob": float(r[prob_col]),
                    "market_implied": float(r[market_col]),
                    "edge": float(edge),
                    "odds_taken": float(r[odds_col]),
                    "won": bool(r["outcome"] == outcome_idx),
                    "profit": float(profit),
                })

    if not bets:
        print(f"  ✗ Zero bets fired (min_edge={args.min_edge*100:.1f}pp too strict?)")
        return 1

    bets_df = pd.DataFrame(bets)
    n_bets = len(bets_df)
    n_won = int(bets_df["won"].sum())
    total_profit = float(bets_df["profit"].sum())
    mean_roi = total_profit / n_bets * 100
    mean_odds = float(bets_df["odds_taken"].mean())
    win_rate = n_won / n_bets * 100

    # SE on ROI (per-bet std × 100 / sqrt(n))
    se_roi = float(bets_df["profit"].std(ddof=1)) * 100 / np.sqrt(n_bets)

    # G5 verdict
    g5_passes = mean_roi > PINNACLE_VIG_FLOOR * 100  # directional bar
    g5_status = "✓ PASS" if g5_passes else "✗ FAIL"
    if PINNACLE_VIG_FLOOR * 100 < mean_roi < PINNACLE_VIG_CEILING * 100:
        g5_status += " (within vig band — borderline)"

    print("─" * 70)
    print("G5 DIRECTIONAL ROI RESULT")
    print("─" * 70)
    print(f"  Total matches:     {len(joined):,}")
    print(f"  Total bets fired:  {n_bets:,}  (edge > {args.min_edge*100:.1f}pp)")
    print(f"  Win rate:          {win_rate:.1f}% ({n_won}/{n_bets})")
    print(f"  Mean odds taken:   {mean_odds:.2f}")
    print(f"  Total profit:      {total_profit:+.2f} units (flat 1u stake)")
    print(f"  Mean ROI per bet:  {mean_roi:+.2f}%")
    print(f"  SE on ROI:         ±{se_roi:.2f}%")
    print(f"  Pinnacle vig:      {mean_vig*100:.2f}% (PASS threshold)")
    print(f"  G5 VERDICT:        {g5_status}")
    print()

    # ─── Per-league breakdown ───
    print("─" * 70)
    print("PER-LEAGUE ROI BREAKDOWN")
    print("─" * 70)
    print(f"  {'league':<18} {'n_bets':>7}  {'win_rate':>9}  {'ROI':>9}")
    per_lg = bets_df.groupby("league").agg(
        n_bets=("won", "count"),
        n_won=("won", "sum"),
        total_profit=("profit", "sum"),
    ).reset_index()
    per_lg["win_rate"] = per_lg["n_won"] / per_lg["n_bets"] * 100
    per_lg["roi"] = per_lg["total_profit"] / per_lg["n_bets"] * 100
    per_lg = per_lg.sort_values("roi", ascending=False)
    per_lg_rows = []
    for _, r in per_lg.iterrows():
        per_lg_rows.append({
            "league": r["league"],
            "n_bets": int(r["n_bets"]),
            "n_won": int(r["n_won"]),
            "total_profit": float(r["total_profit"]),
            "win_rate_pct": float(r["win_rate"]),
            "roi_pct": float(r["roi"]),
        })
        marker = ""
        if r["n_bets"] >= 30:
            marker = "  ✓" if r["roi"] > PINNACLE_VIG_FLOOR * 100 else "  ✗"
        print(f"  {r['league']:<18} {int(r['n_bets']):>7,}  {r['win_rate']:>8.1f}%  "
              f"{r['roi']:>+8.2f}%{marker}")
    print()

    # Save
    OUT_PATH.write_text(json.dumps({
        "phase": "4.3-g5-directional-roi",
        "dev09_tag": args.dev09_tag,
        "test_seasons": list(test_seasons),
        "min_edge_pp": args.min_edge * 100,
        "n_matches_joined": int(len(joined)),
        "n_bets": int(n_bets),
        "n_won": int(n_won),
        "win_rate_pct": float(win_rate),
        "mean_odds_taken": float(mean_odds),
        "total_profit_units": float(total_profit),
        "mean_roi_pct": float(mean_roi),
        "se_roi_pct": float(se_roi),
        "pinnacle_mean_vig_pct": mean_vig * 100,
        "g5_threshold_pct": PINNACLE_VIG_FLOOR * 100,
        "g5_passes_directional": bool(g5_passes),
        "per_league": per_lg_rows,
        "_notes": [
            "Audit-binding 2026-05-28: G5 is DIRECTIONAL CHECK ONLY.",
            "No CI lower bound > 0% hurdle (impossible at n=800 with σ_bet=148%).",
            "PASS criterion: mean ROI > Pinnacle vig (~2.5-3%).",
            "Per-league markers (✓/✗) for n_bets ≥ 30 — small samples discounted.",
        ],
    }, indent=2))
    print(f"  ✓ Output: {OUT_PATH.relative_to(REPO_ROOT)}")
    print()
    print("═" * 70)
    print(f"G5 PHASE 4.3 VERDICT: {g5_status}")
    print("═" * 70)
    return 0 if g5_passes else 2


if __name__ == "__main__":
    sys.exit(main())
