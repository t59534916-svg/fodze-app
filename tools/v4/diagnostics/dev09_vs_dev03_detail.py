#!/usr/bin/env python3
"""dev09_vs_dev03_detail — WHY/WHERE they differ + hybrid feasibility (25/26).

The build decision (hybrid vs dev-09 vs dev-03) hinges on whether the two
models' strengths are COMBINABLE. Core mechanism under test:
  - xG-RMSE rewards accurate λ-MAGNITUDE (total goals).
  - Brier rewards accurate λ-RATIO (home/away split → who wins).
dev-03 owns xG-RMSE → likely better total. dev-09 owns Brier → likely better
split. If so, a hybrid (dev-03 total × dev-09 split) could win BOTH axes.

Analyses (25/26 holdout, dev-03 prod + dev-09 phase42 seed-000, realized xG):
  1. Magnitude vs ratio decomposition (which model owns which).
  2. SMART HYBRID: λ = total_03 × [ratio_09, 1-ratio_09] → does it Pareto-dominate?
  3. α convex λ-blend sweep (the trade-off frontier).
  4. Probability log-pool sweep (β) for Brier.
  5. Per-match error complementarity (does a blend even have headroom?).
  6. Edge by total-xG tercile + favorite-strength tercile (where the edge lives).

Output: tools/v4/diagnostics/dev09_vs_dev03_detail.json
Run:    tools/venv/bin/python3 -I tools/v4/diagnostics/dev09_vs_dev03_detail.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np

import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO

OUT = REPO_ROOT / "tools" / "v4" / "diagnostics" / "dev09_vs_dev03_detail.json"
RHO = DEFAULT_RHO


def _brier(p, y1h):
    return ((p - y1h) ** 2).sum(axis=1)


def _rmse(pred_stack, real_stack):
    return float(np.sqrt(np.mean((pred_stack - real_stack) ** 2)))


def main() -> int:
    print("═" * 76)
    print("DETAILANALYSE dev-09 vs dev-03 · 25/26 · WHY/WHERE + hybrid feasibility")
    print("═" * 76)

    eng = X.corpus_engines(("25/26",), RHO)
    spine = X.XGSpine()
    d09 = X.attach_realized_xg(eng["dev-09"], spine)
    d03 = X.attach_realized_xg(eng["dev-03"], spine)
    m = (d09["mid"] >= 0).to_numpy()  # same matches both (shared corpus)

    lh09, la09 = d09["lam_h"].to_numpy(float)[m], d09["lam_a"].to_numpy(float)[m]
    lh03, la03 = d03["lam_h"].to_numpy(float)[m], d03["lam_a"].to_numpy(float)[m]
    rh, ra = d09["real_h"].to_numpy(float)[m], d09["real_a"].to_numpy(float)[m]
    p09 = d09[["p_h", "p_d", "p_a"]].to_numpy(float)[m]
    p03 = d03[["p_h", "p_d", "p_a"]].to_numpy(float)[m]
    yh, ya = d09["y_h"].to_numpy()[m], d09["y_a"].to_numpy()[m]
    y = np.array([X._outcome(h, a) for h, a in zip(yh, ya)], dtype=int)
    y1h = np.eye(3)[y]
    league = d09["league"].to_numpy()[m]
    n = m.sum()
    print(f"  matched n={n:,}\n")

    real_stack = np.concatenate([rh, ra])
    rmse03 = _rmse(np.concatenate([lh03, la03]), real_stack)
    rmse09 = _rmse(np.concatenate([lh09, la09]), real_stack)
    b03, b09 = _brier(p03, y1h), _brier(p09, y1h)
    print(f"  baseline: dev-03 xG-RMSE {rmse03:.4f} Brier {b03.mean():.4f} | "
          f"dev-09 xG-RMSE {rmse09:.4f} Brier {b09.mean():.4f}")

    # ── 1. magnitude vs ratio ──
    tot_r, tot03, tot09 = rh + ra, lh03 + la03, lh09 + la09
    rat_r = np.divide(rh, tot_r, out=np.full_like(rh, 0.5), where=tot_r > 0)
    rat03 = np.divide(lh03, tot03, out=np.full_like(lh03, 0.5), where=tot03 > 0)
    rat09 = np.divide(lh09, tot09, out=np.full_like(lh09, 0.5), where=tot09 > 0)
    tot_rmse03 = float(np.sqrt(np.mean((tot03 - tot_r) ** 2)))
    tot_rmse09 = float(np.sqrt(np.mean((tot09 - tot_r) ** 2)))
    rat_mae03 = float(np.mean(np.abs(rat03 - rat_r)))
    rat_mae09 = float(np.mean(np.abs(rat09 - rat_r)))
    print("\n" + "─" * 76)
    print("1. MAGNITUDE vs RATIO (the mechanism)")
    print("─" * 76)
    print(f"  total-xG RMSE:   dev-03 {tot_rmse03:.4f}  dev-09 {tot_rmse09:.4f}  "
          f"→ {'dev-03 owns magnitude' if tot_rmse03 < tot_rmse09 else 'dev-09'}")
    print(f"  home-ratio MAE:  dev-03 {rat_mae03:.4f}  dev-09 {rat_mae09:.4f}  "
          f"→ {'dev-09 owns split' if rat_mae09 < rat_mae03 else 'dev-03'}")

    # ── 2. SMART HYBRID: dev-03 total × dev-09 ratio ──
    lh_hyb = tot03 * rat09
    la_hyb = tot03 * (1.0 - rat09)
    rmse_hyb = _rmse(np.concatenate([lh_hyb, la_hyb]), real_stack)
    p_hyb = X._lambdas_to_1x2(np.clip(lh_hyb, X.LAMBDA_MIN, X.LAMBDA_MAX),
                              np.clip(la_hyb, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
    b_hyb = _brier(p_hyb, y1h)
    # reverse hybrid for completeness: dev-09 total × dev-03 ratio
    lh_rev = tot09 * rat03; la_rev = tot09 * (1.0 - rat03)
    rmse_rev = _rmse(np.concatenate([lh_rev, la_rev]), real_stack)
    p_rev = X._lambdas_to_1x2(np.clip(lh_rev, X.LAMBDA_MIN, X.LAMBDA_MAX),
                              np.clip(la_rev, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
    b_rev = _brier(p_rev, y1h)
    dominates = rmse_hyb <= rmse03 + 1e-6 and b_hyb.mean() <= b09.mean() + 1e-6
    print("\n" + "─" * 76)
    print("2. SMART HYBRID  (dev-03 total × dev-09 ratio)")
    print("─" * 76)
    print(f"  hybrid:        xG-RMSE {rmse_hyb:.4f}  Brier {b_hyb.mean():.4f}")
    print(f"  best pure:     xG-RMSE {rmse03:.4f} (dev-03)  Brier {b09.mean():.4f} (dev-09)")
    print(f"  reverse hybrid: xG-RMSE {rmse_rev:.4f}  Brier {b_rev.mean():.4f}")
    print(f"  → Pareto-dominates both pure models: {'✓ YES' if dominates else '✗ no'}")
    if not dominates:
        print(f"    (hybrid xG-RMSE vs dev-03: {rmse_hyb-rmse03:+.4f} · "
              f"hybrid Brier vs dev-09: {b_hyb.mean()-b09.mean():+.5f})")

    # ── 3. α convex λ-blend sweep ──
    print("\n" + "─" * 76)
    print("3. α-BLEND λ = (1-α)·dev-03 + α·dev-09")
    print("─" * 76)
    print(f"  {'α':>4} {'xG-RMSE':>8} {'Brier':>8}")
    sweep = []
    for a in np.linspace(0, 1, 11):
        lhb = (1 - a) * lh03 + a * lh09
        lab = (1 - a) * la03 + a * la09
        rm = _rmse(np.concatenate([lhb, lab]), real_stack)
        pb = X._lambdas_to_1x2(np.clip(lhb, X.LAMBDA_MIN, X.LAMBDA_MAX),
                               np.clip(lab, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
        bm = float(_brier(pb, y1h).mean())
        sweep.append({"alpha": float(a), "xg_rmse": rm, "brier": bm})
        print(f"  {a:>4.1f} {rm:>8.4f} {bm:>8.4f}")

    # ── 4. probability log-pool sweep (Brier only) ──
    print("\n" + "─" * 76)
    print("4. PROB LOG-POOL p ∝ p03^(1-β)·p09^β  (Brier)")
    print("─" * 76)
    eps = 1e-9
    pool = []
    print(f"  {'β':>4} {'Brier':>8}")
    for b in np.linspace(0, 1, 11):
        lp = (1 - b) * np.log(p03 + eps) + b * np.log(p09 + eps)
        pp = np.exp(lp); pp = pp / pp.sum(axis=1, keepdims=True)
        bm = float(_brier(pp, y1h).mean())
        pool.append({"beta": float(b), "brier": bm})
        print(f"  {b:>4.1f} {bm:>8.4f}")
    best_pool = min(pool, key=lambda r: r["brier"])

    # ── 5. error complementarity ──
    ae09 = np.abs(np.concatenate([lh09, la09]) - real_stack)
    ae03 = np.abs(np.concatenate([lh03, la03]) - real_stack)
    corr_xg = float(np.corrcoef(ae09, ae03)[0, 1])
    corr_brier = float(np.corrcoef(b09, b03)[0, 1])
    print("\n" + "─" * 76)
    print("5. ERROR COMPLEMENTARITY (low corr ⇒ blend has headroom)")
    print("─" * 76)
    print(f"  corr(xG abs-err):  {corr_xg:.3f}")
    print(f"  corr(Brier/match): {corr_brier:.3f}")

    # ── 6. edge by bucket ──
    def terciles(v):
        q = np.quantile(v, [1/3, 2/3])
        return np.digitize(v, q)
    fav = np.abs(p03[:, 0] - p03[:, 2])  # favorite strength (home-away prob gap)
    buckets = {"total_xg": terciles(tot_r), "favorite_strength": terciles(fav)}
    bucket_out = {}
    print("\n" + "─" * 76)
    print("6. EDGE BY BUCKET (Brier-Δ dev09−dev03; <0 = dev-09 better)")
    print("─" * 76)
    for bname, bt in buckets.items():
        bucket_out[bname] = []
        print(f"  {bname}:")
        for t, lbl in [(0, "low"), (1, "mid"), (2, "high")]:
            mt = bt == t
            if mt.sum() < 20:
                continue
            bd = float(b09[mt].mean() - b03[mt].mean())
            rd = _rmse(np.concatenate([lh09[mt], la09[mt]]), np.concatenate([rh[mt], ra[mt]])) - \
                 _rmse(np.concatenate([lh03[mt], la03[mt]]), np.concatenate([rh[mt], ra[mt]]))
            bucket_out[bname].append({"tercile": lbl, "n": int(mt.sum()), "brier_delta": bd, "xg_rmse_delta": float(rd)})
            print(f"    {lbl:<5} n={int(mt.sum()):>4}  Brier-Δ {bd:>+.4f}  xG-RMSE-Δ {rd:>+.4f}")

    out = {
        "test_seasons": ["25/26"], "n": int(n),
        "baseline": {"dev03": {"xg_rmse": rmse03, "brier": float(b03.mean())},
                     "dev09": {"xg_rmse": rmse09, "brier": float(b09.mean())}},
        "magnitude_vs_ratio": {"total_rmse_dev03": tot_rmse03, "total_rmse_dev09": tot_rmse09,
                               "ratio_mae_dev03": rat_mae03, "ratio_mae_dev09": rat_mae09},
        "smart_hybrid": {"xg_rmse": rmse_hyb, "brier": float(b_hyb.mean()),
                         "pareto_dominates_both": bool(dominates),
                         "reverse_xg_rmse": rmse_rev, "reverse_brier": float(b_rev.mean())},
        "alpha_blend_sweep": sweep,
        "logpool_sweep": pool, "best_logpool": best_pool,
        "error_complementarity": {"corr_xg_abserr": corr_xg, "corr_brier": corr_brier},
        "edge_by_bucket": bucket_out,
    }
    OUT.write_text(json.dumps(out, indent=2))
    print("\n" + "═" * 76)
    print(f"  ✓ {OUT.relative_to(REPO_ROOT)}")
    print("═" * 76)
    return 0


if __name__ == "__main__":
    sys.exit(main())
