"""
tune_liga_whitelist.py — Path A: tune per-Liga Goldilocks whitelist on 24/25 OOT.

METHODOLOGY:
  1. Run the v4 pipeline (m3 + m6 + m7_kelly) on 24/25 closing odds.
  2. For each Liga with ≥ MIN_TUNING_BETS bets, compute:
       - mean edge (CLV-proxy)
       - point ROI
       - bootstrap ROI 95% CI (200 resamples)
  3. CLASSIFY Ligen:
       - WHITELIST: bootstrap-CI-lower > 0 (statistically-positive ROI)
       - WATCH:     point ROI > 0 but CI-lower ≤ 0 (uncertain, retain conservatively)
       - EXCLUDE:   point ROI ≤ 0 (no signal — don't bet)
  4. Output whitelist + watch + exclude lists for Stage 5 re-run on 25/26.

LEAKAGE-AWARENESS:
  • m3 SAW 24/25 during training (slightly optimistic predictions).
    Effect: per-Liga ROI is upward-biased on 24/25 vs truly-OOS.
  • Benter weights were fit on 23/24 ONLY. 24/25 is NOT in the Benter fit.
    Effect: minimal leakage on Benter side.
  • Net: 24/25 tuning is cleaner than 23/24 (where both m3 AND Benter saw data).
    The 25/26 final validation is truly out-of-everything.

  The signal we're extracting (Liga-level relative profitability) is
  systematic — m3's per-Liga bias structure should persist OOS even with
  the small optimism shift. Liga ROI absolute numbers may shrink on 25/26
  but the WHITELIST/EXCLUDE ranking should largely hold.

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/tune_liga_whitelist.py
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history
from v4.modules.m3_xg import XGPredictor
from v4.modules.m6_market import BenterBlender, remove_vig
from v4.modules.m7_kelly import RobustBayesianKelly

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
TUNING_ODDS = REPO_ROOT / "tools" / "backtest" / "odds-close-24-25.parquet"
REPORTS_DIR = REPO_ROOT / "tools" / "v4" / "reports"

# Tuning hyperparameters
MIN_TUNING_BETS = 25            # minimum bets per Liga to consider a signal
BOOTSTRAP_N = 200               # resamples per Liga
WHITELIST_CI_LOWER_MIN = 0.0    # CI-lower > 0 to be in whitelist
WATCH_ROI_MIN = 0.0             # point ROI > 0 to be in watch (CI may include 0)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Tune Liga whitelist on 24/25 OOT")
    p.add_argument("--m3-tag", default="dev-02-elo")
    p.add_argument("--benter-tag", default="dev-02-elo")
    p.add_argument("--profile", default="M", choices=["K", "M", "A"])
    p.add_argument("--alpha", type=float, default=1.0)
    p.add_argument("--vig-method", default="shin")
    return p.parse_args()


def _outcome_label(h: float, a: float) -> str:
    if h > a: return "H"
    if h < a: return "A"
    return "D"


def _bet_profit(stake_frac: float, odd: float, won: bool) -> float:
    return stake_frac * (odd - 1.0) if won else -stake_frac


def _bootstrap_roi_ci(profits: np.ndarray, stakes: np.ndarray,
                     n_resamples: int = BOOTSTRAP_N) -> Dict[str, float]:
    """Return {ci_lo, median, ci_hi} for ROI via percentile bootstrap."""
    rng = np.random.default_rng(42)
    n = len(profits)
    rois = []
    for _ in range(n_resamples):
        idx = rng.integers(0, n, size=n)
        s = float(stakes[idx].sum())
        if s > 0:
            rois.append(float(profits[idx].sum()) / s)
    if not rois:
        return {"ci_lo": 0.0, "median": 0.0, "ci_hi": 0.0}
    return {
        "ci_lo": float(np.percentile(rois, 2.5)),
        "median": float(np.percentile(rois, 50)),
        "ci_hi": float(np.percentile(rois, 97.5)),
    }


def main() -> int:
    args = parse_args()
    print("=" * 76)
    print(f"PATH A — Tune Liga Whitelist on 24/25 OOT")
    print("=" * 76)
    print(f"  m3 tag:        {args.m3_tag}    (trained on 2017-25-07, SAW 24/25)")
    print(f"  Benter tag:    {args.benter_tag}  (fit on 23/24, NOT on 24/25)")
    print(f"  profile:       {args.profile}    α={args.alpha}")
    print(f"  vig method:    {args.vig_method}")
    print(f"  min bets/Liga: {MIN_TUNING_BETS}")
    print()

    # ─── Load artifacts ───
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{args.m3_tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{args.m3_tag}.pkl"
    benter_path = ARTIFACTS_DIR / f"m6_benter-{args.benter_tag}.pkl"
    for p in [home_path, away_path, benter_path, TUNING_ODDS]:
        if not p.exists():
            print(f"✗ Missing: {p}")
            return 1
    predictor = XGPredictor.from_artifacts(home_path=home_path, away_path=away_path)
    blender = BenterBlender.load(benter_path)
    kelly = RobustBayesianKelly(profile=args.profile, alpha=args.alpha)

    # ─── Load 24/25 tuning data ───
    odds = pd.read_parquet(TUNING_ODDS)
    odds["match_date"] = pd.to_datetime(odds["match_date"])
    odds = odds.dropna(subset=["ft_goals_h", "ft_goals_a", "psch", "pscd", "psca"]).reset_index(drop=True)
    print(f"  24/25 tuning corpus: {len(odds):,} settled matches, "
          f"{odds['league'].nunique()} leagues")

    history = load_team_xg_history()

    # ─── m3 predict ───
    t0 = time.time()
    match_pairs = odds[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    )
    print(f"  Generating m3 predictions...")
    m3_preds = predictor.predict_batch(match_pairs, history)
    print(f"    Done in {time.time()-t0:.1f}s")

    # ─── Vig-remove + Benter blend ───
    odds_arr = odds[["psch", "pscd", "psca"]].values
    market_probs = np.array([remove_vig(o, method=args.vig_method) for o in odds_arr])
    model_probs = m3_preds[["prob_h", "prob_d", "prob_a"]].values
    model_probs = model_probs / model_probs.sum(axis=1, keepdims=True)
    blended_probs = np.zeros_like(model_probs)
    for liga in odds["league"].unique():
        mask = odds["league"].values == liga
        blended_probs[mask] = blender.blend(model_probs[mask], market_probs[mask], liga)
    sigma_sq = (m3_preds["lambda_h_variance"].values + m3_preds["lambda_a_variance"].values) / 2.0

    # ─── Bet ledger ───
    bets = []
    for i, row in odds.iterrows():
        actual = _outcome_label(row["ft_goals_h"], row["ft_goals_a"])
        for outcome_idx, (label, odd_col) in enumerate([
            ("H", "psch"), ("D", "pscd"), ("A", "psca")
        ]):
            d = kelly.stake(
                p_hat=float(blended_probs[i, outcome_idx]),
                odds=float(row[odd_col]),
                league=row["league"],
                sigma_sq=float(sigma_sq[i]),
            )
            if d.f_robust > 0:
                bets.append({
                    "match_date": row["match_date"],
                    "league": row["league"],
                    "outcome": label,
                    "stake_frac": d.f_robust,
                    "odd": float(row[odd_col]),
                    "edge": d.edge,
                    "won": (actual == label),
                })
    bets_df = pd.DataFrame(bets)
    n_total_bets = len(bets_df)
    print(f"  {n_total_bets:,} bets placed in tuning corpus")

    if n_total_bets < 100:
        print(f"✗ Insufficient tuning bets ({n_total_bets})")
        return 1

    # ─── Per-Liga ROI + bootstrap CI ───
    print()
    print(f"  Per-Liga ROI on 24/25 tuning corpus (bootstrap 95% CI from "
          f"{BOOTSTRAP_N} resamples):")
    print()
    print(f"    {'Liga':<18}  {'n':>4}  {'win%':>5}  {'edge%':>6}  "
          f"{'ROI%':>7}  {'CI95%':>22}  class")
    print(f"    {'-'*18}  {'-'*4}  {'-'*5}  {'-'*6}  {'-'*7}  {'-'*22}  -----")

    whitelist: List[str] = []
    watch: List[str] = []
    exclude: List[str] = []
    insufficient: List[str] = []
    per_liga_results: Dict[str, dict] = {}

    for liga, grp in bets_df.groupby("league"):
        n = len(grp)
        win = float(grp["won"].mean())
        edge = float(grp["edge"].mean())
        profits = grp.apply(
            lambda b: _bet_profit(b["stake_frac"], b["odd"], b["won"]), axis=1
        ).values
        stakes = grp["stake_frac"].values
        total_stake = float(stakes.sum())
        if total_stake <= 0:
            continue
        point_roi = float(profits.sum()) / total_stake

        if n < MIN_TUNING_BETS:
            insufficient.append(liga)
            per_liga_results[liga] = {
                "n": n, "point_roi": point_roi, "win_rate": win,
                "mean_edge": edge, "class": "insufficient",
            }
            continue

        ci = _bootstrap_roi_ci(profits, stakes)
        cls = (
            "WHITELIST" if ci["ci_lo"] > WHITELIST_CI_LOWER_MIN
            else ("WATCH" if point_roi > WATCH_ROI_MIN else "EXCLUDE")
        )
        per_liga_results[liga] = {
            "n": int(n), "point_roi": point_roi, "win_rate": win,
            "mean_edge": edge, "ci_lo": ci["ci_lo"], "ci_median": ci["median"],
            "ci_hi": ci["ci_hi"], "class": cls,
        }
        if cls == "WHITELIST":
            whitelist.append(liga)
        elif cls == "WATCH":
            watch.append(liga)
        else:
            exclude.append(liga)

    # Sort by ROI descending for display
    sorted_results = sorted(
        per_liga_results.items(),
        key=lambda kv: -kv[1].get("point_roi", -999),
    )
    for liga, r in sorted_results:
        if r["class"] == "insufficient":
            print(f"    {liga:<18}  {r['n']:>4}  {r['win_rate']*100:>5.1f}  "
                  f"{r['mean_edge']*100:>+6.2f}  {r['point_roi']*100:>+7.2f}  "
                  f"{'(n<' + str(MIN_TUNING_BETS) + ', skip)':>22}  --")
            continue
        ci_str = f"[{r['ci_lo']*100:+5.1f}, {r['ci_hi']*100:+5.1f}]"
        print(f"    {liga:<18}  {r['n']:>4}  {r['win_rate']*100:>5.1f}  "
              f"{r['mean_edge']*100:>+6.2f}  {r['point_roi']*100:>+7.2f}  "
              f"{ci_str:>22}  {r['class']}")

    print()
    print(f"  ─── Classification summary ───")
    print(f"    WHITELIST ({len(whitelist)}): {whitelist}")
    print(f"    WATCH     ({len(watch)}): {watch}")
    print(f"    EXCLUDE   ({len(exclude)}): {exclude}")
    print(f"    INSUFFIC. ({len(insufficient)}): {insufficient}")

    # ─── Aggregate ROI on the WHITELIST subset (sanity check) ───
    if whitelist:
        wl_mask = bets_df["league"].isin(whitelist)
        wl_grp = bets_df[wl_mask]
        wl_profits = wl_grp.apply(
            lambda b: _bet_profit(b["stake_frac"], b["odd"], b["won"]), axis=1
        ).values
        wl_stake = float(wl_grp["stake_frac"].sum())
        wl_roi = float(wl_profits.sum()) / wl_stake if wl_stake > 0 else 0.0
        wl_ci = _bootstrap_roi_ci(wl_profits, wl_grp["stake_frac"].values)
        print()
        print(f"  ─── Tuning-set ROI on WHITELIST only ───")
        print(f"    n_bets:      {len(wl_grp)} (vs {n_total_bets} pre-filter)")
        print(f"    point ROI:   {wl_roi*100:+.2f}%")
        print(f"    bootstrap CI: [{wl_ci['ci_lo']*100:+.2f}%, "
              f"{wl_ci['median']*100:+.2f}%, {wl_ci['ci_hi']*100:+.2f}%]")

    # ─── Save manifest ───
    REPORTS_DIR.mkdir(exist_ok=True)
    manifest = {
        "tag": f"path_a_tuning_24-25_{args.profile}_α{args.alpha}",
        "generated_at": datetime.now().isoformat(),
        "config": {
            "m3_tag": args.m3_tag, "benter_tag": args.benter_tag,
            "profile": args.profile, "alpha": args.alpha,
            "vig_method": args.vig_method,
            "min_tuning_bets": MIN_TUNING_BETS,
            "bootstrap_n": BOOTSTRAP_N,
        },
        "leakage_caveats": (
            "m3 SAW 24/25 during training (slight upward bias on ROI). "
            "Benter weights NOT fit on 24/25 (cleaner). "
            "25/26 is truly held-out for final Stage-5 validation."
        ),
        "tuning_corpus": {
            "season": "24/25",
            "n_matches": int(len(odds)),
            "n_decisions": int(len(odds) * 3),
            "n_bets": int(n_total_bets),
        },
        "per_liga": per_liga_results,
        "whitelist": whitelist,
        "watch": watch,
        "exclude": exclude,
        "insufficient": insufficient,
    }
    out_path = REPORTS_DIR / "path_a_liga_whitelist_24-25.json"
    with open(out_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\n  Saved: {out_path.relative_to(REPO_ROOT)}")
    print("=" * 76)
    return 0


if __name__ == "__main__":
    sys.exit(main())
