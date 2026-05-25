"""bet-edge-policy.ts EMPIRICAL re-validation — replaces assumed-SE with
true per-bet variance from Stage 5 ledger CSVs.

Discovers (post 2026-05-25 self-eval): true per-bet std = 148%, not the
80% I assumed in the earlier bet_edge_policy_audit.py. This is a major
methodological correction that COLLAPSES the "4 Holm-survivors" claim to
ZERO statistically significant leagues.

Inputs:
  tools/v4/reports/stage_5_bets_dev-03_dev-03_M_α1.0.csv         (25/26 holdout)
  tools/v4/reports/stage_5_bets_dev-03-walkfwd_dev-03-walkfwd_M_α1.0.csv (24/25 walkfwd)

Outputs:
  tools/v4/diagnostics/bet_edge_policy_empirical_audit.json
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

ROOT = Path(__file__).resolve().parents[3]
LEDGERS = {
    "25/26": ROOT / "tools/v4/reports/stage_5_bets_dev-03_dev-03_M_α1.0.csv",
    "24/25": ROOT / "tools/v4/reports/stage_5_bets_dev-03-walkfwd_dev-03-walkfwd_M_α1.0.csv",
}


def main():
    print("\n" + "═" * 76)
    print("bet-edge-policy EMPIRICAL re-validation (true per-bet variance)")
    print("═" * 76)

    all_bets = []
    for label, path in LEDGERS.items():
        df = pd.read_csv(path)
        df["holdout"] = label
        all_bets.append(df)
    combined = pd.concat(all_bets, ignore_index=True)

    # Per-bet return per unit stake (NOT scaled by Kelly stake_frac)
    combined["ret_per_unit"] = np.where(combined["won"], combined["odd"] - 1, -1.0)

    # AGGREGATE
    n_agg = len(combined)
    mean_agg = combined["ret_per_unit"].mean() * 100
    std_agg = combined["ret_per_unit"].std() * 100
    se_agg = std_agg / np.sqrt(n_agg)
    z_agg = mean_agg / se_agg
    p_agg = 1 - norm.cdf(z_agg) if z_agg > 0 else 0.5

    print(f"\nAGGREGATE (n={n_agg:,}):")
    print(f"  Mean ROI:       {mean_agg:+.2f}%")
    print(f"  Empirical std:  {std_agg:.1f}% per bet")
    print(f"  SE of mean:     {se_agg:.3f}%")
    print(f"  z-stat:         {z_agg:+.2f}")
    print(f"  p_raw:          {p_agg:.4f}  ({'SIGNIFICANT' if p_agg < 0.05 else 'NOT SIGNIFICANT'} at α=0.05)")

    print(f"\nPER-LEAGUE — empirical Holm-Bonferroni (m=16 leagues):")
    rows = []
    for lg, sub in combined.groupby("league"):
        if len(sub) < 10:
            continue
        n = len(sub)
        mean_ret = sub["ret_per_unit"].mean() * 100
        std_ret = sub["ret_per_unit"].std() * 100
        se = std_ret / np.sqrt(n)
        z = mean_ret / se if se > 0 else 0
        p_raw = 1 - norm.cdf(z) if z > 0 else 0.5
        rows.append({
            "league": str(lg), "n_bets": int(n),
            "mean_roi_pct": round(float(mean_ret), 2),
            "emp_std_pct": round(float(std_ret), 1),
            "emp_se_pct": round(float(se), 3),
            "z_stat": round(float(z), 3),
            "p_raw": round(float(p_raw), 5),
        })

    rows.sort(key=lambda x: x["p_raw"])
    m = len(rows)
    for r in rows:
        r["p_adj"] = float(min(r["p_raw"] * (m - rows.index(r)), 1.0))
        r["holm_significant"] = bool(r["p_adj"] < 0.05)
    print(f"  {'League':<16} {'n':>4} {'mean_ROI':>8} {'std':>7} {'SE':>6} {'z':>6} {'p_raw':>8} {'p_adj':>8}  Sig?")
    print(f"  {'-'*16} {'-'*4} {'-'*8} {'-'*7} {'-'*6} {'-'*6} {'-'*8} {'-'*8}  ----")
    survivors_holm = []
    for i, r in enumerate(rows):
        sig = "✅" if r["holm_significant"] else "❌"
        in_policy = r["league"] in ("la_liga", "scottish_prem", "bundesliga", "primeira_liga")
        star = "★" if in_policy else " "
        print(f"  {star}{r['league']:<15} {r['n_bets']:>4} {r['mean_roi_pct']:>+7.2f}% {r['emp_std_pct']:>6.1f}% "
              f"{r['emp_se_pct']:>5.2f}% {r['z_stat']:>+5.2f} {r['p_raw']:>7.4f} {r['p_adj']:>7.4f}  {sig}")
        if r["holm_significant"]:
            survivors_holm.append(r["league"])

    print(f"\n  HOLM-BONFERRONI SURVIVORS: {len(survivors_holm)} of {m}")
    for s in survivors_holm: print(f"    ✓ {s}")
    if not survivors_holm:
        print(f"    (NONE — entire LEAGUE_EDGE_POLICY needs re-framing)")

    # Compare to current policy
    current = {"la_liga", "scottish_prem", "bundesliga", "primeira_liga"}
    print(f"\n  Current policy: {sorted(current)}")
    print(f"  Empirical surv: {sorted(survivors_holm) if survivors_holm else '[]'}")
    print(f"  Surviving from current policy: {sorted(current & set(survivors_holm))}")

    # Directional criterion (looser than significance): both holdouts positive + n≥40
    print(f"\n  DIRECTIONAL filter (both-holdout-positive + n≥40, lieber criterion):")
    by_lg_holdout = combined.groupby(["league", "holdout"])["ret_per_unit"].mean()
    directional = []
    for lg in combined["league"].unique():
        try:
            r25 = by_lg_holdout.loc[lg].get("25/26")
            r24 = by_lg_holdout.loc[lg].get("24/25")
        except KeyError:
            continue
        n_lg = (combined["league"] == lg).sum()
        if pd.notna(r25) and pd.notna(r24) and r25 > 0 and r24 > 0 and n_lg >= 40:
            mean_combined = (r25 + r24) / 2 * 100
            directional.append({"league": lg, "n": int(n_lg),
                                "roi_24_25": round(float(r24)*100,2),
                                "roi_25_26": round(float(r25)*100,2),
                                "mean_roi": round(mean_combined,2)})

    print(f"  Directional set: {len(directional)} leagues")
    for d in sorted(directional, key=lambda x: -x["mean_roi"]):
        in_policy = "★" if d["league"] in current else " "
        print(f"    {in_policy} {d['league']:<16} n={d['n']:>4}  24/25={d['roi_24_25']:+7.2f}%  25/26={d['roi_25_26']:+7.2f}%  mean={d['mean_roi']:+7.2f}%")

    # Save report
    out = ROOT / "tools" / "v4" / "diagnostics" / "bet_edge_policy_empirical_audit.json"
    out.write_text(json.dumps({
        "aggregate": {
            "n_bets": int(n_agg),
            "mean_roi_pct": round(mean_agg, 3),
            "emp_std_pct": round(std_agg, 2),
            "emp_se_pct": round(se_agg, 3),
            "z_stat": round(z_agg, 3),
            "p_raw": round(p_agg, 5),
            "significant_at_005": bool(p_agg < 0.05),
        },
        "per_league_holm": rows,
        "holm_survivors": survivors_holm,
        "directional_set": directional,
        "current_policy": sorted(current),
        "FINDING": (
            f"With empirical per-bet std={std_agg:.1f}% (not assumed 80%), "
            f"{len(survivors_holm)}/{m} leagues survive Holm-Bonferroni at α=0.05. "
            f"Even aggregate dev-03 ROI is not statistically significant "
            f"(p={p_agg:.3f}). bet-edge-policy.ts must be reframed: keep 4 leagues "
            f"on DIRECTIONAL criterion (both holdouts positive + n≥40), but EXPLICITLY "
            f"REMOVE statistical-significance claim from public API + docs."
        ),
    }, indent=2))
    print(f"\n  Report saved: {out}")


if __name__ == "__main__":
    main()
