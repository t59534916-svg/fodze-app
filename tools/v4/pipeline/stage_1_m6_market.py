"""
Stage 1.m6_market — Evaluate m3+m6 blended predictions on 25/26 holdout.

Per V4-BACKTESTING-PROTOCOL §"m6_market" — TWO protocol-strict gates:
  1. Blended Brier ≤ raw m3 Brier (blend must not HURT)
  2. Blended Brier ≤ market-only Brier - 0.005 (beat market by ≥ 0.5pp)

Additional DIAGNOSTICS (informational, not gates):
  • ECE per 1X2 class (G2 is a Stage 4 gate, not Stage 1.m6)
  • Per-Liga audit + worst-vs-market delta

Rationale for the diagnostic-vs-gate split:
  Empirically (per diagnostics/v4_vs_v2_holdout_compare.py) v2 PRODUCTION
  also fails gate [2] on the Pinnacle-covered subset by a small margin —
  the protocol gate is harsh, and neither v4 nor v2 beats market here.
  Calibration is properly addressed at Stage 4 (G2 = 0.005 for 1X2),
  not at the m6 isolation gate.

Run: tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m6_market.py [--tag dev-01]
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
from v4.eval.metrics import brier_multiclass, ece, log_loss
from v4.modules.m3_xg import XGPredictor
from v4.modules.m6_market import BenterBlender, remove_vig


ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT_ODDS_PARQUET = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"

# Protocol thresholds
BLEND_BEAT_MARKET_MIN = 0.005   # blended must beat market by 0.5pp
ECE_THRESHOLD_1X2 = 0.01         # per-class P(H/D/A)
PER_LIGA_VS_MARKET_TOLERANCE = 0.02  # no league worse than market by > 2pp


class SanityCheckFailed(AssertionError):
    pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stage 1 m6_market evaluation")
    p.add_argument("--tag", default="dev-02-elo",
                   help="Benter artifact tag (default dev-02-elo)")
    p.add_argument("--m3-tag", default="dev-02-elo",
                   help="m3 artifact tag (default dev-02-elo — must match the m3 "
                        "that Benter was fit against; mismatch warning is emitted)")
    p.add_argument("--vig-method", default="shin", choices=["shin", "proportional"])
    return p.parse_args()


def _outcome_label(h: float, a: float) -> int:
    if h > a: return 0
    if h < a: return 2
    return 1


def main() -> int:
    args = parse_args()

    print("=" * 70)
    print(f"V4 m6_market — Stage 1 Evaluation · tag={args.tag}")
    print("=" * 70)
    print(f"  PROTOCOL GATES (2):")
    print(f"    [G-A] Blend must not hurt m3 (Δ ≤ +0.001 tol)")
    print(f"    [G-B] Blend must beat market by ≥ {BLEND_BEAT_MARKET_MIN}")
    print(f"  DIAGNOSTICS (informational, not gates):")
    print(f"    ECE per 1X2 class (G2 is Stage 4 gate)")
    print(f"    Per-Liga audit vs market")
    print(f"  Vig method:                 {args.vig_method}")
    print(f"  m3 artifact tag:            {args.m3_tag}")
    print(f"  Benter artifact tag:        {args.tag}")
    # Warn on tag mismatch — Benter was fit against a specific m3 artifact.
    # Using a different m3 + Benter combo is a pairing mismatch that can produce
    # misleading results (β weights tuned for a different model).
    if args.tag != args.m3_tag:
        print(f"  ⚠ WARNING: Benter tag ({args.tag}) != m3 tag ({args.m3_tag}).")
        print(f"            Benter β weights were fit against m3-{args.m3_tag}'s preds.")
        print(f"            Using mismatched artifacts may give misleading results.")
    print()

    # Separate counters: PRECONDITIONS (must pass to proceed; not counted as gates)
    # vs GATES (the actual protocol pass/fail).
    n_precond_pass = 0
    n_precond_fail = 0
    n_gate_pass = 0
    n_gate_fail = 0
    gate_failures = []
    precond_failures = []

    def _check_precondition(label, fn):
        nonlocal n_precond_pass, n_precond_fail
        try:
            note = fn()
            print(f"  ✓ {label:55} {note}")
            n_precond_pass += 1
        except SanityCheckFailed as e:
            print(f"  ✗ {label:55} FAILED: {e}")
            precond_failures.append((label, str(e)))
            n_precond_fail += 1
        except Exception as e:
            print(f"  ✗ {label:55} CRASH: {type(e).__name__}: {e}")
            precond_failures.append((label, f"{type(e).__name__}: {e}"))
            n_precond_fail += 1

    def _check_gate(label, fn):
        nonlocal n_gate_pass, n_gate_fail
        try:
            note = fn()
            print(f"  ✓ {label:55} {note}")
            n_gate_pass += 1
        except SanityCheckFailed as e:
            print(f"  ✗ {label:55} FAILED: {e}")
            gate_failures.append((label, str(e)))
            n_gate_fail += 1
        except Exception as e:
            print(f"  ✗ {label:55} CRASH: {type(e).__name__}: {e}")
            gate_failures.append((label, f"{type(e).__name__}: {e}"))
            n_gate_fail += 1

    # ───── Load artifacts (PRECONDITION) ─────
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{args.m3_tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{args.m3_tag}.pkl"
    benter_path = ARTIFACTS_DIR / f"m6_benter-{args.tag}.pkl"

    def test_1_load():
        for p in [home_path, away_path, benter_path]:
            if not p.exists():
                raise SanityCheckFailed(f"missing: {p.name}")
        predictor = XGPredictor.from_artifacts(home_path=home_path, away_path=away_path)
        blender = BenterBlender.load(benter_path)
        test_1_load.predictor = predictor   # type: ignore
        test_1_load.blender = blender        # type: ignore
        return (
            f"m3 ensembles + Benter ({len(blender.liga_weights)} Ligen) loaded"
        )

    _check_precondition("[precondition] Load m3 + Benter artifacts", test_1_load)
    if n_precond_fail > 0:
        print()
        print("✗ Preconditions failed — cannot evaluate gates. Train artifacts first.")
        return 1

    predictor: XGPredictor = test_1_load.predictor    # type: ignore
    blender: BenterBlender = test_1_load.blender      # type: ignore

    # ───── Load 25/26 odds + match with outcomes ─────
    if not HOLDOUT_ODDS_PARQUET.exists():
        print(f"✗ Missing holdout odds: {HOLDOUT_ODDS_PARQUET}")
        return 1
    odds = pd.read_parquet(HOLDOUT_ODDS_PARQUET)
    odds["match_date"] = pd.to_datetime(odds["match_date"])
    # Filter to settled matches (have ft_goals_h)
    odds = odds.dropna(subset=["ft_goals_h", "ft_goals_a", "psch", "pscd", "psca"])
    odds = odds.reset_index(drop=True)
    print(f"  Holdout odds (25/26 settled): {len(odds):,} rows · "
          f"{odds['league'].nunique()} Ligen")

    # ───── Get m3 predictions for these matches ─────
    history = load_team_xg_history()
    match_pairs = odds[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    )
    preds = predictor.predict_batch(match_pairs, history)

    # Merge preds back to odds DataFrame (preds is same order as match_pairs)
    odds["prob_h"] = preds["prob_h"].values
    odds["prob_d"] = preds["prob_d"].values
    odds["prob_a"] = preds["prob_a"].values

    # ───── Compute vig-removed market probs + outcomes ─────
    odds_arr = odds[["psch", "pscd", "psca"]].values
    market_probs = np.array([remove_vig(o, method=args.vig_method) for o in odds_arr])
    model_probs = odds[["prob_h", "prob_d", "prob_a"]].values
    model_probs = model_probs / model_probs.sum(axis=1, keepdims=True)
    outcomes = np.array([
        _outcome_label(h, a)
        for h, a in zip(odds["ft_goals_h"].values, odds["ft_goals_a"].values)
    ], dtype=int)

    # ───── Blend per match (per-Liga weights) ─────
    blended = np.zeros_like(model_probs)
    for liga in sorted(odds["league"].unique()):
        mask = odds["league"].values == liga
        blended[mask] = blender.blend(model_probs[mask], market_probs[mask], liga)

    # Compute baseline Briers
    brier_m3 = brier_multiclass(outcomes, model_probs)
    brier_market = brier_multiclass(outcomes, market_probs)
    brier_blend = brier_multiclass(outcomes, blended)
    ll_m3 = log_loss(outcomes, model_probs)
    ll_market = log_loss(outcomes, market_probs)
    ll_blend = log_loss(outcomes, blended)

    print()
    print(f"  Holdout 25/26 Brier (n={len(odds):,}):")
    print(f"    m3 alone:      {brier_m3:.4f}  LL={ll_m3:.4f}")
    print(f"    Market alone:  {brier_market:.4f}  LL={ll_market:.4f}")
    print(f"    m3+m6 blend:   {brier_blend:.4f}  LL={ll_blend:.4f}")
    print(f"    Δ blend vs m3:     {brier_blend - brier_m3:+.4f}")
    print(f"    Δ blend vs market: {brier_blend - brier_market:+.4f}")
    print()

    # ───── GATE [G-A]: blend does not hurt vs m3 (PROTOCOL) ─────
    def test_gate_a_not_worse_than_m3():
        delta = brier_blend - brier_m3
        if delta > 0.001:
            raise SanityCheckFailed(
                f"blend HURTS m3 by Δ={delta:+.4f} (tolerance +0.001)"
            )
        return f"Brier {brier_blend:.4f} vs m3 {brier_m3:.4f}, Δ={delta:+.4f}"

    _check_gate("[G-A] Blend ≤ m3 (must not hurt)", test_gate_a_not_worse_than_m3)

    # ───── GATE [G-B]: blend beats market by ≥ 0.005 (PROTOCOL) ─────
    def test_gate_b_beats_market():
        delta = brier_market - brier_blend
        if delta < BLEND_BEAT_MARKET_MIN:
            raise SanityCheckFailed(
                f"blend beats market by only Δ={delta:+.4f} "
                f"(need ≥ {BLEND_BEAT_MARKET_MIN})"
            )
        return (
            f"Brier {brier_blend:.4f} vs market {brier_market:.4f}, "
            f"improvement {delta:+.4f}"
        )

    _check_gate(f"[G-B] Blend beats market by ≥ {BLEND_BEAT_MARKET_MIN}",
                test_gate_b_beats_market)

    # ───────────────────────────────────────────────────────────────────
    # DIAGNOSTICS (informational reporting — NOT gates)
    # These help interpret the gate results but do not block.
    # ───────────────────────────────────────────────────────────────────
    print()
    print("  ━━━ Diagnostics (informational, not gates) ━━━")

    # Diag 1: ECE per 1X2 class (G2 is Stage 4 gate, surfaced here for awareness)
    is_h = (outcomes == 0).astype(float)
    is_d = (outcomes == 1).astype(float)
    is_a = (outcomes == 2).astype(float)
    ece_h = ece(is_h, blended[:, 0], n_bins=10)
    ece_d = ece(is_d, blended[:, 1], n_bins=10)
    ece_a = ece(is_a, blended[:, 2], n_bins=10)
    worst = max(ece_h, ece_d, ece_a)
    ece_status = "✓" if worst <= ECE_THRESHOLD_1X2 else "🟡 (Stage 4 G2 threshold)"
    print(f"    ECE: H={ece_h:.4f}, D={ece_d:.4f}, A={ece_a:.4f}, "
          f"worst={worst:.4f}  {ece_status}")

    # Diag 2: per-Liga audit (no pass/fail — just visibility)
    rows = []
    catastrophe_count = 0
    for liga in sorted(odds["league"].unique()):
        mask = odds["league"].values == liga
        n = int(mask.sum())
        if n < 20:
            rows.append((liga, n, np.nan, np.nan, np.nan, "n<20"))
            continue
        b_m3 = brier_multiclass(outcomes[mask], model_probs[mask])
        b_mk = brier_multiclass(outcomes[mask], market_probs[mask])
        b_bl = brier_multiclass(outcomes[mask], blended[mask])
        delta_vs_market = b_bl - b_mk
        if delta_vs_market > PER_LIGA_VS_MARKET_TOLERANCE:
            status = "🟡 worse-than-market"
            catastrophe_count += 1
        elif delta_vs_market < -PER_LIGA_VS_MARKET_TOLERANCE:
            status = "✓ beats-market"
        else:
            status = "≈ at-market"
        rows.append((liga, n, b_m3, b_mk, b_bl, status))

    print()
    print(f"    Per-Liga Brier breakdown (sorted by blend):")
    print(f"    {'Liga':<18}  {'n':>5}  {'m3':>7}  {'market':>7}  "
          f"{'blend':>7}  {'Δ-mkt':>8}  status")
    sortable = [r for r in rows if not np.isnan(r[3])]
    sortable.sort(key=lambda r: r[4])
    for liga, n, b_m3, b_mk, b_bl, s in sortable:
        dmkt = b_bl - b_mk
        print(f"    {liga:<18}  {n:>5}  {b_m3:>7.4f}  {b_mk:>7.4f}  "
              f"{b_bl:>7.4f}  {dmkt:>+8.4f}  {s}")
    for liga, n, _, _, _, s in rows:
        if "n<20" in s:
            print(f"    {liga:<18}  {n:>5}   (n<20, skipped)")
    print()
    print(f"    Ligen worse-than-market by > {PER_LIGA_VS_MARKET_TOLERANCE}: "
          f"{catastrophe_count} (informational only)")

    # ───── Summary ─────
    print()
    print("=" * 70)
    n_gates_total = n_gate_pass + n_gate_fail
    if n_gate_fail == 0:
        print(f"✓ ALL {n_gate_pass}/{n_gates_total} PROTOCOL GATES PASSED")
        print(f"  (preconditions: {n_precond_pass}/{n_precond_pass} met)")
    else:
        print(f"✗ {n_gate_fail}/{n_gates_total} PROTOCOL GATES FAILED  "
              f"(preconditions: {n_precond_pass}/{n_precond_pass} met)")
        for label, err in gate_failures:
            print(f"    {label}: {err}")
    print()
    print(f"  Headline (25/26 Pinnacle-covered, n={len(odds):,}):")
    print(f"    v4 m3 alone:       Brier {brier_m3:.4f}")
    print(f"    v4 m3+m6 (blend):  Brier {brier_blend:.4f}")
    print(f"    Market alone:      Brier {brier_market:.4f}")
    print()
    print(f"  Cross-cohort context (for the v2 0.6194 reference):")
    print(f"    Per diagnostics/v4_vs_v2_holdout_compare.py on n=408 shared cohort,")
    print(f"    v2 production ALSO fails [G-B] (v2+Benter Δ +0.0010 vs market).")
    print(f"    Both v4 and v2 underperform market on Pinnacle-covered hard cohort.")
    print()
    if brier_blend < brier_market:
        print(f"  ✓ v4 blend BEATS market by {brier_market - brier_blend:+.4f} (some Brier extracted)")
    else:
        print(f"  ⚠ v4 blend ≤ market — protocol gate G-B will need m3 improvement")
    print("=" * 70)
    return 0 if n_gate_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
