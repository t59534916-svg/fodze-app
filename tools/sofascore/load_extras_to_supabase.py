#!/usr/bin/env python3
"""
FODZE — load Sofascore post-match extras JSONs into Supabase.

Reads `tools/sofascore/data/extras/<game_id>.json` files produced by
fetch_match_extras.py and bulk-inserts via PostgREST.

Tables hit:
  sofascore_match_statistics    PK (game_id, is_home, period)
  sofascore_player_match_stats  PK (game_id, player_id)
  sofascore_incidents           PK (game_id, incident_idx)
  sofascore_average_positions   PK (game_id, player_id)
  sofascore_extras_state        PK (game_id) — sync-state tracker

All idempotent via UNIQUE constraints + on_conflict=resolution=merge-duplicates.

Usage:
  # All cached files
  python3 tools/sofascore/load_extras_to_supabase.py --all

  # Single game
  python3 tools/sofascore/load_extras_to_supabase.py --game-id 13037021

  # Dry-run (count what would be inserted, no write)
  python3 tools/sofascore/load_extras_to_supabase.py --all --dry
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "tools" / "sofascore" / "data" / "extras"


def load_env():
    env_path = REPO_ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


load_env()
SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not SUPA_URL or not SUPA_KEY:
    print("ERROR: missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local", file=sys.stderr)
    sys.exit(1)


# ─── Generic helpers ───────────────────────────────────────────────

def is_real(v) -> bool:
    if v is None:
        return False
    if isinstance(v, float) and math.isnan(v):
        return False
    return True


def to_int(v) -> int | None:
    if not is_real(v):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def to_real(v) -> float | None:
    if not is_real(v):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_pct(s: Any) -> float | None:
    """`"54%"` → 54.0;  `0.54` → 54.0; `"54"` → 54.0."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        f = float(s)
        return f * 100 if f <= 1.0 else f
    if isinstance(s, str):
        s = s.strip().rstrip("%")
        try:
            return float(s)
        except ValueError:
            return None
    return None


_FRAC_RE = re.compile(r"^\s*(\d+)\s*/\s*(\d+)")


def parse_fraction(s: Any) -> tuple[int | None, int | None]:
    """`"412/489"` → (412, 489); `"412/489 (84%)"` → (412, 489); `412` → (412, None)."""
    if isinstance(s, (int, float)):
        return int(s), None
    if isinstance(s, str):
        m = _FRAC_RE.match(s)
        if m:
            return int(m.group(1)), int(m.group(2))
        try:
            return int(s.split()[0].replace(",", "")), None
        except (ValueError, IndexError):
            return None, None
    return None, None


def parse_simple(v: Any) -> int | None:
    """Best-effort parse for stat values that come as int OR `"7"` OR `"7 (3)"`."""
    if isinstance(v, (int, float)):
        return int(v) if is_real(v) else None
    if isinstance(v, str):
        m = re.match(r"^\s*(\d+)", v)
        return int(m.group(1)) if m else None
    return None


# ─── /statistics → sofascore_match_statistics ──────────────────────

# Mapping: Sofascore stat-name → (column, parser) for value field
# Three parser kinds: 'pct' (parse "54%"), 'frac' (returns "X/Y"), 'simple' (int).
# For 'frac' stats we map TWO columns (made, attempted, optionally pct).

STAT_NAME_MAP: dict[str, tuple[str, str]] = {
    "Ball possession":        ("ball_possession_pct", "pct"),
    "Expected goals":         ("expected_goals", "real"),
    "Big chances":            ("big_chances", "simple"),
    "Big chances missed":     ("big_chances_missed", "simple"),
    "Big chances scored":     ("_skip_", "simple"),  # absorbed in raw_extras
    "Total shots":            ("total_shots", "simple"),
    "Shots on target":        ("shots_on_target", "simple"),
    "Shots off target":       ("shots_off_target", "simple"),
    "Blocked shots":          ("blocked_shots", "simple"),
    "Shots inside box":       ("shots_inside_box", "simple"),
    "Shots outside box":      ("shots_outside_box", "simple"),
    "Hit woodwork":           ("hit_woodwork", "simple"),
    "Corner kicks":           ("corner_kicks", "simple"),
    "Free kicks":             ("free_kicks", "simple"),
    "Offsides":               ("offsides", "simple"),
    "Goalkeeper saves":       ("goalkeeper_saves", "simple"),
    "Total saves":            ("goalkeeper_saves", "simple"),  # alt name in Goalkeeping group
    "Saves inside the box":   ("goalkeeper_saves_inside_box", "simple"),
    "Goals prevented":        ("goals_prevented", "real"),
    # Passes — Sofascore returns these as separate simple stats (NOT a fraction)
    "Passes":                 ("passes_total", "simple"),
    "Accurate passes":        ("passes_accurate", "simple"),
    # Tackles — same: separate stats, not fraction
    "Total tackles":          ("tackles_total", "simple"),
    "Tackles":                ("tackles_total", "simple"),  # appears in Match overview group
    # Tackles won is given as PCT, derive count later from total × pct
    "Tackles won":            ("_tackles_won_pct_", "pct"),
    "Interceptions":          ("interceptions", "simple"),
    "Recoveries":             ("recoveries", "simple"),
    "Clearances":             ("clearances", "simple"),
    "Errors lead to a shot":  ("errors_lead_to_shot", "simple"),
    "Errors lead to a goal":  ("errors_lead_to_goal", "simple"),
    # Legacy/alt forms (defensive — different leagues sometimes drop the article)
    "Errors lead to shot":    ("errors_lead_to_shot", "simple"),
    "Errors lead to goal":    ("errors_lead_to_goal", "simple"),
    "Fouls":                  ("fouls", "simple"),
    "Yellow cards":           ("yellow_cards", "simple"),
    "Red cards":              ("red_cards", "simple"),
    # Duels — Sofascore returns this as a single "duel-win share" pct, not totals.
    # Keep it as raw_extras since our schema expects counts; ground/aerial/dribbles
    # below give us the actual duel counts already.
    "Duels":                  ("_skip_", "simple"),
}

# Fraction-style stats: home/away come as "X/Y" or "X/Y (Z%)"
STAT_FRAC_MAP: dict[str, tuple[str, str, str | None]] = {
    # name → (made_col, total_col, pct_col)
    "Long balls":      ("long_balls_accurate", "long_balls_total", None),
    "Crosses":         ("crosses_accurate",    "crosses_total",    None),
    "Ground duels":    ("ground_duels_won",    "ground_duels_total", None),
    "Aerial duels":    ("aerial_duels_won",    "aerial_duels_total", None),
    "Dribbles":        ("dribbles_won",        "dribbles_attempted", None),
}


def project_match_stats(stats_json: dict, game_id: int) -> list[dict]:
    """Returns up to 6 rows: 2 sides × 3 periods (ALL/1ST/2ND)."""
    if not stats_json:
        return []
    statistics = stats_json.get("statistics", [])
    rows: list[dict] = []

    for period_block in statistics:
        period = period_block.get("period", "ALL")
        groups = period_block.get("groups", [])

        home_row = {"game_id": game_id, "is_home": True,  "period": period, "raw_extras": {}}
        away_row = {"game_id": game_id, "is_home": False, "period": period, "raw_extras": {}}

        for grp in groups:
            for item in grp.get("statisticsItems", []):
                name = item.get("name") or ""
                hv = item.get("home")
                av = item.get("away")

                if name in STAT_NAME_MAP:
                    col, kind = STAT_NAME_MAP[name]
                    if col == "_skip_":
                        home_row["raw_extras"][name] = {"home": hv, "away": av}
                        continue
                    if kind == "pct":
                        home_row[col] = parse_pct(hv)
                        away_row[col] = parse_pct(av)
                    elif kind == "real":
                        home_row[col] = to_real(hv)
                        away_row[col] = to_real(av)
                    else:  # simple
                        home_row[col] = parse_simple(hv)
                        away_row[col] = parse_simple(av)
                elif name in STAT_FRAC_MAP:
                    made_col, tot_col, pct_col = STAT_FRAC_MAP[name]
                    h_made, h_tot = parse_fraction(hv)
                    a_made, a_tot = parse_fraction(av)
                    if h_made is not None: home_row[made_col] = h_made
                    if h_tot  is not None: home_row[tot_col]  = h_tot
                    if a_made is not None: away_row[made_col] = a_made
                    if a_tot  is not None: away_row[tot_col]  = a_tot
                    if pct_col and h_made and h_tot:
                        home_row[pct_col] = round(100.0 * h_made / h_tot, 1)
                    if pct_col and a_made and a_tot:
                        away_row[pct_col] = round(100.0 * a_made / a_tot, 1)
                else:
                    # Unknown stat — preserve in raw_extras
                    home_row["raw_extras"][name] = {"home": hv, "away": av}

        # Derive tackles_won from tackles_total × tackles_won_pct (Sofascore
        # gives them as separate stats: total count + win-rate percent).
        # Also derive pass_accuracy_pct since `Passes` + `Accurate passes`
        # are returned as separate simple ints (no fraction), so the FRAC
        # path that normally computes the pct doesn't run.
        for row in (home_row, away_row):
            tot = row.get("tackles_total")
            pct = row.pop("_tackles_won_pct_", None)
            if tot is not None and pct is not None:
                row["tackles_won"] = round(tot * pct / 100.0)
            ptot = row.get("passes_total")
            pacc = row.get("passes_accurate")
            if ptot and pacc:
                row["pass_accuracy_pct"] = round(100.0 * pacc / ptot, 1)

        # Don't store empty raw_extras (saves bytes)
        if not home_row["raw_extras"]:
            home_row["raw_extras"] = None
        if not away_row["raw_extras"]:
            away_row["raw_extras"] = None
        # Store same raw_extras on both sides for forensics? — skip on away to dedupe
        away_row["raw_extras"] = None

        rows.append(home_row)
        rows.append(away_row)

    return rows


# ─── /lineups → sofascore_player_match_stats ───────────────────────

# Per-player stat field name in Sofascore → DB column
# (Sofascore wraps these in player.statistics{} object)
PLAYER_STAT_MAP: dict[str, str] = {
    "rating":                       "rating",
    "minutesPlayed":                "minutes_played",
    "goals":                        "goals",
    "goalAssist":                   "assists",
    "expectedGoals":                "expected_goals",
    "expectedAssists":              "expected_assists",
    "totalScoringAttempt":          "shots_total",
    "onTargetScoringAttempt":       "shots_on_target",
    "shotOffTarget":                "shots_off_target",
    "blockedScoringAttempt":        "shots_blocked",
    "totalPass":                    "passes_total",
    "accuratePass":                 "passes_accurate",
    "keyPass":                      "key_passes",
    "totalLongBalls":               "long_balls_total",
    "accurateLongBalls":            "long_balls_accurate",
    "totalCross":                   "crosses_total",
    "accurateCross":                "crosses_accurate",
    "touches":                      "touches",
    # touches_in_box — comes from heatmaps, not lineups; leave NULL
    "wonContest":                   "dribbles_won",
    "totalContest":                 "dribbles_attempted",
    "dispossessed":                 "was_dispossessed",
    "wonTackle":                    "tackles_won",
    "interceptionWon":              "interceptions",
    "totalClearance":               "clearances",
    "duelWon":                      "duels_won",
    "aerialWon":                    "aerial_duels_won",
    "outfielderBlock":              "blocks",
    "fouls":                        "fouls_committed",
    "wasFouled":                    "fouls_drawn",
    "saves":                        "saves",
    "savedShotsFromInsideTheBox":   "saves_inside_box",
    "goalsPrevented":               "_skip_",  # GK only, captured in raw_extras
}


def _sum_duels(stats: dict) -> int | None:
    """Sofascore gives wonDuel + lostDuel separately. Sum for total."""
    won = stats.get("duelWon")
    lost = stats.get("duelLost")
    if won is not None and lost is not None:
        return int(won) + int(lost)
    return None


def _sum_aerials(stats: dict) -> int | None:
    won = stats.get("aerialWon")
    lost = stats.get("aerialLost")
    if won is not None and lost is not None:
        return int(won) + int(lost)
    return None


def project_player_stats(lineups_json: dict, game_id: int) -> list[dict]:
    """Returns one row per player who has a `statistics` block."""
    if not lineups_json:
        return []
    rows: list[dict] = []

    for side in ("home", "away"):
        side_data = lineups_json.get(side) or {}
        is_home = side == "home"
        players = side_data.get("players") or []

        for slot in players:
            player_obj = slot.get("player") or {}
            stats = slot.get("statistics") or {}
            pid = player_obj.get("id")
            if pid is None:
                continue

            # team_id lives directly on the slot (verified via real Sofascore
            # /lineups payload — 14065246 had slot.teamId=2526 for every home
            # player). Fallback to 0; loader back-fills from sofascore_match.
            slot_team_id = to_int(slot.get("teamId")) or 0

            row: dict[str, Any] = {
                "game_id":         game_id,
                "player_id":       int(pid),
                "team_id":         slot_team_id,
                "is_home":         is_home,
                "is_starter":      not bool(slot.get("substitute")),
                "is_captain":      bool(slot.get("captain")),
                "player_name":     player_obj.get("name"),
                "position":        slot.get("position") or player_obj.get("position"),
                "jersey_number":   to_int(slot.get("shirtNumber") or slot.get("jerseyNumber")),
                "raw_extras":      None,
            }

            extras: dict[str, Any] = {}
            for sf_name, value in stats.items():
                if sf_name in PLAYER_STAT_MAP:
                    db_col = PLAYER_STAT_MAP[sf_name]
                    if db_col == "_skip_":
                        extras[sf_name] = value
                        continue
                    # rating + xG/xA + goals_prevented are reals; rest int
                    if db_col in ("rating", "expected_goals", "expected_assists",
                                  "pass_accuracy_pct"):
                        row[db_col] = to_real(value)
                    else:
                        row[db_col] = parse_simple(value)
                else:
                    extras[sf_name] = value

            # Derived totals
            row["duels_total"] = _sum_duels(stats)
            row["aerial_duels_total"] = _sum_aerials(stats)
            # passes accuracy
            if row.get("passes_total") and row.get("passes_accurate"):
                row["pass_accuracy_pct"] = round(
                    100.0 * row["passes_accurate"] / row["passes_total"], 1
                )

            if extras:
                row["raw_extras"] = extras

            rows.append(row)

    return rows


# ─── /incidents → sofascore_incidents ──────────────────────────────

def project_incidents(incidents_json: dict, game_id: int) -> list[dict]:
    if not incidents_json:
        return []
    items = incidents_json.get("incidents") or []
    # Sofascore returns incidents in REVERSE chronological. We want stable idx
    # so we reverse to match-time order, then enumerate.
    items_chrono = list(reversed(items))
    rows: list[dict] = []
    for idx, ev in enumerate(items_chrono):
        itype = ev.get("incidentType") or "unknown"
        row: dict[str, Any] = {
            "game_id":             game_id,
            "incident_idx":        idx,
            "incident_type":       itype,
            "minute":              to_int(ev.get("time")),
            "added_minute":        to_int(ev.get("addedTime")),
            "period":              None,
            "is_home":             ev.get("isHome"),
            "team_id":             None,
            "player_id":           None,
            "player_name":         None,
            "related_player_id":   None,
            "related_player_name": None,
            "goal_type":           None,
            "card_color":          None,
            "card_reason":         None,
            "scoring_team_score":  None,
            "conceding_team_score": None,
            "raw_extras":          None,
        }

        # Player attribution
        player_obj = ev.get("player") or {}
        if player_obj:
            row["player_id"]   = to_int(player_obj.get("id"))
            row["player_name"] = player_obj.get("name")

        if itype == "goal":
            ic = ev.get("incidentClass") or "regular"
            row["goal_type"] = ic
            assist = ev.get("assist1") or {}
            if assist:
                row["related_player_id"] = to_int(assist.get("id"))
                row["related_player_name"] = assist.get("name")
            # After-goal score
            if row["is_home"] is True:
                row["scoring_team_score"]  = to_int(ev.get("homeScore"))
                row["conceding_team_score"] = to_int(ev.get("awayScore"))
            elif row["is_home"] is False:
                row["scoring_team_score"]  = to_int(ev.get("awayScore"))
                row["conceding_team_score"] = to_int(ev.get("homeScore"))
        elif itype == "card":
            row["card_color"] = ev.get("incidentClass") or "yellow"
            row["card_reason"] = ev.get("reason")
        elif itype == "substitution":
            sub_in = ev.get("playerIn") or {}
            sub_out = ev.get("playerOut") or {}
            row["player_id"] = to_int(sub_out.get("id"))
            row["player_name"] = sub_out.get("name")
            row["related_player_id"] = to_int(sub_in.get("id"))
            row["related_player_name"] = sub_in.get("name")
        elif itype == "period":
            row["period"] = ev.get("text")

        # Stuff anything else into raw_extras
        leftovers = {
            k: v for k, v in ev.items()
            if k not in {"incidentType", "incidentClass", "time", "addedTime",
                        "isHome", "player", "assist1", "playerIn", "playerOut",
                        "text", "homeScore", "awayScore", "reason"}
        }
        if leftovers:
            row["raw_extras"] = leftovers

        rows.append(row)
    return rows


# ─── /average-positions → sofascore_average_positions ──────────────

def project_avg_positions(avg_json: dict, game_id: int, team_ids: dict[bool, int]) -> list[dict]:
    if not avg_json:
        return []
    rows: list[dict] = []
    for side, is_home in (("home", True), ("away", False)):
        items = avg_json.get(side) or []
        team_id = team_ids.get(is_home, 0)
        for entry in items:
            player = entry.get("player") or {}
            pid = to_int(player.get("id"))
            ax = to_real(entry.get("averageX"))
            ay = to_real(entry.get("averageY"))
            if pid is None or ax is None or ay is None:
                continue
            rows.append({
                "game_id":      game_id,
                "player_id":    pid,
                "team_id":      team_id,
                "is_home":      is_home,
                "avg_x":        ax,
                "avg_y":        ay,
                "points_count": to_int(entry.get("pointsCount")),
            })
    return rows


# ─── /managers → sofascore_match_managers ──────────────────────────

def project_managers(managers_json: dict, game_id: int) -> list[dict]:
    """Returns 0 or 2 rows: (game_id, is_home=True/False) home + away coach.

    Sofa shape: {homeManager: {id, name, slug, shortName, fieldTranslations:...},
                 awayManager: {...}}
    Either side can be missing (e.g. interim coach not yet assigned).
    """
    if not managers_json:
        return []
    rows: list[dict] = []
    for is_home, key in ((True, "homeManager"), (False, "awayManager")):
        m = managers_json.get(key)
        if not isinstance(m, dict):
            continue
        mid = to_int(m.get("id"))
        if mid is None:
            continue
        # fieldTranslations is i18n metadata (Arabic/Hindi/Bengali/...) — store
        # as raw_extras to keep main columns clean.
        leftovers = {k: v for k, v in m.items()
                     if k not in {"id", "name", "shortName", "slug"}}
        rows.append({
            "game_id":            game_id,
            "is_home":            is_home,
            "manager_id":         mid,
            "manager_name":       m.get("name"),
            "manager_short_name": m.get("shortName"),
            "manager_slug":       m.get("slug"),
            "raw_extras":         leftovers or None,
        })
    return rows


# ─── /pregame-form → sofascore_pregame_form ────────────────────────

def project_pregame_form(pregame_json: dict, game_id: int) -> list[dict]:
    """Returns 0 or 2 rows.

    Sofa shape: {homeTeam: {avgRating: "6.92", position: 7, value: "7",
                            form: ["D","L","L","W","W"]},
                 awayTeam: {...},
                 label: "Pts"}

    Notes:
      - avgRating + value come as strings (Sofa quirk) → parse to REAL/INT.
      - form is most-recent-first array per Sofa convention; we join to
        a 5-char string for compact storage.
      - label is shared across both teams (top-level field).
    """
    if not pregame_json:
        return []
    rows: list[dict] = []
    label = pregame_json.get("label")
    for is_home, key in ((True, "homeTeam"), (False, "awayTeam")):
        side = pregame_json.get(key)
        if not isinstance(side, dict):
            continue
        avg = side.get("avgRating")
        try:
            avg_rating = float(avg) if avg is not None else None
        except (TypeError, ValueError):
            avg_rating = None
        val = side.get("value")
        try:
            league_value = int(val) if val is not None else None
        except (TypeError, ValueError):
            league_value = None
        form = side.get("form")
        form_str = ("".join(str(f) for f in form)
                    if isinstance(form, list) else None)
        leftovers = {k: v for k, v in side.items()
                     if k not in {"avgRating", "position", "value", "form"}}
        rows.append({
            "game_id":         game_id,
            "is_home":         is_home,
            "avg_rating":      avg_rating,
            "league_position": to_int(side.get("position")),
            "league_value":    league_value,
            "label":           label,
            "form":            form_str,
            "raw_extras":      leftovers or None,
        })
    return rows


# ─── /team-streaks → sofascore_team_streaks ────────────────────────

_STREAK_FRAC_RE = re.compile(r"^\s*(\d+)(?:\s*/\s*(\d+))?")


def _parse_streak_value(s) -> tuple[int | None, int | None]:
    """`"5/7"` → (5, 7); `"3"` → (3, None); 5 → (5, None); None → (None, None)."""
    if s is None:
        return None, None
    if isinstance(s, (int, float)):
        return int(s), None
    if isinstance(s, str):
        m = _STREAK_FRAC_RE.match(s)
        if m:
            num = int(m.group(1))
            den = int(m.group(2)) if m.group(2) else None
            return num, den
    return None, None


def project_team_streaks(streaks_json: dict, game_id: int) -> list[dict]:
    """Returns 0..N rows (typically ~13: ~8 general + ~5 head2head).

    Sofa shape: {general: [{name, value, team, continued}, ...],
                 head2head: [{...}, ...]}

    We preserve the raw value_text for forensics, plus parse to numerator
    + optional denominator for engine-feature consumption.
    """
    if not streaks_json:
        return []
    rows: list[dict] = []
    for category in ("general", "head2head"):
        items = streaks_json.get(category) or []
        if not isinstance(items, list):
            continue
        for idx, entry in enumerate(items):
            if not isinstance(entry, dict):
                continue
            value_raw = entry.get("value")
            num, den = _parse_streak_value(value_raw)
            leftovers = {k: v for k, v in entry.items()
                         if k not in {"name", "value", "team", "continued"}}
            rows.append({
                "game_id":           game_id,
                "category":          category,
                "streak_idx":        idx,
                "name":              entry.get("name"),
                "value_text":        str(value_raw) if value_raw is not None else None,
                "value_numerator":   num,
                "value_denominator": den,
                "team":              entry.get("team"),
                "continued":         bool(entry.get("continued")) if entry.get("continued") is not None else None,
                "raw_extras":        leftovers or None,
            })
    return rows


# ─── Team-id resolver from sofascore_match (for player_match_stats team_id) ─

_TEAM_ID_CACHE: dict[int, dict[bool, int]] = {}


def resolve_team_ids(game_id: int) -> dict[bool, int]:
    if game_id in _TEAM_ID_CACHE:
        return _TEAM_ID_CACHE[game_id]
    url = f"{SUPA_URL}/rest/v1/sofascore_match?game_id=eq.{game_id}&select=home_team_id,away_team_id"
    req = urllib.request.Request(
        url,
        headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())
        if data:
            ids = {True: int(data[0]["home_team_id"]), False: int(data[0]["away_team_id"])}
        else:
            ids = {True: 0, False: 0}
    except Exception:
        ids = {True: 0, False: 0}
    _TEAM_ID_CACHE[game_id] = ids
    return ids


# ─── Supabase upsert ───────────────────────────────────────────────

def _normalize_keys(rows: list[dict]) -> list[dict]:
    """PostgREST requires all rows in a batch to have the same key set
    (PGRST102 "All object keys must match"). Compute the union of keys
    across all rows, then fill missing keys with None on each row.
    Cheap (one pass to gather, one pass to fill); idempotent."""
    if not rows:
        return rows
    union = set()
    for r in rows:
        union.update(r.keys())
    for r in rows:
        for k in union:
            if k not in r:
                r[k] = None
    return rows


def supa_upsert(rows: list[dict], table: str, on_conflict: str, *, dry: bool = False, chunk: int = 500) -> tuple[int, int]:
    if not rows:
        return 0, 0
    rows = _normalize_keys(rows)
    if dry:
        return len(rows), 0
    inserted = 0
    errors = 0
    for i in range(0, len(rows), chunk):
        batch = rows[i : i + chunk]
        body = json.dumps(batch, default=str).encode("utf-8")
        url = f"{SUPA_URL}/rest/v1/{table}?on_conflict={on_conflict}"
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "apikey": SUPA_KEY,
                "Authorization": f"Bearer {SUPA_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status in (200, 201, 204):
                    inserted += len(batch)
                else:
                    errors += len(batch)
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode("utf-8", errors="replace")[:300]
            print(f"    HTTP {e.code} on {table}: {body_txt}", file=sys.stderr)
            errors += len(batch)
        except Exception as e:
            print(f"    {type(e).__name__}: {e}", file=sys.stderr)
            errors += len(batch)
    return inserted, errors


def update_state(game_id: int, league: str, season: str,
                 *, has_stats: bool, has_lineups: bool,
                 has_incidents: bool, has_avg: bool,
                 has_managers: bool = False,
                 has_pregame_form: bool = False,
                 has_team_streaks: bool = False,
                 dry: bool = False) -> None:
    if dry:
        return
    any_success = (has_stats or has_lineups or has_incidents or has_avg
                   or has_managers or has_pregame_form or has_team_streaks)
    row = {
        "game_id":            game_id,
        "league":             league,
        "season":             season,
        "has_statistics":     has_stats,
        "has_player_stats":   has_lineups,
        "has_incidents":      has_incidents,
        "has_avg_positions":  has_avg,
        "has_managers":       has_managers,
        "has_pregame_form":   has_pregame_form,
        "has_team_streaks":   has_team_streaks,
        "last_attempt_at":    "now()",
        "last_success_at":    "now()" if any_success else None,
    }
    # Increment attempt_count via separate PATCH? Simpler: set to 0 on success
    row["attempt_count"] = 0
    supa_upsert([row], "sofascore_extras_state", "game_id", dry=False)


# ─── Per-file driver ───────────────────────────────────────────────

def load_file(path: Path, *, dry: bool, verbose: bool = False) -> dict[str, int]:
    """Returns counts dict for all 7 endpoint families."""
    payload = json.loads(path.read_text())
    game_id = int(payload["game_id"])
    league = payload.get("league") or ""
    season = payload.get("season") or ""

    # 1. Match-level stats
    ms_rows = project_match_stats(payload.get("statistics") or {}, game_id)
    has_stats = len(ms_rows) > 0
    if ms_rows:
        ms_ins, ms_err = supa_upsert(ms_rows, "sofascore_match_statistics",
                                     "game_id,is_home,period", dry=dry)
        if verbose:
            print(f"  match_stats: {ms_ins}/{len(ms_rows)} (errs {ms_err})")

    # 2. Player stats — back-fill team_id from sofascore_match
    team_ids = resolve_team_ids(game_id)
    ps_rows = project_player_stats(payload.get("lineups") or {}, game_id)
    for r in ps_rows:
        if not r.get("team_id"):
            r["team_id"] = team_ids.get(r["is_home"], 0)
    has_lineups = len(ps_rows) > 0
    if ps_rows:
        ps_ins, ps_err = supa_upsert(ps_rows, "sofascore_player_match_stats",
                                     "game_id,player_id", dry=dry)
        if verbose:
            print(f"  player_stats: {ps_ins}/{len(ps_rows)} (errs {ps_err})")

    # 3. Incidents
    inc_rows = project_incidents(payload.get("incidents") or {}, game_id)
    has_incidents = len(inc_rows) > 0
    if inc_rows:
        inc_ins, inc_err = supa_upsert(inc_rows, "sofascore_incidents",
                                       "game_id,incident_idx", dry=dry)
        if verbose:
            print(f"  incidents: {inc_ins}/{len(inc_rows)} (errs {inc_err})")

    # 4. Average positions
    avg_rows = project_avg_positions(payload.get("average_positions") or {},
                                     game_id, team_ids)
    has_avg = len(avg_rows) > 0
    if avg_rows:
        avg_ins, avg_err = supa_upsert(avg_rows, "sofascore_average_positions",
                                       "game_id,player_id", dry=dry)
        if verbose:
            print(f"  avg_positions: {avg_ins}/{len(avg_rows)} (errs {avg_err})")

    # 5. v2: Managers (HIGH-SIGNAL — coaching change detection)
    mgr_rows = project_managers(payload.get("managers") or {}, game_id)
    has_managers = len(mgr_rows) > 0
    if mgr_rows:
        mgr_ins, mgr_err = supa_upsert(mgr_rows, "sofascore_match_managers",
                                       "game_id,is_home", dry=dry)
        if verbose:
            print(f"  managers: {mgr_ins}/{len(mgr_rows)} (errs {mgr_err})")

    # 6. v2: Pregame form (HIGH-SIGNAL — Sofa's pre-match form summary)
    pgf_rows = project_pregame_form(payload.get("pregame_form") or {}, game_id)
    has_pregame_form = len(pgf_rows) > 0
    if pgf_rows:
        pgf_ins, pgf_err = supa_upsert(pgf_rows, "sofascore_pregame_form",
                                       "game_id,is_home", dry=dry)
        if verbose:
            print(f"  pregame_form: {pgf_ins}/{len(pgf_rows)} (errs {pgf_err})")

    # 7. v2: Team streaks (HIGH-SIGNAL — momentum / head-to-head signals)
    streak_rows = project_team_streaks(payload.get("team_streaks") or {}, game_id)
    has_team_streaks = len(streak_rows) > 0
    if streak_rows:
        s_ins, s_err = supa_upsert(streak_rows, "sofascore_team_streaks",
                                   "game_id,category,streak_idx", dry=dry)
        if verbose:
            print(f"  team_streaks: {s_ins}/{len(streak_rows)} (errs {s_err})")

    # 8. State tracker — all 7 flags
    update_state(game_id, league, season,
                 has_stats=has_stats, has_lineups=has_lineups,
                 has_incidents=has_incidents, has_avg=has_avg,
                 has_managers=has_managers,
                 has_pregame_form=has_pregame_form,
                 has_team_streaks=has_team_streaks,
                 dry=dry)

    return {
        "match_stats":  len(ms_rows),
        "player_stats": len(ps_rows),
        "incidents":    len(inc_rows),
        "avg_pos":      len(avg_rows),
        "managers":     len(mgr_rows),
        "pregame_form": len(pgf_rows),
        "team_streaks": len(streak_rows),
    }


# ─── CLI ───────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="Load Sofascore extras JSONs into Supabase")
    p.add_argument("--all", action="store_true", help="load every JSON in data/extras/")
    p.add_argument("--game-id", type=int, help="single game")
    p.add_argument("--dry", action="store_true")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    if not (args.all or args.game_id):
        p.error("use --all or --game-id N")

    if args.game_id:
        path = DATA_DIR / f"{args.game_id}.json"
        if not path.exists():
            print(f"ERROR: {path} not found", file=sys.stderr)
            sys.exit(1)
        files = [path]
    else:
        files = sorted(DATA_DIR.glob("*.json"))
        if not files:
            print(f"No JSONs in {DATA_DIR}", file=sys.stderr)
            return

    total = {"match_stats": 0, "player_stats": 0, "incidents": 0, "avg_pos": 0,
             "managers": 0, "pregame_form": 0, "team_streaks": 0}
    t0 = time.time()
    for i, f in enumerate(files, 1):
        counts = load_file(f, dry=args.dry, verbose=args.verbose)
        for k, v in counts.items():
            total[k] += v
        if i % 25 == 0 or args.verbose:
            print(f"  [{i:>4}/{len(files)}] {f.name}")
    sec = time.time() - t0
    print(f"\n✓ {len(files)} games loaded in {sec:.1f}s")
    print(f"  match_stats:   {total['match_stats']:>6}")
    print(f"  player_stats:  {total['player_stats']:>6}")
    print(f"  incidents:     {total['incidents']:>6}")
    print(f"  avg_pos:       {total['avg_pos']:>6}")
    print(f"  managers:      {total['managers']:>6}  (v2)")
    print(f"  pregame_form:  {total['pregame_form']:>6}  (v2)")
    print(f"  team_streaks:  {total['team_streaks']:>6}  (v2)")


if __name__ == "__main__":
    main()
