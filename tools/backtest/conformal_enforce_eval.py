#!/usr/bin/env python3
"""Conformal ENFORCE evaluation (decision-grade, runtime-faithful).

Question the report does NOT answer: coverage being correct (the refit) only says
the prediction SETS are statistically valid. It does NOT say flipping the staking
gate to `enforce` (binary: bet only when the conformal set is a singleton, else
SKIP) is a good policy. This script measures the gate AS A BET FILTER on the real
production-faithful calibrated probs.

Inputs (all already production-faithful):
  tools/backtest/.conformal_calibrated.json  — B2 output: calibrate1X2(benterBlend(raw))
                                               per OOT row, the EXACT gate input.
  /tmp/corrected-quantiles.json              — the candidate (branch) quantiles.
  public/conformal-quantiles.json            — the STALE prod quantiles (for delta).

For each (quantiles, alpha) it computes, mirroring conformal-gate.ts exactly:
  set_k = { k : cal_k >= 1 - q_league }  (fallback argmax if empty)
  - COVERAGE   : P(ft_result in set)            — reproduce the refit sanity.
  - VOLUME     : enforce keep-rate = P(singleton); dampen mean factor.
  - BET-QUALITY: argmax hit-rate + Brier, split singleton (enforce-KEEP) vs
                 multi (enforce-SKIP), with match-level bootstrap 95% CI on the
                 KEEP-minus-SKIP gap. favourite-strength (mean max prob) per group.

Runtime gate uses alpha=0.10 (DEFAULT_ALPHA in conformal-gate.ts); _meta says
0.05 — we report both. No odds here on purpose: 1X2 edge vs Pinnacle is a settled
negative (forecast doc 5b; dev-09 G5), so ROI is reasoned, not re-derived.
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[2]
CAL = REPO / "tools" / "backtest" / ".conformal_calibrated.json"
Q_CORR = Path("/tmp/corrected-quantiles.json")
Q_STALE = REPO / "public" / "conformal-quantiles.json"
OUT = Path("/tmp/cc_eval_result.json")

IDX = {"H": 0, "D": 1, "A": 2}
ALPHAS = [0.10, 0.05]  # 0.10 = the actual runtime default; 0.05 = _meta default
SEED = 20260601
N_BOOT = 2000


def akey(a: float) -> str:
    return f"{a:.2f}"


def lookup_q(quant: dict, league: str, alpha: float) -> float:
    k = akey(alpha)
    per = quant.get("leagues", {}).get(league)
    if per and k in per:
        return float(per[k])
    g = quant.get("global", {})
    if k in g:
        return float(g[k])
    return 0.50  # FALLBACK_QUANTILE


def gate_set(cal, q):
    """Mirror conformalGate(): inSet = {k: 1-cal_k <= q}; fallback argmax."""
    inset = [k for k in ("H", "D", "A") if (1.0 - cal[IDX[k]]) <= q]
    if not inset:
        inset = [max(("H", "D", "A"), key=lambda k: cal[IDX[k]])]
    return inset


def brier_row(cal, y):
    one = [1.0 if k == y else 0.0 for k in ("H", "D", "A")]
    return sum((cal[i] - one[i]) ** 2 for i in range(3))


def boot_gap(mask_keep, vals, rng, n=N_BOOT):
    """Bootstrap 95% CI of mean(vals[keep]) - mean(vals[skip]) at match level."""
    keep = vals[mask_keep]
    skip = vals[~mask_keep]
    if len(keep) < 5 or len(skip) < 5:
        return None
    diffs = np.empty(n)
    for b in range(n):
        kb = keep[rng.integers(0, len(keep), len(keep))].mean()
        sb = skip[rng.integers(0, len(skip), len(skip))].mean()
        diffs[b] = kb - sb
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return {
        "keep_mean": float(keep.mean()), "skip_mean": float(skip.mean()),
        "gap": float(keep.mean() - skip.mean()),
        "ci95": [float(lo), float(hi)], "crosses_zero": bool(lo <= 0 <= hi),
        "n_keep": int(len(keep)), "n_skip": int(len(skip)),
    }


def analyze(rows, quant, alpha, label):
    rng = np.random.default_rng(SEED)
    cals = [r["cal"] for r in rows]
    ys = [r["ft_result"] for r in rows]
    lgs = [r["league"] for r in rows]
    n = len(rows)

    setsizes = np.empty(n, int)
    covered = np.empty(n, bool)          # ft_result in set
    is_single = np.empty(n, bool)        # enforce keeps
    argmax_hit = np.empty(n, float)      # argmax == ft_result
    briers = np.empty(n, float)
    favstrength = np.empty(n, float)     # max prob
    dampfac = np.empty(n, float)

    cov_by_lg = {}
    for i in range(n):
        cal, y, lg = cals[i], ys[i], lgs[i]
        q = lookup_q(quant, lg, alpha)
        s = gate_set(cal, q)
        ss = len(s)
        setsizes[i] = ss
        covered[i] = y in s
        is_single[i] = ss == 1
        pick = max(("H", "D", "A"), key=lambda k: cal[IDX[k]])
        argmax_hit[i] = 1.0 if pick == y else 0.0
        briers[i] = brier_row(cal, y)
        favstrength[i] = max(cal)
        dampfac[i] = 1.0 if ss == 1 else (0.6 if ss == 2 else 0.3)
        cov_by_lg.setdefault(lg, []).append(1.0 if y in s else 0.0)

    keep_rate = float(is_single.mean())
    cov = float(covered.mean())
    per_lg_cov = {lg: {"n": len(v), "coverage": round(float(np.mean(v)), 4)}
                  for lg, v in sorted(cov_by_lg.items())}
    # how far each league's coverage is from nominal (1-alpha)
    worst_cov = sorted(
        ({"league": lg, "n": d["n"], "coverage": d["coverage"],
          "drift": round(d["coverage"] - (1 - alpha), 4)}
         for lg, d in per_lg_cov.items()),
        key=lambda x: x["drift"])[:5]

    hit_gap = boot_gap(is_single, argmax_hit, rng)
    brier_gap = boot_gap(is_single, briers, rng)
    fav_gap = boot_gap(is_single, favstrength, rng)

    return {
        "label": label, "alpha": alpha, "n": n,
        "aggregate_coverage": round(cov, 4),
        "coverage_drift_vs_nominal": round(cov - (1 - alpha), 4),
        "enforce_keep_rate": round(keep_rate, 4),
        "enforce_skip_rate": round(1 - keep_rate, 4),
        "setsize_dist": {
            "1": round(float((setsizes == 1).mean()), 4),
            "2": round(float((setsizes == 2).mean()), 4),
            "3": round(float((setsizes == 3).mean()), 4),
        },
        "dampen_mean_factor": round(float(dampfac.mean()), 4),
        "argmax_hit_overall": round(float(argmax_hit.mean()), 4),
        "argmax_hit_keep_vs_skip": hit_gap,
        "brier_keep_vs_skip": brier_gap,
        "favstrength_keep_vs_skip": fav_gap,
        "worst5_league_coverage": worst_cov,
    }


def main() -> int:
    rows = json.loads(CAL.read_text())
    corr = json.loads(Q_CORR.read_text())
    stale = json.loads(Q_STALE.read_text())

    out = {
        "n_rows": len(rows),
        "leagues": len(set(r["league"] for r in rows)),
        "corrected_meta": corr.get("_meta", {}),
        "stale_meta": stale.get("_meta", {}),
        "runs": [],
    }
    for alpha in ALPHAS:
        out["runs"].append(analyze(rows, corr, alpha, f"corrected@a={alpha}"))
        out["runs"].append(analyze(rows, stale, alpha, f"stale@a={alpha}"))

    OUT.write_text(json.dumps(out, indent=2))

    # ── human summary ──
    L = []
    L.append("=" * 78)
    L.append(f"CONFORMAL ENFORCE EVAL  n={out['n_rows']} rows · {out['leagues']} leagues")
    L.append(f"  corrected quantiles: {out['corrected_meta'].get('calibration')} "
             f"(global0.05={corr['global'].get('0.05')}, 0.10={corr['global'].get('0.10')})")
    L.append(f"  STALE/prod quantiles: {out['stale_meta'].get('calibration')} "
             f"(global0.05={stale['global'].get('0.05')}, 0.10={stale['global'].get('0.10')})")
    L.append("=" * 78)
    for r in out["runs"]:
        L.append("")
        L.append(f"[{r['label']}]  (alpha={r['alpha']}  nominal coverage={1-r['alpha']:.2f})")
        L.append(f"  aggregate coverage  : {r['aggregate_coverage']:.4f} "
                 f"(drift {r['coverage_drift_vs_nominal']:+.4f} vs nominal)")
        L.append(f"  ENFORCE keep-rate   : {r['enforce_keep_rate']*100:.1f}%  "
                 f"→ SKIPS {r['enforce_skip_rate']*100:.1f}% of 1X2 bets")
        sd = r["setsize_dist"]
        L.append(f"  set-size dist       : |1|={sd['1']*100:.0f}%  |2|={sd['2']*100:.0f}%  |3|={sd['3']*100:.0f}%   "
                 f"(dampen mean factor {r['dampen_mean_factor']:.3f})")
        hg = r["argmax_hit_keep_vs_skip"]
        if hg:
            L.append(f"  argmax hit KEEP/SKIP: {hg['keep_mean']*100:.1f}% (n={hg['n_keep']}) vs "
                     f"{hg['skip_mean']*100:.1f}% (n={hg['n_skip']})  "
                     f"gap {hg['gap']*100:+.1f}pp CI[{hg['ci95'][0]*100:+.1f},{hg['ci95'][1]*100:+.1f}] "
                     f"{'(crosses 0)' if hg['crosses_zero'] else '(robust)'}")
        bg = r["brier_keep_vs_skip"]
        if bg:
            L.append(f"  Brier  KEEP/SKIP    : {bg['keep_mean']:.4f} vs {bg['skip_mean']:.4f}  "
                     f"gap {bg['gap']:+.4f} CI[{bg['ci95'][0]:+.4f},{bg['ci95'][1]:+.4f}] "
                     f"{'(crosses 0)' if bg['crosses_zero'] else '(robust)'}  (lower=better; KEEP should be <)")
        fg = r["favstrength_keep_vs_skip"]
        if fg:
            L.append(f"  fav-strength KEEP/SK: {fg['keep_mean']:.3f} vs {fg['skip_mean']:.3f}  "
                     f"(KEEP higher ⇒ singletons are lopsided-favourite matches)")
    L.append("")
    L.append("=" * 78)
    summary = "\n".join(L)
    print(summary)
    (Path("/tmp/cc_eval_summary.txt")).write_text(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
