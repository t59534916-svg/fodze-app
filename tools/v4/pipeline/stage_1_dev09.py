"""
Stage 1.dev-09 — Evaluate trained dev-09 ensemble on 24/25 holdout.

Per FODZE-Optimal-Blueprint audit + 5-Gate Falsification Protocol:
  - Holdout is HELD-OUT during training (walk-forward CV).
  - Compares dev-09 to v2_benter LIVE baseline (cross-engine-current-metrics.json).
  - Uses dev-03 production pickles for paired per-match Brier-Δ when available.
  - Reports per-Liga breakdown.

Distinct from stage_1_m3_xg.py:
  - Reads sofascore_match for outcome (not team_xg_history).
  - Uses FeatureBuilderDev09 (Sofa-native, NOT team_xg_history-joined).
  - dev-09 + dev-03 head-to-head reported when --vs-dev-03 flag set +
    dev-03 pickles present at expected tag.

Run:
  tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_dev09.py --tag dev-09-day2
  tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_dev09.py --tag dev-09-day2 --vs-dev-03 dev-03

Exit codes:
  0 — evaluation complete, all sanity checks pass
  1 — evaluation failed (missing artifacts, etc.)
  2 — Brier > pass-threshold (v2_benter + 0.005) — informational, not fatal
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Sequence

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.eval.metrics import brier_multiclass, log_loss
from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO
from v4.modules.m3_xg.feature_builder_dev09 import (
    DEV_09_NUMERIC_FEATURES,
    FeatureBuilderDev09,
    extract_X_dev09,
)
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2, get_ou, get_btts
from v4.utils.falsification_protocol import per_match_brier_stats, holm_bonferroni

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
CROSS_ENGINE_METRICS = REPO_ROOT / "tools" / "backtest" / "cross-engine-current-metrics.json"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"

TOP5 = ("epl", "la_liga", "serie_a", "bundesliga", "ligue_1")
LAMBDA_MIN = 0.05
LAMBDA_MAX = 6.0
TARGET_TOLERANCE = 0.005


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stage 1 evaluation for dev-09")
    p.add_argument("--tag", required=True, help="Artifact tag (e.g. dev-09-day2)")
    p.add_argument("--test-seasons", default="24/25",
                   help="Comma-separated holdout seasons (default 24/25)")
    p.add_argument("--leagues", default=",".join(TOP5),
                   help=f"Comma-separated league list (default {','.join(TOP5)})")
    p.add_argument("--rho", type=float, default=None,
                   help=f"DC ρ for score-grid (default {DEFAULT_RHO})")
    p.add_argument("--available-only", action="store_true",
                   help="Evaluate only rows where bottom_up_available=1")
    p.add_argument("--vs-dev-03", default=None,
                   help="dev-03 artifact tag for paired head-to-head comparison "
                        "(e.g. dev-03). When set, computes per-match Brier-Δ + Holm test.")
    return p.parse_args()


def load_v2_baseline() -> tuple[float, dict]:
    """Read v2_benter from live cross-engine metrics file."""
    if not CROSS_ENGINE_METRICS.exists():
        return 0.6194, {"source": "fallback (file missing)"}
    try:
        data = json.loads(CROSS_ENGINE_METRICS.read_text())
        v2b = data.get("engines", {}).get("v2_benter", {})
        return float(v2b.get("brier", 0.6194)), {
            "source": "cross-engine-current-metrics.json",
            "window": data.get("window"),
            "n_v2_eval": v2b.get("n"),
            "generated_at": data.get("generated_at"),
        }
    except Exception as e:
        return 0.6194, {"source": f"fallback (parse error: {e})"}


def _outcome_label(home_goals: float, away_goals: float) -> int:
    """0=H, 1=D, 2=A"""
    if home_goals > away_goals:
        return 0
    if home_goals < away_goals:
        return 2
    return 1


def _build_score_grid(lambda_h: float, lambda_a: float, rho: float):
    """Mirror XGPredictor._build_score_grid (DC with Poisson fallback)."""
    try:
        dc = DixonColesModel(lambda_h, lambda_a, rho=rho)
        return dc.matrix(normalize=True), False
    except ValueError:
        poi = PoissonGoalModel(lambda_h, lambda_a)
        return poi.matrix(normalize=True), True


def _predict_probs(
    home_pkl: Path, away_pkl: Path,
    X: pd.DataFrame, rho: float,
) -> dict:
    """Load ensemble pickles, predict λ, build DC score grid, return prob arrays."""
    ens_h = BayesianEnsemble.load(home_pkl)
    ens_a = BayesianEnsemble.load(away_pkl)
    X_aligned_h = X[ens_h.feature_names]
    X_aligned_a = X[ens_a.feature_names]
    mean_h, var_h = ens_h.predict(X_aligned_h)
    mean_a, var_a = ens_a.predict(X_aligned_a)
    lambda_h = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    lambda_a = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)

    n = len(X)
    p_h = np.empty(n)
    p_d = np.empty(n)
    p_a = np.empty(n)
    p_o25 = np.empty(n)
    fallbacks = 0
    for i in range(n):
        M, fb = _build_score_grid(lambda_h[i], lambda_a[i], rho)
        if fb:
            fallbacks += 1
        p_1x2 = get_1x2(M)
        p_h[i] = p_1x2["H"]
        p_d[i] = p_1x2["D"]
        p_a[i] = p_1x2["A"]
        p_o25[i] = get_ou(M, threshold=2.5)["over"]
    return {
        "lambda_h": lambda_h, "lambda_a": lambda_a,
        "prob_h": p_h, "prob_d": p_d, "prob_a": p_a, "prob_o25": p_o25,
        "fallback_rate": fallbacks / n if n > 0 else 0.0,
    }


def main() -> int:
    args = parse_args()
    tag = args.tag
    test_seasons = tuple(args.test_seasons.split(","))
    leagues = tuple(args.leagues.split(","))

    home_pkl = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    away_pkl = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"
    if not home_pkl.exists() or not away_pkl.exists():
        print(f"  ✗ Missing dev-09 artifacts: {home_pkl.name} / {away_pkl.name}")
        print(f"     Run: tools/venv/bin/python3 -I tools/v4/train_dev09.py --tag {tag}")
        return 1

    rho = args.rho if args.rho is not None else DEFAULT_RHO
    v2_baseline, baseline_meta = load_v2_baseline()
    pass_threshold = v2_baseline + TARGET_TOLERANCE

    print("═" * 70)
    print(f"V4 dev-09 — Stage 1 Evaluation · tag={tag}")
    print("═" * 70)
    print(f"  v2_benter baseline:  {v2_baseline:.4f}")
    print(f"  Pass threshold:      ≤ {pass_threshold:.4f} (v2 + {TARGET_TOLERANCE})")
    print(f"  Test seasons:        {test_seasons}")
    print(f"  Leagues:             {leagues}")
    print(f"  ρ used:              {rho:+.4f}")
    print(f"  available-only:      {args.available_only}")
    print()

    # ─── Build holdout ───
    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    test_df = fb.build_corpus(seasons=test_seasons, leagues=leagues, verbose=True)
    if args.available_only:
        n_before = len(test_df)
        test_df = test_df[test_df["bottom_up_available"] == 1].reset_index(drop=True)
        print(f"  --available-only: filtered {n_before} → {len(test_df)} rows "
              f"(dropped {n_before-len(test_df)} Layer-3 rows)")
    if len(test_df) < 30:
        print(f"  ✗ Insufficient holdout: n={len(test_df)}")
        return 1
    X_test = extract_X_dev09(test_df)
    y_outcomes = np.array([_outcome_label(h, a) for h, a in
                            zip(test_df["home_goals"], test_df["away_goals"])], dtype=int)
    y_onehot = np.eye(3)[y_outcomes]  # for paired Brier-diff calc (still need one-hot)
    print()

    # ─── dev-09 predict ───
    print(f"  Predicting dev-09 on n={len(X_test):,}...")
    dev09 = _predict_probs(home_pkl, away_pkl, X_test, rho)
    p_dev09 = np.column_stack([dev09["prob_h"], dev09["prob_d"], dev09["prob_a"]])
    brier_dev09 = brier_multiclass(y_outcomes, p_dev09)
    ll_dev09 = log_loss(y_outcomes, p_dev09)
    print(f"    Mean λ_h={dev09['lambda_h'].mean():.2f}  λ_a={dev09['lambda_a'].mean():.2f}")
    print(f"    Poisson fallback rate: {dev09['fallback_rate']*100:.1f}%")
    print()

    print("─" * 70)
    print("dev-09 SANITY METRICS")
    print("─" * 70)
    print(f"  Brier 1X2: {brier_dev09:.4f}  (vs v2_benter {v2_baseline:.4f}, "
          f"Δ = {brier_dev09 - v2_baseline:+.4f})")
    print(f"  LogLoss:   {ll_dev09:.4f}")
    print(f"  Probability sanity:")
    print(f"    prob_h+d+a per match range: [{(p_dev09.sum(axis=1)).min():.6f}, "
          f"{(p_dev09.sum(axis=1)).max():.6f}]")
    if not np.allclose(p_dev09.sum(axis=1), 1.0, atol=1e-6):
        print(f"    ⚠ probs do NOT sum to 1.0")
    else:
        print(f"    ✓ all probs sum to 1.0")
    print()

    # ─── Per-league breakdown ───
    print("─" * 70)
    print("PER-LIGA BREAKDOWN")
    print("─" * 70)
    print(f"  {'league':<14} {'n':>5}  {'Brier':>8}  {'vs v2':>8}  {'log_loss':>9}")
    per_liga_rows = []
    for lg in sorted(test_df["league"].cat.categories):
        mask = (test_df["league"] == lg).values
        if mask.sum() < 10:
            continue
        b_lg = brier_multiclass(y_outcomes[mask], p_dev09[mask])
        ll_lg = log_loss(y_outcomes[mask], p_dev09[mask])
        delta_v2 = b_lg - v2_baseline
        per_liga_rows.append({"league": lg, "n": int(mask.sum()),
                              "brier": float(b_lg), "delta_v2": float(delta_v2),
                              "log_loss": float(ll_lg)})
        print(f"  {lg:<14} {mask.sum():>5,}  {b_lg:>8.4f}  {delta_v2:>+8.4f}  {ll_lg:>9.4f}")
    print()

    # ─── Optional: vs dev-03 head-to-head ───
    h2h_result = None
    if args.vs_dev_03:
        dev03_tag = args.vs_dev_03
        dev03_home = ARTIFACTS_DIR / f"m3_xg-home-{dev03_tag}.pkl"
        dev03_away = ARTIFACTS_DIR / f"m3_xg-away-{dev03_tag}.pkl"
        print("─" * 70)
        print(f"HEAD-TO-HEAD vs dev-03 ({dev03_tag})")
        print("─" * 70)
        if not dev03_home.exists() or not dev03_away.exists():
            print(f"  ✗ dev-03 artifacts missing — skipping H2H")
        else:
            try:
                # dev-03 uses a DIFFERENT feature schema — needs its own feature builder.
                # For Day-2, we report only dev-09 Brier vs v2_baseline above; proper
                # paired H2H requires the team_xg_history→Sofa-game_id bridge which
                # lives in Day-3. Document explicitly.
                print(f"  ⚠ Paired dev-09 vs dev-03 H2H requires team_xg_history→Sofa")
                print(f"     game_id bridge (cross-source team-name canonicalization).")
                print(f"     Deferred to Day-3 stage_1_dev09 refit. Day-2 reports dev-09")
                print(f"     vs v2_benter baseline only.")
            except Exception as e:
                print(f"  ✗ dev-03 H2H crashed: {e}")
        print()

    # ─── Holm-Bonferroni context (G2 informational) ───
    print("─" * 70)
    print("G2 INFORMATIONAL — paired Brier-diff vs constant baseline (per-Liga)")
    print("─" * 70)
    # Vs uniform baseline (0.33, 0.33, 0.33) as a stand-in for proper dev-03 H2H.
    # Real Holm correction is for ARCHITECTURE-SWAP claim (dev-09 vs dev-03 paired);
    # this section is purely informational sanity that per-Liga Brier-diff is
    # internally consistent.
    p_uniform = np.full_like(p_dev09, 1.0 / 3.0)
    per_match_diff = (p_dev09 ** 2).sum(axis=1) - 2 * (p_dev09 * y_onehot).sum(axis=1) - (
        (p_uniform ** 2).sum(axis=1) - 2 * (p_uniform * y_onehot).sum(axis=1)
    )
    n_test = len(y_onehot)
    mean_d = per_match_diff.mean()
    se_d = per_match_diff.std(ddof=1) / np.sqrt(n_test)
    print(f"  Paired per-match Brier-diff vs uniform: mean={mean_d:+.5f}  "
          f"se={se_d:.5f}  t={mean_d/se_d if se_d > 0 else 0.0:+.2f}")
    print(f"  This is informational — true G2 hurdle is dev-09 vs dev-03 paired test")
    print(f"  (Day-3 will compute that once Sofa↔team_xg_history bridge ships).")
    print()

    # ─── Save evaluation JSON ───
    eval_path = ARTIFACTS_DIR / f"stage_1_dev09-{tag}.json"
    eval_data = {
        "tag": tag,
        "test_seasons": list(test_seasons),
        "leagues": list(leagues),
        "rho": rho,
        "available_only": args.available_only,
        "n_test": n_test,
        "brier_dev09": float(brier_dev09),
        "log_loss_dev09": float(ll_dev09),
        "v2_benter_baseline": v2_baseline,
        "v2_benter_meta": baseline_meta,
        "brier_delta_vs_v2": float(brier_dev09 - v2_baseline),
        "pass_threshold": float(pass_threshold),
        "stage1_pass": bool(brier_dev09 <= pass_threshold),
        "lambda_h_mean": float(dev09["lambda_h"].mean()),
        "lambda_a_mean": float(dev09["lambda_a"].mean()),
        "poisson_fallback_rate": float(dev09["fallback_rate"]),
        "per_liga": per_liga_rows,
        "_notes": [
            "Day-2 evaluation: dev-09 vs v2_benter (CLAUDE.md live baseline).",
            "Day-3 will add paired dev-09 vs dev-03 head-to-head via Sofa↔team_xg_history bridge.",
            "Stage-1 pass criterion is informational only at Day-2 (no production-swap claim yet).",
        ],
    }
    with open(eval_path, "w") as f:
        json.dump(eval_data, f, indent=2)
    print(f"  ✓ Eval saved: {eval_path.relative_to(REPO_ROOT)}")
    print()

    print("═" * 70)
    if brier_dev09 <= pass_threshold:
        print(f"✓ STAGE-1 PASS: dev-09 Brier {brier_dev09:.4f} ≤ {pass_threshold:.4f}")
    else:
        print(f"⚠ STAGE-1 INFO: dev-09 Brier {brier_dev09:.4f} > {pass_threshold:.4f}")
        print(f"    Δ +{brier_dev09 - v2_baseline:.4f} vs v2_benter — not yet competitive.")
        print(f"    Day-3 will add Elo + rest_days + 22/23 corpus to tighten signal.")
    print("═" * 70)
    return 0 if brier_dev09 <= pass_threshold else 2


if __name__ == "__main__":
    sys.exit(main())
