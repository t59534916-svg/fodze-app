#!/usr/bin/env python3
"""dev09_2h_gate — temporal-robustness final gate (2nd holdout).

Both engines retrained on 22/23+23/24 ONLY, tested on fully-OOT 24/25:
  dev-09-2h  (train_dev09 default split)
  dev-03-2h  (train_m3_xg --cutoff 2024-08-01 --features-locked)

Question: does dev-09's Brier edge (seen on the 25/26 holdout) SURVIVE when
24/25 is out of training? This is the exact temporal-generalization check that
burned dev-09 in Day-3 (a "bundesliga regression" that reversed once 24/25
entered training). A fair gate requires BOTH models at the same earlier cutoff —
production dev-03 has seen 24/25, so it cannot be the baseline here.

Output: tools/v4/diagnostics/dev09_2h_gate.json

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_2h_gate.py
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

import score_xg_forecast as X
from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09, extract_X_dev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

ART = REPO_ROOT / "tools" / "v4" / "artifacts"
OUT = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_2h_gate.json"
RHO = DEFAULT_RHO


def main() -> int:
    print("═" * 74)
    print("dev-09 2ND-HOLDOUT GATE · train 22/23+23/24 → test 24/25 (fully OOT)")
    print("═" * 74)

    d09h = BayesianEnsemble.load(ART / "m3_xg-home-dev-09-2h.pkl")
    d09a = BayesianEnsemble.load(ART / "m3_xg-away-dev-09-2h.pkl")
    d03 = XGPredictor.from_artifacts(home_path=ART / "m3_xg-home-dev-03-2h.pkl",
                                     away_path=ART / "m3_xg-away-dev-03-2h.pkl", rho=RHO)
    print("  ✓ dev-09-2h + dev-03-2h loaded (both train≤23/24)")

    fb = FeatureBuilderDev09(REPO_ROOT / "tools/sofascore/data/local_extras.db").fit()
    test = fb.build_corpus(seasons=("24/25",), leagues=None, verbose=False)
    test["ch"] = test.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    test["ca"] = test.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    cdate = pd.to_datetime(test["match_date"]).dt.normalize().dt.date
    league = test["league"].astype(str).to_numpy()
    y = np.array([X._outcome(h, a) for h, a in zip(test["home_goals"], test["away_goals"])], dtype=int)
    y1h = np.eye(3)[y]
    print(f"  ✓ 24/25 corpus {len(test):,} matches")

    # dev-09-2h
    Xd = extract_X_dev09(test)
    mh, _ = d09h.predict(Xd[d09h.feature_names]); ma, _ = d09a.predict(Xd[d09a.feature_names])
    lam_h_09 = np.clip(mh, X.LAMBDA_MIN, X.LAMBDA_MAX); lam_a_09 = np.clip(ma, X.LAMBDA_MIN, X.LAMBDA_MAX)
    p09 = X._lambdas_to_1x2(lam_h_09, lam_a_09, RHO)

    # dev-03-2h
    history = load_team_xg_history()
    d03_in = pd.DataFrame({"league": test["league"].astype(str),
                           "match_date": pd.to_datetime(test["match_date"]).dt.normalize(),
                           "home": test["ch"], "away": test["ca"],
                           "home_goals": test["home_goals"], "away_goals": test["away_goals"]})
    dp = d03.predict_batch(d03_in, history, verbose=False)
    p03 = np.column_stack([dp["prob_h"], dp["prob_d"], dp["prob_a"]])
    lam_h_03 = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    lam_a_03 = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)

    b09 = ((p09 - y1h) ** 2).sum(1); b03 = ((p03 - y1h) ** 2).sum(1)

    # realized xG
    spine = X.XGSpine(since="2024-07-01")
    rh = np.full(len(test), np.nan); ra = np.full(len(test), np.nan)
    for i in range(len(test)):
        res = spine.resolve(league[i], test["ch"].iloc[i], test["ca"].iloc[i], cdate.iloc[i])
        if res:
            rh[i], ra[i] = res[1], res[2]
    has = ~np.isnan(rh) & ~np.isnan(ra)
    print(f"  ✓ realized-xG join {100*has.mean():.1f}% ({has.sum():,})\n")

    # Brier paired
    bd = float(b09.mean() - b03.mean())
    bse = float((b09 - b03).std(ddof=1) / np.sqrt(len(y)))
    # xG-RMSE paired (stacked, matched)
    pr09 = np.concatenate([lam_h_09[has], lam_a_09[has]]); pr03 = np.concatenate([lam_h_03[has], lam_a_03[has]])
    rl = np.concatenate([rh[has], ra[has]])
    rmse09 = float(np.sqrt(np.mean((pr09 - rl) ** 2))); rmse03 = float(np.sqrt(np.mean((pr03 - rl) ** 2)))
    se09, se03 = (pr09 - rl) ** 2, (pr03 - rl) ** 2
    rng = np.random.default_rng(42); idx = np.arange(len(se09)); boot = []
    for _ in range(3000):
        s = rng.choice(idx, len(idx), True); boot.append(np.sqrt(se09[s].mean()) - np.sqrt(se03[s].mean()))
    rmse_ci = [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))]
    rmse_d = rmse09 - rmse03

    print("─" * 74)
    print(f"  {'engine':<12} {'xG-RMSE':>8} {'Brier':>8}")
    print(f"  {'dev-03-2h':<12} {rmse03:>8.4f} {b03.mean():>8.4f}")
    print(f"  {'dev-09-2h':<12} {rmse09:>8.4f} {b09.mean():>8.4f}")
    print("─" * 74)
    print(f"  Brier   Δ (09−03): {bd:+.5f}  ±{1.96*bse:.5f}  "
          f"→ {'dev-09 sig better' if bd+1.96*bse<0 else ('dev-09 better' if bd<0 else 'dev-03 better')}")
    print(f"  xG-RMSE Δ (09−03): {rmse_d:+.4f}  95%CI [{rmse_ci[0]:+.4f},{rmse_ci[1]:+.4f}]  "
          f"→ {'TIE' if rmse_ci[0]<0<rmse_ci[1] else ('dev-09 better' if rmse_d<0 else 'dev-03 better')}")
    print()

    # per-league Brier
    per = []
    for lg in sorted(set(league)):
        m = league == lg
        if m.sum() < 15:
            continue
        per.append({"league": lg, "n": int(m.sum()),
                    "brier_dev03": float(b03[m].mean()), "brier_dev09": float(b09[m].mean()),
                    "brier_delta": float(b09[m].mean() - b03[m].mean())})
    regress = [p for p in per if p["brier_delta"] > 0.01]
    print(f"  per-league Brier: dev-09 worse by >0.01 in {len(regress)}/{len(per)} leagues"
          + (": " + ", ".join(f"{p['league']}(+{p['brier_delta']:.3f})" for p in regress) if regress else ""))

    holds = bd < 0  # dev-09 Brier better on the 2nd holdout too
    verdict = ("GREEN: edge HOLDS temporally (dev-09 Brier better on 24/25 OOT too)"
               if (bd + 1.96 * bse < 0)
               else ("AMBER: dev-09 better but not significant on 24/25"
                     if bd < 0 else "RED: edge does NOT hold on 24/25 — temporal fluke"))
    out = {"gate": "2nd-holdout-temporal", "train": "22/23+23/24", "test": "24/25",
           "n_corpus": int(len(test)), "n_xg_matched": int(has.sum()),
           "brier_dev03": float(b03.mean()), "brier_dev09": float(b09.mean()),
           "brier_delta": bd, "brier_delta_95": 1.96 * bse,
           "xg_rmse_dev03": rmse03, "xg_rmse_dev09": rmse09, "xg_rmse_delta": rmse_d, "xg_rmse_ci95": rmse_ci,
           "per_league": per, "n_brier_regress": len(regress), "verdict": verdict}
    OUT.write_text(json.dumps(out, indent=2))
    print("\n" + "═" * 74)
    print(f"2ND-HOLDOUT VERDICT: {verdict}")
    print(f"  ✓ {OUT.relative_to(REPO_ROOT)}")
    print("═" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
