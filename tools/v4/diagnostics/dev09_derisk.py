#!/usr/bin/env python3
"""dev09_derisk — three checks before any dev-09 resurrection engineering.

The forecast leaderboard put dev-09 ahead of dev-03 (tied xG-RMSE, Brier
-0.0076 significant). Before investing in a TS port + calibration layer, the
user chose to DE-RISK first. Three checks, all reusing existing artifacts:

  (a) MULTI-SEED — does the Brier edge hold across all 5 dev-09 seeds
      (phase42 seed-000/100/200/300/400), or is it a seed-000 fluke?
      → paired Brier-Δ (dev-09-seed − dev-03) per seed, on the 25/26 holdout.

  (b) CALIBRATED — the leaderboard scored RAW probs, but dev-03 runs with
      isotonic in production while dev-09 has none. Fair check: CV-isotonic
      calibrate BOTH (5-fold, no leakage) and re-compare Brier. Does dev-03's
      calibration close the gap?

  (c) PER-LEAGUE — does dev-09 (5-seed mean) regress catastrophically in any
      league (the audit flagged a bundesliga concern, later reversed)?

Output: tools/v4/diagnostics/dev09_derisk.json

Run:
  tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_derisk.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import KFold

import score_xg_forecast as X  # XGSpine, attach_realized_xg, _outcome, _lambdas_to_1x2, helpers
from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09, extract_X_dev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts"
OUT = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_derisk.json"
SEEDS = ["000", "100", "200", "300", "400"]
RHO = DEFAULT_RHO


def cv_isotonic_brier(probs: np.ndarray, y: np.ndarray, *, n_splits: int = 5, seed: int = 42) -> float:
    """Multiclass Brier after 5-fold CV-isotonic calibration (no leakage).

    Per fold: fit one IsotonicRegression per class on train (p_class → 1{y==class}),
    transform test, renormalize rows, accumulate. Brier over the full out-of-fold set.
    """
    n = len(y)
    cal = np.zeros_like(probs)
    kf = KFold(n_splits=n_splits, shuffle=True, random_state=seed)
    for tr, te in kf.split(probs):
        for k in range(3):
            iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            iso.fit(probs[tr, k], (y[tr] == k).astype(float))
            cal[te, k] = iso.transform(probs[te, k])
    # renormalize (isotonic per-class breaks the sum-to-1)
    s = cal.sum(axis=1, keepdims=True)
    s[s == 0] = 1.0
    cal = cal / s
    y1h = np.eye(3)[y]
    return float(((cal - y1h) ** 2).sum(axis=1).mean())


def main() -> int:
    print("═" * 76)
    print("dev-09 DE-RISK · multi-seed + calibrated + per-league (vs dev-03, 25/26)")
    print("═" * 76)

    # ─── Load dev-03 + all dev-09 seeds ───
    d03 = XGPredictor.from_artifacts(
        home_path=ARTIFACTS / "m3_xg-home-dev-03.pkl",
        away_path=ARTIFACTS / "m3_xg-away-dev-03.pkl", rho=RHO)
    seed_ens = {}
    for s in SEEDS:
        h = ARTIFACTS / f"m3_xg-home-dev-09-phase42-seed-{s}.pkl"
        a = ARTIFACTS / f"m3_xg-away-dev-09-phase42-seed-{s}.pkl"
        seed_ens[s] = (BayesianEnsemble.load(h), BayesianEnsemble.load(a))
    print(f"  ✓ dev-03 + {len(seed_ens)} dev-09 seeds loaded")

    # ─── Build corpus once ───
    fb = FeatureBuilderDev09(REPO_ROOT / "tools/sofascore/data/local_extras.db").fit()
    test = fb.build_corpus(seasons=("25/26",), leagues=None, verbose=False)
    test["ch"] = test.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    test["ca"] = test.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    cdate = pd.to_datetime(test["match_date"]).dt.normalize().dt.date
    league = test["league"].astype(str).to_numpy()
    y = np.array([X._outcome(h, a) for h, a in zip(test["home_goals"], test["away_goals"])], dtype=int)
    y1h = np.eye(3)[y]
    print(f"  ✓ corpus {len(test):,} matches")

    Xd09 = extract_X_dev09(test)

    # ─── dev-03 predictions ───
    history = load_team_xg_history()
    d03_in = pd.DataFrame({
        "league": test["league"].astype(str), "match_date": pd.to_datetime(test["match_date"]).dt.normalize(),
        "home": test["ch"], "away": test["ca"], "home_goals": test["home_goals"], "away_goals": test["away_goals"],
    })
    dp = d03.predict_batch(d03_in, history, verbose=False)
    p03 = np.column_stack([dp["prob_h"], dp["prob_d"], dp["prob_a"]])
    lam_h_03 = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    lam_a_03 = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    brier03_pm = ((p03 - y1h) ** 2).sum(axis=1)

    # ─── dev-09 per-seed predictions ───
    seed_probs, seed_lam_h, seed_lam_a = {}, {}, {}
    for s, (eh, ea) in seed_ens.items():
        mh, _ = eh.predict(Xd09[eh.feature_names])
        ma, _ = ea.predict(Xd09[ea.feature_names])
        lh = np.clip(mh, X.LAMBDA_MIN, X.LAMBDA_MAX)
        la = np.clip(ma, X.LAMBDA_MIN, X.LAMBDA_MAX)
        seed_probs[s] = X._lambdas_to_1x2(lh, la, RHO)
        seed_lam_h[s], seed_lam_a[s] = lh, la

    # ── (a) multi-seed paired Brier-Δ vs dev-03 ──
    print("\n" + "─" * 76)
    print("(a) MULTI-SEED — paired Brier-Δ (dev-09-seed − dev-03), full corpus")
    print("─" * 76)
    seed_rows = []
    for s in SEEDS:
        b09_pm = ((seed_probs[s] - y1h) ** 2).sum(axis=1)
        delta = float(b09_pm.mean() - brier03_pm.mean())
        se = float((b09_pm - brier03_pm).std(ddof=1) / np.sqrt(len(y)))
        seed_rows.append({"seed": s, "brier_dev09": float(b09_pm.mean()),
                          "delta_vs_dev03": delta, "se": se, "sig_neg": bool(delta + 1.96 * se < 0)})
        print(f"  seed-{s}: dev-09 Brier {b09_pm.mean():.4f}  Δ {delta:+.5f}  ±{1.96*se:.5f}  "
              f"{'✓ sig better' if delta+1.96*se<0 else ('better' if delta<0 else 'WORSE')}")
    deltas = [r["delta_vs_dev03"] for r in seed_rows]
    all_neg = all(d < 0 for d in deltas)
    all_sig = all(r["sig_neg"] for r in seed_rows)
    print(f"  dev-03 Brier: {brier03_pm.mean():.4f}")
    print(f"  → all 5 seeds better: {all_neg} · all 5 significant: {all_sig} · "
          f"mean Δ {np.mean(deltas):+.5f} (range [{min(deltas):+.5f}, {max(deltas):+.5f}])")

    # 5-seed mean ensemble (for b + c)
    p09_mean = np.mean([seed_probs[s] for s in SEEDS], axis=0)
    lam_h_09 = np.mean([seed_lam_h[s] for s in SEEDS], axis=0)
    lam_a_09 = np.mean([seed_lam_a[s] for s in SEEDS], axis=0)
    brier09_mean_pm = ((p09_mean - y1h) ** 2).sum(axis=1)

    # ── (b) calibrated (CV-isotonic on BOTH) ──
    print("\n" + "─" * 76)
    print("(b) CALIBRATED — CV-isotonic (5-fold) on BOTH, raw vs calibrated Brier")
    print("─" * 76)
    raw03, raw09 = float(brier03_pm.mean()), float(brier09_mean_pm.mean())
    cal03 = cv_isotonic_brier(p03, y)
    cal09 = cv_isotonic_brier(p09_mean, y)
    print(f"  dev-03  raw {raw03:.4f}  →  calibrated {cal03:.4f}  (Δcal {cal03-raw03:+.4f})")
    print(f"  dev-09  raw {raw09:.4f}  →  calibrated {cal09:.4f}  (Δcal {cal09-raw09:+.4f})")
    print(f"  calibrated gap (dev-09 − dev-03): {cal09-cal03:+.5f}  "
          f"({'dev-09 still better' if cal09<cal03 else 'dev-03 catches up / wins'})")

    # ── (c) per-league (5-seed mean dev-09 vs dev-03) ──
    print("\n" + "─" * 76)
    print("(c) PER-LEAGUE — dev-09(5-seed mean) vs dev-03 · xG-RMSE + Brier")
    print("─" * 76)
    spine = X.XGSpine()
    real_h = np.full(len(test), np.nan); real_a = np.full(len(test), np.nan)
    for i in range(len(test)):
        res = spine.resolve(league[i], test["ch"].iloc[i], test["ca"].iloc[i], cdate.iloc[i])
        if res:
            real_h[i], real_a[i] = res[1], res[2]
    has = ~np.isnan(real_h) & ~np.isnan(real_a)

    print(f"  {'league':<16} {'n':>4} {'RMSE03':>7} {'RMSE09':>7} {'Δ':>7} {'Bri03':>7} {'Bri09':>7} {'Δ':>8}")
    per_league = []
    for lg in sorted(set(league)):
        m = (league == lg) & has
        mb = (league == lg)
        if m.sum() < 15:
            continue
        rmse03 = float(np.sqrt(np.mean((np.concatenate([lam_h_03[m], lam_a_03[m]]) -
                                        np.concatenate([real_h[m], real_a[m]])) ** 2)))
        rmse09 = float(np.sqrt(np.mean((np.concatenate([lam_h_09[m], lam_a_09[m]]) -
                                        np.concatenate([real_h[m], real_a[m]])) ** 2)))
        b03 = float(brier03_pm[mb].mean()); b09 = float(brier09_mean_pm[mb].mean())
        per_league.append({"league": lg, "n": int(m.sum()), "rmse_dev03": rmse03, "rmse_dev09": rmse09,
                           "rmse_delta": rmse09 - rmse03, "brier_dev03": b03, "brier_dev09": b09,
                           "brier_delta": b09 - b03})
        flag = "  ⚠" if (b09 - b03) > 0.01 else ""
        print(f"  {lg:<16} {int(m.sum()):>4} {rmse03:>7.4f} {rmse09:>7.4f} {rmse09-rmse03:>+7.4f} "
              f"{b03:>7.4f} {b09:>7.4f} {b09-b03:>+8.4f}{flag}")
    n_brier_regress = sum(1 for h in per_league if h["brier_delta"] > 0.01)
    print(f"  → leagues where dev-09 Brier worse by >0.01: {n_brier_regress}/{len(per_league)}")

    out = {
        "test_seasons": ["25/26"], "n_corpus": int(len(test)),
        "a_multiseed": {"dev03_brier": float(brier03_pm.mean()), "per_seed": seed_rows,
                        "all_seeds_better": all_neg, "all_seeds_significant": all_sig,
                        "mean_delta": float(np.mean(deltas)), "delta_range": [float(min(deltas)), float(max(deltas))]},
        "b_calibrated": {"dev03_raw": raw03, "dev03_cal": cal03, "dev09_raw": raw09, "dev09_cal": cal09,
                         "calibrated_gap_dev09_minus_dev03": float(cal09 - cal03),
                         "dev09_still_better_calibrated": bool(cal09 < cal03)},
        "c_per_league": {"rows": per_league, "n_brier_regress_gt_0p01": n_brier_regress, "n_leagues": len(per_league)},
        "_caveats": ["Single 25/26 OOT holdout.", "dev-09 has no production calibration layer yet (b approximates it via CV-isotonic).",
                     "ROI tiebreaker is separate (score_roi_leaderboard.py) — tie at ≈0."],
    }
    OUT.write_text(json.dumps(out, indent=2))
    print("\n" + "═" * 76)
    verdict = ("GREEN: dev-09 edge robust (all seeds + calibrated + no league regression)"
               if (all_neg and cal09 < cal03 and n_brier_regress == 0)
               else "MIXED: review per-check results")
    print(f"DE-RISK VERDICT: {verdict}")
    print(f"  ✓ {OUT.relative_to(REPO_ROOT)}")
    print("═" * 76)
    return 0


if __name__ == "__main__":
    sys.exit(main())
