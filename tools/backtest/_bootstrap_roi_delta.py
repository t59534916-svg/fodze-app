#!/usr/bin/env python3
"""Match-level bootstrap of the dev-03 Money-Eval ROI/profit-per-match delta
(CURRENT = stale isotonic on Kelly track  vs  BYPASS = engine's own probs).

The 5-Gate G5 flagged that bypassing the stale isotonic WORSENS dev-03's
(already-negative) value-bet ROI on 25/26. Edge vs Pinnacle is validated-
impossible (forecast doc §5b), so ALL arms lose — the question is whether
"keep helps ROI" is robust signal or a lucky draw on a 33%-coverage subset.

Resamples MATCHES (not bets) with replacement to preserve within-match
correlation, recomputes both arms' profit/ROI per resample, reports the
delta distribution + 95% percentile CI. If the CI crosses 0 the ROI effect
is noise → forecast-quality (Brier+ECE) is the only real axis → bypass.

Metric of record = profit-per-MATCH delta (what actually moves the bankroll;
ROI/bet is unstable because n_bets differs by arm). CURRENT − BYPASS > 0 means
keeping the stale curve reduces losses.

Input:  tools/backtest/.engine_calibrated_rows.json  (dev-03 rows w/ odds)
Output: console + tools/backtest/calibration-bypass-roi-bootstrap.json
Run:    tools/venv/bin/python3 -I tools/backtest/_bootstrap_roi_delta.py [N_BOOT seed]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
BT = REPO / "tools" / "backtest"
ROWS = BT / ".engine_calibrated_rows.json"
OUT = BT / "calibration-bypass-roi-bootstrap.json"
EDGE_MIN = 0.03  # production isValue gate

N_BOOT = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
SEED = int(sys.argv[2]) if len(sys.argv) > 2 else 12345


def _match_pnl(probs, odds, y, edge_min=EDGE_MIN):
    """Per-match (n_bets, profit) under flat-stake value-bet vs vig-removed
    Pinnacle. Returns arrays so we can aggregate over a resample."""
    n = len(y)
    nb = np.zeros(n); pf = np.zeros(n)
    for i in range(n):
        o = odds[i]
        if o is None or any(x is None or x <= 1 for x in o):
            continue
        inv = np.array([1.0 / o[0], 1.0 / o[1], 1.0 / o[2]])
        vf = inv / inv.sum()
        for k in range(3):
            if probs[i][k] - vf[k] >= edge_min:
                nb[i] += 1
                pf[i] += (o[k] - 1.0) if y[i] == k else -1.0
    return nb, pf


def bootstrap(variant_rows, label, rng):
    Y = np.array([r["y"] for r in variant_rows], int)
    cur = np.array([r["cal"] for r in variant_rows], float)
    byp = np.array([r["raw"] for r in variant_rows], float)
    odds = [r["odds"] for r in variant_rows]
    nb_c, pf_c = _match_pnl(cur, odds, Y)
    nb_b, pf_b = _match_pnl(byp, odds, Y)
    n = len(Y)

    def _roi(nb, pf, idx):
        b = nb[idx].sum()
        return (pf[idx].sum() / b * 100) if b > 0 else np.nan

    # point estimates
    roi_c0 = _roi(nb_c, pf_c, np.arange(n))
    roi_b0 = _roi(nb_b, pf_b, np.arange(n))
    ppm_c0 = pf_c.sum() / n  # profit per match
    ppm_b0 = pf_b.sum() / n

    d_roi = np.empty(N_BOOT); d_ppm = np.empty(N_BOOT)
    for b in range(N_BOOT):
        idx = rng.integers(0, n, n)
        d_roi[b] = _roi(nb_c, pf_c, idx) - _roi(nb_b, pf_b, idx)
        d_ppm[b] = pf_c[idx].mean() - pf_b[idx].mean()

    def ci(a):
        a = a[~np.isnan(a)]
        return [float(np.percentile(a, 2.5)), float(np.percentile(a, 97.5))]

    roi_ci, ppm_ci = ci(d_roi), ci(d_ppm)
    # fraction of resamples where keeping the curve helps (delta > 0)
    frac_keep_better_ppm = float((d_ppm > 0).mean())
    res = {
        "label": label, "n_matches": n,
        "n_bets_current": int(nb_c.sum()), "n_bets_bypass": int(nb_b.sum()),
        "roi_current_pct": round(float(roi_c0), 3), "roi_bypass_pct": round(float(roi_b0), 3),
        "roi_delta_pct_point": round(float(roi_c0 - roi_b0), 3),
        "roi_delta_pct_CI95": [round(x, 3) for x in roi_ci],
        "ppm_current": round(float(ppm_c0), 4), "ppm_bypass": round(float(ppm_b0), 4),
        "ppm_delta_point": round(float(ppm_c0 - ppm_b0), 4),
        "ppm_delta_CI95": [round(x, 4) for x in ppm_ci],
        "frac_resamples_keep_better_ppm": round(frac_keep_better_ppm, 3),
        "ppm_delta_significant": bool(ppm_ci[0] > 0 or ppm_ci[1] < 0),
    }
    return res


def main() -> int:
    rows = json.loads(ROWS.read_text())
    rng = np.random.default_rng(SEED)
    out = {"n_boot": N_BOOT, "seed": SEED, "edge_min_pp": EDGE_MIN * 100,
           "convention": "delta = CURRENT(isotonic) - BYPASS(raw); >0 = keeping stale curve reduces losses",
           "variants": {}}
    for variant in ["blended", "raw_dc"]:
        # Production-season decision only (25/26). The rows file may also carry
        # 24/25 cross-season rows; those are a Brier/ECE robustness check, not a
        # staking-decision input — exclude so they don't dilute the bootstrap.
        vr = [r for r in rows if r["engine"] == "dev-03" and r["variant"] == variant
              and r["odds"] is not None and r.get("season", "25/26") == "25/26"]
        if not vr:
            continue
        res = bootstrap(vr, f"dev-03:{variant}", rng)
        out["variants"][variant] = res

    OUT.write_text(json.dumps(out, indent=2))
    print("=" * 92)
    print("dev-03 Money-Eval ROI DELTA bootstrap  (CURRENT isotonic − BYPASS raw)")
    print(f"  N_boot={N_BOOT} seed={SEED} edge≥{EDGE_MIN*100:.0f}pp · >0 ⇒ stale curve reduces losses")
    print("=" * 92)
    for v, r in out["variants"].items():
        print(f"\n  dev-03:{v}  (n_matches={r['n_matches']}, bets cur={r['n_bets_current']} byp={r['n_bets_bypass']})")
        print(f"    ROI:  cur {r['roi_current_pct']:+.2f}%  byp {r['roi_bypass_pct']:+.2f}%  "
              f"Δ {r['roi_delta_pct_point']:+.2f}%  CI95 [{r['roi_delta_pct_CI95'][0]:+.2f}, {r['roi_delta_pct_CI95'][1]:+.2f}]")
        print(f"    profit/match:  cur {r['ppm_current']:+.4f}  byp {r['ppm_bypass']:+.4f}  "
              f"Δ {r['ppm_delta_point']:+.4f}  CI95 [{r['ppm_delta_CI95'][0]:+.4f}, {r['ppm_delta_CI95'][1]:+.4f}]")
        verdict = ("REAL — keeping curve robustly reduces losses" if r["ppm_delta_significant"] and r["ppm_delta_point"] > 0
                   else "REAL — bypass robustly better" if r["ppm_delta_significant"]
                   else "NOISE — CI crosses 0; ROI effect not robust")
        print(f"    → profit/match Δ {verdict}  (keep-better in {r['frac_resamples_keep_better_ppm']:.0%} of resamples)")
    print(f"\n→ wrote {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
