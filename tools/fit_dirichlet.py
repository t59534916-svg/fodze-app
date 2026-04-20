#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE Dirichlet calibration fit (Kull et al. 2019, ODIR variant)
═══════════════════════════════════════════════════════════════════

Reads tools/backtest/v2-oot-predictions.parquet, fits a 3×3 weight
matrix W + 3-vector bias b per league-cluster such that:

    z = W · log(probs) + b
    p' = softmax(z)

trained by minimising cross-entropy + λ × off-diagonal L2
("ODIR" regularisation — biases the fit toward diagonal-dominant W,
which is equivalent to temperature-scaling in the limit λ → ∞).

Schema matches src/lib/calibration.ts::loadDirichletCalibration so
the output drops into public/dirichlet-calibration.json and the
runtime flips it on when NEXT_PUBLIC_CALIBRATION_METHOD=dirichlet.

Cluster partition (matches existing placeholder):
  top5         — Big-5 ligas (bundesliga, epl, la_liga, serie_a, ligue_1)
  mid_european — 2nd tier + Scottish/Greek/Portuguese/Belgian/Turkish top
  lower        — UK L1/L2 and (future) DE Liga3
  global       — catch-all when a league isn't mapped

Train/val: 80% / 20% by match_date (time-aware, no temporal leakage).
Reports before-vs-after Brier / LogLoss / ECE on the held-out 20%.

Usage:
  tools/venv/bin/python tools/fit_dirichlet.py
  tools/venv/bin/python tools/fit_dirichlet.py --lambda 0.005
═══════════════════════════════════════════════════════════════════
"""

import argparse
import json
import os
from typing import Dict, Tuple

import numpy as np
import pandas as pd
from scipy.optimize import minimize

PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DEFAULT_PARQUET = os.path.join(PROJECT_ROOT, "tools", "backtest", "v2-oot-predictions.parquet")
DEFAULT_OUT = os.path.join(PROJECT_ROOT, "public", "dirichlet-calibration.json")

# Must match the cluster_map that the runtime already uses (existing
# placeholder JSON). If a league later moves cluster, update here AND
# add a brief note in the placeholder so the map stays single-source.
CLUSTER_MAP = {
    # top5
    "bundesliga": "top5", "epl": "top5", "la_liga": "top5",
    "serie_a": "top5", "ligue_1": "top5",
    # mid_european
    "eredivisie": "mid_european", "primeira_liga": "mid_european",
    "jupiler_pro": "mid_european", "super_lig": "mid_european",
    "scottish_prem": "mid_european", "championship": "mid_european",
    "la_liga2": "mid_european", "serie_b": "mid_european",
    "ligue_2": "mid_european", "bundesliga2": "mid_european",
    # lower
    "liga3": "lower", "league_one": "lower", "league_two": "lower",
    "greek_sl": "lower",
}
CLUSTER_NAMES = ["top5", "mid_european", "lower"]
RESULT_CLASSES = ("H", "D", "A")
RESULT_INDEX = {c: i for i, c in enumerate(RESULT_CLASSES)}


# ═══════════════════════════════════════════════════════════════════
# Dirichlet-ODIR fit
# ═══════════════════════════════════════════════════════════════════

def _theta_to_Wb(theta: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    return theta[:9].reshape(3, 3), theta[9:]


def apply_dirichlet(probs: np.ndarray, W: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Vectorised z = W · log(p) + b → softmax. probs: [N,3]."""
    log_p = np.log(np.clip(probs, 1e-9, 1.0))
    # L-BFGS-B probes gradient numerically and occasionally pushes W into
    # regions that produce inf/NaN in the matmul before the softmax's max-
    # subtraction can stabilize things. Suppress the RuntimeWarnings —
    # the final softmax still outputs valid probabilities, and the
    # optimizer reliably backs away from these regions. Any NaN that
    # somehow survives becomes inf after exp and gets zeroed by the
    # normalisation, which is a harmless penalty on the loss.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        z = log_p @ W.T + b
    z -= np.nanmax(np.where(np.isfinite(z), z, -np.inf), axis=1, keepdims=True)
    e = np.exp(np.where(np.isfinite(z), z, -np.inf))
    s = e.sum(axis=1, keepdims=True)
    return np.divide(e, s, out=np.full_like(e, 1.0 / 3.0), where=(s > 0))


def _loss(theta: np.ndarray, probs: np.ndarray, y_idx: np.ndarray, lam: float) -> float:
    W, b = _theta_to_Wb(theta)
    p_cal = apply_dirichlet(probs, W, b)
    p_true = p_cal[np.arange(len(y_idx)), y_idx]
    nll = float(-np.mean(np.log(np.clip(p_true, 1e-12, 1.0))))
    # ODIR: penalize off-diagonal W only (Kull 2019)
    off_diag = W - np.diag(np.diag(W))
    return nll + lam * float(np.sum(off_diag ** 2))


def fit_one(probs: np.ndarray, actual: np.ndarray, lam: float) -> Dict:
    y_idx = np.array([RESULT_INDEX[c] for c in actual])
    init = np.concatenate([np.eye(3).flatten(), np.zeros(3)])
    # Bounds keep W / b in a sane range — without them L-BFGS-B occasionally
    # perturbs W to magnitudes that produce inf/NaN in W·log(p) before the
    # softmax stability-shift can save us (causes RuntimeWarnings during
    # gradient estimation even though the optimizer still converges).
    # [-5, 5] spans roughly exp(±5) = 150× which is far beyond any sensible
    # log-prob mapping.
    bounds = [(-5.0, 5.0)] * 9 + [(-5.0, 5.0)] * 3
    result = minimize(
        _loss, init, args=(probs, y_idx, lam),
        method="L-BFGS-B",
        bounds=bounds,
        options={"maxiter": 500, "ftol": 1e-9, "gtol": 1e-7},
    )
    W, b = _theta_to_Wb(result.x)
    return {"W": W, "b": b, "nll": float(result.fun), "success": bool(result.success)}


# Identity (pass-through) fallback — when the fit doesn't beat baseline
# LogLoss on the held-out split, commit to identity for that cluster so
# activating Dirichlet never REGRESSES a well-calibrated model.
_IDENTITY_W = np.eye(3)
_IDENTITY_B = np.zeros(3)


# ═══════════════════════════════════════════════════════════════════
# Metrics (identical logic to tools/backtest/metrics.py)
# ═══════════════════════════════════════════════════════════════════

def metrics(probs: np.ndarray, actual: np.ndarray) -> Dict:
    y_idx = np.array([RESULT_INDEX[c] for c in actual])
    n = len(probs)
    oh = np.zeros((n, 3))
    oh[np.arange(n), y_idx] = 1.0
    brier = float(np.mean(np.sum((probs - oh) ** 2, axis=1)))
    nll = float(-np.mean(np.log(np.clip(probs[np.arange(n), y_idx], 1e-12, 1.0))))

    pred_class = np.argmax(probs, axis=1)
    pred_conf = probs[np.arange(n), pred_class]
    correct = (pred_class == y_idx).astype(float)
    edges = np.linspace(0, 1, 11)
    ece = 0.0
    for i in range(10):
        lo, hi = edges[i], edges[i + 1]
        mask = (pred_conf >= lo) & ((pred_conf <= hi) if i == 9 else (pred_conf < hi))
        if mask.sum() == 0:
            continue
        ece += (mask.sum() / n) * abs(pred_conf[mask].mean() - correct[mask].mean())
    return {"brier": brier, "log_loss": nll, "ece": ece, "n": n}


def time_split(df: pd.DataFrame, train_frac: float) -> Tuple[pd.DataFrame, pd.DataFrame]:
    s = df.sort_values("match_date")
    k = int(len(s) * train_frac)
    return s.iloc[:k].copy(), s.iloc[k:].copy()


# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Fit Dirichlet-ODIR 1X2 calibration.")
    parser.add_argument("--parquet", default=DEFAULT_PARQUET)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--lambda", dest="lam", type=float, default=0.01,
                        help="ODIR off-diagonal regularisation weight")
    parser.add_argument("--train-frac", type=float, default=0.8,
                        help="Fraction of rows for training (time-ordered split)")
    parser.add_argument("--min-rows", type=int, default=200,
                        help="Min rows per cluster to attempt a fit; smaller = fallback to global")
    args = parser.parse_args()

    if not os.path.exists(args.parquet):
        raise SystemExit(f"Parquet not found: {args.parquet}")

    df = pd.read_parquet(args.parquet)
    print(f"Loaded {len(df)} rows from {args.parquet}")

    df = df[df["league"].isin(CLUSTER_MAP.keys())].copy()
    df["cluster"] = df["league"].map(CLUSTER_MAP)
    print(f"After cluster-filter: {len(df)} rows across {df['league'].nunique()} leagues")

    # Pre-compute probs + actual once
    all_probs = df[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].to_numpy()
    all_actual = df["ft_result"].to_numpy()

    fits: Dict[str, Dict] = {}
    summary_rows = []

    for cluster in ["global"] + CLUSTER_NAMES:
        sub = df if cluster == "global" else df[df["cluster"] == cluster]
        if len(sub) < args.min_rows:
            print(f"  SKIP {cluster}: only {len(sub)} rows (< {args.min_rows})")
            continue

        tr, va = time_split(sub, args.train_frac)
        tr_probs = tr[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].to_numpy()
        tr_actual = tr["ft_result"].to_numpy()
        va_probs = va[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].to_numpy()
        va_actual = va["ft_result"].to_numpy()

        base = metrics(va_probs, va_actual)
        fit = fit_one(tr_probs, tr_actual, args.lam)
        cal = metrics(apply_dirichlet(va_probs, fit["W"], fit["b"]), va_actual)

        # Safety net: if the fit doesn't beat baseline LogLoss on the
        # held-out split, fall back to identity (pass-through). That's
        # strictly better than shipping a mapping that makes predictions
        # worse — activating Dirichlet should never regress a well-
        # calibrated cluster. Tolerance of 1e-4 swallows noise-level
        # improvements that aren't worth the schema complexity.
        fallback_to_identity = (cal["log_loss"] >= base["log_loss"] - 1e-4)
        if fallback_to_identity:
            W_out = _IDENTITY_W
            b_out = _IDENTITY_B
            out_val = base  # identity → validation metrics are the baseline
        else:
            W_out = fit["W"]
            b_out = fit["b"]
            out_val = cal

        fits[cluster] = {
            "W": W_out.tolist(),
            "b": b_out.tolist(),
            "n_train": int(len(tr)),
            "oot_logloss": round(out_val["log_loss"], 6),
            "fallback_identity": fallback_to_identity,
            # Extra diagnostics — calibration.ts validator ignores unknown keys.
            "_baseline_val": {k: round(v, 6) if isinstance(v, float) else v for k, v in base.items()},
            "_calibrated_val": {k: round(v, 6) if isinstance(v, float) else v for k, v in cal.items()},
        }
        summary_rows.append((cluster, len(tr), len(va), base, cal, fit["success"], fallback_to_identity))

    # Must have at least `global` for the runtime to load the JSON
    if "global" not in fits:
        raise SystemExit("No valid fit for `global` cluster — need at least 200 rows overall")

    output = {
        "_version": 1,
        "_meta": {
            "method": "dirichlet_odir",
            "lambda": args.lam,
            "train_frac": args.train_frac,
            "source_parquet": os.path.relpath(args.parquet, PROJECT_ROOT),
            "trained_at": pd.Timestamp.now().isoformat(),
        },
        "cluster_map": CLUSTER_MAP,
        "global": {k: v for k, v in fits["global"].items() if not k.startswith("_")},
        "clusters": {
            c: {k: v for k, v in fits[c].items() if not k.startswith("_")}
            for c in CLUSTER_NAMES if c in fits
        },
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(output, f, indent=2)

    # ─── Console summary ───
    print("\n" + "═" * 76)
    print(f"Dirichlet-ODIR fit  (λ = {args.lam})")
    print("═" * 76)
    print(f"  {'cluster':<16} {'tr':>5} {'va':>5}  {'Brier base→cal':<24}  "
          f"{'LogLoss base→cal':<24}  {'ECE base→cal':<20}  ok  shipped")
    for cluster, n_tr, n_va, base, cal, ok, fallback in summary_rows:
        br_delta = cal["brier"] - base["brier"]
        ll_delta = cal["log_loss"] - base["log_loss"]
        ece_delta = cal["ece"] - base["ece"]
        shipped = "identity" if fallback else "dirichlet"
        print(
            f"  {cluster:<16} {n_tr:>5} {n_va:>5}  "
            f"{base['brier']:.4f}→{cal['brier']:.4f} ({br_delta:+.4f})  "
            f"{base['log_loss']:.4f}→{cal['log_loss']:.4f} ({ll_delta:+.4f})  "
            f"{base['ece']:.4f}→{cal['ece']:.4f} ({ece_delta:+.4f})  "
            f"{'✓' if ok else '✗'}  {shipped}"
        )

    print(f"\n  Written: {args.out}")
    print(f"  Activate via: NEXT_PUBLIC_CALIBRATION_METHOD=dirichlet")


if __name__ == "__main__":
    main()
