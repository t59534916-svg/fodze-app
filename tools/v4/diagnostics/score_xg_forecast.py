#!/usr/bin/env python3
"""score_xg_forecast — multi-engine xG-FORECAST leaderboard (new objective).

Objective change (2026-05-28): score for FORECAST QUALITY, not betting edge.
  PRIMARY (coupled): predicted λ (expected goals) vs REALIZED xG  →  xG-RMSE/MAE/bias
                     + the 1X2-Brier derived from the SAME λ.
  SECONDARY (tiebreaker, NOT a veto): Pinnacle ROI (see score_roi_leaderboard.py).

Engines scored on ONE common realized-xG spine (team_xg_history via
load_match_pairs):
  - Standard (ensemble-v1), v1 (poisson-ml), v2 (poisson-ml-v2):
        from tools/backtest/*-oot-predictions.parquet (stored λ + raw probs).
  - dev-03 (production) + dev-09 (archived): predicted live from the pickles
        on the Sofa-native 25/26 corpus.
All probabilities are RAW (no isotonic/benter) → model-vs-model, not pipeline.

Robust realized-xG join (fixes the 77% → ~99% coverage gap): key on
(league, canonical_home, canonical_away) and pick the nearest realized-xG row
within a ±7-day window. This (a) absorbs the Sofa UTC-timestamp off-by-one that
the parquet engines (clean date strings) didn't have, and (b) disambiguates the
310 double-round-robin pairings (austria_bl / scottish_prem / swiss_sl play the
same venue twice a season, months apart → nearest-date picks the right leg).

Two leaderboards:
  1. BEST-EFFORT — each engine on all its joinable 25/26 matches (max n).
  2. COMMON-INTERSECTION — only matches ALL engines predicted → strict paired
     ranking (the fair head-to-head).

Caveat (documented): realized xG is itself a model output (Understat/Sofa), not
ground truth like goals. Lower-variance to score against than goals, but it
measures agreement with another model's chance-quality estimate.

Output: tools/v4/diagnostics/score_xg_forecast.json

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/score_xg_forecast.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO, XGPredictor
from v4.modules.m3_xg.feature_builder_dev09 import FeatureBuilderDev09, extract_X_dev09
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.eval.metrics import xg_forecast_report
from v4.data.loaders import load_team_xg_history, load_match_pairs

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
BACKTEST_DIR = REPO_ROOT / "tools" / "backtest"
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
OUT_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "score_xg_forecast.json"

LAMBDA_MIN, LAMBDA_MAX = 0.05, 6.0
JOIN_WINDOW_DAYS = 7

# Prediction-frame contract: every engine is reduced to these columns.
#   league, ch (canonical home), ca (canonical away), cdate (date),
#   lam_h, lam_a, p_h, p_d, p_a, y_h (home goals), y_a (away goals)


def _outcome(h: int, a: int) -> int:
    return 0 if h > a else (2 if h < a else 1)


def _lambdas_to_1x2(lam_h: np.ndarray, lam_a: np.ndarray, rho: float) -> np.ndarray:
    n = len(lam_h)
    out = np.empty((n, 3))
    for i in range(n):
        try:
            M = DixonColesModel(lam_h[i], lam_a[i], rho=rho).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lam_h[i], lam_a[i]).matrix(normalize=True)
        p = get_1x2(M)
        out[i] = [p["H"], p["D"], p["A"]]
    return out


# ─── name-normalization for the cross-source bridge ──────────────────
# Sofa's canonical_team() and team_xg_history's stored canonical diverge for a
# meaningful slice (e.g. "SSC Napoli"↔"Napoli", "Liverpool FC"↔"Liverpool",
# "Wolverhampton"↔"Wolverhampton Wanderers"). We bridge with tiered matching
# instead of a hand-maintained alias list.

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # strip accents
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _tokens(s: str) -> set:
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return {t for t in re.sub(r"[^a-z0-9 ]", " ", s.lower()).split() if len(t) >= 4}


def _name_match(a: str, b: str) -> bool:
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if na in nb or nb in na:  # Liverpool ⊂ LiverpoolFC; Napoli ⊂ SSCNapoli
        return True
    return len(_tokens(a) & _tokens(b)) >= 1  # shared significant token (≥4 chars)


# ─── realized-xG spine + robust resolver (exact → fuzzy, nearest-date) ─

class XGSpine:
    def __init__(self, since: str = "2025-07-01"):
        sp = load_match_pairs(since=since).dropna(subset=["home_xg", "away_xg"]).reset_index(drop=True)
        sp["mid"] = sp.index
        self._df = sp
        # Tier-1: exact canonical-name index.
        self._cand: Dict[tuple, list] = defaultdict(list)
        # Tier-2/3: per-league rows for fuzzy fallback.
        self._by_league: Dict[str, list] = defaultdict(list)
        for r in sp.itertuples(index=False):
            row = (pd.Timestamp(r.match_date).date(), int(r.mid), float(r.home_xg), float(r.away_xg))
            self._cand[(r.league, r.home, r.away)].append(row)
            self._by_league[r.league].append((r.home, r.away) + row)
        self.tier_counts = {"exact": 0, "fuzzy": 0, "miss": 0}

    def _nearest(self, opts: list, cdate) -> Optional[Tuple[int, float, float]]:
        best = min(opts, key=lambda o: abs((o[0] - cdate).days))
        if abs((best[0] - cdate).days) > JOIN_WINDOW_DAYS:
            return None
        return best[1], best[2], best[3]

    def resolve(self, league: str, ch: str, ca, cdate) -> Optional[Tuple[int, float, float]]:
        # Tier 1: exact canonical key + nearest date.
        opts = self._cand.get((league, ch, ca))
        if opts:
            hit = self._nearest(opts, cdate)
            if hit:
                self.tier_counts["exact"] += 1
                return hit
        # Tier 2/3: fuzzy — both sides name-match within league, nearest date.
        cands = [(d, mid, hx, ax) for (h, a, d, mid, hx, ax) in self._by_league.get(league, [])
                 if _name_match(ch, h) and _name_match(ca, a)]
        if cands:
            hit = self._nearest(cands, cdate)
            if hit:
                self.tier_counts["fuzzy"] += 1
                return hit
        self.tier_counts["miss"] += 1
        return None


def attach_realized_xg(pf: pd.DataFrame, spine: XGSpine) -> pd.DataFrame:
    mids, rh, ra = [], [], []
    for r in pf.itertuples(index=False):
        res = spine.resolve(r.league, r.ch, r.ca, r.cdate)
        if res:
            mids.append(res[0]); rh.append(res[1]); ra.append(res[2])
        else:
            mids.append(-1); rh.append(np.nan); ra.append(np.nan)
    return pf.assign(mid=mids, real_h=rh, real_a=ra)


def score_engine(pf: pd.DataFrame, mid_filter: Optional[set] = None) -> dict:
    """xG-forecast report + Brier on the joinable subset (optionally restricted
    to a set of spine match-ids for the common-intersection leaderboard)."""
    m = pf["mid"] >= 0
    if mid_filter is not None:
        m = m & pf["mid"].isin(mid_filter)
    sub = pf[m]
    if len(sub) == 0:
        return {"n": 0}
    pred = np.concatenate([sub["lam_h"].to_numpy(float), sub["lam_a"].to_numpy(float)])
    real = np.concatenate([sub["real_h"].to_numpy(float), sub["real_a"].to_numpy(float)])
    rep = xg_forecast_report(pred, real)
    p = sub[["p_h", "p_d", "p_a"]].to_numpy(float)
    y = np.array([_outcome(h, a) for h, a in zip(sub["y_h"], sub["y_a"])], dtype=int)
    y1h = np.eye(3)[y]
    brier = float(((p - y1h) ** 2).sum(axis=1).mean())
    return {
        "n_matches": int(len(sub)),
        "xg_rmse": rep["rmse"], "xg_mae": rep["mae"], "xg_bias": rep["bias"],
        "pearson_r": rep["pearson_r"], "brier": brier,
        "mean_lambda": rep["mean_pred"], "mean_realized_xg": rep["mean_realized"],
    }


# ─── engine prediction-frame builders ────────────────────────────────

def parquet_engine(path: Path) -> pd.DataFrame:
    df = pd.read_parquet(path)
    ch = df.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    ca = df.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    return pd.DataFrame({
        "league": df["league"].astype(str),
        "ch": ch, "ca": ca,
        "cdate": pd.to_datetime(df["match_date"]).dt.date,
        "lam_h": np.clip(df["lambda_h_pred"], LAMBDA_MIN, LAMBDA_MAX),
        "lam_a": np.clip(df["lambda_a_pred"], LAMBDA_MIN, LAMBDA_MAX),
        "p_h": df["prob_h_raw"], "p_d": df["prob_d_raw"], "p_a": df["prob_a_raw"],
        "y_h": df["actual_h_goals"], "y_a": df["actual_a_goals"],
    })


def corpus_engines(test_seasons: tuple, rho: float) -> Dict[str, pd.DataFrame]:
    """dev-03 + dev-09 predicted live on the Sofa-native holdout corpus."""
    d09_h = BayesianEnsemble.load(ARTIFACTS_DIR / "m3_xg-home-dev-09-phase42-seed-000.pkl")
    d09_a = BayesianEnsemble.load(ARTIFACTS_DIR / "m3_xg-away-dev-09-phase42-seed-000.pkl")
    d03 = XGPredictor.from_artifacts(
        home_path=ARTIFACTS_DIR / "m3_xg-home-dev-03.pkl",
        away_path=ARTIFACTS_DIR / "m3_xg-away-dev-03.pkl", rho=rho)
    print("  ✓ dev-09 + dev-03 pickles loaded")

    fb = FeatureBuilderDev09(SQLITE_PATH).fit()
    test = fb.build_corpus(seasons=test_seasons, leagues=None, verbose=False)
    test["ch"] = test.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    test["ca"] = test.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    cdate = pd.to_datetime(test["match_date"]).dt.normalize().dt.date
    league = test["league"].astype(str)
    print(f"  ✓ Sofa holdout corpus: {len(test):,} matches")

    # dev-09 λ
    mh, _ = d09_h.predict(extract_X_dev09(test)[d09_h.feature_names])
    ma, _ = d09_a.predict(extract_X_dev09(test)[d09_a.feature_names])
    lam_h_09 = np.clip(mh, LAMBDA_MIN, LAMBDA_MAX)
    lam_a_09 = np.clip(ma, LAMBDA_MIN, LAMBDA_MAX)
    p09 = _lambdas_to_1x2(lam_h_09, lam_a_09, rho)
    dev09 = pd.DataFrame({
        "league": league.values, "ch": test["ch"].values, "ca": test["ca"].values, "cdate": cdate.values,
        "lam_h": lam_h_09, "lam_a": lam_a_09, "p_h": p09[:, 0], "p_d": p09[:, 1], "p_a": p09[:, 2],
        "y_h": test["home_goals"].values, "y_a": test["away_goals"].values,
    })

    # dev-03 (needs team_xg_history)
    d03_in = pd.DataFrame({
        "league": league, "match_date": pd.to_datetime(test["match_date"]).dt.normalize(),
        "home": test["ch"], "away": test["ca"],
        "home_goals": test["home_goals"], "away_goals": test["away_goals"],
    })
    history = load_team_xg_history()
    dp = d03.predict_batch(d03_in, history, verbose=False)
    dev03 = pd.DataFrame({
        "league": league.values, "ch": test["ch"].values, "ca": test["ca"].values, "cdate": cdate.values,
        "lam_h": np.clip(dp["lambda_h"], LAMBDA_MIN, LAMBDA_MAX),
        "lam_a": np.clip(dp["lambda_a"], LAMBDA_MIN, LAMBDA_MAX),
        "p_h": dp["prob_h"].values, "p_d": dp["prob_d"].values, "p_a": dp["prob_a"].values,
        "y_h": test["home_goals"].values, "y_a": test["away_goals"].values,
    })
    return {"dev-09": dev09, "dev-03": dev03}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-seasons", default="25/26")
    ap.add_argument("--rho", type=float, default=DEFAULT_RHO)
    args = ap.parse_args()
    test_seasons = tuple(args.test_seasons.split(","))

    print("═" * 76)
    print(f"xG-FORECAST LEADERBOARD · {test_seasons} · PRIMARY=xG-RMSE+Brier (coupled)")
    print("═" * 76)

    spine = XGSpine()
    print(f"  realized-xG spine: {len(spine._df):,} matches (team_xg_history)")

    engines: Dict[str, pd.DataFrame] = {}
    # Parquet engines (cheap)
    engines["Standard"] = parquet_engine(BACKTEST_DIR / "ensemble-v1-oot-predictions.parquet")
    engines["v1"] = parquet_engine(BACKTEST_DIR / "v1-oot-predictions.parquet")
    engines["v2"] = parquet_engine(BACKTEST_DIR / "v2-oot-predictions.parquet")
    print(f"  ✓ parquet engines: Standard/v1/v2")
    # Corpus engines (expensive)
    engines.update(corpus_engines(test_seasons, args.rho))

    # Attach realized xG (robust join)
    for name in engines:
        engines[name] = attach_realized_xg(engines[name], spine)
        cov = (engines[name]["mid"] >= 0).mean()
        print(f"    {name:<10} {len(engines[name]):>5} preds · realized-xG join {100*cov:>5.1f}%")
    tc = spine.tier_counts
    tot = sum(tc.values()) or 1
    print(f"  join tiers (all engines): exact {tc['exact']:,} · fuzzy {tc['fuzzy']:,} "
          f"({100*tc['fuzzy']/tot:.1f}%) · miss {tc['miss']:,}")
    print()

    # ─── Best-effort leaderboard ───
    best = {name: score_engine(pf) for name, pf in engines.items()}

    # ─── Common-intersection ───
    mid_sets = [set(pf.loc[pf["mid"] >= 0, "mid"]) for pf in engines.values()]
    inter = set.intersection(*mid_sets) if mid_sets else set()
    common = {name: score_engine(pf, mid_filter=inter) for name, pf in engines.items()}

    def _table(title, scores):
        print("─" * 76)
        print(f"{title}")
        print("─" * 76)
        print(f"  {'engine':<10} {'n':>5} {'xG-RMSE':>8} {'xG-MAE':>7} {'xG-bias':>8} {'r':>6} {'Brier':>8}")
        # sort by xG-RMSE (the new primary axis)
        for name in sorted(scores, key=lambda k: scores[k].get("xg_rmse", 9)):
            s = scores[name]
            if s.get("n_matches", 0) == 0:
                continue
            print(f"  {name:<10} {s['n_matches']:>5} {s['xg_rmse']:>8.4f} {s['xg_mae']:>7.4f} "
                  f"{s['xg_bias']:>+8.4f} {s['pearson_r']:>6.3f} {s['brier']:>8.4f}")
        print()

    _table("BEST-EFFORT (each engine on its own joinable 25/26 matches)", best)
    _table(f"COMMON-INTERSECTION (n={len(inter):,} matches predicted by ALL engines)", common)

    # Rankings on the intersection (the fair comparison)
    rmse_rank = sorted([k for k in common if common[k].get("n_matches")],
                       key=lambda k: common[k]["xg_rmse"])
    brier_rank = sorted([k for k in common if common[k].get("n_matches")],
                        key=lambda k: common[k]["brier"])
    print(f"  xG-RMSE ranking (primary): {' < '.join(rmse_rank)}")
    print(f"  Brier   ranking:           {' < '.join(brier_rank)}")
    print()

    out = {
        "objective": "xg-forecast primary (RMSE/MAE/bias) + 1x2-brier coupled; ROI secondary",
        "test_seasons": list(test_seasons),
        "rho": args.rho,
        "join": f"(league, canon_home, canon_away) nearest-date ±{JOIN_WINDOW_DAYS}d",
        "calibration": "RAW probs for all engines (no isotonic/benter)",
        "n_spine": int(len(spine._df)),
        "n_common_intersection": int(len(inter)),
        "best_effort": best,
        "common_intersection": common,
        "rmse_ranking": rmse_rank,
        "brier_ranking": brier_rank,
        "_caveats": [
            "Realized xG is a model output (Understat/Sofa), not ground truth like goals.",
            "All engines on RAW probs (no isotonic) — model quality, not pipeline.",
            "Parquet engines (Standard/v1/v2) carry stored λ; dev-03/dev-09 predicted live.",
            "ROI tiebreaker scored separately (score_roi_leaderboard.py).",
        ],
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print("═" * 76)
    print(f"  ✓ {OUT_PATH.relative_to(REPO_ROOT)}")
    print("═" * 76)
    return 0


if __name__ == "__main__":
    sys.exit(main())
