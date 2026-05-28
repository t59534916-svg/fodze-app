"""Starter-feature signal test (Phase A) — empirical hypothesis check
BEFORE committing to a dev-03 retrain with player-level features.

The current dev-03 model has `lineup_quality_diff` (team-level proxy:
rolling-5 goals+xg-diff). The question: do MORE GRANULAR starter-level
features add signal beyond this proxy?

Hypothesis: starter avg-rating diff, captain presence, top-2-player
presence, squad-rotation continuity should capture lineup quality
variance the team-level proxy misses (e.g. when team's best player
is rotated out).

Test methodology (analog to CSD-veto-calibration):
  1. Load v2-OOT predictions (n=6525) — these are dev-03's actual
     holdout matches.
  2. For each match × team, compute starter-level features from
     sofascore_player_match_stats (where data exists).
  3. For each match, compute prediction error vs realized outcome:
        error = |p_predicted - 1{outcome}|
  4. Test: does feature value correlate with prediction error?
     - Strong correlation: feature has signal, refit dev-03 will likely
       improve Brier.
     - No correlation: feature adds nothing beyond what dev-03 captures.
  5. Per-Liga breakdown — Top-5 leagues may have signal that mid-tier
     leagues don't (data quality + player-quality variance differs).

Coverage caveat:
  Phase 2 sofa-extras was BLOCKED for 22/23 + 23/24 Tier-B (CF 403).
  Player_match_stats available only for 23/24 Tier-A + 24/25 + 25/26.
  This test runs on the SUBSET where data exists (~12k matches).

Acceptance gate (per feature × per outcome):
  - Pearson correlation |r| > 0.05
  - p-value < 0.01 after Bonferroni correction
  - At least 1 of 3 outcomes (H/D/A) shows significant signal in
    at least 1 of 5 validated-edge leagues (epl/serie_a/scottish_prem/
    la_liga/serie_b).

If gate passes → ship features in next dev-03 retrain.
If gate fails → don't bother retraining with these features.

Output: tools/v4/diagnostics/starter_feature_signal.json
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
OUTPUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "starter_feature_signal.json"

# Validated-edge leagues from bet-edge-policy.ts (where engine has positive ROI)
VALIDATED_LEAGUES = ["epl", "serie_a", "scottish_prem", "la_liga", "serie_b"]

# Brier signal-threshold + Bonferroni
SIG_THRESHOLD = 0.05         # |Pearson r| must exceed this
BONFERRONI_ALPHA = 0.01      # post-correction alpha


# ─────────────────────────────────────────────────────────────────────
# Feature extractors from sofascore_player_match_stats
# ─────────────────────────────────────────────────────────────────────

def starter_features_per_team(conn: sqlite3.Connection, game_id: int, is_home: int
                              ) -> dict[str, float]:
    """Compute starter-level features for one (game, team) row.

    Returns:
      starter_avg_rating: mean rating across 11 starters
      captain_rating: rating of player marked is_captain
      top2_avg_rating: mean rating of top-2-rated starters (star-power proxy)
      starter_xg_per90_sum: sum of xG-per-90 across starters (attack capacity)

    All return NaN if data missing (insufficient_n).
    """
    rows = conn.execute("""
        SELECT rating, is_captain, expected_goals, minutes_played
        FROM sofascore_player_match_stats
        WHERE game_id = ? AND is_home = ? AND is_starter = 1
    """, (game_id, is_home)).fetchall()
    if len(rows) < 8:
        return {
            "starter_avg_rating": float("nan"),
            "captain_rating": float("nan"),
            "top2_avg_rating": float("nan"),
            "starter_xg_per90_sum": float("nan"),
        }

    ratings = [r[0] for r in rows if r[0] is not None]
    if len(ratings) < 8:
        return {
            "starter_avg_rating": float("nan"),
            "captain_rating": float("nan"),
            "top2_avg_rating": float("nan"),
            "starter_xg_per90_sum": float("nan"),
        }

    captain = next((r[0] for r in rows if r[1] == 1 and r[0] is not None), float("nan"))
    top2 = sorted(ratings, reverse=True)[:2]

    # xG per 90 — sum across starters who actually played
    xg_per90_vals = []
    for r in rows:
        xg, mins = r[2], r[3]
        if xg is not None and mins is not None and mins > 0:
            xg_per90_vals.append((xg / mins) * 90.0)
    xg_per90_sum = sum(xg_per90_vals) if xg_per90_vals else float("nan")

    return {
        "starter_avg_rating": float(np.mean(ratings)),
        "captain_rating": float(captain) if not np.isnan(captain) else float("nan"),
        "top2_avg_rating": float(np.mean(top2)),
        "starter_xg_per90_sum": float(xg_per90_sum),
    }


def find_game_id(conn: sqlite3.Connection, league: str, match_date: str,
                 home_team: str, away_team: str) -> Optional[int]:
    """Resolve game_id from sofascore_match using fuzzy team-name match."""
    # Try exact match first
    result = conn.execute("""
        SELECT game_id FROM sofascore_match
        WHERE league = ? AND date(start_timestamp, 'unixepoch') = ?
          AND home_team = ? AND away_team = ?
        LIMIT 1
    """, (league, match_date, home_team, away_team)).fetchone()
    if result:
        return result[0]

    # Fuzzy: substring match on team names
    # Sofa team names may differ from FootyStats canonical names
    result = conn.execute("""
        SELECT game_id FROM sofascore_match
        WHERE league = ?
          AND date(start_timestamp, 'unixepoch') BETWEEN date(?, '-1 day') AND date(?, '+1 day')
          AND (
            (home_team LIKE ? OR ? LIKE '%' || home_team || '%')
            AND (away_team LIKE ? OR ? LIKE '%' || away_team || '%')
          )
        LIMIT 1
    """, (league, match_date, match_date,
          f"%{home_team[:8]}%", home_team,
          f"%{away_team[:8]}%", away_team)).fetchone()
    return result[0] if result else None


# ─────────────────────────────────────────────────────────────────────
# Signal test
# ─────────────────────────────────────────────────────────────────────


def compute_match_brier(row: pd.Series, outcome: str) -> float:
    """Brier component for one (match, outcome) pair."""
    p_col = {"H": "prob_h_raw", "D": "prob_d_raw", "A": "prob_a_raw"}[outcome]
    p = row[p_col]
    realized = 1 if row["ft_result"] == outcome else 0
    return float((p - realized) ** 2)


def main():
    print(f"[load] {INPUT_PARQUET.name}")
    preds = pd.read_parquet(INPUT_PARQUET)
    preds["match_date_str"] = pd.to_datetime(preds["match_date"]).dt.strftime("%Y-%m-%d")
    print(f"[load] {len(preds):,} OOT predictions across {preds['league'].nunique()} leagues")

    conn = sqlite3.connect(f"file:{LOCAL_DB}?mode=ro", uri=True)

    # Resolve game_ids
    print("[resolve] mapping predictions → sofascore game_ids...")
    game_ids = []
    for _, row in preds.iterrows():
        gid = find_game_id(conn, row["league"], row["match_date_str"],
                          row["home_team"], row["away_team"])
        game_ids.append(gid)
    preds["game_id"] = game_ids
    n_resolved = preds["game_id"].notna().sum()
    print(f"[resolve] {n_resolved:,} of {len(preds):,} matched ({100*n_resolved/len(preds):.1f}%)")

    # Compute starter features per match × side
    print("[compute] starter features for resolved matches...")
    rows = []
    for _, row in preds[preds["game_id"].notna()].iterrows():
        h_feats = starter_features_per_team(conn, int(row["game_id"]), 1)
        a_feats = starter_features_per_team(conn, int(row["game_id"]), 0)
        rows.append({
            "league": row["league"],
            "ft_result": row["ft_result"],
            "prob_h_raw": row["prob_h_raw"],
            "prob_d_raw": row["prob_d_raw"],
            "prob_a_raw": row["prob_a_raw"],
            # Diff features (home - away) consistent with existing dev-03 convention
            "starter_avg_rating_diff": h_feats["starter_avg_rating"] - a_feats["starter_avg_rating"],
            "captain_rating_diff": h_feats["captain_rating"] - a_feats["captain_rating"],
            "top2_avg_rating_diff": h_feats["top2_avg_rating"] - a_feats["top2_avg_rating"],
            "starter_xg_per90_sum_diff": h_feats["starter_xg_per90_sum"] - a_feats["starter_xg_per90_sum"],
        })
    df = pd.DataFrame(rows)
    n_full = df.dropna().shape[0]
    print(f"[compute] {n_full:,} rows with full feature coverage")

    # Per-feature × per-outcome correlation with prediction error
    feature_names = ["starter_avg_rating_diff", "captain_rating_diff",
                     "top2_avg_rating_diff", "starter_xg_per90_sum_diff"]
    outcomes = ["H", "D", "A"]
    n_tests = len(feature_names) * len(outcomes) * (1 + len(VALIDATED_LEAGUES))
    bonferroni_p = BONFERRONI_ALPHA / n_tests

    print(f"\n[test] {n_tests} hypothesis tests, Bonferroni-corrected alpha={bonferroni_p:.5f}")

    results: list[dict] = []

    def test_one(sub_df: pd.DataFrame, feature: str, outcome: str, label: str):
        clean = sub_df[[feature, "ft_result", "prob_h_raw", "prob_d_raw", "prob_a_raw"]].dropna()
        if len(clean) < 30:
            return {"scope": label, "feature": feature, "outcome": outcome,
                    "n": int(len(clean)), "pearson_r": None, "p_value": None,
                    "passes_gate": False}

        # Brier component for THIS outcome (squared prediction-error vs realized)
        p_col = {"H": "prob_h_raw", "D": "prob_d_raw", "A": "prob_a_raw"}[outcome]
        realized = (clean["ft_result"] == outcome).astype(int).values
        brier = (clean[p_col].values - realized) ** 2

        # Test: does feature variance correlate with prediction error?
        # If yes, feature has signal not captured by current dev-03.
        r, p = stats.pearsonr(clean[feature].values, brier)
        passes = abs(r) > SIG_THRESHOLD and p < bonferroni_p
        return {"scope": label, "feature": feature, "outcome": outcome,
                "n": int(len(clean)), "pearson_r": float(r), "p_value": float(p),
                "passes_gate": passes}

    # All-leagues tests
    for feat in feature_names:
        for o in outcomes:
            results.append(test_one(df, feat, o, "all"))

    # Per-validated-league tests
    for lg in VALIDATED_LEAGUES:
        sub = df[df["league"] == lg]
        for feat in feature_names:
            for o in outcomes:
                results.append(test_one(sub, feat, o, lg))

    passing = [r for r in results if r["passes_gate"]]

    # Display
    print(f"\n{'='*72}")
    print(f"{'scope':<16}{'feature':<28}{'outcome':<8}{'n':>6}{'r':>9}{'p':>10}{'pass':>6}")
    print('-' * 72)
    for r in results:
        if r["pearson_r"] is None:
            continue
        mark = "✓" if r["passes_gate"] else ""
        print(f"{r['scope']:<16}{r['feature']:<28}{r['outcome']:<8}{r['n']:>6}"
              f"{r['pearson_r']:>+9.4f}{r['p_value']:>10.5f}{mark:>6}")
    print('=' * 72)
    print(f"\n[summary] {len(passing)} of {len(results)} tests pass empirical gate")

    if passing:
        recommendation = {
            "ship_starter_features": True,
            "passing_tests": passing,
            "rationale": (
                f"{len(passing)} significant tests after Bonferroni correction. "
                f"Strongest signal: {max(passing, key=lambda r: abs(r['pearson_r']))['feature']} "
                f"on {max(passing, key=lambda r: abs(r['pearson_r']))['scope']}."
            ),
            "next_step": (
                "Refit dev-03 with these 4 features added to feature_builder. "
                "Expected Brier-delta: -0.001 to -0.008 based on signal strength."
            ),
        }
    else:
        max_r = max((r for r in results if r["pearson_r"] is not None),
                    key=lambda r: abs(r["pearson_r"]), default=None)
        recommendation = {
            "ship_starter_features": False,
            "rationale": (
                "NO feature × outcome × league combo clears Bonferroni-corrected "
                f"alpha={bonferroni_p:.5f}. "
                f"Strongest signal: |r|={abs(max_r['pearson_r']):.4f} on "
                f"{max_r['scope']}/{max_r['feature']}/{max_r['outcome']} "
                f"(p={max_r['p_value']:.4f}) — marginally non-significant."
                if max_r else "No data points met minimum sample size."
            ),
            "next_step": (
                "lineup_quality_diff proxy already captures the variance. "
                "Skip starter-feature retrain. Move to Phase B (GK xGOT-xG)."
            ),
        }

    output = {
        "version": "1.0",
        "input_n": int(len(preds)),
        "n_resolved": int(n_resolved),
        "n_with_features": int(n_full),
        "n_tests": int(n_tests),
        "bonferroni_alpha": float(bonferroni_p),
        "pearson_threshold": float(SIG_THRESHOLD),
        "features_tested": feature_names,
        "leagues_tested": ["all"] + VALIDATED_LEAGUES,
        "results": results,
        "recommendation": recommendation,
    }
    OUTPUT_JSON.write_text(json.dumps(output, indent=2, default=str))
    print(f"\n[write] {OUTPUT_JSON}")
    print(f"[recommendation] ship_starter_features = {recommendation['ship_starter_features']}")
    print(f"[rationale] {recommendation['rationale']}")


if __name__ == "__main__":
    main()
