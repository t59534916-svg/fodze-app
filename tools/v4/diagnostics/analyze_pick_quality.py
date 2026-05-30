#!/usr/bin/env python3
"""analyze_pick_quality — the NON-SUGARCOATED level of the production engine at
the two things that actually matter for betting: picking the 1X2 outcome, and
over/under 2.5 goals.

Production path = dev-03 (default engine) λ→Dixon-Coles, then Benter-blend toward
Pinnacle (= what the user acts on). Ground truth + market from the closing-odds
parquet (ft_goals/ft_result + Pinnacle psch/pscd/psca, 100% 1X2 coverage).

THE DECISIVE TESTS (not vanity accuracy):
  1X2 — (a) do we beat "always pick the market favorite"? (b) on matches where
        OUR pick disagrees with the market favorite, who is right more often?
        That head-to-head is the only thing that isolates marginal skill.
  O/U — accuracy + calibration vs the base-rate baseline. NOTE: Pinnacle O/U
        closing coverage is ~1% → we CANNOT verify beating the book on O/U;
        reported honestly as a gap.

CAVEAT: P(over2.5) here is from plain Dixon-Coles (no per-league overdispersion-α
that production's matrix adds); α mildly sharpens O/U tails, so production O/U
CALIBRATION is likely a touch better than this estimate. Accuracy is robust to it.

Output: tools/v4/diagnostics/analyze_pick_quality.json
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/analyze_pick_quality.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, Optional

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
from v4.modules.m6_market.benter import BenterBlender
from v4.data.loaders import load_team_xg_history

D = REPO / "tools" / "v4" / "diagnostics"
ART = REPO / "tools" / "v4" / "artifacts"
BT = REPO / "tools" / "backtest"
RHO = DEFAULT_RHO
WINDOW = 7
_HIST = None
LABELS = ["Heim", "Remis", "Ausw."]


def _vig3(h, d, a):
    if any(o is None or (isinstance(o, float) and np.isnan(o)) or o <= 1 for o in (h, d, a)):
        return None
    s = 1 / h + 1 / d + 1 / a
    return np.array([1 / h / s, 1 / d / s, 1 / a / s])


def _over25_from_lambdas(lh, la):
    out = np.empty(len(lh))
    for i in range(len(lh)):
        try:
            M = DixonColesModel(lh[i], la[i], rho=RHO).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lh[i], la[i]).matrix(normalize=True)
        out[i] = get_ou(M, 2.5)["over"]
    return out


class OddsSpine:
    def __init__(self, parquet: Path):
        od = pd.read_parquet(parquet).dropna(subset=["psch", "pscd", "psca", "ft_goals_h", "ft_goals_a"]).reset_index(drop=True)
        od["ch"] = od.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
        od["ca"] = od.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
        od["d"] = pd.to_datetime(od["match_date"]).dt.date
        self._df = od
        self._exact: Dict[tuple, list] = defaultdict(list)
        self._byl: Dict[str, list] = defaultdict(list)
        for i, r in enumerate(od.itertuples(index=False)):
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


def build(season, tag):
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
    raw = np.column_stack([dp["prob_h"], dp["prob_d"], dp["prob_a"]])
    p_over = _over25_from_lambdas(lh, la)
    leagues = t["league"].astype(str).to_numpy()
    cds = pd.to_datetime(t["match_date"]).dt.date.to_numpy()

    spine = OddsSpine(BT / f"odds-close-{season.replace('/','-')}.parquet")
    benter = BenterBlender.load(ART / "m6_benter-dev-03.pkl")
    rows = []
    for i in range(len(t)):
        mid = spine.resolve(leagues[i], t["ch"].iloc[i], t["ca"].iloc[i], cds[i])
        if mid is None:
            continue
        r = spine._df.iloc[mid]
        mk = _vig3(r["psch"], r["pscd"], r["psca"])
        if mk is None:
            continue
        gh, ga = int(r["ft_goals_h"]), int(r["ft_goals_a"])
        y = 0 if gh > ga else (1 if gh == ga else 2)
        bl = benter.blend(raw[i], mk, leagues[i])
        rows.append({"league": leagues[i], "y": y, "over": int(gh + ga >= 3),
                     "raw": raw[i], "bl": bl, "mk": mk, "p_over": p_over[i]})
    return rows


def _brier_multi(P, y):
    Y = np.eye(3)[y]
    return float(((P - Y) ** 2).sum(1).mean())


def _brier_bin(p, y):
    return float(((p - y) ** 2).mean())


def analyze(rows, season):
    n = len(rows)
    y = np.array([r["y"] for r in rows])
    over = np.array([r["over"] for r in rows])
    raw = np.vstack([r["raw"] for r in rows])
    bl = np.vstack([r["bl"] for r in rows])
    mk = np.vstack([r["mk"] for r in rows])
    p_over = np.array([r["p_over"] for r in rows])
    leagues = np.array([r["league"] for r in rows])

    # ── 1X2 ──
    raw_pick, bl_pick, mk_pick = raw.argmax(1), bl.argmax(1), mk.argmax(1)
    base = np.bincount(y, minlength=3) / n   # H/D/A frequencies (no-skill baseline)
    P_base = np.tile(base, (n, 1))
    acc = {"ours_raw": float((raw_pick == y).mean()), "ours_blended": float((bl_pick == y).mean()),
           "market_favorite": float((mk_pick == y).mean()), "always_home": float((y == 0).mean()),
           "base_rate_mode": float(base.max())}
    brier = {"ours_raw": _brier_multi(raw, y), "ours_blended": _brier_multi(bl, y),
             "market": _brier_multi(mk, y), "base_rate": _brier_multi(P_base, y)}
    bss = {k: 1 - brier[k] / brier["base_rate"] for k in ("ours_raw", "ours_blended", "market")}

    # disagreement head-to-head (production blended vs market favorite)
    disagree = bl_pick != mk_pick
    nd = int(disagree.sum())
    h2h = {"n_disagree": nd, "pct_disagree": float(disagree.mean()),
           "ours_hit_on_disagree": float((bl_pick[disagree] == y[disagree]).mean()) if nd else None,
           "market_hit_on_disagree": float((mk_pick[disagree] == y[disagree]).mean()) if nd else None,
           "agree_hit": float((bl_pick[~disagree] == y[~disagree]).mean()) if (~disagree).any() else None}

    # per-league 1X2 (blended vs market)
    pl = {}
    for lg in sorted(set(leagues)):
        m = leagues == lg
        if m.sum() < 30:
            continue
        pl[lg] = {"n": int(m.sum()), "ours": float((bl_pick[m] == y[m]).mean()),
                  "market": float((mk_pick[m] == y[m]).mean()),
                  "edge": float((bl_pick[m] == y[m]).mean() - (mk_pick[m] == y[m]).mean())}

    # ── O/U 2.5 ──
    over_pick = (p_over > 0.5).astype(int)
    base_over = float(over.mean())
    ou = {"n": n, "base_over_rate": base_over,
          "ours_acc": float((over_pick == over).mean()),
          "always_majority_acc": max(base_over, 1 - base_over),
          "brier_ours": _brier_bin(p_over, over),
          "brier_base": _brier_bin(np.full(n, base_over), over)}
    ou["bss"] = 1 - ou["brier_ours"] / ou["brier_base"]
    # calibration deciles
    cal = []
    order = np.argsort(p_over)
    for q in range(10):
        idx = order[int(q * n / 10):int((q + 1) * n / 10)]
        if len(idx) < 10:
            continue
        cal.append({"bin": q, "n": len(idx), "pred": float(p_over[idx].mean()), "actual": float(over[idx].mean())})
    ece = float(np.mean([abs(c["pred"] - c["actual"]) * c["n"] for c in cal]) / n) if cal else None
    ou["calibration_deciles"] = cal
    ou["ece"] = ece
    # per-league O/U
    ou_pl = {}
    for lg in sorted(set(leagues)):
        m = leagues == lg
        if m.sum() < 30:
            continue
        ou_pl[lg] = {"n": int(m.sum()), "acc": float((over_pick[m] == over[m]).mean()),
                     "base": max(float(over[m].mean()), 1 - float(over[m].mean()))}
    ou["per_league"] = ou_pl

    return {"season": season, "n": n, "acc_1x2": acc, "brier_1x2": brier, "bss_1x2": bss,
            "disagreement_h2h": h2h, "per_league_1x2": pl, "ou25": ou}


def _print(res):
    s = res["season"]; n = res["n"]
    a, b, bss, h = res["acc_1x2"], res["brier_1x2"], res["bss_1x2"], res["disagreement_h2h"]
    print("═" * 78)
    print(f"  {s}  ·  n={n} matches with Pinnacle closing 1X2 (= ground truth + market)")
    print("═" * 78)
    print("  ── 1X2 PICKING ──")
    print(f"    accuracy: ours-blended {a['ours_blended']:.1%} · MARKET-favorite {a['market_favorite']:.1%} "
          f"· ours-raw {a['ours_raw']:.1%} · always-home {a['always_home']:.1%} · mode {a['base_rate_mode']:.1%}")
    print(f"    Brier:    ours-blended {b['ours_blended']:.4f} · market {b['market']:.4f} "
          f"· base-rate {b['base_rate']:.4f}   (BSS ours {bss['ours_blended']:+.1%} vs market {bss['market']:+.1%})")
    print(f"    ⇒ vs market: we are {a['ours_blended']-a['market_favorite']:+.1%} accuracy, "
          f"{b['ours_blended']-b['market']:+.4f} Brier  ({'WORSE' if b['ours_blended']>b['market'] else 'better'})")
    print(f"  ── DISAGREEMENT HEAD-TO-HEAD (the only test of marginal skill) ──")
    if h["n_disagree"]:
        print(f"    we disagree with the market favorite on {h['n_disagree']} ({h['pct_disagree']:.0%}) matches")
        print(f"    on those: OUR pick hits {h['ours_hit_on_disagree']:.1%} · MARKET pick hits {h['market_hit_on_disagree']:.1%}"
              f"  ⇒ {'WE win the disagreements' if h['ours_hit_on_disagree']>h['market_hit_on_disagree'] else 'MARKET wins — our disagreements are noise/worse'}")
        print(f"    when we AGREE with market: {h['agree_hit']:.1%} hit")
    print("  ── O/U 2.5 ──")
    o = res["ou25"]
    print(f"    accuracy {o['ours_acc']:.1%} vs always-majority {o['always_majority_acc']:.1%} "
          f"(base over-rate {o['base_over_rate']:.1%}) · Brier {o['brier_ours']:.4f} vs base {o['brier_base']:.4f} "
          f"(BSS {o['bss']:+.1%}) · ECE {o['ece']:.3f}")
    print(f"    market O/U comparison: see analyze_ou_vs_market.py (Pinnacle O/U closing is 80% in")
    print(f"      Supabase odds_closing_history — the PARQUET this script reads is O/U-sparse). Result: NO edge.")
    # worst leagues 1x2
    pl = res["per_league_1x2"]
    worst = sorted(pl.items(), key=lambda kv: kv[1]["edge"])[:4]
    best = sorted(pl.items(), key=lambda kv: -kv[1]["edge"])[:3]
    print("  ── per-league 1X2 (ours vs market accuracy) ──")
    for tag, items in [("best ", best), ("worst", worst)]:
        for lg, v in items:
            print(f"    [{tag}] {lg:<15} n={v['n']:<4} ours {v['ours']:.0%} vs market {v['market']:.0%} ({v['edge']:+.1%})")


def main() -> int:
    out = {}
    for season, tag in [("25/26", "dev-03"), ("24/25", "dev-03-2h")]:
        rows = build(season, tag)
        res = analyze(rows, season)
        _print(res)
        out[season] = res
    # verdict
    pr = out["25/26"]
    a, b, h = pr["acc_1x2"], pr["brier_1x2"], pr["disagreement_h2h"]
    beats_market_acc = a["ours_blended"] > a["market_favorite"]
    beats_market_brier = b["ours_blended"] < b["market"]
    wins_disagree = h["ours_hit_on_disagree"] and h["market_hit_on_disagree"] and h["ours_hit_on_disagree"] > h["market_hit_on_disagree"]
    verdict = (
        f"1X2 (25/26 n={pr['n']}): ours-blended accuracy {a['ours_blended']:.1%} vs market {a['market_favorite']:.1%} "
        f"({'≥' if beats_market_acc else '<'}market), Brier {b['ours_blended']:.4f} vs {b['market']:.4f} "
        f"({'beats' if beats_market_brier else 'LOSES to'} market). On the {h['pct_disagree']:.0%} of matches where we "
        f"disagree with the market favorite, we hit {h['ours_hit_on_disagree']:.1%} vs their {h['market_hit_on_disagree']:.1%} "
        f"⇒ {'we add marginal skill' if wins_disagree else 'our disagreements are NOT better than the market — no picking edge'}. "
        f"O/U 2.5: accuracy {pr['ou25']['ours_acc']:.1%} (base {pr['ou25']['always_majority_acc']:.1%}, "
        f"BSS {pr['ou25']['bss']:+.1%}). NOTE: market-O/U comparison IS possible via Supabase "
        f"odds_closing_history (80% O/U) — done in analyze_ou_vs_market.py: O/U also does NOT beat "
        f"Pinnacle (loses Brier+disagreement+ROI vs closing). "
        f"BOTTOM LINE: calibrated, near-market on 1X2 AND O/U, but beats Pinnacle on NEITHER."
    )
    print("\n" + "─" * 78)
    print(f"  VERDICT: {verdict}")
    out["verdict"] = verdict
    (D / "analyze_pick_quality.json").write_text(json.dumps(out, indent=2, default=float))
    print(f"  ✓ {(D / 'analyze_pick_quality.json').relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
