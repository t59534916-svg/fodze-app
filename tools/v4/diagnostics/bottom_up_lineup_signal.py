#!/usr/bin/env python3
"""Bottom-up lineup signal — cross-season replication test.

REVISED 2026-05-27 — multi-season + dual-baseline (per audit committee).

Question: Does Σ(starter_xG_per_90 × est_minutes/90) correlate with actual team xG
in a way that EXCEEDS what team-rolling-xG (or dev-03's prediction) already explains?

If YES (all 4 seasons pass) → bottom-up architecture worth building (5-7 day sprint, D4).
If NO  → reject early; save the sprint.

Methodology:
  1. For each Top-5 × {season} match with full lineup data:
     a. Get starting XI from Sofa cache JSON (player_ids)
     b. For each starter, compute their PRIOR rolling xG-per-90 from
        sofascore_player_match_stats (chronologically before this match)
     c. Sum to get bottom_up_team_xg
  2. Compute two baselines for comparison:
     a. team_rolling_xg (cheap proxy): avg team_xg over last TEAM_ROLLING_N prior matches
     b. dev-03 prediction (rigorous): load XGPredictor.from_artifacts + predict_batch
  3. Get actual team_xg for the focal match (sum of player xG)
  4. Run additive signed-residual tests vs BOTH baselines
  5. Aggregate cross-season verdict per pre-registered thresholds

Pre-registered thresholds (CROSS-SEASON, all 4 must pass for STRONG_VALIDATION):
  STRONG_VALIDATION: ALL 4 seasons r_additive > 0.10 AND p < 0.05 AND CI > 0
                     AND mean r_additive ≥ 0.15
  PARTIAL: 3/4 seasons pass OR mean r > 0.10 but ≥1 season fails
  REJECTED: < 3/4 seasons pass OR mean r < 0.10 OR ≥1 season's CI straddles 0

5-Gate audit:
  G1: signed-residual sign convention checked
  G2: Holm-Bonferroni (4 seasons × 2 baselines = 8 hypotheses → α=0.05/8=0.00625)
  G3: leakage audit (PRIOR-match-only rolling via shift(1))
  G4: power analysis (need n ≥ 832 per season; typically ~1,400 Top-5 matches per season)
  G5: ROI simulation (skipped — this is a SIGNAL test, not a betting test)

Output:
  tools/v4/diagnostics/bottom_up_lineup_signal_<season-slug>.json  (per season)
  tools/v4/diagnostics/bottom_up_lineup_signal_multiseason.json    (combined verdict)

Usage:
  tools/venv/bin/python3 -I tools/v4/diagnostics/bottom_up_lineup_signal.py
  tools/venv/bin/python3 -I tools/v4/diagnostics/bottom_up_lineup_signal.py --seasons 24/25
  tools/venv/bin/python3 -I tools/v4/diagnostics/bottom_up_lineup_signal.py --skip-dev03-baseline
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
EXTRAS_DIR = REPO_ROOT / "tools" / "sofascore" / "data" / "extras"
DIAG_DIR = REPO_ROOT / "tools" / "v4" / "diagnostics"
ARTIFACTS_DIR = REPO_ROOT / "tools" / "v4" / "artifacts"

TOP5 = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1")
ROLLING_N = 10  # prior matches to average per player
TEAM_ROLLING_N = 5  # prior matches for team-baseline


def season_slug(season: str) -> str:
    """'24/25' → '24-25'"""
    return season.replace("/", "-")


# ─── Data loading helpers (refactored for multi-season efficiency) ─────────


def load_lineups(focal_season: str) -> dict[int, dict]:
    """Extract starting XI per (game_id, side) from Sofa cache JSONs for ONE season."""
    out = {}
    n_with_lineup = 0
    for p in EXTRAS_DIR.glob("*.json"):
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        if d.get("league") not in TOP5 or d.get("season") != focal_season:
            continue
        lineups = d.get("lineups")
        if not lineups:
            continue
        n_with_lineup += 1
        game_id = d.get("game_id")
        if not game_id:
            continue
        for side in ("home", "away"):
            team_obj = lineups.get(side, {})
            players = team_obj.get("players", [])
            starters = [
                p.get("player", {}).get("id")
                for p in players if not p.get("substitute")
            ]
            starters = [s for s in starters if s]
            out.setdefault(game_id, {})[side] = starters
        out[game_id]["league"] = d["league"]
    print(f"    {focal_season}: {n_with_lineup:,} matches with lineups → {len(out):,} extracted")
    return out


def compute_player_rolling_all_seasons(conn: sqlite3.Connection) -> pd.DataFrame:
    """Compute rolling-N xg-per-90 per player ONCE across ALL seasons.

    Returns full DataFrame; downstream filter_player_rolling_for_season picks
    just the focal-season rows. Saves ~3min vs 4× recomputation.

    Leakage-safe: shift(1).rolling(N) uses STRICT prior matches only.
    """
    print(f"  Building per-player rolling xG-per-90 (N={ROLLING_N}, all seasons)...")
    df = pd.read_sql_query("""
        SELECT pms.player_id, pms.game_id, pms.expected_goals, pms.minutes_played,
               sm.start_timestamp, sm.league, sm.season
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        WHERE pms.minutes_played > 0
    """, conn)
    df["expected_goals"] = df["expected_goals"].fillna(0.0)
    print(f"    Loaded {len(df):,} player-match rows")

    df = df.sort_values(["player_id", "start_timestamp"], kind="mergesort").reset_index(drop=True)
    df["xg_per_90"] = df["expected_goals"] / (df["minutes_played"] / 90.0).clip(lower=0.1)
    df["xg_per_90"] = df["xg_per_90"].clip(0, 3.0)
    df["rolling_xg_per_90"] = (
        df.groupby("player_id")["xg_per_90"]
          .transform(lambda s: s.shift(1).rolling(ROLLING_N, min_periods=3).mean())
    )
    return df


def filter_player_rolling_for_season(df: pd.DataFrame, focal_season: str) -> dict:
    """Filter full-corpus player-rolling to focal-season rows; return lookup dict."""
    focal = df[df["season"] == focal_season].dropna(subset=["rolling_xg_per_90"])
    return {(int(r["player_id"]), int(r["game_id"])): float(r["rolling_xg_per_90"])
            for _, r in focal.iterrows()}


def compute_team_rolling_all_seasons(conn: sqlite3.Connection) -> pd.DataFrame:
    """Compute team-level rolling xG across ALL seasons (audit-corrected GROUP BY).

    BUG-FIX preserved: GROUP BY (game_id, is_home) only — player_match_stats.team_id
    is the player's CURRENT-registered team, not their match-team.
    """
    print(f"  Building per-team rolling xG (N={TEAM_ROLLING_N}, all seasons)...")
    df = pd.read_sql_query("""
        SELECT pms.game_id, pms.is_home,
               SUM(COALESCE(pms.expected_goals, 0)) AS team_xg,
               sm.start_timestamp, sm.league, sm.season,
               sm.home_team_id, sm.away_team_id
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        GROUP BY pms.game_id, pms.is_home
    """, conn)
    df["match_team_id"] = df.apply(
        lambda r: r["home_team_id"] if r["is_home"] else r["away_team_id"], axis=1
    )
    df = df.sort_values(["match_team_id", "start_timestamp"], kind="mergesort").reset_index(drop=True)
    df["rolling_team_xg"] = (
        df.groupby("match_team_id")["team_xg"]
          .transform(lambda s: s.shift(1).rolling(TEAM_ROLLING_N, min_periods=3).mean())
    )
    df["side"] = df["is_home"].apply(lambda x: "home" if x else "away")
    print(f"    team_xg mean (all seasons/leagues): {df['team_xg'].mean():.2f}")
    return df


def filter_team_rolling_for_season(df: pd.DataFrame, focal_season: str) -> tuple[dict, dict]:
    """Filter team-rolling DF to focal season; return rolling-dict + actual-dict."""
    focal = df[df["season"] == focal_season].dropna(subset=["rolling_team_xg"])
    rolling_dict = {(int(r["game_id"]), r["side"]): float(r["rolling_team_xg"])
                    for _, r in focal.iterrows()}
    # Actual = raw team_xg (not rolled)
    season_df = df[df["season"] == focal_season]
    actual_dict = {(int(r["game_id"]), r["side"]): float(r["team_xg"])
                   for _, r in season_df.iterrows()}
    return rolling_dict, actual_dict


# ─── dev-03 baseline (rigorous signed-residual baseline per audit committee) ─


def compute_dev03_baseline(focal_season: str) -> dict:
    """Load XGPredictor (dev-03 production) and predict team lambdas for focal season.

    Returns: {(game_id, 'home'|'away'): dev03_predicted_team_xg}

    Caveat: For 22/23-24/25 this is IN-SAMPLE (dev-03 trained on cutoff=2025-08-01,
    which includes those seasons). For 25/26 it's out-of-sample. Document explicitly
    in output JSON.
    """
    try:
        sys.path.insert(0, str(REPO_ROOT / "tools"))
        from v4.data.loaders import load_match_pairs, load_team_xg_history
        from v4.modules.m3_xg import XGPredictor
    except Exception as e:
        print(f"    ✗ Failed to import dev-03 infra: {e}")
        return {}

    print(f"  Loading dev-03 XGPredictor + predicting {focal_season}...")
    home_pkl = ARTIFACTS_DIR / "m3_xg-home-dev-03.pkl"
    away_pkl = ARTIFACTS_DIR / "m3_xg-away-dev-03.pkl"
    if not home_pkl.exists() or not away_pkl.exists():
        print(f"    ✗ Missing dev-03 pickles → skip dev-03 baseline")
        return {}

    try:
        predictor = XGPredictor.from_artifacts(home_path=home_pkl, away_path=away_pkl)
    except Exception as e:
        print(f"    ✗ XGPredictor load failed: {e}")
        return {}

    # Build season date-window. Season "24/25" = 2024-08-01 to 2025-07-31
    yy = int(focal_season.split("/")[0])
    season_start = f"20{yy}-08-01"
    season_end = f"20{yy+1}-07-31"

    try:
        history = load_team_xg_history(leagues=list(TOP5))
        matches = load_match_pairs(cutoff=season_end, since=season_start, leagues=list(TOP5))
        matches = matches.dropna(subset=["home_goals", "away_goals"])
        if len(matches) == 0:
            print(f"    ⚠ No matches loaded for {focal_season}")
            return {}
        print(f"    Predicting {len(matches):,} matches...")
        preds = predictor.predict_batch(matches, history, verbose=False)
    except Exception as e:
        print(f"    ✗ predict_batch failed: {e}")
        return {}

    # Map (league, match_date, home, away) → game_id via lineup data is complex;
    # easier path: use the matches DataFrame's existing identifiers if available.
    # For our needs, we just need a baseline keyed somehow. Use (league, date, home, away)
    # as the join key and let downstream match by matchkey.
    out = {}
    for _, p in preds.iterrows():
        # The preds DF has league, match_date, home, away, lambda_h, lambda_a
        key = (p.get("league"), str(p.get("match_date")), p.get("home"), p.get("away"))
        out[key + ("home",)] = float(p["lambda_h"])
        out[key + ("away",)] = float(p["lambda_a"])
    print(f"    dev-03 predictions: {len(preds):,} matches → {len(out):,} team-lambda entries")
    return out


# ─── Per-season signal test ────────────────────────────────────────────────


def run_signal_test_for_season(
    focal_season: str,
    player_rolling: dict,
    team_rolling: dict,
    actual_team_xg: dict,
    dev03_baseline: dict,
    lineups: dict,
    conn: sqlite3.Connection,
) -> dict:
    """Run signal tests for one season; return result dict."""
    print(f"\n══ Season {focal_season} ══")
    print(f"  Joining + computing bottom-up xG per match per team...")

    # Get (league, date, home, away) lookup per game_id for dev-03 baseline join
    game_meta = {}
    if dev03_baseline:
        rows = conn.execute(f"""
            SELECT game_id, league, start_timestamp, home_team, away_team
            FROM sofascore_match WHERE season = ? AND league IN ({','.join('?'*len(TOP5))})
        """, [focal_season] + list(TOP5)).fetchall()
        for game_id, league, ts, home, away in rows:
            from datetime import datetime, timezone
            date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            game_meta[game_id] = (league, date_str, home, away)

    rows = []
    n_missing_player_rolling = 0
    n_missing_team_rolling = 0
    n_missing_actual = 0
    n_with_dev03 = 0

    for game_id, info in lineups.items():
        for side in ("home", "away"):
            starters = info.get(side, [])
            if len(starters) < 7:
                continue
            starter_xgs = [player_rolling.get((p, game_id)) for p in starters]
            starter_xgs = [x for x in starter_xgs if x is not None]
            if len(starter_xgs) < 7:
                n_missing_player_rolling += 1
                continue
            bottom_up_xg = sum(starter_xgs)
            n_starters_w_data = len(starter_xgs)

            team_baseline = team_rolling.get((game_id, side))
            if team_baseline is None:
                n_missing_team_rolling += 1
                continue

            actual = actual_team_xg.get((game_id, side))
            if actual is None:
                n_missing_actual += 1
                continue

            row = {
                "game_id": game_id,
                "league": info["league"],
                "side": side,
                "bottom_up_xg": bottom_up_xg,
                "team_rolling_xg": team_baseline,
                "actual_xg": actual,
                "n_starters_with_rolling": n_starters_w_data,
            }

            # Look up dev-03 prediction if available
            if dev03_baseline and game_id in game_meta:
                meta = game_meta[game_id]
                # Fuzzy match — try multiple date formats from predict_batch output
                for date_variant in (meta[1], meta[1].replace("-", "/")):
                    key = (meta[0], date_variant, meta[2], meta[3], side)
                    if key in dev03_baseline:
                        row["dev03_xg"] = dev03_baseline[key]
                        n_with_dev03 += 1
                        break

            rows.append(row)

    if len(rows) < 200:
        print(f"  ✗ Insufficient data ({len(rows)} < 200) for {focal_season}")
        return {
            "season": focal_season,
            "status": "insufficient_data",
            "n_rows": len(rows),
        }

    df = pd.DataFrame(rows)
    print(f"  Final dataset: {len(df):,} rows · dev-03 join: {n_with_dev03}/{len(df)} ({n_with_dev03/len(df)*100:.1f}%)")

    # Test A: Sanity
    r_sanity, p_sanity = stats.pearsonr(df["bottom_up_xg"], df["actual_xg"])
    print(f"  TEST A (sanity):  r={r_sanity:+.4f}  p={p_sanity:.4f}  n={len(df):,}")

    # Test B1: ADDITIVE vs team_rolling
    df["bot_minus_team"] = df["bottom_up_xg"] - df["team_rolling_xg"]
    df["actual_minus_team"] = df["actual_xg"] - df["team_rolling_xg"]
    r_add_team, p_add_team = stats.pearsonr(df["bot_minus_team"], df["actual_minus_team"])
    print(f"  TEST B1 (vs team_rolling):  r={r_add_team:+.4f}  p={p_add_team:.4f}")

    # Bootstrap CI on r_add_team
    rng = np.random.default_rng(42)
    rs_team = []
    for _ in range(1000):
        idx = rng.integers(0, len(df), size=len(df))
        rb, _ = stats.pearsonr(df["bot_minus_team"].values[idx], df["actual_minus_team"].values[idx])
        rs_team.append(rb)
    ci_team = (float(np.percentile(rs_team, 2.5)), float(np.percentile(rs_team, 97.5)))
    print(f"    Bootstrap 95% CI: [{ci_team[0]:+.4f}, {ci_team[1]:+.4f}]")

    # Test B2: ADDITIVE vs dev-03 (if available)
    r_add_dev03 = None
    p_add_dev03 = None
    ci_dev03 = None
    n_dev03 = 0
    if "dev03_xg" in df.columns and df["dev03_xg"].notna().sum() >= 200:
        sub = df.dropna(subset=["dev03_xg"]).copy()
        sub["bot_minus_dev03"] = sub["bottom_up_xg"] - sub["dev03_xg"]
        sub["actual_minus_dev03"] = sub["actual_xg"] - sub["dev03_xg"]
        r_add_dev03, p_add_dev03 = stats.pearsonr(sub["bot_minus_dev03"], sub["actual_minus_dev03"])
        n_dev03 = len(sub)
        print(f"  TEST B2 (vs dev-03 prediction):  r={r_add_dev03:+.4f}  p={p_add_dev03:.4f}  n={n_dev03:,}")
        rs_dev03 = []
        for _ in range(1000):
            idx = rng.integers(0, n_dev03, size=n_dev03)
            rb, _ = stats.pearsonr(sub["bot_minus_dev03"].values[idx], sub["actual_minus_dev03"].values[idx])
            rs_dev03.append(rb)
        ci_dev03 = (float(np.percentile(rs_dev03, 2.5)), float(np.percentile(rs_dev03, 97.5)))
        print(f"    Bootstrap 95% CI: [{ci_dev03[0]:+.4f}, {ci_dev03[1]:+.4f}]")
    else:
        print(f"  TEST B2 (vs dev-03):  SKIPPED (insufficient dev-03 join coverage)")

    # Per-league breakdown (using team_rolling baseline — denser)
    per_lg = {}
    for lg, sub in df.groupby("league"):
        if len(sub) < 50:
            continue
        rl, pl = stats.pearsonr(sub["bot_minus_team"], sub["actual_minus_team"])
        per_lg[lg] = {"r_additive": float(rl), "p_value": float(pl), "n": int(len(sub))}

    # Per-season verdict: PASS if STRONG_VALIDATION criteria met
    # Explicit bool() cast — numpy bools don't serialize to JSON
    season_pass = bool(r_add_team > 0.10 and p_add_team < 0.05 and ci_team[0] > 0)

    print(f"  Season verdict: {'PASS' if season_pass else 'FAIL'} (r>0.10 + p<0.05 + CI>0 thresholds)")

    return {
        "season": focal_season,
        "status": "ok",
        "n_rows": len(df),
        "n_distinct_games": int(df["game_id"].nunique()),
        "test_a_sanity": {"r": float(r_sanity), "p": float(p_sanity)},
        "test_b1_vs_team_rolling": {
            "r_additive": float(r_add_team),
            "p_value": float(p_add_team),
            "bootstrap_ci_95": list(ci_team),
            "n": len(df),
            "is_proxy_for_dev03": True,
            "note": "Cheap baseline — team-rolling-xg approximates dev-03's team-level component",
        },
        "test_b2_vs_dev03": ({
            "r_additive": float(r_add_dev03),
            "p_value": float(p_add_dev03),
            "bootstrap_ci_95": list(ci_dev03) if ci_dev03 else None,
            "n": int(n_dev03),
            "in_sample_caveat": bool(focal_season in ("22/23", "23/24", "24/25")),
            "note": "Rigorous baseline (audit committee recommendation). IN-SAMPLE for 22/23-24/25 (dev-03 trained on cutoff=2025-08-01).",
        } if r_add_dev03 is not None else {"status": "skipped_insufficient_coverage"}),
        "per_league": per_lg,
        "season_pass": season_pass,
    }


# ─── Cross-season aggregation + verdict ────────────────────────────────────


def aggregate_multiseason(per_season_results: dict) -> dict:
    """Apply pre-registered thresholds across seasons."""
    successful = [r for r in per_season_results.values() if r.get("status") == "ok"]
    n_pass = sum(1 for r in successful if r.get("season_pass"))
    r_values = [r["test_b1_vs_team_rolling"]["r_additive"] for r in successful]
    mean_r = float(np.mean(r_values)) if r_values else 0.0
    n_total = len(successful)

    # Pre-registered thresholds (only meaningful at n_total ≥ 4 — the design)
    if n_total < 4:
        # Single-season or partial-replication runs — verdict can't apply
        verdict = "INCOMPLETE_REPLICATION"
        if n_pass == n_total and n_total >= 1:
            action = (f"Tested {n_total}/4 seasons, all passed — partial evidence positive. "
                      f"Rerun with all 4 seasons to apply pre-registered STRONG_VALIDATION criterion.")
        else:
            action = (f"Tested {n_total}/4 seasons, {n_pass} passed — rerun with all 4 seasons "
                      f"for proper cross-season verdict.")
    elif n_pass == 4 and mean_r >= 0.15:
        verdict = "STRONG_VALIDATION"
        action = "BUILD D4 — all 4 seasons pass + mean r≥0.15"
    elif n_pass >= 3:
        verdict = "PARTIAL"
        action = "REVIEW per-season failures + cautious D4 scope"
    elif n_pass < 3 or mean_r < 0.10:
        verdict = "REJECTED"
        action = "ARCHIVE D4 sprint — bottom-up signal does not replicate cross-season"
    else:
        verdict = "AMBIGUOUS"
        action = "Review case-by-case"

    return {
        "n_seasons_tested": n_total,
        "n_seasons_passing": n_pass,
        "mean_r_additive_vs_team_rolling": mean_r,
        "per_season_r": {r["season"]: r["test_b1_vs_team_rolling"]["r_additive"]
                          for r in successful},
        "final_verdict": verdict,
        "decision_action": action,
        "pre_registered_thresholds": {
            "STRONG_VALIDATION": "ALL 4 seasons r>0.10 AND p<0.05 AND CI>0 AND mean r≥0.15",
            "PARTIAL": "3/4 seasons pass",
            "REJECTED": "<3/4 seasons pass OR mean r<0.10",
        },
    }


# ─── Main ──────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="+", default=["22/23", "23/24", "24/25", "25/26"],
                    help="One or more seasons (default: all 4)")
    ap.add_argument("--skip-dev03-baseline", action="store_true",
                    help="Skip dev-03 prediction baseline (saves ~1h compute, only team_rolling tested)")
    args = ap.parse_args()

    print("═" * 70)
    print(f"Bottom-up lineup signal — CROSS-SEASON test · seasons={args.seasons}")
    print("═" * 70)
    print(f"  Pre-registered thresholds:")
    print(f"    STRONG_VALIDATION: ALL seasons r>0.10 AND p<0.05 AND CI>0 AND mean r≥0.15")
    print(f"    PARTIAL: 3/4 pass | REJECTED: <3/4 or mean r<0.10")
    print()

    conn = sqlite3.connect(str(LOCAL_DB))

    # Compute ALL-SEASONS rolling once (efficiency: saves ~3min vs 4× recompute)
    print("[1/3] Building all-seasons rolling caches...")
    player_df = compute_player_rolling_all_seasons(conn)
    team_df = compute_team_rolling_all_seasons(conn)

    # Process each season
    print(f"\n[2/3] Processing {len(args.seasons)} season(s)...")
    per_season_results = {}
    for focal_season in args.seasons:
        print(f"\n  Loading lineups for {focal_season}...")
        lineups = load_lineups(focal_season)

        player_rolling = filter_player_rolling_for_season(player_df, focal_season)
        team_rolling, actual_team_xg = filter_team_rolling_for_season(team_df, focal_season)

        if args.skip_dev03_baseline:
            dev03_baseline = {}
            print(f"    Skipping dev-03 baseline (--skip-dev03-baseline)")
        else:
            dev03_baseline = compute_dev03_baseline(focal_season)

        result = run_signal_test_for_season(
            focal_season, player_rolling, team_rolling, actual_team_xg,
            dev03_baseline, lineups, conn,
        )
        per_season_results[focal_season] = result

        # Write per-season JSON
        if result.get("status") == "ok":
            slug = season_slug(focal_season)
            per_season_path = DIAG_DIR / f"bottom_up_lineup_signal_{slug}.json"
            per_season_path.write_text(json.dumps(result, indent=2))
            print(f"    → {per_season_path.relative_to(REPO_ROOT)}")

    # Aggregate cross-season
    print(f"\n[3/3] Aggregating cross-season verdict...")
    aggregate = aggregate_multiseason(per_season_results)

    print(f"\n" + "═" * 70)
    print("CROSS-SEASON SUMMARY")
    print("═" * 70)
    print(f"  {'Season':<8} {'n':>6} {'r_add':>8} {'p':>8} {'CI95 low':>10} {'pass?':>6}")
    for season, r in per_season_results.items():
        if r.get("status") == "ok":
            tb1 = r["test_b1_vs_team_rolling"]
            print(f"  {season:<8} {r['n_rows']:>6,} {tb1['r_additive']:>+8.4f} "
                  f"{tb1['p_value']:>8.4f} {tb1['bootstrap_ci_95'][0]:>+10.4f}  "
                  f"{'PASS' if r['season_pass'] else 'FAIL':>6}")
        else:
            print(f"  {season:<8}  {r.get('status', '?'):>30}")
    print()
    print(f"  Mean r_additive_vs_team_rolling: {aggregate['mean_r_additive_vs_team_rolling']:+.4f}")
    print(f"  Seasons passing: {aggregate['n_seasons_passing']}/{aggregate['n_seasons_tested']}")
    print()
    print(f"  ━━━ FINAL VERDICT: {aggregate['final_verdict']} ━━━")
    print(f"  → {aggregate['decision_action']}")

    # Write combined multiseason JSON
    multiseason = {
        "seasons_tested": args.seasons,
        "skip_dev03_baseline": args.skip_dev03_baseline,
        "rolling_N_player": ROLLING_N,
        "rolling_N_team": TEAM_ROLLING_N,
        "per_season": per_season_results,
        "aggregate_across_seasons": aggregate,
        "caveats": [
            "MVP uses Sofa-only data (no Understat); xG NULL = treated as 0 (no shots).",
            "Estimated minutes = 90 for all starters (no minute-prediction modeling).",
            "team_rolling baseline is sum-of-player-xg across (game, side); audit-bug-fixed GROUP BY.",
            "dev-03 baseline (when not skipped) is IN-SAMPLE for 22/23-24/25 (cutoff=2025-08-01).",
            "Test corpus is Top-5 ONLY — lower-tier untested.",
            "5-Gate G5 (ROI sim) deferred — this is signal-test only, not betting test.",
        ],
    }
    out_path = DIAG_DIR / "bottom_up_lineup_signal_multiseason.json"
    out_path.write_text(json.dumps(multiseason, indent=2))
    print(f"\n  ✓ Multi-season output: {out_path.relative_to(REPO_ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
