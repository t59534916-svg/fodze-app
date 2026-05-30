#!/usr/bin/env python3
"""analyze_ou_vs_market — does the production engine BEAT PINNACLE on Over/Under 2.5?

The decisive test the whole O/U + combo direction gates on. Fixes the blind spot
found in the 2026-05-29 double-check: the backtest PARQUET has ~1% O/U closing,
but the canonical Supabase `odds_closing_history` has ~80% (24,617 rows). So the
market comparison I'd called "impossible" is eminently possible — here on ~7.7k
matches (24/25 + 25/26) with Pinnacle O/U-2.5 closing lines.

Production path: dev-03 λ → Dixon-Coles → P(over2.5) via get_ou. Market: psc_over25
/ psc_under25, vig-removed. Truth: ft_goals.

Tests (mirror of analyze_pick_quality's 1X2 logic, plus the money test):
  - accuracy: ours (P>0.5) vs market (implied>0.5) vs base-rate
  - Brier: ours vs market
  - DISAGREEMENT head-to-head: where our O/U pick ≠ market's, who is right?
  - FLAT-STAKE ROI vs the CLOSING line at edge thresholds — betting into the
    sharpest price; +ROI here is the strongest possible evidence of real edge.
  - per-league ROI + accuracy

CAVEAT: P(over) from plain Dixon-Coles (no per-league overdispersion-α that
production's matrix adds; α sharpens O/U tails). Accuracy robust; Brier/ROI
approximate to production by a small amount.

Output: tools/v4/diagnostics/analyze_ou_vs_market.json
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/analyze_ou_vs_market.py
"""
from __future__ import annotations

import json
import sys
import urllib.request
import urllib.parse
from collections import defaultdict
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd

import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_ou
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
RHO = DEFAULT_RHO
WINDOW = 7
_HIST = None


def _env(k):
    for line in (REPO / ".env.local").read_text().splitlines():
        if line.startswith(k + "="):
            return line.split("=", 1)[1].strip()
    return None


def fetch_closing_ou(since="2024-08-01") -> pd.DataFrame:
    url = _env("NEXT_PUBLIC_SUPABASE_URL")
    key = _env("SUPABASE_SERVICE_ROLE_KEY") or _env("SUPABASE_SERVICE_KEY")
    cols = "league,match_date,home_team,away_team,psc_over25,psc_under25,ft_goals_h,ft_goals_a"
    rows, offset = [], 0
    while True:
        q = (f"{url}/rest/v1/odds_closing_history?select={cols}"
             f"&psc_over25=not.is.null&ft_goals_h=not.is.null&match_date=gte.{since}"
             f"&order=match_date.asc&limit=1000&offset={offset}")
        req = urllib.request.Request(q, headers={"apikey": key, "Authorization": f"Bearer {key}"})
        batch = json.loads(urllib.request.urlopen(req, timeout=60).read())
        if not batch:
            break
        rows.extend(batch)
        offset += 1000
        if len(batch) < 1000:
            break
    df = pd.DataFrame(rows)
    df["ch"] = df.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    df["ca"] = df.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    df["d"] = pd.to_datetime(df["match_date"]).dt.date
    for c in ("psc_over25", "psc_under25", "ft_goals_h", "ft_goals_a"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.dropna(subset=["psc_over25", "psc_under25", "ft_goals_h", "ft_goals_a"]).reset_index(drop=True)


class OUSpine:
    def __init__(self, df):
        self._df = df
        self._exact = defaultdict(list)
        self._byl = defaultdict(list)
        for i, r in enumerate(df.itertuples(index=False)):
            self._exact[(r.league, r.ch, r.ca)].append((r.d, i))
            self._byl[r.league].append((r.ch, r.ca, r.d, i))

    def _pick(self, opts, cd):
        b = min(opts, key=lambda o: abs((o[0] - cd).days))
        return b[1] if abs((b[0] - cd).days) <= WINDOW else None

    def resolve(self, lg, ch, ca, cd):
        o = self._exact.get((lg, ch, ca))
        if o:
            m = self._pick(o, cd)
            if m is not None:
                return m
        cands = [(d, i) for (h, a, d, i) in self._byl.get(lg, []) if X._name_match(ch, h) and X._name_match(ca, a)]
        return self._pick(cands, cd) if cands else None


def p_over_from_lambdas(lh, la):
    out = np.empty(len(lh))
    for i in range(len(lh)):
        try:
            M = DixonColesModel(lh[i], la[i], rho=RHO).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lh[i], la[i]).matrix(normalize=True)
        out[i] = get_ou(M, 2.5)["over"]
    return out


def build(season, tag, spine: OUSpine):
    global _HIST
    d03 = XGPredictor.from_artifacts(home_path=ART / f"m3_xg-home-{tag}.pkl",
                                     away_path=ART / f"m3_xg-away-{tag}.pkl", rho=RHO)
    fb = FeatureBuilderDev09(REPO / "tools/sofascore/data/local_extras.db").fit()
    t = fb.build_corpus(seasons=(season,), leagues=None, verbose=False)
    t["ch"] = t.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    t["ca"] = t.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    if _HIST is None:
        _HIST = load_team_xg_history()
    din = pd.DataFrame({"league": t["league"].astype(str), "match_date": pd.to_datetime(t["match_date"]).dt.normalize(),
                        "home": t["ch"], "away": t["ca"], "home_goals": t["home_goals"], "away_goals": t["away_goals"]})
    dp = d03.predict_batch(din, _HIST, verbose=False)
    lh = np.clip(dp["lambda_h"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    la = np.clip(dp["lambda_a"].to_numpy(float), X.LAMBDA_MIN, X.LAMBDA_MAX)
    pov = p_over_from_lambdas(lh, la)
    lg = t["league"].astype(str).to_numpy()
    cd = pd.to_datetime(t["match_date"]).dt.date.to_numpy()
    rows = []
    for i in range(len(t)):
        mid = spine.resolve(lg[i], t["ch"].iloc[i], t["ca"].iloc[i], cd[i])
        if mid is None:
            continue
        r = spine._df.iloc[mid]
        oo, ou = float(r["psc_over25"]), float(r["psc_under25"])
        if oo <= 1 or ou <= 1:
            continue
        impl_over = (1 / oo) / (1 / oo + 1 / ou)  # vig-removed market P(over)
        over = int(r["ft_goals_h"] + r["ft_goals_a"] >= 3)
        rows.append({"league": lg[i], "p_over": pov[i], "impl_over": impl_over,
                     "o_over": oo, "o_under": ou, "over": over})
    return rows


def roi(rows, thr):
    prof, won, n = [], 0, 0
    for r in rows:
        edge_o = r["p_over"] - r["impl_over"]
        edge_u = r["impl_over"] - r["p_over"]
        if edge_o > thr:
            n += 1; win = r["over"] == 1
            prof.append((r["o_over"] - 1) if win else -1); won += win
        elif edge_u > thr:
            n += 1; win = r["over"] == 0
            prof.append((r["o_under"] - 1) if win else -1); won += win
    if not prof:
        return {"n_bets": 0}
    return {"n_bets": n, "win_pct": won / n, "roi_pct": 100 * float(np.mean(prof))}


def analyze(rows, season):
    n = len(rows)
    pov = np.array([r["p_over"] for r in rows])
    impl = np.array([r["impl_over"] for r in rows])
    over = np.array([r["over"] for r in rows])
    lg = np.array([r["league"] for r in rows])

    our_pick, mk_pick = (pov > 0.5).astype(int), (impl > 0.5).astype(int)
    base_over = float(over.mean())
    acc = {"ours": float((our_pick == over).mean()), "market": float((mk_pick == over).mean()),
           "always_majority": max(base_over, 1 - base_over), "base_over_rate": base_over}
    brier = {"ours": float(((pov - over) ** 2).mean()), "market": float(((impl - over) ** 2).mean()),
             "base": float(((np.full(n, base_over) - over) ** 2).mean())}
    dis = our_pick != mk_pick
    nd = int(dis.sum())
    h2h = {"n_disagree": nd, "pct": float(dis.mean()),
           "ours_hit": float((our_pick[dis] == over[dis]).mean()) if nd else None,
           "market_hit": float((mk_pick[dis] == over[dis]).mean()) if nd else None}
    roi_tbl = {f"edge>{int(t*100)}pp": roi(rows, t) for t in (0.0, 0.02, 0.05)}
    # per-league ROI @ edge>2pp + accuracy
    pl = {}
    for L in sorted(set(lg)):
        m = lg == L
        if m.sum() < 40:
            continue
        sub = [r for r in rows if r["league"] == L]
        pl[L] = {"n": int(m.sum()), "acc_ours": float((our_pick[m] == over[m]).mean()),
                 "acc_market": float((mk_pick[m] == over[m]).mean()), "roi_edge2": roi(sub, 0.02)}
    return {"season": season, "n": n, "acc": acc, "brier": brier, "h2h": h2h,
            "roi": roi_tbl, "per_league": pl}


def _print(res):
    print("═" * 80)
    print(f"  {res['season']}  ·  n={res['n']} matches with Pinnacle O/U-2.5 closing (Supabase)")
    print("═" * 80)
    a, b, h = res["acc"], res["brier"], res["h2h"]
    print(f"  accuracy: ours {a['ours']:.1%} · MARKET {a['market']:.1%} · majority {a['always_majority']:.1%}")
    print(f"  Brier:    ours {b['ours']:.4f} · market {b['market']:.4f} · base {b['base']:.4f}  "
          f"({'BEATS' if b['ours']<b['market'] else 'loses to'} market on Brier)")
    if h["n_disagree"]:
        print(f"  DISAGREEMENT: on {h['pct']:.0%} where our O/U pick ≠ market — ours {h['ours_hit']:.1%} vs market {h['market_hit']:.1%}"
              f"  ⇒ {'WE win' if h['ours_hit']>h['market_hit'] else 'MARKET wins (our O/U disagreements are noise)'}")
    print(f"  ── FLAT-STAKE ROI vs CLOSING line (bet our edge; vig ~2.5-3%) ──")
    for k, v in res["roi"].items():
        if v.get("n_bets"):
            mark = "✓ +EV" if v["roi_pct"] > 0 else "✗"
            print(f"    {k:<10} n={v['n_bets']:<5} win {v['win_pct']:.1%} · ROI {v['roi_pct']:+.2f}%  {mark}")
    # best/worst leagues by ROI
    pl = res["per_league"]
    with_roi = {k: v for k, v in pl.items() if v["roi_edge2"].get("n_bets", 0) >= 20}
    best = sorted(with_roi.items(), key=lambda kv: -kv[1]["roi_edge2"]["roi_pct"])[:4]
    worst = sorted(with_roi.items(), key=lambda kv: kv[1]["roi_edge2"]["roi_pct"])[:3]
    print(f"  ── per-league ROI @ edge>2pp (n_bets≥20) ──")
    for tag, items in [("best ", best), ("worst", worst)]:
        for L, v in items:
            rr = v["roi_edge2"]
            print(f"    [{tag}] {L:<15} n={rr['n_bets']:<4} ROI {rr['roi_pct']:+.1f}% (acc ours {v['acc_ours']:.0%} vs mkt {v['acc_market']:.0%})")


def main() -> int:
    print("fetching Pinnacle O/U closing from Supabase odds_closing_history …")
    df = fetch_closing_ou("2024-08-01")
    print(f"  ✓ {len(df)} closing-O/U rows (24/25+25/26)")
    spine = OUSpine(df)
    out = {}
    for season, tag in [("25/26", "dev-03"), ("24/25", "dev-03-2h")]:
        rows = build(season, tag, spine)
        res = analyze(rows, season)
        _print(res)
        out[season] = res
    # verdict (25/26 primary)
    pr = out["25/26"]
    roi0 = pr["roi"].get("edge>2pp", {})
    beats_brier = pr["brier"]["ours"] < pr["brier"]["market"]
    wins_dis = pr["h2h"]["ours_hit"] and pr["h2h"]["market_hit"] and pr["h2h"]["ours_hit"] > pr["h2h"]["market_hit"]
    pos_roi = roi0.get("roi_pct", -99) > 0
    verdict = (
        f"O/U 2.5 vs Pinnacle (25/26 n={pr['n']}): accuracy ours {pr['acc']['ours']:.1%} vs market "
        f"{pr['acc']['market']:.1%}; Brier ours {pr['brier']['ours']:.4f} vs {pr['brier']['market']:.4f} "
        f"({'beats' if beats_brier else 'LOSES'}). Disagreement: ours {pr['h2h']['ours_hit']:.1%} vs market "
        f"{pr['h2h']['market_hit']:.1%} ({'we win' if wins_dis else 'market wins'}). "
        f"Flat-stake ROI @edge>2pp: {roi0.get('roi_pct', float('nan')):+.2f}% on {roi0.get('n_bets',0)} bets "
        f"({'+EV vs closing line!' if pos_roi else 'negative — no edge at the closing line'}). "
        f"VERDICT: {'O/U shows a real edge — pursue per-league + combos' if (pos_roi and wins_dis) else 'O/U does NOT beat Pinnacle closing — same story as 1X2; combo thesis (needs accurate O/U legs) is likely dead too'}."
    )
    print("\n" + "─" * 80)
    print(f"  {verdict}")
    out["verdict"] = verdict
    (D / "analyze_ou_vs_market.json").write_text(json.dumps(out, indent=2, default=float))
    print(f"  ✓ {(D / 'analyze_ou_vs_market.json').relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
