#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE Backtest Metrics — statistical evaluation of OOT predictions
═══════════════════════════════════════════════════════════════════

Reads a prediction parquet (schema defined by retrain_v2.py's OOT
export) and computes Brier / LogLoss / RPS / ECE plus a Brier-Skill-
Score vs base-rate climatology so "does the model actually beat
picking the league-average result" becomes a single number.

Usage:
  tools/venv/bin/python tools/backtest/metrics.py
  tools/venv/bin/python tools/backtest/metrics.py \\
      --parquet tools/backtest/v2-oot-predictions.parquet \\
      --out     tools/backtest/v2-oot-metrics.json

The output JSON is gitignored (same pattern as the input parquet);
regenerate locally by re-running. This script has no side-effects
beyond writing the output path and printing to stdout.
═══════════════════════════════════════════════════════════════════
"""

import json
import os
import argparse
from typing import Dict, Any

import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DEFAULT_PARQUET = os.path.join(PROJECT_ROOT, "tools", "backtest", "v2-oot-predictions.parquet")
DEFAULT_OUT = os.path.join(PROJECT_ROOT, "tools", "backtest", "v2-oot-metrics.json")

RESULT_CLASSES = ("H", "D", "A")
RESULT_INDEX = {c: i for i, c in enumerate(RESULT_CLASSES)}

# Below this sample count per-league metrics are very noisy; we still
# report them but flag them in the output so downstream tooling knows
# to treat them with caution.
MIN_STABLE_SAMPLE = 100


# ═══════════════════════════════════════════════════════════════════
# Metric functions — each takes (probs: [N,3], actual: [N] of H/D/A)
# ═══════════════════════════════════════════════════════════════════

def _onehot(actual: np.ndarray) -> np.ndarray:
    oh = np.zeros((len(actual), 3), dtype=float)
    for i, c in enumerate(actual):
        oh[i, RESULT_INDEX[c]] = 1.0
    return oh


def brier_3class(probs: np.ndarray, actual: np.ndarray) -> float:
    return float(np.mean(np.sum((probs - _onehot(actual)) ** 2, axis=1)))


def log_loss(probs: np.ndarray, actual: np.ndarray, eps: float = 1e-12) -> float:
    clipped = np.clip(probs, eps, 1.0)
    idx = np.array([RESULT_INDEX[c] for c in actual])
    return float(-np.mean(np.log(clipped[np.arange(len(idx)), idx])))


def rps_ordinal(probs: np.ndarray, actual: np.ndarray) -> float:
    """
    Ranked Probability Score for the ordered outcome H > D > A.
    Penalizes predicting A when H happened more than predicting D,
    which plain Brier doesn't. Constant = 0.5 × Σ(F_pred − F_act)²
    over the first K−1 classes.
    """
    cum_pred = np.cumsum(probs, axis=1)
    cum_act = np.zeros_like(cum_pred)
    for i, c in enumerate(actual):
        if c == "H":
            cum_act[i] = [1.0, 1.0, 1.0]
        elif c == "D":
            cum_act[i] = [0.0, 1.0, 1.0]
        else:
            cum_act[i] = [0.0, 0.0, 1.0]
    # Drop the last column (always 1.0 on both sides → zero contribution)
    return float(0.5 * np.mean(np.sum((cum_pred[:, :2] - cum_act[:, :2]) ** 2, axis=1)))


def ece_10bucket(probs: np.ndarray, actual: np.ndarray, n_bins: int = 10) -> Dict[str, Any]:
    """
    Expected Calibration Error on the argmax class — standard top-label
    ECE. Returns {ece, reliability[]} so downstream tooling can draw a
    calibration plot without re-reading the parquet.
    """
    pred_class = np.argmax(probs, axis=1)
    pred_conf = probs[np.arange(len(probs)), pred_class]
    actual_idx = np.array([RESULT_INDEX[c] for c in actual])
    correct = (pred_class == actual_idx).astype(float)

    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    reliability = []
    ece = 0.0
    n = len(probs)
    for i in range(n_bins):
        lo, hi = bin_edges[i], bin_edges[i + 1]
        if i == n_bins - 1:
            mask = (pred_conf >= lo) & (pred_conf <= hi)
        else:
            mask = (pred_conf >= lo) & (pred_conf < hi)
        count = int(mask.sum())
        if count == 0:
            reliability.append({"lo": lo, "hi": hi, "n": 0, "avg_conf": None, "accuracy": None})
            continue
        avg_conf = float(pred_conf[mask].mean())
        accuracy = float(correct[mask].mean())
        ece += (count / n) * abs(avg_conf - accuracy)
        reliability.append({"lo": lo, "hi": hi, "n": count, "avg_conf": avg_conf, "accuracy": accuracy})
    return {"ece": float(ece), "reliability": reliability}


# ═══════════════════════════════════════════════════════════════════
# Aggregation
# ═══════════════════════════════════════════════════════════════════

def compute_metrics(df: pd.DataFrame) -> Dict[str, Any]:
    probs = df[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].to_numpy()
    actual = df["ft_result"].to_numpy()

    # Climatology: constant-prob forecast using this split's base rates.
    # The toughest "dumb" baseline — tougher than pick-home because
    # pick-home assigns 100% to H and gets smashed by 1-0.56 = 0.44
    # Brier on away wins. Constant base rate is the mathematically
    # minimal climatology that's still class-aware.
    base_rate = np.array([float((actual == c).mean()) for c in RESULT_CLASSES])
    base_probs = np.tile(base_rate, (len(actual), 1))

    brier = brier_3class(probs, actual)
    brier_clim = brier_3class(base_probs, actual)
    bss = (1.0 - brier / brier_clim) if brier_clim > 0 else 0.0

    ece_result = ece_10bucket(probs, actual)

    return {
        "n": int(len(df)),
        "brier": round(brier, 6),
        "brier_climatology": round(brier_clim, 6),
        "brier_skill_score": round(bss, 6),
        "log_loss": round(log_loss(probs, actual), 6),
        "rps": round(rps_ordinal(probs, actual), 6),
        "ece_10bucket": round(ece_result["ece"], 6),
        "reliability": ece_result["reliability"],
        "base_rate": {c: round(float(base_rate[i]), 4) for i, c in enumerate(RESULT_CLASSES)},
        "low_sample": bool(len(df) < MIN_STABLE_SAMPLE),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute OOT backtest metrics.")
    parser.add_argument("--parquet", default=DEFAULT_PARQUET,
                        help="Input parquet from retrain_v2.py OOT export.")
    parser.add_argument("--out", default=DEFAULT_OUT,
                        help="Output JSON path.")
    args = parser.parse_args()

    if not os.path.exists(args.parquet):
        raise SystemExit(
            f"Parquet not found: {args.parquet}\n"
            "Regenerate via: tools/venv/bin/python tools/retrain_v2.py "
            "--no-optuna --skip-public-export --use-full-csv --use-tactics "
            "--use-players --use-roster --use-shots"
        )

    df = pd.read_parquet(args.parquet)
    print(f"Loaded {len(df)} rows from {args.parquet}")

    overall = compute_metrics(df)
    per_league = {
        lg: compute_metrics(df[df["league"] == lg])
        for lg in sorted(df["league"].unique())
    }

    output = {
        "generated_at": pd.Timestamp.now().isoformat(),
        "source_parquet": os.path.relpath(args.parquet, PROJECT_ROOT),
        "overall": overall,
        "per_league": per_league,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(output, f, indent=2)

    # ─── Human-readable summary ───
    print("\n" + "═" * 64)
    print(f"OOT METRICS — overall ({overall['n']} rows)")
    print("═" * 64)
    print(f"  Brier:           {overall['brier']:.4f}")
    print(f"  Climatology BS:  {overall['brier_climatology']:.4f}")
    print(f"  Skill Score:     {overall['brier_skill_score']:+.4f}"
          f"   {'← beats climatology' if overall['brier_skill_score'] > 0 else '← WORSE than climatology'}")
    print(f"  Log-Loss:        {overall['log_loss']:.4f}")
    print(f"  RPS:             {overall['rps']:.4f}")
    print(f"  ECE (10-bin):    {overall['ece_10bucket']:.4f}"
          f"   {'← well-calibrated' if overall['ece_10bucket'] < 0.05 else '← miscalibrated'}")
    br = overall["base_rate"]
    print(f"  Base rate:       H={br['H']:.3f}  D={br['D']:.3f}  A={br['A']:.3f}")

    print(f"\n  Per-league  ({len(per_league)} leagues, ≥{MIN_STABLE_SAMPLE} rows = stable):")
    print(f"  {'league':<18} {'N':>6}  {'Brier':>8}  {'BSS':>8}  {'LogLoss':>8}  {'ECE':>6}  flag")
    print(f"  {'─' * 62}")
    for lg, m in sorted(per_league.items(), key=lambda x: -x[1]["brier_skill_score"]):
        flag = "low-n" if m["low_sample"] else ""
        print(f"  {lg:<18} {m['n']:>6}  {m['brier']:>8.4f}  {m['brier_skill_score']:>+8.4f}  "
              f"{m['log_loss']:>8.4f}  {m['ece_10bucket']:>6.4f}  {flag}")

    print(f"\n  Written: {args.out}")


if __name__ == "__main__":
    main()
