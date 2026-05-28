"""
simulate_m7_kelly_clv.py — Stage 5 CLV + bankroll simulation for v4 end-to-end.

⚠ KNOWN CAVEAT — Brier-vs-ROI divergence (verified empirically 2026-05-13):
  Adding the Elo feature (dev-01 → dev-02-elo) IMPROVED Brier from 0.6193
  to 0.6133 (cleared protocol G1) but WORSENED Kelly betting ROI from
  -2.7% to -4.0% on the same 25/26 holdout. Path A WATCH filter ROI also
  worsened (+4.3% → -8.9%).

  Brier measures AVERAGE prediction accuracy. Kelly betting depends only on
  the EDGE TAIL (predictions where p_model × odds > 1.0 + Goldilocks_min).
  A model can improve Brier by being more confident on average while
  introducing MORE over-confident edge predictions that lose at the tail.

  Implication: Brier improvements are NOT sufficient for Stage 5 ship-readiness.
  Real production betting requires per-Liga calibration on OOF data and
  per-Liga edge tuning — Stage 5 ship still requires more work.

Per V4-BACKTESTING-PROTOCOL §"Stage 5: CLV Simulation":

Per match in 25/26 holdout:
  1. Generate v4 prediction via m3 (LightGBM + Bayesian Ensemble) + m6 (Shin+Benter)
  2. For each of 3 outcomes (H/D/A), compute edge = blended_prob × odds - 1
  3. Apply m7_kelly → stake fraction (Goldilocks gate + variance shrinkage + cap)
  4. If stake > 0, simulate bet outcome against actual match result
  5. Track per-bet ledger (date, league, outcome, stake, odds, won, profit)

Then compute:
  - Total bets placed, win-rate, ROI, mean edge (CLV-proxy)
  - Bankroll trajectories for 3 starting variants (€100/€1,000/€10,000)
  - Max drawdown per trajectory
  - Bootstrap ROI 95% CI (1,000 resamples)

Pass criteria (per protocol):
  * ROI 95% CI lower bound > 0 (statistically positive EV)
  * Median bootstrapped ROI > 0
  * Max drawdown < 30%
  * Mean edge (CLV-proxy) > 0.5%

Run:
  tools/venv/bin/python3 -I tools/v4/simulate_m7_kelly_clv.py \\
    --m3-tag dev-01 --benter-tag dev-01 --profile M --alpha 1.0
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history
from v4.modules.m3_xg import XGPredictor
from v4.modules.m6_market import BenterBlender, remove_vig
from v4.modules.m7_kelly import KellyDecision, RobustBayesianKelly

ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT_ODDS = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
REPORTS_DIR = REPO_ROOT / "tools" / "v4" / "reports"


# Pass-gate thresholds per protocol §"Stage 5"
ROI_CI_LOWER_MIN = 0.0           # ROI 95% CI lower bound must be > 0
ROI_MEDIAN_MIN = 0.0             # Median resample ROI > 0
MAX_DRAWDOWN_MAX = 0.30          # Max drawdown < 30%
MEAN_EDGE_MIN = 0.005            # Mean edge (CLV-proxy) > 0.5%
BOOTSTRAP_N_RESAMPLES = 1000
BOOTSTRAP_SEED = 42


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stage 5 CLV + bankroll simulation")
    p.add_argument("--m3-tag", default="dev-02-elo",
                   help="m3 artifact tag (default dev-02-elo — 14-feature Elo schema)")
    p.add_argument("--benter-tag", default="dev-02-elo",
                   help="Benter artifact tag (default dev-02-elo — fit against dev-02-elo m3)")
    p.add_argument("--profile", default="M", choices=["K", "M", "A"])
    p.add_argument("--alpha", type=float, default=1.0,
                   help="Kelly variance-shrinkage strength (default 1.0)")
    p.add_argument("--vig-method", default="shin", choices=["shin", "proportional"])
    p.add_argument("--save-ledger", action="store_true",
                   help="Save full per-bet ledger CSV to reports/")
    p.add_argument("--allow-list", default=None,
                   help="Comma-separated Liga whitelist (Path A). Ligen not in "
                        "the list produce f_robust=0. Default: no filter.")
    p.add_argument("--tag-suffix", default="",
                   help="Append to artifact filename for variant runs (e.g. '_pathA')")
    return p.parse_args()


def _outcome_label(h_goals: float, a_goals: float) -> str:
    """Return 'H', 'D', or 'A' from actual goals."""
    if h_goals > a_goals: return "H"
    if h_goals < a_goals: return "A"
    return "D"


def _compute_max_drawdown(trajectory: np.ndarray) -> float:
    """Max drawdown of a bankroll trajectory: largest peak-to-trough decline.
    Returns fraction (e.g., 0.15 = 15% drawdown from running peak)."""
    if len(trajectory) < 2:
        return 0.0
    running_max = np.maximum.accumulate(trajectory)
    drawdown = (running_max - trajectory) / running_max
    return float(drawdown.max())


def _bet_profit(stake_frac: float, odd: float, won: bool) -> float:
    """Profit per bet as fraction of bankroll-at-bet-time.
    Win: +stake × (odd-1).  Loss: -stake.
    """
    return stake_frac * (odd - 1.0) if won else -stake_frac


def main() -> int:
    args = parse_args()
    tag = f"{args.m3_tag}_{args.benter_tag}_{args.profile}_α{args.alpha}{args.tag_suffix}"

    print("=" * 72)
    print(f"V4 Stage 5 — CLV + Bankroll Simulation · tag={tag}")
    print("=" * 72)
    print(f"  m3 tag:         {args.m3_tag}")
    print(f"  Benter tag:     {args.benter_tag}")
    print(f"  Kelly profile:  {args.profile}  (cap K=2.5% M=4% A=6%)")
    print(f"  α (shrinkage):  {args.alpha}")
    print(f"  vig method:     {args.vig_method}")
    print(f"  bootstrap n:    {BOOTSTRAP_N_RESAMPLES}")
    print()

    # ───── Load artifacts ─────
    home_path = ARTIFACTS_DIR / f"m3_xg-home-{args.m3_tag}.pkl"
    away_path = ARTIFACTS_DIR / f"m3_xg-away-{args.m3_tag}.pkl"
    benter_path = ARTIFACTS_DIR / f"m6_benter-{args.benter_tag}.pkl"
    for p in [home_path, away_path, benter_path, HOLDOUT_ODDS]:
        if not p.exists():
            print(f"✗ Missing artifact: {p}")
            return 1

    predictor = XGPredictor.from_artifacts(home_path=home_path, away_path=away_path)
    blender = BenterBlender.load(benter_path)
    allow_list_set = None
    if args.allow_list:
        allow_list_set = set(s.strip() for s in args.allow_list.split(",") if s.strip())
        print(f"  Liga ALLOW_LIST ({len(allow_list_set)}): {sorted(allow_list_set)}")
    kelly = RobustBayesianKelly(
        profile=args.profile, alpha=args.alpha,
        liga_allow_list=allow_list_set,
    )

    # ───── Load holdout ─────
    odds = pd.read_parquet(HOLDOUT_ODDS)
    odds["match_date"] = pd.to_datetime(odds["match_date"])
    odds = odds.dropna(subset=["ft_goals_h", "ft_goals_a", "psch", "pscd", "psca"])
    odds = odds.sort_values("match_date").reset_index(drop=True)
    print(f"  Holdout (25/26 settled w/ Pinnacle odds): {len(odds):,} matches")

    history = load_team_xg_history()
    print(f"  team_xg_history: {len(history):,} rows")

    # ───── Generate m3 predictions for the corpus ─────
    t0 = time.time()
    match_pairs = odds[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    )
    print(f"\n  Generating m3 predictions for {len(match_pairs):,} matches...")
    m3_preds = predictor.predict_batch(match_pairs, history)
    print(f"    Done in {time.time()-t0:.1f}s")

    # ───── Vig-remove market odds + Benter blend ─────
    odds_arr = odds[["psch", "pscd", "psca"]].values
    market_probs = np.array([remove_vig(o, method=args.vig_method) for o in odds_arr])
    model_probs = m3_preds[["prob_h", "prob_d", "prob_a"]].values
    # Defensive: normalize model probs (predictor should already, but be safe)
    model_probs = model_probs / model_probs.sum(axis=1, keepdims=True)

    blended_probs = np.zeros_like(model_probs)
    for liga in odds["league"].unique():
        mask = odds["league"].values == liga
        blended_probs[mask] = blender.blend(model_probs[mask], market_probs[mask], liga)

    # σ² proxy: average of home + away λ variance (m3 doesn't expose
    # per-outcome σ² directly — derived quantities through DC matrix would
    # require uncertainty propagation; (σ²_h + σ²_a)/2 is the principled
    # scalar approximation for Kelly variance-shrinkage).
    sigma_sq_proxy = (
        m3_preds["lambda_h_variance"].values + m3_preds["lambda_a_variance"].values
    ) / 2.0

    # ───── Build bet ledger ─────
    print(f"\n  Evaluating Kelly decisions across {len(odds):,} matches × 3 outcomes...")
    bets: List[dict] = []
    decisions_evaluated = 0
    for i, row in odds.iterrows():
        actual = _outcome_label(row["ft_goals_h"], row["ft_goals_a"])
        for outcome_idx, (label, odd_col) in enumerate([
            ("H", "psch"), ("D", "pscd"), ("A", "psca")
        ]):
            decisions_evaluated += 1
            decision: KellyDecision = kelly.stake(
                p_hat=float(blended_probs[i, outcome_idx]),
                odds=float(row[odd_col]),
                league=row["league"],
                sigma_sq=float(sigma_sq_proxy[i]),
            )
            if decision.f_robust > 0:
                bets.append({
                    "match_date": row["match_date"],
                    "league": row["league"],
                    "home_team": row["home_team"],
                    "away_team": row["away_team"],
                    "outcome": label,
                    "stake_frac": decision.f_robust,
                    "odd": float(row[odd_col]),
                    "p_blended": float(blended_probs[i, outcome_idx]),
                    "p_market": float(market_probs[i, outcome_idx]),
                    "edge": decision.edge,
                    "shrinkage": decision.shrinkage,
                    "cap_applied": decision.cap_applied,
                    "league_tier": decision.league_tier,
                    "actual_outcome": actual,
                    "won": (actual == label),
                })
    bets_df = pd.DataFrame(bets).sort_values("match_date").reset_index(drop=True)
    n_bets = len(bets_df)
    bet_rate = n_bets / decisions_evaluated if decisions_evaluated else 0.0

    print(f"    {n_bets:,} bets placed out of {decisions_evaluated:,} decisions "
          f"({bet_rate:.1%} pass-rate through Goldilocks)")

    if n_bets < 30:
        print(f"\n✗ Insufficient bets ({n_bets}) for meaningful simulation.")
        return 1

    # ───── Per-bet aggregate metrics ─────
    win_rate = float(bets_df["won"].mean())
    mean_edge = float(bets_df["edge"].mean())
    median_edge = float(bets_df["edge"].median())
    mean_stake_frac = float(bets_df["stake_frac"].mean())
    median_stake_frac = float(bets_df["stake_frac"].median())

    # Total stake (fraction-units) + total profit (fraction-units)
    profits = bets_df.apply(
        lambda b: _bet_profit(b["stake_frac"], b["odd"], b["won"]), axis=1
    ).values
    total_stake = float(bets_df["stake_frac"].sum())
    total_profit = float(profits.sum())
    roi = total_profit / total_stake if total_stake > 0 else 0.0

    print()
    print(f"  ─── Headline (single trajectory, all bets pooled) ───")
    print(f"    n_bets:        {n_bets:,}")
    print(f"    bet rate:      {bet_rate:.1%}  ({decisions_evaluated:,} decisions → {n_bets:,} bets)")
    print(f"    win rate:      {win_rate:.3f}")
    print(f"    mean edge:     {mean_edge*100:+.3f}%   (CLV-proxy)")
    print(f"    median edge:   {median_edge*100:+.3f}%")
    print(f"    mean stake:    {mean_stake_frac*100:.3f}% of bankroll")
    print(f"    ROI:           {roi*100:+.3f}%   (total_profit/total_stake, frac-units)")

    # ───── Per-Liga + per-tier breakdown ─────
    print()
    print(f"  ─── Per-Liga (top 8 by bet count) ───")
    print(f"    {'Liga':<18}  {'tier':<8}  {'n':>5}  {'win%':>5}  {'edge%':>6}  {'ROI%':>7}")
    print(f"    {'-'*18}  {'-'*8}  {'-'*5}  {'-'*5}  {'-'*6}  {'-'*7}")
    liga_summary = []
    for liga, grp in bets_df.groupby("league"):
        n = len(grp)
        if n < 5:
            continue
        win_l = grp["won"].mean()
        edge_l = grp["edge"].mean()
        prof_l = grp.apply(
            lambda b: _bet_profit(b["stake_frac"], b["odd"], b["won"]), axis=1
        ).sum()
        stake_l = grp["stake_frac"].sum()
        roi_l = prof_l / stake_l if stake_l > 0 else 0
        tier_l = grp["league_tier"].iloc[0]
        liga_summary.append((liga, tier_l, n, win_l, edge_l, roi_l))
    liga_summary.sort(key=lambda x: -x[2])  # by n desc
    for liga, tier, n, w, e, r in liga_summary[:8]:
        print(f"    {liga:<18}  {tier:<8}  {n:>5}  {w*100:>5.1f}  {e*100:>+6.2f}  {r*100:>+7.2f}")

    # ───── Bankroll trajectories (compound Kelly) ─────
    print()
    print(f"  ─── Bankroll trajectories (compound Kelly) ───")
    bankroll_results = {}
    for starting in [100.0, 1000.0, 10000.0]:
        bankroll = starting
        trajectory = [bankroll]
        for _, b in bets_df.iterrows():
            stake = b["stake_frac"] * bankroll
            if b["won"]:
                bankroll += stake * (b["odd"] - 1.0)
            else:
                bankroll -= stake
            trajectory.append(bankroll)
        trajectory = np.array(trajectory)
        final = trajectory[-1]
        roi_compound = (final - starting) / starting
        log_growth = float(np.log(final / starting)) if final > 0 else float("-inf")
        max_dd = _compute_max_drawdown(trajectory)
        bankroll_results[starting] = {
            "start": starting,
            "final": float(final),
            "roi": float(roi_compound),
            "log_growth": log_growth,
            "max_drawdown": max_dd,
            "trajectory_len": len(trajectory),
        }
        print(f"    €{starting:>7,.0f}: final €{final:>10,.2f}  ROI {roi_compound*100:+7.2f}%  "
              f"log-growth {log_growth:+.4f}  max-DD {max_dd*100:5.2f}%")

    # log-bankroll-growth rate should be scale-invariant per protocol — sanity-check
    log_growths = [v["log_growth"] for v in bankroll_results.values()]
    if max(log_growths) - min(log_growths) > 1e-6:
        print(f"    ⚠ scale-invariance violated: log_growths {log_growths}")
    else:
        print(f"    ✓ scale-invariant: log_growth identical across bankrolls (diff < 1e-6)")

    # ───── Bootstrap ROI CI ─────
    print()
    print(f"  ─── Bootstrap ROI ({BOOTSTRAP_N_RESAMPLES} resamples) ───")
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    stakes = bets_df["stake_frac"].values
    boot_rois = np.empty(BOOTSTRAP_N_RESAMPLES, dtype=float)
    for r in range(BOOTSTRAP_N_RESAMPLES):
        idx = rng.integers(0, n_bets, size=n_bets)
        boot_profits = profits[idx]
        boot_stake_total = float(stakes[idx].sum())
        if boot_stake_total > 0:
            boot_rois[r] = float(boot_profits.sum()) / boot_stake_total
        else:
            boot_rois[r] = 0.0

    roi_ci_lo = float(np.percentile(boot_rois, 2.5))
    roi_ci_med = float(np.percentile(boot_rois, 50))
    roi_ci_hi = float(np.percentile(boot_rois, 97.5))
    print(f"    95% CI: [{roi_ci_lo*100:+.3f}%, {roi_ci_med*100:+.3f}%, {roi_ci_hi*100:+.3f}%]")

    # ───── Gates ─────
    print()
    print(f"  ─── Stage 5 protocol gates ───")
    gates = {
        "ROI 95% CI lower > 0":      roi_ci_lo > ROI_CI_LOWER_MIN,
        "Bootstrap median ROI > 0":  roi_ci_med > ROI_MEDIAN_MIN,
        "Mean edge > +0.5%":         mean_edge > MEAN_EDGE_MIN,
        "Max drawdown < 30%":        bankroll_results[1000.0]["max_drawdown"] < MAX_DRAWDOWN_MAX,
    }
    for gate, passed in gates.items():
        sym = "✓" if passed else "✗"
        print(f"    {sym} {gate}")
    all_pass = all(gates.values())

    # ───── Save manifest ─────
    REPORTS_DIR.mkdir(exist_ok=True)
    manifest_path = REPORTS_DIR / f"stage_5_kelly_clv_{tag}.json"
    manifest = {
        "tag": tag,
        "generated_at": datetime.now().isoformat(),
        "config": {
            "m3_tag": args.m3_tag,
            "benter_tag": args.benter_tag,
            "profile": args.profile,
            "alpha": args.alpha,
            "vig_method": args.vig_method,
            "bootstrap_n": BOOTSTRAP_N_RESAMPLES,
        },
        "holdout": {
            "n_matches_settled": int(len(odds)),
            "n_decisions_evaluated": int(decisions_evaluated),
            "n_bets_placed": int(n_bets),
            "bet_rate": float(bet_rate),
            "date_range": [
                str(odds["match_date"].min().date()),
                str(odds["match_date"].max().date()),
            ],
        },
        "aggregate": {
            "win_rate": win_rate,
            "mean_edge_pct": mean_edge * 100,
            "median_edge_pct": median_edge * 100,
            "mean_stake_pct": mean_stake_frac * 100,
            "roi_pct_single_trajectory": roi * 100,
            "roi_bootstrap_ci_lo_pct": roi_ci_lo * 100,
            "roi_bootstrap_ci_median_pct": roi_ci_med * 100,
            "roi_bootstrap_ci_hi_pct": roi_ci_hi * 100,
        },
        "bankroll_trajectories": {
            f"€{int(k):,}": v for k, v in bankroll_results.items()
        },
        "per_liga": [
            {
                "league": liga, "tier": tier, "n_bets": n,
                "win_rate": w, "mean_edge_pct": e * 100, "roi_pct": r * 100,
            }
            for liga, tier, n, w, e, r in liga_summary
        ],
        "gates": gates,
        "all_pass": all_pass,
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\n  Manifest saved: {manifest_path.relative_to(REPO_ROOT)}")

    if args.save_ledger:
        ledger_path = REPORTS_DIR / f"stage_5_bets_{tag}.csv"
        bets_df.to_csv(ledger_path, index=False)
        print(f"  Per-bet ledger: {ledger_path.relative_to(REPO_ROOT)}")

    print()
    print("=" * 72)
    if all_pass:
        print(f"✓ STAGE 5 PASSED — v4 ships a money-positive Kelly strategy on 25/26")
    else:
        n_failed = sum(1 for v in gates.values() if not v)
        print(f"✗ STAGE 5: {n_failed}/{len(gates)} gates failed (see breakdown above)")
    print("=" * 72)
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
