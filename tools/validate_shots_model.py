#!/usr/bin/env python3
"""
FODZE — Shots-xG Model Baseline Validation

Compares the current shots-xg-model predictions against StatsBomb's
per-shot-based real xG (gold-standard ground truth) from the aggregates
CSV produced by tools/statsbomb/parse.py.

Metrics reported:
  MAE          — mean absolute error (predicted xG vs real xG per team-match)
  RMSE         — root mean squared error
  Bias         — mean(predicted - real): positive = systematic overestimate
  R²           — coefficient of determination
  Per-bin MAE  — accuracy by actual-xG bucket (low-xG games easier than high)

Use-case: establishes BASELINE accuracy we need to beat with FootyStats-
direct-ingestion. Without a baseline number we can't evaluate whether
switching to FootyStats-sourced xG actually helps.

Usage:
  python3 tools/validate_shots_model.py
  python3 tools/validate_shots_model.py --csv tools/statsbomb/aggregates.csv
  python3 tools/validate_shots_model.py --model public/shots-xg-model.json
"""

import os
import sys
import csv
import json
import argparse
import math
from collections import defaultdict

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DEFAULT_CSV = os.path.join(PROJECT_ROOT, "tools", "statsbomb", "aggregates.csv")
DEFAULT_MODEL = os.path.join(PROJECT_ROOT, "public", "shots-xg-model.json")


def load_model(path):
    with open(path) as f:
        m = json.load(f)
    # Support both flat (legacy) and nested (per-league + pooled) shapes
    if "pooled" in m:
        return m["pooled"], m.get("leagues", {})
    return m, {}


def predict_xg(coefs, shots_total, shots_on_target):
    """xG = intercept + c_sot × SoT + c_soff × (total - SoT)"""
    if shots_total is None or shots_on_target is None:
        return None
    sot = int(shots_on_target)
    soff = max(0, int(shots_total) - sot)
    pred = (
        coefs["intercept"]
        + coefs["coef_shots_on_target"] * sot
        + coefs["coef_shots_off_target"] * soff
    )
    return max(0.05, pred)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()

    if not os.path.exists(args.csv):
        print(f"❌ Aggregates CSV not found: {args.csv}")
        print("   Run `python3 tools/statsbomb/parse.py` first.")
        sys.exit(1)
    if not os.path.exists(args.model):
        print(f"❌ Model JSON not found: {args.model}")
        sys.exit(1)

    pooled, per_league = load_model(args.model)
    print(f"Model: intercept={pooled['intercept']:.4f}  "
          f"SoT={pooled['coef_shots_on_target']:.4f}  "
          f"SoFF={pooled['coef_shots_off_target']:.4f}")
    print(f"  Reported training R²={pooled.get('r2','?')}  MAE={pooled.get('mae','?')}  n={pooled.get('n_train','?')}")
    if per_league:
        print(f"  Per-league fits: {', '.join(per_league.keys())}")
    print()

    # Load StatsBomb aggregates
    rows = []
    with open(args.csv) as f:
        for r in csv.DictReader(f):
            rows.append(r)
    print(f"Validation corpus: {len(rows)} team-match rows from {args.csv}")

    # Predict + compare
    preds = []
    errors = []
    per_comp = defaultdict(list)
    for r in rows:
        try:
            shots = int(r.get("shots_for") or 0)
            sot = int(r.get("shots_on_target_for") or 0)
            actual = float(r.get("xg_for") or 0)
        except (ValueError, TypeError):
            continue
        if shots == 0 and sot == 0:
            continue
        pred = predict_xg(pooled, shots, sot)
        if pred is None:
            continue
        err = pred - actual
        preds.append((pred, actual, err, r.get("competition", "?")))
        errors.append(err)
        per_comp[r.get("competition", "?")].append((pred, actual, err))

    if not preds:
        print("No usable rows.")
        return

    # Global metrics
    n = len(preds)
    mae = sum(abs(e) for _, _, e, _ in preds) / n
    rmse = math.sqrt(sum(e*e for _, _, e, _ in preds) / n)
    bias = sum(e for _, _, e, _ in preds) / n

    # R²: 1 - ssr/sst
    mean_actual = sum(a for _, a, _, _ in preds) / n
    ss_tot = sum((a - mean_actual) ** 2 for _, a, _, _ in preds)
    ss_res = sum(e ** 2 for _, _, e, _ in preds)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0

    print("\n━━━ BASELINE: shots-xg-model vs StatsBomb real xG ━━━")
    print(f"  n:     {n} team-match rows")
    print(f"  MAE:   {mae:.4f}  (lower = better)")
    print(f"  RMSE:  {rmse:.4f}")
    print(f"  Bias:  {bias:+.4f}  {'(overestimate)' if bias > 0.05 else '(underestimate)' if bias < -0.05 else '(well-centered)'}")
    print(f"  R²:    {r2:.4f}  (training claimed {pooled.get('r2','?')})")

    # Per-competition breakdown
    if len(per_comp) > 1:
        print("\n  Per-competition:")
        for comp, data in sorted(per_comp.items()):
            m = sum(abs(e) for _, _, e in data) / len(data)
            b = sum(e for _, _, e in data) / len(data)
            print(f"    {comp:<28s}  n={len(data):<4d}  MAE={m:.3f}  Bias={b:+.3f}")

    # Per-xg-bucket breakdown
    buckets = [(0, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.5), (2.5, 10)]
    print("\n  Per actual-xG bucket:")
    for lo, hi in buckets:
        in_bucket = [(p, a, e) for p, a, e, _ in preds if lo <= a < hi]
        if not in_bucket:
            continue
        m = sum(abs(e) for _, _, e in in_bucket) / len(in_bucket)
        b = sum(e for _, _, e in in_bucket) / len(in_bucket)
        mean_pred = sum(p for p, _, _ in in_bucket) / len(in_bucket)
        mean_actual_b = sum(a for _, a, _ in in_bucket) / len(in_bucket)
        print(f"    xG ∈ [{lo},{hi:<4}]  n={len(in_bucket):<4d}  mean_actual={mean_actual_b:.2f}  mean_pred={mean_pred:.2f}  MAE={m:.3f}  Bias={b:+.3f}")

    # Extreme outliers
    preds.sort(key=lambda x: abs(x[2]), reverse=True)
    print("\n  Top-5 largest errors:")
    for p, a, e, comp in preds[:5]:
        print(f"    pred={p:.2f}  actual={a:.2f}  err={e:+.2f}  ({comp})")

    # Interpretation
    print("\n━━━ Interpretation ━━━")
    if bias > 0.2:
        print(f"  ⚠ Systematic OVERESTIMATE ({bias:+.2f} avg) — expected since model is")
        print(f"    trained on Top-5 Understat and WM 2022 is higher-quality shots.")
    elif bias < -0.2:
        print(f"  ⚠ Systematic UNDERESTIMATE ({bias:+.2f} avg)")
    else:
        print(f"  ✓ Bias well-centered ({bias:+.2f})")
    print(f"  MAE={mae:.2f} xG per team-match. For context:")
    print(f"    < 0.35 = production-ready")
    print(f"    0.35-0.55 = acceptable but noisy")
    print(f"    > 0.55 = significant room for improvement")
    print(f"  FootyStats-direct-source would give MAE ≈ 0.00 for covered leagues")
    print(f"  (replaces shots→xG approximation with real xG values).")


if __name__ == "__main__":
    main()
