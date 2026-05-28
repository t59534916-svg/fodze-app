#!/usr/bin/env python3
"""falsify_draw_value — does the draw-VALUE edge replicate out-of-sample?

decision_thresholds found: betting the draw when Blend P(draw) > Pinnacle-implied
returned +5.9% (edge≥0, n=860) to +19.5% (edge≥4pp) on 25/26 — the ONLY +ROI cut
vs Pinnacle. But single season, wide CIs. This sends it through the 5-Gate with a
real OUT-OF-SAMPLE season + bootstrap CIs.

Seasons (each with an engine that is OOT for that season + its Pinnacle closing):
  25/26  Blend(prod) = dev-03 + dev-09-phase42  (trained ≤24/25 → 25/26 OOT)
  24/25  Blend(2h)   = dev-03-2h + dev-09-2h     (trained ≤23/24 → 24/25 OOT)

Rule: bet draw (stake 1) when P(draw) > 1/pscd + edge.  profit = pscd-1 if draw else -1.

5-Gate:
  G1 sign     — ROI > 0 directional on discovery (25/26)
  G2 multiple — pre-registered PRIMARY = edge≥0 (largest n, no cherry-pick);
                edge 2/4pp reported as secondary
  G3 leakage  — OOT engine per season + bet vs market closing
  G4 power    — bootstrap 95% CI on ROI (does it exclude 0?)
  G5 replicate— the decisive gate: does edge≥0 ROI stay POSITIVE on 24/25 OOT?

Output: tools/v4/diagnostics/falsify_draw_value.json
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/falsify_draw_value.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd

import score_xg_forecast as X
from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09, extract_X_dev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
BT = REPO / "tools" / "backtest"
OUT = D / "falsify_draw_value.json"
RHO = DEFAULT_RHO
WINDOW = X.JOIN_WINDOW_DAYS
EDGES = [0.0, 0.02, 0.04]
_HIST = None


def predict_blend_draws(season, d03_tag, d09_tag):
    global _HIST
    d09h = BayesianEnsemble.load(ART / f"m3_xg-home-{d09_tag}.pkl")
    d09a = BayesianEnsemble.load(ART / f"m3_xg-away-{d09_tag}.pkl")
    d03 = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{d03_tag}.pkl",
                                     away_path=ART / f"m3_xg-away-{d03_tag}.pkl", rho=RHO)
    fb = FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=(season,), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    cdate = pd.to_datetime(t["match_date"]).dt.normalize().dt.date
    Xd = extract_X_dev09(t)
    mh, _ = d09h.predict(Xd[d09h.feature_names]); ma, _ = d09a.predict(Xd[d09a.feature_names])
    lh9 = np.clip(mh, X.LAMBDA_MIN, X.LAMBDA_MAX); la9 = np.clip(ma, X.LAMBDA_MIN, X.LAMBDA_MAX)
    if _HIST is None:
        _HIST = load_team_xg_history()
    din = pd.DataFrame({"league": t["league"].astype(str), "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"], "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    dp = d03.predict_batch(din, _HIST, verbose=False)
    lh3 = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    la3 = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    p = X._lambdas_to_1x2(0.5 * lh9 + 0.5 * lh3, 0.5 * la9 + 0.5 * la3, RHO)
    y = np.array([X._outcome(h, a) for h, a in zip(t["home_goals"], t["away_goals"])])
    return pd.DataFrame({"league": t["league"].astype(str).values, "ch": t["ch"].values, "ca": t["ca"].values,
                         "cdate": cdate.values, "p_draw": p[:, 1], "is_draw": (y == 1).astype(int)})


class DrawOdds:
    """pscd lookup with the SAME tiered fuzzy resolver as OddsSpine/XGSpine
    (exact → name-match within league, nearest-date ±7d) so coverage + the
    discovery number reconcile with decision_thresholds."""

    def __init__(self, parquet):
        od = pd.read_parquet(parquet).dropna(subset=["pscd"]).reset_index(drop=True)
        od["ch"] = od.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
        od["ca"] = od.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
        od["d"] = pd.to_datetime(od["match_date"]).dt.date
        self._by = defaultdict(list)
        self._by_league = defaultdict(list)
        for r in od.itertuples(index=False):
            self._by[(r.league, r.ch, r.ca)].append((r.d, float(r.pscd)))
            self._by_league[r.league].append((r.ch, r.ca, r.d, float(r.pscd)))

    def _pick(self, opts, cdate):
        best = min(opts, key=lambda o: abs((o[0] - cdate).days))
        return best[1] if abs((best[0] - cdate).days) <= WINDOW else None

    def resolve(self, league, ch, ca, cdate):
        opts = self._by.get((league, ch, ca))
        if opts:
            v = self._pick(opts, cdate)
            if v is not None:
                return v
        cands = [(d, v) for (h, a, d, v) in self._by_league.get(league, [])
                 if X._name_match(ch, h) and X._name_match(ca, a)]
        if cands:
            return self._pick(cands, cdate)
        return None


def boot_ci(profits, n=2000, seed=42):
    rng = np.random.default_rng(seed)
    idx = np.arange(len(profits))
    rois = [profits[rng.choice(idx, len(idx), True)].mean() * 100 for _ in range(n)]
    return float(np.percentile(rois, 2.5)), float(np.percentile(rois, 97.5))


def season_result(name, df, odds: DrawOdds):
    pscd = np.array([odds.resolve(r.league, r.ch, r.ca, r.cdate) for r in df.itertuples(index=False)], dtype=float)
    has = np.isfinite(pscd)
    p_draw, is_draw = df["p_draw"].to_numpy()[has], df["is_draw"].to_numpy()[has]
    pscd = pscd[has]
    implied = 1.0 / pscd
    out = {"n_matches_with_odds": int(has.sum()), "edges": []}
    for e in EDGES:
        bet = p_draw > implied + e
        nb = int(bet.sum())
        if nb < 10:
            out["edges"].append({"edge_pp": e * 100, "n_bets": nb, "roi_pct": None}); continue
        profit = np.where(is_draw[bet] == 1, pscd[bet] - 1, -1.0)
        roi = float(profit.mean() * 100)
        lo, hi = boot_ci(profit)
        out["edges"].append({"edge_pp": e * 100, "n_bets": nb, "win_rate": float(is_draw[bet].mean()),
                             "mean_odds": float(pscd[bet].mean()), "roi_pct": round(roi, 2),
                             "ci95": [round(lo, 2), round(hi, 2)], "ci_excludes_0": bool(lo > 0)})
    return out


def main() -> int:
    seasons = [
        ("25/26", "dev-03", "dev-09-phase42-seed-000", BT / "odds-close-25-26.parquet", "discovery"),
        ("24/25", "dev-03-2h", "dev-09-2h", BT / "odds-close-24-25.parquet", "OOT-replication"),
    ]
    print("═" * 74)
    print("DRAW-VALUE FALSIFICATION · bet draw when Blend P(draw) > Pinnacle-implied")
    print("═" * 74)
    results = {}
    for season, d03t, d09t, oddsf, role in seasons:
        print(f"\n── {season} ({role}) · {d03t} ⊕ {d09t} ──")
        df = predict_blend_draws(season, d03t, d09t)
        odds = DrawOdds(oddsf)
        r = season_result(season, df, odds)
        r["role"] = role
        results[season] = r
        print(f"  n with odds: {r['n_matches_with_odds']:,}")
        for e in r["edges"]:
            if e["roi_pct"] is None:
                print(f"    edge≥{int(e['edge_pp'])}pp: n={e['n_bets']} (zu wenig)"); continue
            sig = "✓CI>0" if e["ci_excludes_0"] else "ci~0"
            print(f"    edge≥{int(e['edge_pp'])}pp: ROI {e['roi_pct']:+6.2f}%  CI[{e['ci95'][0]:+.1f},{e['ci95'][1]:+.1f}] {sig}  "
                  f"n={e['n_bets']} win{e['win_rate']:.0%} @{e['mean_odds']:.2f}")

    # ── verdict ──
    def roi0(s):
        return next((e for e in results[s]["edges"] if e["edge_pp"] == 0 and e["roi_pct"] is not None), None)
    disc, oot = roi0("25/26"), roi0("24/25")
    disc_pos = bool(disc and disc["roi_pct"] > 0)
    oot_pos = bool(oot and oot["roi_pct"] > 0)
    oot_sig = bool(oot and oot["ci_excludes_0"])
    if disc_pos and oot_pos and oot_sig:
        verdict = "VALIDATED — draw-value POSITIVE on discovery AND OOT (24/25 CI>0) → real edge"
    elif disc_pos and oot_pos:
        verdict = ("DIRECTIONAL — positive on both seasons but 24/25 CI straddles 0; "
                   "promising, needs 3rd season / larger n before staking")
    elif disc_pos and not oot_pos:
        verdict = "NOT REPLICATED — positive 25/26 but flat/negative on 24/25 OOT → likely 25/26 noise"
    else:
        verdict = "REJECTED — not positive even on discovery"
    out = {"rule": "bet draw when Blend P(draw) > 1/pscd + edge",
           "primary_metric": "edge≥0pp ROI (pre-registered, largest n)",
           "seasons": results,
           "discovery_25_26_edge0_roi": disc["roi_pct"] if disc else None,
           "oot_24_25_edge0_roi": oot["roi_pct"] if oot else None,
           "oot_24_25_ci_excludes_0": oot_sig, "verdict": verdict}
    OUT.write_text(json.dumps(out, indent=2, default=float))
    print("\n" + "═" * 74)
    print(f"VERDIKT: {verdict}")
    print(f"  25/26 edge≥0 ROI {disc['roi_pct'] if disc else '?'}% · 24/25 OOT edge≥0 ROI {oot['roi_pct'] if oot else '?'}% "
          f"(CI {oot['ci95'] if oot else '?'})")
    print(f"  ✓ {OUT.relative_to(REPO)}")
    print("═" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
