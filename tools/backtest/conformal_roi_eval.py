#!/usr/bin/env python3
"""Does ENFORCE improve the BETTING book, or just thin it? (the real G5 for the gate)

Coverage being correct only validates the prediction SETS. The staking decision is:
flipping `enforce` bets ONLY in singleton matches and SKIPS the rest. This script
value-bets the production-faithful calibrated probs against Pinnacle CLOSING odds
and asks whether the singleton-KEPT bets realise better ROI than the multi-SKIPPED
bets. If the KEEP-minus-SKIP ROI gap's bootstrap CI crosses 0, enforce drops bets
indiscriminately → no money benefit (consistent with the settled no-edge result).

Join: calibrated rows are positionally aligned with B1's filtered+sorted v2 parquet
(asserted via league+date+ft_result). Odds joined on the SCORE key
(league, date, goals_h, goals_a) — unique within a league-date in ~all cases —
which sidesteps cross-source team-name canonicalization entirely.

Realistic payout uses the WITH-VIG Pinnacle decimal (psch/pscd/psca). Edge uses the
vig-removed fair prob. Flat 1u stake. Bootstrap (match-level) 95% CI on KEEP-SKIP.
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
CAL = REPO / "tools" / "backtest" / ".conformal_calibrated.json"
V2 = REPO / "tools" / "backtest" / "v2-oot-predictions.parquet"
ODDS = REPO / "tools" / "backtest" / "odds-close-25-26.parquet"
Q_CORR = Path("/tmp/corrected-quantiles.json")
OUT = Path("/tmp/cc_roi_result.json")

WINDOW_FROM, WINDOW_TO = "2025-08-01", "2026-07-01"
IDX = {"H": 0, "D": 1, "A": 2}
ALPHA = 0.10           # runtime DEFAULT_ALPHA
THRESHOLDS = [0.0, 0.02, 0.03, 0.05]
SEED = 20260601
N_BOOT = 2000


def akey(a): return f"{a:.2f}"


def lookup_q(quant, league, alpha):
    k = akey(alpha)
    per = quant.get("leagues", {}).get(league)
    if per and k in per:
        return float(per[k])
    return float(quant.get("global", {}).get(k, 0.50))


def is_singleton(cal, q):
    inset = [k for k in ("H", "D", "A") if (1.0 - cal[IDX[k]]) <= q]
    if not inset:
        return True  # argmax fallback ⇒ singleton
    return len(inset) == 1


def main() -> int:
    cal_rows = json.loads(CAL.read_text())
    quant = json.loads(Q_CORR.read_text())

    # ── align calibrated rows to the v2 parquet (B1's exact filter+sort) ──
    v2 = pd.read_parquet(V2)
    v2["match_date"] = pd.to_datetime(v2["match_date"]).dt.date.astype(str)
    v2 = v2[(v2["match_date"] >= WINDOW_FROM) & (v2["match_date"] < WINDOW_TO)]
    v2 = v2[v2["ft_result"].isin(["H", "D", "A"])].copy()
    v2 = v2.sort_values("match_date").reset_index(drop=True)
    assert len(v2) == len(cal_rows), f"len mismatch {len(v2)} vs {len(cal_rows)}"
    # verify positional alignment (guards against sort nondeterminism)
    mism = sum(
        1 for i, r in enumerate(cal_rows)
        if not (r["league"] == v2.at[i, "league"]
                and r["match_date"] == v2.at[i, "match_date"]
                and r["ft_result"] == v2.at[i, "ft_result"])
    )
    align_ok = mism == 0

    df = pd.DataFrame({
        "league": [r["league"] for r in cal_rows],
        "match_date": [r["match_date"] for r in cal_rows],
        "ft_result": [r["ft_result"] for r in cal_rows],
        "cal_h": [r["cal"][0] for r in cal_rows],
        "cal_d": [r["cal"][1] for r in cal_rows],
        "cal_a": [r["cal"][2] for r in cal_rows],
        "gh": v2["actual_h_goals"].astype(int).values,
        "ga": v2["actual_a_goals"].astype(int).values,
    })

    # ── odds: keep score-key UNIQUE within (league,date) on BOTH sides ──
    od = pd.read_parquet(ODDS)
    od["match_date"] = pd.to_datetime(od["match_date"]).dt.date.astype(str)
    od = od.dropna(subset=["psch", "pscd", "psca"])
    od["gh"] = od["ft_goals_h"].astype("Int64")
    od["ga"] = od["ft_goals_a"].astype("Int64")
    od = od.dropna(subset=["gh", "ga"])
    od["gh"] = od["gh"].astype(int); od["ga"] = od["ga"].astype(int)
    key = ["league", "match_date", "gh", "ga"]
    od_u = od.drop_duplicates(key, keep=False)[key + ["psch", "pscd", "psca"]]
    df_u = df.drop_duplicates(key, keep=False)
    merged = df_u.merge(od_u, on=key, how="inner")

    # ── value-bet sim per row ──
    res = {"align_ok": align_ok, "align_mismatches": mism,
           "n_cal": len(cal_rows), "n_joined_unique_score": len(merged),
           "alpha": ALPHA, "thresholds": {}}

    odd = merged[["psch", "pscd", "psca"]].values.astype(float)      # decimal, with vig
    inv = 1.0 / odd
    fair = inv / inv.sum(axis=1, keepdims=True)                       # vig-removed
    cal = merged[["cal_h", "cal_d", "cal_a"]].values.astype(float)
    edge = cal - fair
    yidx = merged["ft_result"].map(IDX).values
    # gate: singleton per match (α=0.10 corrected quantiles)
    keep_match = np.array([
        is_singleton([cal[i, 0], cal[i, 1], cal[i, 2]],
                     lookup_q(quant, merged.at[i, "league"], ALPHA))
        for i in range(len(merged))
    ])

    rng = np.random.default_rng(SEED)

    def roi_ci(profits):
        if len(profits) < 5:
            return {"n": int(len(profits)), "roi": None}
        b = np.array([profits[rng.integers(0, len(profits), len(profits))].mean()
                      for _ in range(N_BOOT)])
        lo, hi = np.percentile(b, [2.5, 97.5])
        return {"n": int(len(profits)), "roi": float(profits.mean()),
                "ci95": [float(lo), float(hi)]}

    def gap_ci(pk, ps):
        if len(pk) < 5 or len(ps) < 5:
            return None
        d = np.array([pk[rng.integers(0, len(pk), len(pk))].mean()
                      - ps[rng.integers(0, len(ps), len(ps))].mean()
                      for _ in range(N_BOOT)])
        lo, hi = np.percentile(d, [2.5, 97.5])
        return {"gap": float(pk.mean() - ps.mean()), "ci95": [float(lo), float(hi)],
                "crosses_zero": bool(lo <= 0 <= hi)}

    for thr in THRESHOLDS:
        # fire on every outcome whose edge exceeds the threshold (engine surfaces all)
        fired = edge > thr
        rows_i, sides = np.where(fired)
        if len(rows_i) == 0:
            res["thresholds"][str(thr)] = {"n_bets": 0}
            continue
        # realized flat-stake profit at WITH-VIG decimal
        win = (sides == yidx[rows_i])
        profit = np.where(win, odd[rows_i, sides] - 1.0, -1.0)
        kept = keep_match[rows_i]   # enforce KEEPS this bet's match
        res["thresholds"][str(thr)] = {
            "n_bets": int(len(rows_i)),
            "all_warn":    roi_ci(profit),                 # gate=warn (bet all)
            "enforce_kept": roi_ci(profit[kept]),          # gate=enforce (singleton only)
            "enforce_skipped": roi_ci(profit[~kept]),      # the bets enforce DROPS
            "kept_minus_skipped": gap_ci(profit[kept], profit[~kept]),
        }

    OUT.write_text(json.dumps(res, indent=2))

    # human summary
    L = ["=" * 78, f"CONFORMAL ENFORCE → ROI vs Pinnacle CLOSING (α={ALPHA}, corrected quantiles)",
         f"  align_ok={align_ok} (mismatches={mism}) · joined unique-score rows={len(merged)} / {len(cal_rows)}",
         "  ROI = mean flat-stake profit per 1u bet at Pinnacle closing (with vig).",
         "=" * 78]
    for thr, d in res["thresholds"].items():
        if d.get("n_bets", 0) == 0:
            L.append(f"\n[edge>{thr}] no bets"); continue
        L.append(f"\n[edge>{thr}]  total fired bets={d['n_bets']}")
        def fmt(x):
            if not x or x.get("roi") is None:
                return f"n={x['n'] if x else 0} (too few)"
            return f"n={x['n']:<5} ROI {x['roi']*100:+.2f}%  CI[{x['ci95'][0]*100:+.2f},{x['ci95'][1]*100:+.2f}]"
        L.append(f"   gate=warn  (bet ALL)      : {fmt(d['all_warn'])}")
        L.append(f"   gate=enforce (KEPT only)  : {fmt(d['enforce_kept'])}")
        L.append(f"   the SKIPPED bets          : {fmt(d['enforce_skipped'])}")
        g = d["kept_minus_skipped"]
        if g:
            L.append(f"   KEPT − SKIPPED ROI gap    : {g['gap']*100:+.2f}pp "
                     f"CI[{g['ci95'][0]*100:+.2f},{g['ci95'][1]*100:+.2f}] "
                     f"{'(crosses 0 → enforce gives NO robust ROI benefit)' if g['crosses_zero'] else '(ROBUST)'}")
    L.append("\n" + "=" * 78)
    s = "\n".join(L)
    print(s)
    Path("/tmp/cc_roi_summary.txt").write_text(s)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
