"""Tests for tools/v4/modules/m3_xg/bottom_up_features.BottomUpCalculator.

Enforces D4 Day 1 audit-committee invariants:
  1. GROUP BY (game_id, is_home) — never team_id (bug-class A regression)
  2. shift(1).rolling(N=10, min_periods=3) leakage-safety
  3. MVP-replication: must reproduce r=+0.2409 (24/25 Top-5 corpus, vs team_rolling baseline)
  4. Layer-3 graceful degradation when n_starters < 7

These tests gate every dev-09 commit. If any test fails, the bug-class A
or leakage contracts have been violated and engine output is suspect.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from v4.modules.m3_xg.bottom_up_features import (
    DEV_09_BOTTOM_UP_FEATURES,
    MIN_PERIODS,
    MIN_STARTERS_WITH_HISTORY,
    ROLLING_N,
    BottomUpCalculator,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SQLITE_PATH = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
TOP5 = ("epl", "la_liga", "serie_a", "bundesliga", "ligue_1")
FOCAL_SEASON = "24/25"
MVP_R_ADDITIVE_TARGET = 0.2409  # from bottom_up_lineup_signal_24-25.json
MVP_TOLERANCE = 0.005           # allow ±0.5% drift for rounding
# Diagnostic uses TEAM_ROLLING_N=5 for the team-rolling baseline
# (different from PLAYER ROLLING_N=10). This is purely for the team-baseline
# residual used by r_additive_vs_team_rolling — NOT a BottomUpCalculator
# feature, so the constant lives only in the replication test.
TEAM_ROLLING_N_MVP = 5


@pytest.fixture(scope="module")
def sqlite_path() -> Path:
    if not SQLITE_PATH.exists():
        pytest.skip(f"SQLite mirror not at {SQLITE_PATH}")
    return SQLITE_PATH


@pytest.fixture(scope="module")
def fitted_calculator(sqlite_path: Path) -> BottomUpCalculator:
    """Fitted BottomUpCalculator — shared across tests (fit is expensive ~30s)."""
    return BottomUpCalculator(sqlite_path).fit()


# ─── Constants + shape ─────────────────────────────────────────────────────


def test_constants_match_audit_contract():
    """ROLLING_N=10, MIN_PERIODS=3, MIN_STARTERS=7 (audit-frozen)."""
    assert ROLLING_N == 10
    assert MIN_PERIODS == 3
    assert MIN_STARTERS_WITH_HISTORY == 7


def test_dev09_feature_list_shape():
    """DEV_09_BOTTOM_UP_FEATURES must expose 8 diffs + available + n_min."""
    assert len(DEV_09_BOTTOM_UP_FEATURES) == 10
    assert "bottom_up_xg_diff" in DEV_09_BOTTOM_UP_FEATURES
    assert "bottom_up_available" in DEV_09_BOTTOM_UP_FEATURES
    assert "n_starters_with_history_min" in DEV_09_BOTTOM_UP_FEATURES
    # Audit-rejected feature must NOT be exposed
    assert "bottom_up_chain_diff" not in DEV_09_BOTTOM_UP_FEATURES
    # No dev-03 macro feature borrows allowed (TABULA RASA architecture)
    for f in DEV_09_BOTTOM_UP_FEATURES:
        assert "lambda_h" not in f and "elo" not in f and "league_home_avg" not in f, \
            f"Feature {f} leaks dev-03 macro feature naming — TABULA RASA violation"


# ─── Bug-class A: GROUP BY (game_id, is_home), NOT team_id ──────────────────


def _strip_docs_and_comments(src: str) -> str:
    """Strip Python docstrings + comments so source-pattern checks don't match
    documentation/warning text (e.g. our own bug-class-A warning in the module
    docstring uses the literal phrase we're guarding against)."""
    import ast
    tree = ast.parse(src)
    # Remove docstrings from module + function/class bodies
    for node in ast.walk(tree):
        if (isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef,
                              ast.ClassDef)) and
            node.body and isinstance(node.body[0], ast.Expr) and
            isinstance(node.body[0].value, ast.Constant) and
            isinstance(node.body[0].value.value, str)):
            node.body[0].value.value = ""  # blank out docstring
    # Unparse, then strip `#` comments line-by-line
    no_docs = ast.unparse(tree)
    no_comments = "\n".join(
        line.split("#")[0] for line in no_docs.splitlines()
    )
    return no_comments


def test_bug_class_a_no_team_id_groupby(fitted_calculator: BottomUpCalculator):
    """Bug-class A regression: BottomUpCalculator must NOT use team_id for player aggregation.

    Player team_id is the player's CURRENT-registered team (post-transfer).
    Match-team is derived from sofa_match.home_team_id / away_team_id.

    Scans the AST-cleaned source (docstrings + comments stripped) so that
    cautionary mentions in documentation don't trigger false-positives.
    The actual SQL in fit() must NOT have a GROUP BY clause involving team_id;
    aggregation happens Python-side via _aggregate_starters with explicit
    starting_xi lists supplied by the caller.
    """
    src = (REPO_ROOT / "tools" / "v4" / "modules" / "m3_xg" /
           "bottom_up_features.py").read_text()
    code_only = _strip_docs_and_comments(src)
    # Strict: the SQL in fit() must NOT GROUP BY team_id (case-insensitive,
    # tolerant of whitespace)
    import re
    pattern = re.compile(r"GROUP\s+BY[^A-Za-z]*\bteam_id\b", re.IGNORECASE)
    matches = pattern.findall(code_only)
    assert not matches, (
        f"BUG-CLASS-A: SQL GROUP BY team_id pattern detected in code "
        f"(matched: {matches}). Player team_id is CURRENT-team after transfer, "
        "not match-team. Use GROUP BY (game_id, is_home) and derive match-team "
        "from sofa_match.home_team_id / away_team_id instead."
    )


def test_aggregator_uses_explicit_starter_lists(fitted_calculator: BottomUpCalculator):
    """get_features_for_match takes explicit starting_xi lists — never queries by team_id.

    Verifies the API contract: caller must supply the actual match-side starter
    player_ids, removing all team_id ambiguity. Empty lists return Layer-3
    degradation; not an error.
    """
    out = fitted_calculator.get_features_for_match(
        game_id=99999999,  # nonexistent
        starting_xi_home=[],
        starting_xi_away=[],
    )
    # Layer-3: no starters with history → all features = 0, not available
    assert out["bottom_up_available"] == 0
    for f in ("bottom_up_xg_diff", "bottom_up_xa_diff", "bottom_up_shots_diff",
              "bottom_up_key_passes_diff", "attack_concentration_diff",
              "defense_block_sum_diff", "gk_save_rate_diff", "minutes_rate_diff"):
        assert out[f] == 0.0


# ─── Leakage-safety: shift(1).rolling(N=10, min_periods=3) ──────────────────


def test_leakage_safe_pattern_in_source():
    """Source code must use shift(1).rolling pattern, not raw rolling."""
    src = (REPO_ROOT / "tools" / "v4" / "modules" / "m3_xg" /
           "bottom_up_features.py").read_text()
    # Required pattern
    assert ".shift(1).rolling(" in src, \
        "LEAKAGE: shift(1).rolling(N) pattern required — focal match must be excluded"
    # mergesort determinism (also audit-required)
    assert 'kind="mergesort"' in src or "kind='mergesort'" in src, \
        "DETERMINISM: pandas.sort_values must use kind='mergesort' (default quicksort is unstable)"
    # Sort by (player_id, start_timestamp) — must canonicalize to chrono
    assert "player_id" in src and "start_timestamp" in src


def test_leakage_safe_focal_match_excluded(fitted_calculator: BottomUpCalculator):
    """Empirical leakage-safety: for a known player, rolling-xg at game N
    must equal the mean of games [N-10..N-1], never including game N itself.

    Direct numeric check by walking through one player's chronological history.
    """
    con = sqlite3.connect(str(SQLITE_PATH))
    # Find a player with many matches (top 1)
    row = con.execute("""
        SELECT player_id, COUNT(*) as n
        FROM sofascore_player_match_stats pms
        WHERE pms.minutes_played > 0 AND pms.expected_goals IS NOT NULL
        GROUP BY player_id ORDER BY n DESC LIMIT 1
    """).fetchone()
    assert row is not None
    pid = row[0]

    # Get full chronological xg-per-90 sequence
    df = pd.read_sql_query("""
        SELECT pms.game_id, pms.expected_goals, pms.minutes_played, sm.start_timestamp
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        WHERE pms.player_id = ? AND pms.minutes_played > 0
        ORDER BY sm.start_timestamp
    """, con, params=[pid])
    con.close()

    df["expected_goals"] = df["expected_goals"].fillna(0.0)
    df["xg_per_90"] = (df["expected_goals"] / (df["minutes_played"] / 90.0).clip(lower=0.1)).clip(0, 3.0)

    # Compute reference shift(1).rolling(10, min_periods=3) ourselves
    df["ref_rolling"] = df["xg_per_90"].shift(1).rolling(ROLLING_N, min_periods=MIN_PERIODS).mean()

    # Compare against fitted_calculator cache for matches with ≥ MIN_PERIODS prior
    matches_with_history = df.dropna(subset=["ref_rolling"])
    if len(matches_with_history) == 0:
        pytest.skip(f"Player {pid} has < {MIN_PERIODS} prior matches anywhere")

    mismatches = 0
    n_checked = 0
    for _, r in matches_with_history.iterrows():
        gid = int(r["game_id"])
        cached = fitted_calculator._player_rolling.get((pid, gid))
        if cached is None:
            continue
        # Cached value must equal ref (within float epsilon)
        diff = abs(cached["xg_per_90"] - float(r["ref_rolling"]))
        if diff > 1e-9:
            mismatches += 1
        n_checked += 1

    assert n_checked > 10, f"Only {n_checked} cache lookups for player {pid} — sample too small"
    assert mismatches == 0, \
        f"LEAKAGE: {mismatches}/{n_checked} games had rolling-xg ≠ shift(1)+rolling reference"


# ─── Layer-3 degradation ─────────────────────────────────────────────────────


def test_layer3_degradation_below_min_starters(fitted_calculator: BottomUpCalculator):
    """When n_starters_with_history < MIN_STARTERS_WITH_HISTORY → all features = 0,
    available = 0. The engine then falls back to orthogonal context (Elo, league).
    """
    # Pick a real game_id from cache, pass only 3 starters
    sample_key = next(iter(fitted_calculator._player_rolling.keys()))
    pid, gid = sample_key

    out = fitted_calculator.get_features_for_match(
        game_id=gid,
        starting_xi_home=[pid, pid, pid],   # only 3 < 7
        starting_xi_away=[pid, pid, pid, pid, pid, pid, pid],
    )
    assert out["bottom_up_available"] == 0
    for f in ("bottom_up_xg_diff", "bottom_up_xa_diff", "bottom_up_shots_diff",
              "bottom_up_key_passes_diff", "attack_concentration_diff",
              "defense_block_sum_diff", "gk_save_rate_diff", "minutes_rate_diff"):
        assert out[f] == 0.0


# ─── MVP replication regression: r=+0.2409 on 24/25 Top-5 ───────────────────


def test_mvp_replication_r_additive(fitted_calculator: BottomUpCalculator):
    """Critical regression test: BottomUpCalculator's per-player rolling cache
    must reproduce the MVP signed-residual r=+0.2409 on Top-5 24/25 corpus.

    Methodology mirrors tools/v4/diagnostics/bottom_up_lineup_signal.py::TEST B1:
      r_additive = pearsonr(
        bottom_up_xg - team_rolling_xg,        # bottom-up signal vs team baseline
        actual_xg     - team_rolling_xg,       # actual outcome vs team baseline
      )

    bottom_up_xg = sum of starters' rolling_xg_per_90
    team_rolling_xg = team's last-10-matches xG mean (GROUP BY game_id, is_home)
    actual_xg = team's actual sum-of-player-xg in this match
    """
    # 1. Load Top-5 24/25 starters from is_starter=1
    con = sqlite3.connect(str(SQLITE_PATH))
    starters_df = pd.read_sql_query(f"""
        SELECT pms.game_id, pms.is_home, pms.player_id
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        WHERE pms.is_starter = 1
          AND sm.season = '{FOCAL_SEASON}'
          AND sm.league IN ({','.join(repr(l) for l in TOP5)})
    """, con)
    # 2. Team-rolling baseline (audit-bug-fixed GROUP BY)
    team_df = pd.read_sql_query(f"""
        SELECT pms.game_id, pms.is_home,
               SUM(COALESCE(pms.expected_goals, 0)) AS team_xg,
               sm.start_timestamp, sm.season,
               sm.home_team_id, sm.away_team_id
        FROM sofascore_player_match_stats pms
        JOIN sofascore_match sm ON sm.game_id = pms.game_id
        GROUP BY pms.game_id, pms.is_home
    """, con)
    con.close()

    team_df["match_team_id"] = team_df.apply(
        lambda r: r["home_team_id"] if r["is_home"] else r["away_team_id"], axis=1
    )
    team_df = team_df.sort_values(["match_team_id", "start_timestamp"],
                                  kind="mergesort").reset_index(drop=True)
    team_df["rolling_team_xg"] = (
        team_df.groupby("match_team_id")["team_xg"]
               .transform(lambda s: s.shift(1).rolling(TEAM_ROLLING_N_MVP, min_periods=MIN_PERIODS).mean())
    )

    # Filter to focal season rows
    focal_team = team_df[team_df["season"] == FOCAL_SEASON].dropna(subset=["rolling_team_xg"])
    team_rolling_lookup = {
        (int(r["game_id"]), bool(r["is_home"])): float(r["rolling_team_xg"])
        for _, r in focal_team.iterrows()
    }
    actual_lookup = {
        (int(r["game_id"]), bool(r["is_home"])): float(r["team_xg"])
        for _, r in team_df[team_df["season"] == FOCAL_SEASON].iterrows()
    }

    # 3. Iterate over (game_id, side) keys, aggregate starters via calculator
    rows = []
    for (gid, side_int), starter_group in starters_df.groupby(["game_id", "is_home"]):
        side_bool = bool(side_int)
        # Aggregate via BottomUpCalculator's internal method
        starter_ids = starter_group["player_id"].tolist()
        if len(starter_ids) < MIN_STARTERS_WITH_HISTORY:
            continue
        # Compute sum-of-rolling-xg using calculator cache directly
        bottom_up_xg = 0.0
        n_with = 0
        for pid in starter_ids:
            entry = fitted_calculator._player_rolling.get((int(pid), int(gid)))
            if entry is not None:
                bottom_up_xg += entry["xg_per_90"]
                n_with += 1
        if n_with < MIN_STARTERS_WITH_HISTORY:
            continue
        team_baseline = team_rolling_lookup.get((int(gid), side_bool))
        actual = actual_lookup.get((int(gid), side_bool))
        if team_baseline is None or actual is None:
            continue
        rows.append({
            "game_id": int(gid),
            "side": "home" if side_bool else "away",
            "bottom_up_xg": bottom_up_xg,
            "team_rolling_xg": team_baseline,
            "actual_xg": actual,
        })

    assert len(rows) >= 3000, f"Expected ≥3000 rows for 24/25 Top-5, got {len(rows)}"

    df = pd.DataFrame(rows)
    df["bot_minus_team"] = df["bottom_up_xg"] - df["team_rolling_xg"]
    df["actual_minus_team"] = df["actual_xg"] - df["team_rolling_xg"]
    r_additive, p_value = stats.pearsonr(df["bot_minus_team"], df["actual_minus_team"])

    print(f"\n  MVP replication r_additive = {r_additive:+.4f} (target ±{MVP_TOLERANCE} of {MVP_R_ADDITIVE_TARGET})")
    print(f"  n_rows = {len(df)} · p = {p_value:.2e}")

    assert abs(r_additive - MVP_R_ADDITIVE_TARGET) < MVP_TOLERANCE, \
        f"MVP REPLICATION FAILED: r_additive={r_additive:.4f} drifted >{MVP_TOLERANCE} " \
        f"from target {MVP_R_ADDITIVE_TARGET}. BottomUpCalculator cache is computing " \
        f"player-rolling differently than the diagnostic — signal contract broken."
    assert p_value < 1e-30, f"p_value={p_value:.2e} weaker than MVP — sample/method drift"


# ─── Feature-shape sanity at the unit level ─────────────────────────────────


def test_features_shape_and_keys(fitted_calculator: BottomUpCalculator):
    """get_features_for_match returns exactly the documented 10-key dict."""
    sample_key = next(iter(fitted_calculator._player_rolling.keys()))
    _, gid = sample_key
    # Pick any 11 players that have data for this game (synthetic but valid shape)
    candidates = [k for k in fitted_calculator._player_rolling.keys() if k[1] == gid]
    if len(candidates) < 22:
        pytest.skip(f"Game {gid} has only {len(candidates)} players cached")
    home_ids = [k[0] for k in candidates[:11]]
    away_ids = [k[0] for k in candidates[11:22]]

    out = fitted_calculator.get_features_for_match(
        game_id=gid, starting_xi_home=home_ids, starting_xi_away=away_ids,
    )
    assert set(out.keys()) == set(DEV_09_BOTTOM_UP_FEATURES)
    assert isinstance(out["bottom_up_available"], int)
    assert out["bottom_up_available"] in (0, 1)
    assert out["n_starters_with_history_min"] >= 0


def test_fit_required_before_query(sqlite_path: Path):
    """Calling get_features_for_match before fit() raises RuntimeError."""
    bc = BottomUpCalculator(sqlite_path)  # NOT fitted
    with pytest.raises(RuntimeError, match="must be fit"):
        bc.get_features_for_match(game_id=1, starting_xi_home=[], starting_xi_away=[])


def test_stats_reports_coverage(fitted_calculator: BottomUpCalculator):
    """stats() returns dict with fitted=True + non-zero coverage."""
    s = fitted_calculator.stats()
    assert s["fitted"] is True
    assert s["n_fitted_player_match_pairs"] > 100_000
    assert s["n_distinct_players"] > 5_000
    assert s["n_distinct_games"] > 5_000
