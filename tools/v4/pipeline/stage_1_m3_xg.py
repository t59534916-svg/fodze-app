"""
Stage 1.m3_xg — Evaluate trained m3_xg predictor on 25/26 holdout.

Per V4-BACKTESTING-PROTOCOL §"m3_xg":
  Pass criteria: Brier ≤ v2 + 0.005 (must at least match — improvement comes
                                      from later modules).

v2 production baseline is read LIVE from
  tools/backtest/cross-engine-current-metrics.json
(not from CLAUDE.md which may be stale — empirically observed 2026-05-12:
CLAUDE.md claimed v2_benter=0.6120 but live metrics file reports 0.6194).

Stage 1 pass = v4 m3 (raw, no m6 Benter blend) ≤ v2_benter + 0.005.

Tests (7 total):
  1. Trained artifacts load + have correct schema
  2. Holdout predict_batch runs without errors, returns finite probabilities
  3. 1X2 probabilities sum to 1.0 per match
  4. σ² distribution non-degenerate (>50% of σ² > 0.001)
  5. Brier 1X2 on 25/26 holdout ≤ v2_benter + 0.005 (live baseline)
  6. Per-Liga Brier inspection (no catastrophic outliers > 0.70)
  7. No-future-leakage poison-row test (m3 must inherit m2_lambda's safety)

Run: tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m3_xg.py [--tag dev-01]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.eval.metrics import (
    IDENTITY_TOLERANCE,
    PROBABILITY_TOLERANCE,
    brier_multiclass,
    log_loss,
)
from v4.modules.m3_xg import XGPredictor


ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
CROSS_ENGINE_METRICS = REPO_ROOT / "tools" / "backtest" / "cross-engine-current-metrics.json"
TARGET_TOLERANCE = 0.005           # protocol: m3 ≤ v2 + 0.005
PER_LIGA_CATASTROPHE = 0.70        # any league above this = investigation flag

# Fallback if cross-engine file is missing or corrupt — uses CLAUDE.md value
# but logs a warning so the user knows the baseline source.
FALLBACK_V2_BRIER = 0.6194
FALLBACK_SOURCE = "hard-coded (cross-engine-current-metrics.json missing/invalid)"


class SanityCheckFailed(AssertionError):
    pass


def load_v2_baseline() -> tuple[float, dict]:
    """Read v2_benter Brier from the live cross-engine metrics file.

    Returns (brier_value, metadata_dict).
    Falls back to FALLBACK_V2_BRIER + warning if the file is missing/invalid.
    """
    if not CROSS_ENGINE_METRICS.exists():
        return FALLBACK_V2_BRIER, {
            "source": FALLBACK_SOURCE,
            "warning": f"missing file at {CROSS_ENGINE_METRICS}",
        }
    try:
        with open(CROSS_ENGINE_METRICS) as f:
            data = json.load(f)
        v2 = data["engines"]["v2_benter"]
        return float(v2["brier"]), {
            "source": "tools/backtest/cross-engine-current-metrics.json",
            "window": data.get("window"),
            "n_v2_eval": int(v2["n"]),
            "generated_at": data.get("generated_at"),
        }
    except (KeyError, json.JSONDecodeError, ValueError) as e:
        return FALLBACK_V2_BRIER, {
            "source": FALLBACK_SOURCE,
            "warning": f"file parse error: {e}",
        }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stage 1 m3_xg evaluation")
    p.add_argument("--tag", default="dev-02-elo",
                   help="Artifact tag to load (default dev-02-elo — 14-feature "
                        "schema with Elo. Use 'dev-01' for the 13-feature baseline.)")
    p.add_argument("--holdout-since", default="2025-08-01",
                   help="Holdout window start (default 2025-08-01)")
    p.add_argument("--leagues", default=None,
                   help="Restrict to comma-sep leagues (default: all)")
    p.add_argument("--rho", type=float, default=None,
                   help="Override ρ used in DC score-grid (default: read from "
                        "artifacts/m3_xg-rho-{tag}.json if present, else DEFAULT_RHO)")
    p.add_argument("--use-isotonic", action="store_true",
                   help="Apply isotonic post-calibration from "
                        "artifacts/m3_xg-isotonic-{tag}.pkl if present")
    return p.parse_args()


def load_fitted_rho(tag: str) -> tuple[float, str]:
    """Read fitted ρ from artifacts/m3_xg-rho-{tag}.json if present.
    Returns (rho, source_description). Falls back to predictor's default."""
    rho_path = ARTIFACTS_DIR / f"m3_xg-rho-{tag}.json"
    if rho_path.exists():
        try:
            with open(rho_path) as f:
                data = json.load(f)
            return float(data["fitted_rho"]), f"fitted (from {rho_path.name})"
        except (KeyError, json.JSONDecodeError, ValueError) as e:
            return None, f"file parse error: {e}"
    return None, "no fitted-ρ file"


def _outcome_label(home_goals: float, away_goals: float) -> int:
    """Convert (h_goals, a_goals) → outcome class: 0=H, 1=D, 2=A."""
    if home_goals > away_goals:
        return 0
    if home_goals < away_goals:
        return 2
    return 1


def main() -> int:
    args = parse_args()
    leagues = args.leagues.split(",") if args.leagues else None
    tag = args.tag

    # Load live v2 baseline (NOT hardcoded — CLAUDE.md can drift)
    v2_baseline, baseline_meta = load_v2_baseline()
    pass_threshold = v2_baseline + TARGET_TOLERANCE

    print("=" * 70)
    print(f"V4 m3_xg — Stage 1 Evaluation · tag={tag}")
    print("=" * 70)
    print(f"  v2_benter baseline:      Brier {v2_baseline:.4f}")
    print(f"  Baseline source:         {baseline_meta['source']}")
    if "window" in baseline_meta:
        win = baseline_meta["window"]
        print(f"    window: {win['from']} → {win['to']}, n={baseline_meta.get('n_v2_eval')}")
    if "warning" in baseline_meta:
        print(f"    ⚠ WARNING: {baseline_meta['warning']}")
    print(f"  Pass threshold:          Brier ≤ {pass_threshold:.4f} (v2 + {TARGET_TOLERANCE})")
    print(f"  Per-Liga catastrophe at: Brier > {PER_LIGA_CATASTROPHE:.4f}")
    print(f"  Holdout since:           {args.holdout_since}")
    print()

    n_pass = 0
    n_fail = 0
    failures = []

    def _check(label: str, fn):
        nonlocal n_pass, n_fail
        try:
            note = fn()
            print(f"  ✓ {label:50} {note}")
            n_pass += 1
        except SanityCheckFailed as e:
            print(f"  ✗ {label:50} FAILED: {e}")
            failures.append((label, str(e)))
            n_fail += 1
        except Exception as e:
            print(f"  ✗ {label:50} CRASH: {type(e).__name__}: {e}")
            failures.append((label, f"{type(e).__name__}: {e}"))
            n_fail += 1

    # ─────────── Test 1: Load artifacts ───────────
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{tag}.pkl"

    def test_1_load():
        if not home_path.exists():
            raise SanityCheckFailed(f"missing artifact: {home_path}")
        if not away_path.exists():
            raise SanityCheckFailed(f"missing artifact: {away_path}")
        predictor = XGPredictor.from_artifacts(home_path=home_path, away_path=away_path)
        if not predictor.ensemble_home.is_fitted:
            raise SanityCheckFailed("home ensemble not fitted")
        if not predictor.ensemble_away.is_fitted:
            raise SanityCheckFailed("away ensemble not fitted")
        return (
            f"home={len(predictor.ensemble_home.models)} models, "
            f"away={len(predictor.ensemble_away.models)} models"
        )

    _check("[1] Load artifacts", test_1_load)

    # If artifacts didn't load, skip the rest
    if n_fail > 0:
        print()
        print("=" * 70)
        print("✗ Artifacts failed to load — skipping evaluation")
        print(f"  Run: tools/venv/bin/python3 -I tools/v4/train_m3_xg.py --tag {tag}")
        print("=" * 70)
        return 1

    # Resolve ρ: explicit --rho > fitted-rho file > predictor default
    from v4.modules.m3_xg import DEFAULT_RHO as DEFAULT_RHO_VAL
    if args.rho is not None:
        rho_used = float(args.rho)
        rho_source = f"explicit --rho={rho_used:.4f}"
    else:
        fitted, source = load_fitted_rho(tag)
        if fitted is not None:
            rho_used = fitted
            rho_source = source
        else:
            rho_used = DEFAULT_RHO_VAL
            rho_source = f"default ({source})"
    print(f"  ρ used in DC score-grid: {rho_used:+.4f}  [{rho_source}]")

    # Isotonic calibrator (optional)
    isotonic_path = None
    if args.use_isotonic:
        candidate = ARTIFACTS_DIR / f"m3_xg-isotonic-{tag}.pkl"
        if candidate.exists():
            isotonic_path = candidate
            print(f"  Isotonic calibration: ENABLED ({candidate.name})")
        else:
            print(f"  ⚠ --use-isotonic specified but {candidate.name} missing — skipping cal")
    else:
        print(f"  Isotonic calibration: disabled")
    print()

    predictor = XGPredictor.from_artifacts(
        home_path=home_path, away_path=away_path,
        rho=rho_used, isotonic_path=isotonic_path,
    )

    # ─────────── Load holdout ───────────
    history = load_team_xg_history(leagues=leagues)
    holdout = load_match_pairs(since=args.holdout_since, leagues=leagues)
    holdout = holdout.dropna(subset=["home_goals", "away_goals"]).reset_index(drop=True)
    print()
    print(f"  Holdout: {len(holdout):,} settled matches in {holdout['league'].nunique()} leagues")
    print()

    if len(holdout) < 30:
        print(f"  ✗ Insufficient holdout: {len(holdout)} matches")
        return 1

    # ─────────── Test 2: predict_batch runs without errors ───────────
    def test_2_predict_batch():
        # Use only history pre-cutoff to avoid look-ahead in feature building.
        # NOTE: each row in holdout has its own match_date; feature builder respects
        # that internally. But we should still trim history to be safe.
        preds = predictor.predict_batch(holdout, history)
        if len(preds) != len(holdout):
            raise SanityCheckFailed(f"pred count mismatch: {len(preds)} vs {len(holdout)}")
        if not np.all(np.isfinite(preds[["prob_h", "prob_d", "prob_a"]].values)):
            raise SanityCheckFailed("non-finite probabilities in batch output")
        # Store on a closure
        test_2_predict_batch.preds = preds  # type: ignore
        fallback_rate = preds.attrs.get("poisson_fallback_rate", float("nan"))
        return (
            f"n={len(preds):,} predictions, all finite · "
            f"DC→Poisson fallback: {fallback_rate:.1%}"
        )

    _check("[2] predict_batch finite", test_2_predict_batch)
    if n_fail > 0:
        return 1
    preds: pd.DataFrame = test_2_predict_batch.preds  # type: ignore

    # ─────────── Test 3: 1X2 sums to 1 ───────────
    def test_3_probs_sum_to_one():
        sums = preds["prob_h"] + preds["prob_d"] + preds["prob_a"]
        max_dev = float(np.max(np.abs(sums - 1.0)))
        # Use the project-wide PROBABILITY_TOLERANCE (1e-9) — single source of
        # truth imported from eval.metrics. Predictor output is explicitly
        # normalized so drift should be ~1e-15.
        if max_dev > PROBABILITY_TOLERANCE:
            bad_idx = int(np.argmax(np.abs(sums - 1.0)))
            raise SanityCheckFailed(
                f"max 1X2 sum-deviation {max_dev:.4e} at row {bad_idx} "
                f"(tol={PROBABILITY_TOLERANCE})"
            )
        return f"max sum-deviation {max_dev:.2e} (≤ {PROBABILITY_TOLERANCE})"

    _check("[3] 1X2 probabilities sum to 1", test_3_probs_sum_to_one)

    # ─────────── Test 4: σ² non-degenerate ───────────
    def test_4_variance_distribution():
        var_h = preds["lambda_h_variance"].values
        var_a = preds["lambda_a_variance"].values
        nondegenerate_h = (var_h > 0.001).mean()
        nondegenerate_a = (var_a > 0.001).mean()
        if nondegenerate_h < 0.50:
            raise SanityCheckFailed(
                f"σ²_h degenerate: only {nondegenerate_h:.0%} of matches > 0.001"
            )
        if nondegenerate_a < 0.50:
            raise SanityCheckFailed(
                f"σ²_a degenerate: only {nondegenerate_a:.0%} of matches > 0.001"
            )
        return (
            f"σ²_h: {nondegenerate_h:.0%} non-degenerate · "
            f"σ²_a: {nondegenerate_a:.0%} non-degenerate · "
            f"avg σ²_h={var_h.mean():.4f}"
        )

    _check("[4] σ² distribution non-degenerate", test_4_variance_distribution)

    # ─────────── Test 5: Brier vs v2 baseline ───────────
    def test_5_brier_baseline():
        # Build outcome labels
        outcomes = np.array([
            _outcome_label(h, a) for h, a in
            zip(holdout["home_goals"].values, holdout["away_goals"].values)
        ], dtype=int)
        # Predicted prob matrix (H, D, A in that order — matches outcome 0/1/2 encoding)
        y_pred = preds[["prob_h", "prob_d", "prob_a"]].values
        # Renormalize defensively (sum check already done in test 3)
        y_pred = y_pred / y_pred.sum(axis=1, keepdims=True)

        brier = brier_multiclass(outcomes, y_pred)
        ll = log_loss(outcomes, y_pred)

        # Stash results for Test 6
        test_5_brier_baseline.brier = brier  # type: ignore
        test_5_brier_baseline.log_loss = ll  # type: ignore
        test_5_brier_baseline.outcomes = outcomes  # type: ignore
        test_5_brier_baseline.y_pred = y_pred  # type: ignore

        if brier > pass_threshold:
            raise SanityCheckFailed(
                f"Brier {brier:.4f} > pass threshold {pass_threshold:.4f} "
                f"(v2_benter {v2_baseline:.4f} + {TARGET_TOLERANCE})"
            )
        return (
            f"Brier {brier:.4f} (target ≤ {pass_threshold:.4f}, "
            f"v2_benter={v2_baseline:.4f}, Δ={brier - v2_baseline:+.4f}) · "
            f"LogLoss {ll:.4f}"
        )

    _check(f"[5] Brier ≤ v2_benter + {TARGET_TOLERANCE}", test_5_brier_baseline)

    # ─────────── Test 6: Per-Liga audit ───────────
    def test_6_per_liga_audit():
        if not hasattr(test_5_brier_baseline, "y_pred"):
            raise SanityCheckFailed("test 5 didn't produce y_pred")
        y_pred = test_5_brier_baseline.y_pred  # type: ignore
        outcomes = test_5_brier_baseline.outcomes  # type: ignore

        rows = []
        bad_ligas = []
        for league in sorted(holdout["league"].unique()):
            mask = holdout["league"].values == league
            n = int(mask.sum())
            if n < 20:
                rows.append((league, n, float("nan"), "⚠ n<20"))
                continue
            brier_l = brier_multiclass(outcomes[mask], y_pred[mask])
            status = "🔴 BAD" if brier_l > PER_LIGA_CATASTROPHE else "✓"
            rows.append((league, n, brier_l, status))
            if brier_l > PER_LIGA_CATASTROPHE:
                bad_ligas.append((league, brier_l))

        # Print sorted by Brier asc (best first)
        sortable = [(lg, n, b, s) for lg, n, b, s in rows if not np.isnan(b)]
        sortable.sort(key=lambda r: r[2])
        print()
        print(f"  Per-Liga Brier (sorted ascending):")
        for lg, n, b, s in sortable:
            print(f"      {lg:<18}  n={n:>4}  Brier={b:.4f}  {s}")
        small = [(lg, n) for lg, n, b, _ in rows if np.isnan(b)]
        for lg, n in small:
            print(f"      {lg:<18}  n={n:>4}  (skipped, n<20)")

        if bad_ligas:
            raise SanityCheckFailed(
                f"catastrophic per-Liga Brier: {bad_ligas}"
            )
        return f"all leagues ≤ {PER_LIGA_CATASTROPHE:.2f}"

    _check("[6] Per-Liga max-Brier audit", test_6_per_liga_audit)

    # ─────────── Test 7: No-future-leakage (poison row) ───────────
    def test_7_no_future_leakage():
        """Inject a poison row dated AFTER the as-of date with extreme xG values.
        The predictor must produce identical λ/probs as without the poison.
        This verifies that m3's feature pipeline (via m2_lambda) strictly filters
        history < match_date.
        """
        # Sample one real holdout match
        sample = holdout.iloc[0]
        sample_date = sample["match_date"].to_pydatetime()

        # Baseline prediction
        baseline = predictor.predict_one(
            home_team=sample["home"],
            away_team=sample["away"],
            league=sample["league"],
            match_date=sample_date,
            history=history,
        )

        # Build poison: 50 future-dated rows with extreme xG, for both teams
        from datetime import timedelta as _td
        poison_rows = []
        for delta_days in range(1, 51):
            future_date = sample["match_date"] + _td(days=delta_days)
            poison_rows.extend([
                {
                    "team": sample["home"], "league": sample["league"],
                    "opponent": "POISON_OPP", "venue": "home",
                    "match_date": future_date,
                    "xg": 10.0, "xga": 0.0,
                    "goals_for": 10, "goals_against": 0,
                    "source": "POISON",
                },
                {
                    "team": sample["away"], "league": sample["league"],
                    "opponent": "POISON_OPP", "venue": "away",
                    "match_date": future_date,
                    "xg": 0.0, "xga": 10.0,
                    "goals_for": 0, "goals_against": 10,
                    "source": "POISON",
                },
            ])
        poisoned = pd.concat([history, pd.DataFrame(poison_rows)], ignore_index=True)
        poisoned["match_date"] = pd.to_datetime(poisoned["match_date"])

        # Poisoned prediction
        poisoned_pred = predictor.predict_one(
            home_team=sample["home"],
            away_team=sample["away"],
            league=sample["league"],
            match_date=sample_date,
            history=poisoned,
        )

        # Verify λ predictions identical.
        # Use IDENTITY_TOLERANCE (1e-9): for a leakage-free run delta should be
        # exactly 0 modulo IEEE drift. Any δ > 1e-9 indicates real contamination
        # (any sub-1e-9 difference is float64 roundoff).
        delta_h = abs(poisoned_pred["lambda_h"] - baseline["lambda_h"])
        delta_a = abs(poisoned_pred["lambda_a"] - baseline["lambda_a"])
        if delta_h > IDENTITY_TOLERANCE or delta_a > IDENTITY_TOLERANCE:
            raise SanityCheckFailed(
                f"FUTURE LEAKAGE in m3: "
                f"baseline λ=({baseline['lambda_h']:.4f}, {baseline['lambda_a']:.4f}), "
                f"poisoned λ=({poisoned_pred['lambda_h']:.4f}, {poisoned_pred['lambda_a']:.4f}), "
                f"Δ=({delta_h:.2e}, {delta_a:.2e})"
            )
        return f"baseline = poisoned (Δ_h={delta_h:.2e}, Δ_a={delta_a:.2e}) ✓"

    _check("[7] No-future-leakage (poison row)", test_7_no_future_leakage)

    # ─────────── Summary ───────────
    print()
    print("=" * 70)
    if n_fail == 0:
        print(f"✓ ALL {n_pass}/{n_pass} TESTS PASSED")
        if hasattr(test_5_brier_baseline, "brier"):
            print(f"  v4 m3_xg Brier:   {test_5_brier_baseline.brier:.4f}")  # type: ignore
            print(f"  v2_benter target: {v2_baseline:.4f}")
            delta = test_5_brier_baseline.brier - v2_baseline  # type: ignore
            print(f"  delta:            {delta:+.4f}")
            if delta < -0.003:
                print(f"  ✓ G1 ship-gate (v4 ≤ v2 - 0.003) CLEARED")
                print(f"  ⚠ NOTE: Brier improvement does NOT guarantee Stage 5 (Kelly ROI)")
                print(f"     improvement. See simulate_m7_kelly_clv.py for ROI eval.")
        print(f"  → m3_xg Stage 1 cleared.")
        print(f"  → Next: m6_market (Shin + Benter blend) or Stage 2 feature_lab iteration.")
    else:
        print(f"✗ {n_fail}/{n_pass + n_fail} TESTS FAILED")
        for label, err in failures:
            print(f"    {label}: {err}")
    print("=" * 70)
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
