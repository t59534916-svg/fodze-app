#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE Kelly-staking backtest — v2 OOT × Pinnacle close
═══════════════════════════════════════════════════════════════════

Walks the OOT parquet chronologically, places Kelly-sized bets against
Pinnacle closing odds whenever the engine edge falls inside the
Goldilocks band [2.5 %, 7.5 %], applies the K / M / A risk caps
(2.5 % / 4 % / 6 % of bankroll respectively), and tracks:

  - Terminal ROI
  - Max drawdown (peak-to-trough, fractional)
  - Sharpe (daily return mean / std × √252)
  - Calmar (ROI / |Max DD|)
  - Hit rate per edge bucket (0–2 % / 2–5 % / 5–10 % / 10 %+)
  - Per-league ROI breakdown

Inputs:
  tools/backtest/v2-oot-predictions.parquet   (retrain_v2.py OOT export)
  tools/backtest/odds-close-oot.parquet       (fit_benter.py cache)

Output:
  tools/backtest/v2-oot-simulation.json       (gitignored)

Edge definition matches FODZE production:
  market_prob_k = (1 / odds_k) / overround     (vig-removed, proportional)
  edge_k        = model_prob_k − market_prob_k

Negative-edge outcomes are skipped regardless of Kelly formula (they
imply "bet against" which FODZE doesn't support).

Usage:
  tools/venv/bin/python tools/backtest/simulate_kelly.py
  tools/venv/bin/python tools/backtest/simulate_kelly.py \\
      --edge-min 0.025 --edge-max 0.075 --bankroll 10000
═══════════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OOT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
ODDS_CACHE = REPO_ROOT / "tools" / "backtest" / "odds-close-oot.parquet"
DEFAULT_OUT = REPO_ROOT / "tools" / "backtest" / "v2-oot-simulation.json"

# Risk caps match src/lib/kelly.ts conventions + tests/kelly.test.ts
RISK_CAPS = {"K": 0.025, "M": 0.040, "A": 0.060}
# Edge-bucket boundaries for hit-rate breakdown (open intervals)
EDGE_BUCKETS = [(0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 1.0)]

# Bootstrap: row-level resample WITH replacement of the per-bet list so
# ROI-on-stake = Σ profit / Σ stake remains a self-consistent ratio on
# each resample. 1000 resamples for stable 95% quantiles; seed pinned
# so re-runs match exactly for the same input data.
BOOTSTRAP_N = 1000
BOOTSTRAP_SEED = 42


@dataclass
class Bet:
    date: str
    league: str
    outcome: str
    model_prob: float
    market_prob: float
    edge: float
    odds: float
    fraction: float
    stake: float
    won: bool
    profit: float


@dataclass
class SimResult:
    profile: str
    bets: List[Bet] = field(default_factory=list)
    bankroll_trajectory: List[Tuple[str, float]] = field(default_factory=list)
    starting_bankroll: float = 10000.0
    final_bankroll: float = 10000.0


# ═══════════════════════════════════════════════════════════════════
# Simulation core
# ═══════════════════════════════════════════════════════════════════

def simulate(
    df: pd.DataFrame,
    profile: str,
    edge_min: float,
    edge_max: float,
    starting_bankroll: float,
) -> SimResult:
    """
    df must carry: match_date, league, ft_result,
      prob_h_raw, prob_d_raw, prob_a_raw,
      psch, pscd, psca,
      pinn_h, pinn_d, pinn_a  (vig-removed Pinnacle probs)
    Sorted by match_date ascending.
    """
    cap = RISK_CAPS[profile]
    result = SimResult(profile=profile, starting_bankroll=starting_bankroll, final_bankroll=starting_bankroll)
    bankroll = starting_bankroll
    result.bankroll_trajectory.append(("_start", bankroll))

    for _, row in df.iterrows():
        actual = row["ft_result"]
        outcomes = [
            ("H", row["prob_h_raw"], row["pinn_h"], row["psch"], actual == "H"),
            ("D", row["prob_d_raw"], row["pinn_d"], row["pscd"], actual == "D"),
            ("A", row["prob_a_raw"], row["pinn_a"], row["psca"], actual == "A"),
        ]
        for k, p_model, p_market, odds, won in outcomes:
            if odds is None or odds <= 1.0 or not math.isfinite(odds):
                continue
            if p_model is None or not math.isfinite(p_model) or p_model <= 0 or p_model >= 1:
                continue

            edge = float(p_model) - float(p_market)
            if edge < edge_min or edge > edge_max:
                continue

            b = float(odds) - 1.0
            q = 1.0 - float(p_model)
            kelly = (b * float(p_model) - q) / b
            if kelly <= 0:
                # Defensive: edge > 0 but Kelly ≤ 0 shouldn't happen given our
                # inputs, but skip just in case of numerical noise.
                continue
            fraction = min(kelly, cap)
            stake = fraction * bankroll
            if stake <= 0:
                continue

            profit = stake * b if won else -stake
            bankroll += profit

            result.bets.append(Bet(
                date=str(row["match_date"]),
                league=str(row["league"]),
                outcome=k,
                model_prob=float(p_model),
                market_prob=float(p_market),
                edge=float(edge),
                odds=float(odds),
                fraction=float(fraction),
                stake=float(stake),
                won=bool(won),
                profit=float(profit),
            ))
            result.bankroll_trajectory.append((str(row["match_date"]), bankroll))

    result.final_bankroll = bankroll
    return result


# ═══════════════════════════════════════════════════════════════════
# Metrics on a SimResult
# ═══════════════════════════════════════════════════════════════════

def _daily_returns(traj: List[Tuple[str, float]]) -> np.ndarray:
    """Aggregate bet-level trajectory into per-day returns so Sharpe isn't
    inflated by multiple bets settling on the same date."""
    if len(traj) < 2:
        return np.array([])
    # Group by date — use the LAST bankroll of each date as the EOD value.
    df = pd.DataFrame(traj, columns=["date", "bankroll"])
    df = df[df["date"] != "_start"]
    if df.empty:
        return np.array([])
    eod = df.groupby("date")["bankroll"].last().sort_index()
    # Prepend the starting bankroll to measure the first day's return.
    eod = pd.concat([pd.Series([traj[0][1]]), eod.reset_index(drop=True)])
    returns = eod.pct_change().dropna().to_numpy()
    return returns


def metrics_for(result: SimResult) -> Dict:
    n = len(result.bets)
    if n == 0:
        return {
            "profile": result.profile,
            "n_bets": 0,
            "roi": 0.0,
            "final_bankroll": result.final_bankroll,
            "note": "no bets placed — Goldilocks band never triggered on this data",
        }

    wins = sum(1 for b in result.bets if b.won)
    total_stake = sum(b.stake for b in result.bets)
    total_profit = sum(b.profit for b in result.bets)

    # Max drawdown on the bet-level trajectory (peak-to-trough fraction)
    bankrolls = np.array([b for _, b in result.bankroll_trajectory], dtype=float)
    running_peak = np.maximum.accumulate(bankrolls)
    drawdown = (bankrolls - running_peak) / running_peak
    max_dd = float(drawdown.min()) if len(drawdown) > 0 else 0.0

    # Sharpe on daily returns (more robust than bet-level)
    daily = _daily_returns(result.bankroll_trajectory)
    if daily.std() > 0 and len(daily) >= 2:
        sharpe = float(daily.mean() / daily.std() * math.sqrt(252))
    else:
        sharpe = 0.0

    roi = (result.final_bankroll / result.starting_bankroll) - 1.0
    # Calmar: annualised return / |max drawdown|. With <1 year of data the
    # "annualised" wrapper is misleading, so just report ROI/|DD| honestly.
    calmar = (roi / abs(max_dd)) if max_dd < 0 else float("inf")

    # Hit rate per edge bucket
    buckets = {f"{lo:.2f}-{hi:.2f}": {"n": 0, "wins": 0, "pnl": 0.0} for lo, hi in EDGE_BUCKETS}
    for bet in result.bets:
        for lo, hi in EDGE_BUCKETS:
            if lo <= bet.edge < hi:
                key = f"{lo:.2f}-{hi:.2f}"
                buckets[key]["n"] += 1
                buckets[key]["wins"] += 1 if bet.won else 0
                buckets[key]["pnl"] += bet.profit
                break
    for k in buckets:
        b = buckets[k]
        b["hit_rate"] = round(b["wins"] / b["n"], 4) if b["n"] > 0 else None
        b["roi_on_bucket"] = round(b["pnl"] / (b["n"] or 1), 4) if b["n"] > 0 else None

    # Per-league ROI (profit / stake on that league)
    per_league: Dict[str, Dict] = {}
    per_league_bets: Dict[str, List[Tuple[float, float]]] = {}
    for bet in result.bets:
        lg = bet.league
        pl = per_league.setdefault(lg, {"n": 0, "wins": 0, "stake": 0.0, "pnl": 0.0})
        pl["n"] += 1
        pl["wins"] += 1 if bet.won else 0
        pl["stake"] += bet.stake
        pl["pnl"] += bet.profit
        per_league_bets.setdefault(lg, []).append((bet.stake, bet.profit))
    for lg in per_league:
        pl = per_league[lg]
        pl["hit_rate"] = round(pl["wins"] / pl["n"], 4)
        pl["roi_on_stake"] = round(pl["pnl"] / pl["stake"], 4) if pl["stake"] > 0 else 0.0

        # Bootstrap 95% CI on ROI-on-stake. Resample (stake, profit) pairs
        # together so numerator AND denominator co-vary — avoids the trap
        # of treating wins and stakes as independent. With 150-550 bets
        # per league the CIs are wide (±10-20 pp typical).
        #
        # NB: the inner loop MUST NOT shadow the outer `n = len(result.bets)`
        # declared at the top of this function — dict values including
        # "n_bets" reference it. Using a distinct `n_lg` is the fix.
        arr = np.array(per_league_bets[lg], dtype=float)  # [N, 2]: stake, profit
        n_lg = len(arr)
        if n_lg >= 30:
            rng = np.random.default_rng(BOOTSTRAP_SEED + hash(lg) % 100)
            idx = rng.integers(0, n_lg, size=(BOOTSTRAP_N, n_lg))
            resampled = arr[idx]  # [B, N, 2]
            stake_sums = resampled[:, :, 0].sum(axis=1)
            profit_sums = resampled[:, :, 1].sum(axis=1)
            rois = np.where(stake_sums > 0, profit_sums / stake_sums, 0.0)
            pl["roi_ci95_low"] = round(float(np.quantile(rois, 0.025)), 4)
            pl["roi_ci95_high"] = round(float(np.quantile(rois, 0.975)), 4)
            pl["ci_excludes_zero"] = bool(pl["roi_ci95_low"] > 0 or pl["roi_ci95_high"] < 0)
        else:
            pl["roi_ci95_low"] = None
            pl["roi_ci95_high"] = None
            pl["ci_excludes_zero"] = False

    return {
        "profile": result.profile,
        "n_bets": n,
        "wins": wins,
        "hit_rate": round(wins / n, 4),
        "starting_bankroll": result.starting_bankroll,
        "final_bankroll": round(result.final_bankroll, 2),
        "roi": round(roi, 4),
        "total_stake": round(total_stake, 2),
        "total_profit": round(total_profit, 2),
        "max_drawdown": round(max_dd, 4),
        "sharpe_daily_annualised": round(sharpe, 3),
        "calmar": round(calmar, 3) if math.isfinite(calmar) else None,
        "edge_buckets": buckets,
        "per_league": per_league,
    }


# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Kelly-staking backtest on v2 OOT × Pinnacle close.")
    parser.add_argument("--oot", default=str(OOT_PARQUET))
    parser.add_argument("--odds", default=str(ODDS_CACHE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--edge-min", type=float, default=0.025, help="Minimum engine edge to bet (default 2.5 %)")
    parser.add_argument("--edge-max", type=float, default=0.075, help="Maximum engine edge to bet (default 7.5 %)")
    parser.add_argument("--bankroll", type=float, default=10000.0)
    args = parser.parse_args()

    if not Path(args.oot).exists():
        raise SystemExit(f"OOT parquet missing: {args.oot}")
    if not Path(args.odds).exists():
        raise SystemExit(
            f"Odds cache missing: {args.odds}\n"
            "Run `tools/venv/bin/python tools/fit_benter.py` once first — it writes the cache."
        )

    oot = pd.read_parquet(args.oot)
    odds = pd.read_parquet(args.odds)

    # Normalise types (parquet stores dates as datetime64; odds cached them as strings)
    oot["match_date"] = pd.to_datetime(oot["match_date"]).dt.date.astype(str)
    odds["match_date"] = pd.to_datetime(odds["match_date"]).dt.date.astype(str)
    for col in ("psch", "pscd", "psca"):
        odds[col] = pd.to_numeric(odds[col], errors="coerce")
    odds = odds.dropna(subset=["psch", "pscd", "psca"])

    # Vig removal — proportional normalisation of 1/odds
    raw = np.stack([1.0 / odds["psch"], 1.0 / odds["pscd"], 1.0 / odds["psca"]], axis=1)
    overround = raw.sum(axis=1, keepdims=True)
    implied = raw / overround
    odds["pinn_h"] = implied[:, 0]
    odds["pinn_d"] = implied[:, 1]
    odds["pinn_a"] = implied[:, 2]

    merged = oot.merge(
        odds[["league", "match_date", "home_team", "away_team",
              "psch", "pscd", "psca", "pinn_h", "pinn_d", "pinn_a"]],
        on=["league", "match_date", "home_team", "away_team"],
        how="inner",
    ).sort_values("match_date").reset_index(drop=True)
    print(f"[sim] joined {len(merged)} rows ({len(merged)/len(oot)*100:.1f}% of OOT)")

    all_metrics: Dict[str, Dict] = {}
    for profile in ("K", "M", "A"):
        sim = simulate(merged, profile, args.edge_min, args.edge_max, args.bankroll)
        m = metrics_for(sim)
        all_metrics[profile] = m

        print(f"\n── Profile {profile}  (cap {RISK_CAPS[profile]*100:.1f}% / bet) ──")
        print(f"  bets:          {m['n_bets']}")
        if m["n_bets"] == 0:
            print(f"  {m['note']}")
            continue
        print(f"  hit rate:      {m['hit_rate']*100:.2f}%")
        print(f"  ROI:           {m['roi']*100:+.2f}%  ({args.bankroll:.0f} → {m['final_bankroll']:.2f})")
        print(f"  total stake:   {m['total_stake']:.0f}")
        print(f"  max drawdown:  {m['max_drawdown']*100:.2f}%")
        print(f"  Sharpe (ann.): {m['sharpe_daily_annualised']:.3f}")
        print(f"  Calmar:        {m['calmar']}")
        print(f"  edge buckets:")
        for k, b in m["edge_buckets"].items():
            if b["n"] == 0:
                print(f"    {k:<10} n=0  (no bets)")
            else:
                print(f"    {k:<10} n={b['n']:>4}  hit={b['hit_rate']*100:>5.2f}%  avg_pnl={b['roi_on_bucket']:+.2f}")

    # Per-league ROI table on the middle (M) profile — typical retail setting.
    mid = all_metrics.get("M", {})
    if mid.get("per_league"):
        print(f"\n── Per-league ROI  (profile M)  — * = 95% CI excludes zero ──")
        print(f"  {'league':<18} {'n':>4} {'hit':>7} {'ROI_stake':>11}  {'95% CI':<22}")
        rows = sorted(mid["per_league"].items(), key=lambda x: -x[1]["roi_on_stake"])
        for lg, pl in rows:
            lo = pl.get("roi_ci95_low")
            hi = pl.get("roi_ci95_high")
            if lo is not None and hi is not None:
                ci_str = f"[{lo*100:+6.2f}%, {hi*100:+6.2f}%]"
            else:
                ci_str = "(n<30 — skipped)"
            excl = " *" if pl.get("ci_excludes_zero") else "  "
            print(f"  {lg:<18} {pl['n']:>4} {pl['hit_rate']*100:>6.2f}%  {pl['roi_on_stake']*100:>+9.2f}%  {ci_str}{excl}")

    output = {
        "generated_at": pd.Timestamp.utcnow().isoformat() + "Z",
        "source": {
            "oot_parquet": os.path.relpath(args.oot, REPO_ROOT),
            "odds_cache": os.path.relpath(args.odds, REPO_ROOT),
        },
        "config": {
            "edge_min": args.edge_min,
            "edge_max": args.edge_max,
            "risk_caps": RISK_CAPS,
            "starting_bankroll": args.bankroll,
            "goldilocks": f"{args.edge_min:.2%} – {args.edge_max:.2%}",
        },
        "n_joined": int(len(merged)),
        "profiles": all_metrics,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(output, indent=2, default=float))
    print(f"\n[sim] wrote {args.out}")


if __name__ == "__main__":
    main()
