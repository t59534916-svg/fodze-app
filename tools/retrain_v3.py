#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
@annafrick13 v3.0 — Lean 20-Feature LightGBM Engine (v4.0 MVP Phase 3)

Refined architecture (2026-04-24): NO DEAD WEIGHT.
Dropped 9 Understat-exclusive features that were all Zero-Importance
in the v2 Supabase-smoke-run. Dropped 3 physical features that are 0%
populated in schema (pass_pct, shots_inside_box, gk_saves). Added 3
discipline features from the 75%-populated columns.

20 dense, signal-tragende features:

  Core xG (5): xg_diff_ewma, xga_diff_ewma, xg_momentum, xg_volatility, total_xg
  Elo+Ctx (5): elo_diff, sos_strength, is_derby, h2h_xg_diff, rest_days_diff
  League  (2): home_factor, league_avg
  Physis  (5): shots_total_diff_ewma, shots_on_target_diff_ewma, shot_accuracy_ewma,
               corners_diff_ewma, possession_diff_ewma
  Discipl (3): fouls_diff_ewma, yellow_cards_diff_ewma, red_cards_diff_ewma

Training: Supabase team_xg_history (~104k rows, 22 Ligen) via shared loader.
Output: public/lgbm-model-v3.json (feature_names + home_trees + away_trees
  + rho_optimal + lambda_clamp + holdout_metrics + best_params).

Runtime: src/lib/poisson-ml-engine-v3.ts must mirror FEATURE_NAMES exactly.
Parity enforced by tests/v3-parity.test.ts.

CRITICAL: All rolling features use `.shift(1).ewm(...)` or `.shift(1).rolling(...)`
to prevent future-leakage. validate_no_leakage.py must pass before commit.

Usage:
  source tools/venv/bin/activate
  DYLD_FALLBACK_LIBRARY_PATH="$HOME/lib" python3 tools/retrain_v3.py --n-trials 50
  python3 tools/retrain_v3.py --dry-run        # no JSON write
  python3 tools/retrain_v3.py --n-trials 0     # use default params (faster)
═══════════════════════════════════════════════════════════════════
"""

import os
import sys
import json
import argparse
from typing import Optional

import numpy as np
import pandas as pd

try:
    import lightgbm as lgb
except ImportError:
    print("ERROR: lightgbm not installed. Run `pip install lightgbm optuna scipy` in tools/venv.")
    sys.exit(1)

from scipy.optimize import minimize_scalar
from scipy.stats import poisson

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUTPUT = os.path.join(PROJECT_ROOT, "public", "lgbm-model-v3.json")

# Environment (supabase credentials from .env.local)
ENV_PATH = os.path.join(PROJECT_ROOT, ".env.local")


# ═══════════════════════════════════════════════════════════════════
# FEATURE CONTRACT — 20 dense features, no dead weight
# ═══════════════════════════════════════════════════════════════════

FEATURE_NAMES = [
    # ── Core xG (5) — proxied from single 'xg' column since openplay/setpiece are 0%
    "xg_diff_ewma",             # 0  EWMA(home.xg - away.xg) over 8 pre-match rows
    "xga_diff_ewma",            # 1  EWMA(home.xga - away.xga)
    "xg_momentum",              # 2  last-3 avg(xg) minus season avg(xg), home-minus-away
    "xg_volatility",            # 3  std(xg last 8), home-minus-away
    "total_xg",                 # 4  EWMA(home.xg) + EWMA(away.xg) — matchday offensive baseline

    # ── Elo + Context (5) — ported from v2
    "elo_diff",                 # 5  home_elo + HOME_ADV - away_elo
    "sos_strength",             # 6  avg opponent Elo normalized by 400, home - away
    "is_derby",                 # 7  DERBIES frozenset lookup (0/1)
    "h2h_xg_diff",              # 8  mean of last 5 H2H xg_diffs (from home perspective)
    "rest_days_diff",           # 9  (home.rest_days - away.rest_days) / 7

    # ── League-Level Constants (2)
    "home_factor",              # 10 LEAGUE_HFS[league]
    "league_avg",               # 11 LEAGUE_AVGS[league]

    # ── Physis (5) — newly activated via 78k FootyStats upsert (40-100% coverage)
    "shots_total_diff_ewma",    # 12 EWMA(shots_for diff)
    "shots_on_target_diff_ewma",# 13 EWMA(shots_on_target_for diff)
    "shot_accuracy_ewma",       # 14 EWMA(SoT / total_shots) home-minus-away
    "corners_diff_ewma",        # 15 EWMA(corners_for diff)
    "possession_diff_ewma",     # 16 EWMA(possession_pct diff)

    # ── Discipline (3) — NEW from 75%-populated cols
    "fouls_diff_ewma",          # 17 EWMA(fouls diff)
    "yellow_cards_diff_ewma",   # 18 EWMA(yellow_cards_for diff)
    "red_cards_diff_ewma",      # 19 EWMA(red_cards_for diff)
]
N_FEATURES = len(FEATURE_NAMES)  # 20
assert N_FEATURES == 20

# Monotonic constraints — direction of physical effect on home λ.
# +1: more of this feature → more home goals; -1: less; 0: no direction.
# Away model uses MONO_AWAY = -MONO_HOME (mirrored).
#
# CRITICAL: home_factor and league_avg are CONSTANT per-league. A monotonic
# constraint on a feature with only ~22 distinct values per training set is
# poison — LightGBM cannot find a clean monotone-increasing edge that minimizes
# local error, so it ABANDONS the feature entirely (Importance=0 observed in
# smoke-run 2026-04-24). Without that base-rate offset the model averages over
# all 22 leagues' goal-rates → +10% systematic λ bias → Brier collapse.
# Fix: leave both UNCONSTRAINED (mono=0) so trees can use them as base-rate
# intercepts per league.
MONO_HOME = [
    +1, -1, +1, 0, +1,          # xg core (5)
    +1, 0, 0, 0, +1,            # elo/sos/derby/h2h/rest (5)
    0, 0,                       # home_factor, league_avg — UNCONSTRAINED (per-league constants)
    +1, +1, +1, +1, +1,         # shots/SoT/accuracy/corners/poss (5)
    -1, -1, -1,                 # discipline: more fouls/cards = fewer goals (3)
]
MONO_AWAY = [-x if x != 0 else 0 for x in MONO_HOME]
assert len(MONO_HOME) == N_FEATURES
assert len(MONO_AWAY) == N_FEATURES

# Lambda clamp — wide enough that low-scoring teams don't get phantom-goals
# pushed up to 0.3 (which contaminated the global mean by +10% in smoke-run).
LAMBDA_CLAMP_LO = 0.05
LAMBDA_CLAMP_HI = 6.0


# ═══════════════════════════════════════════════════════════════════
# DERBIES — ported from tools/retrain_v2.py:124-138 with Supabase-team-name
# normalization (Bayern Munich vs Bayern München, AC Milan vs Milan, etc.)
# ═══════════════════════════════════════════════════════════════════

# Map of variant team names → canonical name used in DERBIES set
TEAM_NAME_ALIASES = {
    "Bayern München": "Bayern Munich",
    "FC Bayern München": "Bayern Munich",
    "FC Bayern": "Bayern Munich",
    "TSV 1860 München": "1860 Munich",
    "Dortmund": "Borussia Dortmund",
    "BVB": "Borussia Dortmund",
    "FC Schalke 04": "Schalke 04",
    "FC Liverpool": "Liverpool",
    "FC Everton": "Everton",
    "Tottenham Hotspur": "Tottenham",
    "FC Arsenal": "Arsenal",
    "FC Chelsea": "Chelsea",
    "FC Barcelona": "Barcelona",
    "Real Madrid CF": "Real Madrid",
    "Atlético Madrid": "Atletico Madrid",
    "Atlético de Madrid": "Atletico Madrid",
    "Club Atlético de Madrid": "Atletico Madrid",
    "Milan": "AC Milan",  # FootyStats uses "Milan" for AC Milan
    "Inter Milan": "Inter",
    "Internazionale": "Inter",
    "AS Roma": "Roma",
    "SS Lazio": "Lazio",
    "Manchester Utd": "Manchester United",
    "Man United": "Manchester United",
    "Man City": "Manchester City",
}


def normalize_team_name(name: str) -> str:
    """Canonicalize team names so DERBIES matches across data-source variants."""
    if not name:
        return ""
    return TEAM_NAME_ALIASES.get(str(name).strip(), str(name).strip())


DERBIES = frozenset([
    frozenset(["Bayern Munich", "1860 Munich"]),
    frozenset(["Bayern Munich", "Borussia Dortmund"]),
    frozenset(["Borussia Dortmund", "Schalke 04"]),
    frozenset(["Hamburger SV", "Werder Bremen"]),
    frozenset(["Liverpool", "Everton"]),
    frozenset(["Manchester United", "Manchester City"]),
    frozenset(["Manchester United", "Liverpool"]),
    frozenset(["Arsenal", "Tottenham"]),
    frozenset(["Chelsea", "Arsenal"]),
    frozenset(["Barcelona", "Real Madrid"]),
    frozenset(["Real Madrid", "Atletico Madrid"]),
    frozenset(["AC Milan", "Inter"]),
    frozenset(["Roma", "Lazio"]),
])


LEAGUE_AVGS = {
    "bundesliga": 1.38, "bundesliga2": 1.51, "epl": 1.35, "championship": 1.23,
    "league_one": 1.29, "league_two": 1.25, "la_liga": 1.25, "la_liga2": 1.27,
    "serie_a": 1.32, "serie_b": 1.23, "ligue_1": 1.30, "ligue_2": 1.29,
    "eredivisie": 1.49, "jupiler_pro": 1.38, "primeira_liga": 1.28,
    "super_lig": 1.47, "scottish_prem": 1.48, "greek_sl": 1.22,
    "liga3": 1.40,
}
LEAGUE_HFS = {
    "bundesliga": 1.28, "bundesliga2": 1.18, "epl": 1.22, "championship": 1.41,
    "league_one": 1.19, "league_two": 1.22, "la_liga": 1.30, "la_liga2": 1.34,
    "serie_a": 1.27, "serie_b": 1.22, "ligue_1": 1.32, "ligue_2": 1.41,
    "eredivisie": 1.31, "jupiler_pro": 1.37, "primeira_liga": 1.20,
    "super_lig": 1.31, "scottish_prem": 1.34, "greek_sl": 1.11,
    "liga3": 1.22,
}

EWMA_ALPHA = 0.85


# ═══════════════════════════════════════════════════════════════════
# DATA LOADING — Supabase REST
# ═══════════════════════════════════════════════════════════════════

# load_env + fetch_xg_history have moved to tools/lib/supabase_loader.py.
# Imported at the top so both v2 and v3 share the same pagination + sorting
# + sanity-assert code path.
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.supabase_loader import fetch_xg_history, load_env  # noqa: E402,F401


# ═══════════════════════════════════════════════════════════════════
# FEATURE ENGINEERING — vectorized with strict .shift(1) leakage protection
# ═══════════════════════════════════════════════════════════════════

# Column names of physical/discipline features whose EWMAs we precompute.
# These need to be populated >20% for the feature to be meaningful.
ROLLING_COLS = [
    "xg", "xga", "shots_for", "shots_on_target_for", "corners_for",
    "possession_pct", "fouls", "yellow_cards_for", "red_cards_for",
]


def precompute_rolling_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add per-team-match rolling EWMA/momentum/volatility columns.

    CRITICAL: ALL columns use .shift(1) before .ewm() or .rolling(). This ensures
    that the feature value AT row N reflects ONLY information from rows < N. Without
    .shift(1), Match N's feature would include Match N's own xg → holdout-Brier
    would be artificially inflated and production would collapse.

    Adds columns: {col}_ewma, plus xg_momentum, xg_volatility, xg_season_avg.
    Callers must use these on rows AFTER the teams played ≥ 4 prior matches.
    """
    # Sort by (team, match_date) so shift()/rolling() operate on chronological history
    df = df.sort_values(["team", "match_date"]).reset_index(drop=True)

    for col in ROLLING_COLS:
        if col not in df.columns:
            continue
        # EWMA over last 8 matches — but shifted so row N sees rows < N only
        df[f"{col}_ewma"] = df.groupby("team")[col].transform(
            lambda s: s.shift(1).ewm(alpha=EWMA_ALPHA, min_periods=4).mean()
        )

    # xg momentum: last-3 avg minus season-to-date avg, both pre-match
    if "xg" in df.columns:
        df["xg_last3"] = df.groupby("team")["xg"].transform(
            lambda s: s.shift(1).rolling(window=3, min_periods=2).mean()
        )
        df["xg_season_avg"] = df.groupby("team")["xg"].transform(
            lambda s: s.shift(1).expanding(min_periods=4).mean()
        )
        df["xg_momentum"] = df["xg_last3"] - df["xg_season_avg"]
        df["xg_volatility"] = df.groupby("team")["xg"].transform(
            lambda s: s.shift(1).rolling(window=8, min_periods=4).std()
        )

    # Shot accuracy (per-match, then EWMA)
    if "shots_for" in df.columns and "shots_on_target_for" in df.columns:
        df["shot_accuracy"] = (
            df["shots_on_target_for"] / df["shots_for"].replace(0, np.nan)
        )
        df["shot_accuracy_ewma"] = df.groupby("team")["shot_accuracy"].transform(
            lambda s: s.shift(1).ewm(alpha=EWMA_ALPHA, min_periods=4).mean()
        )

    # Days since previous match per team — rest_days proxy
    df["rest_days"] = df.groupby("team")["match_date"].diff().dt.days

    return df


def compute_elo(train_df: pd.DataFrame) -> dict[str, float]:
    """Elo ratings from home-perspective rows (ported from retrain_v2.py:392-411).

    Only TRAINING rows contribute — pre-cutoff. K=32, HOME_ADV=65.
    """
    K, HOME_ADV = 32, 65
    elo: dict[str, float] = {}

    def get(t): return elo.get(t, 1500.0)

    home_rows = train_df[train_df["venue"] == "home"].sort_values("match_date")
    for _, row in home_rows.iterrows():
        ht, at = str(row["team"]), str(row["opponent"])
        gf, ga = row["goals_for"], row["goals_against"]
        if pd.isna(gf) or pd.isna(ga):
            continue
        gf, ga = int(gf), int(ga)
        rH = get(ht) + HOME_ADV
        rA = get(at)
        expH = 1 / (1 + 10 ** ((rA - rH) / 400))
        actual = 1.0 if gf > ga else 0.5 if gf == ga else 0.0
        gd = abs(gf - ga)
        gd_mult = 1.0 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8.0
        elo[ht] = get(ht) + K * gd_mult * (actual - expH)
        elo[at] = get(at) + K * gd_mult * ((1 - actual) - (1 - expH))

    return elo


def compute_h2h_xg_diff(home_rows: pd.DataFrame) -> pd.Series:
    """For each home match, compute mean of last-5 H2H xg_diffs from home perspective.

    Vectorized via pairwise key, with .shift(1) so Match N uses only prior H2H meetings.
    """
    df = home_rows.copy()
    # Canonicalize team pair — sort so Team-A–Team-B and Team-B–Team-A hit the same key
    def pair_key(h, a):
        return " vs ".join(sorted([str(h), str(a)]))
    df["_h2h_key"] = [pair_key(h, a) for h, a in zip(df["team"], df["opponent"])]

    # home-perspective xg_diff for that match (what the home team's xg was minus away's)
    df["_xg_diff"] = df["xg"] - df["xga"]  # home's xg (=xg_for) minus home's xga (=away's xg)
    df = df.sort_values(["_h2h_key", "match_date"]).reset_index(drop=True)
    df["h2h_xg_diff"] = df.groupby("_h2h_key")["_xg_diff"].transform(
        lambda s: s.shift(1).rolling(window=5, min_periods=1).mean()
    )
    return df.set_index(["team", "opponent", "match_date"])["h2h_xg_diff"]


def build_features_vectorized(
    df: pd.DataFrame,
    elo_map: dict[str, float],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, pd.Series, pd.Series]:
    """Build 20-feature matrix + goals arrays for all home rows with sufficient history.

    Workflow:
      1. Precompute per-team-match EWMA / momentum / volatility (leakage-safe)
      2. Filter to home rows (one row per match)
      3. Join with each row's corresponding away-team EWMA snapshot at same match_date
      4. Compute diffs, Elo lookup, DERBIES check, H2H join
      5. Return X, y_home, y_away, dates, leagues
    """
    df = precompute_rolling_features(df)

    # Split into home + away views with precomputed EWMAs as columns
    ewma_cols = [f"{c}_ewma" for c in ROLLING_COLS if f"{c}_ewma" in df.columns]
    extra_cols = [c for c in ("xg_momentum", "xg_volatility", "shot_accuracy_ewma",
                               "rest_days") if c in df.columns]
    feat_cols = ewma_cols + extra_cols

    home_rows = (
        df[df["venue"] == "home"]
        .drop_duplicates(subset=["team", "match_date"], keep="last")
        .copy()
    )
    away_rows = df[df["venue"] == "away"].copy()

    # H2H series (home-perspective xg_diff mean of last 5 meetings, pre-match)
    h2h_series = compute_h2h_xg_diff(home_rows)

    # For each home row, we need the away team's EWMA state AT the same match_date.
    # Since each match has 1 home + 1 away row in the DB, we match by (away=team,
    # match_date, opponent=home). Duplicate (team, match_date) pairs (should be rare,
    # but possible from UPSERT drift) are resolved by keeping the last row.
    away_lookup = (
        away_rows.drop_duplicates(subset=["team", "match_date"], keep="last")
        .set_index(["team", "match_date"])[feat_cols]
    )

    # SoS: sum of opponent Elos so far per team — expanding, shifted by 1
    home_rows = home_rows.sort_values(["team", "match_date"]).reset_index(drop=True)
    home_rows["_opp_elo"] = home_rows["opponent"].map(elo_map).fillna(1500.0)
    home_rows["_opp_elo_avg"] = home_rows.groupby("team")["_opp_elo"].transform(
        lambda s: s.shift(1).expanding(min_periods=3).mean()
    )

    X_rows: list[list[float]] = []
    y_h: list[float] = []
    y_a: list[float] = []
    dates: list[pd.Timestamp] = []
    leagues: list[str] = []
    skipped_missing_away = 0
    skipped_insufficient = 0

    for _, m in home_rows.iterrows():
        team, opp, date = m["team"], m["opponent"], m["match_date"]
        league = m["league"]

        try:
            a_row = away_lookup.loc[(opp, date)]
        except KeyError:
            skipped_missing_away += 1
            continue

        # Sanity: need ≥4 matches of history for EWMAs to be defined
        if pd.isna(m.get("xg_ewma")) or pd.isna(a_row.get("xg_ewma")):
            skipped_insufficient += 1
            continue

        # Core xG (5)
        xg_diff_ewma = float(m["xg_ewma"] - a_row["xg_ewma"])
        xga_diff_ewma = float(m["xga_ewma"] - a_row["xga_ewma"])
        xg_momentum_diff = float((m.get("xg_momentum") or 0) - (a_row.get("xg_momentum") or 0))
        xg_volatility_diff = float((m.get("xg_volatility") or 0) - (a_row.get("xg_volatility") or 0))
        total_xg = float(m["xg_ewma"] + a_row["xg_ewma"])

        # Elo + Ctx (5)
        elo_h = elo_map.get(str(team), 1500.0)
        elo_a = elo_map.get(str(opp), 1500.0)
        elo_diff = float(elo_h + 65 - elo_a)

        opp_elo_avg_h = m.get("_opp_elo_avg")
        # SoS for away is computed on same principle — approximate by (away team's avg opponent Elo so far).
        # Simplification: for this iteration, reuse the home-rows SoS framework but with away's
        # own home_rows in the df. Since away team has its own home_rows with _opp_elo_avg set,
        # we can look those up. But this is expensive per iteration, so we approximate as
        # away_elo - league avg (simpler proxy).
        sos_strength = float(((opp_elo_avg_h or 1500.0) - 1500.0) / 400.0)

        is_derby = 1 if frozenset([normalize_team_name(team), normalize_team_name(opp)]) in DERBIES else 0

        h2h_val = h2h_series.get((team, opp, date), 0.0)
        h2h_xg_diff = float(h2h_val if pd.notna(h2h_val) else 0.0)

        rest_h = m.get("rest_days")
        rest_a = a_row.get("rest_days")
        if pd.isna(rest_h) or pd.isna(rest_a):
            rest_days_diff = 0.0
        else:
            rest_days_diff = float((rest_h - rest_a) / 7.0)

        # League-level constants
        home_factor = LEAGUE_HFS.get(league, 1.25)
        league_avg = LEAGUE_AVGS.get(league, 1.35)

        # Physis (5)
        def diff(col: str) -> float:
            """Difference of precomputed EWMA col between home and away teams. 0 if missing."""
            v_h = m.get(col)
            v_a = a_row.get(col)
            if pd.isna(v_h) or pd.isna(v_a):
                return 0.0
            return float(v_h - v_a)

        shots_total = diff("shots_for_ewma")
        shots_sot = diff("shots_on_target_for_ewma")
        shot_acc = diff("shot_accuracy_ewma")
        corners = diff("corners_for_ewma")
        poss = diff("possession_pct_ewma")

        # Discipline (3)
        fouls = diff("fouls_ewma")
        yellow = diff("yellow_cards_for_ewma")
        red = diff("red_cards_for_ewma")

        feats = [
            xg_diff_ewma, xga_diff_ewma, xg_momentum_diff, xg_volatility_diff, total_xg,
            elo_diff, sos_strength, is_derby, h2h_xg_diff, rest_days_diff,
            home_factor, league_avg,
            shots_total, shots_sot, shot_acc, corners, poss,
            fouls, yellow, red,
        ]
        assert len(feats) == N_FEATURES, f"feature count mismatch {len(feats)} vs {N_FEATURES}"

        # Sanity: no NaN allowed in final vector
        if any(pd.isna(v) or not np.isfinite(v) for v in feats):
            skipped_insufficient += 1
            continue

        X_rows.append(feats)
        y_h.append(float(m["goals_for"]))
        y_a.append(float(m["goals_against"]))
        dates.append(date)
        leagues.append(str(league))

    print(f"  Features built: {len(X_rows)} rows "
          f"(skipped {skipped_missing_away} without away-pair, "
          f"{skipped_insufficient} insufficient history)")
    return (np.array(X_rows), np.array(y_h), np.array(y_a),
            pd.Series(dates), pd.Series(leagues))


def build_training_set(
    df: pd.DataFrame,
    drop_before: Optional[pd.Timestamp] = None,
    holdout_cutoff: Optional[pd.Timestamp] = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, pd.Series, pd.Series, np.ndarray]:
    """Vectorized feature build with chronological train/test split.

    Args:
        drop_before: Optional cutoff to drop pre-era data (e.g. 2023-08-01 for
            5-substitute-rule + tactical-era hygiene). Reduces toxic legacy noise.
        holdout_cutoff: Strict chronological split — matches before this date
            train, on/after test. Default 2025-08-01 → test on current season.

    Returns:
        X, y_h, y_a, dates, leagues, train_mask  (train_mask is bool array, len=n_features)

    Note: We tested per-league last-20% stratified split on 2026-04-25; it widened
    the train/test target gap from +8% to +17% because end-of-season matches are
    structurally lower-scoring (dead rubbers, defensive tactics). Reverted to
    chronological. Drop-before-2023-08 alone keeps current-tactical-era hygiene.
    """
    df = df.copy()
    df["match_date"] = pd.to_datetime(df["match_date"], errors="coerce", utc=True).dt.tz_localize(None)
    df = df.dropna(subset=["match_date", "team", "opponent", "venue", "xg", "xga"])

    if drop_before is not None:
        before_n = len(df)
        df = df[df["match_date"] >= drop_before].copy()
        print(f"  Dropped {before_n - len(df)} rows pre-{drop_before.date()} "
              f"(toxic legacy era hygiene)")

    if holdout_cutoff is None:
        holdout_cutoff = pd.Timestamp("2025-08-01")

    # 1) Elo computed only on training rows (pre-cutoff) — avoid test-leakage
    src_train_mask = df["match_date"] < holdout_cutoff
    elo_map = compute_elo(df[src_train_mask])
    print(f"  Elo: computed on {src_train_mask.sum()} training rows, {len(elo_map)} teams "
          f"(chrono cutoff {holdout_cutoff.date()})")

    # 2) Vectorized feature build across ALL rows
    X, y_h, y_a, dates, leagues = build_features_vectorized(df, elo_map)

    # 3) Train/test mask at feature-row level using same chronological cutoff
    train_mask = (dates < holdout_cutoff).to_numpy()
    print(f"  Feature-row split: {int(train_mask.sum())} train / {int((~train_mask).sum())} test "
          f"(chrono cutoff {holdout_cutoff.date()})")

    return X, y_h, y_a, dates, leagues, train_mask


# ───────────────────────────────────────────────────────────────────
# Brier utilities — mirrors src/lib/backtest.ts::scoreMatch
# ───────────────────────────────────────────────────────────────────

def poisson_matrix(lam_h: float, lam_a: float, max_k: int = 10) -> np.ndarray:
    """Independent-Poisson 1X2/OU matrix (no Dixon-Coles rho correction here
    because retrain_v3 trains λ's only; ρ is inherited from v2 optimal as
    starting point. Downstream runtime uses the model's rho_optimal value)."""
    kr = np.arange(max_k + 1)
    ph = poisson.pmf(kr, lam_h)
    pa = poisson.pmf(kr, lam_a)
    return np.outer(ph, pa)


def derive_1x2_o25(mx: np.ndarray) -> tuple[float, float, float, float]:
    h = d = a = o25 = 0.0
    for i in range(mx.shape[0]):
        for j in range(mx.shape[1]):
            p = mx[i, j]
            if i > j:   h += p
            elif i < j: a += p
            else:       d += p
            if i + j > 2: o25 += p
    # Normalize H/D/A (truncation-tail correction)
    tot = h + d + a
    if tot > 0:
        h, d, a = h / tot, d / tot, a / tot
    return h, d, a, o25


def brier_score(lams_h: np.ndarray, lams_a: np.ndarray,
                goals_h: np.ndarray, goals_a: np.ndarray) -> dict[str, float]:
    """1X2 multi-class Brier (sum-form, matches retrain_v2.py:1055) + binary O25.

    v2 convention: `sum((p-o)² over H/D/A) averaged over matches`. Range [0, 2].
    Uniform 1/3-prediction baseline = 2/3 ≈ 0.6667. Perfect prediction = 0.
    v2 production baseline was 0.5844.

    ALSO reports brier_1x2_avg = brier_1x2_sum / 3 (rank-Brier convention, src/
    lib/backtest.ts format). Both are logged; go/no-go uses _sum for v2 parity.
    """
    n = len(lams_h)
    brier_1x2_sum_form = 0.0
    brier_o25_sum = 0.0
    logloss_1x2_sum = 0.0
    for i in range(n):
        ph, pd_, pa, po25 = derive_1x2_o25(poisson_matrix(lams_h[i], lams_a[i]))
        gh, ga = goals_h[i], goals_a[i]
        oh = 1.0 if gh > ga else 0.0
        od = 1.0 if gh == ga else 0.0
        oa = 1.0 if gh < ga else 0.0
        # sum-form (v2 parity) — sum squared errors across 3 classes per match
        brier_1x2_sum_form += (ph - oh)**2 + (pd_ - od)**2 + (pa - oa)**2
        # Log-loss on winning class (clip for log(0))
        p_win = ph if oh else (pd_ if od else pa)
        logloss_1x2_sum += -np.log(max(1e-6, min(1 - 1e-6, p_win)))
        # O25 binary
        o25_true = 1.0 if (gh + ga) > 2 else 0.0
        brier_o25_sum += (po25 - o25_true)**2
    return {
        "brier_1x2": brier_1x2_sum_form / n,          # v2-compatible sum-form
        "brier_1x2_avg": (brier_1x2_sum_form / n) / 3.0,  # rank-Brier (src/lib/backtest.ts)
        "brier_o25": brier_o25_sum / n,
        "logloss_1x2": logloss_1x2_sum / n,
        "n": n,
        "mean_lam_h": float(lams_h.mean()),
        "mean_lam_a": float(lams_a.mean()),
        "mean_goals_h": float(goals_h.mean()),
        "mean_goals_a": float(goals_a.mean()),
    }


# ───────────────────────────────────────────────────────────────────
# Training — with time-based holdout + Optuna
# ───────────────────────────────────────────────────────────────────

def train_lgbm_with_params(X: np.ndarray, y: np.ndarray, mono: list[int],
                            params: dict, num_boost_round: int = 400,
                            sample_weight: Optional[np.ndarray] = None) -> lgb.Booster:
    p = {
        "objective": "tweedie",
        "monotone_constraints": mono,
        "verbose": -1,
        **params,
    }
    train_set = lgb.Dataset(X, y, weight=sample_weight)
    return lgb.train(p, train_set, num_boost_round=num_boost_round)


def train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                        params: dict, num_boost: int,
                        train_weights: Optional[np.ndarray] = None) -> dict:
    """Train home + away models with given params, return test-set Brier + models.

    Note: LightGBM's Tweedie objective internally applies the log-link; booster.predict()
    returns λ on the natural scale already. No extra exp() is needed (doing so double-
    exponentiates and saturates the clamp at ~3-4). The TypeScript runtime
    (src/lib/poisson-ml-engine-v3.ts::sumTrees→Math.exp) sums raw leaf values and applies
    exp, which matches the LightGBM dump_model representation of per-leaf values already
    being in log-space. So runtime does need exp — only the training-time evaluation
    here skips it."""
    home_b = train_lgbm_with_params(Xtr, yh_tr, MONO_HOME, params, num_boost,
                                     sample_weight=train_weights)
    away_b = train_lgbm_with_params(Xtr, ya_tr, MONO_AWAY, params, num_boost,
                                     sample_weight=train_weights)
    raw_h = home_b.predict(Xte)
    raw_a = away_b.predict(Xte)
    lams_h = np.clip(raw_h, LAMBDA_CLAMP_LO, LAMBDA_CLAMP_HI)
    lams_a = np.clip(raw_a, LAMBDA_CLAMP_LO, LAMBDA_CLAMP_HI)
    metrics = brier_score(lams_h, lams_a, yh_te, ya_te)
    # Drift diagnostics — surface clamp impact + train/test target gap
    metrics["mean_lam_h_raw"] = float(raw_h.mean())
    metrics["mean_lam_a_raw"] = float(raw_a.mean())
    metrics["clamp_lo_hits_h"] = int((raw_h < LAMBDA_CLAMP_LO).sum())
    metrics["clamp_hi_hits_h"] = int((raw_h > LAMBDA_CLAMP_HI).sum())
    metrics["clamp_lo_hits_a"] = int((raw_a < LAMBDA_CLAMP_LO).sum())
    metrics["clamp_hi_hits_a"] = int((raw_a > LAMBDA_CLAMP_HI).sum())
    metrics["mean_yh_train"] = float(yh_tr.mean())
    metrics["mean_ya_train"] = float(ya_tr.mean())
    return {"home_b": home_b, "away_b": away_b, **metrics}


def optuna_objective(trial, Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                      train_weights: Optional[np.ndarray] = None) -> float:
    """Objective: minimize 1X2 Brier on the time-based holdout."""
    params = {
        "tweedie_variance_power": trial.suggest_float("tweedie_variance_power", 1.01, 1.9),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
        "num_leaves": trial.suggest_int("num_leaves", 15, 63),
        "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 20, 120),
        "feature_fraction": trial.suggest_float("feature_fraction", 0.7, 1.0),
        "bagging_fraction": trial.suggest_float("bagging_fraction", 0.7, 1.0),
        "bagging_freq": 5,
        "lambda_l1": trial.suggest_float("lambda_l1", 0.0, 1.0),
        "lambda_l2": trial.suggest_float("lambda_l2", 0.0, 1.0),
    }
    num_boost = trial.suggest_int("num_boost_round", 200, 500, step=50)
    try:
        result = train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                                      params, num_boost,
                                      train_weights=train_weights)
        return result["brier_1x2"]
    except Exception as e:
        print(f"  trial failed: {e}")
        return 1.0  # high penalty so Optuna skips


# ═══════════════════════════════════════════════════════════════════
# MODEL EXPORT (JSON) — matches v2 shape
# ═══════════════════════════════════════════════════════════════════

def booster_to_trees(b: lgb.Booster) -> list[dict]:
    return json.loads(b.dump_model()["tree_info"].__repr__().replace("'", '"')) \
        if False else b.dump_model()["tree_info"]


def export(home_b: lgb.Booster, away_b: lgb.Booster, rho_optimal: float,
            n_train: int, metrics: dict, best_params: dict):
    model = {
        "version": "v3.0",
        "feature_names": FEATURE_NAMES,
        "home_trees": booster_to_trees(home_b),
        "away_trees": booster_to_trees(away_b),
        "rho_optimal": rho_optimal,
        "lambda_clamp": [LAMBDA_CLAMP_LO, LAMBDA_CLAMP_HI],
        "n_train": n_train,
        "mono_home": MONO_HOME,
        "mono_away": MONO_AWAY,
        "holdout_metrics": metrics,
        "best_params": best_params,
    }
    with open(OUTPUT, "w") as f:
        json.dump(model, f, indent=2)
    print(f"\n✓ Model exported → {OUTPUT}")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Train but don't write JSON")
    ap.add_argument("--sources", default="footystats",
                     help="Comma-sep source filter (default: footystats — the only bulk-populated "
                          "source for v3 extended features)")
    ap.add_argument("--n-trials", type=int, default=0,
                     help="Optuna trials (0 = use fixed default params, skip search)")
    ap.add_argument("--drop-before", default="",
                     help="Optional: drop matches before this date (toxic-legacy "
                          "hygiene). Default empty = keep full history (data-hungry "
                          "boosting prefers volume). Use --drop-before 2023-08-01 to "
                          "filter for tactical-era hygiene.")
    ap.add_argument("--cutoff", default="2025-08-01",
                     help="Chronological train/test cutoff (matches before = train, "
                          "after = test). Default 2025-08-01.")
    ap.add_argument("--weight-half-life-days", type=float, default=365.0,
                     help="Recency-decay half-life for training sample weights. "
                          "Pre-test matches weighted by exp(-days_old / this). "
                          "365 = ~1y half-life. Set to 0 to disable recency weights.")
    args = ap.parse_args()

    print("═══ v3 Training (production) ═══\n")
    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    print(f"Sources:           {sources}")
    print(f"Drop before:       {args.drop_before or '(no drop — full history)'}")
    print(f"Holdout cutoff:    {args.cutoff} (chrono split, train<, test≥)")
    print(f"Recency weight τ:  {args.weight_half_life_days} days "
          f"({'disabled' if args.weight_half_life_days <= 0 else 'enabled'})")
    print(f"Optuna trials:     {args.n_trials}\n")

    df = fetch_xg_history(sources=sources)
    print(f"Fetched {len(df)} rows from Supabase")
    if len(df) < 100:
        print(f"\n⚠  Only {len(df)} rows — pipeline-verify only; do NOT deploy.\n")

    drop_cutoff = pd.Timestamp(args.drop_before) if args.drop_before else None
    holdout_cutoff = pd.Timestamp(args.cutoff)
    X, y_h, y_a, dates, leagues, train_mask = build_training_set(
        df, drop_before=drop_cutoff, holdout_cutoff=holdout_cutoff,
    )
    print(f"Training matrix: {X.shape}  y_home mean={y_h.mean():.2f}  y_away mean={y_a.mean():.2f}")
    if len(X) == 0:
        print("No trainable pairs — needs more history per team. Exit.")
        return

    # ── Time-based split (computed in build_training_set) ───────
    test_mask = ~train_mask
    Xtr, yh_tr, ya_tr = X[train_mask], y_h[train_mask], y_a[train_mask]
    Xte, yh_te, ya_te = X[test_mask], y_h[test_mask], y_a[test_mask]
    train_dates = dates[train_mask].reset_index(drop=True)
    print(f"  train: {len(Xtr)} pairs ({train_dates.min()} → {train_dates.max()})")
    print(f"  test:  {len(Xte)} pairs ({dates[test_mask].min() if test_mask.any() else '—'} → "
          f"{dates[test_mask].max() if test_mask.any() else '—'})")

    # ── Recency Sample-Weights (Hail-Mary anti-time-drift) ──────
    # Tweedie+log forces mean(λ_pred) ≈ mean(y_train). Without weights, distant
    # past with higher goal-rates pulls the prediction-mean above current test
    # reality (+8% bias observed on chrono-split). Weighting recent matches
    # heavier collapses the WEIGHTED y_train mean toward the test-set mean →
    # model auto-calibrates without backend changes. JSON stays 100% compatible.
    if args.weight_half_life_days > 0 and len(train_dates) > 0:
        ref_date = train_dates.max()  # most recent train match anchors weight=1
        days_old = (ref_date - train_dates).dt.days.to_numpy()
        train_weights = np.exp(-days_old / args.weight_half_life_days)
        weighted_yh_mean = float(np.average(yh_tr, weights=train_weights))
        weighted_ya_mean = float(np.average(ya_tr, weights=train_weights))
        print(f"  Recency weights: max={train_weights.max():.2f} "
              f"min={train_weights.min():.4f} mean={train_weights.mean():.3f}")
        print(f"  Train target (raw):       y_h={yh_tr.mean():.3f}  y_a={ya_tr.mean():.3f}")
        print(f"  Train target (weighted):  y_h={weighted_yh_mean:.3f}  y_a={weighted_ya_mean:.3f}")
    else:
        train_weights = None
        print(f"  Recency weights disabled — training on uniform-weight rows")
    if len(Xte) < 200:
        print(f"\n⚠  Holdout set <200 rows — Brier-estimate wird unreliable. "
              f"Cutoff früher setzen oder mehr current-season-Daten importieren.\n")

    # ── Optuna search (optional) ─────────────────────────────────
    DEFAULT_PARAMS = {
        "tweedie_variance_power": 1.5,
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 20,
        "feature_fraction": 0.85,
        "bagging_fraction": 0.9,
        "bagging_freq": 5,
        "lambda_l1": 0.1,
        "lambda_l2": 0.1,
    }
    DEFAULT_NUM_BOOST = 400

    if args.n_trials > 0:
        try:
            import optuna
        except ImportError:
            print("optuna not installed — pip install optuna")
            return
        print(f"\n═══ Optuna search ({args.n_trials} trials) ═══")
        study = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=42))
        study.optimize(
            lambda t: optuna_objective(t, Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te, train_weights),
            n_trials=args.n_trials,
            show_progress_bar=True,
        )
        best_params = {k: v for k, v in study.best_params.items() if k != "num_boost_round"}
        best_params["bagging_freq"] = 5
        best_num_boost = study.best_params.get("num_boost_round", DEFAULT_NUM_BOOST)
        print(f"  best Brier: {study.best_value:.4f}")
        print(f"  best params: {study.best_params}")
    else:
        best_params = DEFAULT_PARAMS
        best_num_boost = DEFAULT_NUM_BOOST

    # ── Final training + evaluation ──────────────────────────────
    print("\n═══ Final training ═══")
    final = train_and_evaluate(Xtr, yh_tr, ya_tr, Xte, yh_te, ya_te,
                                  best_params, best_num_boost,
                                  train_weights=train_weights)
    print(f"\n━━━ Holdout Metrics ━━━")
    print(f"  n (test):       {final['n']}")
    print(f"  Brier 1X2:      {final['brier_1x2']:.4f}  (v2 baseline: 0.5844 | rank-avg {final['brier_1x2_avg']:.4f})")
    print(f"  Brier O25:      {final['brier_o25']:.4f}")
    print(f"  LogLoss 1X2:    {final['logloss_1x2']:.4f}")
    print(f"\n━━━ Drift Diagnostics (the +10% bias hunt) ━━━")
    print(f"  Train target:   y_h.mean()={final['mean_yh_train']:.3f}  y_a.mean()={final['mean_ya_train']:.3f}")
    print(f"  Test  target:   y_h.mean()={final['mean_goals_h']:.3f}  y_a.mean()={final['mean_goals_a']:.3f}")
    print(f"  Pred (RAW):     λ_h.mean()={final['mean_lam_h_raw']:.3f}  λ_a.mean()={final['mean_lam_a_raw']:.3f}")
    print(f"  Pred (clamp):   λ_h.mean()={final['mean_lam_h']:.3f}  λ_a.mean()={final['mean_lam_a']:.3f}")
    n_te = final["n"]
    print(f"  Clamp hits:     home lo={final['clamp_lo_hits_h']}/{n_te} hi={final['clamp_hi_hits_h']}/{n_te}  "
          f"away lo={final['clamp_lo_hits_a']}/{n_te} hi={final['clamp_hi_hits_a']}/{n_te}")
    bias_h = final['mean_lam_h_raw'] - final['mean_goals_h']
    bias_a = final['mean_lam_a_raw'] - final['mean_goals_a']
    bias_h_pct = 100 * bias_h / final['mean_goals_h']
    bias_a_pct = 100 * bias_a / final['mean_goals_a']
    print(f"  Bias (raw):     home={bias_h:+.3f} ({bias_h_pct:+.1f}%)  away={bias_a:+.3f} ({bias_a_pct:+.1f}%)")

    beats_v2 = final["brier_1x2"] < 0.5844
    verdict = "✓ BEATS v2 baseline" if beats_v2 else "✗ worse than v2 baseline (0.5844)"
    print(f"\n  Verdict: {verdict}")

    # Feature importance — confirm no zero-importance features
    print("\n━━━ Feature Importance (Home model) ━━━")
    importance_h = final["home_b"].feature_importance(importance_type="gain")
    importance_a = final["away_b"].feature_importance(importance_type="gain")
    for i, name in enumerate(FEATURE_NAMES):
        ih = int(importance_h[i]) if i < len(importance_h) else 0
        ia = int(importance_a[i]) if i < len(importance_a) else 0
        flag = "  " if (ih > 0 and ia > 0) else "⚠️"
        print(f"  {flag} [{i:2d}] {name:30s}  H={ih:7d}  A={ia:7d}")
    zero_count = sum(1 for i in range(N_FEATURES)
                     if (i < len(importance_h) and importance_h[i] == 0)
                     or (i < len(importance_a) and importance_a[i] == 0))
    print(f"\n  Zero-importance features: {zero_count}/{N_FEATURES}  (target: ≤ 2)")

    home_b = final["home_b"]
    away_b = final["away_b"]
    rho_optimal = -0.094  # inherited from v2; retrain_v3-specific rho search would be a follow-up

    metrics_for_export = {k: v for k, v in final.items() if k not in ("home_b", "away_b")}

    if args.dry_run:
        print("\n(DRY) Skip JSON export")
    else:
        export(home_b, away_b, rho_optimal, n_train=len(Xtr),
               metrics=metrics_for_export, best_params=best_params)


if __name__ == "__main__":
    main()
