#!/usr/bin/env python3
"""
Phase A: LightGBM gain-importance analysis on dev-06-premium archived artifact.

Goal: identify which of the 9 premium features the model actually used
(gain > 0) vs. dead weight (gain ≈ 0). If all 9 are bottom-ranked vs the
20 lean features, the architecture is fundamentally redundant.

Gain importance answers a different question than out-of-sample Brier:
  • Brier: does the feature help PREDICT goals?  (what we want for shipping)
  • Gain: did the model USE the feature during training?
A feature can have HIGH gain (model used it a lot) but ZERO Brier benefit
(it just chased training noise). Conversely, a low-gain feature can't
hurt out-of-sample because the model basically ignored it.

So:
  • Low gain across all premium  → architecture is over-spec, model ignored them
  • High gain on premium + bad Brier (the dev-06 result) → model overfit
  • Mixed: some high-gain premium → those are candidates for single-feature retraining

Run: tools/venv/bin/python3 tools/v4/diagnostics/dev06_feature_importance.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np

from v4.modules.m3_xg.bayesian_ensemble import BayesianEnsemble

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts" / "_archived"


def main():
    home_path = ARTIFACTS / "m3_xg-home-dev-06-premium.pkl"
    away_path = ARTIFACTS / "m3_xg-away-dev-06-premium.pkl"
    if not home_path.exists():
        print(f"❌ {home_path} not found (expected in _archived/)")
        return 1

    ens_h = BayesianEnsemble.load(home_path)
    ens_a = BayesianEnsemble.load(away_path)
    feat_names = ens_h.feature_names
    print(f"Loaded archived dev-06-premium ensembles")
    print(f"  features (in column order, {len(feat_names)} total):")
    for i, f in enumerate(feat_names):
        print(f"    [{i:2d}] {f}")
    print()

    # ── Average gain-importance across the 5 bagged models ──
    # LGBMRegressor exposes .booster_.feature_importance(importance_type='gain')
    def aggregate_gain(ensemble):
        gains_per_model = []
        for m in ensemble.models:
            g = m.booster_.feature_importance(importance_type="gain")
            gains_per_model.append(g)
        return np.mean(gains_per_model, axis=0)

    gains_h = aggregate_gain(ens_h)
    gains_a = aggregate_gain(ens_a)
    # Normalize so totals sum to 100%
    gains_h_pct = 100.0 * gains_h / gains_h.sum() if gains_h.sum() > 0 else gains_h
    gains_a_pct = 100.0 * gains_a / gains_a.sum() if gains_a.sum() > 0 else gains_a

    # Premium feature names (last 9 + 1 categorical)
    PREMIUM_NAMES = {
        "mean_shot_xg_for_diff", "big_chance_rate_diff", "key_pass_quality_diff",
        "xa_creator_concentration", "attack_position_y_diff",
        "defense_line_height_diff", "tactical_width_diff",
        "manager_tenure_match_idx", "setpiece_xg_share_diff",
    }

    # Sort by combined importance (home + away)
    combined = (gains_h_pct + gains_a_pct) / 2
    order = np.argsort(-combined)

    print(f"{'Rank':>4s} {'Feature':<40s} {'home_gain':>10s} {'away_gain':>10s} {'avg':>8s}  tier")
    print("-" * 90)
    for rank, i in enumerate(order, 1):
        f = feat_names[i]
        is_premium = f in PREMIUM_NAMES
        tier = "PREMIUM" if is_premium else ("lean" if f != "league" else "cat")
        marker = "  ●" if is_premium else ""
        print(f"  {rank:>2d}.  {f:<40s} {gains_h_pct[i]:>8.2f}% {gains_a_pct[i]:>8.2f}% "
              f"{combined[i]:>7.2f}%  {tier}{marker}")

    # Premium feature aggregate
    premium_idx = [i for i, f in enumerate(feat_names) if f in PREMIUM_NAMES]
    lean_idx = [i for i, f in enumerate(feat_names)
                if f not in PREMIUM_NAMES and f != "league"]
    print()
    print("=" * 70)
    print(f"Aggregate gain share (home + away avg):")
    print(f"  Lean features    ({len(lean_idx):>2d}):  {combined[lean_idx].sum():>5.1f}%")
    print(f"  Premium features ({len(premium_idx):>2d}):  {combined[premium_idx].sum():>5.1f}%")
    print(f"  Category 'league'      :  {combined[feat_names.index('league')] if 'league' in feat_names else 0:>5.1f}%")
    print()

    # Verdict on per-feature basis
    print("Per-premium-feature verdict:")
    promising = []
    for f in sorted(PREMIUM_NAMES):
        i = feat_names.index(f) if f in feat_names else None
        if i is None:
            continue
        rank = (order.tolist().index(i)) + 1
        share = combined[i]
        if share >= 3.0:
            verdict = "✅ used substantially — candidate for solo retrain"
            promising.append(f)
        elif share >= 1.0:
            verdict = "⚠ used moderately — borderline candidate"
        else:
            verdict = "✗ near-zero usage — dead weight"
        print(f"  {f:<32s} rank #{rank:>2d}  share={share:>5.2f}%   {verdict}")

    print()
    if promising:
        print(f"Phase B targets ({len(promising)} features): {promising}")
    else:
        print(f"No premium feature has substantial gain → architecture is structurally redundant")
        print(f"  Phase B would just confirm what gain-importance already tells us.")
        print(f"  Recommend: archive dev-06 architecture path entirely.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
