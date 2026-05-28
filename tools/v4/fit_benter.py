"""
fit_benter.py — Fit per-Liga Benter log-pool weights for m6_market.

Input:
  1. odds-close-oot.parquet — 23/24 Pinnacle closing odds (~5.6k matches)
  2. m3 dev-01 predictor — m3 model predictions

Output:
  artifacts/m6_benter-{tag}.pkl — fitted BenterBlender with per-Liga β weights
  artifacts/m6_benter-{tag}.json — manifest with fit diagnostics

⚠ Soft-leakage caveat: m3 was trained on 2017-2025 including 23/24. So the m3
predictions on this odds dataset are in-training. β weights fit on those preds
may over-trust the model. The truly OOS evaluation lives in Stage 1.m6 (25/26
holdout, never seen by m3 OR Benter fitting).

Run: tools/venv/bin/python3 -I tools/v4/fit_benter.py --tag dev-01
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history
from v4.eval.metrics import brier_multiclass, log_loss
from v4.modules.m3_xg import XGPredictor
from v4.modules.m6_market import BenterBlender, remove_vig

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"
ODDS_PARQUET = REPO_ROOT / "tools" / "backtest" / "odds-close-oot.parquet"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fit Benter log-pool weights")
    p.add_argument("--tag", default="dev-02-elo",
                   help="Output tag (default dev-02-elo)")
    p.add_argument("--m3-tag", default="dev-02-elo",
                   help="m3 artifact tag to use for model predictions (default dev-02-elo)")
    p.add_argument("--vig-method", default="shin", choices=["shin", "proportional"])
    p.add_argument("--min-liga-samples", type=int, default=100)
    return p.parse_args()


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def main() -> int:
    args = parse_args()
    tag = args.tag

    print("=" * 70)
    print(f"V4 m6_market — Fit Benter Blend · tag={tag}")
    print("=" * 70)
    print(f"  vig method:       {args.vig_method}")
    print(f"  min Liga samples: {args.min_liga_samples}")
    print(f"  m3 artifact tag:  {args.m3_tag}")
    print()

    # ───── Load odds + m3 ─────
    if not ODDS_PARQUET.exists():
        print(f"✗ Missing odds parquet: {ODDS_PARQUET}")
        return 1

    odds_df = pd.read_parquet(ODDS_PARQUET)
    odds_df["match_date"] = pd.to_datetime(odds_df["match_date"])
    print(f"  Odds rows: {len(odds_df):,} "
          f"({odds_df['match_date'].min().date()} → {odds_df['match_date'].max().date()})")
    print(f"  Leagues:   {odds_df['league'].nunique()}")
    print()

    home_path = ARTIFACTS_DIR / f"m3_xg-home-{args.m3_tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{args.m3_tag}.pkl"
    if not (home_path.exists() and away_path.exists()):
        print(f"✗ Missing m3 artifacts (tag={args.m3_tag}). Run train_m3_xg.py first.")
        return 1
    predictor = XGPredictor.from_artifacts(home_path=home_path, away_path=away_path)

    # ───── Build match_pairs DataFrame for batch m3 prediction ─────
    # We need to convert odds_df rows into the match_pairs shape predict_batch expects
    # Required cols: league, match_date, home, away (predict_batch ignores goals)
    match_pairs = odds_df.rename(
        columns={"home_team": "home", "away_team": "away"}
    )[["league", "match_date", "home", "away"]].copy()

    # ───── Get m3 predictions ─────
    t0 = time.time()
    history = load_team_xg_history()
    print(f"  Generating m3 predictions for {len(match_pairs):,} matches...")
    preds_df = predictor.predict_batch(match_pairs, history, verbose=True)
    print(f"  Done in {time.time()-t0:.1f}s")
    print()

    # ───── Compute vig-removed market probs + match outcomes ─────
    # Outcomes: need actual goals. odds-close-oot.parquet doesn't have them.
    # Join via team_xg_history (we have goals_for/against per row).
    # Build a match-level outcome table.
    t0 = time.time()
    history_home = history[history["venue"] == "home"][
        ["league", "match_date", "team", "opponent", "goals_for", "goals_against"]
    ].rename(columns={"team": "home", "opponent": "away",
                      "goals_for": "home_goals", "goals_against": "away_goals"})

    # Inner-join odds with outcomes (drops matches without outcome data)
    matched = match_pairs.merge(
        history_home, on=["league", "match_date", "home", "away"], how="inner"
    ).merge(
        odds_df[["league", "match_date", "home_team", "away_team", "psch", "pscd", "psca"]],
        left_on=["league", "match_date", "home", "away"],
        right_on=["league", "match_date", "home_team", "away_team"],
        how="inner",
    )
    print(f"  Matched {len(matched):,} matches with outcomes + odds in {time.time()-t0:.1f}s")
    print(f"  Coverage: {len(matched)/len(odds_df):.1%} of odds rows matched to outcomes")
    print()

    if len(matched) < 500:
        print(f"✗ Insufficient matched data: {len(matched)}")
        return 1

    # Re-derive m3 preds on the matched subset (same order as preds_df)
    matched_pairs = matched[["league", "match_date", "home", "away"]]
    # Inner-join preds_df with matched on (league, match_date, home, away)
    preds_matched = preds_df.merge(
        matched_pairs, on=["league", "match_date", "home", "away"], how="inner"
    )
    if len(preds_matched) != len(matched):
        # Reorder via merge (more reliable than positional)
        matched = matched.merge(
            preds_df[["league", "match_date", "home", "away",
                      "prob_h", "prob_d", "prob_a"]],
            on=["league", "match_date", "home", "away"], how="inner"
        )
        if len(matched) < 500:
            print(f"✗ Coverage collapse after preds-join: {len(matched)}")
            return 1
        print(f"  After preds-join: {len(matched):,} matches")
    else:
        matched["prob_h"] = preds_matched["prob_h"].values
        matched["prob_d"] = preds_matched["prob_d"].values
        matched["prob_a"] = preds_matched["prob_a"].values

    # Vig-remove odds → market probs (per row)
    odds_arr = matched[["psch", "pscd", "psca"]].values
    market_probs = np.array([remove_vig(o, method=args.vig_method) for o in odds_arr])

    # Model probs (already normalized from m3)
    model_probs = matched[["prob_h", "prob_d", "prob_a"]].values
    model_probs = model_probs / model_probs.sum(axis=1, keepdims=True)

    # Outcomes
    outcomes = np.array([
        _outcome_label(h, a)
        for h, a in zip(matched["home_goals"].values, matched["away_goals"].values)
    ], dtype=int)

    # Sanity: per-source Brier
    brier_model = brier_multiclass(outcomes, model_probs)
    brier_market = brier_multiclass(outcomes, market_probs)
    print(f"  Pre-blend metrics on Benter-fit corpus ({len(matched)} matches):")
    print(f"    m3 model Brier:    {brier_model:.4f}")
    print(f"    Market-only Brier: {brier_market:.4f}")
    print()

    # ───── Group by Liga + fit Benter ─────
    per_liga_data = {}
    for liga in sorted(matched["league"].unique()):
        mask = (matched["league"].values == liga)
        per_liga_data[liga] = (
            model_probs[mask],
            market_probs[mask],
            outcomes[mask],
        )

    blender = BenterBlender(min_liga_samples=args.min_liga_samples).fit(per_liga_data)

    # ───── Report per-Liga weights ─────
    print(f"  Per-Liga Benter weights (β_model, β_market):")
    print(f"  {'Liga':<18}  {'n':>5}  {'β_model':>8}  {'β_market':>9}  source")
    print(f"  {'-'*18}  {'-'*5}  {'-'*8}  {'-'*9}  ------")
    for liga in sorted(blender.liga_weights.keys()):
        w = blender.liga_weights[liga]
        src = w["source"].replace("global_pool_fallback_", "→")
        print(f"  {liga:<18}  {w['n_samples']:>5}  {w['beta_model']:>8.3f}  "
              f"{w['beta_market']:>9.3f}  {src}")
    print()
    print(f"  Global pooled weights: β_model={blender.global_weights[0]:.3f}, "
          f"β_market={blender.global_weights[1]:.3f}")

    # ───── In-sample sanity: blended Brier ─────
    blended = np.zeros_like(model_probs)
    for liga in sorted(matched["league"].unique()):
        mask = (matched["league"].values == liga)
        blended[mask] = blender.blend(model_probs[mask], market_probs[mask], liga)
    brier_blended = brier_multiclass(outcomes, blended)
    print()
    print(f"  In-sample blended Brier: {brier_blended:.4f}")
    print(f"    delta vs m3 alone:     {brier_blended - brier_model:+.4f}")
    print(f"    delta vs market alone: {brier_blended - brier_market:+.4f}")
    print(f"    ⚠ in-sample only — true gate is Stage 1.m6 on 25/26 holdout")

    # ───── Save ─────
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    blender_path = ARTIFACTS_DIR / f"m6_benter-{tag}.pkl"
    manifest_path = ARTIFACTS_DIR / f"m6_benter-{tag}.json"
    blender.save(blender_path)

    manifest = {
        "tag": tag,
        "m3_tag": args.m3_tag,
        "vig_method": args.vig_method,
        "fitted_at": datetime.now().isoformat(),
        "training_window": {
            "from": str(matched["match_date"].min().date()),
            "to": str(matched["match_date"].max().date()),
            "n_matches": int(len(matched)),
            "_warning": (
                "m3 was trained on this period (2023-2024). Benter weights "
                "fit on in-training predictions are soft-leaky. Honest evaluation "
                "in Stage 1.m6 on 25/26 holdout."
            ),
        },
        "global_weights": {
            "beta_model": float(blender.global_weights[0]),
            "beta_market": float(blender.global_weights[1]),
        },
        "liga_weights": {
            liga: {
                "beta_model": w["beta_model"],
                "beta_market": w["beta_market"],
                "n_samples": w["n_samples"],
                "fit_success": w["fit_success"],
                "source": w["source"],
            }
            for liga, w in blender.liga_weights.items()
        },
        "in_sample_metrics": {
            "_warning": "in-sample, NOT a validation metric",
            "n": int(len(matched)),
            "brier_m3_alone": float(brier_model),
            "brier_market_alone": float(brier_market),
            "brier_blended": float(brier_blended),
        },
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print()
    print(f"  ✓ Saved:")
    print(f"    {blender_path.relative_to(REPO_ROOT)}")
    print(f"    {manifest_path.relative_to(REPO_ROOT)}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
