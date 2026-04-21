#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE Benter-blend fit (Bill Benter 1994, log-pool variant)
═══════════════════════════════════════════════════════════════════

Fits per-league (β₁, β₂) weights such that:

    z_k = β₁ · log(model_k) + β₂ · log(pinn_k)
    p_k = softmax(z_H, z_D, z_A)

minimising cross-entropy against the actual FT result. Runtime in
src/lib/benter-blend.ts consumes these → activates when the env flag
NEXT_PUBLIC_BENTER_BLEND is set to "on" (or "shadow" to log only).

Data path:
  1. OOT parquet (tools/backtest/v2-oot-predictions.parquet) —
     v2 model probabilities + actual FT result. 6.7k rows.
  2. odds_closing_history (Supabase, PSCH/PSCD/PSCA columns) —
     Pinnacle closing odds per match. Fetched once via REST API
     (paginated) and cached to tools/backtest/odds-close-oot.parquet
     so re-runs don't hammer the DB.
  3. Inner join on (league, match_date, home_team, away_team).
     Both tables source from football-data.co.uk canonical names so
     exact-match works — no fuzzy string join needed.

Pinnacle implied probs:
  raw_k = 1 / odds_k
  overround = raw_H + raw_D + raw_A
  pinn_k = raw_k / overround    (proportional vig-removal)

Per-league fit requires ≥ MIN_LEAGUE_ROWS joined rows; below that we
fall back to the global weights. Global always gets fit on the full
joined pool.

Usage:
  tools/venv/bin/python tools/fit_benter.py
  tools/venv/bin/python tools/fit_benter.py --force-refetch
═══════════════════════════════════════════════════════════════════
"""

from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple, Optional

import numpy as np
import pandas as pd
import requests
from scipy.optimize import minimize

REPO_ROOT = Path(__file__).resolve().parent.parent
OOT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
ODDS_CACHE = REPO_ROOT / "tools" / "backtest" / "odds-close-oot.parquet"
OUTPUT_PATH = REPO_ROOT / "public" / "benter-weights.json"

RESULT_INDEX = {"H": 0, "D": 1, "A": 2}
MIN_LEAGUE_ROWS = 150  # below this, fall back to global weights for the league


# ═══════════════════════════════════════════════════════════════════
# .env.local loader — tiny, avoids python-dotenv dependency
# ═══════════════════════════════════════════════════════════════════

def load_env_local(path: Path) -> Dict[str, str]:
    """Parse .env.local into a dict. Ignores comments and blank lines.

    Keeps the logic simple: no nested variable substitution, no quoted-
    multiline support. That covers the current .env.local shape; if the
    format ever gets more complex, swap for python-dotenv.
    """
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        env[k.strip()] = v
    return env


# ═══════════════════════════════════════════════════════════════════
# Supabase REST fetch (with pagination + local cache)
# ═══════════════════════════════════════════════════════════════════

def fetch_odds_closing_history(
    supabase_url: str,
    service_key: str,
    date_from: str,
    date_to: str,
    page_size: int = 1000,
) -> pd.DataFrame:
    """Paginate GET /rest/v1/odds_closing_history via Range headers."""
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/odds_closing_history"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }
    # PostgREST accepts list-of-tuples params for duplicate keys; the
    # standard dict-form would swallow one of the two match_date filters.
    params = [
        ("select", "league,match_date,home_team,away_team,psch,pscd,psca"),
        ("match_date", f"gte.{date_from}"),
        ("match_date", f"lte.{date_to}"),
        ("order", "match_date.asc"),
    ]

    rows: List[dict] = []
    offset = 0
    while True:
        page_headers = {**headers, "Range-Unit": "items", "Range": f"{offset}-{offset + page_size - 1}"}
        resp = requests.get(endpoint, headers=page_headers, params=params, timeout=30)
        if resp.status_code not in (200, 206):
            raise SystemExit(f"Supabase REST fetch failed {resp.status_code}: {resp.text[:200]}")
        page = resp.json()
        if not page:
            break
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return pd.DataFrame(rows)


def load_or_fetch_odds(force_refetch: bool, date_from: str, date_to: str) -> pd.DataFrame:
    if ODDS_CACHE.exists() and not force_refetch:
        df = pd.read_parquet(ODDS_CACHE)
        print(f"[benter-fit] loaded odds cache: {len(df)} rows from {ODDS_CACHE}")
        return df

    env = load_env_local(REPO_ROOT / ".env.local")
    url = env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL")
    key = (env.get("SUPABASE_SERVICE_ROLE_KEY")
           or env.get("SUPABASE_SERVICE_KEY")
           or env.get("FODZE_SERVICE_KEY"))
    if not url or not key:
        raise SystemExit(
            "[benter-fit] need NEXT_PUBLIC_SUPABASE_URL + a service key in .env.local "
            "(SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY / FODZE_SERVICE_KEY)"
        )

    print(f"[benter-fit] fetching odds_closing_history from Supabase REST (cache miss)")
    df = fetch_odds_closing_history(url, key, date_from, date_to)
    print(f"[benter-fit] fetched {len(df)} rows; caching to {ODDS_CACHE}")
    ODDS_CACHE.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(ODDS_CACHE, index=False)
    return df


# ═══════════════════════════════════════════════════════════════════
# Benter fit core
# ═══════════════════════════════════════════════════════════════════

def pinnacle_implied(pH: float, pD: float, pA: float) -> Tuple[float, float, float]:
    """Proportional vig removal: raw_k = 1/odds_k, normalise to sum=1."""
    raw = np.array([1.0 / pH, 1.0 / pD, 1.0 / pA])
    return tuple(raw / raw.sum())


def _softmax3(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def _loss_benter(theta: np.ndarray, log_model: np.ndarray, log_pinn: np.ndarray, y_idx: np.ndarray) -> float:
    beta1, beta2 = theta
    # z shape: [N, 3]
    z = beta1 * log_model + beta2 * log_pinn
    p = _softmax3(z)
    return float(-np.mean(np.log(np.clip(p[np.arange(len(y_idx)), y_idx], 1e-12, 1.0))))


def fit_betas(df: pd.DataFrame) -> Dict:
    """Fit (β1, β2) by L-BFGS-B on cross-entropy."""
    # Log-probs [N, 3]
    model = df[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].to_numpy(dtype=float)
    pinn = df[["pinn_h", "pinn_d", "pinn_a"]].to_numpy(dtype=float)
    log_model = np.log(np.clip(model, 1e-9, 1.0))
    log_pinn = np.log(np.clip(pinn, 1e-9, 1.0))
    y_idx = df["ft_result"].map(RESULT_INDEX).to_numpy(dtype=int)

    # Baseline: model-only (β1=1, β2=0) — this is the identity/pass-through
    baseline_nll = _loss_benter(np.array([1.0, 0.0]), log_model, log_pinn, y_idx)

    # Initialise near pure-model; gradient will pull β2 up if Pinnacle helps.
    # Lower-bounded at 0 to stay in the "convex combination of information
    # sources" regime Benter described (negative weights would invert).
    result = minimize(
        _loss_benter,
        np.array([1.0, 0.0]),
        args=(log_model, log_pinn, y_idx),
        method="L-BFGS-B",
        bounds=[(0.0, 5.0), (0.0, 5.0)],
        options={"maxiter": 200, "ftol": 1e-9},
    )
    fitted_nll = float(result.fun)
    beta1, beta2 = float(result.x[0]), float(result.x[1])

    # Degenerate-case guard: if the optimizer returns β1=β2=0 (all zeros)
    # that means the gradient is zero and the fit is pathological. Fall
    # back to identity so runtime doesn't hit a sum-of-zeros softmax.
    if beta1 + beta2 < 1e-6:
        beta1, beta2 = 1.0, 0.0

    return {
        "beta1": round(beta1, 4),
        "beta2": round(beta2, 4),
        "n": int(len(df)),
        "baseline_nll": round(baseline_nll, 6),
        "fitted_nll": round(fitted_nll, 6),
        "improvement": round(baseline_nll - fitted_nll, 6),
        "converged": bool(result.success),
    }


# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Fit Benter (β1, β2) weights from v2 OOT predictions.")
    parser.add_argument("--force-refetch", action="store_true",
                        help="Ignore the odds cache and re-query Supabase")
    parser.add_argument("--engine", default="v2", choices=["v2"],
                        help="Engine to fit for (only v2 has an OOT parquet today)")
    parser.add_argument("--min-league-rows", type=int, default=MIN_LEAGUE_ROWS)
    args = parser.parse_args()

    if not OOT_PARQUET.exists():
        raise SystemExit(f"[benter-fit] OOT parquet missing: {OOT_PARQUET}")
    oot = pd.read_parquet(OOT_PARQUET)
    oot["match_date"] = pd.to_datetime(oot["match_date"]).dt.date.astype(str)
    print(f"[benter-fit] OOT parquet: {len(oot)} rows")

    # Pull the closing odds for this OOT window (with a day of padding to
    # absorb any date-parse drift between CSV and REST).
    d_min, d_max = oot["match_date"].min(), oot["match_date"].max()
    d_min = (pd.to_datetime(d_min) - pd.Timedelta(days=1)).date().isoformat()
    d_max = (pd.to_datetime(d_max) + pd.Timedelta(days=1)).date().isoformat()

    odds = load_or_fetch_odds(args.force_refetch, d_min, d_max)
    if odds.empty:
        raise SystemExit("[benter-fit] no odds rows in window — check date range + service key")

    # Normalise odds columns to float (REST returns strings).
    for col in ("psch", "pscd", "psca"):
        odds[col] = pd.to_numeric(odds[col], errors="coerce")
    odds = odds.dropna(subset=["psch", "pscd", "psca"])
    odds["match_date"] = pd.to_datetime(odds["match_date"]).dt.date.astype(str)

    # Compute Pinnacle implied probs (proportional vig removal).
    raw = np.stack([1.0 / odds["psch"].values, 1.0 / odds["pscd"].values, 1.0 / odds["psca"].values], axis=1)
    overround = raw.sum(axis=1, keepdims=True)
    implied = raw / overround
    odds["pinn_h"] = implied[:, 0]
    odds["pinn_d"] = implied[:, 1]
    odds["pinn_a"] = implied[:, 2]

    # Inner join on exact (league, date, home, away). Both sources are
    # football-data.co.uk canonical names so no fuzzy matching required.
    merged = oot.merge(
        odds[["league", "match_date", "home_team", "away_team", "pinn_h", "pinn_d", "pinn_a"]],
        on=["league", "match_date", "home_team", "away_team"],
        how="inner",
    )
    print(f"[benter-fit] joined rows: {len(merged)} ({len(merged)/len(oot)*100:.1f}% of OOT)")

    if len(merged) < 500:
        raise SystemExit(f"[benter-fit] only {len(merged)} joined rows — something is wrong with the join")

    # ── Global fit ──
    global_fit = fit_betas(merged)
    print(f"\n[benter-fit] GLOBAL  β=({global_fit['beta1']:.3f}, {global_fit['beta2']:.3f})  "
          f"n={global_fit['n']}  NLL {global_fit['baseline_nll']:.4f} → {global_fit['fitted_nll']:.4f} "
          f"(Δ {global_fit['improvement']:+.4f})  {'✓' if global_fit['converged'] else '✗'}")

    # ── Per-league fits ──
    per_league: Dict[str, Dict] = {}
    for lg in sorted(merged["league"].unique()):
        sub = merged[merged["league"] == lg]
        if len(sub) < args.min_league_rows:
            print(f"[benter-fit] {lg:<18} n={len(sub):>4}  < {args.min_league_rows} → fall back to global")
            continue
        fit = fit_betas(sub)
        per_league[lg] = fit
        print(f"[benter-fit] {lg:<18} β=({fit['beta1']:.3f}, {fit['beta2']:.3f})  n={fit['n']:>4}  "
              f"NLL {fit['baseline_nll']:.4f} → {fit['fitted_nll']:.4f} "
              f"(Δ {fit['improvement']:+.4f})  {'✓' if fit['converged'] else '✗'}")

    # ── Assemble output, preserving v1 / ensemble placeholders ──
    # Load existing JSON so we don't clobber other engines' state.
    existing = {}
    if OUTPUT_PATH.exists():
        try:
            existing = json.loads(OUTPUT_PATH.read_text())
        except Exception as e:
            print(f"[benter-fit] existing benter-weights.json unreadable ({e}); starting fresh")

    engines = existing.get("engines", {
        "v1":       {"global": {"beta1": 1.0, "beta2": 0.0}, "leagues": {}},
        "ensemble": {"global": {"beta1": 1.0, "beta2": 0.0}, "leagues": {}},
    })
    # Ensure v1 + ensemble stay as placeholders if they were missing.
    for eng in ("v1", "ensemble"):
        engines.setdefault(eng, {"global": {"beta1": 1.0, "beta2": 0.0}, "leagues": {}})

    # Overwrite v2 with the fit results.
    engines[args.engine] = {
        "global": {"beta1": global_fit["beta1"], "beta2": global_fit["beta2"]},
        "leagues": {
            lg: {
                "beta1": f["beta1"],
                "beta2": f["beta2"],
                "n": f["n"],
                "oot_logloss": f["fitted_nll"],
            }
            for lg, f in per_league.items()
        },
    }

    output = {
        "_version": 1,
        "_meta": {
            "trained_at": pd.Timestamp.utcnow().isoformat() + "Z",
            "n_oot_total": int(len(merged)),
            "loss_function": "cross_entropy",
            "min_league_rows": args.min_league_rows,
            "source_parquet": str(OOT_PARQUET.relative_to(REPO_ROOT)),
            "odds_cache": str(ODDS_CACHE.relative_to(REPO_ROOT)),
        },
        "engines": engines,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2))
    print(f"\n[benter-fit] → wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    print("[benter-fit] Activate via: NEXT_PUBLIC_BENTER_BLEND=on (or 'shadow' for log-only)")


if __name__ == "__main__":
    main()
