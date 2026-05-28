"""GK shot-stopping quality signal test (Phase B).

Hypothesis: rolling per-GK save-quality (xGOT-against minus goals-against)
adds Brier-improvable signal to dev-03 beyond what's captured by team-level
defense_ratio + xga_ewma features.

GK quality = saves more (or fewer) goals than xGOT predicts:
  Per game × GK: shots_faced = SUM(xgot of shots against this GK)
                 goals_conceded = SUM(goals scored against this GK)
                 save_value = xgot_against - goals_conceded
                 (positive = saved more than expected, "shot-stopping above replacement")

For each match, feature = home_GK_rolling_save_quality - away_GK_rolling_save_quality.
Diff aligns with home-bias of dev-03 (positive feature → home better keeper → home advantage).

Empirical test (same structure as Phase A starter-feature test):
  Test Pearson correlation between GK_quality_diff and per-outcome Brier error.
  Acceptance: |r| > 0.05 with Bonferroni-corrected p < 0.01 for at least
  1 of 3 outcomes (H/D/A) in at least 1 of 5 validated-edge leagues.

Output: tools/v4/diagnostics/gk_quality_signal.json
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
INPUT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
OUTPUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "gk_quality_signal.json"

VALIDATED_LEAGUES = ["epl", "serie_a", "scottish_prem", "la_liga", "serie_b"]
ROLLING_WINDOW = 8           # last-N games per GK for save-quality average
SIG_THRESHOLD = 0.05
BONFERRONI_ALPHA = 0.01


def build_gk_index(conn: sqlite3.Connection) -> dict:
    """Pre-build per-GK rolling save-quality cache.

    Returns: {gk_id: [(match_ts, save_value), ...]} sorted by ts ascending.
    Save_value = xgot_against - goals_conceded for one match.
    """
    print("[index] aggregating GK save-quality per match...")
    # Get all (game_id, GK_player_id, is_home) tuples
    gks = conn.execute("""
        SELECT pms.game_id, pms.player_id, pms.is_home, sm.start_timestamp
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        WHERE pms.position = 'G' AND pms.is_starter = 1
          AND pms.minutes_played >= 70
    """).fetchall()
    print(f"[index] {len(gks):,} GK appearances")

    # For each (game, GK_side), compute total xgot + goals_against from shotmap
    # Shots AGAINST a team are shotmap rows where is_home != GK_side
    gk_history: dict = {}
    for game_id, gk_id, gk_is_home, ts in gks:
        # Shots faced by THIS GK = opponent's shots (is_home != gk_is_home)
        shot_data = conn.execute("""
            SELECT SUM(COALESCE(xgot, 0)) as xgot_sum,
                   SUM(CASE WHEN shot_type = 'goal' THEN 1 ELSE 0 END) as goals
            FROM sofascore_shotmap
            WHERE game_id = ? AND is_home != ?
        """, (game_id, gk_is_home)).fetchone()
        xgot_against = shot_data[0] or 0.0
        goals_against = shot_data[1] or 0
        save_value = float(xgot_against - goals_against)
        # Store per-GK chronologically
        if gk_id not in gk_history:
            gk_history[gk_id] = []
        gk_history[gk_id].append((int(ts), save_value))

    # Sort each GK's history by ts ascending
    for gk_id in gk_history:
        gk_history[gk_id].sort()

    print(f"[index] {len(gk_history):,} unique GKs indexed")
    return gk_history


def gk_rolling_quality(gk_history: dict, gk_id: int, focal_ts: int,
                       window: int = ROLLING_WINDOW) -> float:
    """Return GK's rolling save-quality average over last-N matches BEFORE focal_ts.
    NaN if <3 history available (insufficient sample)."""
    hist = gk_history.get(gk_id, [])
    past = [(ts, v) for ts, v in hist if ts < focal_ts]
    if len(past) < 3:
        return float("nan")
    last_n = past[-window:]
    return float(np.mean([v for _, v in last_n]))


def find_gk_for_match(conn: sqlite3.Connection, game_id: int, is_home: int) -> int | None:
    """Get the starting GK's player_id for a given (game, side)."""
    result = conn.execute("""
        SELECT player_id FROM sofascore_player_match_stats
        WHERE game_id = ? AND is_home = ? AND is_starter = 1 AND position = 'G'
        LIMIT 1
    """, (game_id, is_home)).fetchone()
    return result[0] if result else None


def find_game_id(conn: sqlite3.Connection, league: str, match_date: str,
                 home_team: str, away_team: str) -> int | None:
    result = conn.execute("""
        SELECT game_id FROM sofascore_match
        WHERE league = ? AND date(start_timestamp, 'unixepoch') = ?
          AND home_team = ? AND away_team = ?
        LIMIT 1
    """, (league, match_date, home_team, away_team)).fetchone()
    if result:
        return result[0]
    result = conn.execute("""
        SELECT game_id FROM sofascore_match
        WHERE league = ?
          AND date(start_timestamp, 'unixepoch') BETWEEN date(?, '-1 day') AND date(?, '+1 day')
          AND home_team LIKE ? AND away_team LIKE ?
        LIMIT 1
    """, (league, match_date, match_date, f"%{home_team[:8]}%", f"%{away_team[:8]}%")).fetchone()
    return result[0] if result else None


def main():
    print(f"[load] {INPUT_PARQUET.name}")
    preds = pd.read_parquet(INPUT_PARQUET)
    preds["match_date_str"] = pd.to_datetime(preds["match_date"]).dt.strftime("%Y-%m-%d")
    print(f"[load] {len(preds):,} OOT predictions")

    conn = sqlite3.connect(f"file:{LOCAL_DB}?mode=ro", uri=True)
    gk_history = build_gk_index(conn)

    # Compute GK quality diff per match
    print("[compute] GK quality diff per match...")
    rows = []
    for _, row in preds.iterrows():
        gid = find_game_id(conn, row["league"], row["match_date_str"],
                          row["home_team"], row["away_team"])
        if gid is None:
            continue
        home_gk = find_gk_for_match(conn, gid, 1)
        away_gk = find_gk_for_match(conn, gid, 0)
        if not home_gk or not away_gk:
            continue
        # Match kickoff timestamp
        ts_result = conn.execute("SELECT start_timestamp FROM sofascore_match WHERE game_id = ?",
                                (gid,)).fetchone()
        if not ts_result:
            continue
        focal_ts = int(ts_result[0])
        home_quality = gk_rolling_quality(gk_history, home_gk, focal_ts)
        away_quality = gk_rolling_quality(gk_history, away_gk, focal_ts)
        if np.isnan(home_quality) or np.isnan(away_quality):
            continue
        rows.append({
            "league": row["league"],
            "ft_result": row["ft_result"],
            "prob_h_raw": row["prob_h_raw"],
            "prob_d_raw": row["prob_d_raw"],
            "prob_a_raw": row["prob_a_raw"],
            "gk_quality_diff": home_quality - away_quality,
        })
    df = pd.DataFrame(rows)
    print(f"[compute] {len(df):,} matches with full GK feature coverage")

    # Test
    outcomes = ["H", "D", "A"]
    n_tests = len(outcomes) * (1 + len(VALIDATED_LEAGUES))
    bonferroni_p = BONFERRONI_ALPHA / n_tests
    print(f"\n[test] {n_tests} hypothesis tests, Bonferroni alpha={bonferroni_p:.5f}")

    results = []

    def test_one(sub_df, outcome, label):
        if len(sub_df) < 30:
            return {"scope": label, "outcome": outcome, "n": int(len(sub_df)),
                    "pearson_r": None, "p_value": None, "passes_gate": False}
        p_col = {"H": "prob_h_raw", "D": "prob_d_raw", "A": "prob_a_raw"}[outcome]
        realized = (sub_df["ft_result"] == outcome).astype(int).values
        brier = (sub_df[p_col].values - realized) ** 2
        r, p = stats.pearsonr(sub_df["gk_quality_diff"].values, brier)
        return {"scope": label, "outcome": outcome, "n": int(len(sub_df)),
                "pearson_r": float(r), "p_value": float(p),
                "passes_gate": abs(r) > SIG_THRESHOLD and p < bonferroni_p}

    for o in outcomes:
        results.append(test_one(df, o, "all"))
    for lg in VALIDATED_LEAGUES:
        sub = df[df["league"] == lg]
        for o in outcomes:
            results.append(test_one(sub, o, lg))

    passing = [r for r in results if r["passes_gate"]]

    print(f"\n{'='*60}")
    print(f"{'scope':<16}{'outcome':<10}{'n':>6}{'r':>10}{'p':>10}{'pass':>6}")
    print('-' * 60)
    for r in results:
        if r["pearson_r"] is None:
            continue
        mark = "✓" if r["passes_gate"] else ""
        print(f"{r['scope']:<16}{r['outcome']:<10}{r['n']:>6}"
              f"{r['pearson_r']:>+10.4f}{r['p_value']:>10.5f}{mark:>6}")
    print('=' * 60)
    print(f"\n[summary] {len(passing)} of {len(results)} pass empirical gate")

    if passing:
        rec = {"ship_gk_feature": True,
               "passing_tests": passing,
               "rationale": f"{len(passing)} significant tests after Bonferroni. "
                            "GK shot-stopping quality has signal beyond defense_ratio.",
               "next_step": "Add gk_quality_diff to dev-03 feature_builder for E retrain."}
    else:
        max_r = max((r for r in results if r["pearson_r"] is not None),
                    key=lambda r: abs(r["pearson_r"]), default=None)
        rec = {"ship_gk_feature": False,
               "rationale": (f"No test clears Bonferroni alpha={bonferroni_p:.5f}. "
                            f"Strongest: |r|={abs(max_r['pearson_r']):.4f} on "
                            f"{max_r['scope']}/{max_r['outcome']}." if max_r else "No data"),
               "next_step": "GK quality fully captured by team-level defense_ratio. Skip."}

    OUTPUT_JSON.write_text(json.dumps({
        "version": "1.0",
        "input_n": int(len(preds)),
        "n_matches_with_gk_data": int(len(df)),
        "rolling_window": ROLLING_WINDOW,
        "bonferroni_alpha": float(bonferroni_p),
        "results": results,
        "recommendation": rec,
    }, indent=2, default=str))
    print(f"\n[write] {OUTPUT_JSON}")
    print(f"[recommendation] ship_gk_feature = {rec['ship_gk_feature']}")
    print(f"[rationale] {rec['rationale']}")


if __name__ == "__main__":
    main()
