#!/usr/bin/env python3
"""
Line-Movement Ablation: does Pinnacle drift (opening → closing) improve
lean's Brier on a real-size training corpus?

Background: dev-04/05/06 all failed because their features were either
sparse (Coverage-Trap) or redundant (Phase B confirmed). Line-movement
is fundamentally different — it captures *sharp money flow* which is
information NOT in xG history.

Data:
  • Source: odds_closing_history with newly-backfilled PSH/PSD/PSA + existing PSCH/PSCD/PSCA
  • Coverage: ~16,674 matches × 16 leagues × 22/23+23/24+24/25 seasons
  • Bridge to team_xg_history via fuzzy team-name normalize (same as
    train_m3_premium.py — strips diacritics + club prefixes)

Setup:
  • Train: 22/23 + 23/24 + 24/25-H1 (Aug 22 → Dec 24)
  • Holdout: 24/25-H2 (Jan 25 → Jul 25)
  • Lean-only baseline (current 20 features) vs lean + 3 drift features

Drift features (after Shin vig-removal of both opening + closing):
  • drift_h = closing_p_h − opening_p_h  (positive = money OFF home)
  • drift_d = closing_p_d − opening_p_d
  • drift_a = closing_p_a − opening_p_a

Run:
  tools/venv/bin/python3 tools/v4/diagnostics/line_movement_ablation.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.eval.metrics import brier_multiclass
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m2_lambda import LAMBDA_MIN, LAMBDA_MAX
from v4.modules.m3_xg import BayesianEnsemble, NUMERIC_FEATURES, build_features_for_corpus
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator

CACHE_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / ".line_movement_odds_cache.parquet"


# ── Env loader for Supabase creds ────────────────────────────────────
def load_env():
    p = REPO_ROOT / ".env.local"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip().strip("'\"")
        if k and not os.environ.get(k):
            os.environ[k] = v


# ── Fetch odds_closing_history via Supabase REST ─────────────────────
def fetch_odds_paginated(supa_url: str, supa_key: str) -> pd.DataFrame:
    headers = {"apikey": supa_key, "Authorization": f"Bearer {supa_key}"}
    all_rows = []
    offset = 0
    PAGE = 1000
    cols = "match_key,league,match_date,home_team,away_team,psh,psd,psa,psch,pscd,psca"
    while True:
        url = (
            f"{supa_url}/rest/v1/odds_closing_history?select={cols}"
            f"&source=eq.football-data.co.uk&psh=not.is.null&psch=not.is.null"
            f"&limit={PAGE}&offset={offset}"
        )
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            page = json.loads(resp.read().decode())
        if not page:
            break
        all_rows.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
    return pd.DataFrame(all_rows)


# ── Team-name normalize (mirror train_m3_premium) ───────────────────
def fuzzy_team_normalize(s):
    import unicodedata
    if not s:
        return ""
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    tokens = s.lower().split()
    PREFIXES = {"afc", "fc", "sc", "ac", "vfl", "vfb", "tsg", "rb", "1.",
                "rcd", "sd", "ud", "ca", "us", "ssc", "as", "ssd"}
    while tokens and tokens[0] in PREFIXES:
        tokens.pop(0)
    return "".join(tokens)


# ── Shin vig-removal (mirrors market_disagreement) ───────────────────
def shin_vig_remove_3way(odds: np.ndarray) -> np.ndarray:
    """Shin's z-method on 3-way odds. Input: [decimal_h, decimal_d, decimal_a]."""
    if not (odds > 1.0).all():
        return np.array([np.nan, np.nan, np.nan])
    raw = 1.0 / odds
    s = raw.sum()
    if s <= 1.0:  # negative vig, return raw
        return raw / s
    # Shin's z ≈ (sum - 1) / (1 + max_prob)
    z = (s - 1.0) / (1.0 + raw.max() / s)
    z = float(np.clip(z, 0.001, 0.5))
    # Iterative shin probabilities
    p = raw.copy()
    for _ in range(20):
        denom = 1.0 - z + 2.0 * z * p
        p_new = (np.sqrt(z * z + 4 * (1 - z) * p * raw / (1 - z + 2 * z * p)) - z) / (2 * (1 - z))
        p_new = np.clip(p_new, 1e-6, 1 - 1e-6)
        p_new = p_new / p_new.sum()
        if np.allclose(p, p_new, atol=1e-8):
            break
        p = p_new
    return p


def main():
    print("=" * 72)
    print("Line-Movement Ablation")
    print("=" * 72)

    # ── 1. Fetch odds (or load cached) ──
    if CACHE_PATH.exists():
        print(f"Loading cached odds from {CACHE_PATH.name}")
        odds_df = pd.read_parquet(CACHE_PATH)
    else:
        load_env()
        supa_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
        supa_key = os.environ.get("SUPABASE_SERVICE_KEY")
        if not supa_url or not supa_key:
            print("❌ Supabase env vars missing")
            return 1
        print("Fetching odds_closing_history from Supabase (16k rows expected)...")
        t0 = time.time()
        odds_df = fetch_odds_paginated(supa_url, supa_key)
        print(f"  fetched {len(odds_df):,} rows in {time.time()-t0:.1f}s")
        odds_df.to_parquet(CACHE_PATH)
        print(f"  cached to {CACHE_PATH.name}")

    print(f"odds rows with both PSH+PSCH: {len(odds_df):,}")
    odds_df["match_date"] = pd.to_datetime(odds_df["match_date"]).dt.date

    # ── 2. Compute drift features ──
    print("Computing Shin vig-removed probs + drift...")
    t0 = time.time()
    open_probs = np.array([
        shin_vig_remove_3way(odds_df.iloc[i][["psh", "psd", "psa"]].astype(float).values)
        for i in range(len(odds_df))
    ])
    close_probs = np.array([
        shin_vig_remove_3way(odds_df.iloc[i][["psch", "pscd", "psca"]].astype(float).values)
        for i in range(len(odds_df))
    ])
    odds_df["drift_h"] = close_probs[:, 0] - open_probs[:, 0]
    odds_df["drift_d"] = close_probs[:, 1] - open_probs[:, 1]
    odds_df["drift_a"] = close_probs[:, 2] - open_probs[:, 2]
    odds_df = odds_df.dropna(subset=["drift_h", "drift_d", "drift_a"])
    print(f"  drift computed in {time.time()-t0:.1f}s, {len(odds_df):,} valid rows")
    print(f"  drift_h: mean={odds_df['drift_h'].mean():+.4f}  std={odds_df['drift_h'].std():.4f}")
    print(f"  drift_d: mean={odds_df['drift_d'].mean():+.4f}  std={odds_df['drift_d'].std():.4f}")
    print(f"  drift_a: mean={odds_df['drift_a'].mean():+.4f}  std={odds_df['drift_a'].std():.4f}")

    # ── 3. Bridge to team_xg_history via fuzzy normalize ──
    print("Loading team_xg_history match_pairs (22/23+23/24+24/25)...")
    pairs = load_match_pairs(
        since="2022-07-01", cutoff="2025-08-01",
    ).dropna(subset=["home_goals", "away_goals"])
    print(f"  match_pairs: {len(pairs):,}")

    # Fuzzy-join odds onto pairs
    odds_df["home_norm"] = odds_df["home_team"].apply(fuzzy_team_normalize)
    odds_df["away_norm"] = odds_df["away_team"].apply(fuzzy_team_normalize)
    pairs["home_norm"] = pairs["home"].apply(fuzzy_team_normalize)
    pairs["away_norm"] = pairs["away"].apply(fuzzy_team_normalize)
    pairs["match_date_d"] = pairs["match_date"].dt.date

    join_cols = ["league", "match_date_d", "home_norm", "away_norm"]
    odds_keyed = odds_df.rename(columns={"match_date": "_skip_date"})
    odds_keyed["match_date_d"] = odds_keyed["_skip_date"]
    odds_keyed = odds_keyed[
        ["league", "match_date_d", "home_norm", "away_norm",
         "drift_h", "drift_d", "drift_a", "psch", "pscd", "psca"]
    ].drop_duplicates(subset=join_cols)
    merged = pairs.merge(odds_keyed, on=join_cols, how="left")
    n_with_drift = int(merged["drift_h"].notna().sum())
    print(f"  match_pairs with drift: {n_with_drift:,}/{len(merged):,} "
          f"({100*n_with_drift/len(merged):.1f}%)")
    merged = merged.dropna(subset=["drift_h"]).reset_index(drop=True)

    # ── 4. Split train/holdout ──
    split_date = pd.Timestamp("2025-01-01")
    train_mask = merged["match_date"] < split_date
    train = merged[train_mask].reset_index(drop=True)
    holdout = merged[~train_mask].reset_index(drop=True)
    print(f"  train: {len(train):,}  holdout (24/25-H2 + later): {len(holdout):,}")

    # ── 5. Build lean features ──
    print("Building lean features (train + holdout)...")
    history = load_team_xg_history()
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)
    t0 = time.time()
    lean_train = build_features_for_corpus(
        train[["league", "match_date", "home", "away", "home_goals", "away_goals"]],
        history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    lean_hold = build_features_for_corpus(
        holdout[["league", "match_date", "home", "away", "home_goals", "away_goals"]],
        history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    print(f"  lean features built in {time.time()-t0:.1f}s")

    # Attach drift columns
    lean_train["drift_h"] = train["drift_h"].values
    lean_train["drift_d"] = train["drift_d"].values
    lean_train["drift_a"] = train["drift_a"].values
    lean_hold["drift_h"] = holdout["drift_h"].values
    lean_hold["drift_d"] = holdout["drift_d"].values
    lean_hold["drift_a"] = holdout["drift_a"].values

    def y_idx(h, a): return 0 if h > a else (2 if h < a else 1)
    y_train_h = train["home_goals"].values
    y_train_a = train["away_goals"].values
    y_hold = np.array([y_idx(h, a) for h, a in zip(holdout["home_goals"], holdout["away_goals"])])

    # ── 6. Helper: train + Brier ──
    def train_and_brier(extra_features: list):
        cols_X = list(NUMERIC_FEATURES) + extra_features
        X_tr = lean_train[cols_X + ["league"]].copy()
        X_tr["league"] = X_tr["league"].astype("category")
        X_ho = lean_hold[cols_X + ["league"]].copy()
        X_ho["league"] = X_ho["league"].astype("category")

        ens_h = BayesianEnsemble(n_models=5)
        ens_h.fit(X_tr, y_train_h, categorical_columns=["league"])
        ens_a = BayesianEnsemble(n_models=5)
        ens_a.fit(X_tr, y_train_a, categorical_columns=["league"])

        # Predict + DC
        mean_h, _ = ens_h.predict(X_ho[ens_h.feature_names])
        mean_a, _ = ens_a.predict(X_ho[ens_a.feature_names])
        lh = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
        la = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
        probs = np.empty((len(X_ho), 3))
        for i in range(len(X_ho)):
            try:
                M = DixonColesModel(float(lh[i]), float(la[i]), rho=-0.094).matrix(normalize=True)
            except ValueError:
                M = PoissonGoalModel(float(lh[i]), float(la[i])).matrix(normalize=True)
            p = get_1x2(M)
            probs[i] = [p["H"], p["D"], p["A"]]
        return brier_multiclass(y_hold, probs), ens_h

    # ── 7. Compare ──
    print()
    print("Training lean baseline...")
    t0 = time.time()
    brier_lean, ens_lean = train_and_brier([])
    print(f"  lean Brier on holdout: {brier_lean:.4f}  ({time.time()-t0:.1f}s)")

    print("Training lean + drift...")
    t0 = time.time()
    brier_drift, ens_drift = train_and_brier(["drift_h", "drift_d", "drift_a"])
    print(f"  lean+drift Brier on holdout: {brier_drift:.4f}  ({time.time()-t0:.1f}s)")

    delta = brier_drift - brier_lean
    print()
    print("=" * 72)
    print(f"  lean:        Brier {brier_lean:.4f}")
    print(f"  lean+drift:  Brier {brier_drift:.4f}    Δ = {delta:+.4f}")
    print()
    if delta <= -0.001:
        print(f"  ✅ DRIFT FEATURES IMPROVE Brier by ≥ 1pp → real signal beyond lean")
        # Quick SHAP-rank-equivalent: gain importance for drift features
        for ens, label in [(ens_drift, "home")]:
            gains = np.mean(
                [m.booster_.feature_importance(importance_type="gain") for m in ens.models],
                axis=0,
            )
            gains_pct = 100.0 * gains / gains.sum()
            feat_names = ens.feature_names
            for f in ["drift_h", "drift_d", "drift_a"]:
                if f in feat_names:
                    idx = feat_names.index(f)
                    print(f"    {f:<12s} ({label}) gain-share: {gains_pct[idx]:.2f}%  "
                          f"rank #{(np.argsort(-gains).tolist().index(idx)) + 1}/{len(feat_names)}")
    elif delta <= 0:
        print(f"  ⚠ Drift slightly better but within noise band (Δ > -0.001)")
    else:
        print(f"  ✗ Drift makes Brier WORSE — sharp-money signal NOT predictive beyond lean")

    return 0


if __name__ == "__main__":
    sys.exit(main())
