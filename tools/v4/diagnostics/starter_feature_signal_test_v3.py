"""Starter-feature signal test v3 — CORRECTED for both methodology + leakage.

Critical fixes from v1 → v2 → v3:

v1: tested Pearson(feature, SQUARED_error) — conflates correlation-with-outcome
    with feature-adds-signal. Wrong test direction.

v2: switched to Pearson(feature, SIGNED_residual). Methodologically clean,
    BUT used same-match player ratings = post-hoc leakage. Sofascore's
    `rating` is a player-of-the-match score computed AFTER the match,
    not a pre-match quality signal. r=0.74 on residual_H was spurious.

v3: uses ROLLING PRIOR-MATCH ratings per starter (chronologically before
    focal match). For each starter in match M_t at time t, looks up their
    rating in last 5 matches M_{t-1}, M_{t-2}, ... and averages. THIS is
    a legitimate pre-match feature.

Math (per starter S, focal match M_t):
  prior_ratings(S, t) = [rating(S, m) for m in matches(S) where m.ts < t]
  rolling_5(S, t) = mean(prior_ratings(S, t)[-5:])   # NaN if <3 prior matches

  starter_avg_rolling_rating(team, t) = mean(rolling_5(S, t) for S in starters(team, M_t))

  feature_diff = home_avg_rolling - away_avg_rolling

Test: Pearson(feature_diff, residual_o) where residual_o = realized_o - p_o_raw.
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
OUTPUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "starter_feature_signal_v3.json"

VALIDATED_LEAGUES = ["epl", "serie_a", "scottish_prem", "la_liga", "serie_b"]
ROLLING_WINDOW = 5           # last-N prior matches per player
MIN_PRIOR_MATCHES = 3        # require at least N prior matches for feature
SIG_THRESHOLD = 0.05
BONFERRONI_ALPHA = 0.01


def build_player_rating_index(conn) -> dict:
    """Pre-build (player_id) → sorted [(match_ts, rating)] index.
    Critical for fast rolling lookups."""
    print("[index] building player rating history...")
    result = conn.execute("""
        SELECT pms.player_id, sm.start_timestamp, pms.rating
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        WHERE pms.rating IS NOT NULL AND pms.is_starter = 1
          AND pms.minutes_played >= 60
        ORDER BY pms.player_id, sm.start_timestamp
    """).fetchall()
    index: dict = {}
    for player_id, ts, rating in result:
        if player_id not in index:
            index[player_id] = []
        index[player_id].append((int(ts), float(rating)))
    print(f"[index] {len(index):,} players × {sum(len(v) for v in index.values()):,} ratings")
    return index


def rolling_prior_rating(player_index: dict, player_id: int, focal_ts: int) -> float:
    """Return rolling-N mean of player's last-N matches BEFORE focal_ts.
    NaN if <MIN_PRIOR_MATCHES history."""
    hist = player_index.get(player_id, [])
    past = [r for ts, r in hist if ts < focal_ts]
    if len(past) < MIN_PRIOR_MATCHES:
        return float("nan")
    return float(np.mean(past[-ROLLING_WINDOW:]))


def starters_for_match(conn, game_id: int, is_home: int) -> list[tuple[int, int]]:
    """Return [(player_id, is_captain), ...] for the 11 starters of one side."""
    return conn.execute("""
        SELECT player_id, COALESCE(is_captain, 0)
        FROM sofascore_player_match_stats
        WHERE game_id = ? AND is_home = ? AND is_starter = 1
    """, (game_id, is_home)).fetchall()


def team_features(player_index: dict, starters: list, focal_ts: int) -> dict:
    """Compute team-level features from 11 starters' PRIOR rolling ratings."""
    priors = [rolling_prior_rating(player_index, pid, focal_ts) for pid, _ in starters]
    captain_priors = [rolling_prior_rating(player_index, pid, focal_ts)
                      for pid, is_cap in starters if is_cap == 1]
    valid = [p for p in priors if not np.isnan(p)]
    if len(valid) < 8:  # require ≥8 of 11 starters to have prior ratings
        return {k: float("nan") for k in
                ["avg_prior_rating", "captain_prior_rating", "top2_prior_rating"]}
    top2 = sorted(valid, reverse=True)[:2]
    return {
        "avg_prior_rating": float(np.mean(valid)),
        "captain_prior_rating": float(captain_priors[0]) if captain_priors
                                and not np.isnan(captain_priors[0]) else float("nan"),
        "top2_prior_rating": float(np.mean(top2)),
    }


def find_game_id(conn, league: str, match_date: str, home_team: str, away_team: str
                ) -> Optional[tuple[int, int]]:
    """Return (game_id, start_timestamp) or None."""
    result = conn.execute("""
        SELECT game_id, start_timestamp FROM sofascore_match
        WHERE league = ? AND date(start_timestamp, 'unixepoch') = ?
          AND home_team = ? AND away_team = ?
        LIMIT 1
    """, (league, match_date, home_team, away_team)).fetchone()
    if result:
        return (int(result[0]), int(result[1]))
    result = conn.execute("""
        SELECT game_id, start_timestamp FROM sofascore_match
        WHERE league = ?
          AND date(start_timestamp, 'unixepoch') BETWEEN date(?, '-1 day') AND date(?, '+1 day')
          AND home_team LIKE ? AND away_team LIKE ?
        LIMIT 1
    """, (league, match_date, match_date, f"%{home_team[:8]}%", f"%{away_team[:8]}%")).fetchone()
    return (int(result[0]), int(result[1])) if result else None


def main():
    preds = pd.read_parquet(INPUT_PARQUET)
    preds["match_date_str"] = pd.to_datetime(preds["match_date"]).dt.strftime("%Y-%m-%d")
    print(f"[load] {len(preds):,} OOT predictions")

    conn = sqlite3.connect(f"file:{LOCAL_DB}?mode=ro", uri=True)
    player_index = build_player_rating_index(conn)

    print("[compute] PRE-MATCH rolling features per match...")
    rows = []
    for _, row in preds.iterrows():
        g = find_game_id(conn, row["league"], row["match_date_str"],
                        row["home_team"], row["away_team"])
        if g is None:
            continue
        gid, focal_ts = g
        h_starters = starters_for_match(conn, gid, 1)
        a_starters = starters_for_match(conn, gid, 0)
        if len(h_starters) < 11 or len(a_starters) < 11:
            continue
        h_feats = team_features(player_index, h_starters, focal_ts)
        a_feats = team_features(player_index, a_starters, focal_ts)
        rows.append({
            "league": row["league"],
            "ft_result": row["ft_result"],
            "prob_h_raw": row["prob_h_raw"],
            "prob_d_raw": row["prob_d_raw"],
            "prob_a_raw": row["prob_a_raw"],
            "avg_prior_rating_diff": h_feats["avg_prior_rating"] - a_feats["avg_prior_rating"],
            "captain_prior_rating_diff": h_feats["captain_prior_rating"] - a_feats["captain_prior_rating"],
            "top2_prior_rating_diff": h_feats["top2_prior_rating"] - a_feats["top2_prior_rating"],
        })
    df = pd.DataFrame(rows)
    n_full = df.dropna().shape[0]
    print(f"[compute] {n_full:,} rows with full PRE-MATCH feature coverage")
    print(f"  (vs {len(rows):,} with at least partial — diff = sample-too-thin players)")

    feature_names = ["avg_prior_rating_diff", "captain_prior_rating_diff", "top2_prior_rating_diff"]
    outcomes = ["H", "D", "A"]
    n_tests = len(feature_names) * len(outcomes) * (1 + len(VALIDATED_LEAGUES))
    bonferroni_p = BONFERRONI_ALPHA / n_tests
    print(f"\n[test] {n_tests} tests, Bonferroni alpha={bonferroni_p:.5f}")
    print(f"[methodology] CORRECT v3: rolling-{ROLLING_WINDOW} PRIOR-match ratings, "
          f"residual = realized - predicted (signed, no leakage)")

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

    print(f"\n{'='*80}")
    print(f"{'scope':<16}{'feature':<28}{'outcome':<8}{'n':>6}{'r':>10}{'p':>11}{'pass':>6}")
    print('-' * 80)
    for r in results:
        if r["pearson_r"] is None:
            continue
        mark = "✓" if r["passes_gate"] else ""
        print(f"{r['scope']:<16}{r['feature']:<28}{r['outcome']:<8}{r['n']:>6}"
              f"{r['pearson_r']:>+10.4f}{r['p_value']:>11.5f}{mark:>6}")
    print('=' * 80)
    print(f"\n[summary v3] {len(passing)} of {len(results)} pass empirical gate (leakage-free)")

    if passing:
        best = max(passing, key=lambda r: abs(r["pearson_r"]))
        rec = {"ship_starter_features": True,
               "passing_tests": passing,
               "rationale": (f"{len(passing)} tests pass after Bonferroni correction. "
                            f"Strongest: {best['feature']} on {best['scope']}/{best['outcome']}: "
                            f"r={best['pearson_r']:.4f}, p={best['p_value']:.5f}, n={best['n']}."),
               "next_step": "Refit dev-04 with these features."}
    else:
        max_r = max((r for r in results if r["pearson_r"] is not None),
                    key=lambda r: abs(r["pearson_r"]), default=None)
        rec = {"ship_starter_features": False,
               "rationale": (
                   f"NO test clears Bonferroni alpha={bonferroni_p:.5f} after leakage-correction. "
                   f"Strongest: |r|={abs(max_r['pearson_r']):.4f} on "
                   f"{max_r['scope']}/{max_r['feature']}/{max_r['outcome']} "
                   f"(p={max_r['p_value']:.4f}). "
                   "Prior v1/v2 results were inflated by post-hoc leakage. "
                   "Rolling pre-match starter rating does NOT add significant "
                   "signal beyond lineup_quality_diff (existing proxy)."
                   if max_r else "Insufficient sample."),
               "next_step": "Don't refit. Consider other features or accept E retrain on existing schema."}

    output = {
        "version": "3.0",
        "methodology_note": (
            "v3 uses ROLLING PRIOR-match ratings (chronologically before focal match) "
            "+ SIGNED residual. v1 had wrong correlation target. v2 used same-match "
            "ratings = post-hoc leakage. v3 is leakage-free + methodologically clean."
        ),
        "rolling_window": ROLLING_WINDOW,
        "min_prior_matches": MIN_PRIOR_MATCHES,
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
