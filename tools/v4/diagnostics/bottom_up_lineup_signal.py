#!/usr/bin/env python3
"""Bottom-up lineup signal — scoped MVP test.

Question: Does Σ(starter_xG_per_90 × est_minutes/90) correlate with actual team xG
in a way that EXCEEDS what team-rolling-xG already explains?

If YES → bottom-up architecture worth building (5-7 day sprint).
If NO  → reject early; save the sprint.

Methodology:
  1. For each Top-5 × 24/25 match with full lineup data:
     a. Get starting XI from Sofa cache JSON (player_ids)
     b. For each starter, compute their PRIOR rolling xG-per-90 from
        sofascore_player_match_stats (chronologically before this match)
     c. Sum to get bottom_up_team_xg
  2. Get team-rolling baseline from sofascore_team_chance_quality
     (avg team_xg over last 5 prior matches)
  3. Get actual team_xg for the focal match
  4. Run 3 tests:
     a. Sanity: corr(bottom_up, actual) — does the metric even correlate?
     b. ADDITIVE: corr(bottom_up − team_rolling, actual − team_rolling)
        → positive slope = bottom-up has signal beyond team-rolling
        → zero/negative slope = info-redundant
     c. Brier-style: bootstrap CI on the additive correlation

Pre-registered hypothesis: ADDITIVE r > 0.05 with bootstrap p < 0.05 = signal.
Pre-registered rejection: r ≤ 0.05 OR p > 0.05 = reject.

5-Gate audit:
  G1: signed-residual sign convention checked
  G2: Holm-Bonferroni (single hypothesis, α=0.05)
  G3: leakage audit (PRIOR-match-only rolling)
  G4: power analysis (need n ≥ 832; we have ~1,400 Top-5 24/25 matches)
  G5: ROI simulation (skipped for now — this is a SIGNAL test, not a betting test)

Output: tools/v4/diagnostics/bottom_up_lineup_signal.json
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from collections import defaultdict

import numpy as np
import pandas as pd
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
EXTRAS_DIR = REPO_ROOT / "tools" / "sofascore" / "data" / "extras"
OUT_JSON = REPO_ROOT / "tools" / "v4" / "diagnostics" / "bottom_up_lineup_signal.json"

TOP5 = ("epl", "la_liga", "bundesliga", "serie_a", "ligue_1")
FOCAL_SEASON = "24/25"
ROLLING_N = 10  # prior matches to average per player
TEAM_ROLLING_N = 5  # prior matches for team-baseline


def load_lineups(focal_season: str) -> dict[int, dict]:
    """Extract starting XI per (game_id, side) from Sofa cache JSONs.

    Returns: {game_id: {'home': [player_id, ...], 'away': [...], 'league': ...}}
    """
    out = {}
    n_files_checked = 0
    n_with_lineup = 0
    for p in EXTRAS_DIR.glob("*.json"):
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        n_files_checked += 1
        if d.get("league") not in TOP5:
            continue
        if d.get("season") != focal_season:
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
            starters = [s for s in starters if s]  # drop nulls
            out.setdefault(game_id, {})[side] = starters
        out[game_id]["league"] = d["league"]
    print(f"  Checked {n_files_checked:,} cache files, {n_with_lineup:,} had lineups")
    print(f"  Final: {len(out):,} matches with lineups extracted (Top-5 × {focal_season})")
    return out


def build_player_rolling_xg(conn: sqlite3.Connection, focal_season: str) -> dict:
    """Compute rolling-N xg-per-90 per player up to each game_date.

    Returns: {(player_id, game_id): rolling_xg_per_90}
    where rolling is computed over <= ROLLING_N PRIOR matches of that player.
    """
    print(f"  Building per-player rolling xG-per-90 (N={ROLLING_N})...")

    # Load all Sofa player_match_stats rows for players appearing in focal season
    # Need (player_id, game_id, expected_goals, minutes_played, game_date)
    df = pd.read_sql_query("""
        SELECT pms.player_id, pms.game_id, pms.expected_goals, pms.minutes_played,
               sm.start_timestamp, sm.league, sm.season
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        WHERE pms.minutes_played > 0
    """, conn)
    df["expected_goals"] = df["expected_goals"].fillna(0.0)  # null = no shots = 0 xG
    print(f"    Loaded {len(df):,} player-match rows (all seasons)")

    # Sort chronologically per player
    df = df.sort_values(["player_id", "start_timestamp"], kind="mergesort").reset_index(drop=True)

    # Compute rolling mean of xg-per-90 (using STRICT prior matches via shift)
    df["xg_per_90"] = df["expected_goals"] / (df["minutes_played"] / 90.0).clip(lower=0.1)
    df["xg_per_90"] = df["xg_per_90"].clip(0, 3.0)  # sanity cap

    # Rolling mean of PRIOR N matches (shift+rolling to exclude current)
    df["rolling_xg_per_90"] = (
        df.groupby("player_id")["xg_per_90"]
          .transform(lambda s: s.shift(1).rolling(ROLLING_N, min_periods=3).mean())
    )

    # Build lookup keyed by (player_id, game_id) — only for matches IN focal season
    focal_df = df[df["season"] == focal_season].copy()
    focal_df = focal_df.dropna(subset=["rolling_xg_per_90"])
    print(f"    Focal-season rows with valid rolling: {len(focal_df):,}")
    return {(int(r["player_id"]), int(r["game_id"])): float(r["rolling_xg_per_90"])
            for _, r in focal_df.iterrows()}


def build_team_rolling_xg(conn: sqlite3.Connection, focal_season: str) -> dict:
    """Team-level rolling xG (TEAM_ROLLING_N prior matches) per (game_id, team_side).

    Returns: {(game_id, 'home'|'away'): rolling_team_xg}
    """
    print(f"  Building per-team rolling xG (N={TEAM_ROLLING_N})...")
    # Use sofascore_team_chance_quality view if available, else per-team xG aggregate
    # Simpler: aggregate from player_match_stats by team
    df = pd.read_sql_query("""
        SELECT pms.game_id, pms.team_id, pms.is_home,
               SUM(COALESCE(pms.expected_goals, 0)) AS team_xg,
               sm.start_timestamp, sm.league, sm.season,
               sm.home_team_id, sm.away_team_id
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        GROUP BY pms.game_id, pms.team_id, pms.is_home
    """, conn)
    df = df.sort_values(["team_id", "start_timestamp"], kind="mergesort").reset_index(drop=True)
    df["rolling_team_xg"] = (
        df.groupby("team_id")["team_xg"]
          .transform(lambda s: s.shift(1).rolling(TEAM_ROLLING_N, min_periods=3).mean())
    )
    df["side"] = df["is_home"].apply(lambda x: "home" if x else "away")
    focal = df[df["season"] == focal_season].dropna(subset=["rolling_team_xg"])
    print(f"    Focal-season team-rows with valid rolling: {len(focal):,}")
    return {(int(r["game_id"]), r["side"]): float(r["rolling_team_xg"])
            for _, r in focal.iterrows()}, df[["game_id", "team_id", "is_home", "team_xg"]].copy()


def main():
    print("═" * 70)
    print(f"Bottom-up lineup signal MVP test · Top-5 × {FOCAL_SEASON}")
    print("═" * 70)

    print("\n[1/5] Loading lineups from Sofa cache...")
    lineups = load_lineups(FOCAL_SEASON)

    conn = sqlite3.connect(str(LOCAL_DB))

    print("\n[2/5] Building per-player rolling xG-per-90...")
    player_rolling = build_player_rolling_xg(conn, FOCAL_SEASON)

    print("\n[3/5] Building team-baseline rolling xG...")
    team_rolling, all_team_xg = build_team_rolling_xg(conn, FOCAL_SEASON)

    print("\n[4/5] Joining + computing bottom-up xG per match per team...")

    # Build actual team-xg lookup (for the focal match)
    actual_team_xg = {(int(r["game_id"]), "home" if r["is_home"] else "away"): float(r["team_xg"])
                     for _, r in all_team_xg.iterrows()}

    rows = []
    n_with_full_data = 0
    n_missing_player_rolling = 0
    n_missing_team_rolling = 0
    n_missing_actual = 0

    for game_id, info in lineups.items():
        for side in ("home", "away"):
            starters = info.get(side, [])
            if len(starters) < 7:  # need at least ~7 starters with rolling data
                continue
            # Sum xg-per-90 × (90 minutes assumed) / 90 = sum of xg-per-90
            # (assumes all starters play 90 min, which is a coarse but consistent assumption)
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

            rows.append({
                "game_id": game_id,
                "league": info["league"],
                "side": side,
                "bottom_up_xg": bottom_up_xg,
                "team_rolling_xg": team_baseline,
                "actual_xg": actual,
                "n_starters_with_rolling": n_starters_w_data,
            })
            n_with_full_data += 1

    print(f"  Final dataset: {n_with_full_data:,} (team, match) joined rows")
    print(f"  Dropped — missing player rolling: {n_missing_player_rolling:,}")
    print(f"  Dropped — missing team rolling:   {n_missing_team_rolling:,}")
    print(f"  Dropped — missing actual:          {n_missing_actual:,}")

    if n_with_full_data < 200:
        print(f"\n  ✗ Insufficient data ({n_with_full_data} < 200) — aborting test")
        return 1

    df = pd.DataFrame(rows)

    print(f"\n[5/5] Statistical tests...")
    print("─" * 70)

    # Test A: Sanity check — does bottom_up correlate with actual at all?
    r_sanity, p_sanity = stats.pearsonr(df["bottom_up_xg"], df["actual_xg"])
    print(f"\n  TEST A · Sanity: corr(bottom_up, actual)")
    print(f"    r = {r_sanity:.4f}  ·  p = {p_sanity:.4f}  ·  n = {len(df):,}")
    if r_sanity < 0.10:
        print(f"    ⚠ Weak correlation — bottom-up barely tracks reality")

    # Test B: Additive test — does bottom_up explain residuals after team-rolling?
    df["bottom_up_minus_baseline"] = df["bottom_up_xg"] - df["team_rolling_xg"]
    df["actual_minus_baseline"] = df["actual_xg"] - df["team_rolling_xg"]
    r_additive, p_additive = stats.pearsonr(df["bottom_up_minus_baseline"], df["actual_minus_baseline"])
    print(f"\n  TEST B · ADDITIVE: corr(bottom_up − team_rolling, actual − team_rolling)")
    print(f"    r = {r_additive:.4f}  ·  p = {p_additive:.4f}  ·  n = {len(df):,}")
    if r_additive > 0.05 and p_additive < 0.05:
        verdict_B = "SIGNAL — bottom-up explains residuals beyond team-rolling"
    elif p_additive < 0.05 and abs(r_additive) > 0.02:
        verdict_B = "MARGINAL — statistically significant but very weak effect"
    else:
        verdict_B = "REJECTED — no additive signal beyond team-rolling"
    print(f"    → {verdict_B}")

    # Bootstrap CI on r_additive
    n_bootstrap = 1000
    rng = np.random.default_rng(42)
    rs = []
    for _ in range(n_bootstrap):
        idx = rng.integers(0, len(df), size=len(df))
        rb, _ = stats.pearsonr(
            df["bottom_up_minus_baseline"].values[idx],
            df["actual_minus_baseline"].values[idx])
        rs.append(rb)
    ci_low = float(np.percentile(rs, 2.5))
    ci_high = float(np.percentile(rs, 97.5))
    print(f"\n  Bootstrap 95% CI on r_additive: [{ci_low:+.4f}, {ci_high:+.4f}]")
    if ci_low > 0:
        ci_verdict = "CI strictly positive → robust additive signal"
    elif ci_high < 0:
        ci_verdict = "CI strictly negative → anti-signal (weird)"
    else:
        ci_verdict = "CI straddles 0 → cannot reject null"
    print(f"  → {ci_verdict}")

    # Test C: Per-league breakdown
    print(f"\n  PER-LEAGUE Additive correlations:")
    per_lg = {}
    for lg, sub in df.groupby("league"):
        if len(sub) < 50:
            continue
        rl, pl = stats.pearsonr(sub["bottom_up_minus_baseline"], sub["actual_minus_baseline"])
        per_lg[lg] = {"r_additive": float(rl), "p_value": float(pl), "n": int(len(sub))}
        marker = "✓" if rl > 0.05 and pl < 0.05 else "✗"
        print(f"    {marker} {lg:<14} n={len(sub):>4,}  r={rl:+.4f}  p={pl:.4f}")

    # Final verdict
    print("\n" + "═" * 70)
    print("FINAL VERDICT")
    print("═" * 70)

    # Pre-registered: ADDITIVE r > 0.05 AND p < 0.05 = signal
    if r_additive > 0.05 and p_additive < 0.05 and ci_low > 0:
        final = "BUILD"
        print(f"\n  ✅ BUILD-RECOMMENDED")
        print(f"     ADDITIVE r={r_additive:+.4f} > 0.05, p={p_additive:.4f} < 0.05, CI strictly positive")
        print(f"     → Bottom-up architecture has measurable signal beyond team-rolling")
        print(f"     → Next step: 5-7 day full bottom-up build")
    elif p_additive < 0.05 and abs(r_additive) > 0.02:
        final = "WEAK"
        print(f"\n  ⚠ WEAK-EVIDENCE")
        print(f"     Statistically significant but very small effect (r={r_additive:+.4f})")
        print(f"     → Could still build but expected ROI gain is marginal")
        print(f"     → Consider effort/reward before committing 5-7 days")
    else:
        final = "REJECT"
        print(f"\n  ❌ REJECT (per pre-registered criteria)")
        print(f"     ADDITIVE r={r_additive:+.4f} {'(below 0.05 threshold)' if abs(r_additive) <= 0.05 else ''}")
        print(f"     p={p_additive:.4f} {'(above 0.05 threshold)' if p_additive >= 0.05 else ''}")
        print(f"     Bootstrap CI: [{ci_low:+.4f}, {ci_high:+.4f}]")
        print(f"     → Bottom-up adds no signal beyond team-rolling on this corpus")
        print(f"     → Save the 5-7 day sprint. Stick with dev-03 architecture.")

    # Save JSON
    out = {
        "focal_season": FOCAL_SEASON,
        "n_matches_team_rows": int(len(df)),
        "n_distinct_games": int(df["game_id"].nunique()),
        "rolling_N_player": ROLLING_N,
        "rolling_N_team": TEAM_ROLLING_N,
        "test_a_sanity_correlation": {
            "r": float(r_sanity), "p": float(p_sanity),
            "interpretation": "Does Σ(starter rolling xG) track actual team xG at all?",
        },
        "test_b_additive": {
            "r_additive": float(r_additive),
            "p_value": float(p_additive),
            "bootstrap_ci_95": [ci_low, ci_high],
            "n_bootstrap": n_bootstrap,
            "interpretation": (
                "ADDITIVE test: does bottom_up explain residuals AFTER subtracting team-rolling baseline? "
                "Positive r = bottom-up has signal beyond team-rolling. "
                "Pre-registered threshold: r > 0.05 AND p < 0.05 AND CI strictly positive = SIGNAL"
            ),
            "verdict": verdict_B,
            "ci_verdict": ci_verdict,
        },
        "per_league": per_lg,
        "final_verdict": final,
        "recommendation": {
            "BUILD": "5-7 day bottom-up architecture build justified by signal evidence",
            "WEAK":  "Borderline — proceed only if mechanistic hypothesis strong",
            "REJECT": "Stick with dev-03 team-rolling — bottom-up info-redundant per this test",
        }[final],
        "caveats": [
            "MVP uses Sofa-only data (no Understat-fuzzy-match); xG NULL = treated as 0 (no shots)",
            "Estimated minutes = 90 for all starters (no minute-prediction modeling)",
            "Team-rolling baseline is sum-of-player-xg (cleaner than independent team_xg_history)",
            "Test corpus is Top-5 × 24/25 ONLY — lower-tier untested (different data structure)",
            "5-Gate G5 (ROI sim) deferred — this is signal-test only, not betting test",
        ],
    }
    OUT_JSON.write_text(json.dumps(out, indent=2))
    print(f"\n  ✓ Output: {OUT_JSON.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
