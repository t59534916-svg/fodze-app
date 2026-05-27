"""sofa_context — Sofa-native orthogonal context features for dev-09.

Per FODZE-Optimal-Blueprint audit committee: `elo_diff` and `rest_days_diff`
are "orthogonal context, not dev-03-specific". These features are computed
PURELY from sofascore_match results (NOT from team_xg_history + dev-03's
EloCalculator). Keeps dev-09 strictly TABULA RASA.

Both functions produce per-(game_id, side) lookup dicts. Layer-3 rows
(bottom_up_available=0) USE these features — they provide the only signal
when lineups are unknown.

Leakage contract: identical to BottomUpCalculator — chronological iteration
with strict pre-match-only lookups. The pre-match Elo/rest at game G is
computed using ONLY matches before G (per-team chronological state).
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import pandas as pd

# Elo hyperparameters (industry-standard; not tuned)
ELO_BASE = 1500.0
ELO_K = 20.0  # K-factor — sensitivity to single match outcome
ELO_HOME_ADVANTAGE = 70.0  # ≈ 100 Elo ≈ 65% expected outcome, tuned for soccer
REST_DAYS_MAX = 60.0  # cap to prevent huge gaps (e.g., season break) dominating signal


def compute_sofa_context(
    sqlite_path: Path,
) -> Tuple[Dict[Tuple[int, bool], float], Dict[Tuple[int, bool], float]]:
    """Compute pre-match Elo + days-since-last-match per (game_id, is_home).

    Args:
        sqlite_path: path to local_extras.db (sofascore_match table)

    Returns:
        (elo_lookup, rest_days_lookup) where each dict maps (game_id, is_home_bool)
        to a float. is_home_bool: True for home team, False for away.

    Algorithm:
        - Iterate matches in chronological order (ORDER BY start_timestamp)
        - For each match: read pre-match Elo of both teams (from running state)
        - Compute expected outcome via Elo formula + home advantage
        - Apply K-factor update based on actual result
        - Track per-team last-match timestamp → rest days

    Leakage-safe: pre-match state recorded BEFORE applying current match's update.
    """
    con = sqlite3.connect(str(sqlite_path))
    cur = con.cursor()
    cur.execute("""
        SELECT game_id, home_team_id, away_team_id, home_score, away_score, start_timestamp
        FROM sofascore_match
        WHERE home_score IS NOT NULL AND away_score IS NOT NULL
        ORDER BY start_timestamp, game_id
    """)
    rows = cur.fetchall()
    con.close()

    elo_state: Dict[int, float] = defaultdict(lambda: ELO_BASE)
    last_ts: Dict[int, int] = {}  # team_id → last start_timestamp seen

    elo_lookup: Dict[Tuple[int, bool], float] = {}
    rest_days_lookup: Dict[Tuple[int, bool], float] = {}

    for gid, h_id, a_id, h_score, a_score, ts in rows:
        # Pre-match state (RECORD FIRST — no leakage)
        h_elo = elo_state[h_id]
        a_elo = elo_state[a_id]
        elo_lookup[(int(gid), True)] = h_elo
        elo_lookup[(int(gid), False)] = a_elo

        h_rest = (ts - last_ts[h_id]) / 86400 if h_id in last_ts else REST_DAYS_MAX
        a_rest = (ts - last_ts[a_id]) / 86400 if a_id in last_ts else REST_DAYS_MAX
        # Cap at REST_DAYS_MAX (big gaps = season break, not signal-relevant)
        rest_days_lookup[(int(gid), True)] = min(h_rest, REST_DAYS_MAX)
        rest_days_lookup[(int(gid), False)] = min(a_rest, REST_DAYS_MAX)

        # Now apply the match's update
        # Expected home win probability (Elo formula with home advantage)
        expected_h = 1.0 / (1.0 + 10 ** ((a_elo - h_elo - ELO_HOME_ADVANTAGE) / 400.0))

        if h_score > a_score:
            actual_h = 1.0
        elif h_score < a_score:
            actual_h = 0.0
        else:
            actual_h = 0.5

        update = ELO_K * (actual_h - expected_h)
        elo_state[h_id] = h_elo + update
        elo_state[a_id] = a_elo - update

        last_ts[h_id] = ts
        last_ts[a_id] = ts

    return elo_lookup, rest_days_lookup


def stats_for_context(
    elo_lookup: Dict[Tuple[int, bool], float],
    rest_lookup: Dict[Tuple[int, bool], float],
) -> dict:
    """Diagnostic stats for sanity-checking computed context."""
    elos = list(elo_lookup.values())
    rests = list(rest_lookup.values())
    return {
        "n_elo_entries": len(elos),
        "elo_mean": float(np.mean(elos)) if elos else None,
        "elo_std": float(np.std(elos)) if elos else None,
        "elo_min": float(np.min(elos)) if elos else None,
        "elo_max": float(np.max(elos)) if elos else None,
        "n_rest_entries": len(rests),
        "rest_mean": float(np.mean(rests)) if rests else None,
        "rest_max_cap_pct": float(np.mean([r >= REST_DAYS_MAX - 0.01 for r in rests]) * 100) if rests else None,
    }
