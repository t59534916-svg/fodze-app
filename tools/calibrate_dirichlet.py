#!/usr/bin/env python3
"""
FODZE Dirichlet-ODIR Calibration Fit (Kull 2019)
═══════════════════════════════════════════════

Fits a 3×3 weight matrix W + 3-bias b per league cluster ("top5",
"mid_european", "lower") so that applying

    z = W @ log(probs) + b
    p' = softmax(z)

on the model's OOT predictions minimises

    L = NLL + λ · ( Σ W_offdiag²  +  Σ b² )

(Kull/Silva Filho/Flach 2019 — "Beyond Temperature Scaling"). The
off-diagonal + bias regulariser is ODIR: identity-preserving, so when
data is sparse the solution stays close to pass-through.

Usage:
    python3 tools/calibrate_dirichlet.py --engine v2
    python3 tools/calibrate_dirichlet.py --engine v2 --lam 0.01 --dry

Prereqs:
    tools/oot_predictions_{engine}.parquet  (schema: match_id, league,
        match_date, model_prob_h, model_prob_d, model_prob_a, y_true_class)

Output:
    public/dirichlet-calibration.json   (schema documented inline)

MVP status — SKELETON:
    Runs the full ODIR fit when predictions exist. If prereqs are missing,
    prints a hint and exits 0 so it doesn't fail a refresh cron.
"""

from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    from scipy.optimize import minimize
except ImportError:
    print("[dirichlet-fit] numpy + pandas + scipy required. `source tools/venv/bin/activate` first.", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "public" / "dirichlet-calibration.json"

# League → cluster map. Matches public/dirichlet-calibration.json so the
# runtime lookup stays consistent. A league NOT in this map falls back to
# the "global" params at runtime.
CLUSTER_MAP = {
    "bundesliga": "top5", "epl": "top5", "la_liga": "top5", "serie_a": "top5", "ligue_1": "top5",
    "eredivisie": "mid_european", "primeira_liga": "mid_european", "jupiler_pro": "mid_european",
    "super_lig": "mid_european", "scottish_prem": "mid_european", "championship": "mid_european",
    "la_liga2": "mid_european", "serie_b": "mid_european", "ligue_2": "mid_european",
    "bundesliga2": "mid_european",
    "liga3": "lower", "league_one": "lower", "league_two": "lower", "greek_sl": "lower",
}

# Per-cluster minimum. Set to 1500 so the top5 cluster (≈1752 OOT rows
# for v2 in 2023-08–2024-06) gets its own fit instead of falling back to
# the global params. The Kull paper fits clusters with ≥ 500 samples
# without issue — 1500 is a conservative middle ground that still
# protects the sparsely-represented "lower" cluster if it ever shrinks.
MIN_SAMPLES_PER_CLUSTER = 1500
EPS = 1e-9


# ─── ODIR loss ────────────────────────────────────────────────────────

def _pack(W: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Flatten W (3×3) + b (3) into a 12-vector for L-BFGS-B."""
    return np.concatenate([W.flatten(), b])


def _unpack(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    W = x[:9].reshape(3, 3)
    b = x[9:12]
    return W, b


def _apply(W: np.ndarray, b: np.ndarray, logits: np.ndarray) -> np.ndarray:
    """Apply z = W @ logits + b, then softmax row-wise."""
    z = logits @ W.T + b[None, :]
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def _loss(x: np.ndarray, logits: np.ndarray, y: np.ndarray, lam: float) -> float:
    W, b = _unpack(x)
    probs = _apply(W, b, logits)
    nll = -np.mean(np.log(np.clip(probs[np.arange(len(y)), y], EPS, 1.0)))
    # ODIR: penalise off-diagonal of W + bias. Identity (W=I, b=0) → penalty=0.
    off_diag = W - np.diag(np.diag(W))
    reg = lam * (np.sum(off_diag ** 2) + np.sum(b ** 2))
    return nll + reg


def fit_cluster(probs: np.ndarray, y: np.ndarray, lam: float) -> tuple[np.ndarray, np.ndarray, float]:
    """Fit a single cluster's (W, b) to minimise ODIR loss. Returns (W, b, final_loss)."""
    logits = np.log(np.clip(probs, EPS, 1.0))
    x0 = _pack(np.eye(3), np.zeros(3))   # identity initialisation
    result = minimize(
        _loss, x0, args=(logits, y, lam),
        method="L-BFGS-B",
        options={"maxiter": 500, "ftol": 1e-9},
    )
    W, b = _unpack(result.x)
    return W, b, float(result.fun)


# ─── Data loaders ─────────────────────────────────────────────────────
# Canonical (v2): tools/backtest/{engine}-oot-predictions.parquet with
# prob_*_raw + ft_result columns — this is what retrain_v2.py writes in
# its OOT export (matches what tools/fit_conformal.py reads).
# Legacy: tools/oot_predictions_{engine}.parquet with model_prob_* +
# y_true_class — kept as a fallback so older pipelines still load.

_RESULT_TO_CLASS = {"H": 0, "D": 1, "A": 2}


def load_oot_predictions(engine: str) -> pd.DataFrame | None:
    canonical = REPO_ROOT / "tools" / "backtest" / f"{engine}-oot-predictions.parquet"
    legacy = REPO_ROOT / "tools" / f"oot_predictions_{engine}.parquet"

    if canonical.exists():
        df = pd.read_parquet(canonical)
        if "ft_result" not in df.columns:
            print(f"[dirichlet-fit] {canonical.name}: expected 'ft_result' column missing", file=sys.stderr)
            return None
        return df.assign(
            y_true_class=df["ft_result"].map(_RESULT_TO_CLASS),
            model_prob_h=df["prob_h_raw"],
            model_prob_d=df["prob_d_raw"],
            model_prob_a=df["prob_a_raw"],
        )[["match_date", "league", "model_prob_h", "model_prob_d", "model_prob_a", "y_true_class"]]

    if legacy.exists():
        return pd.read_parquet(legacy)

    print(f"[dirichlet-fit] missing both {canonical.relative_to(REPO_ROOT)} and {legacy.relative_to(REPO_ROOT)}", file=sys.stderr)
    print(f"[dirichlet-fit]   → extend tools/retrain_{engine}.py to persist OOT predictions", file=sys.stderr)
    return None


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["v1", "v2", "ensemble"], default="v2",
                    help="Which engine's OOT predictions to calibrate.")
    ap.add_argument("--lam", type=float, default=0.01,
                    help="ODIR regularisation strength. Kull-default: 0.01.")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    preds = load_oot_predictions(args.engine)
    if preds is None:
        return

    preds = preds.copy()
    preds["match_date"] = pd.to_datetime(preds["match_date"]).dt.date.astype(str)
    # OOT window only — held-out stays untouched.
    oot = preds[(preds["match_date"] >= "2023-08-01") & (preds["match_date"] < "2024-07-01")]
    if oot.empty:
        print("[dirichlet-fit] no OOT rows — aborting")
        return

    # Derive cluster per row.
    oot = oot.assign(cluster=oot["league"].map(CLUSTER_MAP).fillna("global"))

    # Base output shell with identity defaults; we overwrite real fits below.
    output = {
        "_version": 1,
        "_meta": {
            "method": "dirichlet_odir",
            "lambda": args.lam,
            "trained_at": pd.Timestamp.utcnow().isoformat() + "Z",
        },
        "cluster_map": CLUSTER_MAP,
        "global": {"W": np.eye(3).tolist(), "b": [0.0, 0.0, 0.0], "n_train": 0},
        "clusters": {},
    }

    # Global fit uses all OOT rows — fallback when a cluster is too thin.
    probs_all = oot[["model_prob_h", "model_prob_d", "model_prob_a"]].to_numpy()
    y_all = oot["y_true_class"].to_numpy().astype(int)
    W_g, b_g, loss_g = fit_cluster(probs_all, y_all, args.lam)
    output["global"] = {"W": W_g.tolist(), "b": b_g.tolist(), "n_train": int(len(y_all)), "oot_logloss": loss_g}
    print(f"[dirichlet-fit]   GLOBAL: n={len(y_all)} loss={loss_g:.4f}")

    for cluster in ["top5", "mid_european", "lower"]:
        sub = oot[oot["cluster"] == cluster]
        if len(sub) < MIN_SAMPLES_PER_CLUSTER:
            print(f"[dirichlet-fit]   {cluster}: only {len(sub)} < {MIN_SAMPLES_PER_CLUSTER} — using GLOBAL fit")
            output["clusters"][cluster] = {"W": W_g.tolist(), "b": b_g.tolist(), "n_train": int(len(sub))}
            continue
        p = sub[["model_prob_h", "model_prob_d", "model_prob_a"]].to_numpy()
        y = sub["y_true_class"].to_numpy().astype(int)
        W, b, ll = fit_cluster(p, y, args.lam)
        output["clusters"][cluster] = {"W": W.tolist(), "b": b.tolist(), "n_train": int(len(y)), "oot_logloss": ll}
        print(f"[dirichlet-fit]   {cluster}: n={len(y)} loss={ll:.4f}")

    if args.dry:
        print("\n[dirichlet-fit] DRY — not writing output")
        print(json.dumps(output, indent=2))
        return

    OUTPUT_PATH.write_text(json.dumps(output, indent=2))
    print(f"\n[dirichlet-fit] → wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
