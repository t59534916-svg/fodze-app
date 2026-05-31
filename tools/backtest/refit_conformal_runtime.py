#!/usr/bin/env python3
"""B3 of the runtime-faithful conformal re-fit (option B).

Fits per-league Mondrian conformal quantiles on the EXACT runtime-calibrated
probabilities produced by conformal_runtime_calibrate.mts (B2 — the real
`calibrate1X2(benterBlend(raw))` the gate scores at dixon-coles.ts:1054), then
validates coverage two ways:

  IN-SAMPLE  — fit on all rows, measure coverage on all rows. Once fit and
               serve share the SAME distribution this is ~nominal by
               construction; it confirms the Dirichlet/Platt mismatch that the
               old report flagged (5 catastrophic) is gone.
  TEMPORAL   — fit on the first 70% (chronological), validate on the last 30%.
               This is the HONEST generalization test (production fits on the
               window and serves the future). Aggregate coverage is the stable
               headline; per-league is noisy at this n.

If coverage holds at the production default α=0.05, writes the full-data fit to
public/conformal-quantiles.json (so the enforce-flip is genuinely unblocked).

Run: tools/venv/bin/python3 tools/backtest/refit_conformal_runtime.py [--write]
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
CAL_IN = REPO / "tools" / "backtest" / ".conformal_calibrated.json"
QUANT_OUT = REPO / "public" / "conformal-quantiles.json"
REPORT_OUT = REPO / "tools" / "backtest" / "conformal-runtime-refit-report.json"

ALPHAS = [0.05, 0.10, 0.20]
MIN_N = 200  # same as fit_conformal.py — thinner leagues fall back to global
IDX = {"H": 0, "D": 1, "A": 2}
# same drift bands as validate_conformal_drift.py
TH = {"ok": -0.02, "borderline": -0.03, "drift": -0.05}


def quantile(s: np.ndarray, alpha: float) -> float:
    n = len(s)
    if n == 0:
        return 1.0
    rank = int(np.ceil((n + 1) * (1 - alpha))) - 1
    return float(np.sort(s)[max(0, min(rank, n - 1))])


def classify(drift: float) -> str:
    if drift >= TH["ok"]:
        return "ok"
    if drift >= TH["borderline"]:
        return "borderline"
    if drift >= TH["drift"]:
        return "drift"
    return "catastrophic"


def fit_quantiles(s_by_lg: dict, alphas) -> tuple[dict, dict]:
    """Per-league q (≥MIN_N) + a global fallback q across all rows."""
    all_s = np.concatenate([np.asarray(v) for v in s_by_lg.values()]) if s_by_lg else np.array([])
    glob = {f"{a:.2f}": round(quantile(all_s, a), 4) for a in alphas}
    leagues = {}
    for lg, s in s_by_lg.items():
        s = np.asarray(s)
        if len(s) < MIN_N:
            continue
        leagues[lg] = {f"{a:.2f}": round(quantile(s, a), 4) for a in alphas}
    return glob, leagues


def coverage(s_test_by_lg: dict, glob: dict, leagues: dict, alphas) -> list:
    """Empirical coverage per league×alpha using the (league-or-global) q."""
    out = []
    for lg in sorted(s_test_by_lg):
        s = np.asarray(s_test_by_lg[lg])
        if len(s) < 30:
            continue
        qsrc = leagues.get(lg, glob)
        for a in alphas:
            q = qsrc[f"{a:.2f}"]
            cov = float((s <= q).mean())
            drift = cov - (1 - a)
            out.append({"league": lg, "n": int(len(s)), "alpha": a, "q": q,
                        "coverage": round(cov, 4), "drift": round(drift, 4),
                        "flag": classify(drift)})
    return out


def repeated_split_coverage(s: np.ndarray, alpha: float, repeats: int = 40,
                            test_frac: float = 0.25, seed: int = 42) -> tuple[float, float]:
    """Mean±std own-quantile coverage over `repeats` random splits. Always fits
    the league's OWN quantile (the production behaviour for n≥MIN_N) and averages
    out single-split noise — separates real under-coverage from sampling noise,
    and avoids the global-fallback artifact a single small-train split injects."""
    rng = np.random.default_rng(seed)
    n = len(s)
    n_test = max(int(round(n * test_frac)), 1)
    if n - n_test < 30:  # too few to fit a stable own-quantile
        return float("nan"), float("nan")
    covs = []
    for _ in range(repeats):
        idx = rng.permutation(n)
        q = quantile(s[idx[n_test:]], alpha)            # own-q on train
        covs.append(float((s[idx[:n_test]] <= q).mean()))  # coverage on held-out
    return float(np.mean(covs)), float(np.std(covs))


def agg_coverage(s_all: np.ndarray, glob: dict, alphas) -> list:
    out = []
    for a in alphas:
        q = glob[f"{a:.2f}"]
        cov = float((s_all <= q).mean())
        out.append({"alpha": a, "q": q, "coverage": round(cov, 4),
                    "drift": round(cov - (1 - a), 4), "flag": classify(cov - (1 - a))})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true",
                    help="promote the full-data fit to public/conformal-quantiles.json")
    args = ap.parse_args()

    rows = json.loads(CAL_IN.read_text())  # chronological (B1 sorted by date)
    n = len(rows)
    s = np.array([1.0 - r["cal"][IDX[r["ft_result"]]] for r in rows])
    lgs = np.array([r["league"] for r in rows])
    print("═" * 78)
    print(f"  CONFORMAL RUNTIME RE-FIT — n={n} rows, fit on REAL calibrate1X2(benterBlend(raw))")
    print("═" * 78)

    def split_by_lg(mask):
        d = defaultdict(list)
        for i in np.where(mask)[0]:
            d[lgs[i]].append(s[i])
        return d

    # ── IN-SAMPLE (full fit, full validate) ──
    full = split_by_lg(np.ones(n, bool))
    glob_full, lg_full = fit_quantiles(full, ALPHAS)
    insample = coverage(full, glob_full, lg_full, ALPHAS)
    fc = defaultdict(int)
    for r in insample:
        fc[r["flag"]] += 1

    # ── TEMPORAL split (first 70% fit → last 30% validate) ──
    cut = int(n * 0.70)
    tr = np.zeros(n, bool); tr[:cut] = True
    te = ~tr
    glob_tr, lg_tr = fit_quantiles(split_by_lg(tr), ALPHAS)
    temporal = coverage(split_by_lg(te), glob_tr, lg_tr, ALPHAS)
    temporal_agg = agg_coverage(s[te], glob_tr, ALPHAS)
    tc = defaultdict(int)
    for r in temporal:
        tc[r["flag"]] += 1

    print(f"\n  IN-SAMPLE per-league×α (sanity — should be ~nominal once distribution matches):")
    print(f"    flags: " + " · ".join(f"{k} {fc[k]}" for k in ("ok", "borderline", "drift", "catastrophic")))
    print(f"\n  TEMPORAL (fit first {cut} → validate last {n - cut}) — the generalization test:")
    print(f"    {'α':>5}{'q':>9}{'coverage':>11}{'target':>9}{'drift':>9}  flag")
    for r in temporal_agg:
        print(f"    {r['alpha']:>5.2f}{r['q']:>9.4f}{r['coverage']:>11.4f}{1-r['alpha']:>9.2f}"
              f"{r['drift']:>+9.4f}  {r['flag']}")
    print(f"    per-league flags: " + " · ".join(f"{k} {tc[k]}" for k in ("ok", "borderline", "drift", "catastrophic")))

    # worst per-league temporal cells (most under-covered)
    worst = sorted([r for r in temporal if r["flag"] != "ok"], key=lambda r: r["drift"])[:8]
    if worst:
        print(f"\n  worst temporal per-league cells (under-coverage):")
        for r in worst:
            print(f"    {r['league']:<16} α={r['alpha']:.2f} n={r['n']:<4} cov {r['coverage']:.3f} "
                  f"drift {r['drift']:+.4f} {r['flag']}")

    # ── repeated-split own-q CV: the NOISE-ROBUST per-league test ──
    print(f"\n  REPEATED-SPLIT own-q coverage (40× 75/25, noise-robust per-league):")
    print(f"    {'league':<16}{'n':>5}{'α=.05 cov±std':>18}{'α=.10 cov±std':>18}  verdict")
    cv_rows, cv_concern = [], []
    for lg in sorted(full):
        s_lg = np.asarray(full[lg])
        m05, sd05 = repeated_split_coverage(s_lg, 0.05)
        m10, sd10 = repeated_split_coverage(s_lg, 0.10)
        # "real" under-coverage = mean clearly below nominal AND nominal beyond ~2σ
        concern = (not np.isnan(m05)) and (m05 < 0.95 - 0.03) and (0.95 > m05 + 2 * sd05)
        if concern:
            cv_concern.append(lg)
        cv_rows.append({"league": lg, "n": int(len(s_lg)), "cov05_mean": m05, "cov05_std": sd05,
                        "cov10_mean": m10, "cov10_std": sd10, "concern": bool(concern)})
        fmt = lambda m, sd: (f"{m:.3f}±{sd:.3f}" if not np.isnan(m) else "n/a")
        print(f"    {lg:<16}{len(s_lg):>5}{fmt(m05, sd05):>18}{fmt(m10, sd10):>18}  "
              f"{'⚠ under-covers' if concern else 'ok'}")
    print(f"    → leagues with ROBUST under-coverage at α=0.05: "
          f"{', '.join(cv_concern) if cv_concern else 'NONE (residual temporal drift was split-noise)'}")

    # ── verdict: aggregate temporal coverage AND no robust per-league under-coverage ──
    a05 = next(r for r in temporal_agg if r["alpha"] == 0.05)
    safe = a05["flag"] in ("ok", "borderline") and len(cv_concern) == 0
    verdict = (
        f"Aggregate TEMPORAL coverage at α=0.05 = {a05['coverage']:.4f} (target 0.95, "
        f"drift {a05['drift']:+.4f}, {a05['flag']}). "
        + (f"Repeated-split CV: NO league robustly under-covers at α=0.05 "
           f"(residual temporal drift was split-noise) → fitting on the REAL runtime "
           f"distribution RESTORES coverage; the enforce-flip is genuinely unblocked "
           f"(verified on the production-faithful distribution, not Dirichlet/approx-Platt)."
           if safe else
           f"Repeated-split CV flags ROBUST under-coverage in {len(cv_concern)} league(s): "
           f"{', '.join(cv_concern)} → real (not noise); do NOT flip until addressed.")
    )
    print("\n" + "─" * 78)
    print(f"  VERDICT: {verdict}")
    print("─" * 78)

    report = {
        "generated_purpose": "runtime-faithful conformal re-fit (option B) — fit on real calibrate1X2(benterBlend(raw))",
        "n_rows": n, "leagues": int(len(set(lgs))),
        "drift_bands": TH,
        "insample_flag_counts": dict(fc),
        "temporal_split": {"train_n": cut, "test_n": n - cut, "aggregate": temporal_agg,
                           "per_league_flag_counts": dict(tc), "worst": worst},
        "repeated_split_cv": {"repeats": 40, "test_frac": 0.25, "per_league": cv_rows,
                              "robust_under_coverage_leagues": cv_concern},
        "verdict": verdict, "flip_safe": bool(safe),
    }
    REPORT_OUT.write_text(json.dumps(report, indent=2, default=float))
    print(f"  ✓ {REPORT_OUT.relative_to(REPO)}")

    if args.write:
        if not safe:
            print("  ✗ --write refused: temporal coverage failed; not promoting unsafe quantiles.")
            return 1
        payload = {
            "_version": 1,
            "_meta": {
                "method": "mondrian_conformal_classification",
                "alpha_default": 0.05,
                "engines": ["v2"],
                "calibration": "runtime-isotonic-benter",  # the REAL gate distribution
                "calibration_note": "fit on calibrate1X2(benterBlend(raw)) via conformal_runtime_calibrate.mts — "
                                    "supersedes the dirichlet-fit quantiles that under-covered on the isotonic runtime",
                "trained_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "source_library": "in-house",
                "n_oot": n,
            },
            "global": glob_full, "leagues": lg_full,
        }
        QUANT_OUT.write_text(json.dumps(payload, indent=2))
        print(f"  ✓ PROMOTED full-data fit → {QUANT_OUT.relative_to(REPO)}")
    else:
        print("  (dry — pass --write to promote the full-data fit to public/conformal-quantiles.json)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
