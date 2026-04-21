#!/usr/bin/env python3
"""
FODZE Mondrian Conformal Prediction Fit (Angelopoulos & Bates 2023)
═══════════════════════════════════════════════════════════════════

Fits per-league quantiles q_g for conformal classification so the
staking gate can produce prediction sets  S = { k : 1 - p_k ≤ q_g }
with (1-α) coverage guarantee within each league.

Mondrian grouping (per-league) avoids a volatile League-Two diluting
EPL's coverage — each league's own OOT residuals anchor its own q.

Usage:
    python3 tools/fit_conformal.py --engine v2 --alpha 0.10
    python3 tools/fit_conformal.py --engine v2 --alpha 0.10 --dry
    python3 tools/fit_conformal.py --engines v1,v2,ensemble --alphas 0.05,0.10,0.20

Prereqs:
    For engine=v2 (canonical): tools/backtest/v2-oot-predictions.parquet
    produced by `retrain_v2.py` OOT export — carries:
        match_date, league, home_team, away_team,
        prob_h_raw, prob_d_raw, prob_a_raw, prob_o25_raw, prob_btts_raw,
        actual_h_goals, actual_a_goals, ft_result, features, ...

    For legacy engines (v1, ensemble): falls back to the older
    tools/oot_predictions_{engine}.parquet format with
        match_id, league, match_date, model_prob_{h|d|a}, y_true_class.
    This path is skipped when the file is absent, so the script won't
    fail spuriously on a single-engine run.

Output:
    public/conformal-quantiles.json  (schema documented inline)

MVP status — SKELETON:
    Runs end-to-end via the MAPIE library when available. If MAPIE is
    missing or OOT predictions don't exist, prints a friendly hint and
    exits 0 so nightly pipelines don't fail spuriously.
"""

from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
except ImportError:
    print("[conformal-fit] numpy + pandas required. `source tools/venv/bin/activate` first.", file=sys.stderr)
    sys.exit(1)

# MAPIE is optional — we can fit quantiles manually (simpler for 3-class).
try:
    from mapie.classification import MapieClassifier  # noqa: F401
    HAVE_MAPIE = True
except ImportError:
    HAVE_MAPIE = False

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "public" / "conformal-quantiles.json"


# ─── Core math ──────────────────────────────────────────────────────

def compute_quantile(probs: np.ndarray, y: np.ndarray, alpha: float) -> float:
    """
    Classic conformal calibration for 3-class classification.

    Nonconformity score s_i = 1 - p_{i, y_i}
    q = ⌈(n+1)(1-α)⌉ / n-th order statistic of {s_1, …, s_n}

    This matches what MAPIE's MapieClassifier('score') computes with
    a single-group calibration — we inline it for two reasons:
      1. `method='mondrian'` in MAPIE is conveniently per-group, but
         we want to cross-check against hand-computed quantiles.
      2. Avoids MAPIE as a hard dependency (it pulls in sklearn).
    """
    n = len(y)
    if n == 0:
        return 1.0
    # Pick the true-class probability for each calibration row.
    s = 1.0 - probs[np.arange(n), y]
    # Off-by-one quantile index in conformal theory.
    rank = int(np.ceil((n + 1) * (1 - alpha))) - 1
    rank = max(0, min(rank, n - 1))
    return float(np.sort(s)[rank])


# ─── Data loader ────────────────────────────────────────────────────

_RESULT_TO_CLASS = {"H": 0, "D": 1, "A": 2}


def load_oot_predictions(engine: str) -> pd.DataFrame | None:
    """
    Load a parquet in one of two shapes and normalise to the internal
    DataFrame used by `fit_for_engine`:
        match_date, league, model_prob_h, model_prob_d, model_prob_a, y_true_class

    Preferred (v2): tools/backtest/v2-oot-predictions.parquet — the output
    of retrain_v2.py's --skip-public-export flow. Uses prob_{h,d,a}_raw
    + ft_result columns.

    Legacy: tools/oot_predictions_{engine}.parquet — kept for eventual
    v1 / ensemble support. Uses model_prob_* + y_true_class directly.
    """
    canonical = REPO_ROOT / "tools" / "backtest" / f"{engine}-oot-predictions.parquet"
    legacy = REPO_ROOT / "tools" / f"oot_predictions_{engine}.parquet"

    if canonical.exists():
        df = pd.read_parquet(canonical)
        # Map ft_result → y_true_class (0/1/2), prob_*_raw → model_prob_*.
        if "ft_result" not in df.columns:
            print(f"[conformal-fit] {canonical.name}: expected column 'ft_result' missing", file=sys.stderr)
            return None
        df = df.assign(
            y_true_class=df["ft_result"].map(_RESULT_TO_CLASS),
            model_prob_h=df["prob_h_raw"],
            model_prob_d=df["prob_d_raw"],
            model_prob_a=df["prob_a_raw"],
        )
        return df[["match_date", "league", "model_prob_h", "model_prob_d", "model_prob_a", "y_true_class"]]

    if legacy.exists():
        return pd.read_parquet(legacy)

    print(f"[conformal-fit] missing both {canonical.relative_to(REPO_ROOT)} and {legacy.relative_to(REPO_ROOT)}", file=sys.stderr)
    print(f"[conformal-fit]   → generate via `python3 tools/retrain_{engine}.py --skip-public-export ...`", file=sys.stderr)
    return None


# ─── Main ───────────────────────────────────────────────────────────

def fit_for_engine(engine: str, alphas: list[float]) -> dict | None:
    df = load_oot_predictions(engine)
    if df is None or df.empty:
        return None

    df = df.copy()
    df["match_date"] = pd.to_datetime(df["match_date"]).dt.date.astype(str)
    # Only use the OOT window for calibration; held-out is never used here.
    df = df[(df["match_date"] >= "2023-08-01") & (df["match_date"] < "2024-07-01")]
    if df.empty:
        print(f"[conformal-fit] {engine}: no OOT rows")
        return None

    probs_all = df[["model_prob_h", "model_prob_d", "model_prob_a"]].to_numpy()
    y_all = df["y_true_class"].to_numpy().astype(int)

    output = {"global": {}, "leagues": {}}

    # Global quantiles across all leagues.
    for a in alphas:
        q = compute_quantile(probs_all, y_all, a)
        output["global"][f"{a:.2f}"] = round(q, 4)
        print(f"[conformal-fit]   GLOBAL α={a}: q={q:.4f}  n={len(y_all)}")

    # Per-league Mondrian quantiles. Fall back to the global q when a
    # league has < 200 OOT samples (too thin for a reliable tail).
    MIN_N = 200
    for lg in sorted(df["league"].unique()):
        sub = df[df["league"] == lg]
        if len(sub) < MIN_N:
            print(f"[conformal-fit]   {lg}: {len(sub)} < {MIN_N} — fallback to global")
            continue
        p = sub[["model_prob_h", "model_prob_d", "model_prob_a"]].to_numpy()
        y = sub["y_true_class"].to_numpy().astype(int)
        out = {}
        for a in alphas:
            q = compute_quantile(p, y, a)
            out[f"{a:.2f}"] = round(q, 4)
        output["leagues"][lg] = out
        print(f"[conformal-fit]   {lg}: n={len(sub)}  q@0.10={out.get('0.10'):.4f}")

    return output


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="v2")
    ap.add_argument("--engines", help="comma-separated override for --engine")
    ap.add_argument("--alpha", type=float, default=0.10)
    ap.add_argument("--alphas", help="comma-separated override for --alpha (e.g. 0.05,0.10,0.20)")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    engines = args.engines.split(",") if args.engines else [args.engine]
    alphas = [float(a) for a in args.alphas.split(",")] if args.alphas else [args.alpha]

    # We merge engines into one "effective" output — MAPIE's convention
    # is that conformal quantiles sit with the calibration layer, not
    # per engine. When multiple engines are fit we take the widest (most
    # conservative) quantile so the gate stays safe across all of them.
    merged = {"global": {}, "leagues": {}}
    any_success = False
    for eng in engines:
        print(f"\n[conformal-fit] fitting engine={eng}")
        out = fit_for_engine(eng, alphas)
        if out is None:
            continue
        any_success = True
        # Merge: max across engines at each alpha / cluster.
        for key, val in out["global"].items():
            merged["global"][key] = max(merged["global"].get(key, 0), val)
        for lg, byAlpha in out["leagues"].items():
            cur = merged["leagues"].setdefault(lg, {})
            for key, val in byAlpha.items():
                cur[key] = max(cur.get(key, 0), val)

    if not any_success:
        print("\n[conformal-fit] no engine produced predictions — placeholder untouched.")
        return

    payload = {
        "_version": 1,
        "_meta": {
            "method": "mondrian_conformal_classification",
            "alpha_default": alphas[0] if alphas else 0.10,
            "engines": engines,
            "trained_at": pd.Timestamp.utcnow().isoformat() + "Z",
            "source_library": "MAPIE" if HAVE_MAPIE else "in-house",
        },
        **merged,
    }

    if args.dry:
        print("\n[conformal-fit] DRY — not writing output")
        print(json.dumps(payload, indent=2))
        return
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2))
    print(f"\n[conformal-fit] → wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
