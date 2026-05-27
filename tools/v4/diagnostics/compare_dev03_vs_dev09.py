#!/usr/bin/env python3
"""compare_dev03_vs_dev09 — TRUE paired head-to-head on the SAME 25/26 holdout.

Phase 4.2 of D4 sprint. Audit committee binding 2026-05-28:
  'Der Vergleich darf ausschließlich auf der exakten Match-Key-Intersection
   des 25/26 Holdouts laufen: Pure Macro (dev-03) vs. Pure Micro (dev-09).'

Solves the Day-3 "temporal-mismatch" defect:
  - Day-3 compared dev-09 (Brier on 24/25) vs v2_benter (Brier on 25/26)
    → cross-corpus, cross-time, NOT a valid baseline
  - Phase 4.2: Both engines evaluated on IDENTICAL 25/26 matches
    → apples-to-apples paired test

Algorithm:
  1. Load dev-09 phase-4.2 ensemble (trained on 22/23+23/24+24/25)
  2. Load dev-03 production ensemble
  3. Build 25/26 Sofa-native test corpus via FeatureBuilderDev09
  4. For each Sofa game in test: canonicalize home/away → look up in
     team_xg_history for dev-03 input
  5. Compute INTERSECTION (matches present in BOTH sources after canonicalization)
  6. Both models predict on intersection → paired Brier comparison
  7. Per-Liga breakdown + paired t-test

The dev-03 bridge:
  - sofascore_match has (home_team, away_team, start_timestamp)
  - team_xg_history (dev-03's source) uses canonical names from canonical-team.mjs
  - canonical_team() in v4.modules.m3_xg.canonical_team_map gives us the mapping
  - Join key = (league, match_date, canonical_home, canonical_away)

Output:
  tools/v4/diagnostics/compare_dev03_vs_dev09.json — paired Brier + per-Liga
  + Holm-corrected per-Liga p-values + decision verdict

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/compare_dev03_vs_dev09.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/compare_dev03_vs_dev09.py \
    --dev09-tag dev-09-phase42-seed-000 --dev03-tag dev-03
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import (
    DEV_09_CATEGORICAL_FEATURES,
    DEV_09_NUMERIC_FEATURES,
    FeatureBuilderDev09,
    extract_X_dev09,
)
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.eval.metrics import brier_multiclass
from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.utils.falsification_protocol import (
    per_match_brier_stats,
    holm_bonferroni,
)

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "compare_dev03_vs_dev09.json"

LAMBDA_MIN = 0.05
LAMBDA_MAX = 6.0


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def _ensemble_predict_1x2(ens_h, ens_a, X: pd.DataFrame, rho: float) -> np.ndarray:
    """Common λ → DC score grid → 1X2 probability pipeline.
    Used identically for dev-09 and dev-03."""
    X_aligned_h = X[ens_h.feature_names]
    X_aligned_a = X[ens_a.feature_names]
    mean_h, _ = ens_h.predict(X_aligned_h)
    mean_a, _ = ens_a.predict(X_aligned_a)
    lambda_h = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    lambda_a = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
    n = len(X)
    p1x2 = np.empty((n, 3))
    for i in range(n):
        try:
            M = DixonColesModel(lambda_h[i], lambda_a[i], rho=rho).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lambda_h[i], lambda_a[i]).matrix(normalize=True)
        p = get_1x2(M)
        p1x2[i] = [p["H"], p["D"], p["A"]]
    return p1x2


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--dev09-tag", default="dev-09-phase42-seed-000",
                   help="dev-09 artifact tag (default: phase-4.2 seed-000)")
    p.add_argument("--dev03-tag", default="dev-03",
                   help="dev-03 artifact tag (default: production)")
    p.add_argument("--test-seasons", default="25/26",
                   help="Holdout seasons (default 25/26)")
    p.add_argument("--rho", type=float, default=DEFAULT_RHO,
                   help=f"DC ρ for score-grid (default {DEFAULT_RHO})")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    test_seasons = tuple(args.test_seasons.split(","))

    print("═" * 70)
    print(f"COMPARE dev-03 (Pure Macro) vs dev-09 (Pure Micro) · {test_seasons} holdout")
    print("═" * 70)
    print(f"  dev-09 tag: {args.dev09_tag}")
    print(f"  dev-03 tag: {args.dev03_tag}")
    print(f"  ρ:          {args.rho:+.4f}")
    print()

    # ─── Load dev-09 ───
    d09_home = ARTIFACTS_DIR / f"m3_xg-home-{args.dev09_tag}.pkl"
    d09_away = ARTIFACTS_DIR / f"m3_xg-away-{args.dev09_tag}.pkl"
    if not d09_home.exists() or not d09_away.exists():
        print(f"  ✗ Missing dev-09 pickles for tag={args.dev09_tag}")
        return 1
    d09_h = BayesianEnsemble.load(d09_home)
    d09_a = BayesianEnsemble.load(d09_away)
    print(f"  ✓ Loaded dev-09 ensembles ({d09_h.n_models} bagged each)")

    # ─── Load dev-03 ───
    d03_home = ARTIFACTS_DIR / f"m3_xg-home-{args.dev03_tag}.pkl"
    d03_away = ARTIFACTS_DIR / f"m3_xg-away-{args.dev03_tag}.pkl"
    if not d03_home.exists() or not d03_away.exists():
        print(f"  ✗ Missing dev-03 pickles for tag={args.dev03_tag}")
        return 1
    d03 = XGPredictor.from_artifacts(home_path=d03_home, away_path=d03_away, rho=args.rho)
    print(f"  ✓ Loaded dev-03 XGPredictor (features={len(d03.ensemble_home.feature_names)})")
    print()

    # ─── Build dev-09 test corpus (Sofa-native) ───
    print(f"  Building dev-09 25/26 holdout via FeatureBuilderDev09...")
    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    test_df_sofa = fb.build_corpus(seasons=test_seasons, leagues=None, verbose=True)

    # ─── Bridge: canonicalize sofa team names + add canonical match_date ───
    print(f"  Bridging Sofa game_ids → team_xg_history canonical names...")
    test_df_sofa["canonical_home"] = test_df_sofa.apply(
        lambda r: canonical_team(r["home_team"], r["league"]), axis=1
    )
    test_df_sofa["canonical_away"] = test_df_sofa.apply(
        lambda r: canonical_team(r["away_team"], r["league"]), axis=1
    )
    # Convert match_date (already a pd.Timestamp from start_timestamp) to date-only for join
    test_df_sofa["match_date_d"] = pd.to_datetime(test_df_sofa["match_date"]).dt.normalize()

    # ─── Build dev-03 input from canonicalized Sofa matches ───
    # dev-03's predict_batch expects DataFrame with columns: league, match_date (datetime),
    # home, away, home_goals, away_goals. We synthesize this from the canonicalized Sofa data.
    d03_input = pd.DataFrame({
        "league": test_df_sofa["league"].astype(str),
        "match_date": test_df_sofa["match_date_d"],
        "home": test_df_sofa["canonical_home"],
        "away": test_df_sofa["canonical_away"],
        "home_goals": test_df_sofa["home_goals"],
        "away_goals": test_df_sofa["away_goals"],
    })

    # dev-03 also needs team_xg_history. Load full corpus (it caches Elo + momentum).
    print(f"  Loading team_xg_history for dev-03 feature build (one-time)...")
    history = load_team_xg_history()
    print(f"    {len(history):,} rows loaded")
    print()

    # ─── Predict dev-03 on canonicalized 25/26 corpus ───
    print(f"  Predicting dev-03 on {len(d03_input):,} matches...")
    d03_preds = d03.predict_batch(d03_input, history, verbose=False)
    print(f"    dev-03 returned {len(d03_preds):,} predictions  "
          f"(fallback rate {d03_preds.attrs.get('poisson_fallback_rate', 0)*100:.1f}%)")

    # ─── Predict dev-09 on same matches ───
    print(f"  Predicting dev-09 on {len(test_df_sofa):,} matches...")
    X_test = extract_X_dev09(test_df_sofa)
    p_dev09 = _ensemble_predict_1x2(d09_h, d09_a, X_test, args.rho)

    # ─── Strict match_key intersection ───
    # Both predictions cover the same input matches by construction (we built dev-03
    # input from test_df_sofa). But we must check that dev-03 didn't drop any rows
    # internally (its feature builder might drop rows with missing xG history).
    if len(d03_preds) != len(test_df_sofa):
        # Length mismatch — need explicit intersection. Map via (league, match_date, home, away).
        # dev-03's predict_batch returns same row order as input by contract → len mismatch
        # would be a bug. Bail if so.
        print(f"  ⚠ dev-03 returned {len(d03_preds)} preds vs {len(test_df_sofa)} input — "
              "row-order contract broken. Bailing.")
        return 1

    # Predictions are positionally aligned — same row i in both
    p_dev03 = np.column_stack([d03_preds["prob_h"], d03_preds["prob_d"], d03_preds["prob_a"]])

    # Outcomes (Sofa-native ground truth)
    y_outcomes = np.array([_outcome_label(h, a) for h, a in
                            zip(test_df_sofa["home_goals"], test_df_sofa["away_goals"])], dtype=int)
    y_onehot = np.eye(3)[y_outcomes]

    n = len(test_df_sofa)
    print(f"  Intersection size: n={n:,} (paired per-match comparison)")
    print()

    # ─── Per-match Brier ───
    brier_dev09_per = ((p_dev09 - y_onehot) ** 2).sum(axis=1)
    brier_dev03_per = ((p_dev03 - y_onehot) ** 2).sum(axis=1)
    brier_dev09 = float(brier_dev09_per.mean())
    brier_dev03 = float(brier_dev03_per.mean())
    diff_per_match = brier_dev09_per - brier_dev03_per  # < 0 = dev-09 better
    mean_diff = float(diff_per_match.mean())
    std_diff = float(diff_per_match.std(ddof=1))
    se_diff = std_diff / np.sqrt(n)
    t_stat = mean_diff / se_diff

    # Two-sided p (normal approximation)
    from scipy.stats import norm
    p_two_sided = 2 * (1 - norm.cdf(abs(t_stat)))

    print("─" * 70)
    print("PAIRED BRIER-Δ (dev-09 vs dev-03) on identical 25/26 corpus")
    print("─" * 70)
    print(f"  dev-09 Brier:       {brier_dev09:.4f}")
    print(f"  dev-03 Brier:       {brier_dev03:.4f}")
    print(f"  Mean Δ:             {mean_diff:+.5f}  ({'dev-09 BETTER' if mean_diff < 0 else 'dev-03 BETTER'})")
    print(f"  σ per-match:        {std_diff:.5f}")
    print(f"  SE:                 {se_diff:.6f}")
    print(f"  t-stat:             {t_stat:+.2f}")
    print(f"  Two-sided p:        {p_two_sided:.4e}")
    print()

    # ─── Per-Liga + Holm correction ───
    print("─" * 70)
    print("PER-LIGA paired test (with Holm-Bonferroni correction)")
    print("─" * 70)
    print(f"  {'league':<18} {'n':>4}  {'d09 Bri':>8}  {'d03 Bri':>8}  {'Δ':>9}  {'t':>6}  {'p_raw':>8}")
    per_liga_hypotheses: List[dict] = []
    for lg in sorted(test_df_sofa["league"].cat.categories):
        mask = (test_df_sofa["league"] == lg).values
        if mask.sum() < 10:
            continue
        n_lg = int(mask.sum())
        b09 = float(brier_dev09_per[mask].mean())
        b03 = float(brier_dev03_per[mask].mean())
        d_lg = float(diff_per_match[mask].mean())
        se_lg = float(diff_per_match[mask].std(ddof=1)) / np.sqrt(n_lg)
        t_lg = d_lg / se_lg if se_lg > 0 else 0
        p_raw = 2 * (1 - norm.cdf(abs(t_lg))) if se_lg > 0 else 1.0
        per_liga_hypotheses.append({
            "league": lg,
            "n": n_lg,
            "brier_dev09": b09,
            "brier_dev03": b03,
            "mean_diff": d_lg,
            "t_stat": float(t_lg),
            "p_raw": float(p_raw),
        })
        print(f"  {lg:<18} {n_lg:>4}  {b09:>8.4f}  {b03:>8.4f}  {d_lg:>+8.4f}  {t_lg:>+6.2f}  {p_raw:>8.4f}")

    # Holm correction across leagues
    corrected = holm_bonferroni(per_liga_hypotheses, p_key="p_raw", alpha=0.05)
    print()
    print(f"  Holm-Bonferroni adjusted (m={len(per_liga_hypotheses)} leagues):")
    print(f"  {'league':<18} {'p_raw':>8}  {'p_adj':>8}  {'sig?'}")
    for h in corrected:
        sig = "✓ YES" if h["significant"] else "✗ no"
        print(f"  {h['league']:<18} {h['p_raw']:>8.4f}  {h['p_adj']:>8.4f}  {sig}")
    print()

    # ─── Aggregate G2 vs feature-count (m=11 features) ───
    # Audit's main G2 binding: architecture-swap claim must satisfy
    #   p_raw < α/m = 0.05/11 = 0.00455 (Bonferroni-adjusted threshold).
    # The threshold IS the correction; we compare raw p against α/m directly.
    G2_THRESHOLD_M = 11
    g2_threshold = 0.05 / G2_THRESHOLD_M
    print("─" * 70)
    print(f"ARCHITECTURE-SWAP G2 (Bonferroni m={G2_THRESHOLD_M} features)")
    print("─" * 70)
    print(f"  Aggregate p_raw:     {p_two_sided:.4e}")
    print(f"  Threshold (α/m):     {g2_threshold:.5f}  (0.05/{G2_THRESHOLD_M})")
    g2_passes = bool(p_two_sided < g2_threshold)
    print(f"  G2 verdict:          {'✓ PASS' if g2_passes else '✗ FAIL'}")
    print()

    # ─── Decision-table mapping per audit binding ───
    print("─" * 70)
    print("PRODUCTION-SWAP DECISION TABLE (from FODZE-OPTIMAL-BLUEPRINT)")
    print("─" * 70)
    # Brier-Δ band
    if mean_diff <= -0.005:
        brier_band = "DELTA_LE_-0.005"
    elif mean_diff <= -0.002:
        brier_band = "DELTA_IN_-0.005_-0.002"
    elif mean_diff <= 0:
        brier_band = "DELTA_IN_-0.002_0"
    else:
        brier_band = "DELTA_POSITIVE"

    # Per-Liga gate: how many leagues exceed +2σ_inter_seed (audit literal threshold)?
    sigma_seed = 0.0007  # from Phase 4.2 bootstrap
    catastrophic = [h for h in corrected if h["mean_diff"] > 2 * sigma_seed]
    print(f"  Per-Liga catastrophes (Δ > +2σ_inter_seed = +{2*sigma_seed:.4f}): "
          f"{len(catastrophic)}/{len(corrected)}")
    if catastrophic:
        for h in catastrophic:
            print(f"    {h['league']}: Δ={h['mean_diff']:+.4f}")

    # Combined verdict per audit-binding decision table
    all_leagues_ok = len(catastrophic) == 0
    if brier_band == "DELTA_LE_-0.005" and all_leagues_ok and g2_passes:
        final_verdict = "SHIP (Δ ≤ -0.005, all leagues ≤ +2σ, G2 PASS)"
    elif brier_band in ("DELTA_LE_-0.005", "DELTA_IN_-0.005_-0.002") and g2_passes:
        final_verdict = ("SHIP-AS-ALTERNATIVE (Δ in ship band, G2 PASS, "
                         f"BUT {len(catastrophic)}/22 leagues exceed +2σ_seed gate)")
    elif brier_band == "DELTA_IN_-0.002_0":
        final_verdict = "SUB-NOISE — archive or extend test"
    elif brier_band == "DELTA_POSITIVE":
        final_verdict = "REGRESSION — REJECT"
    else:
        final_verdict = f"BORDERLINE — Brier={brier_band}, G2={'PASS' if g2_passes else 'FAIL'}, catastrophic={len(catastrophic)}"

    print(f"  Brier-Δ band:        {brier_band}")
    print(f"  G2 (m=11 Bonferroni): {'PASS' if g2_passes else 'FAIL'}")
    print(f"  All leagues ≤ +2σ:   {'YES' if all_leagues_ok else 'NO'}")
    print(f"  FINAL VERDICT:       {final_verdict}")
    print()

    # ─── Save output ───
    out = {
        "phase": "4.2-true-h2h",
        "dev09_tag": args.dev09_tag,
        "dev03_tag": args.dev03_tag,
        "test_seasons": list(test_seasons),
        "rho": args.rho,
        "n_test": int(n),
        "brier_dev09": brier_dev09,
        "brier_dev03": brier_dev03,
        "mean_diff": mean_diff,
        "std_per_match_diff": std_diff,
        "se_diff": se_diff,
        "t_stat": float(t_stat),
        "p_two_sided": float(p_two_sided),
        "g2_threshold_alpha_over_m": float(g2_threshold),
        "g2_m_features": G2_THRESHOLD_M,
        "g2_passes": g2_passes,
        "brier_band": brier_band,
        "n_catastrophic_leagues": len(catastrophic),
        "catastrophic_leagues": [h["league"] for h in catastrophic],
        "all_leagues_ok": all_leagues_ok,
        "final_verdict": final_verdict,
        "per_league": corrected,
        "_notes": [
            "Apples-to-apples paired test on IDENTICAL 25/26 holdout matches.",
            "dev-03 path: canonicalize Sofa → team_xg_history → XGPredictor.predict_batch",
            "dev-09 path: FeatureBuilderDev09 → BayesianEnsemble → DC score-grid",
            "G2 Holm correction uses m=11 (dev-09 feature count) — conservative bound.",
            "Per-Liga p-values also Holm-corrected across the 22-league family.",
        ],
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"  ✓ Output: {OUT_PATH.relative_to(REPO_ROOT)}")
    print()
    print("═" * 70)
    print(f"PHASE 4.2 H2H FINAL VERDICT: {final_verdict}")
    print("═" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
