#!/usr/bin/env python3
"""A/B: does training dev-03 on REALIZED xG (instead of real goals) give a better
xG forecast — and what does it cost the 1X2 win-probabilities?

User question (2026-06-01): "predict cleaned xG, not real goals → a clean view of
who SHOULD have won / how close the game was."

This is a clean, production-untouched experiment. IDENTICAL in every way except the
training target:
  arm GOALS : y = home_goals / away_goals     (= current production dev-03 target)
  arm XG    : y = home_xg    / away_xg         (= the user's proposal)
Same matches, same features (locked dev-03 schema), same seeds [42..46], same
Tweedie params, same temporal split (train < 2025-08-01, test = 25/26 OOT).

Measured on the test set, three axes:
  1. xG-RMSE  — each arm's λ vs REALIZED xG. THE axis the user cares about
     ("who should have won"). Stacked home+away (2*n points).
  2. Goals-RMSE — each arm's λ vs REALIZED goals (completeness).
  3. 1X2 Brier — each arm's λ folded through Dixon-Coles → P(H/D/A) vs the ACTUAL
     result. This is the CALIBRATION-RISK check: an xG-trained model may be
     over-confident on match outcomes because xG is less dispersed than goals.

Verdict bars: inter-seed Brier σ ≈ 0.0005 (measured 2026-05-27). A Brier Δ below
that is noise. For RMSE we bootstrap the paired per-match diff (2000 resamples).

Run: DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" tools/venv/bin/python3 tools/backtest/xg_target_ab.py
"""
from __future__ import annotations
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # tools/backtest/<file> → repo root
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))

import json
import numpy as np
import pandas as pd

import score_xg_forecast as X  # _lambdas_to_1x2, _outcome, LAMBDA_MIN/MAX, _name_match
from v4.modules.m3_xg import DEFAULT_RHO, BayesianEnsemble
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.feature_builder import build_features_for_corpus
from v4.data.loaders import load_team_xg_history, load_match_pairs

# Locked dev-03 production schema (mirror of train_m3_xg.py::DEV_03_LOCKED_FEATURES —
# kept inline so this harness doesn't import that script's argparse/main).
DEV_03_LOCKED_FEATURES = [
    "home_attack_ratio", "home_defense_ratio", "away_attack_ratio", "away_defense_ratio",
    "home_ess", "away_ess", "league_home_avg", "league_away_avg", "league_home_advantage",
    "lambda_h_naive", "lambda_a_naive", "attack_defense_ratio_h", "attack_defense_ratio_a",
    "elo_diff", "lineup_quality_diff", "form_streak_diff",
]

SPLIT = "2025-08-01"          # train < SPLIT, test >= SPLIT (25/26 OOT)
SINCE = "2022-07-01"          # same training window as prod dev-03
SEEDS = [42, 43, 44, 45, 46]  # identical to prod
RHO = DEFAULT_RHO
SEED_BOOT = 20260601
N_BOOT = 2000
OUT = Path("/tmp/xg_target_ab.json")


def rmse(pred, true):
    return float(np.sqrt(np.mean((pred - true) ** 2)))


def brier_1x2(lh, la, results):
    """Fold λ through Dixon-Coles → P(H/D/A); multiclass Brier vs actual result.
    `results` = ints from X._outcome (0=H, 1=D, 2=A) = same column order as the probs."""
    p = X._lambdas_to_1x2(lh, la, RHO)          # (n,3) columns H,D,A
    y1h = np.zeros_like(p)
    for i, r in enumerate(results):
        y1h[i, int(r)] = 1.0
    return float(((p - y1h) ** 2).sum(1).mean()), p


def boot_paired_rmse_delta(predA, predB, true, rng):
    """Bootstrap CI of RMSE(B) - RMSE(A) over matched points."""
    n = len(true)
    d = np.empty(N_BOOT)
    for b in range(N_BOOT):
        ix = rng.integers(0, n, n)
        ra = np.sqrt(np.mean((predA[ix] - true[ix]) ** 2))
        rb = np.sqrt(np.mean((predB[ix] - true[ix]) ** 2))
        d[b] = rb - ra
    lo, hi = np.percentile(d, [2.5, 97.5])
    return float(lo), float(hi)


def main() -> int:
    print("═" * 78)
    print("  xG-TARGET A/B  ·  GOALS-target (prod) vs XG-target (proposal)")
    print("═" * 78)

    # ── load once ──
    hist = load_team_xg_history()
    matches = load_match_pairs(since=SINCE)
    need = ["home_goals", "away_goals", "home_xg", "away_xg"]
    matches = matches.dropna(subset=need).reset_index(drop=True)
    # drop rows with degenerate xg (==0 both) — those are no-xG-coverage matches
    keep = ~((matches["home_xg"] <= 0) & (matches["away_xg"] <= 0))
    matches = matches[keep].reset_index(drop=True)
    md = pd.to_datetime(matches["match_date"])
    print(f"  matches with goals+xg: {len(matches)}  ({md.min().date()}…{md.max().date()})")

    # ── features once (identical X for both arms) ──
    elo = EloCalculator().fit(hist)
    feats = build_features_for_corpus(matches, hist, elo_calculator=elo, verbose=False)
    feats = feats.reset_index(drop=True)
    feats["match_date"] = pd.to_datetime(matches["match_date"].values)
    feats["home_xg"] = matches["home_xg"].values
    feats["away_xg"] = matches["away_xg"].values

    # ── ANTI-GARBAGE GUARD: a missing or all-zero feature would silently invalidate
    # the whole A/B (the lesson from this session's fabricated-number incident). Abort
    # loudly instead. lineup_quality_diff is allowed to be all-zero (no PlayerLineup
    # calculator wired here) — but then it's INERT for BOTH arms, so the A/B stays fair.
    missing = [c for c in DEV_03_LOCKED_FEATURES if c not in feats.columns]
    if missing:
        print(f"  ✗ ABORT: feature columns missing from build → {missing}")
        print("    (build_features_for_corpus did not emit the locked schema; the A/B "
              "would be invalid. Fix the builder wiring before trusting any result.)")
        return 2
    allzero = [c for c in DEV_03_LOCKED_FEATURES
               if float(np.abs(feats[c].to_numpy(float)).sum()) == 0.0]
    # Only lineup_quality_diff may legitimately be all-zero (no PLC here). Anything else
    # all-zero means a broken feature → invalid.
    bad_zero = [c for c in allzero if c != "lineup_quality_diff"]
    if bad_zero:
        print(f"  ✗ ABORT: feature columns are ALL-ZERO (broken) → {bad_zero}")
        return 2
    if allzero:
        print(f"  ⚠ note: {allzero} all-zero (inert for BOTH arms → A/B still fair)")

    Xcols = DEV_03_LOCKED_FEATURES + ["league"]
    Xall = feats[Xcols].copy()
    tr = feats["match_date"] < SPLIT
    te = ~tr
    n_tr, n_te = int(tr.sum()), int(te.sum())
    print(f"  split @ {SPLIT}: train {n_tr} · test(25/26 OOT) {n_te}")
    if n_te < 500:
        print("  ✗ too few test matches"); return 1

    Xtr, Xte = Xall[tr], Xall[te]
    res = np.array([X._outcome(h, a) for h, a in
                    zip(feats["home_goals"][te], feats["away_goals"][te])])
    true_goals_h = feats["home_goals"][te].to_numpy(float)
    true_goals_a = feats["away_goals"][te].to_numpy(float)
    true_xg_h = feats["home_xg"][te].to_numpy(float)
    true_xg_a = feats["away_xg"][te].to_numpy(float)

    def train_predict(yh_col, ya_col):
        eh = BayesianEnsemble(n_models=5, seeds=SEEDS)
        ea = BayesianEnsemble(n_models=5, seeds=SEEDS)
        eh.fit(Xtr, feats[yh_col][tr].to_numpy(float), categorical_columns=["league"])
        ea.fit(Xtr, feats[ya_col][tr].to_numpy(float), categorical_columns=["league"])
        # BayesianEnsemble.predict() returns (mean, var) — take the mean ([0]).
        lh = np.clip(eh.predict(Xte)[0], X.LAMBDA_MIN, X.LAMBDA_MAX)
        la = np.clip(ea.predict(Xte)[0], X.LAMBDA_MIN, X.LAMBDA_MAX)
        return lh, la

    print("\n  training GOALS-target arm (prod)…")
    g_lh, g_la = train_predict("home_goals", "away_goals")
    print("  training XG-target arm (proposal)…")
    x_lh, x_la = train_predict("home_xg", "away_xg")

    # ── metrics ──
    # stack home+away for RMSE axes
    g_lam = np.concatenate([g_lh, g_la]); x_lam = np.concatenate([x_lh, x_la])
    t_xg = np.concatenate([true_xg_h, true_xg_a])
    t_goals = np.concatenate([true_goals_h, true_goals_a])

    out = {"n_train": n_tr, "n_test": n_te, "split": SPLIT, "seeds": SEEDS,
           "inter_seed_brier_sigma": 0.0005}

    # axis 1: xG-RMSE (THE axis)
    out["xg_rmse_goals_arm"] = rmse(g_lam, t_xg)
    out["xg_rmse_xg_arm"] = rmse(x_lam, t_xg)
    rng = np.random.default_rng(SEED_BOOT)
    lo, hi = boot_paired_rmse_delta(g_lam, x_lam, t_xg, rng)
    out["xg_rmse_delta"] = out["xg_rmse_xg_arm"] - out["xg_rmse_goals_arm"]
    out["xg_rmse_delta_ci95"] = [lo, hi]

    # axis 2: goals-RMSE
    out["goals_rmse_goals_arm"] = rmse(g_lam, t_goals)
    out["goals_rmse_xg_arm"] = rmse(x_lam, t_goals)

    # axis 3: 1X2 Brier (calibration risk)
    out["brier_goals_arm"], pg = brier_1x2(g_lh, g_la, res)
    out["brier_xg_arm"], px = brier_1x2(x_lh, x_la, res)
    out["brier_delta"] = out["brier_xg_arm"] - out["brier_goals_arm"]

    # calibration sharpness: mean max-prob (higher = more confident)
    out["confidence_goals_arm"] = float(pg.max(1).mean())
    out["confidence_xg_arm"] = float(px.max(1).mean())
    # mean predicted total λ (xg-arm should sit lower if xg<goals on avg)
    out["mean_total_lambda_goals_arm"] = float((g_lh + g_la).mean())
    out["mean_total_lambda_xg_arm"] = float((x_lh + x_la).mean())
    out["mean_realized_total_goals"] = float((true_goals_h + true_goals_a).mean())
    out["mean_realized_total_xg"] = float((true_xg_h + true_xg_a).mean())

    OUT.write_text(json.dumps(out, indent=2))

    # ── report ──
    def tag_rmse(delta, lo, hi):
        if hi < 0: return "XG-arm BETTER (CI<0, robust)"
        if lo > 0: return "XG-arm WORSE (CI>0, robust)"
        return "TIE (CI spans 0)"
    def tag_brier(delta):
        if abs(delta) < 0.0005: return "TIE (< inter-seed σ)"
        return ("XG-arm BETTER" if delta < 0 else "XG-arm WORSE") + f" ({delta:+.4f}, > σ)"

    print("\n" + "─" * 78)
    print("  AXIS 1 — xG-RMSE (predicted λ vs REALIZED xG · 'who should have won')")
    print(f"    GOALS-target arm : {out['xg_rmse_goals_arm']:.4f}")
    print(f"    XG-target arm    : {out['xg_rmse_xg_arm']:.4f}")
    print(f"    Δ (xg-goals)     : {out['xg_rmse_delta']:+.4f}  CI[{lo:+.4f},{hi:+.4f}]  → {tag_rmse(out['xg_rmse_delta'],lo,hi)}")
    print("\n  AXIS 2 — Goals-RMSE (predicted λ vs REALIZED goals)")
    print(f"    GOALS-target arm : {out['goals_rmse_goals_arm']:.4f}")
    print(f"    XG-target arm    : {out['goals_rmse_xg_arm']:.4f}")
    print("\n  AXIS 3 — 1X2 Brier (λ→Dixon-Coles→P(H/D/A) vs ACTUAL result · CALIBRATION RISK)")
    print(f"    GOALS-target arm : {out['brier_goals_arm']:.4f}")
    print(f"    XG-target arm    : {out['brier_xg_arm']:.4f}")
    print(f"    Δ (xg-goals)     : {out['brier_delta']:+.4f}  → {tag_brier(out['brier_delta'])}")
    print("\n  diagnostics:")
    print(f"    mean total λ  goals-arm {out['mean_total_lambda_goals_arm']:.2f} · "
          f"xg-arm {out['mean_total_lambda_xg_arm']:.2f}")
    print(f"    realized total goals {out['mean_realized_total_goals']:.2f} · "
          f"realized total xg {out['mean_realized_total_xg']:.2f}")
    print(f"    mean top-prob (confidence) goals-arm {out['confidence_goals_arm']:.3f} · "
          f"xg-arm {out['confidence_xg_arm']:.3f}")
    print("─" * 78)
    print(f"  ✓ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
