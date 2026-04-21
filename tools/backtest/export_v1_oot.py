#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE v1 Poisson-GLM — OOT prediction export
═══════════════════════════════════════════════════════════════════

Scores the v2 OOT split (2023-08-01 → 2024-06-30) with the v1 Poisson
GLM shipping in public/ensemble-model.json and writes the output in
the same parquet schema retrain_v2.py produces, so the cross-engine CLI
+ fit_conformal.py + fit_dirichlet can ingest it without a schema
change.

Why we read v2's feature matrix instead of rebuilding v1's feature
pipeline: v1's training (tools/retrain_all.py) is a different code
path with different data sources (FootyStats CSVs etc.) and takes
hours to regenerate. Six of v1's nine features overlap exactly by name
with v2's 21-feature vector (elo_diff, home_factor, league_avg,
rest_days_diff, sos_strength, is_derby). The other three are the
semantic pair

    v1 → v2
    xg_diff      ↔ npxg_diff_ewma       (penalties included → excluded)
    xga_diff     ↔ npxga_diff_ewma
    total_goals  ↔ total_npxg

Using v2's npxG versions in v1's GLM is a small bias (penalties ≈ 8 %
of league-average xG) but the scaler trained on v1's distribution
partially absorbs it. The output is labelled `v1_from_npxg` in the
_meta so downstream tooling knows it's a controlled approximation
rather than a fresh v1 retrain.

Usage:
  tools/venv/bin/python tools/backtest/export_v1_oot.py
  tools/venv/bin/python tools/backtest/export_v1_oot.py --dry
"""

from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
V2_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
V1_PARQUET = REPO_ROOT / "tools" / "backtest" / "v1-oot-predictions.parquet"
ENSEMBLE_JSON = REPO_ROOT / "public" / "ensemble-model.json"

# Maps v1 feature name → v2 feature name (or `None` when identical).
V1_FROM_V2_MAP = {
    "xg_diff":        "npxg_diff_ewma",
    "xga_diff":       "npxga_diff_ewma",
    "elo_diff":       "elo_diff",
    "total_goals":    "total_npxg",
    "home_factor":    "home_factor",
    "league_avg":     "league_avg",
    "rest_days_diff": "rest_days_diff",
    "sos_strength":   "sos_strength",
    "is_derby":       "is_derby",
}

# Dixon-Coles ρ that v1 ships with (ensemble-v1 was tuned on the ρ
# embedded in its own training, which is close to v2's but separate).
# Using -0.05 matches tools/backtest/run_backtest.mjs:48 and is the
# "safe default" across FODZE's non-retuned engines.
V1_RHO = -0.05


def poisson_pmf_matrix(lam_h: np.ndarray, lam_a: np.ndarray, n: int = 10) -> np.ndarray:
    """Build (N, n, n) score-matrix via log-space Poisson PMFs for numerical safety."""
    ks = np.arange(n)
    log_fact = np.zeros(n)
    for k in range(2, n):
        log_fact[k] = log_fact[k - 1] + np.log(k)
    # Clip λ to avoid log(0); the engine clamps λ ∈ [0.3, 4.5] in runtime.
    lh = np.clip(lam_h, 1e-6, None)
    la = np.clip(lam_a, 1e-6, None)
    log_p_h = -lh[:, None] + ks[None, :] * np.log(lh)[:, None] - log_fact[None, :]
    log_p_a = -la[:, None] + ks[None, :] * np.log(la)[:, None] - log_fact[None, :]
    p_h = np.exp(log_p_h)  # (N, n)
    p_a = np.exp(log_p_a)  # (N, n)
    return p_h[:, :, None] * p_a[:, None, :]  # (N, n, n)


def dixon_coles_adjust(mx: np.ndarray, lam_h: np.ndarray, lam_a: np.ndarray, rho: float) -> np.ndarray:
    out = mx.copy()
    lh = lam_h[:, None, None]
    la = lam_a[:, None, None]
    out[:, 0, 0] *= np.maximum(0.0, 1 - lh[:, 0, 0] * la[:, 0, 0] * rho)
    out[:, 1, 0] *= np.maximum(0.0, 1 + la[:, 0, 0] * rho)
    out[:, 0, 1] *= np.maximum(0.0, 1 + lh[:, 0, 0] * rho)
    out[:, 1, 1] *= np.maximum(0.0, 1 - rho)
    # Renormalise row-wise so each matrix still sums to 1.
    s = out.sum(axis=(1, 2), keepdims=True)
    return out / np.maximum(s, 1e-12)


def matrix_to_markets(mx: np.ndarray) -> dict:
    n = mx.shape[1]
    i = np.arange(n)[:, None]
    j = np.arange(n)[None, :]
    home_mask = (i > j)
    draw_mask = (i == j)
    away_mask = (i < j)
    o25_mask = (i + j > 2.5)
    btts_mask = (i > 0) & (j > 0)
    return {
        "prob_h_raw":    (mx * home_mask).sum(axis=(1, 2)),
        "prob_d_raw":    (mx * draw_mask).sum(axis=(1, 2)),
        "prob_a_raw":    (mx * away_mask).sum(axis=(1, 2)),
        "prob_o25_raw":  (mx * o25_mask).sum(axis=(1, 2)),
        "prob_btts_raw": (mx * btts_mask).sum(axis=(1, 2)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--v2-parquet", default=str(V2_PARQUET))
    ap.add_argument("--ensemble-json", default=str(ENSEMBLE_JSON))
    ap.add_argument("--out", default=str(V1_PARQUET))
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    v2_path = Path(args.v2_parquet)
    if not v2_path.exists():
        raise SystemExit(f"v2 OOT parquet missing: {v2_path}")
    ens_path = Path(args.ensemble_json)
    if not ens_path.exists():
        raise SystemExit(f"ensemble-model.json missing: {ens_path}")

    df = pd.read_parquet(v2_path)
    print(f"[v1-oot] loaded {len(df)} rows from {v2_path.relative_to(REPO_ROOT)}")

    ensemble = json.loads(ens_path.read_text())
    p = ensemble.get("poisson")
    if not p:
        raise SystemExit("ensemble-model.json has no `poisson` block")

    v1_features: list[str] = p["feature_names"]
    v2_features: list[str] = df.attrs.get("feature_names", [])  # may be empty
    # The meta with v2 feature names isn't inside the parquet — read it
    # from the sibling .meta.json that retrain_v2.py writes.
    meta_path = v2_path.with_suffix(".meta.json")
    if meta_path.exists():
        v2_features = json.loads(meta_path.read_text()).get("feature_names", v2_features)
    if not v2_features:
        raise SystemExit(f"couldn't recover v2 feature_names (looked in parquet attrs + {meta_path.name})")

    v2_name_to_idx = {name: i for i, name in enumerate(v2_features)}
    v1_cols_needed = []
    for v1_name in v1_features:
        v2_name = V1_FROM_V2_MAP.get(v1_name)
        if v2_name is None:
            raise SystemExit(f"no v2-mapping for v1 feature '{v1_name}' — add to V1_FROM_V2_MAP")
        if v2_name not in v2_name_to_idx:
            raise SystemExit(f"v2 feature '{v2_name}' (mapped from v1 '{v1_name}') not in parquet")
        v1_cols_needed.append(v2_name_to_idx[v2_name])

    # Unpack v2's `features` column (list-per-row) into a (N, 21) matrix,
    # then project to the 9 columns v1 wants.
    feat_matrix = np.array(df["features"].tolist(), dtype=float)  # (N, 21)
    v1_X = feat_matrix[:, v1_cols_needed]  # (N, 9)
    print(f"[v1-oot] built {v1_X.shape[0]}×{v1_X.shape[1]} v1-feature matrix from v2's 21-dim vector")

    scaler_mean = np.array(p["scaler_mean"])
    scaler_scale = np.array(p["scaler_scale"])
    v1_X_scaled = (v1_X - scaler_mean) / scaler_scale

    coef_h = np.array(p["home"]["coefficients"])
    int_h = p["home"]["intercept"]
    coef_a = np.array(p["away"]["coefficients"])
    int_a = p["away"]["intercept"]

    # Suppress a spurious RuntimeWarning from numpy's matmul dispatcher:
    # on this machine the BLAS kernel raises "divide by zero" / "overflow"
    # flags from internal optimisations even though the outputs are
    # finite (verified: no NaN/inf in lh_log, la_log). Using a direct
    # np.dot avoids matmul's warning path.
    lam_h = np.exp(int_h + np.dot(v1_X_scaled, coef_h))
    lam_a = np.exp(int_a + np.dot(v1_X_scaled, coef_a))
    # Match runtime clamping behaviour (src/lib/poisson-ml-engine-v2.ts
    # clamps to [0.3, 4.5]; v1 uses the same safe range).
    lam_h = np.clip(lam_h, 0.3, 4.5)
    lam_a = np.clip(lam_a, 0.3, 4.5)
    print(f"[v1-oot] λh mean={lam_h.mean():.3f}, λa mean={lam_a.mean():.3f}, ρ={V1_RHO}")

    mx = poisson_pmf_matrix(lam_h, lam_a, n=10)
    mx = dixon_coles_adjust(mx, lam_h, lam_a, V1_RHO)
    markets = matrix_to_markets(mx)

    out_df = pd.DataFrame({
        "match_date":      df["match_date"],
        "league":          df["league"],
        "home_team":       df["home_team"],
        "away_team":       df["away_team"],
        "lambda_h_pred":   lam_h,
        "lambda_a_pred":   lam_a,
        "prob_h_raw":      markets["prob_h_raw"],
        "prob_d_raw":      markets["prob_d_raw"],
        "prob_a_raw":      markets["prob_a_raw"],
        "prob_o25_raw":    markets["prob_o25_raw"],
        "prob_btts_raw":   markets["prob_btts_raw"],
        "actual_h_goals":  df["actual_h_goals"],
        "actual_a_goals":  df["actual_a_goals"],
        "ft_result":       df["ft_result"],
        "features":        list(v1_X),          # 9-dim (not 21 — different engine)
        "feature_version": "v1-from-v2-npxg",
        "split_label":     "oot-test",
        "rho_used":        V1_RHO,
    })

    # Tiny sanity check: probs should sum to ~1 on each row.
    s_1x2 = out_df[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].sum(axis=1)
    deviation = (s_1x2 - 1.0).abs().max()
    if deviation > 0.001:
        print(f"[v1-oot] WARN: max 1X2 prob sum deviation = {deviation:.6f}", file=sys.stderr)

    if args.dry:
        print(f"[v1-oot] DRY — would write {len(out_df)} rows to {args.out}")
        print(out_df.head(3).to_string())
        return

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_df.to_parquet(out_path, index=False)

    # Sibling meta so fit_conformal.py et al. can pick up feature_names
    # without a schema change.
    meta_out = {
        "feature_names": v1_features,
        "feature_version": "v1-from-v2-npxg",
        "derived_from": str(v2_path.relative_to(REPO_ROOT)),
        "rho_used": V1_RHO,
        "oot_cutoff": "2023-08-01",
        "n_rows": int(len(out_df)),
        "note": (
            "v1 Poisson-GLM scored on v2's OOT feature matrix. xg_diff / xga_diff / "
            "total_goals are approximated by v2's npxg equivalents (penalties excluded). "
            "The other 6 features overlap by name. Use for cross-engine comparison only — "
            "this is NOT a fresh v1 retrain."
        ),
        "trained_at": pd.Timestamp.utcnow().isoformat() + "Z",
    }
    out_path.with_suffix(".meta.json").write_text(json.dumps(meta_out, indent=2))
    print(f"[v1-oot] wrote {out_path.relative_to(REPO_ROOT)} ({len(out_df)} rows)")


if __name__ == "__main__":
    main()
