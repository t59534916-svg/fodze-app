#!/usr/bin/env python3
"""
energy_freq_signal_discovery.py — Phase A der dev-08 Sprint.

Operationalisiert die 5 Kennzahlen aus dem "Energie · Frequenz · Schwingung"
First-Principles Framework auf team_xg_history (Saisons 23/24 + 24/25 train,
25/26 holdout), und prüft per-feature ob sie über lean (dev-03) HINAUS Signal
tragen — BEVOR wir trainieren.

Methodik:
  1. Pure-Python-Computation der 5 Features (keine Sofa-extras → keine
     Sparsity-Trap analog dev-04/05).
  2. Spearman-Korrelation zu Outcome (goal_diff + 1X2).
  3. Korrelations-Matrix zu lean features (catch redundancy analog dev-06).
  4. Marginal-Brier-Test: lean + JE 1 dieser features. Brier-Gate:
     Δ ≤ -0.001 = real signal | Δ in [-0.001, +0.001] = noise |
     Δ > +0.001 = active hurt.

Operationalisierung der 5 Kennzahlen (alle als HOME - AWAY diff):

  - Schwingung_amplitude  = range(goal_diff) over last-8 matches
                          → Amplitude einer Form-Oszillation
  - Frequenz_total_goals  = mean(goals_for + goals_against) over last-10
                          → Ereignis-Rate pro Match
  - Energie_match_intensity = mean(xg_for) × mean(xg_for + xga) over last-5
                          → Team-Quality × Match-Pace ("Intensität × Dauer")
  - Noise_xg_discrepancy  = mean(|xg - goals_for|) / mean(xg) over last-8
                          → relative xG-vs-Actual Diskrepanz
  - CSD_autocorr_lag1     = corr(goal_diff[t-1], goal_diff[t]) over last-10
                          → Critical Slowing Down: ↑ autocorr = Kipppunkt-Warnung

Run:
  tools/venv/bin/python3 tools/v4/diagnostics/energy_freq_signal_discovery.py

Output:
  - Konsolen-Tabelle pro Feature: Brier-Gate-Status
  - tools/v4/diagnostics/energy_freq_signal_discovery.json (alle Zahlen)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.eval.metrics import brier_multiclass
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m2_lambda import LAMBDA_MIN, LAMBDA_MAX
from v4.modules.m3_xg import BayesianEnsemble, NUMERIC_FEATURES, build_features_for_corpus
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator

# ── Acceptance Thresholds ──
# These reflect the hard-won lessons from dev-04/05/06/07:
# - Brier-improvement < 0.001 is within run-variance for 5-bagged ensembles
#   (we showed std≈0.002 in line_movement_validation.py)
# - We want Δ ≤ -0.001 as the gate, so we have ~1σ separation from noise
BRIER_GATE = -0.001  # Δ ≤ this → real signal
BRIER_NOISE_BAND = 0.001  # |Δ| ≤ this → indistinguishable from noise

# ── Tier-A leagues (consistent with dev-06 Phase B comparison) ──
TIER_A = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1", "championship", "liga3")


# ════════════════════════════════════════════════════════════════════════
# Feature operationalizations — all pure functions on team_xg_history
# ════════════════════════════════════════════════════════════════════════

def _team_history_before(
    history: pd.DataFrame, team: str, league: str, before_date: pd.Timestamp, window: int
) -> pd.DataFrame:
    """Strict-lagging slice of team's history. Filter by (team, league) and
    strictly < before_date, take last `window` rows in chronological order.
    """
    mask = (
        (history["team"] == team)
        & (history["league"] == league)
        & (history["match_date"] < before_date)
    )
    return history.loc[mask].sort_values("match_date").tail(window)


def schwingung_amplitude(
    history: pd.DataFrame, team: str, league: str, before_date: pd.Timestamp, window: int = 8
) -> float:
    """Amplitude = range(goal_diff) over last-window matches.

    Captures form-curve oscillation distinct from MEAN (lean already has mean).
    A team going [+3, -2, +4, -1, ...] has HIGH amplitude; a stable team has LOW.
    """
    last = _team_history_before(history, team, league, before_date, window)
    if len(last) < 4:
        return 0.0  # neutral when not enough history
    diff = (last["goals_for"].fillna(0) - last["goals_against"].fillna(0)).values
    return float(diff.max() - diff.min())


def frequenz_total_goals(
    history: pd.DataFrame, team: str, league: str, before_date: pd.Timestamp, window: int = 10
) -> float:
    """Event-rate (goals per match, for OR against).

    Captures "how often things happen" — high-scoring teams (BVB, Bayern) vs
    low-scoring (Atletico). Distinct from lambda_naive because it sums BOTH
    sides → measures match-pace, not team-strength.
    """
    last = _team_history_before(history, team, league, before_date, window)
    if len(last) < 5:
        return 2.5  # league-typical default
    return float((last["goals_for"].fillna(0) + last["goals_against"].fillna(0)).mean())


def energie_match_intensity(
    history: pd.DataFrame, team: str, league: str, before_date: pd.Timestamp, window: int = 5
) -> float:
    """Match-intensity = mean(xg_for + xga) × team's own xG mean.

    Operationalizes "Intensität × Dauer" from the PDF using only columns
    available in team_xg_history. The total-match-xG (xg_for + xga) measures
    HOW OPEN/INTENSE matches involving this team have been over the last 5 —
    Dortmund-style high-event vs Atletico-style cagey. Multiplied by the
    team's own xG gives a Quality×Intensity composite.

    Distinct from lambda_h_naive (which is just mean xg_for) because it
    captures the OPPONENT-induced match pace too.
    """
    last = _team_history_before(history, team, league, before_date, window)
    if len(last) < 3:
        return 4.0  # neutral default (~2.4 + 1.6 = avg match xG totals)
    xg_for = last["xg"].fillna(last["goals_for"])
    xg_against = last["xga"].fillna(last["goals_against"])
    intensity = (xg_for + xg_against).mean()
    quality = xg_for.mean()
    return float(quality * intensity)


def noise_xg_discrepancy(
    history: pd.DataFrame, team: str, league: str, before_date: pd.Timestamp, window: int = 8
) -> float:
    """|xg - goals_for| variance, normalized to xg mean = relative noise.

    Captures luck-vs-skill. A team that consistently scores ABOVE xG (over-
    performer / clinical finishing) AND a team that consistently scores BELOW
    xG (wasteful / bad finishing) both have low NOISE — they're consistent.
    A team alternating between 3-vs-0.5-xG and 0-vs-2.5-xG has high NOISE.
    """
    last = _team_history_before(history, team, league, before_date, window)
    if len(last) < 4:
        return 0.3  # neutral
    xg = last["xg"].fillna(last["goals_for"])
    goals = last["goals_for"].fillna(0)
    discrepancy = (xg - goals).abs().mean()
    return float(discrepancy / max(0.5, xg.mean()))


def csd_autocorr_lag1(
    history: pd.DataFrame, team: str, league: str, before_date: pd.Timestamp, window: int = 10
) -> float:
    """Lag-1 autocorrelation of goal_diff series.

    The Critical-Slowing-Down core signal. As a team approaches a regime-shift
    (form-tip-over OR breakout), its goal_diff series becomes MORE auto-
    correlated (good games predict good, bad predict bad — recovery rate λ ↓).
    Clipped to [-1, 1].
    """
    last = _team_history_before(history, team, league, before_date, window)
    if len(last) < 5:
        return 0.0
    diff = (last["goals_for"].fillna(0) - last["goals_against"].fillna(0)).values
    if np.std(diff) < 1e-6:
        return 0.0
    return float(np.clip(np.corrcoef(diff[:-1], diff[1:])[0, 1], -1.0, 1.0))


# ── Feature registry ──
ENERGY_FEATURE_FUNCS = {
    "schwingung_amplitude": schwingung_amplitude,
    "frequenz_total_goals": frequenz_total_goals,
    "energie_match_intensity": energie_match_intensity,
    "noise_xg_discrepancy": noise_xg_discrepancy,
    "csd_autocorr_lag1": csd_autocorr_lag1,
}

# Each becomes a DIFF feature (home - away) consistent with elo_diff, lineup_quality_diff
ENERGY_FEATURE_NAMES = [f"{k}_diff" for k in ENERGY_FEATURE_FUNCS.keys()]


def build_energy_features_for_corpus(
    match_pairs: pd.DataFrame, history: pd.DataFrame, verbose: bool = False
) -> pd.DataFrame:
    """Build the 5 diff-features for every match. Returns DataFrame with
    columns ENERGY_FEATURE_NAMES, indexed match-row-order matching match_pairs.
    """
    out_rows = []
    n = len(match_pairs)
    for i, (_, m) in enumerate(match_pairs.iterrows()):
        if verbose and i > 0 and i % 1000 == 0:
            print(f"  energy features: {i:,}/{n:,}")
        row = {}
        for fname, func in ENERGY_FEATURE_FUNCS.items():
            h_val = func(history, m["home"], m["league"], m["match_date"])
            a_val = func(history, m["away"], m["league"], m["match_date"])
            row[f"{fname}_diff"] = h_val - a_val
        out_rows.append(row)
    return pd.DataFrame(out_rows).reset_index(drop=True)


# ════════════════════════════════════════════════════════════════════════
# Brier-Gate evaluation pipeline
# ════════════════════════════════════════════════════════════════════════

def _build_score_grid(lh, la, rho=-0.094):
    try:
        return DixonColesModel(lh, la, rho=rho).matrix(normalize=True), False
    except ValueError:
        return PoissonGoalModel(lh, la).matrix(normalize=True), True


def predict_probs(ens_h, ens_a, X):
    X = X.copy()
    if "league" in X.columns:
        X["league"] = X["league"].astype("category")
    X_aligned = X[ens_h.feature_names]
    mean_h, _ = ens_h.predict(X_aligned)
    mean_a, _ = ens_a.predict(X_aligned)
    lh = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
    la = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)
    probs = np.empty((len(X), 3))
    for i in range(len(X)):
        M, _ = _build_score_grid(lh[i], la[i])
        p = get_1x2(M)
        probs[i] = [p["H"], p["D"], p["A"]]
    return probs


def y_index(h, a):
    return 0 if h > a else (2 if h < a else 1)


# ════════════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════════════

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-models", type=int, default=5)
    ap.add_argument("--tier-a-only", action="store_true",
                    help="Restrict to Tier-A leagues (consistent with dev-06 ablation methodology)")
    ap.add_argument("--quick", action="store_true",
                    help="Quick mode: 3 bagged models, no full ablation (debugging only)")
    args = ap.parse_args()

    if args.quick:
        args.n_models = 3

    t_total = time.time()
    print("=" * 78)
    print("Phase A: Energy/Frequency/CSD Signal Discovery")
    print("=" * 78)
    print(f"Brier-Gate: Δ ≤ {BRIER_GATE} → ship signal | |Δ| < {BRIER_NOISE_BAND} → noise")
    print(f"n_models: {args.n_models}, tier-a-only: {args.tier_a_only}")
    print()

    leagues = list(TIER_A) if args.tier_a_only else None

    # ── Load training corpus + holdout ──
    print("Loading match pairs...")
    train_pairs = (
        load_match_pairs(cutoff="2025-08-01", since="2023-07-01", leagues=leagues)
        .dropna(subset=["home_goals", "away_goals"])
        .reset_index(drop=True)
    )
    print(f"  train: {len(train_pairs):,} matches")

    holdout_pairs = (
        load_match_pairs(since="2025-08-01", leagues=leagues)
        .dropna(subset=["home_goals", "away_goals"])
        .reset_index(drop=True)
    )
    print(f"  holdout (25/26): {len(holdout_pairs):,} matches")

    print("\nLoading team_xg_history...")
    history = load_team_xg_history(leagues=leagues)
    history["match_date"] = pd.to_datetime(history["match_date"])
    print(f"  history rows: {len(history):,}")

    # ── Build lean features (dev-03 schema) ──
    print("\nFitting Elo + Momentum calculators (one-time)...")
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)

    print("Building lean features for train+holdout...")
    t0 = time.time()
    lean_train = build_features_for_corpus(
        train_pairs, history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    lean_hold = build_features_for_corpus(
        holdout_pairs, history, elo_calculator=elo, momentum_calculator=momentum,
    ).reset_index(drop=True)
    print(f"  lean done in {time.time()-t0:.1f}s")

    # ── Build energy/freq/CSD features ──
    print("Building energy/freq/CSD features for train+holdout...")
    t0 = time.time()
    energy_train = build_energy_features_for_corpus(train_pairs, history, verbose=True)
    energy_hold = build_energy_features_for_corpus(holdout_pairs, history, verbose=True)
    print(f"  energy done in {time.time()-t0:.1f}s")

    # ── PART 1: Correlation diagnostics (cheap, run first) ──
    print()
    print("=" * 78)
    print("PART 1: Correlation diagnostics (signal-without-training)")
    print("=" * 78)

    # 1a. Per-feature Spearman correlation to outcome (goal_diff)
    print("\n[1a] Spearman correlation to goal_diff (outcome strength):")
    goal_diff_train = train_pairs["home_goals"].values - train_pairs["away_goals"].values
    goal_diff_hold = holdout_pairs["home_goals"].values - holdout_pairs["away_goals"].values

    print(f"  {'Feature':<35s} {'ρ (train)':>10s}  {'ρ (holdout)':>12s}  {'  verdict'}")
    print("  " + "-" * 75)
    spearman_results = {}
    for f in ENERGY_FEATURE_NAMES:
        rho_tr, _ = scipy_stats.spearmanr(energy_train[f], goal_diff_train)
        rho_ho, _ = scipy_stats.spearmanr(energy_hold[f], goal_diff_hold)
        spearman_results[f] = {"train": float(rho_tr), "holdout": float(rho_ho)}
        sign_consistent = (rho_tr > 0) == (rho_ho > 0)
        strong = abs(rho_ho) > 0.05
        marker = "🟢 strong" if (strong and sign_consistent) else (
            "🟡 weak" if (sign_consistent and abs(rho_ho) > 0.02) else "🔴 noise"
        )
        print(f"  {f:<35s} {rho_tr:+.4f}    {rho_ho:+.4f}      {marker}")

    # 1b. Correlation with lean features (catch redundancy)
    print("\n[1b] Max correlation with lean features (|ρ| > 0.7 → likely redundant):")
    lean_cols = [c for c in NUMERIC_FEATURES if c in lean_train.columns]
    redundancy_results = {}
    for f in ENERGY_FEATURE_NAMES:
        max_rho = 0.0
        worst_lean = ""
        for lc in lean_cols:
            r, _ = scipy_stats.spearmanr(energy_train[f], lean_train[lc])
            if abs(r) > abs(max_rho):
                max_rho = r
                worst_lean = lc
        redundancy_results[f] = {"max_abs_rho": abs(max_rho), "with_feature": worst_lean}
        flag = "⚠ redundant" if abs(max_rho) > 0.7 else ("· corr" if abs(max_rho) > 0.4 else "✓ independent")
        print(f"  {f:<35s} {max_rho:+.4f} with {worst_lean:<30s} {flag}")

    # ── PART 2: Brier-Gate ablation (expensive — only run if Part 1 has any hope) ──
    any_strong = any(abs(spearman_results[f]["holdout"]) > 0.02 for f in ENERGY_FEATURE_NAMES)
    if not any_strong and not args.quick:
        print()
        print("=" * 78)
        print("ALL 5 features show ρ < 0.02 to holdout outcome → SKIPPING Brier-Gate")
        print("=" * 78)
        print("Verdict: Phase A FAIL. Stop investing in this direction.")
        out = {
            "verdict": "FAIL_NO_HOLDOUT_CORRELATION",
            "spearman": spearman_results,
            "redundancy": redundancy_results,
            "brier_ablation": None,
            "duration_min": (time.time() - t_total) / 60.0,
        }
        out_path = REPO_ROOT / "tools/v4/diagnostics/energy_freq_signal_discovery.json"
        with open(out_path, "w") as fh:
            json.dump(out, fh, indent=2)
        print(f"  Report: {out_path.relative_to(REPO_ROOT)}")
        return 0

    print()
    print("=" * 78)
    print("PART 2: Brier-Gate ablation (per-feature add, train, eval on 25/26 holdout)")
    print("=" * 78)
    print(f"This trains {len(ENERGY_FEATURE_NAMES) + 1 + 1} ensembles ({2 * (len(ENERGY_FEATURE_NAMES) + 2)} bagged models)…")

    # y_true for holdout 1x2
    y_true_hold = np.array(
        [y_index(h, a) for h, a in zip(holdout_pairs["home_goals"], holdout_pairs["away_goals"])]
    )
    y_h_train = train_pairs["home_goals"].values
    y_a_train = train_pairs["away_goals"].values

    def train_and_score(extra_features: list, label: str) -> float:
        feature_cols = list(NUMERIC_FEATURES)
        # Concat lean + extra
        X_tr_lean = lean_train[NUMERIC_FEATURES]
        X_ho_lean = lean_hold[NUMERIC_FEATURES]
        if extra_features:
            X_tr = pd.concat(
                [X_tr_lean] + [energy_train[[f]] for f in extra_features], axis=1
            )
            X_ho = pd.concat(
                [X_ho_lean] + [energy_hold[[f]] for f in extra_features], axis=1
            )
        else:
            X_tr = X_tr_lean.copy()
            X_ho = X_ho_lean.copy()
        X_tr["league"] = lean_train["league"].values
        X_ho["league"] = lean_hold["league"].values

        ens_h = BayesianEnsemble(n_models=args.n_models)
        ens_h.fit(X_tr, y_h_train, categorical_columns=["league"])
        ens_a = BayesianEnsemble(n_models=args.n_models)
        ens_a.fit(X_tr, y_a_train, categorical_columns=["league"])

        probs = predict_probs(ens_h, ens_a, X_ho)
        return brier_multiclass(y_true_hold, probs)

    # Baseline
    print("\n[2a] Training lean-only baseline...")
    t0 = time.time()
    brier_baseline = train_and_score([], "lean-only")
    print(f"   Baseline lean-only Brier on 25/26 holdout: {brier_baseline:.4f}  ({time.time()-t0:.1f}s)")

    # Per-feature
    print(f"\n[2b] Per-feature ablation (add 1 energy feature to lean → 18 features):")
    print(f"  {'Feature added':<35s} {'Brier':>8s} {'Δ vs lean':>12s}  verdict")
    print("  " + "-" * 75)
    ablation_results = {}
    for f in ENERGY_FEATURE_NAMES:
        t0 = time.time()
        b = train_and_score([f], f)
        delta = b - brier_baseline
        ablation_results[f] = {"brier": float(b), "delta": float(delta)}
        if delta <= BRIER_GATE:
            marker = "🟢 PASS (ship)"
        elif abs(delta) < BRIER_NOISE_BAND:
            marker = "🟡 noise"
        else:
            marker = "🔴 HURT"
        print(f"  {f:<35s} {b:.4f}    {delta:+.4f}    {marker}  ({time.time()-t0:.1f}s)")

    # All 5 combined
    print(f"\n[2c] All 5 features combined (sanity):")
    t0 = time.time()
    b_all = train_and_score(ENERGY_FEATURE_NAMES, "all-5")
    delta_all = b_all - brier_baseline
    print(f"  {'all 5 energy/freq/CSD features':<35s} {b_all:.4f}    {delta_all:+.4f}  ({time.time()-t0:.1f}s)")

    # ── Verdict ──
    print()
    print("=" * 78)
    print("PHASE A VERDICT")
    print("=" * 78)
    winners = [
        (f, r["brier"], r["delta"]) for f, r in ablation_results.items() if r["delta"] <= BRIER_GATE
    ]
    if winners:
        winners.sort(key=lambda x: x[2])
        print(f"🎯 {len(winners)} feature(s) PASS the Brier-Gate (Δ ≤ {BRIER_GATE}):")
        for f, b, d in winners:
            print(f"   {f:<35s} Brier={b:.4f}  Δ={d:+.4f}")
        print(f"\n→ Proceed to Phase B: train dev-08 with lean + these features.")
        verdict = "PASS"
    else:
        print(f"❌ ZERO of 5 features cleared the Brier-Gate ({BRIER_GATE}) on 25/26 holdout.")
        print(f"   Best Δ: {min(r['delta'] for r in ablation_results.values()):+.4f}")
        print(f"   Verdict: Signal redundant with lean OR lost in run-variance.")
        print(f"   → ARCHIVE dev-08. Document in CLAUDE.md analog to dev-04/05/06/07.")
        verdict = "FAIL"

    out = {
        "verdict": verdict,
        "config": {
            "n_models": args.n_models,
            "tier_a_only": args.tier_a_only,
            "brier_gate": BRIER_GATE,
            "noise_band": BRIER_NOISE_BAND,
            "n_train_matches": len(train_pairs),
            "n_holdout_matches": len(holdout_pairs),
        },
        "spearman": spearman_results,
        "redundancy": redundancy_results,
        "brier_ablation": {
            "baseline_brier": float(brier_baseline),
            "per_feature": ablation_results,
            "all_5": {"brier": float(b_all), "delta": float(delta_all)},
        },
        "winners": [{"feature": f, "brier": b, "delta": d} for f, b, d in winners],
        "duration_min": (time.time() - t_total) / 60.0,
    }
    out_path = REPO_ROOT / "tools/v4/diagnostics/energy_freq_signal_discovery.json"
    with open(out_path, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"\nReport saved: {out_path.relative_to(REPO_ROOT)}")
    print(f"Total time: {(time.time() - t_total) / 60.0:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
