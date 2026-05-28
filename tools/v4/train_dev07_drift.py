#!/usr/bin/env python3
"""
Train + Eval dev-07: dev-03 schema + drift_h/d/a on FULL 27k corpus.

The definitive test of whether the Pinnacle-line-drift signal helps when
added to a production-size training corpus (not just the 4k-bridged subset
from the earlier ablation, where corpus-size effects dominated).

Architecture:
  • Same features as dev-03 (20 lean) + 3 drift features = 23 features total
  • Train: same window as dev-03 (since 2017, cutoff 2025-08-01 = before 25/26)
  • Drift bridged via fuzzy_team_normalize → odds_closing_history (PSH+PSCH)
  • Un-bridged matches: drift_h/d/a = 0 (impute-zero)
  • 5-model BayesianEnsemble (same architecture as dev-03)

Eval: 25/26 Tier-A holdout (same as Stage 1.m3 dev-03 baseline 0.6089)

Ship-decision:
  Δ ≤ -0.001 vs dev-03 → ship dev-07 as new primary
  Δ in (-0.001, +0.001) → archive (no meaningful improvement)
  Δ > +0.001 → archive (impute-0 biases the model)

Run: tools/venv/bin/python3 tools/v4/train_dev07_drift.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.eval.metrics import brier_multiclass
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m2_lambda import LAMBDA_MIN, LAMBDA_MAX
from v4.modules.m3_xg import (
    BayesianEnsemble, DEFAULT_LGB_PARAMS, NUMERIC_FEATURES,
    build_features_for_corpus,
)
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator

ARTIFACTS = REPO_ROOT / "tools/v4/artifacts"
CACHE = REPO_ROOT / "tools/v4/diagnostics/.line_movement_odds_cache.parquet"

TIER_A = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "championship", "liga3")


from v4.modules.m3_xg.canonical_team_map import join_key as canonical_join_key

def fuzzy_team_normalize(s, league=None):
    """Canonical-aware bridge between odds_closing_history and team_xg_history.

    Uses the JSON map dumped from canonical-team.mjs — same registry the
    project's JS ingest scripts use. Falls back to plain stripping for
    teams missing from the registry."""
    return canonical_join_key(s, league or "")


def shin_vig_remove_3way(odds):
    if not (odds > 1.0).all():
        return np.array([np.nan, np.nan, np.nan])
    raw = 1.0 / odds
    s = raw.sum()
    if s <= 1.0:
        return raw / s
    z = (s - 1.0) / (1.0 + raw.max() / s)
    z = float(np.clip(z, 0.001, 0.5))
    p = raw.copy()
    for _ in range(20):
        p_new = (np.sqrt(z * z + 4 * (1 - z) * p * raw / (1 - z + 2 * z * p)) - z) / (2 * (1 - z))
        p_new = np.clip(p_new, 1e-6, 1 - 1e-6)
        p_new = p_new / p_new.sum()
        if np.allclose(p, p_new, atol=1e-8):
            break
        p = p_new
    return p


def load_env():
    p = REPO_ROOT / ".env.local"
    if not p.exists(): return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip().strip("'\"")
        if k and not os.environ.get(k):
            os.environ[k] = v


def fetch_all_odds():
    """Fetch ALL odds_closing_history rows with PSH+PSCH (now incl. 25/26)."""
    load_env()
    supa_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    supa_key = os.environ.get("SUPABASE_SERVICE_KEY")
    headers = {"apikey": supa_key, "Authorization": f"Bearer {supa_key}"}
    cols = "match_key,league,match_date,home_team,away_team,psh,psd,psa,psch,pscd,psca"
    all_rows, offset = [], 0
    while True:
        url = (f"{supa_url}/rest/v1/odds_closing_history?select={cols}"
               f"&source=eq.football-data.co.uk&psh=not.is.null&psch=not.is.null"
               f"&limit=1000&offset={offset}")
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
            page = json.loads(r.read().decode())
        if not page: break
        all_rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    return pd.DataFrame(all_rows)


def attach_drift(pairs, odds):
    """Fuzzy-join opening+closing odds onto pairs, compute drift, impute 0 for unmatched."""
    odds = odds.copy()
    odds["match_date"] = pd.to_datetime(odds["match_date"]).dt.date

    # Compute drift via Shin vig-removal
    open_probs = np.array([
        shin_vig_remove_3way(odds.iloc[i][["psh", "psd", "psa"]].astype(float).values)
        for i in range(len(odds))
    ])
    close_probs = np.array([
        shin_vig_remove_3way(odds.iloc[i][["psch", "pscd", "psca"]].astype(float).values)
        for i in range(len(odds))
    ])
    odds["drift_h"] = close_probs[:, 0] - open_probs[:, 0]
    odds["drift_d"] = close_probs[:, 1] - open_probs[:, 1]
    odds["drift_a"] = close_probs[:, 2] - open_probs[:, 2]
    odds = odds.dropna(subset=["drift_h"])
    # Canonical-aware: pass league so canonical_join_key can lookup the
    # league-specific alias map.
    odds["home_norm"] = odds.apply(lambda r: fuzzy_team_normalize(r["home_team"], r["league"]), axis=1)
    odds["away_norm"] = odds.apply(lambda r: fuzzy_team_normalize(r["away_team"], r["league"]), axis=1)
    odds_keyed = odds.rename(columns={"match_date": "match_date_d"})[
        ["league", "match_date_d", "home_norm", "away_norm",
         "drift_h", "drift_d", "drift_a"]
    ].drop_duplicates(subset=["league", "match_date_d", "home_norm", "away_norm"])

    pairs = pairs.copy()
    pairs["home_norm"] = pairs.apply(lambda r: fuzzy_team_normalize(r["home"], r["league"]), axis=1)
    pairs["away_norm"] = pairs.apply(lambda r: fuzzy_team_normalize(r["away"], r["league"]), axis=1)
    pairs["match_date_d"] = pairs["match_date"].dt.date

    merged = pairs.merge(
        odds_keyed, on=["league", "match_date_d", "home_norm", "away_norm"], how="left"
    )
    # Impute 0 for unmatched (drift unavailable)
    for c in ("drift_h", "drift_d", "drift_a"):
        merged[c] = merged[c].fillna(0.0)

    n_bridged = int((merged[["drift_h", "drift_d", "drift_a"]].abs().sum(axis=1) > 0).sum())
    print(f"  bridged: {n_bridged:,}/{len(merged):,} "
          f"({100 * n_bridged / len(merged):.1f}%)  rest imputed 0")
    return merged


def main():
    t_all = time.time()
    print("=" * 72)
    print("Train + Eval dev-07: dev-03 features + drift on FULL 27k corpus")
    print("=" * 72)

    # ── Fetch all odds (re-fetch since 25/26 backfill just landed) ──
    print("Fetching odds_closing_history (with 25/26 backfill)...")
    odds = fetch_all_odds()
    print(f"  fetched: {len(odds):,} rows")
    # Refresh cache
    odds.to_parquet(CACHE)

    # ── Training pairs (full corpus, mirror dev-03 setup) ──
    print("Loading training match_pairs (since 2017, cutoff 2025-08-01)...")
    train_pairs = load_match_pairs(
        cutoff="2025-08-01", since="2017-01-01",
    ).dropna(subset=["home_goals", "away_goals"])
    print(f"  train_pairs: {len(train_pairs):,}")

    print("Attaching drift to training corpus...")
    train_pairs = attach_drift(train_pairs, odds)

    # ── Holdout: 25/26 Tier-A (matches Stage 1.m3 dev-03 baseline) ──
    print("Loading holdout (25/26 Tier-A)...")
    holdout = load_match_pairs(
        since="2025-08-01", leagues=list(TIER_A),
    ).dropna(subset=["home_goals", "away_goals"])
    print(f"  holdout: {len(holdout):,}")
    holdout = attach_drift(holdout, odds)

    # ── Build lean features ──
    history = load_team_xg_history()
    print("Fitting EloCalculator + TeamMomentumCalculator...")
    t0 = time.time()
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)
    print(f"  fit in {time.time() - t0:.1f}s")

    print(f"Building lean features (train, {len(train_pairs):,} matches)...")
    t0 = time.time()
    lean_train = build_features_for_corpus(
        train_pairs[["league", "match_date", "home", "away", "home_goals", "away_goals"]],
        history, elo_calculator=elo, momentum_calculator=momentum, verbose=True,
    ).reset_index(drop=True)
    print(f"  done in {time.time() - t0:.1f}s")

    print(f"Building lean features (holdout, {len(holdout):,} matches)...")
    lean_hold = build_features_for_corpus(
        holdout[["league", "match_date", "home", "away", "home_goals", "away_goals"]],
        history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)

    # Attach drift columns
    lean_train["drift_h"] = train_pairs["drift_h"].values
    lean_train["drift_d"] = train_pairs["drift_d"].values
    lean_train["drift_a"] = train_pairs["drift_a"].values
    lean_hold["drift_h"] = holdout["drift_h"].values
    lean_hold["drift_d"] = holdout["drift_d"].values
    lean_hold["drift_a"] = holdout["drift_a"].values

    y_train_h = train_pairs["home_goals"].values
    y_train_a = train_pairs["away_goals"].values
    def y_idx(h, a): return 0 if h > a else (2 if h < a else 1)
    y_test = np.array([y_idx(h, a) for h, a in zip(holdout["home_goals"], holdout["away_goals"])])

    def X(df, with_drift):
        cols = list(NUMERIC_FEATURES) + (["drift_h", "drift_d", "drift_a"] if with_drift else [])
        D = df[cols + ["league"]].copy()
        D["league"] = D["league"].astype("category")
        return D

    def lambdas_to_1x2(lh, la):
        probs = np.empty((len(lh), 3))
        for i in range(len(lh)):
            try:
                M = DixonColesModel(float(lh[i]), float(la[i]), rho=-0.094).matrix(normalize=True)
            except ValueError:
                M = PoissonGoalModel(float(lh[i]), float(la[i])).matrix(normalize=True)
            p = get_1x2(M)
            probs[i] = [p["H"], p["D"], p["A"]]
        return probs

    # ── Train dev-07 (with drift) ──
    print(f"\nTraining dev-07 (lean + drift, n_train={len(X(lean_train, True)):,}, 23 features)...")
    t0 = time.time()
    ens_h_07 = BayesianEnsemble(n_models=5)
    ens_h_07.fit(X(lean_train, True), y_train_h, categorical_columns=["league"])
    ens_a_07 = BayesianEnsemble(n_models=5)
    ens_a_07.fit(X(lean_train, True), y_train_a, categorical_columns=["league"])
    print(f"  done in {time.time() - t0:.1f}s")

    # Also retrain lean (no drift) on same corpus as comparison sanity
    print(f"\nTraining lean-only (no drift) on same corpus as control...")
    t0 = time.time()
    ens_h_lean = BayesianEnsemble(n_models=5)
    ens_h_lean.fit(X(lean_train, False), y_train_h, categorical_columns=["league"])
    ens_a_lean = BayesianEnsemble(n_models=5)
    ens_a_lean.fit(X(lean_train, False), y_train_a, categorical_columns=["league"])
    print(f"  done in {time.time() - t0:.1f}s")

    # ── Predict + Brier ──
    print(f"\nPredicting on holdout ({len(holdout):,} matches)...")

    def predict_brier(ens_h, ens_a, X_ho):
        mh, _ = ens_h.predict(X_ho[ens_h.feature_names])
        ma, _ = ens_a.predict(X_ho[ens_a.feature_names])
        lh = np.clip(mh, LAMBDA_MIN, LAMBDA_MAX)
        la = np.clip(ma, LAMBDA_MIN, LAMBDA_MAX)
        return brier_multiclass(y_test, lambdas_to_1x2(lh, la))

    brier_07 = predict_brier(ens_h_07, ens_a_07, X(lean_hold, True))
    brier_lean_full = predict_brier(ens_h_lean, ens_a_lean, X(lean_hold, False))

    # Reference: actual dev-03 artifact
    home03 = ARTIFACTS / "m3_xg-home-dev-03.pkl"
    away03 = ARTIFACTS / "m3_xg-away-dev-03.pkl"
    if home03.exists():
        ens_h_03 = BayesianEnsemble.load(home03)
        ens_a_03 = BayesianEnsemble.load(away03)
        brier_dev03 = predict_brier(ens_h_03, ens_a_03, X(lean_hold, False))
    else:
        brier_dev03 = None

    # ── Decision ──
    print()
    print("=" * 72)
    print(f"{'model':<35s} {'features':>10s} {'Brier':>10s}")
    print("-" * 72)
    if brier_dev03 is not None:
        print(f"{'dev-03 (production, archive)':<35s} {20:>10d} {brier_dev03:>10.4f}")
    print(f"{'lean-control (re-trained, no drift)':<35s} {20:>10d} {brier_lean_full:>10.4f}")
    print(f"{'dev-07 (lean + drift_h/d/a)':<35s} {23:>10d} {brier_07:>10.4f}")
    print()
    delta_vs_lean_control = brier_07 - brier_lean_full
    print(f"  Δ vs lean-control: {delta_vs_lean_control:+.4f}")
    if brier_dev03 is not None:
        delta_vs_dev03 = brier_07 - brier_dev03
        print(f"  Δ vs dev-03 (production): {delta_vs_dev03:+.4f}")

    print()
    if brier_dev03 is not None and brier_07 < brier_dev03 - 0.001:
        verdict = "✅ SHIP dev-07 — drift improves production model"
        save = True
    elif brier_dev03 is not None and brier_07 < brier_dev03:
        verdict = "⚠ marginal improvement vs dev-03 — Δ within noise band"
        save = True
    else:
        verdict = "✗ ARCHIVE — drift does NOT improve production model"
        save = False
    print(f"  {verdict}")

    if save:
        tag = "dev-07-drift"
        ARTIFACTS.mkdir(exist_ok=True)
        ens_h_07.save(ARTIFACTS / f"m3_xg-home-{tag}.pkl")
        ens_a_07.save(ARTIFACTS / f"m3_xg-away-{tag}.pkl")
        manifest = {
            "tag": tag,
            "trained_at": datetime.now().isoformat(),
            "architecture": "dev-03 + pinnacle line-drift (h/d/a)",
            "n_train_matches": len(train_pairs),
            "n_holdout_matches": len(holdout),
            "n_features_total": 23,
            "feature_names_lean": list(NUMERIC_FEATURES),
            "feature_names_drift": ["drift_h", "drift_d", "drift_a"],
            "lgb_params": DEFAULT_LGB_PARAMS,
            "brier_dev07": float(brier_07),
            "brier_lean_control": float(brier_lean_full),
            "brier_dev03_reference": float(brier_dev03) if brier_dev03 else None,
            "delta_vs_dev03": float(brier_07 - brier_dev03) if brier_dev03 else None,
        }
        with open(ARTIFACTS / f"m3_xg-{tag}.json", "w") as f:
            json.dump(manifest, f, indent=2)
        print(f"  ✓ saved artifacts: m3_xg-{{home,away}}-{tag}.pkl")
    print()
    print(f"Total: {(time.time() - t_all) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
