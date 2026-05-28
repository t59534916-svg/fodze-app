"""Starter-feature signal test v2 — CORRECTED methodology.

v1 (starter_feature_signal_test.py) had a methodological flaw: tested
Pearson correlation between feature and SQUARED prediction error. That
conflates "feature correlates with outcome" with "feature adds signal
beyond what model captures."

v2 correctly tests against SIGNED residual = (realized - predicted).
If model already encodes the feature, residual should be uncorrelated
with feature. Non-zero correlation → genuine additive signal.

Math:
  signed_residual_o = 1{ft_result == o} - prob_o_raw   range [-1, +1]
  test: Pearson(feature_diff, signed_residual_o) per (feature, outcome, league)

Acceptance gate (same as v1 but on CORRECT test):
  |r| > 0.05 AND Bonferroni-corrected p < 0.01

Both v1 and v2 outputs are kept for audit trail.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
INPUT_PARQUET = REPO_ROOT / "tools" / "backtest" / "v2-oot-predictions.parquet"
OUTPUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "starter_feature_signal_v2.json"

VALIDATED_LEAGUES = ["epl", "serie_a", "scottish_prem", "la_liga", "serie_b"]
SIG_THRESHOLD = 0.05
BONFERRONI_ALPHA = 0.01


def starter_features_per_team(conn, game_id: int, is_home: int) -> dict:
    rows = conn.execute("""
        SELECT rating, is_captain, expected_goals, minutes_played
        FROM sofascore_player_match_stats
        WHERE game_id = ? AND is_home = ? AND is_starter = 1
    """, (game_id, is_home)).fetchall()
    if len(rows) < 8:
        return {k: float("nan") for k in
                ["starter_avg_rating", "captain_rating", "top2_avg_rating", "starter_xg_per90_sum"]}
    ratings = [r[0] for r in rows if r[0] is not None]
    if len(ratings) < 8:
        return {k: float("nan") for k in
                ["starter_avg_rating", "captain_rating", "top2_avg_rating", "starter_xg_per90_sum"]}
    captain = next((r[0] for r in rows if r[1] == 1 and r[0] is not None), float("nan"))
    top2 = sorted(ratings, reverse=True)[:2]
    xg_per90 = []
    for r in rows:
        if r[2] is not None and r[3] is not None and r[3] > 0:
            xg_per90.append((r[2] / r[3]) * 90.0)
    return {
        "starter_avg_rating": float(np.mean(ratings)),
        "captain_rating": float(captain) if not np.isnan(captain) else float("nan"),
        "top2_avg_rating": float(np.mean(top2)),
        "starter_xg_per90_sum": float(sum(xg_per90)) if xg_per90 else float("nan"),
    }


def find_game_id(conn, league: str, match_date: str,
                 home_team: str, away_team: str) -> Optional[int]:
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
    preds = pd.read_parquet(INPUT_PARQUET)
    preds["match_date_str"] = pd.to_datetime(preds["match_date"]).dt.strftime("%Y-%m-%d")
    print(f"[load] {len(preds):,} OOT predictions")

    conn = sqlite3.connect(f"file:{LOCAL_DB}?mode=ro", uri=True)

    print("[resolve+compute] features for matched games...")
    rows = []
    for _, row in preds.iterrows():
        gid = find_game_id(conn, row["league"], row["match_date_str"],
                          row["home_team"], row["away_team"])
        if gid is None:
            continue
        h = starter_features_per_team(conn, gid, 1)
        a = starter_features_per_team(conn, gid, 0)
        rows.append({
            "league": row["league"],
            "ft_result": row["ft_result"],
            "prob_h_raw": row["prob_h_raw"],
            "prob_d_raw": row["prob_d_raw"],
            "prob_a_raw": row["prob_a_raw"],
            "starter_avg_rating_diff": h["starter_avg_rating"] - a["starter_avg_rating"],
            "captain_rating_diff": h["captain_rating"] - a["captain_rating"],
            "top2_avg_rating_diff": h["top2_avg_rating"] - a["top2_avg_rating"],
            "starter_xg_per90_sum_diff": h["starter_xg_per90_sum"] - a["starter_xg_per90_sum"],
        })
    df = pd.DataFrame(rows)
    n_full = df.dropna().shape[0]
    print(f"[compute] {n_full:,} rows with full feature coverage")

    feature_names = ["starter_avg_rating_diff", "captain_rating_diff",
                     "top2_avg_rating_diff", "starter_xg_per90_sum_diff"]
    outcomes = ["H", "D", "A"]
    n_tests = len(feature_names) * len(outcomes) * (1 + len(VALIDATED_LEAGUES))
    bonferroni_p = BONFERRONI_ALPHA / n_tests
    print(f"\n[test] {n_tests} tests, Bonferroni alpha={bonferroni_p:.5f}")
    print(f"[methodology] CORRECTED: Pearson(feature, SIGNED RESIDUAL = realized - predicted)")
    print()

    results = []

    def test_one(sub_df, feature, outcome, label):
        clean = sub_df[[feature, "ft_result", "prob_h_raw", "prob_d_raw", "prob_a_raw"]].dropna()
        if len(clean) < 30:
            return {"scope": label, "feature": feature, "outcome": outcome,
                    "n": int(len(clean)), "pearson_r": None, "p_value": None,
                    "passes_gate": False}
        p_col = {"H": "prob_h_raw", "D": "prob_d_raw", "A": "prob_a_raw"}[outcome]
        realized = (clean["ft_result"] == outcome).astype(int).values
        predicted = clean[p_col].values
        # CORRECTED: signed residual, not squared error
        residual = realized - predicted
        r, p = stats.pearsonr(clean[feature].values, residual)
        return {"scope": label, "feature": feature, "outcome": outcome,
                "n": int(len(clean)), "pearson_r": float(r), "p_value": float(p),
                "passes_gate": abs(r) > SIG_THRESHOLD and p < bonferroni_p}

    for feat in feature_names:
        for o in outcomes:
            results.append(test_one(df, feat, o, "all"))
    for lg in VALIDATED_LEAGUES:
        sub = df[df["league"] == lg]
        for feat in feature_names:
            for o in outcomes:
                results.append(test_one(sub, feat, o, lg))

    passing = [r for r in results if r["passes_gate"]]

    print(f"{'scope':<16}{'feature':<28}{'outcome':<8}{'n':>6}{'r':>10}{'p':>11}{'pass':>6}")
    print('-' * 80)
    for r in results:
        if r["pearson_r"] is None:
            continue
        mark = "✓" if r["passes_gate"] else ""
        print(f"{r['scope']:<16}{r['feature']:<28}{r['outcome']:<8}{r['n']:>6}"
              f"{r['pearson_r']:>+10.4f}{r['p_value']:>11.5f}{mark:>6}")
    print('=' * 80)
    print(f"\n[summary v2] {len(passing)} of {len(results)} pass empirical gate")

    if passing:
        best = max(passing, key=lambda r: abs(r["pearson_r"]))
        rec = {"ship_starter_features": True,
               "passing_tests": passing,
               "rationale": (f"{len(passing)} tests pass after Bonferroni correction. "
                            f"Strongest: {best['feature']} on {best['scope']}/"
                            f"{best['outcome']}: r={best['pearson_r']:.4f}, "
                            f"p={best['p_value']:.5f}, n={best['n']}."),
               "next_step": "Refit dev-04 with these features as additive."}
    else:
        max_r = max((r for r in results if r["pearson_r"] is not None),
                    key=lambda r: abs(r["pearson_r"]), default=None)
        rec = {"ship_starter_features": False,
               "rationale": (
                   f"NO test clears Bonferroni alpha={bonferroni_p:.5f}. "
                   f"Strongest: |r|={abs(max_r['pearson_r']):.4f} on "
                   f"{max_r['scope']}/{max_r['feature']}/{max_r['outcome']} "
                   f"(p={max_r['p_value']:.4f}). "
                   "Conclusion: lineup_quality_diff (existing proxy) already "
                   "captures the variance these features would add."
                   if max_r else "No tests with adequate sample."),
               "next_step": "Skip starter-feature retrain. Move to other hypotheses."}

    output = {
        "version": "2.0",
        "methodology_note": (
            "v2 uses SIGNED residual = realized - predicted. v1 used SQUARED "
            "error which conflated feature-outcome correlation with feature-adds-signal."
        ),
        "input_n": int(len(preds)),
        "n_with_features": int(n_full),
        "n_tests": int(n_tests),
        "bonferroni_alpha": float(bonferroni_p),
        "pearson_threshold": float(SIG_THRESHOLD),
        "results": results,
        "recommendation": rec,
    }
    OUTPUT_JSON.write_text(json.dumps(output, indent=2, default=str))
    print(f"\n[write] {OUTPUT_JSON}")
    print(f"[recommendation] ship_starter_features = {rec['ship_starter_features']}")
    print(f"[rationale] {rec['rationale']}")


if __name__ == "__main__":
    main()
