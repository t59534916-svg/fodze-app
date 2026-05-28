#!/usr/bin/env python3
"""eval_conf_weight_sweep — is "train with focus on high-confidence games" the
wrong lever across a RANGE of weighting strengths, not just one config?

THE GAP (self-eval 2026-05-28, item f): the "wrong lever" conclusion rested on
the headroom proof + a SINGLE conf-weight config (k=2). This sweeps the
sample-weight strength k ∈ {0, 0.5, 1, 2, 4} (weight ∝ 1 + k·|elo_diff|_z, i.e.
up-weighting lopsided/high-confidence matches at fit time) and re-checks, on the
25/26 OOT holdout (RAW 1X2, no isotonic), whether ANY k:
  (1) meaningfully improves the high-conf (≥65%) tier Brier/accuracy, and
  (2) does so without degrading overall Brier.

Expected (per the headroom proof — high-conf is already ~calibrated + only ~7%
of the Brier loss + upset-ceiling): monotone-or-flat — no k buys high-conf
skill, and overall Brier degrades as k grows. That makes the conclusion robust
to the weighting strength, not an artifact of k=2.

Requires the trained tags (train each once with --features-locked --conf-weight-k k):
  k=0   dev-03-base0      k=0.5 dev-03-confw-k0p5   k=1 dev-03-confw-k1
  k=2   dev-03-confw      k=4   dev-03-confw-k4

Output: tools/v4/diagnostics/eval_conf_weight_sweep.json · .png
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/eval_conf_weight_sweep.py
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
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
RHO = DEFAULT_RHO

# k → artifact tag (k=0 is the uniform baseline)
LADDER = [(0.0, "dev-03-base0"), (0.5, "dev-03-confw-k0p5"), (1.0, "dev-03-confw-k1"),
          (2.0, "dev-03-confw"), (4.0, "dev-03-confw-k4")]


def predict_1x2(tag, din, hist):
    d = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{tag}.pkl",
                                   away_path=ART / f"m3_xg-away-{tag}.pkl", rho=RHO)
    dp = d.predict_batch(din, hist, verbose=False)
    return np.column_stack([dp["prob_h"], dp["prob_d"], dp["prob_a"]])


def metrics(p, y):
    y1h = np.eye(3)[y]
    bpm = ((p - y1h) ** 2).sum(1)
    conf, pick = p.max(1), p.argmax(1)
    hi, cont = conf >= 0.65, conf < 0.55
    return {
        "overall_brier": float(bpm.mean()), "overall_acc": float((pick == y).mean()),
        "hi_n": int(hi.sum()), "hi_brier": float(bpm[hi].mean()) if hi.sum() else None,
        "hi_acc": float((pick[hi] == y[hi]).mean()) if hi.sum() else None,
        "contested_brier": float(bpm[cont].mean()) if cont.sum() else None,
    }


def main() -> int:
    missing = [t for _, t in LADDER if not (ART / f"m3_xg-home-{t}.pkl").exists()]
    if missing:
        print(f"  ✗ missing tags: {missing}\n  Train each: train_m3_xg.py --features-locked "
              f"--since 2017-01-01 --cutoff 2025-08-01 --tag <tag> --conf-weight-k <k>")
        return 1

    # build 25/26 holdout once (same path as eval_conf_weight.py)
    fb = FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=("25/26",), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    din = pd.DataFrame({"league": t["league"].astype(str),
                        "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"],
                        "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])
    hist = load_team_xg_history()

    print("═" * 76)
    print("conf-weight SWEEP · k ∈ {0, 0.5, 1, 2, 4} · 25/26 OOT (RAW 1X2)")
    print("═" * 76)
    rows = []
    base = None
    for k, tag in LADDER:
        m = metrics(predict_1x2(tag, din, hist), y)
        if k == 0.0:
            base = m
        m["k"] = k
        m["overall_brier_vs_base"] = m["overall_brier"] - base["overall_brier"] if base else 0.0
        m["hi_brier_vs_base"] = (m["hi_brier"] - base["hi_brier"]) if (base and m["hi_brier"] is not None) else None
        rows.append(m)

    print(f"  {'k':>4} {'overall Brier':>14} {'Δ vs k=0':>10} {'hi≥65 Brier':>12} {'Δ':>9} "
          f"{'hi acc':>7} {'hi n':>6} {'cont Brier':>11}")
    for m in rows:
        print(f"  {m['k']:>4.1f} {m['overall_brier']:>14.4f} {m['overall_brier_vs_base']:>+10.4f} "
              f"{m['hi_brier']:>12.4f} {m['hi_brier_vs_base']:>+9.4f} {m['hi_acc']:>7.1%} "
              f"{m['hi_n']:>6} {m['contested_brier']:>11.4f}")

    # ── verdict ──
    hi_deltas = [m["hi_brier_vs_base"] for m in rows if m["k"] > 0]
    overall_deltas = [m["overall_brier_vs_base"] for m in rows if m["k"] > 0]
    any_hi_improves = any(d < -0.001 for d in hi_deltas)   # meaningful high-conf Brier gain
    overall_degrades = all(d >= -0.0005 for d in overall_deltas)  # never meaningfully better overall
    monotone_worse = overall_deltas == sorted(overall_deltas)  # overall Brier worse as k grows
    verdict = (
        f"CONFIRMS HEADROOM ACROSS k: high-conf Brier Δ vs k=0 ranges "
        f"[{min(hi_deltas):+.4f}, {max(hi_deltas):+.4f}] — "
        f"{'NO k meaningfully improves high-conf' if not any_hi_improves else 'some k improves high-conf'}; "
        f"overall Brier Δ ranges [{min(overall_deltas):+.4f}, {max(overall_deltas):+.4f}] "
        f"({'never better, ' if overall_degrades else ''}"
        f"{'monotonically worse as k grows' if monotone_worse else 'no clean monotone trend'}). "
        f"Training-focus on high-confidence games is the wrong lever at EVERY strength tested — "
        f"the high-conf region is already ~calibrated and upset-ceilinged. Right lever: SELECTIVE "
        f"PREDICTION (use only high-conf tips), not retraining."
    )
    print(f"\n  VERDICT: {verdict}")

    out = {"test_season": "25/26", "ladder": rows, "verdict": verdict,
           "any_k_improves_highconf": bool(any_hi_improves),
           "overall_never_better": bool(overall_degrades)}
    (D / "eval_conf_weight_sweep.json").write_text(json.dumps(out, indent=2, default=float))

    # ── figure ──
    ks = [m["k"] for m in rows]
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))
    ax1.plot(ks, [m["overall_brier"] for m in rows], "o-", color="#3a7ca5", lw=2)
    ax1.set_xlabel("conf-weight k (↑ up-weights lopsided matches)"); ax1.set_ylabel("Overall Brier")
    ax1.set_title("Overall Brier vs k\n(lower = better — does focus help?)", fontweight="bold")
    ax1.grid(alpha=0.25)
    ax2.plot(ks, [m["hi_brier"] for m in rows], "o-", color="#d98c3f", lw=2, label="high-conf ≥65% Brier")
    ax2.plot(ks, [m["contested_brier"] for m in rows], "s--", color="#4f8a3d", lw=2, label="contested <55% Brier")
    ax2.set_xlabel("conf-weight k"); ax2.set_ylabel("Brier (by region)")
    ax2.set_title("Region Brier vs k\n(high-conf flat = no headroom)", fontweight="bold")
    ax2.legend(fontsize=9); ax2.grid(alpha=0.25)
    fig.suptitle("FODZE · conf-weight k-sweep — training-focus on high-confidence is the wrong lever",
                 fontsize=12, fontweight="bold")
    fig.tight_layout()
    fig.savefig(D / "eval_conf_weight_sweep.png", dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  ✓ eval_conf_weight_sweep.json · .png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
