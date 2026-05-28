"""
generate_dev03_features_golden.py — Build golden-fixture pairs for parity-
testing the TS port of dev-03 feature builder against the Python reference.

Picks 3 representative real matches from 25/26 (EPL/Serie A/liga3), runs the
full Python pipeline (m2_lambda compute_features + Elo + Momentum), captures:
  - inputs the TS port will receive (per-team last-16 history)
  - expected outputs (the 17-feature vector)

Output: tests/fixtures/dev03-features-golden.json
Loaded by: tests/dev03-features.test.ts
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import pandas as pd

from v4.data.loaders import load_match_pairs, load_team_xg_history
from v4.modules.m2_lambda import LambdaEstimator
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator
from v4.modules.m3_xg.feature_builder import build_features_for_match

OUTPUT_PATH = REPO_ROOT / "tests/fixtures/dev03-features-golden.json"

# Match the leagues + season of the dev03-feature-cache exporter for parity
LEAGUES = [
    "epl", "la_liga", "bundesliga", "serie_a", "ligue_1",
    "championship", "liga3", "bundesliga2", "serie_b", "la_liga2",
    "eredivisie", "primeira_liga", "ligue_2", "league_one", "league_two",
    "eerste_divisie", "scottish_prem", "jupiler_pro", "austria_bl",
    "swiss_sl", "greek_sl", "super_lig",
]


def pick_match(pairs: pd.DataFrame, league: str, prefer_recent_n: int = 50) -> dict:
    """Pick one well-instrumented match from a league's recent matches.

    Picks the LAST match in `prefer_recent_n` that has both teams with
    ≥ 8 prior matches (to ensure stable EWMA inputs).
    """
    sub = pairs[pairs["league"] == league].sort_values("match_date").tail(prefer_recent_n)
    if sub.empty:
        return None
    # Take the last one
    row = sub.iloc[-1]
    return {
        "league": league,
        "home_team": row["home"],
        "away_team": row["away"],
        "match_date": row["match_date"].isoformat(),
    }


def history_last_n_for_team(
    history: pd.DataFrame, team: str, league: str,
    before_date: pd.Timestamp, n: int = 16,
) -> list:
    """Return team's last-n matches NEWEST-FIRST, as dicts."""
    df = history[
        (history["team"] == team)
        & (history["league"] == league)
        & (history["match_date"] < before_date)
    ].sort_values("match_date", ascending=False).head(n)
    return [
        {
            "xg": float(r.xg) if pd.notna(r.xg) else None,
            "xga": float(r.xga) if pd.notna(r.xga) else None,
            "goals_for": int(r.goals_for) if pd.notna(r.goals_for) else None,
            "goals_against": int(r.goals_against) if pd.notna(r.goals_against) else None,
            "date": pd.Timestamp(r.match_date).date().isoformat(),
            "opponent": r.opponent,
        }
        for _, r in df.iterrows()
    ]


def main() -> None:
    print("Loading 25/26 match pairs + full team_xg_history...")
    pairs = load_match_pairs(since="2025-08-01", leagues=LEAGUES).dropna(
        subset=["home_goals", "away_goals"]
    )
    history = load_team_xg_history(leagues=LEAGUES)
    history["match_date"] = pd.to_datetime(history["match_date"])

    # Fit calculators
    print("Fitting Elo + Momentum...")
    elo = EloCalculator().fit(history)
    momentum = TeamMomentumCalculator().fit(history)
    estimator = LambdaEstimator()

    # ── Synthetic "future" match_date ────────────────────────────────
    # The TS port consumes a precomputed cache (public/dev03-feature-cache.json)
    # which contains POST-FIT final Elo + Momentum snapshots from the full
    # history. So we need to evaluate Python's pipeline at a date strictly
    # AFTER history_through to ensure Python's per-match filters return the
    # SAME state that the cache holds. Using the actual past match-date
    # gives Python pre-game data while cache has post-game data → mismatch.
    history_through = history["match_date"].max()
    synthetic_md = (history_through + pd.Timedelta(days=30)).to_pydatetime()
    print(f"\nHistory through: {history_through.date()}")
    print(f"Synthetic prediction date (post-snapshot): {synthetic_md.date()}\n")

    # Pick 3 representative matches: top-tier, mid-tier, lower-tier
    pick_leagues = ["epl", "serie_a", "liga3"]
    fixtures = []
    for lg in pick_leagues:
        m = pick_match(pairs, lg)
        if m is None:
            print(f"  ⚠ no match found for {lg}, skipping")
            continue

        # Override match_date with synthetic future date (see comment above)
        md = pd.Timestamp(synthetic_md)
        feats = build_features_for_match(
            home_team=m["home_team"],
            away_team=m["away_team"],
            league=lg,
            match_date=synthetic_md,
            history=history,
            estimator=estimator,
            elo_calculator=elo,
            momentum_calculator=momentum,
        )
        # Drop dev-04/05 features (TS port targets dev-03 schema: 16 numeric + 1 cat)
        for k in [
            "market_disagreement_flag",
            "market_disagreement_high",
            "lineup_quality_player_diff",
            "lineup_quality_player_available",
        ]:
            feats.pop(k, None)

        h_hist = history_last_n_for_team(history, m["home_team"], lg, md, n=16)
        a_hist = history_last_n_for_team(history, m["away_team"], lg, md, n=16)

        fixtures.append({
            "name": f"{lg}_{m['home_team']}_vs_{m['away_team']}".replace(" ", "_"),
            "input": {
                "homeTeam": m["home_team"],
                "awayTeam": m["away_team"],
                "league": lg,
                "match_date": synthetic_md.isoformat(),
                "hHistory": h_hist,
                "aHistory": a_hist,
            },
            # Expected feature output (17 features incl. categorical `league`)
            "expected_features": {
                k: (float(v) if isinstance(v, (int, float)) else v)
                for k, v in feats.items()
            },
        })
        print(f"  → {lg}: {m['home_team']} vs {m['away_team']}")
        print(f"      home_attack_ratio={feats['home_attack_ratio']:.4f}, lambda_h_naive={feats['lambda_h_naive']:.4f}")
        print(f"      elo_diff={feats['elo_diff']:.2f}, lineup_quality_diff={feats['lineup_quality_diff']:+.4f}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump({
            "version": "dev-03-golden-1",
            "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "tolerance_note": "TS port must match within 1e-6 for all numeric features.",
            "fixtures": fixtures,
        }, f, indent=2)

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\nWrote {OUTPUT_PATH.relative_to(REPO_ROOT)} ({size_kb:.1f} KB) with {len(fixtures)} fixtures")


if __name__ == "__main__":
    main()
