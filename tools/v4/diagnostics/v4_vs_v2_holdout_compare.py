"""
v4_vs_v2_holdout_compare.py — apples-to-apples v4 vs v2 on the SAME 25/26 subset.

Three diagnostics that the prior Stage 1.m6 analysis didn't deliver:

  A. v2 Brier on the same 2,274 Pinnacle-covered subset that v4 m3+m6 was
     evaluated on. (v2_benter = 0.6194 cross-engine number was on n=5,448;
     wrong cohort for apples-to-apples comparison.)

  B. v4 m3 + v4 m3+m6 + v2_raw + v2+Benter(our blender) all on identical match
     set, so we can attribute differences to model vs blend cleanly.

  C. Competitiveness binning: m3 Brier by quartile of min(P_H, P_A). If m3
     Brier varies sharply across bins, m3 has a structural weakness on
     close matches (predicts a clear favorite when the match is actually
     a coin-flip).

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/v4_vs_v2_holdout_compare.py
     [--m3-tag dev-01] [--benter-tag dev-01] [--vig-method shin]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history
from v4.eval.metrics import brier_multiclass, log_loss
from v4.modules.m3_xg import XGPredictor
from v4.modules.m6_market import BenterBlender, remove_vig


ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT_ODDS = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
V2_OOT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="v4 vs v2 apples-to-apples diagnostic")
    p.add_argument("--m3-tag", default="dev-02-elo",
                   help="m3 artifact tag to load (default dev-02-elo — 14-feature Elo schema)")
    p.add_argument("--benter-tag", default="dev-02-elo",
                   help="Benter artifact tag to load (default dev-02-elo)")
    p.add_argument("--vig-method", default="shin",
                   choices=["shin", "proportional"],
                   help="Vig-removal method (default shin)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    print("=" * 70)
    print(f"v4-vs-v2 apples-to-apples diagnostic on 25/26 Pinnacle subset")
    print(f"  m3 tag:     {args.m3_tag}")
    print(f"  Benter tag: {args.benter_tag}")
    print(f"  vig method: {args.vig_method}")
    print("=" * 70)

    # ───── Load all data sources ─────
    odds = pd.read_parquet(HOLDOUT_ODDS)
    odds["match_date"] = pd.to_datetime(odds["match_date"])
    odds = odds.dropna(subset=["ft_goals_h", "ft_goals_a", "psch", "pscd", "psca"])
    odds = odds.reset_index(drop=True)
    print(f"\n  25/26 Pinnacle-covered settled matches: {len(odds):,}")

    v2_preds = pd.read_parquet(V2_OOT_PARQUET)
    v2_preds["match_date"] = pd.to_datetime(v2_preds["match_date"])
    print(f"  v2 OOT predictions available:           {len(v2_preds):,}")

    history = load_team_xg_history()
    print(f"  team_xg_history rows:                   {len(history):,}")

    # ───── Inner-join odds × v2 on (league, match_date, home_team, away_team) ─────
    # v2 col names: home_team, away_team. Odds: home_team, away_team. Match!
    merged = odds.merge(
        v2_preds[
            ["league", "match_date", "home_team", "away_team",
             "prob_h_raw", "prob_d_raw", "prob_a_raw"]
        ],
        on=["league", "match_date", "home_team", "away_team"],
        how="inner",
    )
    print(f"\n  Joined v2 × odds (same match): {len(merged):,} matches "
          f"({len(merged)/len(odds):.0%} of Pinnacle subset has v2 preds)")

    if len(merged) < 100:
        print(f"✗ Joined cohort too small. Possible team-name mismatch.")
        # Diagnostic: which side has unmatched rows?
        odds_keys = set(zip(odds["league"], odds["match_date"],
                             odds["home_team"], odds["away_team"]))
        v2_keys = set(zip(v2_preds["league"], v2_preds["match_date"],
                          v2_preds["home_team"], v2_preds["away_team"]))
        print(f"  odds keys not in v2: {len(odds_keys - v2_keys)}")
        print(f"  v2 keys not in odds: {len(v2_keys - odds_keys)}")
        # Show a few samples
        for key in list(odds_keys - v2_keys)[:5]:
            print(f"    odds-only: {key}")
        return 1

    # ───── Get v4 m3 + m3+m6 predictions on the merged cohort ─────
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{args.m3_tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{args.m3_tag}.pkl"
    benter_path = ARTIFACTS_DIR / f"m6_benter-{args.benter_tag}.pkl"
    for p in [home_path, away_path, benter_path]:
        if not p.exists():
            print(f"✗ Missing artifact: {p.name}")
            return 1
    predictor = XGPredictor.from_artifacts(home_path=home_path, away_path=away_path)
    blender = BenterBlender.load(benter_path)

    match_pairs = merged[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    )
    print(f"\n  Generating v4 m3 predictions for {len(match_pairs):,} matches...")
    v4_preds = predictor.predict_batch(match_pairs, history)
    merged["v4_m3_h"] = v4_preds["prob_h"].values
    merged["v4_m3_d"] = v4_preds["prob_d"].values
    merged["v4_m3_a"] = v4_preds["prob_a"].values

    # ───── Outcomes + market probs ─────
    outcomes = np.array([
        _outcome_label(h, a)
        for h, a in zip(merged["ft_goals_h"].values, merged["ft_goals_a"].values)
    ], dtype=int)

    market_probs = np.array([
        remove_vig(o, method=args.vig_method)
        for o in merged[["psch", "pscd", "psca"]].values
    ])

    v4_m3 = merged[["v4_m3_h", "v4_m3_d", "v4_m3_a"]].values
    v4_m3 = v4_m3 / v4_m3.sum(axis=1, keepdims=True)

    v2_raw = merged[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].values
    v2_raw = v2_raw / v2_raw.sum(axis=1, keepdims=True)

    # v4 m3+m6 blend per Liga
    v4_blend = np.zeros_like(v4_m3)
    for liga in merged["league"].unique():
        mask = merged["league"].values == liga
        v4_blend[mask] = blender.blend(v4_m3[mask], market_probs[mask], liga)

    # v2+Benter blend per Liga (re-using our blender — same β weights)
    v2_blend = np.zeros_like(v2_raw)
    for liga in merged["league"].unique():
        mask = merged["league"].values == liga
        v2_blend[mask] = blender.blend(v2_raw[mask], market_probs[mask], liga)

    # ───── Aggregate Brier comparison ─────
    print()
    print("=" * 70)
    print(f"  HEADLINE: Brier on n={len(merged):,} (same match set)")
    print("=" * 70)

    metrics = {
        "Market alone (vig-removed)": market_probs,
        "v2 raw (no Benter)":          v2_raw,
        "v2 + Benter (our blender)":   v2_blend,
        "v4 m3 alone":                 v4_m3,
        "v4 m3+m6 (Benter)":           v4_blend,
    }
    print(f"\n  {'Model':<32}  {'Brier':>7}  {'LogLoss':>8}")
    print(f"  {'-'*32}  {'-'*7}  {'-'*8}")
    results = {}
    for name, p in metrics.items():
        b = brier_multiclass(outcomes, p)
        ll = log_loss(outcomes, p)
        results[name] = b
        print(f"  {name:<32}  {b:.4f}   {ll:.4f}")

    # ───── Strategic comparisons ─────
    print()
    print("=" * 70)
    print(f"  Strategic deltas (negative = better)")
    print("=" * 70)
    v4_blend_brier = results["v4 m3+m6 (Benter)"]
    v2_blend_brier = results["v2 + Benter (our blender)"]
    market_brier = results["Market alone (vig-removed)"]
    v4_m3_brier = results["v4 m3 alone"]
    v2_raw_brier = results["v2 raw (no Benter)"]

    print(f"\n  v4 vs v2 (raw):             Δ {v4_m3_brier - v2_raw_brier:+.4f}  "
          f"({'v4 better' if v4_m3_brier < v2_raw_brier else 'v2 better'})")
    print(f"  v4 vs v2 (with Benter):     Δ {v4_blend_brier - v2_blend_brier:+.4f}  "
          f"({'v4 better' if v4_blend_brier < v2_blend_brier else 'v2 better'})")
    print(f"  Best blend vs market:       Δ {min(v4_blend_brier, v2_blend_brier) - market_brier:+.4f}  "
          f"({'beats market' if min(v4_blend_brier, v2_blend_brier) < market_brier else 'loses to market'})")
    print(f"  v4 blend vs market - 0.005: Δ {v4_blend_brier - (market_brier - 0.005):+.4f}  "
          f"({'pass' if v4_blend_brier <= market_brier - 0.005 else 'fail'} Stage 1.m6 gate [3])")

    # ───── Per-league: v4 vs v2 ─────
    print()
    print("=" * 70)
    print(f"  Per-league: v4 m3 vs v2 raw (negative = v4 wins)")
    print("=" * 70)
    print(f"\n  {'Liga':<18}  {'n':>4}  {'v4_m3':>7}  {'v2_raw':>7}  {'Δ':>7}  status")
    print(f"  {'-'*18}  {'-'*4}  {'-'*7}  {'-'*7}  {'-'*7}  ------")
    per_liga = []
    for liga in sorted(merged["league"].unique()):
        mask = merged["league"].values == liga
        n = int(mask.sum())
        if n < 20:
            continue
        b_v4 = brier_multiclass(outcomes[mask], v4_m3[mask])
        b_v2 = brier_multiclass(outcomes[mask], v2_raw[mask])
        delta = b_v4 - b_v2
        per_liga.append((liga, n, b_v4, b_v2, delta))
    per_liga.sort(key=lambda r: r[4])  # ascending delta (most v4-favorable first)
    for liga, n, b_v4, b_v2, delta in per_liga:
        status = "✓ v4" if delta < -0.005 else ("✓ v2" if delta > 0.005 else "≈")
        print(f"  {liga:<18}  {n:>4}  {b_v4:>7.4f}  {b_v2:>7.4f}  {delta:>+7.4f}  {status}")

    # ───── Per-league: v4 m3+m6 vs v2+Benter ─────
    print()
    print("=" * 70)
    print(f"  Per-league: v4 m3+m6 vs v2+Benter (negative = v4 wins)")
    print("=" * 70)
    print(f"\n  {'Liga':<18}  {'n':>4}  {'v4_blend':>9}  {'v2_blend':>9}  {'Δ':>7}  status")
    print(f"  {'-'*18}  {'-'*4}  {'-'*9}  {'-'*9}  {'-'*7}  ------")
    for liga, n, _, _, _ in per_liga:
        mask = merged["league"].values == liga
        b_v4_bl = brier_multiclass(outcomes[mask], v4_blend[mask])
        b_v2_bl = brier_multiclass(outcomes[mask], v2_blend[mask])
        delta = b_v4_bl - b_v2_bl
        status = "✓ v4" if delta < -0.005 else ("✓ v2" if delta > 0.005 else "≈")
        print(f"  {liga:<18}  {n:>4}  {b_v4_bl:>9.4f}  {b_v2_bl:>9.4f}  {delta:>+7.4f}  {status}")

    # ───── COMPETITIVENESS BINNING ─────
    print()
    print("=" * 70)
    print(f"  v4 m3 Brier binned by match-competitiveness")
    print(f"  (proxy: min(P_H, P_A) — smaller = more decisive match)")
    print("=" * 70)

    # Bin by min(P_H, P_A) — small means a clear favorite (decisive)
    decisive_score = np.minimum(v4_m3[:, 0], v4_m3[:, 2])
    # Quartile bins
    bin_edges = np.quantile(decisive_score, [0, 0.25, 0.5, 0.75, 1.0])
    bin_labels = ["Q1 (most decisive)", "Q2", "Q3", "Q4 (most coin-flip)"]
    print(f"\n  {'Bin':<25}  {'n':>5}  {'edge_lo':>8}  {'edge_hi':>8}  "
          f"{'m3_Brier':>9}  {'mkt_Brier':>10}  {'Δ vs mkt':>9}")
    print(f"  {'-'*25}  {'-'*5}  {'-'*8}  {'-'*8}  {'-'*9}  {'-'*10}  {'-'*9}")
    for i, label in enumerate(bin_labels):
        lo, hi = bin_edges[i], bin_edges[i + 1]
        if i == 0:
            mask = decisive_score <= hi
        else:
            mask = (decisive_score > lo) & (decisive_score <= hi)
        n = int(mask.sum())
        if n < 50:
            continue
        b_m3 = brier_multiclass(outcomes[mask], v4_m3[mask])
        b_mkt = brier_multiclass(outcomes[mask], market_probs[mask])
        print(f"  {label:<25}  {n:>5}  {lo:>8.4f}  {hi:>8.4f}  "
              f"{b_m3:>9.4f}  {b_mkt:>10.4f}  {b_m3 - b_mkt:>+9.4f}")

    # ───── ALSO: v2 binned same way ─────
    print()
    print(f"  v2 raw Brier binned by SAME competitiveness bins")
    print(f"  {'Bin':<25}  {'n':>5}  {'v2_Brier':>9}  {'v4_m3':>9}  "
          f"{'Δ v4-v2':>9}")
    print(f"  {'-'*25}  {'-'*5}  {'-'*9}  {'-'*9}  {'-'*9}")
    for i, label in enumerate(bin_labels):
        lo, hi = bin_edges[i], bin_edges[i + 1]
        if i == 0:
            mask = decisive_score <= hi
        else:
            mask = (decisive_score > lo) & (decisive_score <= hi)
        n = int(mask.sum())
        if n < 50:
            continue
        b_v2 = brier_multiclass(outcomes[mask], v2_raw[mask])
        b_v4 = brier_multiclass(outcomes[mask], v4_m3[mask])
        print(f"  {label:<25}  {n:>5}  {b_v2:>9.4f}  {b_v4:>9.4f}  "
              f"{b_v4 - b_v2:>+9.4f}")

    print()
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
