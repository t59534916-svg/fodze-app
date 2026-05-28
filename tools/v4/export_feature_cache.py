"""
export_feature_cache.py — Snapshot Elo + Momentum + League-Constants for the
dev-03 TS-runtime feature builder.

Rationale:
  - Python feature builder computes m2_lambda features from full team_xg_history
    (87k rows). The browser can't load that much data per match.
  - But: m2_lambda features need only the team's last-16-match history
    (already loaded by MatchdayContext as `xg_h_history`).
  - What the browser CAN'T compute locally:
      * EloCalculator.fit() — needs FULL chronological history across all 87k rows
      * TeamMomentumCalculator.fit() — needs 365d rolling per-league norms
      * compute_league_constants() — needs FULL per-league avg xG
  - Solution: precompute snapshots offline (this script), serve as JSON.

Output: public/dev03-feature-cache.json

JSON shape:
{
  "version": "dev-03-feature-cache-1",
  "exported_at": "...",
  "data_window": {"history_through": "...", "n_history_rows": 87330},
  "league_constants": {
    "epl":         {"home_xg_avg": 1.55, "away_xg_avg": 1.30, "home_advantage": 0.25, "total_avg": 2.85, "n_matches": 12345, "source": "computed"},
    "bundesliga":  {...},
    ...
  },
  "elo": {
    "epl|Arsenal":          1567.3,
    "epl|Manchester City":  1612.4,
    ...
  },
  "momentum": {
    "epl|Arsenal": {"raw_lineup": 0.45, "raw_form": 9.0, "n_seen": 41},
    ...
  },
  "momentum_norms": {
    "epl": {"mu_lineup": 0.08, "sd_lineup": 0.72, "mu_form": 4.85, "sd_form": 2.10},
    ...
  }
}

Update cadence: weekly (after refresh-all.mjs). Stale cache is OK — Elo + Momentum
ratings shift slowly. Worst-case staleness for a team that played 3 matches since
last snapshot is ~30 Elo points / ~0.3 raw_lineup — within model noise.

Usage:
    tools/venv/bin/python3 tools/v4/export_feature_cache.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd

from v4.data.loaders import load_team_xg_history
from v4.modules.m2_lambda import compute_league_constants
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator

OUTPUT_PATH = REPO_ROOT / "public/dev03-feature-cache.json"

# All 22 FODZE leagues (matches `LEAGUES` in dixon-coles.ts)
LEAGUES = [
    "epl", "la_liga", "bundesliga", "serie_a", "ligue_1",
    "championship", "liga3", "bundesliga2", "serie_b", "la_liga2",
    "eredivisie", "primeira_liga", "ligue_2", "league_one", "league_two",
    "eerste_divisie", "scottish_prem", "jupiler_pro", "austria_bl",
    "swiss_sl", "greek_sl", "super_lig",
]


def main() -> None:
    print("=" * 70)
    print("dev-03 feature-cache exporter")
    print("=" * 70)

    print("Loading team_xg_history (all 22 leagues)...")
    history = load_team_xg_history(leagues=LEAGUES)
    history["match_date"] = pd.to_datetime(history["match_date"])
    # Don't resort here — the SQL loader returns rows already ordered by
    # (match_date, team). A naive `sort_values("match_date")` would use the
    # default (unstable) quicksort, scrambling same-date ties. Since
    # EloCalculator + TeamMomentumCalculator now sort by canonical
    # (match_date, team, opponent) internally with mergesort (see fix
    # 2026-05-21), our input order doesn't matter — but resorting here
    # would re-introduce the order-sensitivity for any downstream caller
    # that bypasses those calculators.
    n_total = len(history)
    history_through = history["match_date"].max()
    print(f"  → {n_total:,} rows, through {history_through.date()}")

    # ── 1. League constants ──────────────────────────────────────────────
    print("\nComputing league constants (avg xG home/away, home advantage)...")
    league_constants: Dict[str, Dict[str, Any]] = {}
    # snapshot_date = history_through + 30 days. The 30-day forward shift
    # ensures: (a) the cache predicts matches AFTER all known history,
    # (b) the 540-day lookback in compute_league_constants is consistent
    # with the test/production code path (which passes before_date for the
    # actual match-date, typically days-to-weeks after history_through),
    # (c) Python's get_rating(before_date=future) and our cached values
    # use the same temporal cutoff.
    snapshot_date = history_through + pd.Timedelta(days=30)
    for lg in LEAGUES:
        c = compute_league_constants(history, league=lg, before_date=snapshot_date)
        league_constants[lg] = {
            "home_xg_avg": c["home_xg_avg"],
            "away_xg_avg": c["away_xg_avg"],
            "home_advantage": c["home_advantage"],
            "total_avg": c["total_avg"],
            "n_matches": int(c["n_matches"]),
            "source": c["source"],
        }
        print(f"  {lg:<20s}  home={c['home_xg_avg']:.3f}  away={c['away_xg_avg']:.3f}  adv={c['home_advantage']:+.3f}  (n={c['n_matches']:,}, {c['source']})")

    # ── 2. Elo ratings ────────────────────────────────────────────────────
    print("\nFitting EloCalculator (one chronological pass)...")
    t0 = pd.Timestamp.now()
    elo = EloCalculator().fit(history)
    print(f"  → fitted in {(pd.Timestamp.now() - t0).total_seconds():.1f}s")
    print(f"  Stats: {elo.stats()}")

    # Snapshot the LATEST stored rating per (team, league). Use `_history[-1]`
    # NOT `_current` — see comment below. The two differ by one update:
    #   _current = post-last-match (after the most-recent match was processed)
    #   _history[-1] = pre-last-match (snapshot taken before the last update)
    # Python's `get_rating(team, league, before_date=future)` binary-searches
    # `_history` and returns the latest snapshot's rating = pre-last-match.
    # Our TS port must match Python's prediction semantics, so we store
    # _history[-1] here (slightly stale by one match's worth of updates
    # ~10-20 Elo points — same staleness Python production already has).
    elo_snapshot: Dict[str, float] = {}
    for (league, team), snapshots in elo._history.items():
        if not snapshots:
            continue
        key = f"{league}|{team}"
        elo_snapshot[key] = float(snapshots[-1].rating)
    print(f"  → {len(elo_snapshot):,} (league, team) Elo snapshots (pre-last-match = matches Python.get_rating semantics)")

    # ── 3. Momentum (lineup_quality + form_streak) ───────────────────────
    print("\nFitting TeamMomentumCalculator...")
    t0 = pd.Timestamp.now()
    momentum = TeamMomentumCalculator().fit(history)
    print(f"  → fitted in {(pd.Timestamp.now() - t0).total_seconds():.1f}s")
    print(f"  Stats: {momentum.stats()}")

    # Latest snapshot per (league, team)
    mom_snapshot: Dict[str, Dict[str, float]] = {}
    for (league, team), snaps in momentum._snapshots.items():
        if not snaps:
            continue
        latest = snaps[-1]  # most recent snapshot
        key = f"{league}|{team}"
        mom_snapshot[key] = {
            "raw_lineup": float(latest.raw_lineup),
            "raw_form": float(latest.raw_form),
            "n_seen": int(latest.n_seen),
        }
    print(f"  → {len(mom_snapshot):,} (league, team) momentum snapshots")

    # Per-league norm stats — use the LATEST (most recent date) per league
    mom_norms: Dict[str, Dict[str, float]] = {}
    for league, stats_list in momentum._norms.items():
        if not stats_list:
            continue
        latest_date, mu_l, sd_l, mu_f, sd_f = stats_list[-1]
        mom_norms[league] = {
            "mu_lineup": float(mu_l),
            "sd_lineup": float(sd_l),
            "mu_form": float(mu_f),
            "sd_form": float(sd_f),
            "computed_at": str(latest_date.date()),
        }
    print(f"  → {len(mom_norms):,} per-league norm stats")

    # ── 4. Assemble + write ──────────────────────────────────────────────
    payload = {
        "version": "dev-03-feature-cache-1",
        "exported_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "data_window": {
            "history_through": history_through.isoformat(),
            "snapshot_date": snapshot_date.isoformat(),
            "n_history_rows": n_total,
        },
        "league_constants": league_constants,
        "elo": elo_snapshot,
        "elo_default": 1500.0,
        "momentum": mom_snapshot,
        "momentum_norms": mom_norms,
        "momentum_default": {"raw_lineup": 0.0, "raw_form": 0.0, "n_seen": 0},
        "meta": {
            "elo_K": 20.0,
            "elo_home_field": 100.0,
            "elo_initial_rating": 1500.0,
            "lineup_window": 5,
            "form_window": 3,
            "form_weights": [3.0, 2.0, 1.0],
            "norm_lookback_days": 365,
            "z_clip_range": [-3.0, 3.0],
            "ewma_halflife": 8.0,
            "lookback_matches": 16,
            "min_team_matches": 4,
            "lambda_min": 0.30,
            "lambda_max": 4.50,
        },
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\n→ Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.1f} KB)")
    print(f"  - {len(league_constants)} league_constants")
    print(f"  - {len(elo_snapshot):,} elo snapshots")
    print(f"  - {len(mom_snapshot):,} momentum snapshots")
    print(f"  - {len(mom_norms)} per-league norm stats")
    print(f"  - history_through: {history_through.date()}")


if __name__ == "__main__":
    main()
