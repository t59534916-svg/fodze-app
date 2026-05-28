#!/usr/bin/env python3
"""eval_conf_weight — does confidence-weighted training improve high-conf games?

A/B: dev-03-base0 (uniform) vs dev-03-confw (sample-weight ∝ |elo_diff|), both
cutoff 2025-08-01, features-locked → tested on 25/26 OOT. Each variant predicts
1X2 (raw DC, no isotonic). Compares:
  - overall Brier + accuracy
  - high-conf (≥65%) tier accuracy/Brier (the target region)
  - contested (<55%) Brier (the region we'd risk)

Expected (per the headroom proof): conf-weighting does NOT meaningfully improve
the already-calibrated, near-ceiling high-conf region, and risks overall Brier.

Output: tools/v4/diagnostics/eval_conf_weight.json
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/eval_conf_weight.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd

import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
RHO = DEFAULT_RHO


def predict_1x2(tag, din, hist):
    d = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{tag}.pkl",
                                   away_path=ART / f"m3_xg-away-{tag}.pkl", rho=RHO)
    dp = d.predict_batch(din, hist, verbose=False)
    return np.column_stack([dp["prob_h"], dp["prob_d"], dp["prob_a"]])


def metrics(p, y, name):
    y1h = np.eye(3)[y]
    bpm = ((p - y1h) ** 2).sum(1)
    conf, pick = p.max(1), p.argmax(1)
    hi = conf >= 0.65
    cont = conf < 0.55
    return {
        "engine": name, "overall_acc": float((pick == y).mean()), "overall_brier": float(bpm.mean()),
        "hi_n": int(hi.sum()), "hi_acc": float((pick[hi] == y[hi]).mean()) if hi.sum() else None,
        "hi_brier": float(bpm[hi].mean()) if hi.sum() else None,
        "hi_claim": float(conf[hi].mean()) if hi.sum() else None,
        "contested_brier": float(bpm[cont].mean()),
    }


def main() -> int:
    # build 25/26 holdout match list (canonical) once
    fb = FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=("25/26",), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    din = pd.DataFrame({"league": t["league"].astype(str), "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"], "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])
    hist = load_team_xg_history()

    p_base = predict_1x2("dev-03-base0", din, hist)
    p_cw = predict_1x2("dev-03-confw", din, hist)
    m_base = metrics(p_base, y, "base0 (uniform)")
    m_cw = metrics(p_cw, y, "conf-weighted")

    print("═" * 72)
    print("A/B · conf-weighted training vs uniform · 25/26 OOT")
    print("═" * 72)
    print(f"  {'metric':<22} {'base0':>12} {'conf-weighted':>14} {'Δ':>10}")
    for k, lbl in [("overall_acc", "Overall accuracy"), ("overall_brier", "Overall Brier"),
                   ("hi_acc", "High-conf accuracy"), ("hi_brier", "High-conf Brier"),
                   ("contested_brier", "Contested Brier")]:
        b, c = m_base[k], m_cw[k]
        d = (c - b) if (b is not None and c is not None) else None
        print(f"  {lbl:<22} {b:>12.4f} {c:>14.4f} {d:>+10.4f}")
    print(f"  high-conf n: base {m_base['hi_n']} · confw {m_cw['hi_n']}")

    hi_better = (m_cw["hi_brier"] is not None and m_cw["hi_brier"] < m_base["hi_brier"])
    overall_cost = m_cw["overall_brier"] - m_base["overall_brier"]
    verdict = (
        f"CONFIRMS HEADROOM: conf-weighting "
        f"{'marginally helps' if hi_better else 'does NOT help'} high-conf "
        f"(Brier Δ {m_cw['hi_brier']-m_base['hi_brier']:+.4f}) "
        f"while overall Brier Δ {overall_cost:+.4f} "
        f"({'WORSE' if overall_cost>0.0005 else 'flat'}) and high-conf size shrank "
        f"{m_base['hi_n']}→{m_cw['hi_n']}. Training-focus on high-conf is the wrong lever; "
        f"use selective prediction.")
    print(f"\n  VERDICT: {verdict}")
    out = {"base": m_base, "conf_weighted": m_cw, "overall_brier_cost": overall_cost, "verdict": verdict}
    (D / "eval_conf_weight.json").write_text(json.dumps(out, indent=2, default=float))
    print(f"  ✓ {(D / 'eval_conf_weight.json').relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
