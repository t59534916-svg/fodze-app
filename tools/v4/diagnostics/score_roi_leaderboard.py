#!/usr/bin/env python3
"""score_roi_leaderboard — unified flat-stake ROI across ALL engines (tiebreaker).

The SECONDARY tiebreaker under the new forecast-quality objective. The prior
ROI numbers (+5.4% dev-03 Stage-5-Kelly vs -2.08% dev-09 G5-flat) came from
DIFFERENT setups → not comparable. This runs every engine through ONE identical
flat-stake simulation vs the same Pinnacle 25/26 closing odds, on a common
match universe, so the ROI ranking is apples-to-apples.

Engines: Standard / v1 / v2 (stored raw probs from *-oot-predictions.parquet)
+ dev-03 / dev-09 (live from pickles). All bet RAW probs (no isotonic) — the
same probabilities the xG-forecast leaderboard scored, so ROI and forecast are
measured on the same model output.

Method (per engine, per match, per outcome H/D/A):
  edge = model_prob − market_implied (1/odds, vig-included)
  bet 1u whenever edge > --min-edge  →  profit = (odds−1) if win else −1
  ROI = total_profit / n_bets

Odds join reuses the tiered fuzzy resolver (exact → normalized → substring,
within league + nearest-date ±7d) so dev-03/dev-09 (Sofa UTC dates +
name-divergent canonicals) get the same high coverage as the parquet engines.

Common universe: matches where ALL engines have a prediction AND Pinnacle odds
→ every engine bets within the identical universe (its own edges).

Directional bar (audit-binding 2026-05-28): mean ROI > Pinnacle vig (~2.5-3%).
NO CI>0 hurdle (impossible at these n with σ_bet≈148%). This is a tiebreaker,
not a gate — forecast quality (xG-RMSE+Brier) is primary.

Output: tools/v4/diagnostics/score_roi_leaderboard.json

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/score_roi_leaderboard.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/score_roi_leaderboard.py --min-edge 0.02
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, Optional

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

import score_xg_forecast as X  # reuse engine builders + _name_match + _outcome
from v4.modules.m3_xg import DEFAULT_RHO
from v4.modules.m3_xg.canonical_team_map import canonical_team

ODDS_PARQUET = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "score_roi_leaderboard.json"
WINDOW = X.JOIN_WINDOW_DAYS
PINNACLE_VIG_FLOOR = 0.025


def vig_remove(psch, pscd, psca):
    if any(o is None or o <= 1 or np.isnan(o) for o in (psch, pscd, psca)):
        return np.nan
    s = 1.0 / psch + 1.0 / pscd + 1.0 / psca
    return float(s - 1.0)


class OddsSpine:
    """Pinnacle closing odds with the same tiered fuzzy resolver as XGSpine."""

    def __init__(self):
        od = pd.read_parquet(ODDS_PARQUET).dropna(subset=["psch", "pscd", "psca"]).reset_index(drop=True)
        od["ch"] = od.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
        od["ca"] = od.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
        od["d"] = pd.to_datetime(od["match_date"]).dt.date
        od["mid"] = od.index
        self._df = od
        self._exact: Dict[tuple, list] = defaultdict(list)
        self._by_league: Dict[str, list] = defaultdict(list)
        for r in od.itertuples(index=False):
            self._exact[(r.league, r.ch, r.ca)].append((r.d, int(r.mid)))
            self._by_league[r.league].append((r.ch, r.ca, r.d, int(r.mid)))

    def _pick(self, opts, cdate):
        best = min(opts, key=lambda o: abs((o[0] - cdate).days))
        return best[1] if abs((best[0] - cdate).days) <= WINDOW else None

    def resolve(self, league, ch, ca, cdate) -> Optional[int]:
        opts = self._exact.get((league, ch, ca))
        if opts:
            mid = self._pick(opts, cdate)
            if mid is not None:
                return mid
        cands = [(d, mid) for (h, a, d, mid) in self._by_league.get(league, [])
                 if X._name_match(ch, h) and X._name_match(ca, a)]
        if cands:
            return self._pick(cands, cdate)
        return None


def attach_odds(pf: pd.DataFrame, spine: OddsSpine) -> pd.DataFrame:
    mids = [spine.resolve(r.league, r.ch, r.ca, r.cdate) for r in pf.itertuples(index=False)]
    pf = pf.assign(omid=[m if m is not None else -1 for m in mids])
    od = spine._df
    pf = pf.assign(
        psch=[od.iloc[m]["psch"] if m >= 0 else np.nan for m in pf["omid"]],
        pscd=[od.iloc[m]["pscd"] if m >= 0 else np.nan for m in pf["omid"]],
        psca=[od.iloc[m]["psca"] if m >= 0 else np.nan for m in pf["omid"]],
    )
    return pf


def simulate(pf: pd.DataFrame, min_edge: float, universe: Optional[set] = None) -> dict:
    """Flat-stake ROI over the joinable (optionally universe-restricted) matches."""
    m = pf["omid"] >= 0
    if universe is not None:
        m = m & pf["omid"].isin(universe)
    sub = pf[m]
    profits, leagues, won_flags = [], [], []
    odds_cols = [("p_h", "psch", 0), ("p_d", "pscd", 1), ("p_a", "psca", 2)]
    for r in sub.itertuples(index=False):
        y = X._outcome(r.y_h, r.y_a)
        for pcol, ocol, idx in odds_cols:
            odds = getattr(r, ocol)
            if odds is None or np.isnan(odds) or odds <= 1:
                continue
            edge = getattr(r, pcol) - 1.0 / odds
            if edge > min_edge:
                profits.append((odds - 1.0) if y == idx else -1.0)
                won_flags.append(y == idx)
                leagues.append(r.league)
    if not profits:
        return {"n_bets": 0, "n_matches": int(m.sum())}
    profits = np.array(profits, float)
    n = len(profits)
    roi = float(profits.mean() * 100)
    se = float(profits.std(ddof=1) * 100 / np.sqrt(n))
    return {
        "n_matches": int(m.sum()), "n_bets": n, "win_rate_pct": float(100 * np.mean(won_flags)),
        "total_profit_u": float(profits.sum()), "roi_pct": roi, "se_roi_pct": se,
        "_profits": profits, "_leagues": leagues, "_won": won_flags,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-seasons", default="25/26")
    ap.add_argument("--min-edge", type=float, default=0.0, help="min edge (pp/100); 0.02 = 2pp")
    ap.add_argument("--rho", type=float, default=DEFAULT_RHO)
    args = ap.parse_args()
    test_seasons = tuple(args.test_seasons.split(","))

    print("═" * 76)
    print(f"UNIFIED ROI LEADERBOARD · {test_seasons} vs Pinnacle closing · min-edge {args.min_edge*100:.1f}pp")
    print("  (secondary tiebreaker — forecast quality is primary)")
    print("═" * 76)

    spine = OddsSpine()
    print(f"  Pinnacle closing spine: {len(spine._df):,} matches")

    engines: Dict[str, pd.DataFrame] = {
        "Standard": X.parquet_engine(X.BACKTEST_DIR / "ensemble-v1-oot-predictions.parquet"),
        "v1": X.parquet_engine(X.BACKTEST_DIR / "v1-oot-predictions.parquet"),
        "v2": X.parquet_engine(X.BACKTEST_DIR / "v2-oot-predictions.parquet"),
    }
    engines.update(X.corpus_engines(test_seasons, args.rho))
    for name in engines:
        engines[name] = attach_odds(engines[name], spine)
        cov = (engines[name]["omid"] >= 0).mean()
        print(f"    {name:<10} odds-join {100*cov:>5.1f}%")
    print()

    # Common universe: matches with odds present for ALL engines
    omid_sets = [set(pf.loc[pf["omid"] >= 0, "omid"]) for pf in engines.values()]
    universe = set.intersection(*omid_sets) if omid_sets else set()
    print(f"  common universe (odds + all-engine preds): {len(universe):,} matches\n")

    results = {name: simulate(pf, args.min_edge, universe) for name, pf in engines.items()}

    print("─" * 76)
    print(f"  {'engine':<10} {'n_bets':>7} {'win%':>6} {'ROI%':>8} {'±SE':>6}  {'vs vig 2.5%'}")
    print("─" * 76)
    for name in sorted(results, key=lambda k: -results[k].get("roi_pct", -99)):
        s = results[name]
        if s.get("n_bets", 0) == 0:
            print(f"  {name:<10}  (no bets)"); continue
        mark = "✓ beats vig" if s["roi_pct"] > PINNACLE_VIG_FLOOR * 100 else ("· positive" if s["roi_pct"] > 0 else "✗ negative")
        print(f"  {name:<10} {s['n_bets']:>7,} {s['win_rate_pct']:>5.1f}% {s['roi_pct']:>+7.2f}% "
              f"±{s['se_roi_pct']:>4.2f}  {mark}")
    print()

    # dev-09 vs dev-03 head-to-head (the live tiebreaker)
    d9, d3 = results.get("dev-09", {}), results.get("dev-03", {})
    if d9.get("n_bets") and d3.get("n_bets"):
        print(f"  TIEBREAKER dev-09 vs dev-03 ROI: {d9['roi_pct']:+.2f}% vs {d3['roi_pct']:+.2f}% "
              f"→ {'dev-09' if d9['roi_pct'] > d3['roi_pct'] else 'dev-03'} better")
    print()

    out = {
        "objective_role": "SECONDARY tiebreaker (forecast quality primary)",
        "test_seasons": list(test_seasons), "min_edge_pp": args.min_edge * 100,
        "n_common_universe": len(universe),
        "directional_bar_pct": PINNACLE_VIG_FLOOR * 100,
        "engines": {n: {k: v for k, v in s.items() if not k.startswith("_")} for n, s in results.items()},
        "_caveats": [
            "Flat-stake, RAW probs, identical universe + odds for all engines.",
            "Directional bar only (ROI > vig); no CI>0 hurdle (σ_bet≈148%).",
            "Odds join via tiered fuzzy resolver (same as xG leaderboard).",
        ],
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print("═" * 76)
    print(f"  ✓ {OUT_PATH.relative_to(REPO_ROOT)}")
    print("═" * 76)
    return 0


if __name__ == "__main__":
    sys.exit(main())
