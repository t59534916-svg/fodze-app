"""CSD-veto Money-Eval — ultimate acceptance gate.

The Brier-lift validation in csd_veto_threshold_calibration.py shows the
model is +0.043 less reliable in persistent_reversal regime. But Brier-lift
≠ profitable veto. We need to verify the Kelly-PnL impact.

Simulation:
  1. Join v2-OOT predictions × odds-close-25-26 on (league, match_date, teams)
  2. For each prediction × outcome, compute Kelly stake using moderate cap (4%)
     + Goldilocks per-Liga edge-zone filter (sharp 1.5-5%)
  3. Compute PnL: stake × (decimal_odds - 1) if outcome realized else -stake
  4. Apply CSD veto per-team-side:
       - persistent_reversal on home team → 0.5x stake on home & draw bets
       - persistent_reversal on away team → 0.5x stake on away & draw bets
  5. Compare: total PnL shield-off vs shield-on
  6. Bootstrap CI on PnL-difference (1000 resamples on per-bet PnL)

Acceptance gate:
  shield-on PnL >= shield-off PnL
  Bootstrap-CI Lower-Bound on PnL-delta >= 0

Output: tools/v4/diagnostics/csd_veto_money_eval.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

from v4.data.loaders import load_team_xg_history  # noqa: E402
from v4.modules.m9_filter_shield import (  # noqa: E402
    compute_csd_veto,
    load_config,
    csd_veto_to_shield_veto,
    FilterShield,
)


INPUT_PREDS = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
INPUT_ODDS = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
OUTPUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "csd_veto_money_eval.json"

# Goldilocks per-Liga edge zones (sharp tier default; matches src/lib/dixon-coles.ts)
EDGE_MIN_PCT = 1.5   # min edge to bet
EDGE_MAX_PCT = 7.5   # max edge (above = trap suspect, no bet)
KELLY_CAP_PCT = 4.0  # moderate (M) risk profile cap
BOOTSTRAP_N = 1000
RNG_SEED = 20260522


def vig_removed_probs(psch: float, pscd: float, psca: float) -> tuple[float, float, float]:
    """Pinnacle closing odds → vig-removed implied probabilities."""
    if any(x is None or not np.isfinite(x) or x <= 1.0 for x in (psch, pscd, psca)):
        return (np.nan, np.nan, np.nan)
    inv = (1/psch, 1/pscd, 1/psca)
    total = sum(inv)
    return tuple(p / total for p in inv)


def kelly_stake(prob_model: float, decimal_odds: float, cap_pct: float = KELLY_CAP_PCT
                ) -> float:
    """Edge-based Kelly with risk cap. Returns stake as fraction of bankroll."""
    if not np.isfinite(prob_model) or not np.isfinite(decimal_odds) or decimal_odds <= 1.0:
        return 0.0
    edge = prob_model * decimal_odds - 1.0
    if edge <= 0:
        return 0.0
    f = edge / (decimal_odds - 1.0)
    return min(f, cap_pct / 100.0)


def in_goldilocks_zone(edge_pct: float) -> bool:
    return EDGE_MIN_PCT <= edge_pct <= EDGE_MAX_PCT


def main():
    print(f"[load] {INPUT_PREDS.name}")
    preds = pd.read_parquet(INPUT_PREDS)
    preds["match_date"] = pd.to_datetime(preds["match_date"])

    print(f"[load] {INPUT_ODDS.name}")
    odds = pd.read_parquet(INPUT_ODDS)
    odds["match_date"] = pd.to_datetime(odds["match_date"])

    # Join
    print("[join] preds × odds on (league, match_date, home_team, away_team)")
    df = preds.merge(
        odds[["league", "match_date", "home_team", "away_team",
              "psch", "pscd", "psca", "ft_result"]],
        on=["league", "match_date", "home_team", "away_team"],
        how="inner",
        suffixes=("", "_odds"),
    )
    # Prefer the odds-side ft_result (closer to ground-truth source)
    df["ft_result"] = df["ft_result_odds"]
    df = df.drop(columns=["ft_result_odds"])
    print(f"[join] {len(df):,} matched predictions (of {len(preds):,} preds, {len(odds):,} odds)")

    # Compute vig-removed sharp probs (used as "market truth" baseline; bet against if
    # model thinks differently — i.e. edge against the market)
    # Actually we bet against MARKET odds — model prob vs decimal odds.
    # So we use the RAW decimal odds (psch/pscd/psca), not vig-removed.

    # Add CSD veto for each match × team-side
    earliest = df["match_date"].min() - pd.Timedelta(days=730)
    print(f"[load] team_xg_history for CSD computation since {earliest.date()}")
    team_xg = load_team_xg_history(since=earliest.strftime("%Y-%m-%d"))
    team_xg["match_ts"] = (team_xg["match_date"].astype("int64") // 10**9).astype(int)

    print("[index] building team history index...")
    team_dates: dict = {}
    for (league, team), g in team_xg.groupby(["league", "team"], sort=False):
        g_sorted = g.sort_values("match_ts", kind="mergesort")
        team_dates[(league, team)] = {
            "ts": g_sorted["match_ts"].values,
            "goals_for": g_sorted["goals_for"].fillna(0).values.astype(float),
            "goals_against": g_sorted["goals_against"].fillna(0).values.astype(float),
        }

    print("[compute] per-team CSD classification...")
    cfg = load_config().csd_veto
    df["match_ts"] = (df["match_date"].astype("int64") // 10**9).astype(int)

    home_regime = []
    away_regime = []
    for _, row in df.iterrows():
        for side, key in [("home", "home_team"), ("away", "away_team")]:
            team = row[key]
            rec = team_dates.get((row["league"], team))
            if rec is None:
                regime = "no_history"
            else:
                cutoff = int(row["match_ts"]) - cfg.leakage_offset_sec
                mask = rec["ts"] <= cutoff
                if not mask.any():
                    regime = "no_history"
                else:
                    idx = np.where(mask)[0][-cfg.window:]
                    series = rec["goals_for"][idx] - rec["goals_against"][idx]
                    csd_r = compute_csd_veto(series, cfg)
                    regime = csd_r.regime
            if side == "home":
                home_regime.append(regime)
            else:
                away_regime.append(regime)
    df["home_csd_regime"] = home_regime
    df["away_csd_regime"] = away_regime

    print(f"[compute] regime counts (home / away):")
    for regime in ["persistent_reversal", "catastrophic", "stable", "insufficient_n", "no_history"]:
        nh = (df["home_csd_regime"] == regime).sum()
        na = (df["away_csd_regime"] == regime).sum()
        print(f"  {regime:>22}  home={nh:>5}  away={na:>5}")

    # ─────────────────────────────────────────────────────────────
    # Run simulation
    # ─────────────────────────────────────────────────────────────
    print("\n[sim] Kelly PnL simulation (shield-off vs shield-on)...")

    rows_pnl = []
    for _, row in df.iterrows():
        market_odds = {"H": row["psch"], "D": row["pscd"], "A": row["psca"]}
        model_p = {"H": row["prob_h_raw"], "D": row["prob_d_raw"], "A": row["prob_a_raw"]}
        ft = row["ft_result"]

        for outcome in ("H", "D", "A"):
            odds_dec = market_odds[outcome]
            p = model_p[outcome]
            if not np.isfinite(odds_dec) or odds_dec <= 1.0:
                continue

            edge_pct = (p * odds_dec - 1.0) * 100.0
            if not in_goldilocks_zone(edge_pct):
                continue

            stake_off = kelly_stake(p, odds_dec, KELLY_CAP_PCT)
            if stake_off <= 0:
                continue

            # Shield-on: apply CSD veto for relevant team
            haircut = 1.0
            home_reg = row["home_csd_regime"]
            away_reg = row["away_csd_regime"]

            # persistent_reversal is active → 0.5 multiplier
            pr_mult = cfg.regimes["persistent_reversal"].multiplier
            if outcome == "H" and home_reg == "persistent_reversal":
                haircut = min(haircut, pr_mult)
            if outcome == "A" and away_reg == "persistent_reversal":
                haircut = min(haircut, pr_mult)
            if outcome == "D":
                if home_reg == "persistent_reversal" or away_reg == "persistent_reversal":
                    haircut = min(haircut, pr_mult)

            stake_on = stake_off * haircut

            # PnL: stake × (odds-1) if win, else -stake
            won = (ft == outcome)
            pnl_off = stake_off * (odds_dec - 1.0) if won else -stake_off
            pnl_on = stake_on * (odds_dec - 1.0) if won else -stake_on

            rows_pnl.append({
                "league": row["league"],
                "match_date": row["match_date"],
                "outcome": outcome,
                "won": won,
                "edge_pct": edge_pct,
                "stake_off": stake_off,
                "stake_on": stake_on,
                "haircut": haircut,
                "pnl_off": pnl_off,
                "pnl_on": pnl_on,
                "shield_active": haircut < 1.0,
            })

    pnl_df = pd.DataFrame(rows_pnl)
    print(f"[sim] {len(pnl_df):,} bets placed (in-edge-zone)")
    print(f"[sim] {pnl_df['shield_active'].sum():,} bets had shield haircut applied")

    if len(pnl_df) == 0:
        print("[ERROR] no bets in edge zone — cannot evaluate")
        return

    # ─────────────────────────────────────────────────────────────
    # Bootstrap CI on PnL-delta
    # ─────────────────────────────────────────────────────────────
    print("\n[bootstrap] Computing CI on PnL-delta (1000 resamples)...")
    rng = np.random.default_rng(RNG_SEED)
    pnl_diff_per_bet = pnl_df["pnl_on"].values - pnl_df["pnl_off"].values
    boot_diffs = np.empty(BOOTSTRAP_N)
    for i in range(BOOTSTRAP_N):
        sample = rng.choice(pnl_diff_per_bet, size=len(pnl_diff_per_bet), replace=True)
        boot_diffs[i] = sample.sum()
    ci_lo, ci_hi = np.percentile(boot_diffs, [2.5, 97.5])

    total_pnl_off = float(pnl_df["pnl_off"].sum())
    total_pnl_on = float(pnl_df["pnl_on"].sum())
    pnl_delta = total_pnl_on - total_pnl_off
    total_staked_off = float(pnl_df["stake_off"].sum())
    total_staked_on = float(pnl_df["stake_on"].sum())

    print(f"\n{'='*60}")
    print(f"{'METRIC':<32}{'shield-off':>12}{'shield-on':>14}")
    print('-' * 60)
    print(f"{'n_bets':<32}{len(pnl_df):>12,}{len(pnl_df):>14,}")
    print(f"{'total_staked (bankroll-frac)':<32}{total_staked_off:>12.3f}{total_staked_on:>14.3f}")
    print(f"{'total_pnl (bankroll-frac)':<32}{total_pnl_off:>+12.3f}{total_pnl_on:>+14.3f}")
    print(f"{'ROI (PnL/Staked)':<32}{total_pnl_off/total_staked_off:>+12.3%}"
          f"{total_pnl_on/total_staked_on:>+14.3%}")
    print(f"{'PnL delta':<32}{'':>12}{pnl_delta:>+14.4f}")
    print(f"{'CI [2.5%, 97.5%]':<32}{'':>12}[{ci_lo:+.4f}, {ci_hi:+.4f}]")
    print('=' * 60)

    # On shield-affected bets only — most-informative comparison
    affected = pnl_df[pnl_df["shield_active"]]
    if len(affected) > 0:
        n_aff = len(affected)
        pnl_off_aff = affected["pnl_off"].sum()
        pnl_on_aff = affected["pnl_on"].sum()
        print(f"\nShield-affected bets only (n={n_aff}):")
        print(f"  shield-off PnL: {pnl_off_aff:+.4f}")
        print(f"  shield-on PnL:  {pnl_on_aff:+.4f}")
        print(f"  delta:          {pnl_on_aff - pnl_off_aff:+.4f}")
        print(f"  shield-off ROI: {pnl_off_aff / affected['stake_off'].sum():+.2%}")
        if affected['stake_on'].sum() > 0:
            print(f"  shield-on ROI:  {pnl_on_aff / affected['stake_on'].sum():+.2%}")

    # Acceptance gate
    passes_gate = ci_lo >= 0 and pnl_delta >= 0
    if passes_gate:
        print(f"\n[ACCEPT] CSD veto SHIPS — PnL delta {pnl_delta:+.4f}, CI lower {ci_lo:+.4f} ≥ 0")
    else:
        print(f"\n[REJECT] CSD veto FAILS — PnL delta {pnl_delta:+.4f}, CI [{ci_lo:+.4f}, {ci_hi:+.4f}]")
        print("[REJECT] Brier-lift did not translate to Kelly-PnL improvement.")

    output = {
        "version": "1.0",
        "input_preds": str(INPUT_PREDS.relative_to(REPO_ROOT)),
        "input_odds": str(INPUT_ODDS.relative_to(REPO_ROOT)),
        "n_predictions": len(preds),
        "n_matched": len(df),
        "n_bets_in_zone": len(pnl_df),
        "n_shield_affected": int(pnl_df["shield_active"].sum()),
        "params": {
            "edge_min_pct": EDGE_MIN_PCT,
            "edge_max_pct": EDGE_MAX_PCT,
            "kelly_cap_pct": KELLY_CAP_PCT,
            "csd_persistent_reversal_multiplier": cfg.regimes["persistent_reversal"].multiplier,
        },
        "results": {
            "total_pnl_off": total_pnl_off,
            "total_pnl_on": total_pnl_on,
            "pnl_delta": pnl_delta,
            "total_staked_off": total_staked_off,
            "total_staked_on": total_staked_on,
            "roi_off": total_pnl_off / total_staked_off,
            "roi_on": total_pnl_on / total_staked_on,
            "bootstrap_ci_lower": float(ci_lo),
            "bootstrap_ci_upper": float(ci_hi),
            "passes_gate": passes_gate,
        },
        "shield_affected": {
            "n": int(len(affected)) if len(affected) > 0 else 0,
            "pnl_off": float(affected["pnl_off"].sum()) if len(affected) > 0 else 0.0,
            "pnl_on": float(affected["pnl_on"].sum()) if len(affected) > 0 else 0.0,
        },
        "regime_counts": {
            "home": {regime: int((df["home_csd_regime"] == regime).sum())
                     for regime in ["persistent_reversal", "catastrophic",
                                   "stable", "insufficient_n", "no_history"]},
            "away": {regime: int((df["away_csd_regime"] == regime).sum())
                     for regime in ["persistent_reversal", "catastrophic",
                                   "stable", "insufficient_n", "no_history"]},
        },
    }
    OUTPUT_JSON.write_text(json.dumps(output, indent=2, default=str))
    print(f"\n[write] {OUTPUT_JSON}")


if __name__ == "__main__":
    main()
