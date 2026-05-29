#!/usr/bin/env python3
"""eval_blend_partners — is the Blend's gain from LINEUP INFO (dev-09) or just
ENSEMBLE VARIANCE REDUCTION (averaging any two decorrelated models)?

This decides the entire cost of wiring the Blend. The validated Blend is
dev-03 ⊕ dev-09, but dev-09 needs a fragile live-lineup pipeline (CF-blocked
Sofa, proxy burnout). If a cheap lineup-FREE partner (v2 / ensemble / v1 — all
already in production) gives ~the same blend gain over dev-03, then the gain is
variance reduction and we SKIP the lineup pipeline. If dev-03⊕dev-09 is clearly
best, the lineup info is real and the pipeline is justified.

25/26 OOT, common-intersection (matches ALL engines predict), 1X2 Brier on
RAW DC probs from a 50/50 λ-blend. dev-03+dev-09 from the corpus builder;
v2/v1/Standard from the OOT parquets.

Output: tools/v4/diagnostics/eval_blend_partners.json
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/eval_blend_partners.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np

import score_xg_forecast as X

D = REPO / "tools" / "v4" / "diagnostics"
RHO = DEFAULT_RHO = X.DEFAULT_RHO


def _brier_from_lambdas(lh, la, y):
    p = X._lambdas_to_1x2(lh, la, RHO)
    y1h = np.eye(3)[y]
    return float(((p - y1h) ** 2).sum(1).mean())


def main() -> int:
    spine = X.XGSpine()
    # engines on 25/26
    eng = {}
    eng["Standard"] = X.parquet_engine(X.BACKTEST_DIR / "ensemble-v1-oot-predictions.parquet")
    eng["v1"] = X.parquet_engine(X.BACKTEST_DIR / "v1-oot-predictions.parquet")
    eng["v2"] = X.parquet_engine(X.BACKTEST_DIR / "v2-oot-predictions.parquet")
    eng.update(X.corpus_engines(("25/26",), RHO))   # dev-03, dev-09
    for name in eng:
        eng[name] = X.attach_realized_xg(eng[name], spine)

    # common intersection by spine mid
    mid_sets = [set(pf.loc[pf["mid"] >= 0, "mid"]) for pf in eng.values()]
    inter = sorted(set.intersection(*mid_sets))
    print(f"common-intersection: {len(inter)} matches (predicted by ALL {len(eng)} engines)")

    # per-engine λ + outcome aligned by mid
    lam = {}
    y_by_mid = {}
    for name, pf in eng.items():
        sub = pf[pf["mid"].isin(inter)]
        lh = dict(zip(sub["mid"], sub["lam_h"].astype(float)))
        la = dict(zip(sub["mid"], sub["lam_a"].astype(float)))
        lam[name] = (lh, la)
        if not y_by_mid:
            for r in sub.itertuples(index=False):
                y_by_mid[r.mid] = X._outcome(r.y_h, r.y_a)
    mids = [m for m in inter if all(m in lam[n][0] for n in eng)]
    y = np.array([y_by_mid[m] for m in mids])

    def lam_arr(name):
        return (np.array([lam[name][0][m] for m in mids]),
                np.array([lam[name][1][m] for m in mids]))

    # singles
    singles = {}
    for name in eng:
        lh, la = lam_arr(name)
        singles[name] = _brier_from_lambdas(lh, la, y)

    # blends dev-03 ⊕ X (50/50 λ)
    lh3, la3 = lam_arr("dev-03")
    blends = {}
    for partner in ["dev-09", "v2", "Standard", "v1"]:
        lhp, lap = lam_arr(partner)
        blends[f"dev-03⊕{partner}"] = _brier_from_lambdas(0.5 * (lh3 + lhp), 0.5 * (la3 + lap), y)

    base = singles["dev-03"]
    print(f"\n  n={len(mids)} · dev-03 (baseline) Brier {base:.4f}\n")
    print(f"  {'single engine':<14}{'Brier':>9}      {'blend dev-03⊕X':<16}{'Brier':>9}{'Δ vs dev-03':>13}")
    order_s = sorted(singles, key=singles.get)
    order_b = sorted(blends, key=blends.get)
    for i in range(max(len(order_s), len(order_b))):
        ls = f"  {order_s[i]:<14}{singles[order_s[i]]:>9.4f}" if i < len(order_s) else "  " + " " * 23
        if i < len(order_b):
            b = order_b[i]
            lb = f"      {b:<16}{blends[b]:>9.4f}{blends[b]-base:>+13.4f}"
        else:
            lb = ""
        print(ls + lb)

    best_blend = min(blends, key=blends.get)
    dev09_blend = blends["dev-03⊕dev-09"]
    best_cheap = min((b for b in blends if b != "dev-03⊕dev-09"), key=blends.get)
    cheap_brier = blends[best_cheap]
    gap = cheap_brier - dev09_blend   # how much WORSE the best lineup-free blend is
    verdict = (
        f"dev-03⊕dev-09 Brier {dev09_blend:.4f} (Δ {dev09_blend-base:+.4f} vs dev-03). "
        f"Best lineup-FREE blend = {best_cheap} {cheap_brier:.4f} (Δ {cheap_brier-base:+.4f}). "
        f"Gap dev-09-blend vs best-cheap-blend = {gap:+.4f}. VERDICT: "
        + (f"dev-09 is NOT specially needed — {best_cheap} captures ~the same gain WITHOUT a lineup "
           f"pipeline. Wire the cheap blend, SKIP the lineup build."
           if gap > -0.0009 else
           f"dev-09 adds real signal beyond variance reduction ({-gap:.4f} better than the best "
           f"lineup-free blend) — the lineup pipeline is justified.")
    )
    print(f"\n  VERDICT: {verdict}")
    out = {"n": len(mids), "singles": singles, "blends_dev03_plus": blends,
           "dev03_baseline": base, "best_blend": best_blend, "best_cheap_blend": best_cheap,
           "gap_dev09_vs_cheap": gap, "verdict": verdict}
    (D / "eval_blend_partners.json").write_text(json.dumps(out, indent=2, default=float))
    print(f"  ✓ {(D / 'eval_blend_partners.json').relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
