#!/usr/bin/env python3
"""volume_tier_xg_source_check — PRE-CHECK (not a deliverable): for the 5
volume-tier leagues that have NO Sofa-xG, would a Sofa-shotmap-derived xG be a
better goal-predictor than the FootyStats xG they currently use?

Backfilling "real Sofa-xG" is impossible — Sofa emits 0 xG for these leagues
(50k+ shotmap rows, all xg=NULL). The only achievable path is computing xG
ourselves from the local shot coordinates. This script asks whether that is
even worth building, by comparing two xG proxies against ACTUAL GOALS at the
team-match level:
  A. FootyStats xG  (team_xg_history.xg, source=footystats — the status quo)
  B. Sofa shot-count xG  (n_shots × per-league goals/shot — the CRUDEST possible
     shotmap xG; a coordinate model would be an upper bound ABOVE this)

If even crude shot-count xG ties/beats FootyStats xG as a goal-predictor, a
coordinate model is promising. If FootyStats clearly wins, building one is
likely wasted effort (the status quo is already the better proxy).

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/volume_tier_xg_source_check.py
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd

from v4.modules.m3_xg.canonical_team_map import canonical_team

SQLITE = REPO / "tools" / "sofascore" / "data" / "local_extras.db"
VOL = ["la_liga2", "league_one", "league_two", "ligue_2", "eerste_divisie"]


def main() -> int:
    con = sqlite3.connect(f"file:{SQLITE}?mode=ro", uri=True)

    # ── Sofa team-match: shots + actual goals, canonicalized ──
    sofa = pd.read_sql_query(f"""
        SELECT m.game_id, m.league, m.start_timestamp,
               s.is_home,
               CASE WHEN s.is_home=1 THEN m.home_team ELSE m.away_team END AS team_raw,
               s.cnt AS shots,
               CASE WHEN s.is_home=1 THEN m.home_score ELSE m.away_score END AS goals
        FROM (SELECT game_id, is_home, COUNT(*) cnt FROM sofascore_shotmap GROUP BY game_id, is_home) s
        JOIN sofascore_match m ON s.game_id=m.game_id
        WHERE m.league IN ({','.join('?'*len(VOL))}) AND m.status='Ended' AND m.home_score IS NOT NULL
    """, con, params=VOL)
    sofa["date"] = pd.to_datetime(sofa["start_timestamp"], unit="s").dt.date
    sofa["cteam"] = sofa.apply(lambda r: canonical_team(r["team_raw"], r["league"]), axis=1)

    # per-league goals/shot → crude shot-xG
    g_per_shot = sofa.groupby("league").apply(
        lambda d: d["goals"].sum() / d["shots"].sum(), include_groups=False).to_dict()
    sofa["shot_xg"] = sofa.apply(lambda r: r["shots"] * g_per_shot[r["league"]], axis=1)

    # ── FootyStats xG from team_xg_history (status quo) ──
    fs = pd.read_sql_query(f"""
        SELECT team AS cteam, league, match_date, xg AS fs_xg, goals_for AS fs_goals
        FROM team_xg_history
        WHERE league IN ({','.join('?'*len(VOL))}) AND source='footystats' AND xg IS NOT NULL
    """, con, params=VOL)
    con.close()
    fs["date"] = pd.to_datetime(fs["match_date"]).dt.date

    # ── join on (league, canonical team, exact date) ──
    j = sofa.merge(fs, on=["league", "cteam", "date"], how="inner")
    # goals sanity: Sofa goals vs FootyStats goals_for should agree
    goal_agree = (j["goals"] == j["fs_goals"]).mean()
    print("═" * 72)
    print("  VOLUME-TIER xG SOURCE PRE-CHECK — Sofa-shot-xG vs FootyStats-xG vs goals")
    print("═" * 72)
    print(f"  joined team-matches: {len(j):,}  (Sofa∩FootyStats, exact date)")
    print(f"  goal agreement (Sofa vs FS): {goal_agree:.1%}  (sanity — should be ~100%)\n")

    def _metrics(pred, goals):
        pred, goals = np.asarray(pred, float), np.asarray(goals, float)
        rmse = float(np.sqrt(np.mean((pred - goals) ** 2)))
        corr = float(np.corrcoef(pred, goals)[0, 1])
        return rmse, corr

    print(f"  {'league':<16}{'n':>6}{'FS-xG rmse':>12}{'shot-xG rmse':>14}"
          f"{'FS r':>7}{'shot r':>8}  winner")
    rows = []
    for lg in VOL:
        d = j[j["league"] == lg]
        if len(d) < 50:
            print(f"  {lg:<16}{len(d):>6}   (too few)"); continue
        fr, fc = _metrics(d["fs_xg"], d["goals"])
        sr, sc = _metrics(d["shot_xg"], d["goals"])
        win = "FootyStats" if fr < sr else "Sofa-shots"
        rows.append({"league": lg, "n": len(d), "fs_rmse": fr, "shot_rmse": sr,
                     "fs_corr": fc, "shot_corr": sc, "winner": win})
        print(f"  {lg:<16}{len(d):>6}{fr:>12.4f}{sr:>14.4f}{fc:>7.3f}{sc:>8.3f}  {win}")

    if rows:
        fs_wins = sum(r["winner"] == "FootyStats" for r in rows)
        mean_fs_r = np.mean([r["fs_corr"] for r in rows])
        mean_shot_r = np.mean([r["shot_corr"] for r in rows])
        print("\n" + "─" * 72)
        print(f"  FootyStats-xG is the better goal-predictor in {fs_wins}/{len(rows)} leagues "
              f"(mean corr: FS {mean_fs_r:.3f} vs crude-shot {mean_shot_r:.3f}).")
        verdict = (
            "FootyStats xG already beats crude shot-count xG → a coordinate model would have "
            "to close that gap AND add value before helping. Build is HIGH-RISK / low-confidence; "
            "recommend NOT investing without a stronger signal."
            if fs_wins >= len(rows) - 1 else
            "Crude shot-count xG already competes with FootyStats → a coordinate model (which "
            "strictly improves on shot-count) is PROMISING; worth a scoped build + 5-Gate test."
        )
        print(f"  VERDICT: {verdict}")
    print("═" * 72)
    print("  NOTE: crude shot-count xG is the FLOOR; a coordinate model (shooter_x/y +")
    print("  body_part + situation) would sit somewhere above these shot-xG numbers.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
