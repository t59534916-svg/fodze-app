#!/usr/bin/env python3
"""
generate-data-dictionary-pdf.py — FODZE Data-Dictionary PDF (v2 · visual)

Renders docs/DATA-DICTIONARY.pdf with:
  - Cover + executive summary with KPIs
  - 3-layer storage architecture diagram
  - Coverage matrix (per-season × per-league)
  - team_xg_history deep-dive (source pie + monthly timeline)
  - Tables by row count (bar chart)
  - Per-category table sections with:
    · Row count + columns + last update
    · 3-5 diverse sample rows
    · Column profile: type, null %, distinct count, range
  - Glossary + relationships

Run: tools/venv/bin/python3 scripts/generate-data-dictionary-pdf.py
"""
from __future__ import annotations

import os
import re
import json
import sqlite3
import urllib.request
import urllib.error
import tempfile
from pathlib import Path
from datetime import datetime
from typing import Any
from io import BytesIO

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = REPO_ROOT / "docs"
OUTPUT_PDF = DOCS_DIR / "DATA-DICTIONARY.pdf"
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
TMP_DIR = Path(tempfile.mkdtemp(prefix="fodze_pdf_"))

# ─── FODZE color palette (matched to design tokens) ───────────────────

LEATHER  = "#1a0f0a"
LEATHER2 = "#231510"
GOLD     = "#d4b86a"
GOLD_LIGHT = "#e8d5a0"
GOLD_MID = "#c4a265"
GOLD_DEEP = "#a68940"
TEXT     = "#2a1810"
MUTED    = "#5a4830"
GREEN    = "#4a8c3a"
VALUE    = "#6aad55"
SURFACE  = "#fdf9ed"
WARN     = "#e07070"
INFO     = "#5a9ec4"
CREAM    = "#faf3e0"

# Per-source colors for charts
SOURCE_COLORS = {
    "footystats":          "#c4a265",
    "sofascore":           "#6aad55",
    "understat":           "#5a9ec4",
    "goals-proxy":         "#e0a070",
    "shots-model-pooled":  "#a07060",
    "shots-model":         "#806050",
    "api-sports":          "#9090a0",
}


# ─── Env + Supabase REST helper ───────────────────────────────────────

def read_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in (REPO_ROOT / ".env.local").read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=(.+)$", line.strip())
        if m:
            env[m.group(1)] = m.group(2).strip().strip("'\"")
    return env


class Supabase:
    def __init__(self, env: dict[str, str]):
        self.url = env["NEXT_PUBLIC_SUPABASE_URL"]
        self.key = env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

    def _request(self, path: str, extra_headers: dict | None = None,
                 timeout: int = 15) -> tuple[int, str, dict]:
        url = f"{self.url}/rest/v1/{path}"
        req = urllib.request.Request(url, headers={
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            **(extra_headers or {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read().decode("utf-8"), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8"), {}
        except Exception as e:
            return 0, f"EXC:{type(e).__name__}: {e}", {}

    def sample_rows(self, table: str, n: int = 3, where: str = "",
                    order: str = "") -> list[dict]:
        params = f"select=*&limit={n}"
        if order:
            params += f"&order={order}"
        if where:
            params = f"{where}&{params}"
        status, body, _ = self._request(f"{table}?{params}")
        if status != 200:
            return []
        try:
            data = json.loads(body)
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def count(self, table: str, where: str = "") -> int:
        path = f"{table}?select=*" + (f"&{where}" if where else "")
        _, _, headers = self._request(
            path,
            extra_headers={"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
        )
        cr = headers.get("content-range") or headers.get("Content-Range") or ""
        m = re.search(r"/(\d+)", cr)
        return int(m.group(1)) if m else 0

    def distinct_counts(self, table: str, column: str, top_n: int = 50) -> dict[str, int]:
        """Return dict {value: count} for top N most-frequent values."""
        path = f"{table}?select={column}&limit=1000"
        status, body, _ = self._request(path)
        if status != 200:
            return {}
        try:
            data = json.loads(body)
            counts: dict[str, int] = {}
            for r in data:
                v = r.get(column)
                if v is None:
                    continue
                k = str(v)
                counts[k] = counts.get(k, 0) + 1
            top = dict(sorted(counts.items(), key=lambda x: -x[1])[:top_n])
            return top
        except Exception:
            return {}


# ─── Catalog (curated descriptions) ───────────────────────────────────

CATALOG: dict[str, list[dict]] = {
    "1. Live Engine Inputs": [
        {
            "name": "team_xg_history",
            "purpose": "PRIMÄRER ENGINE-INPUT. Per-match-per-team xG/xGA Historie. UNIQUE (team, league, match_date, venue). 18 Sofa-Features seit 2026-05-07.",
            "key_cols": [
                ("team",                  "Mannschaftsname (canonical)",                "string"),
                ("league",                "FODZE league key (z.B. bundesliga)",         "string"),
                ("venue",                 "home oder away",                              "enum"),
                ("match_date",            "ISO Datum YYYY-MM-DD",                       "date"),
                ("opponent",              "Gegner (canonical)",                          "string"),
                ("xg",                    "Expected goals for (Understat / Sofa)",      "float"),
                ("xga",                   "Expected goals against",                      "float"),
                ("goals_for",             "Tatsächliche Tore erzielt",                   "int"),
                ("goals_against",         "Tatsächliche Tore kassiert",                 "int"),
                ("shots_for",             "Schüsse gesamt",                              "int"),
                ("shots_against",         "Gegnerische Schüsse",                         "int"),
                ("source",                "Datenquelle",                                 "enum"),
                ("big_chances",           "Sofa: clear chances created",                 "int"),
                ("possession_pct",        "Sofa: ball-possession Anteil",                "float"),
                ("tackles",               "Sofa: erfolgreiche Tackles",                  "int"),
                ("interceptions",         "Sofa: abgefangene Pässe",                     "int"),
                ("fouls_committed",       "Sofa: begangene Fouls",                       "int"),
                ("yellow_cards",          "Sofa: gelbe Karten",                          "int"),
                ("red_cards",             "Sofa: rote Karten",                           "int"),
                ("expected_goals_prevented", "Sofa: Goalkeeper-PSxG saved",             "float"),
            ],
            "note": "Sources: footystats | sofascore | understat | goals-proxy | shots-model | api-sports",
        },
        {
            "name": "live_odds",
            "purpose": "Aktuelle Quoten von The-Odds-API. Vig-removed sharp + best across bookmakers. Auto-refresh alle 4h.",
            "key_cols": [
                ("match_key",      "Eindeutiger Match-key",                    "string"),
                ("league",         "FODZE league key",                          "string"),
                ("home_team",      "Heimteam",                                  "string"),
                ("away_team",      "Auswärtsteam",                              "string"),
                ("commence_time",  "Kickoff ISO timestamp",                     "ts"),
                ("sharp_h",        "Pinnacle home win prob (vig-removed)",      "float"),
                ("sharp_d",        "Pinnacle draw prob",                        "float"),
                ("sharp_a",        "Pinnacle away win prob",                    "float"),
                ("best_h",         "Beste home odds across bookmakers",         "float"),
                ("best_d",         "Beste draw odds",                           "float"),
                ("best_a",         "Beste away odds",                           "float"),
                ("sharp_over25",   "Pinnacle Over 2.5 vig-removed prob",        "float"),
                ("sharp_under25",  "Pinnacle Under 2.5 vig-removed prob",       "float"),
            ],
            "note": "Single-row per match — wird bei jedem Cron-Tick ersetzt (kein Historical-Tracking).",
        },
        {
            "name": "matchdays",
            "purpose": "Spieltag-JSON pro Liga (JSONB). xg_h8, Form, Tags, H2H, Standings, Injuries — alles embedded.",
            "key_cols": [
                ("league",      "FODZE league key",                       "string"),
                ("label",       "z.B. '30. Spieltag' aus OpenLigaDB",     "string"),
                ("date",        "Spieltag-Datum",                          "date"),
                ("data",        "JSONB mit data.matches[] (rich match meta)", "jsonb"),
                ("created_at",  "Insert-Timestamp",                        "ts"),
                ("created_by",  "User-ID (FODZE admin)",                   "uuid"),
            ],
            "note": "data.matches[] enthält pro Match: home/away xg, form, standings, injuries, h2h, tags.",
        },
    ],
    "2. Engine Outputs + Backtest": [
        {
            "name": "match_predictions",
            "purpose": "Pre-match Engine-Snapshots pro Engine-Variante. Captured beim /matchday Page-Load.",
            "key_cols": [
                ("match_key",    "Eindeutiger Match-key",          "string"),
                ("engine",       "ensemble | poisson-ml | v2 | v3 | footbayes", "enum"),
                ("league",       "Liga",                            "string"),
                ("lambda_h",     "Engine λ home (Dixon-Coles)",     "float"),
                ("lambda_a",     "Engine λ away",                    "float"),
                ("prob_h",       "Win-prob home",                    "float"),
                ("prob_d",       "Draw-prob",                        "float"),
                ("prob_a",       "Win-prob away",                    "float"),
                ("prob_over25",  "Over 2.5 Goals prob",              "float"),
                ("prob_btts",    "Both teams to score prob",         "float"),
                ("sharp_h",      "Markt-vergleichswert home",        "float"),
                ("sharp_d",      "Markt-vergleichswert draw",        "float"),
                ("sharp_a",      "Markt-vergleichswert away",        "float"),
                ("predicted_at", "Pre-match snapshot timestamp",     "ts"),
            ],
            "note": "UNIQUE (match_key, engine). Richer als pipeline_shadow_log.",
        },
        {
            "name": "match_outcomes",
            "purpose": "Post-match REALITY — was wirklich passierte. Joined predictions × actual.",
            "key_cols": [
                ("match_key",    "Eindeutiger Match-key",     "string"),
                ("match_date",   "Spielzeit-Datum",            "date"),
                ("league",       "Liga",                       "string"),
                ("home_team",    "Heimteam",                   "string"),
                ("away_team",    "Auswärtsteam",               "string"),
                ("home_goals",   "Final score home",           "int"),
                ("away_goals",   "Final score away",           "int"),
                ("home_xg",      "Actual xG home (Sofa)",      "float"),
                ("away_xg",      "Actual xG away",              "float"),
                ("total_goals",  "Generated: home+away",        "int (gen)"),
                ("over25",       "Generated: total > 2.5",      "bool (gen)"),
                ("btts",         "Generated: beide ≥ 1 goal",   "bool (gen)"),
                ("outcome_1x2",  "Generated: H | D | A",        "enum (gen)"),
            ],
            "note": "UNIQUE (match_key, match_date) seit 2026-04-27. Drives ROI + Brier metrics.",
        },
        {
            "name": "live_brier_snapshots",
            "purpose": "Time-series Live-Brier-Score pro (engine, league). Drives Performance-Tracking auf /health.",
            "key_cols": [
                ("id",               "UUID",                                "uuid"),
                ("window_end_date",  "Window-End-Datum (rolling)",          "date"),
                ("engine",           "ensemble | poisson-ml | v2 | v3",     "enum"),
                ("league",           "Liga (oder '__overall' aggregate)",    "string"),
                ("n",                "Stichproben-N in window",              "int"),
                ("brier_1x2",        "Brier Score für 1X2 outcome (lower=better)", "float"),
                ("brier_o25",        "Brier Score für Over 2.5 goals",       "float"),
                ("captured_at",      "Snapshot-Timestamp",                  "ts"),
            ],
            "note": "UNIQUE (window_end_date, engine, league). Brier ~0.55 = good · ~0.75 = chance-level.",
        },
        {
            "name": "pipeline_shadow_log",
            "purpose": "Per-Matchday Engine A/B/C/D predictions. ~4-5 engines geloggt parallel.",
            "key_cols": [
                ("match_key",       "Match-key",                "string"),
                ("league",          "Liga",                      "string"),
                ("engine_variant",  "ensemble | v1 | v2 | v3 | footbayes", "enum"),
                ("prob_h",          "Win-prob home",            "float"),
                ("prob_d",          "Draw-prob",                 "float"),
                ("prob_a",          "Win-prob away",             "float"),
                ("prob_o25",        "Over 2.5 prob",             "float"),
                ("feature_version", "Engine model version tag",  "string"),
                ("predicted_at",    "Pre-match snapshot ts",     "ts"),
            ],
            "note": "UNIQUE (match_key, engine_variant, predicted_date). monitor-live-brier.mjs scored gegen team_xg_history.",
        },
    ],
    "3. User Data": [
        {
            "name": "bets",
            "purpose": "Vom User platzierte Bets. CLV-tracking via closing_odds embedded.",
            "key_cols": [
                ("id",            "Bet ID",                       "uuid"),
                ("match_key",     "Match-key",                    "string"),
                ("home_team",     "Heim",                          "string"),
                ("away_team",     "Auswärts",                      "string"),
                ("market",        "Over 2.5 | Home Win | etc.",   "enum"),
                ("odds_placed",   "Quote bei Wett-Platzierung",   "float"),
                ("stake",         "Einsatz EUR",                   "float"),
                ("model_prob",    "Engine's Prob für dieses Outcome", "float"),
                ("edge",          "Edge % = model_prob × odds − 1", "float"),
                ("result",        "won | lost | pending",          "enum"),
                ("closing_odds",  "Pinnacle-Quote zu Spielbeginn", "float"),
                ("clv",           "log(odds_placed/closing) × 100", "float"),
                ("placed_at",     "Wett-Timestamp",                "ts"),
                ("settled_at",    "Settlement-Timestamp",          "ts"),
            ],
            "note": "Auto-settled via fetch-results.mjs cron. RLS: User reads/writes nur own row.",
        },
        {
            "name": "profiles",
            "purpose": "User profile — bankroll, risk profile (K/M/A), engine choice.",
            "key_cols": [
                ("user_id",            "FK auf auth.users.id",         "uuid"),
                ("display_name",       "Anzeigename",                  "string"),
                ("bankroll",           "Aktueller Bankroll EUR",       "float"),
                ("risk_profile",       "K (conservative) | M (moderate) | A (aggressive)", "enum"),
                ("prediction_engine",  "Bevorzugte Engine",             "enum"),
            ],
            "note": "RLS aktiv. K=2.5% Kelly cap, M=4%, A=6%.",
        },
    ],
    "4. Sofa Pipeline — Match catalog + Shots": [
        {
            "name": "sofascore_match",
            "purpose": "Sofa-API Match Catalog. Skeleton-Tabelle für die ganze Sofa-Pipeline.",
            "key_cols": [
                ("game_id",            "Sofa-internal unique match-ID",  "int"),
                ("league",             "FODZE league key",                "string"),
                ("season",             "Saison wie '24/25'",              "string"),
                ("home_team",          "Heimteam (Sofa name)",            "string"),
                ("away_team",          "Auswärts (Sofa name)",            "string"),
                ("home_team_id",       "Sofa home-team-ID",                "int"),
                ("away_team_id",       "Sofa away-team-ID",                "int"),
                ("start_timestamp",    "Kickoff Unix-timestamp",          "int"),
                ("status_code",        "100=ended, 60=postponed, etc.",   "int"),
                ("status_description", "Ended | Postponed | Cancelled",    "string"),
                ("home_score",         "Final score home",                "int"),
                ("away_score",         "Final score away",                "int"),
                ("tournament_id",      "Sofa tournament ID",               "int"),
                ("season_id",          "Sofa season ID",                   "int"),
            ],
            "note": "Populated via fetch_shots.py + load_to_supabase.py. Pflicht für extras-pipeline.",
        },
        {
            "name": "sofascore_shotmap",
            "purpose": "Per-shot Events: xG, xGOT, body-part, situation, koords. ~375k rows.",
            "key_cols": [
                ("game_id",        "Match-ID",                         "int"),
                ("shot_idx",       "Shot index in game",                "int"),
                ("player_id",     "Sofa player-ID",                    "int"),
                ("player_name",    "Schütze-Name",                      "string"),
                ("is_home",        "Heimteam ja/nein",                   "bool"),
                ("minute",         "Spielminute",                        "int"),
                ("xg",             "Expected Goals dieses Shots",        "float"),
                ("xg_on_target",   "xGOT (post-shot xG)",                "float"),
                ("body_part",      "right-foot | left-foot | head",      "enum"),
                ("situation",      "open-play | corner | penalty | ...", "enum"),
                ("outcome",        "goal | saved | post | block | miss", "enum"),
                ("x",              "Shooter X-koord (pitch %)",          "float"),
                ("y",              "Shooter Y-koord",                     "float"),
                ("goal_mouth_x",   "Ball-Eintritt-Tor X (xGOT only)",     "float"),
                ("goal_mouth_y",   "Ball-Eintritt-Tor Y",                  "float"),
            ],
            "note": "data_quality_tier: premium (16 Ligen voll-xG+tags) · partial · volume.",
        },
    ],
    "5. Sofa Pipeline — Per-game Extras": [
        {
            "name": "sofascore_match_statistics",
            "purpose": "Team-level match-aggregates per period (ALL/1ST/2ND). Bridge-Quelle für team_xg_history features.",
            "key_cols": [
                ("game_id",                "Match-ID",                                "int"),
                ("is_home",                "Heim ja/nein",                             "bool"),
                ("period",                 "ALL | 1ST | 2ND",                          "enum"),
                ("ball_possession_pct",    "Ballbesitz %",                              "float"),
                ("expected_goals",         "Sofa Team-xG",                              "float"),
                ("big_chances",            "Clear chances created",                     "int"),
                ("total_shots",            "Gesamt-Schüsse",                            "int"),
                ("shots_on_target",        "Aufs Tor",                                  "int"),
                ("shots_inside_box",       "Strafraum-Schüsse",                         "int"),
                ("shots_outside_box",      "Außer-Strafraum",                            "int"),
                ("passes",                 "Pässe total",                                "int"),
                ("passes_accurate",        "Erfolgreiche Pässe",                         "int"),
                ("tackles",                "Tackles",                                   "int"),
                ("interceptions",          "Abgefangene",                               "int"),
                ("fouls",                  "Begangene Fouls",                           "int"),
                ("yellow_cards",           "Gelb",                                       "int"),
                ("red_cards",              "Rot",                                        "int"),
                ("corners",                "Ecken",                                      "int"),
                ("offsides",               "Abseits",                                    "int"),
            ],
            "note": "UNIQUE (game_id, is_home, period). 84k+ rows.",
        },
        {
            "name": "sofascore_incidents",
            "purpose": "Goal/Card/Substitution-Timeline pro Game. Hier kommen NEUER-TRAINER + Streak-Detektion-Daten her.",
            "key_cols": [
                ("game_id",         "Match-ID",                          "int"),
                ("incident_idx",    "Index in game (sort by minute)",    "int"),
                ("incident_type",   "goal | card | substitution | period", "enum"),
                ("minute",          "Spielminute",                        "int"),
                ("added_time",      "Nachspielzeit-Minuten",              "int"),
                ("player_id",       "Beteiligter Spieler (Sofa-ID)",      "int"),
                ("player_name",     "Beteiligter Spieler (name)",         "string"),
                ("is_home",         "Home-team event?",                    "bool"),
                ("scoring_team",    "Torschütze: home oder away",         "enum"),
                ("is_penalty",      "Elfmeter ja/nein",                   "bool"),
                ("is_own_goal",     "Eigentor ja/nein",                   "bool"),
                ("card_color",      "yellow | red | second-yellow",       "enum"),
            ],
            "note": "UNIQUE (game_id, incident_idx). ~304k rows.",
        },
        {
            "name": "sofascore_average_positions",
            "purpose": "Tactical avg-pitch coords pro Spieler. Heatmap-Basis.",
            "key_cols": [
                ("game_id",         "Match-ID",                "int"),
                ("player_id",       "Spieler-ID",              "int"),
                ("player_name",     "Spieler-name",            "string"),
                ("is_home",         "Heim?",                    "bool"),
                ("avg_x",           "Durchschnitt X-pos",       "float"),
                ("avg_y",           "Durchschnitt Y-pos",       "float"),
                ("is_starter",      "In Startelf?",             "bool"),
                ("minutes_played",  "Gespielte Minuten",        "int"),
            ],
            "note": "UNIQUE (game_id, player_id). 453k+ rows.",
        },
        {
            "name": "sofascore_match_managers",
            "purpose": "Manager-info pro Game. manager_id stable → Coaching-Change-Detection.",
            "key_cols": [
                ("game_id",             "Match-ID",                  "int"),
                ("is_home",             "Home oder Away coach?",     "bool"),
                ("manager_id",          "Sofa manager-ID (stable)",  "int"),
                ("manager_name",        "Voller Name",                "string"),
                ("manager_slug",        "Sofa URL slug",              "string"),
                ("manager_short_name",  "Kurzname",                  "string"),
            ],
            "note": "View sofa_team_manager_history aggregiert für NEUER-TRAINER detection.",
        },
        {
            "name": "sofascore_pregame_form",
            "purpose": "Sofa's pre-match Form-Summary: Rating, Liga-Position, last-5.",
            "key_cols": [
                ("game_id",         "Match-ID",                       "int"),
                ("is_home",         "Heim?",                           "bool"),
                ("avg_rating",      "Sofa Avg Rating last-N",          "float"),
                ("league_position", "Aktuelle Liga-Position",          "int"),
                ("league_value",    "Wert für die Position (Points)",  "int"),
                ("label",           "z.B. 'WWDLW' last-5 outcomes",    "string"),
            ],
            "note": "~29k rows. Early-season Week 1-2 fehlt oft pregame-form (kein Vorjahr-Form-Daten).",
        },
        {
            "name": "sofascore_team_streaks",
            "purpose": "Team-Streaks — general (cross-league) + h2h (vs this opponent). 161k rows.",
            "key_cols": [
                ("game_id",         "Match-ID",                            "int"),
                ("is_home",         "Heim?",                                "bool"),
                ("streak_type",     "general | h2h",                        "enum"),
                ("streak_outcome",  "W | L | D",                             "enum"),
                ("n_games",         "Streak-Länge",                          "int"),
                ("streak_value",    "Extra context (z.B. cleansheets)",     "string"),
            ],
            "note": "Drives streak-pattern Trigger Detector (W5+ oder L5+ fires).",
        },
        {
            "name": "sofascore_extras_state",
            "purpose": "Sync-state Tracker. Welche Endpoints für jedes Game erfolgreich gepullt.",
            "key_cols": [
                ("game_id",            "Match-ID",                  "int"),
                ("league",             "Liga",                       "string"),
                ("season",             "Saison",                     "string"),
                ("has_statistics",     "stats-endpoint erfolgreich?", "bool"),
                ("has_player_stats",   "lineups-endpoint?",          "bool"),
                ("has_incidents",      "incidents?",                 "bool"),
                ("has_avg_positions",  "avg-positions?",             "bool"),
                ("has_managers",       "managers?",                  "bool"),
                ("has_pregame_form",   "pregame-form?",              "bool"),
                ("has_team_streaks",   "team-streaks?",              "bool"),
                ("last_attempt_at",    "Letzter Fetch-Versuch",      "ts"),
                ("last_success_at",    "Letzter erfolgreich",         "ts"),
                ("attempt_count",      "Wiederholungs-Counter",      "int"),
            ],
            "note": "Forever-cache. Alle has_* TRUE + status='Ended' → v2_complete.",
        },
    ],
    "6. Reference Metadata": [
        {
            "name": "team_metadata",
            "purpose": "Team-Metadata aus TheSportsDB — logos, colors, stadium, cross-source IDs.",
            "key_cols": [
                ("team_name",         "Team-Name",                          "string"),
                ("fodze_league",      "FODZE league key",                   "string"),
                ("thesportsdb_id",    "TheSportsDB unique-ID",              "int"),
                ("api_sports_id",     "api-sports cross-ref",                "int"),
                ("logo_url",          "Logo PNG URL (R2 CDN)",              "url"),
                ("jersey_url",        "Jersey/Equipment URL",                "url"),
                ("color_primary",     "Primärfarbe hex",                     "color"),
                ("color_secondary",   "Sekundärfarbe hex",                   "color"),
                ("color_tertiary",    "Tertiärfarbe hex",                    "color"),
                ("stadium",           "Stadion-Name",                        "string"),
                ("stadium_capacity",  "Stadion-Kapazität",                   "int"),
                ("country",           "Land",                                "string"),
                ("founded_year",      "Gründungsjahr",                       "int"),
            ],
            "note": "UNIQUE (team_name, fodze_league). Multiple aliases per thesportsdb_id ok.",
        },
        {
            "name": "player_xg_history",
            "purpose": "Per-Player xG/xA/key_passes (Top-5 leagues only, Understat).",
            "key_cols": [
                ("player_name",        "Spielername",          "string"),
                ("team",               "Aktuelles Team",        "string"),
                ("league",             "Liga (top-5)",          "string"),
                ("season",             "Saison",                "string"),
                ("xg_per_90",          "xG pro 90 Minuten",     "float"),
                ("xa_per_90",          "Expected Assists/90",   "float"),
                ("key_passes_per_90",  "Schlüsselpässe/90",     "float"),
                ("npxg_per_90",        "Non-penalty xG/90",     "float"),
                ("minutes_played",     "Gespielte Minuten",     "int"),
                ("games_played",       "Spiele",                "int"),
            ],
            "note": "Used für xGChain-hydration in MatchdayContext bei TM-Injuries.",
        },
        {
            "name": "player_injuries",
            "purpose": "Current-season Injuries via api-sports. ⚠ EMPTY — TM-Injuries embedded in matchday JSON.",
            "key_cols": [
                ("player_id",       "api-sports ID",         "int"),
                ("team_name",       "Team",                   "string"),
                ("league",          "Liga",                   "string"),
                ("injury_type",     "INJURY | SUSPENSION",    "enum"),
                ("position",        "GK | DEF | MID | FWD",   "enum"),
                ("reason",          "Bandscheibe | Knöchel | ...", "string"),
                ("expected_return", "Erwartetes Return ISO",  "date"),
            ],
            "note": "Schema bleibt für künftigen api-sports backfill.",
        },
    ],
    "7. Historical + Closing-Odds": [
        {
            "name": "odds_closing_history",
            "purpose": "Pinnacle closing odds. Historical + live snapshot. CLV-Forward-Cache.",
            "key_cols": [
                ("match_key",   "Match-key",                           "string"),
                ("match_date",  "Spieldatum",                           "date"),
                ("league",      "Liga",                                 "string"),
                ("home_team",   "Heim",                                  "string"),
                ("away_team",   "Auswärts",                              "string"),
                ("psch",        "Pinnacle Close Home (decimal)",       "float"),
                ("pscd",        "Pinnacle Close Draw",                  "float"),
                ("psca",        "Pinnacle Close Away",                  "float"),
                ("psc_over25",  "Pinnacle Close Over 2.5",              "float"),
                ("psc_under25", "Pinnacle Close Under 2.5",             "float"),
                ("ah_line",     "Asian-Handicap-Linie",                 "float"),
                ("pscahh",      "AH home odds",                          "float"),
                ("pscaha",      "AH away odds",                          "float"),
                ("ft_result",   "Final-time result (H | D | A)",        "enum"),
                ("source",      "football-data.co.uk | live-odds-snapshot", "enum"),
            ],
            "note": "UNIQUE (match_key). 25k+ rows.",
        },
        {
            "name": "odds_snapshots",
            "purpose": "Quotenverlauf mit Timestamps (manual/live/import). Hist-tracking.",
            "key_cols": [
                ("match_key",    "Match-key",            "string"),
                ("league",       "Liga",                  "string"),
                ("home_team",    "Heim",                  "string"),
                ("away_team",    "Auswärts",              "string"),
                ("market",       "1X2 | OU25 | BTTS",     "enum"),
                ("odds",         "Odds (JSONB)",          "jsonb"),
                ("source",       "manual | live | import", "enum"),
                ("snapshot_at",  "Timestamp",             "ts"),
            ],
            "note": "Historisches Tracking (vs live_odds das pro Tick ersetzt wird).",
        },
        {
            "name": "upcoming_fixtures",
            "purpose": "Fixture-Spielplan piggybacked aus fetch-odds.mjs.",
            "key_cols": [
                ("match_key",     "Match-key",      "string"),
                ("league",        "Liga",            "string"),
                ("home_team",     "Heim",            "string"),
                ("away_team",     "Auswärts",        "string"),
                ("commence_time", "Kickoff ISO ts",  "ts"),
            ],
            "note": "Extracted aus The-Odds-API events endpoint pro fetch-odds run.",
        },
    ],
}

LOCAL_TABLES = [
    {
        "name": "sofascore_player_match_stats",
        "purpose": "Player-match stats — LOCAL ONLY seit 2026-05-18 (Supabase 500MB-limit). 443k rows.",
        "note": "Storage-saver: ~36KB/game = 60% v1+v2 storage cost on Supabase free-tier.",
    },
    {
        "name": "understat_player_match_stats",
        "purpose": "Understat player-level: xg_chain, xa, key_passes per game. Top-5 × 8 Saisons.",
        "note": "424k rows × 21k unique players × Top-5 leagues. Bereit für dev-05 player-lineup feature.",
    },
]


# ─── Chart helpers ────────────────────────────────────────────────────

def _fodze_chart_style(ax: plt.Axes, title: str = "") -> None:
    """Apply FODZE chart styling."""
    ax.set_facecolor(SURFACE)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["bottom"].set_color(GOLD_MID)
    ax.spines["left"].set_color(GOLD_MID)
    ax.tick_params(colors=TEXT, labelsize=8)
    ax.grid(True, axis="y", linestyle="--", linewidth=0.4, color=GOLD_MID, alpha=0.4)
    ax.set_axisbelow(True)
    if title:
        ax.set_title(title, color=LEATHER, fontsize=11, fontweight="bold", pad=10)


def save_chart(fig: plt.Figure, name: str, tight: bool = True) -> Path:
    path = TMP_DIR / f"{name}.png"
    if tight:
        fig.savefig(path, dpi=130, bbox_inches="tight", facecolor=SURFACE,
                    pad_inches=0.2)
    else:
        fig.savefig(path, dpi=130, facecolor=SURFACE)
    plt.close(fig)
    return path


def chart_storage_architecture() -> Path:
    """3-layer storage architecture: Sofa API → JSON checkpoints → Local SQLite + Supabase → Engine."""
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 5)
    ax.axis("off")
    ax.set_facecolor(SURFACE)

    def box(x, y, w, h, text, color, text_color="white", fontsize=9):
        rect = FancyBboxPatch((x, y), w, h,
                              boxstyle="round,pad=0.05,rounding_size=0.15",
                              linewidth=1.5, edgecolor=GOLD_MID, facecolor=color)
        ax.add_patch(rect)
        ax.text(x + w/2, y + h/2, text, ha="center", va="center",
                color=text_color, fontsize=fontsize, weight="bold", wrap=True)

    def arrow(x1, y1, x2, y2):
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle="->", color=GOLD_DEEP, lw=1.5))

    # Top: data source
    box(3.8, 4.2, 2.4, 0.7, "Sofa API\n(curl_cffi + Webshare)", LEATHER, "#fff", 10)

    # Middle: storage layers
    box(0.5, 2.8, 2.6, 0.9, "JSON Checkpoints\n10.801 files · 1.5 GB\n(authoritative)", GOLD_MID, "#fff", 9)
    box(3.8, 2.8, 2.4, 0.9, "Local SQLite\n661 MB\n90k team_xg rows", VALUE, "#fff", 9)
    box(7.0, 2.8, 2.6, 0.9, "Supabase\n14k match-extras\n(free-tier 500MB)", INFO, "#fff", 9)

    # Bottom: consumers
    box(0.5, 1.0, 2.6, 0.9, "Engine Retraining\n(python pipeline)", GOLD, LEATHER, 9)
    box(3.8, 1.0, 2.4, 0.9, "Bridges → team_xg_history\n(per-game xG features)", GOLD, LEATHER, 9)
    box(7.0, 1.0, 2.6, 0.9, "FODZE App\n(MatchdayContext)", GOLD, LEATHER, 9)

    # Arrows
    arrow(5.0, 4.2, 2.0, 3.7)  # API → JSON
    arrow(3.1, 3.25, 3.8, 3.25)  # JSON → SQLite
    arrow(6.2, 3.25, 7.0, 3.25)  # SQLite → Supabase (bridges)
    arrow(1.8, 2.8, 1.8, 1.9)
    arrow(5.0, 2.8, 5.0, 1.9)
    arrow(8.3, 2.8, 8.3, 1.9)

    ax.text(5, 0.3, "3-Layer Storage Architecture · FODZE Sofa Pipeline",
            ha="center", color=LEATHER, fontsize=10, weight="bold", style="italic")
    fig.suptitle("Data Flow & Storage Layers", fontsize=14, color=LEATHER, weight="bold", y=0.97)
    return save_chart(fig, "01_architecture")


def chart_table_sizes(table_counts: dict[str, int]) -> Path:
    """Horizontal bar chart: top 15 NON-EMPTY tables by row count."""
    # Filter zeros (empty tables break log-scale) + cap at 15
    non_zero = {k: v for k, v in table_counts.items() if v > 0}
    sorted_tables = sorted(non_zero.items(), key=lambda x: -x[1])[:15]

    plt.close("all")
    fig, ax = plt.subplots(figsize=(10, 6))

    if not sorted_tables:
        ax.text(0.5, 0.5, "(keine Daten)", ha="center", va="center", fontsize=12)
        ax.axis("off")
        return save_chart(fig, "02_table_sizes", tight=False)

    names = [t[0] for t in sorted_tables]
    counts = [t[1] for t in sorted_tables]

    bars = ax.barh(names[::-1], counts[::-1], color=GOLD, edgecolor=GOLD_DEEP, linewidth=0.6)
    for bar, count in zip(bars, counts[::-1]):
        ax.text(bar.get_width() * 1.02, bar.get_y() + bar.get_height()/2,
                f"{count:,}", va="center", color=TEXT, fontsize=8)
    # Log scale only if range is wide enough (>100×); else linear
    max_count = max(counts)
    min_count = min(counts)
    if max_count / max(min_count, 1) > 100:
        ax.set_xscale("log")
        ax.set_xlabel("Rows (log scale)", color=TEXT, fontsize=9)
        ax.set_xlim(max(1, min_count * 0.7), max_count * 2)
    else:
        ax.set_xlabel("Rows", color=TEXT, fontsize=9)
    _fodze_chart_style(ax, "Top 15 Tabellen nach Row Count")
    return save_chart(fig, "02_table_sizes", tight=False)


def chart_team_xg_sources(supa: Supabase, conn: sqlite3.Connection | None) -> Path:
    """Pie chart of team_xg_history sources (from local SQLite for fast query)."""
    # Use local SQLite — fastest
    sources: dict[str, int] = {}
    if conn is not None:
        try:
            for row in conn.execute(
                "SELECT source, COUNT(*) FROM team_xg_history GROUP BY source ORDER BY 2 DESC"
            ):
                sources[row[0]] = row[1]
        except Exception:
            pass

    fig, ax = plt.subplots(figsize=(9, 5))
    if sources:
        labels = list(sources.keys())
        sizes = list(sources.values())
        colors_arr = [SOURCE_COLORS.get(l, "#888") for l in labels]
        wedges, texts, autotexts = ax.pie(
            sizes,
            labels=[f"{l}\n{v:,}" for l, v in sources.items()],
            colors=colors_arr,
            autopct=lambda p: f"{p:.1f}%" if p > 3 else "",
            startangle=90,
            wedgeprops=dict(edgecolor="white", linewidth=1.5),
            textprops=dict(fontsize=8, color=TEXT),
        )
        for at in autotexts:
            at.set_color("white")
            at.set_fontweight("bold")
        ax.set_title(f"team_xg_history Quellen-Verteilung\n(Total: {sum(sizes):,} rows)",
                     color=LEATHER, fontsize=12, weight="bold", pad=10)
    return save_chart(fig, "03_xg_sources")


def chart_coverage_matrix(supa: Supabase) -> Path:
    """Per-league × per-season game coverage grid."""
    leagues = ["bundesliga", "bundesliga2", "liga3", "epl", "la_liga", "la_liga2",
               "serie_a", "serie_b", "ligue_1", "ligue_2", "championship",
               "eredivisie", "primeira_liga", "greek_sl", "super_lig",
               "scottish_prem", "jupiler_pro"]
    seasons = ["23/24", "24/25", "25/26"]

    matrix = np.zeros((len(leagues), len(seasons)))
    for i, lg in enumerate(leagues):
        for j, s in enumerate(seasons):
            cnt = supa.count("sofascore_match", where=f"league=eq.{lg}&season=eq.{s.replace('/','%2F')}")
            matrix[i, j] = cnt

    fig, ax = plt.subplots(figsize=(8, 9))
    im = ax.imshow(matrix, cmap="YlGn", aspect="auto", vmin=0, vmax=matrix.max() if matrix.max() > 0 else 1)
    ax.set_xticks(range(len(seasons)))
    ax.set_xticklabels(seasons, color=TEXT, fontsize=10)
    ax.set_yticks(range(len(leagues)))
    ax.set_yticklabels(leagues, color=TEXT, fontsize=9)
    ax.set_facecolor(SURFACE)

    # Cell numbers
    for i in range(len(leagues)):
        for j in range(len(seasons)):
            val = int(matrix[i, j])
            color = "white" if val > matrix.max() * 0.4 else TEXT
            ax.text(j, i, f"{val}" if val > 0 else "–",
                    ha="center", va="center", color=color, fontsize=8, weight="bold")

    plt.colorbar(im, ax=ax, label="games in sofascore_match", shrink=0.6)
    ax.set_title("Per-League × Per-Season Coverage\n(sofascore_match rows)",
                 color=LEATHER, fontsize=12, weight="bold", pad=10)
    fig.tight_layout()
    return save_chart(fig, "04_coverage_matrix")


def chart_xg_monthly_timeline(conn: sqlite3.Connection | None) -> Path:
    """Monthly timeline of team_xg_history records since 2023-08."""
    # Use a fresh plt context
    plt.close("all")

    data: list[tuple[str, int]] = []
    if conn is not None:
        try:
            for row in conn.execute("""
                SELECT SUBSTR(match_date, 1, 7) as ym, COUNT(*)
                FROM team_xg_history
                WHERE match_date >= '2023-08-01' AND match_date IS NOT NULL
                GROUP BY ym ORDER BY ym
            """):
                data.append(row)
        except Exception:
            pass

    if not data:
        fig, ax = plt.subplots(figsize=(10, 3))
        ax.text(0.5, 0.5, "(keine Daten)", ha="center", va="center", fontsize=12)
        ax.axis("off")
        return save_chart(fig, "05_timeline", tight=False)

    months = [d[0] for d in data]
    counts = [d[1] for d in data]
    # Color by season — using numeric x positions to avoid categorical issues
    xs = list(range(len(months)))
    season_colors = []
    for m in months:
        y, mo = int(m.split("-")[0]), int(m.split("-")[1])
        if (y == 2023 and mo >= 8) or (y == 2024 and mo <= 6):
            season_colors.append(GOLD_LIGHT)
        elif (y == 2024 and mo >= 7) or (y == 2025 and mo <= 6):
            season_colors.append(GOLD_MID)
        else:
            season_colors.append(GOLD)

    fig, ax = plt.subplots(figsize=(10, 3.5))
    ax.bar(xs, counts, color=season_colors, edgecolor=GOLD_DEEP, linewidth=0.4)
    ax.set_xticks(xs[::2])  # every other label to avoid crowding
    ax.set_xticklabels([months[i] for i in xs[::2]], rotation=45, ha="right", fontsize=7)
    ax.set_xlabel("Month", fontsize=9, color=TEXT)
    ax.set_ylabel("Match rows", fontsize=9, color=TEXT)
    ax.set_facecolor(SURFACE)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(colors=TEXT, labelsize=7)
    ax.grid(True, axis="y", linestyle="--", linewidth=0.3, color=GOLD_MID, alpha=0.4)
    ax.set_axisbelow(True)
    ax.set_title("team_xg_history Monthly Timeline (von 2023-08)",
                 color=LEATHER, fontsize=11, fontweight="bold", pad=8)
    legend_patches = [
        mpatches.Patch(color=GOLD_LIGHT, label="23/24"),
        mpatches.Patch(color=GOLD_MID, label="24/25"),
        mpatches.Patch(color=GOLD, label="25/26"),
    ]
    ax.legend(handles=legend_patches, loc="upper left", fontsize=7, framealpha=0.9)
    return save_chart(fig, "05_timeline", tight=False)


def chart_sofa_extras_breakdown(table_counts: dict[str, int]) -> Path:
    """Bar chart of Sofa extras tables by row count."""
    sofa_tables = {k: v for k, v in table_counts.items() if k.startswith("sofascore_")
                   and k not in ("sofascore_match", "sofascore_player_match_stats")}
    sofa_tables = dict(sorted(sofa_tables.items(), key=lambda x: -x[1]))

    fig, ax = plt.subplots(figsize=(10, 5))
    names = [n.replace("sofascore_", "") for n in sofa_tables.keys()]
    counts = list(sofa_tables.values())
    bars = ax.bar(names, counts, color=VALUE, edgecolor=GREEN, linewidth=0.5)
    for bar, c in zip(bars, counts):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() * 1.02,
                f"{c:,}", ha="center", color=TEXT, fontsize=8, weight="bold")
    ax.set_ylabel("Rows", color=TEXT, fontsize=9)
    plt.xticks(rotation=20, ha="right", fontsize=8)
    _fodze_chart_style(ax, "Sofa Extras Tables — Row Counts")
    fig.tight_layout()
    return save_chart(fig, "06_sofa_extras", tight=False)


# ═══════════════════════════════════════════════════════════════════════
# DEEP-DIVE CHARTS — team_xg_history
# ═══════════════════════════════════════════════════════════════════════

def chart_xg_xga_distribution(conn: sqlite3.Connection | None) -> Path:
    """Side-by-side histograms of xG and xGA distributions."""
    plt.close("all")
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4))

    if conn is None:
        ax1.text(0.5, 0.5, "no data", ha="center")
        return save_chart(fig, "07_xg_dist", tight=False)

    xgs = [r[0] for r in conn.execute(
        "SELECT xg FROM team_xg_history WHERE xg IS NOT NULL AND xg < 6.0"
    )]
    xgas = [r[0] for r in conn.execute(
        "SELECT xga FROM team_xg_history WHERE xga IS NOT NULL AND xga < 6.0"
    )]

    # xG histogram (left)
    n1, bins1, patches1 = ax1.hist(xgs, bins=40, color=GOLD, edgecolor=GOLD_DEEP, linewidth=0.4)
    ax1.axvline(np.mean(xgs), color=WARN, linewidth=1.5, linestyle="--", label=f"μ = {np.mean(xgs):.2f}")
    ax1.axvline(np.median(xgs), color=VALUE, linewidth=1.5, linestyle="--", label=f"median = {np.median(xgs):.2f}")
    ax1.set_xlabel("xG pro Match", fontsize=9, color=TEXT)
    ax1.set_ylabel("Häufigkeit", fontsize=9, color=TEXT)
    ax1.legend(fontsize=8, framealpha=0.9)
    _fodze_chart_style(ax1, "xG-Verteilung (team_xg_history)")

    # xGA histogram (right)
    n2, bins2, patches2 = ax2.hist(xgas, bins=40, color=INFO, edgecolor="#3a7090", linewidth=0.4)
    ax2.axvline(np.mean(xgas), color=WARN, linewidth=1.5, linestyle="--", label=f"μ = {np.mean(xgas):.2f}")
    ax2.axvline(np.median(xgas), color=VALUE, linewidth=1.5, linestyle="--", label=f"median = {np.median(xgas):.2f}")
    ax2.set_xlabel("xGA pro Match", fontsize=9, color=TEXT)
    ax2.set_ylabel("Häufigkeit", fontsize=9, color=TEXT)
    ax2.legend(fontsize=8, framealpha=0.9)
    _fodze_chart_style(ax2, "xGA-Verteilung")

    fig.suptitle(f"team_xg_history · n={len(xgs):,}", fontsize=10, color=LEATHER, y=1.02)
    return save_chart(fig, "07_xg_dist", tight=False)


def chart_xg_per_league(conn: sqlite3.Connection | None) -> Path:
    """Per-league count + mean xG."""
    plt.close("all")
    if conn is None:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no data", ha="center")
        return save_chart(fig, "08_per_league", tight=False)

    data = list(conn.execute("""
        SELECT league, COUNT(*) as n, AVG(xg) as avg_xg
        FROM team_xg_history WHERE xg IS NOT NULL
        GROUP BY league ORDER BY n DESC LIMIT 20
    """))
    leagues = [r[0] for r in data]
    counts = [r[1] for r in data]
    avgs = [r[2] for r in data]

    fig, ax1 = plt.subplots(figsize=(11, 5.5))
    bars = ax1.bar(leagues, counts, color=GOLD, edgecolor=GOLD_DEEP, linewidth=0.4, alpha=0.7,
                   label="Row Count")
    ax1.set_xlabel("Liga", fontsize=9, color=TEXT)
    ax1.set_ylabel("Anzahl Rows", fontsize=9, color=GOLD_DEEP)
    ax1.tick_params(axis="y", colors=GOLD_DEEP, labelsize=8)
    plt.xticks(rotation=45, ha="right", fontsize=7)
    for bar, c in zip(bars, counts):
        ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() * 1.01,
                 f"{c:,}", ha="center", color=TEXT, fontsize=7, weight="bold")

    # Mean xG as line overlay
    ax2 = ax1.twinx()
    ax2.plot(leagues, avgs, color=VALUE, marker="o", linewidth=1.5,
             markersize=5, markeredgecolor=GREEN, label="ø xG")
    ax2.set_ylabel("Mean xG", fontsize=9, color=GREEN)
    ax2.tick_params(axis="y", colors=GREEN, labelsize=8)
    ax2.set_ylim(0.5, max(avgs) * 1.15)

    ax1.set_facecolor(SURFACE)
    ax1.spines["top"].set_visible(False)
    ax2.spines["top"].set_visible(False)
    ax1.grid(True, axis="y", linestyle="--", linewidth=0.3, color=GOLD_MID, alpha=0.4)
    ax1.set_axisbelow(True)
    ax1.set_title("team_xg_history · Per-Liga Row Count + Mean xG (Top 20)",
                  color=LEATHER, fontsize=11, fontweight="bold", pad=10)
    # combined legend
    h1, l1 = ax1.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax1.legend(h1 + h2, l1 + l2, loc="upper right", fontsize=8, framealpha=0.9)
    fig.subplots_adjust(bottom=0.25)
    return save_chart(fig, "08_per_league", tight=False)


def chart_xg_source_season(conn: sqlite3.Connection | None) -> Path:
    """Source × season stacked bar."""
    plt.close("all")
    if conn is None:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no data", ha="center")
        return save_chart(fig, "09_source_season", tight=False)

    data = list(conn.execute("""
        SELECT
          CASE
            WHEN match_date >= '2025-07-01' THEN '25/26'
            WHEN match_date >= '2024-07-01' THEN '24/25'
            WHEN match_date >= '2023-07-01' THEN '23/24'
            WHEN match_date >= '2022-07-01' THEN '22/23'
            WHEN match_date >= '2021-07-01' THEN '21/22'
            ELSE 'older'
          END as season,
          source,
          COUNT(*) as n
        FROM team_xg_history
        WHERE match_date IS NOT NULL
        GROUP BY season, source
    """))

    seasons = ["older", "21/22", "22/23", "23/24", "24/25", "25/26"]
    sources = sorted(set(r[1] for r in data))
    matrix = {sea: {s: 0 for s in sources} for sea in seasons}
    for row in data:
        if row[0] in matrix:
            matrix[row[0]][row[1]] = row[2]

    fig, ax = plt.subplots(figsize=(10, 5))
    bottoms = np.zeros(len(seasons))
    for src in sources:
        vals = [matrix[s][src] for s in seasons]
        ax.bar(seasons, vals, bottom=bottoms,
               color=SOURCE_COLORS.get(src, "#888"), label=src,
               edgecolor="white", linewidth=0.4)
        bottoms += vals

    for i, sea in enumerate(seasons):
        total = bottoms[i]
        if total > 0:
            ax.text(i, total * 1.01, f"{int(total):,}",
                    ha="center", fontsize=8, color=TEXT, weight="bold")

    ax.set_xlabel("Season", fontsize=9, color=TEXT)
    ax.set_ylabel("Rows", fontsize=9, color=TEXT)
    ax.legend(loc="upper left", fontsize=7, framealpha=0.9)
    _fodze_chart_style(ax, "team_xg_history · Source × Season Stacked")
    return save_chart(fig, "09_source_season", tight=False)


# ═══════════════════════════════════════════════════════════════════════
# DEEP-DIVE CHARTS — sofascore_shotmap
# ═══════════════════════════════════════════════════════════════════════

def chart_shotmap_xg_distribution(conn: sqlite3.Connection | None) -> Path:
    """Per-shot xG distribution (log-y because most shots are low-xG)."""
    plt.close("all")
    if conn is None:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no shotmap", ha="center")
        return save_chart(fig, "10_shot_xg_dist", tight=False)

    xgs = [r[0] for r in conn.execute(
        "SELECT xg FROM sofascore_shotmap WHERE xg IS NOT NULL AND xg > 0"
    )]
    if not xgs:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no xG data", ha="center")
        return save_chart(fig, "10_shot_xg_dist", tight=False)

    fig, ax = plt.subplots(figsize=(11, 4.5))
    ax.hist(xgs, bins=50, color=VALUE, edgecolor=GREEN, linewidth=0.4)
    ax.set_yscale("log")
    mean_xg = np.mean(xgs)
    median_xg = np.median(xgs)
    ax.axvline(mean_xg, color=WARN, linewidth=1.5, linestyle="--", label=f"μ = {mean_xg:.3f}")
    ax.axvline(median_xg, color=GOLD_DEEP, linewidth=1.5, linestyle="--",
               label=f"median = {median_xg:.3f}")
    ax.axvline(0.5, color=INFO, linewidth=1, linestyle=":", alpha=0.7,
               label="0.5 (high-quality threshold)")
    ax.set_xlabel("xG pro Shot", fontsize=9, color=TEXT)
    ax.set_ylabel("Anzahl Shots (log-scale)", fontsize=9, color=TEXT)
    ax.legend(fontsize=8, framealpha=0.9)
    _fodze_chart_style(ax, f"sofascore_shotmap · xG-Verteilung (n={len(xgs):,} shots)")
    return save_chart(fig, "10_shot_xg_dist", tight=False)


def chart_shotmap_pie(conn: sqlite3.Connection | None, column: str,
                      title: str, name: str) -> Path:
    """Generic pie chart for shotmap categorical columns."""
    plt.close("all")
    if conn is None:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no shotmap", ha="center")
        return save_chart(fig, name, tight=False)

    data = list(conn.execute(
        f"SELECT {column}, COUNT(*) FROM sofascore_shotmap "
        f"WHERE {column} IS NOT NULL GROUP BY {column} ORDER BY 2 DESC LIMIT 10"
    ))
    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, f"no {column} data", ha="center")
        return save_chart(fig, name, tight=False)

    labels = [r[0] for r in data]
    sizes = [r[1] for r in data]
    total = sum(sizes)

    palette = [GOLD, VALUE, INFO, GOLD_MID, "#e0a070", "#a07060", "#9090a0",
               "#806050", "#c2a865", "#5a8aae"]

    fig, ax = plt.subplots(figsize=(9, 5))
    wedges, texts, autotexts = ax.pie(
        sizes,
        labels=[f"{l}\n{v:,} ({100*v/total:.1f}%)" for l, v in zip(labels, sizes)],
        colors=palette[:len(labels)],
        autopct=lambda p: f"{p:.0f}%" if p > 5 else "",
        startangle=90,
        wedgeprops=dict(edgecolor="white", linewidth=1.5),
        textprops=dict(fontsize=8, color=TEXT),
    )
    for at in autotexts:
        at.set_color("white")
        at.set_fontweight("bold")
        at.set_fontsize(9)
    ax.set_title(title, color=LEATHER, fontsize=12, weight="bold", pad=10)
    return save_chart(fig, name, tight=False)


def chart_shotmap_pitch_heatmap(conn: sqlite3.Connection | None) -> Path:
    """KDE heatmap of shot locations on football pitch."""
    plt.close("all")
    if conn is None:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no shotmap", ha="center")
        return save_chart(fig, "11_pitch_heatmap", tight=False)

    # Sample 50k shots for performance
    data = list(conn.execute("""
        SELECT shooter_x, shooter_y FROM sofascore_shotmap
        WHERE shooter_x IS NOT NULL AND shooter_y IS NOT NULL
          AND shooter_x BETWEEN 0 AND 100 AND shooter_y BETWEEN 0 AND 100
        LIMIT 50000
    """))
    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no coordinates", ha="center")
        return save_chart(fig, "11_pitch_heatmap", tight=False)

    xs = np.array([r[0] for r in data])
    ys = np.array([r[1] for r in data])

    fig, ax = plt.subplots(figsize=(10, 7))
    # Pitch outline (Sofa coords: x=0 at goal-line, increasing forward; y=0-100 width)
    # We draw a half-pitch (attacking) — most shots are 60-100 x range
    pitch_color = "#3a7d2a"
    line_color = "white"

    # Background pitch
    ax.add_patch(plt.Rectangle((0, 0), 100, 100, color=pitch_color, alpha=0.95))

    # Center line + boxes (Sofa coords)
    ax.plot([50, 50], [0, 100], color=line_color, linewidth=1, alpha=0.7)
    # Right penalty area (attacking goal at x=100, y=50)
    ax.plot([83, 100], [22, 22], color=line_color, linewidth=1, alpha=0.7)
    ax.plot([83, 100], [78, 78], color=line_color, linewidth=1, alpha=0.7)
    ax.plot([83, 83], [22, 78], color=line_color, linewidth=1, alpha=0.7)
    # Right 6-yard box
    ax.plot([94, 100], [38, 38], color=line_color, linewidth=1, alpha=0.7)
    ax.plot([94, 100], [62, 62], color=line_color, linewidth=1, alpha=0.7)
    ax.plot([94, 94], [38, 62], color=line_color, linewidth=1, alpha=0.7)
    # Penalty spot
    ax.plot(89, 50, 'wo', markersize=3)
    # Goal posts
    ax.plot([100, 100], [44, 56], color=line_color, linewidth=3, alpha=0.9)
    # Pitch boundary
    ax.add_patch(plt.Rectangle((0, 0), 100, 100, fill=False, edgecolor=line_color, linewidth=2))

    # Hexbin heatmap of shot density (only x > 40 = attacking half)
    hb = ax.hexbin(xs, ys, gridsize=40, cmap="YlOrRd", mincnt=1, alpha=0.7,
                   extent=(0, 100, 0, 100))
    cbar = plt.colorbar(hb, ax=ax, shrink=0.7, label="Shot count")
    cbar.ax.tick_params(labelsize=8)

    ax.set_xlim(-2, 102)
    ax.set_ylim(-2, 102)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(f"sofascore_shotmap · Shot Locations Heatmap (n={len(xs):,} shots)",
                 color=LEATHER, fontsize=12, weight="bold", pad=10)
    # Sofa coord-system note
    ax.text(50, -6, "Sofa-koords: x=0 (own goal) → x=100 (target goal) · y=0-100 width",
            ha="center", fontsize=8, color=MUTED, style="italic")

    return save_chart(fig, "11_pitch_heatmap", tight=False)


def chart_shotmap_conversion_by_situation(conn: sqlite3.Connection | None) -> Path:
    """Bar chart: avg-xG + actual-conversion per situation."""
    plt.close("all")
    if conn is None:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no shotmap", ha="center")
        return save_chart(fig, "12_situation_conv", tight=False)

    # Note: shotmap doesn't have a direct "is_goal" — we'd need to join incidents.
    # Approximate: shots with xg > 0.5 are likely goals; use avg-xG as proxy.
    data = list(conn.execute("""
        SELECT situation, COUNT(*), AVG(xg), AVG(xgot)
        FROM sofascore_shotmap
        WHERE situation IS NOT NULL AND xg IS NOT NULL
        GROUP BY situation ORDER BY 2 DESC LIMIT 8
    """))
    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no situation data", ha="center")
        return save_chart(fig, "12_situation_conv", tight=False)

    situations = [r[0] for r in data]
    counts = [r[1] for r in data]
    avg_xgs = [r[2] for r in data]
    avg_xgots = [r[3] if r[3] is not None else 0 for r in data]

    fig, ax1 = plt.subplots(figsize=(11, 5))
    x_pos = np.arange(len(situations))
    width = 0.35
    bars1 = ax1.bar(x_pos - width/2, avg_xgs, width, color=GOLD, edgecolor=GOLD_DEEP,
                    linewidth=0.4, label="ø xG")
    bars2 = ax1.bar(x_pos + width/2, avg_xgots, width, color=VALUE, edgecolor=GREEN,
                    linewidth=0.4, label="ø xGOT (post-shot)")
    for b1, b2, v1, v2 in zip(bars1, bars2, avg_xgs, avg_xgots):
        ax1.text(b1.get_x() + b1.get_width()/2, b1.get_height() * 1.02,
                 f"{v1:.3f}", ha="center", fontsize=7, color=TEXT)
        if v2 > 0:
            ax1.text(b2.get_x() + b2.get_width()/2, b2.get_height() * 1.02,
                     f"{v2:.3f}", ha="center", fontsize=7, color=TEXT)
    ax1.set_xticks(x_pos)
    ax1.set_xticklabels(situations, rotation=20, ha="right", fontsize=8)
    ax1.set_xlabel("Situation", fontsize=9, color=TEXT)
    ax1.set_ylabel("Mean xG / xGOT", fontsize=9, color=TEXT)
    ax1.legend(loc="upper right", fontsize=9, framealpha=0.9)
    _fodze_chart_style(ax1, "Shot-Quality per Situation · sofascore_shotmap")

    # Annotation
    ax1.text(0, max(max(avg_xgs), max(avg_xgots)) * 1.15,
             f"Sample-Sizes: " + " · ".join(f"{s}={c:,}" for s, c in zip(situations[:5], counts[:5])),
             fontsize=7, color=MUTED, style="italic")
    fig.subplots_adjust(bottom=0.2)
    return save_chart(fig, "12_situation_conv", tight=False)


# ═══════════════════════════════════════════════════════════════════════
# DEEP-DIVE CHARTS — sofascore_match_statistics
# ═══════════════════════════════════════════════════════════════════════

def _fetch_match_stats_sample(supa: Supabase, limit: int = 5000) -> list[dict]:
    """Fetch sample of match_statistics ALL-period rows."""
    cols = "ball_possession_pct,total_shots,shots_on_target,big_chances,expected_goals,corners,passes,fouls,yellow_cards,red_cards,is_home"
    status, body, _ = supa._request(
        f"sofascore_match_statistics?select={cols}&period=eq.ALL&limit={limit}")
    if status != 200:
        return []
    try:
        return json.loads(body)
    except Exception:
        return []


def chart_match_stats_distributions(supa: Supabase) -> Path:
    """4-panel histograms of key team-stats: possession, total_shots, big_chances, xG."""
    plt.close("all")
    data = _fetch_match_stats_sample(supa, limit=5000)
    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no match_statistics data", ha="center")
        return save_chart(fig, "14_stats_dist", tight=False)

    fig, axes = plt.subplots(2, 2, figsize=(11, 7))

    metrics = [
        ("ball_possession_pct", "Ballbesitz %", GOLD, GOLD_DEEP, [0, 100]),
        ("total_shots",         "Total Shots / Match", VALUE, GREEN, [0, 30]),
        ("big_chances",         "Big Chances / Match", INFO, "#3a7090", [0, 10]),
        ("expected_goals",      "Sofa Expected Goals", "#e0a070", "#a07050", [0, 5]),
    ]
    for ax, (col, label, color, edge, xlim) in zip(axes.flatten(), metrics):
        vals = [r.get(col) for r in data if r.get(col) is not None]
        if not vals:
            ax.text(0.5, 0.5, f"no {col}", ha="center")
            continue
        ax.hist(vals, bins=30, color=color, edgecolor=edge, linewidth=0.4)
        m = np.mean(vals)
        med = np.median(vals)
        ax.axvline(m, color=WARN, linewidth=1.2, linestyle="--", label=f"μ={m:.1f}")
        ax.axvline(med, color="#3a7d2a", linewidth=1.2, linestyle="--", label=f"med={med:.1f}")
        ax.set_xlim(xlim)
        ax.set_xlabel(label, fontsize=8, color=TEXT)
        ax.set_ylabel("Count", fontsize=8, color=TEXT)
        ax.legend(fontsize=7, framealpha=0.9)
        _fodze_chart_style(ax, label)

    fig.suptitle(f"sofascore_match_statistics · Verteilungen (sample n={len(data):,})",
                 fontsize=12, color=LEATHER, weight="bold", y=1.00)
    fig.tight_layout()
    return save_chart(fig, "14_stats_dist", tight=False)


def chart_match_stats_shots_vs_xg(supa: Supabase) -> Path:
    """Scatter: total_shots vs expected_goals (with home vs away color)."""
    plt.close("all")
    data = _fetch_match_stats_sample(supa, limit=3000)
    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no data", ha="center")
        return save_chart(fig, "15_shots_xg", tight=False)

    # Split home vs away
    home_x, home_y, away_x, away_y = [], [], [], []
    for r in data:
        if r.get("total_shots") is None or r.get("expected_goals") is None:
            continue
        if r.get("is_home"):
            home_x.append(r["total_shots"])
            home_y.append(r["expected_goals"])
        else:
            away_x.append(r["total_shots"])
            away_y.append(r["expected_goals"])

    fig, ax = plt.subplots(figsize=(10, 6))
    ax.scatter(home_x, home_y, color=GOLD, alpha=0.4, s=15, edgecolors="none",
               label=f"Home (n={len(home_x):,})")
    ax.scatter(away_x, away_y, color=INFO, alpha=0.4, s=15, edgecolors="none",
               label=f"Away (n={len(away_x):,})")

    # Trend line
    all_x = np.array(home_x + away_x)
    all_y = np.array(home_y + away_y)
    if len(all_x) > 10:
        coeffs = np.polyfit(all_x, all_y, 1)
        trend_x = np.linspace(0, max(all_x), 100)
        trend_y = np.polyval(coeffs, trend_x)
        # Correlation
        corr = np.corrcoef(all_x, all_y)[0, 1]
        ax.plot(trend_x, trend_y, color=WARN, linewidth=1.5, linestyle="--",
                label=f"trend (r={corr:.3f})")

    ax.set_xlabel("Total Shots", fontsize=9, color=TEXT)
    ax.set_ylabel("Expected Goals (Sofa)", fontsize=9, color=TEXT)
    ax.legend(fontsize=9, framealpha=0.9, loc="upper left")
    _fodze_chart_style(ax, "Shots vs xG · sofascore_match_statistics (ALL period)")
    return save_chart(fig, "15_shots_xg", tight=False)


def chart_match_stats_home_away_diff(supa: Supabase) -> Path:
    """Bar comparison: home vs away avg stats."""
    plt.close("all")
    data = _fetch_match_stats_sample(supa, limit=8000)
    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no data", ha="center")
        return save_chart(fig, "16_home_away", tight=False)

    metrics = ["ball_possession_pct", "total_shots", "shots_on_target",
               "big_chances", "corners", "passes", "fouls", "expected_goals"]

    home_avgs, away_avgs = {}, {}
    for m in metrics:
        home_vals = [r.get(m) for r in data if r.get("is_home") and r.get(m) is not None]
        away_vals = [r.get(m) for r in data if not r.get("is_home") and r.get(m) is not None]
        if home_vals:
            home_avgs[m] = np.mean(home_vals)
        if away_vals:
            away_avgs[m] = np.mean(away_vals)

    common = [m for m in metrics if m in home_avgs and m in away_avgs]
    fig, ax = plt.subplots(figsize=(11, 5))
    x_pos = np.arange(len(common))
    width = 0.38
    home_vals = [home_avgs[m] for m in common]
    away_vals = [away_avgs[m] for m in common]
    b1 = ax.bar(x_pos - width/2, home_vals, width, color=GOLD, edgecolor=GOLD_DEEP,
                label="Home")
    b2 = ax.bar(x_pos + width/2, away_vals, width, color=INFO, edgecolor="#3a7090",
                label="Away")
    for bar, v in zip(b1, home_vals):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() * 1.01,
                f"{v:.1f}", ha="center", fontsize=7, color=TEXT, weight="bold")
    for bar, v in zip(b2, away_vals):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() * 1.01,
                f"{v:.1f}", ha="center", fontsize=7, color=TEXT, weight="bold")
    ax.set_xticks(x_pos)
    ax.set_xticklabels([m.replace("_", " ") for m in common], rotation=20, ha="right", fontsize=7)
    ax.set_ylabel("Mean / Match", fontsize=9, color=TEXT)
    ax.legend(loc="upper right", fontsize=9, framealpha=0.9)
    _fodze_chart_style(ax, "Home vs Away · ø Team Stats per Match")
    fig.subplots_adjust(bottom=0.2)
    return save_chart(fig, "16_home_away", tight=False)


# ═══════════════════════════════════════════════════════════════════════
# DEEP-DIVE CHARTS — live_brier_snapshots
# ═══════════════════════════════════════════════════════════════════════

def chart_brier_timeline(supa: Supabase) -> Path:
    """Time series of Brier 1X2 per engine (overall)."""
    plt.close("all")
    status, body, _ = supa._request(
        "live_brier_snapshots?select=window_end_date,engine,brier_1x2,brier_o25,n"
        "&league=eq.__overall&order=window_end_date.asc&limit=500"
    )
    if status != 200:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no brier data", ha="center")
        return save_chart(fig, "17_brier_timeline", tight=False)

    try:
        data = json.loads(body)
    except Exception:
        data = []

    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no brier data", ha="center")
        return save_chart(fig, "17_brier_timeline", tight=False)

    # Group by engine
    engines: dict[str, list[tuple[str, float]]] = {}
    for r in data:
        e = r.get("engine")
        d = r.get("window_end_date")
        b = r.get("brier_1x2")
        if e and d and b is not None:
            engines.setdefault(e, []).append((d, b))

    fig, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True)
    palette = {"ensemble": GOLD, "poisson-ml": VALUE, "poisson-ml-v2": INFO,
               "poisson-ml-v3": "#a07060", "footbayes-hierarchical": WARN}

    # Top: Brier 1X2
    ax = axes[0]
    for e, pts in engines.items():
        pts.sort()
        dates = [p[0] for p in pts]
        vals = [p[1] for p in pts]
        ax.plot(dates, vals, marker="o", markersize=4, linewidth=1.2,
                color=palette.get(e, "#888"), label=e)
    ax.set_ylabel("Brier 1X2 (lower=better)", fontsize=9, color=TEXT)
    ax.legend(loc="upper right", fontsize=8, framealpha=0.9)
    _fodze_chart_style(ax, "Live Brier Score · 1X2 Outcome (lower = besser)")

    # Bottom: Brier O25
    ax = axes[1]
    engines_o25: dict[str, list[tuple[str, float]]] = {}
    for r in data:
        e = r.get("engine")
        d = r.get("window_end_date")
        b = r.get("brier_o25")
        if e and d and b is not None:
            engines_o25.setdefault(e, []).append((d, b))
    for e, pts in engines_o25.items():
        pts.sort()
        dates = [p[0] for p in pts]
        vals = [p[1] for p in pts]
        ax.plot(dates, vals, marker="s", markersize=4, linewidth=1.2,
                color=palette.get(e, "#888"), label=e)
    ax.set_ylabel("Brier O25 (lower=better)", fontsize=9, color=TEXT)
    ax.set_xlabel("Date", fontsize=9, color=TEXT)
    ax.tick_params(axis="x", rotation=45, labelsize=7)
    ax.legend(loc="upper right", fontsize=8, framealpha=0.9)
    _fodze_chart_style(ax, "Live Brier Score · Over 2.5 Goals")

    fig.tight_layout()
    return save_chart(fig, "17_brier_timeline", tight=False)


def chart_brier_per_engine_avg(supa: Supabase) -> Path:
    """Average Brier per engine (overall) — bar chart for direct comparison."""
    plt.close("all")
    status, body, _ = supa._request(
        "live_brier_snapshots?select=engine,brier_1x2,brier_o25,n"
        "&league=eq.__overall&limit=500"
    )
    if status != 200:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no brier", ha="center")
        return save_chart(fig, "18_brier_avg", tight=False)

    try:
        data = json.loads(body)
    except Exception:
        data = []
    if not data:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "no brier data", ha="center")
        return save_chart(fig, "18_brier_avg", tight=False)

    by_engine: dict[str, dict] = {}
    for r in data:
        e = r.get("engine")
        if not e:
            continue
        entry = by_engine.setdefault(e, {"b1x2": [], "bo25": [], "n_total": 0})
        if r.get("brier_1x2") is not None:
            entry["b1x2"].append(r["brier_1x2"])
        if r.get("brier_o25") is not None:
            entry["bo25"].append(r["brier_o25"])
        entry["n_total"] += r.get("n") or 0

    engines = sorted(by_engine.keys())
    mean_b1x2 = [np.mean(by_engine[e]["b1x2"]) if by_engine[e]["b1x2"] else 0
                 for e in engines]
    mean_bo25 = [np.mean(by_engine[e]["bo25"]) if by_engine[e]["bo25"] else 0
                 for e in engines]
    n_totals = [by_engine[e]["n_total"] for e in engines]

    fig, ax = plt.subplots(figsize=(11, 5))
    x_pos = np.arange(len(engines))
    width = 0.38
    b1 = ax.bar(x_pos - width/2, mean_b1x2, width, color=GOLD, edgecolor=GOLD_DEEP,
                label="ø Brier 1X2")
    b2 = ax.bar(x_pos + width/2, mean_bo25, width, color=VALUE, edgecolor=GREEN,
                label="ø Brier O25")
    for bar, v in zip(b1, mean_b1x2):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.005,
                f"{v:.3f}", ha="center", fontsize=8, color=TEXT, weight="bold")
    for bar, v in zip(b2, mean_bo25):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.005,
                f"{v:.3f}", ha="center", fontsize=8, color=TEXT, weight="bold")
    # Sample-size annotations
    for i, n in enumerate(n_totals):
        ax.text(i, -0.05, f"Σn={n}", ha="center", fontsize=7, color=MUTED)
    ax.set_xticks(x_pos)
    ax.set_xticklabels(engines, rotation=15, ha="right", fontsize=8)
    ax.set_ylabel("ø Brier Score (lower = better)", fontsize=9, color=TEXT)
    ax.legend(loc="upper right", fontsize=9, framealpha=0.9)
    _fodze_chart_style(ax, "ø Brier Score per Engine · live_brier_snapshots")
    fig.subplots_adjust(bottom=0.2)
    return save_chart(fig, "18_brier_avg", tight=False)


# ═══════════════════════════════════════════════════════════════════════
# RELATIONSHIPS DIAGRAMS
# ═══════════════════════════════════════════════════════════════════════

def chart_detailed_relationships() -> Path:
    """Full FODZE schema network: 22 tables + their FK relationships,
    color-coded by category."""
    plt.close("all")
    fig, ax = plt.subplots(figsize=(13, 9))
    ax.set_xlim(0, 13)
    ax.set_ylim(0, 9)
    ax.axis("off")
    ax.set_facecolor(SURFACE)

    # Color per cluster
    CLUSTER_COLORS = {
        "sofa":   GOLD,             # Sofa pipeline
        "market": INFO,             # Market data + odds
        "engine": VALUE,            # Engine outputs
        "user":   "#a07060",        # User data
        "meta":   GOLD_MID,         # Reference metadata
    }

    # Node: (x, y, label, cluster, [secondary line below])
    NODES = {
        # SOFA cluster (TOP-LEFT)
        "sofascore_match":              (1.5, 8.0, "sofascore_match",        "sofa",   "PK: game_id"),
        "sofascore_shotmap":            (0.5, 6.8, "shotmap\n375k",          "sofa",   "FK: game_id"),
        "sofascore_match_statistics":   (1.5, 6.8, "match_stats\n85k",       "sofa",   "FK: game_id"),
        "sofascore_incidents":          (2.5, 6.8, "incidents\n304k",        "sofa",   "FK: game_id"),
        "sofascore_average_positions":  (0.5, 5.7, "avg_positions\n453k",    "sofa",   "FK: game_id"),
        "sofascore_match_managers":     (1.5, 5.7, "managers\n30k",          "sofa",   "FK: game_id"),
        "sofascore_pregame_form":       (2.5, 5.7, "pregame_form\n29k",      "sofa",   "FK: game_id"),
        "sofascore_team_streaks":       (0.5, 4.6, "team_streaks\n161k",     "sofa",   "FK: game_id"),
        "sofascore_extras_state":       (1.5, 4.6, "extras_state\n14k",      "sofa",   "PK: game_id"),

        # METADATA cluster (LEFT-CENTER)
        "team_metadata":                (0.5, 3.0, "team_metadata\n400+",   "meta",   "PK: team_name+league"),
        "player_xg_history":            (1.5, 3.0, "player_xg_history\n2.5k","meta",   "Top-5 Understat"),

        # MARKET cluster (TOP-RIGHT)
        "live_odds":                    (8.5, 8.0, "live_odds",              "market", "PK: match_key"),
        "upcoming_fixtures":            (10.0, 8.0, "upcoming_fixtures",     "market", "PK: match_key"),
        "matchdays":                    (11.5, 8.0, "matchdays",             "market", "PK: league+date"),
        "odds_closing_history":         (8.5, 6.8, "odds_closing_hist\n25k", "market", "PK: match_key"),
        "odds_snapshots":               (10.0, 6.8, "odds_snapshots",        "market", "TS-tracked"),

        # ENGINE cluster (CENTER-RIGHT)
        "team_xg_history":              (5.5, 5.5, "team_xg_history\n90k",  "engine", "Engine PRIMARY input"),
        "match_predictions":            (8.5, 5.0, "match_predictions",     "engine", "Pre-match snapshot"),
        "pipeline_shadow_log":          (10.0, 5.0, "pipeline_shadow_log",  "engine", "A/B engines logged"),
        "match_outcomes":               (8.5, 3.5, "match_outcomes",        "engine", "Post-match REALITY"),
        "live_brier_snapshots":         (11.0, 3.5, "live_brier_snapshots\n295", "engine", "Calibration tracking"),

        # USER cluster (BOTTOM-RIGHT)
        "profiles":                     (10.0, 1.8, "profiles",              "user",   "User data"),
        "bets":                         (8.5, 1.8, "bets",                   "user",   "User bets"),
    }

    # Relationships: (from_node, to_node, label, style)
    EDGES = [
        # Sofa → sofa_match: all extras FK to game_id
        ("sofascore_match", "sofascore_shotmap", "game_id", "fk"),
        ("sofascore_match", "sofascore_match_statistics", "game_id", "fk"),
        ("sofascore_match", "sofascore_incidents", "game_id", "fk"),
        ("sofascore_match", "sofascore_average_positions", "game_id", "fk"),
        ("sofascore_match", "sofascore_match_managers", "game_id", "fk"),
        ("sofascore_match", "sofascore_pregame_form", "game_id", "fk"),
        ("sofascore_match", "sofascore_team_streaks", "game_id", "fk"),
        ("sofascore_match", "sofascore_extras_state", "game_id", "fk"),

        # BRIDGES (process, not FK)
        ("sofascore_match_statistics", "team_xg_history", "bridge: 18 features", "bridge"),
        ("sofascore_match", "team_xg_history", "bridge: per-game xG", "bridge"),

        # Market data feeds team_xg_history + matchdays
        ("matchdays", "team_xg_history", "data.matches[]", "uses"),
        ("live_odds", "matchdays", "in matchday JSON", "uses"),

        # team_xg_history → engine outputs
        ("team_xg_history", "match_predictions", "Engine reads", "uses"),
        ("team_xg_history", "pipeline_shadow_log", "Engine reads", "uses"),
        ("matchdays", "match_predictions", "match metadata", "uses"),

        # Outcomes feedback
        ("match_outcomes", "live_brier_snapshots", "scored vs predictions", "uses"),
        ("match_predictions", "live_brier_snapshots", "score Brier", "uses"),

        # User flow
        ("profiles", "bets", "user_id", "fk"),
        ("matchdays", "bets", "match_key", "fk"),
        ("odds_closing_history", "bets", "closing_odds + CLV", "uses"),
        ("bets", "match_outcomes", "settle on result", "uses"),

        # team_metadata used everywhere
        ("team_metadata", "team_xg_history", "team canonicalize", "uses"),
        ("team_metadata", "matchdays", "logos + colors", "uses"),
    ]

    # Draw cluster background regions
    def cluster_bg(x, y, w, h, color, label):
        rect = FancyBboxPatch(
            (x, y), w, h,
            boxstyle="round,pad=0.05,rounding_size=0.2",
            linewidth=0.5, edgecolor=color, facecolor=color + "20",
        )
        ax.add_patch(rect)
        ax.text(x + 0.1, y + h - 0.2, label, fontsize=8, color=color,
                weight="bold", style="italic")

    cluster_bg(0.1, 4.2, 3.0, 4.4, GOLD,       "SOFA PIPELINE (game_id linked)")
    cluster_bg(0.1, 2.4, 2.4, 1.4, GOLD_MID,   "REFERENCE METADATA")
    cluster_bg(8.0, 6.2, 4.5, 2.4, INFO,       "MARKET DATA + ODDS")
    cluster_bg(4.5, 3.0, 7.2, 3.4, VALUE,      "ENGINE OUTPUTS + EVALUATION")
    cluster_bg(8.0, 1.0, 3.5, 1.6, "#a07060",  "USER DATA")

    # Draw edges first (so nodes overlay)
    for from_n, to_n, label, style in EDGES:
        if from_n not in NODES or to_n not in NODES:
            continue
        x1, y1 = NODES[from_n][:2]
        x2, y2 = NODES[to_n][:2]
        if style == "fk":
            color = MUTED
            ls = "-"
            alpha = 0.4
            lw = 0.7
        elif style == "bridge":
            color = "#a07060"
            ls = "--"
            alpha = 0.85
            lw = 1.5
        else:  # uses
            color = INFO
            ls = ":"
            alpha = 0.55
            lw = 0.9
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle="->", color=color, lw=lw,
                                    linestyle=ls, alpha=alpha,
                                    connectionstyle="arc3,rad=0.05"))

    # Draw nodes (over edges)
    for name, vals in NODES.items():
        x, y, label, cluster, sub = vals
        color = CLUSTER_COLORS[cluster]
        box = FancyBboxPatch(
            (x - 0.55, y - 0.22), 1.1, 0.44,
            boxstyle="round,pad=0.02,rounding_size=0.06",
            linewidth=0.8, edgecolor=color, facecolor="white",
        )
        ax.add_patch(box)
        ax.text(x, y + 0.05, label, ha="center", va="center",
                fontsize=6.5, color=LEATHER, weight="bold")
        ax.text(x, y - 0.13, sub, ha="center", va="center",
                fontsize=5, color=MUTED, style="italic")

    # Legend
    legend_y = 0.6
    ax.text(0.3, legend_y + 0.2, "Edge-Typen:", fontsize=8, color=LEATHER, weight="bold")
    ax.annotate("", xy=(2.0, legend_y), xytext=(0.3, legend_y),
                arrowprops=dict(arrowstyle="->", color=MUTED, lw=0.7, alpha=0.4))
    ax.text(2.1, legend_y, "FK (foreign key)", fontsize=7, color=MUTED, va="center")
    ax.annotate("", xy=(5.5, legend_y), xytext=(3.8, legend_y),
                arrowprops=dict(arrowstyle="->", color="#a07060", lw=1.5, linestyle="--"))
    ax.text(5.6, legend_y, "Bridge (script propagates)", fontsize=7, color="#a07060", va="center")
    ax.annotate("", xy=(9.7, legend_y), xytext=(8.5, legend_y),
                arrowprops=dict(arrowstyle="->", color=INFO, lw=0.9, linestyle=":"))
    ax.text(9.8, legend_y, "Uses (functional dep.)", fontsize=7, color=INFO, va="center")

    ax.set_title("FODZE Schema · Tables + Relationships",
                 color=LEATHER, fontsize=14, weight="bold", y=0.97)
    return save_chart(fig, "19_relationships_detailed", tight=False)


def chart_data_flow_simplified() -> Path:
    """Simplified end-to-end data flow: Source → Engine → User."""
    plt.close("all")
    fig, ax = plt.subplots(figsize=(13, 5.5))
    ax.set_xlim(0, 13)
    ax.set_ylim(0, 5.5)
    ax.axis("off")
    ax.set_facecolor(SURFACE)

    # Stage definitions: (x, y, w, h, label, sublabel, color)
    STAGES = [
        (0.2,  3.8, 2.0, 0.9, "Sofa API",          "curl_cffi + Webshare",      LEATHER),
        (2.8,  3.8, 2.0, 0.9, "JSON Checkpoints",  "10.8k files · 1.5GB",       GOLD_MID),
        (5.4,  3.8, 2.6, 0.9, "DB Tables",         "Supabase · SQLite mirror",  INFO),
        (8.6,  3.8, 2.4, 0.9, "team_xg_history",   "90k engine-rows",           VALUE),
        (11.4, 3.8, 1.4, 0.9, "Engine",            "Dixon-Coles + LGBM",        WARN),

        (5.4,  2.4, 2.6, 0.9, "Market Data",       "live_odds · matchdays",     INFO),
        (8.6,  2.4, 2.4, 0.9, "match_predictions", "per-engine snapshot",       VALUE),
        (11.4, 2.4, 1.4, 0.9, "FODZE App",         "/matchday UI",              GOLD),

        (5.4,  1.0, 2.6, 0.9, "User Action",       "Place bet",                 "#a07060"),
        (8.6,  1.0, 2.4, 0.9, "match_outcomes",    "Reality after kickoff",     VALUE),
        (11.4, 1.0, 1.4, 0.9, "Brier Score",       "Engine performance",        WARN),
    ]

    for x, y, w, h, label, sub, color in STAGES:
        box = FancyBboxPatch(
            (x, y), w, h,
            boxstyle="round,pad=0.05,rounding_size=0.12",
            linewidth=1.2, edgecolor=color, facecolor=color,
        )
        ax.add_patch(box)
        ax.text(x + w/2, y + h/2 + 0.15, label, ha="center", va="center",
                fontsize=10, color="white", weight="bold")
        ax.text(x + w/2, y + h/2 - 0.18, sub, ha="center", va="center",
                fontsize=7.5, color="white", alpha=0.95, style="italic")

    # Arrows for main flow (top row)
    def arrow(x1, y1, x2, y2, color=GOLD_DEEP, lw=2.0):
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle="->", color=color, lw=lw, mutation_scale=15))

    # Top row: Sofa → JSON → DB → team_xg_history → Engine
    arrow(2.2, 4.25, 2.8, 4.25)
    arrow(4.8, 4.25, 5.4, 4.25)
    arrow(8.0, 4.25, 8.6, 4.25)
    arrow(11.0, 4.25, 11.4, 4.25)

    # Middle row: Market → predictions → App
    arrow(8.0, 2.85, 8.6, 2.85)
    arrow(11.0, 2.85, 11.4, 2.85)

    # Vertical: Engine → predictions
    arrow(12.1, 3.8, 12.1, 3.3, color=VALUE, lw=2.0)
    # Engine + market converge at predictions
    arrow(8.0, 3.55, 8.6, 2.85, color=INFO, lw=1.4)

    # Bottom row: predictions → user action → outcomes → brier
    arrow(11.4, 2.85, 6.7, 1.45, color=GOLD, lw=1.2)  # App → User
    arrow(8.0, 1.45, 8.6, 1.45)                       # User → Outcomes
    arrow(11.0, 1.45, 11.4, 1.45)                     # Outcomes → Brier
    # Brier feeds back to engine evaluation
    arrow(12.1, 1.9, 12.1, 3.3, color=WARN, lw=1.0)

    # Labels for arrows
    ax.text(7.5, 4.5, "load_extras_to_supabase.py",
            ha="center", fontsize=7, color=MUTED, style="italic")
    ax.text(10.0, 4.5, "bridges (×2)",
            ha="center", fontsize=7, color="#a07060", weight="bold", style="italic")
    ax.text(9.8, 2.5, "join", ha="center", fontsize=7, color=MUTED, style="italic")
    ax.text(7.7, 2.1, "bet on prediction", ha="center", fontsize=7,
            color=MUTED, style="italic")
    ax.text(9.8, 1.1, "settle on result", ha="center", fontsize=7,
            color=MUTED, style="italic")
    ax.text(12.4, 2.7, "feedback", ha="center", fontsize=7, color=WARN,
            rotation=90, style="italic")

    ax.set_title("FODZE · End-to-End Data Flow",
                 color=LEATHER, fontsize=14, weight="bold", y=0.98)
    ax.text(6.5, 0.2, "Daten fließen links nach rechts in 3 horizontalen Schichten: "
                      "1) Ingestion · 2) Engine + UI · 3) Settlement + Evaluation",
            ha="center", fontsize=8, color=MUTED, style="italic")

    return save_chart(fig, "20_flow_simplified", tight=False)


def chart_match_outcomes_per_league(supa: Supabase) -> Path:
    """Per-league: Over 2.5 hit rate + Home Win rate."""
    plt.close("all")
    fig, ax = plt.subplots(figsize=(11, 5))

    leagues_to_check = ["bundesliga", "bundesliga2", "epl", "la_liga", "serie_a",
                        "ligue_1", "championship", "liga3", "eredivisie", "primeira_liga"]
    over25_rates = []
    home_win_rates = []
    counts = []
    valid_leagues = []

    for lg in leagues_to_check:
        # Over 2.5 rate
        total = supa.count("match_outcomes", where=f"league=eq.{lg}")
        if total < 50:
            continue
        over25 = supa.count("match_outcomes", where=f"league=eq.{lg}&over25=eq.true")
        home_wins = supa.count("match_outcomes", where=f"league=eq.{lg}&outcome_1x2=eq.H")
        over25_rates.append(100 * over25 / total)
        home_win_rates.append(100 * home_wins / total)
        counts.append(total)
        valid_leagues.append(lg)

    if not valid_leagues:
        ax.text(0.5, 0.5, "no match_outcomes data", ha="center")
        return save_chart(fig, "13_outcomes_per_league", tight=False)

    x_pos = np.arange(len(valid_leagues))
    width = 0.35
    bars1 = ax.bar(x_pos - width/2, over25_rates, width, color=VALUE, edgecolor=GREEN,
                   linewidth=0.4, label="Over 2.5 %")
    bars2 = ax.bar(x_pos + width/2, home_win_rates, width, color=GOLD, edgecolor=GOLD_DEEP,
                   linewidth=0.4, label="Home Win %")
    for b1, b2, v1, v2 in zip(bars1, bars2, over25_rates, home_win_rates):
        ax.text(b1.get_x() + b1.get_width()/2, b1.get_height() + 0.5,
                f"{v1:.0f}%", ha="center", fontsize=7, color=TEXT, weight="bold")
        ax.text(b2.get_x() + b2.get_width()/2, b2.get_height() + 0.5,
                f"{v2:.0f}%", ha="center", fontsize=7, color=TEXT, weight="bold")

    ax.set_xticks(x_pos)
    ax.set_xticklabels(valid_leagues, rotation=20, ha="right", fontsize=8)
    ax.set_xlabel("Liga", fontsize=9, color=TEXT)
    ax.set_ylabel("% von gespielten Matches", fontsize=9, color=TEXT)
    ax.set_ylim(0, 70)
    ax.axhline(50, color=INFO, linewidth=0.7, linestyle="--", alpha=0.6)
    ax.legend(loc="upper right", fontsize=9, framealpha=0.9)
    _fodze_chart_style(ax, "match_outcomes · Over 2.5 + Home Win Rate per Liga")
    return save_chart(fig, "13_outcomes_per_league", tight=False)


# ─── PDF builder ──────────────────────────────────────────────────────

def build_pdf(supa: Supabase, conn: sqlite3.Connection | None) -> None:
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
        Image, KeepTogether,
    )
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.colors import HexColor, white
    from reportlab.lib.units import cm
    from reportlab.lib.enums import TA_CENTER, TA_LEFT

    styles = getSampleStyleSheet()
    LEATHER_C = HexColor(LEATHER)
    GOLD_C    = HexColor(GOLD)
    GOLD_MID_C= HexColor(GOLD_MID)
    TEXT_C    = HexColor(TEXT)
    MUTED_C   = HexColor(MUTED)
    GREEN_C   = HexColor(GREEN)
    SURFACE_C = HexColor(SURFACE)
    CREAM_C   = HexColor(CREAM)
    WARN_C    = HexColor(WARN)
    VALUE_C   = HexColor(VALUE)

    h1 = ParagraphStyle("h1", parent=styles["Heading1"], textColor=LEATHER_C,
                        fontSize=20, leading=24, spaceAfter=10, spaceBefore=14)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], textColor=GOLD_MID_C,
                        fontSize=15, leading=18, spaceAfter=6, spaceBefore=12)
    h3 = ParagraphStyle("h3", parent=styles["Heading3"], textColor=LEATHER_C,
                        fontSize=11, leading=14, spaceAfter=4, spaceBefore=8)
    body = ParagraphStyle("body", parent=styles["BodyText"], textColor=TEXT_C,
                          fontSize=9.5, leading=13, spaceAfter=4)
    note = ParagraphStyle("note", parent=styles["BodyText"], textColor=MUTED_C,
                          fontSize=8.5, leading=11, spaceAfter=4)
    small = ParagraphStyle("small", parent=styles["BodyText"], textColor=MUTED_C,
                           fontSize=7.5, leading=10, spaceAfter=2)
    kpi_label = ParagraphStyle("kpi_label", parent=styles["BodyText"], textColor=MUTED_C,
                               fontSize=9, leading=11, alignment=TA_CENTER, spaceAfter=2)
    kpi_value = ParagraphStyle("kpi_value", parent=styles["BodyText"], textColor=LEATHER_C,
                               fontSize=22, leading=26, alignment=TA_CENTER, fontName="Helvetica-Bold")

    doc = SimpleDocTemplate(
        str(OUTPUT_PDF), pagesize=A4,
        leftMargin=1.5*cm, rightMargin=1.5*cm, topMargin=1.5*cm, bottomMargin=1.5*cm,
        title="FODZE Data Dictionary",
    )

    elements: list = []

    # ─── COVER ─────────────────────────────────────────────────────
    elements.append(Spacer(1, 4*cm))
    elements.append(Paragraph(
        "FODZE",
        ParagraphStyle("cover_h", parent=styles["Heading1"], textColor=GOLD_C,
                       fontSize=54, alignment=TA_CENTER, leading=64)))
    elements.append(Paragraph(
        "Data Dictionary",
        ParagraphStyle("cover_h2", parent=styles["Heading1"], textColor=LEATHER_C,
                       fontSize=26, alignment=TA_CENTER, leading=32, spaceAfter=12)))
    elements.append(Paragraph(
        "Visualisierte Übersicht aller Datenbezeichnungen,<br/>"
        "Profile-Stats und Architektur",
        ParagraphStyle("cover_sub", parent=body, alignment=TA_CENTER,
                       fontSize=12, leading=18, textColor=MUTED_C)))
    elements.append(Spacer(1, 2.5*cm))

    table_count = sum(len(t) for t in CATALOG.values()) + len(LOCAL_TABLES)
    elements.append(Paragraph(
        f"<b>Generiert:</b> {datetime.now().strftime('%Y-%m-%d %H:%M')}<br/>"
        f"<b>Tabellen:</b> {table_count} dokumentiert<br/>"
        f"<b>Kategorien:</b> {len(CATALOG)}<br/>"
        f"<b>Storage Layers:</b> 3 (JSON · Local SQLite · Supabase)",
        ParagraphStyle("meta", parent=body, alignment=TA_CENTER,
                       fontSize=11, leading=18, textColor=TEXT_C)))
    elements.append(PageBreak())

    # ─── EXECUTIVE SUMMARY (KPIs + Architecture) ──────────────────
    elements.append(Paragraph("Executive Summary", h1))
    elements.append(Paragraph(
        "FODZE pflegt parallele Storage-Layer für Resilience + Performance. "
        "Die zentrale Engine-Eingabe-Tabelle <b>team_xg_history</b> wird aus 7 Quellen "
        "bridged + normalisiert; Sofascore-Pipeline liefert seit 2026-04 reichhaltige "
        "post-match Daten für 22 Ligen.",
        body))
    elements.append(Spacer(1, 16))

    # KPI cards
    team_xg_rows = 0
    if conn is not None:
        try:
            team_xg_rows = conn.execute("SELECT COUNT(*) FROM team_xg_history").fetchone()[0]
        except Exception:
            pass
    total_sofa_matches = supa.count("sofascore_match")
    total_shotmap = supa.count("sofascore_shotmap")
    total_extras_state = supa.count("sofascore_extras_state")

    kpi_data = [[
        [Paragraph("TEAM_XG_HISTORY", kpi_label),
         Paragraph(f"{team_xg_rows:,}", kpi_value),
         Paragraph("Engine-Input rows", small)],
        [Paragraph("SOFASCORE_MATCH", kpi_label),
         Paragraph(f"{total_sofa_matches:,}", kpi_value),
         Paragraph("unique games", small)],
        [Paragraph("SHOTMAP EVENTS", kpi_label),
         Paragraph(f"{total_shotmap:,}", kpi_value),
         Paragraph("per-shot rows", small)],
        [Paragraph("EXTRAS COVERAGE", kpi_label),
         Paragraph(f"{total_extras_state:,}", kpi_value),
         Paragraph("games with 7 endpoints", small)],
    ]]
    kpi_table = Table(kpi_data, colWidths=[4*cm, 4*cm, 4.5*cm, 4.5*cm], rowHeights=[3*cm])
    kpi_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CREAM_C),
        ("BOX", (0, 0), (-1, -1), 1, GOLD_C),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, GOLD_MID_C),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    elements.append(kpi_table)
    elements.append(Spacer(1, 16))

    # Architecture diagram
    arch_path = chart_storage_architecture()
    elements.append(Image(str(arch_path), width=18*cm, height=9*cm))
    elements.append(PageBreak())

    # ─── COVERAGE OVERVIEW ─────────────────────────────────────────
    elements.append(Paragraph("Coverage Overview", h1))
    elements.append(Paragraph(
        "Match-Daten-Coverage pro Liga × Saison aus <code>sofascore_match</code> Tabelle. "
        "Grünere Zellen = mehr Spiele erfasst. Leerzeilen = Saison noch nicht oder nicht vollständig backfilled.",
        body))
    elements.append(Spacer(1, 8))
    cov_path = chart_coverage_matrix(supa)
    elements.append(Image(str(cov_path), width=14*cm, height=15.7*cm))
    elements.append(PageBreak())

    # ─── RELATIONSHIPS & DATA FLOW ─────────────────────────────────
    elements.append(Paragraph("Relationships & Data Flow", h1))
    elements.append(Paragraph(
        "Wie hängen die Tabellen zusammen? Foreign-Key-Beziehungen + Bridge-Skripte + "
        "Functional-Dependencies. Drei verschiedene Beziehungs-Typen sind farb-kodiert:",
        body))
    elements.append(Paragraph(
        "<b>•</b> <b><font color='#5a4830'>FK (Foreign Key)</font></b> — Tabelle B referenziert ein PK-feld in Tabelle A "
        "(z.B. <code>sofascore_shotmap.game_id</code> → <code>sofascore_match.game_id</code>).<br/>"
        "<b>•</b> <b><font color='#a07060'>Bridge (script propagiert)</font></b> — Custom Node/Python-Skript liest Tabelle A "
        "und schreibt aggregierte/transformierte Daten in Tabelle B (z.B. bridge-sofascore-extras → team_xg_history).<br/>"
        "<b>•</b> <b><font color='#5a9ec4'>Uses (Functional dep.)</font></b> — Tabelle B wird beim Lesen / Joinen aus Tabelle A "
        "verwendet (kein erzwungener FK, aber logische Abhängigkeit).",
        note))
    elements.append(Spacer(1, 12))
    rels_path = chart_detailed_relationships()
    elements.append(Image(str(rels_path), width=18*cm, height=12.5*cm))
    elements.append(PageBreak())

    elements.append(Paragraph("Simplified Data Flow · End-to-End", h2))
    elements.append(Paragraph(
        "Aggregiertes Bild der wichtigsten Datenflüsse — von der Sofa-API über Bridges "
        "und Engine bis zum User-Action + Settlement + Performance-Feedback. Drei horizontale "
        "Schichten: <b>Ingestion</b> (oben) · <b>Engine + UI</b> (mitte) · <b>Settlement + "
        "Brier-Evaluation</b> (unten).",
        body))
    elements.append(Spacer(1, 8))
    flow_path = chart_data_flow_simplified()
    elements.append(Image(str(flow_path), width=18*cm, height=8*cm))
    elements.append(PageBreak())

    # ─── team_xg_history DEEP DIVE ─────────────────────────────────
    elements.append(Paragraph("Engine-Input Deep Dive: team_xg_history", h1))
    elements.append(Paragraph(
        "Dies ist die zentrale Tabelle die ALLE Engine-Vorhersagen speist. "
        "Multi-Source: Understat (Top-5 echte xG), FootyStats (22 Ligen baseline), "
        "Sofascore (per-game tactical features), goals-proxy (OpenLigaDB für DE), "
        "shots-model (calibrated CSV historisch), api-sports (Nebenligen).",
        body))
    elements.append(Spacer(1, 8))

    sources_path = chart_team_xg_sources(supa, conn)
    elements.append(Image(str(sources_path), width=15*cm, height=8.5*cm))
    elements.append(Spacer(1, 12))

    timeline_path = chart_xg_monthly_timeline(conn)
    elements.append(Image(str(timeline_path), width=18*cm, height=6*cm))
    elements.append(PageBreak())

    # ─── team_xg_history EXTENDED DEEP-DIVE ────────────────────────
    elements.append(Paragraph("team_xg_history · Extended Deep-Dive", h1))
    elements.append(Paragraph(
        "<b>xG / xGA Verteilung</b> — Mean ~1.4 (typische Pro-Match-Erwartung). "
        "Distribution ist rechts-skewed: viele 0.5-1.5 xG Matches, lange Tail bis 6+ xG "
        "(z.B. Bayern × Heidenheim Blowouts). Median liegt unter dem Mean → schwere "
        "Outlier ziehen Mean nach rechts.",
        body))
    elements.append(Spacer(1, 8))
    dist_path = chart_xg_xga_distribution(conn)
    elements.append(Image(str(dist_path), width=18*cm, height=6.5*cm))
    elements.append(Spacer(1, 12))

    elements.append(Paragraph(
        "<b>Per-Liga Row-Count + Mean xG</b> — Bars zeigen Sample-Size, Linie zeigt "
        "durchschnittliches xG. Top-5 Ligen haben höhere xG-Means (sharp markets, "
        "mehr Tor-Aktion). Lower-tier ligen wie liga3/jupiler_pro liegen niedriger.",
        body))
    elements.append(Spacer(1, 8))
    league_path = chart_xg_per_league(conn)
    elements.append(Image(str(league_path), width=18*cm, height=9*cm))
    elements.append(PageBreak())

    elements.append(Paragraph(
        "<b>Source × Season Stacked Bar</b> — Wer hat Daten für welche Saison geliefert. "
        "Understat (blau) historisch nur Top-5. FootyStats (gold) baseline für alle 22 Ligen. "
        "Sofascore (grün) neu seit 2026-05 für 3 Saisons.",
        body))
    elements.append(Spacer(1, 8))
    src_season_path = chart_xg_source_season(conn)
    elements.append(Image(str(src_season_path), width=18*cm, height=8.5*cm))
    elements.append(PageBreak())

    # ─── sofascore_shotmap DEEP-DIVE ───────────────────────────────
    elements.append(Paragraph("sofascore_shotmap · Deep-Dive", h1))
    elements.append(Paragraph(
        f"Per-shot Events — 274.404 Shots im lokalen Mirror. Jeder Shot hat: xG, xGOT, "
        f"Körperteil, Situation, Pitch-Koordinaten, Shooter-ID. Dies ist die RICHSTE "
        f"granulare Datenquelle für FODZE — bildet die Basis für tactical features.",
        body))
    elements.append(Spacer(1, 8))

    shot_xg_path = chart_shotmap_xg_distribution(conn)
    elements.append(Image(str(shot_xg_path), width=18*cm, height=7.5*cm))
    elements.append(Paragraph(
        "<i>Power-law-artige Verteilung: Mean ~0.1, Median ~0.05. 95% aller Shots haben "
        "xG &lt; 0.3 (typische Fern-/Halbchancen). Die seltenen high-xG-Shots (>0.5) sind "
        "die statistischen 'Big Chances'.</i>", note))
    elements.append(PageBreak())

    # Body-part + Situation pies side-by-side
    body_pie = chart_shotmap_pie(conn, "body_part",
                                   "Body Part Breakdown", "shotmap_body_pie")
    sit_pie = chart_shotmap_pie(conn, "situation",
                                  "Situation Breakdown", "shotmap_sit_pie")
    out_pie = chart_shotmap_pie(conn, "shot_type",
                                  "Shot Type Breakdown", "shotmap_outcome_pie")

    elements.append(Paragraph("Categorical Breakdowns", h2))
    elements.append(Paragraph(
        "Drei Kuchen-Diagramme zeigen Distribution der wichtigsten kategorialen Features.",
        body))
    elements.append(Spacer(1, 6))
    elements.append(Image(str(body_pie), width=16*cm, height=9*cm))
    elements.append(Spacer(1, 8))
    elements.append(Image(str(sit_pie), width=16*cm, height=9*cm))
    elements.append(PageBreak())

    # Pitch heatmap (showcase)
    elements.append(Paragraph("Shot Location Heatmap", h2))
    elements.append(Paragraph(
        "Hexbin-Heatmap der Schuss-Koordinaten auf dem Spielfeld. Konzentration im "
        "Strafraum bei 16er + 6er. Sofa-koords: x=0 ist eigenes Tor, x=100 das Ziel-Tor.",
        body))
    elements.append(Spacer(1, 8))
    pitch_path = chart_shotmap_pitch_heatmap(conn)
    elements.append(Image(str(pitch_path), width=18*cm, height=12.5*cm))
    elements.append(PageBreak())

    # Conversion by situation
    elements.append(Paragraph("Shot Quality per Situation", h2))
    elements.append(Paragraph(
        "Durchschnittliches xG + xGOT pro Situation. Penalty hat höchstes xG (~0.79). "
        "Open-play 'regular' Shots haben geringes xG (long-range distance shots). "
        "Corner-Shots liegen typisch bei 0.04-0.06 xG (Header from set-piece).",
        body))
    elements.append(Spacer(1, 8))
    sit_chart = chart_shotmap_conversion_by_situation(conn)
    elements.append(Image(str(sit_chart), width=18*cm, height=8.5*cm))
    elements.append(PageBreak())

    # ─── match_outcomes mini deep-dive ─────────────────────────────
    elements.append(Paragraph("match_outcomes · Per-Liga Patterns", h1))
    elements.append(Paragraph(
        "Aus historischen Match-Outcomes: wie oft fallen Over 2.5 Goals + wie oft "
        "gewinnt das Heimteam? Wichtige Liga-spezifische Baselines für Edge-Calculation. "
        "Bundesliga ist typischerweise hochskorend (~58% Over 2.5), Ligue 1 + Eredivisie "
        "ebenso. Liga3 / Championship eher torärmer.",
        body))
    elements.append(Spacer(1, 8))
    out_path = chart_match_outcomes_per_league(supa)
    elements.append(Image(str(out_path), width=18*cm, height=8.5*cm))
    elements.append(PageBreak())

    # ─── sofascore_match_statistics DEEP-DIVE ──────────────────────
    elements.append(Paragraph("sofascore_match_statistics · Deep-Dive", h1))
    elements.append(Paragraph(
        "Team-Level Match-Aggregates für Bridge zu team_xg_history. Pro Game zwei Rows "
        "(home/away) × 3 Perioden (ALL, 1ST, 2ND). Reichste Datenquelle für tactical features.",
        body))
    elements.append(Spacer(1, 8))

    stats_dist_path = chart_match_stats_distributions(supa)
    elements.append(Image(str(stats_dist_path), width=18*cm, height=11*cm))
    elements.append(Paragraph(
        "<i>4-Panel-Histogramme der wichtigsten team-stats. Possession ist annähernd normalverteilt "
        "(Mean ~50%, std-dev ~12pp). Total Shots rechts-skewed (typisch 10-15, lange Tail). "
        "Big chances rechts-skewed (Median 1-2, lange Tail bei dominanten Teams). xG distribution "
        "spiegelt team_xg_history.</i>", note))
    elements.append(PageBreak())

    elements.append(Paragraph("Shots vs xG · Korrelation", h2))
    elements.append(Paragraph(
        "Scatter-Plot zeigt Beziehung zwischen Shots-Volumen und realisiertem Sofa-xG. "
        "Erwartete Korrelation r=0.7-0.8 (mehr Shots = mehr xG, aber nicht linear weil "
        "Shot-Qualität variabel). Home (gold) vs Away (blue) zeigt typisch leichten "
        "Home-Bias.",
        body))
    elements.append(Spacer(1, 8))
    scatter_path = chart_match_stats_shots_vs_xg(supa)
    elements.append(Image(str(scatter_path), width=17*cm, height=10*cm))
    elements.append(PageBreak())

    elements.append(Paragraph("Home vs Away · ø Stats Vergleich", h2))
    elements.append(Paragraph(
        "Empirische Validierung des Heim-Vorteils: Home-Teams haben durchschnittlich "
        "mehr Possession, mehr Shots, mehr Big Chances, mehr Passes. Auswärts mehr Fouls "
        "(defensive Aktionen).",
        body))
    elements.append(Spacer(1, 8))
    ha_path = chart_match_stats_home_away_diff(supa)
    elements.append(Image(str(ha_path), width=18*cm, height=8.5*cm))
    elements.append(PageBreak())

    # ─── live_brier_snapshots DEEP-DIVE ────────────────────────────
    elements.append(Paragraph("live_brier_snapshots · Engine Performance Tracking", h1))
    elements.append(Paragraph(
        "Live-Brier-Score per Engine über die Zeit. Brier Score misst Vorhersage-Qualität: "
        "Niedriger ist besser, theoretisches Minimum ~0.5 (perfekt) gegen ~0.75 (Münzwurf). "
        "Track-record-Quelle für /performance Page + Engine-Vergleich.",
        body))
    elements.append(Spacer(1, 8))

    brier_tl_path = chart_brier_timeline(supa)
    elements.append(Image(str(brier_tl_path), width=18*cm, height=11*cm))
    elements.append(Paragraph(
        "<i>2-Panel Time-Series: oben Brier 1X2 (Win/Draw/Lose), unten Brier O25 (Over 2.5). "
        "Trend nach unten = Engine wird besser. Spikes = Liga-Spezifika oder kleine n.</i>", note))
    elements.append(PageBreak())

    elements.append(Paragraph("ø Brier per Engine · Direct Comparison", h2))
    elements.append(Paragraph(
        "Aggregated Average pro Engine über alle Time-Windows. Direkt vergleichbar. "
        "Niedriger = besser. Σn unter den Bars = total Stichproben pro Engine.",
        body))
    elements.append(Spacer(1, 8))
    brier_avg_path = chart_brier_per_engine_avg(supa)
    elements.append(Image(str(brier_avg_path), width=18*cm, height=8.5*cm))
    elements.append(PageBreak())

    # ─── ALL TABLES BY SIZE ────────────────────────────────────────
    elements.append(Paragraph("Storage Footprint: Tables by Row Count", h1))
    elements.append(Paragraph(
        "Log-scale Übersicht der größten Tabellen. Sofa-Pipeline-Tabellen dominieren "
        "wegen Per-Shot/Per-Event/Per-Player-Granularität.",
        body))
    elements.append(Spacer(1, 8))

    # Build table_counts dict (from CATALOG, query each)
    table_counts: dict[str, int] = {}
    for cat, tables in CATALOG.items():
        for t in tables:
            table_counts[t["name"]] = supa.count(t["name"])

    sizes_path = chart_table_sizes(table_counts)
    elements.append(Image(str(sizes_path), width=17*cm, height=10*cm))
    elements.append(Spacer(1, 12))

    extras_path = chart_sofa_extras_breakdown(table_counts)
    elements.append(Image(str(extras_path), width=17*cm, height=8.5*cm))
    elements.append(PageBreak())

    # ─── INHALTSVERZEICHNIS ────────────────────────────────────────
    elements.append(Paragraph("Inhaltsverzeichnis", h1))
    elements.append(Spacer(1, 4))
    for cat, tables in CATALOG.items():
        elements.append(Paragraph(cat, h2))
        for t in tables:
            elements.append(Paragraph(
                f"&nbsp;&nbsp;&bull; <b>{t['name']}</b> — {t['purpose'][:80]}{'...' if len(t['purpose']) > 80 else ''}",
                body))
    elements.append(Paragraph("Local SQLite (Mirror + lokal-only)", h2))
    for t in LOCAL_TABLES:
        elements.append(Paragraph(f"&nbsp;&nbsp;&bull; <b>{t['name']}</b> — {t['purpose'][:80]}", body))
    elements.append(PageBreak())

    # ─── PER-TABLE DETAIL ──────────────────────────────────────────
    for cat, tables in CATALOG.items():
        elements.append(Paragraph(cat, h1))

        for t in tables:
            elements.append(Paragraph(t["name"], h2))

            row_count = table_counts.get(t["name"], 0)
            samples = supa.sample_rows(t["name"], n=3)

            # Header info bar
            info_bar = Table(
                [[
                    Paragraph(f"<b>Rows:</b> {row_count:,}", small),
                    Paragraph(f"<b>Sample-Spalten:</b> {len(t.get('key_cols', []))}", small),
                    Paragraph(f"<b>Samples:</b> {len(samples)}", small),
                ]],
                colWidths=[5*cm, 5*cm, 7*cm],
            )
            info_bar.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), CREAM_C),
                ("BOX", (0, 0), (-1, -1), 0.5, GOLD_MID_C),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            elements.append(info_bar)
            elements.append(Spacer(1, 6))

            # Purpose paragraph
            elements.append(Paragraph(f"<b>Zweck:</b> {t['purpose']}", body))
            if t.get("note"):
                elements.append(Paragraph(f"<i>📌 {t['note']}</i>", note))
            elements.append(Spacer(1, 6))

            # Columns table — with descriptions + sample values from up to 3 sample rows
            cols_def = t.get("key_cols", [])

            header = ["Column", "Type", "Beschreibung"]
            for i in range(min(len(samples), 3)):
                header.append(f"Sample {i+1}")

            rows_data = [header]
            for col_tuple in cols_def:
                if len(col_tuple) == 3:
                    col, desc, typ = col_tuple
                else:
                    col, desc = col_tuple[0], (col_tuple[1] if len(col_tuple) > 1 else "")
                    typ = ""
                row = [col, typ, desc]
                for s in samples[:3]:
                    val = s.get(col)
                    val_str = str(val) if val is not None else "—"
                    if len(val_str) > 35:
                        val_str = val_str[:32] + "..."
                    row.append(val_str)
                rows_data.append(row)

            n_samples = min(len(samples), 3)
            col_widths = [3*cm, 1.6*cm, 5.5*cm] + [(8.5*cm) / max(n_samples, 1)] * n_samples
            # Adjust for fewer samples
            if n_samples == 0:
                col_widths = [3.5*cm, 2*cm, 12*cm]

            col_tbl = Table(rows_data, colWidths=col_widths, repeatRows=1)
            style = [
                ("BACKGROUND", (0, 0), (-1, 0), GOLD_C),
                ("TEXTCOLOR", (0, 0), (-1, 0), LEATHER_C),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 8.5),
                ("FONTSIZE", (0, 1), (-1, -1), 7.5),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
                ("TEXTCOLOR", (0, 1), (0, -1), LEATHER_C),
                ("TEXTCOLOR", (1, 1), (1, -1), MUTED_C),
                ("FONTNAME", (1, 1), (1, -1), "Courier"),
                ("FONTNAME", (3, 1), (-1, -1), "Courier"),
                ("TEXTCOLOR", (3, 1), (-1, -1), GREEN_C),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURFACE_C, white]),
                ("GRID", (0, 0), (-1, -1), 0.25, GOLD_MID_C),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 3),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
            col_tbl.setStyle(TableStyle(style))
            elements.append(col_tbl)
            elements.append(Spacer(1, 16))

        elements.append(PageBreak())

    # ─── LOCAL SQLITE SECTION ──────────────────────────────────────
    if conn is not None:
        elements.append(Paragraph("Local SQLite Mirror", h1))
        elements.append(Paragraph(
            "Tabellen die NUR lokal existieren (tools/sofascore/data/local_extras.db, 661 MB). "
            "Player-stats waren in Supabase bis 2026-05-18 (190 MB → 500 MB free-tier limit hit). "
            "Local-only Strategy: Engine-critical Daten haben dort eine Reserve-Kopie.",
            body))
        elements.append(Spacer(1, 12))

        cur = conn.cursor()
        for t in LOCAL_TABLES:
            tname = t["name"]
            elements.append(Paragraph(tname, h2))

            try:
                n = cur.execute(f"SELECT COUNT(*) FROM {tname}").fetchone()[0]
                cols_info = cur.execute(f"PRAGMA table_info({tname})").fetchall()
                rows = cur.execute(f"SELECT * FROM {tname} LIMIT 3").fetchall()
            except Exception as e:
                elements.append(Paragraph(f"<i>ERR: {e}</i>", note))
                continue

            info_bar = Table(
                [[
                    Paragraph(f"<b>Rows:</b> {n:,}", small),
                    Paragraph(f"<b>Columns:</b> {len(cols_info)}", small),
                    Paragraph(f"<b>Samples:</b> {len(rows)}", small),
                ]],
                colWidths=[5*cm, 5*cm, 7*cm],
            )
            info_bar.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), CREAM_C),
                ("BOX", (0, 0), (-1, -1), 0.5, GOLD_MID_C),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            elements.append(info_bar)
            elements.append(Spacer(1, 6))

            elements.append(Paragraph(f"<b>Zweck:</b> {t['purpose']}", body))
            if t.get("note"):
                elements.append(Paragraph(f"<i>📌 {t['note']}</i>", note))
            elements.append(Spacer(1, 6))

            # Columns from PRAGMA + sample values
            col_names = [c[1] for c in cols_info]
            col_types = [c[2] for c in cols_info]

            cols_to_show = col_names[:20]  # cap for layout
            header_row = ["Column", "Type"]
            for i in range(min(len(rows), 3)):
                header_row.append(f"Sample {i+1}")

            rows_data = [header_row]
            for j, (col, typ) in enumerate(zip(cols_to_show, col_types[:20])):
                row = [col, typ.lower()]
                for sample_row in rows[:3]:
                    val = sample_row[j] if j < len(sample_row) else None
                    val_str = str(val) if val is not None else "—"
                    if len(val_str) > 35:
                        val_str = val_str[:32] + "..."
                    row.append(val_str)
                rows_data.append(row)

            n_samples = min(len(rows), 3)
            col_widths = [4*cm, 2*cm] + [(11*cm) / max(n_samples, 1)] * n_samples
            if n_samples == 0:
                col_widths = [4*cm, 2*cm, 11*cm]

            col_tbl = Table(rows_data, colWidths=col_widths, repeatRows=1)
            col_tbl.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), GOLD_C),
                ("TEXTCOLOR", (0, 0), (-1, 0), LEATHER_C),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 8.5),
                ("FONTSIZE", (0, 1), (-1, -1), 7.5),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
                ("TEXTCOLOR", (0, 1), (0, -1), LEATHER_C),
                ("TEXTCOLOR", (1, 1), (1, -1), MUTED_C),
                ("FONTNAME", (1, 1), (1, -1), "Courier"),
                ("FONTNAME", (2, 1), (-1, -1), "Courier"),
                ("TEXTCOLOR", (2, 1), (-1, -1), GREEN_C),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURFACE_C, white]),
                ("GRID", (0, 0), (-1, -1), 0.25, GOLD_MID_C),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 3),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]))
            elements.append(col_tbl)
            elements.append(Spacer(1, 16))
        elements.append(PageBreak())

    # ─── GLOSSARY ──────────────────────────────────────────────────
    elements.append(Paragraph("Glossar & Terminologie", h1))
    glossary_terms = [
        ("xG (Expected Goals)",
         "Statistisches Maß für die Wahrscheinlichkeit dass ein Shot ein Tor wird. "
         "Skala 0-1. ΣxG over a game = total expected goals per Team. Quellen: Understat (echte historische), Sofa (per-shot)."),
        ("xGOT (Expected Goals on Target)",
         "Post-shot xG — wertet AUCH die Qualität des Schusses NACH Abgabe (Ziel-Ecke etc.). Höher als xG."),
        ("xGA (Expected Goals Against)",
         "Spiegelbild von xG aus Defensive-Sicht: erwartete kassierte Tore basierend auf zugelassenen Shot-Qualität."),
        ("CLV (Closing Line Value)",
         "log(odds_placed / closing_odds) × 100. Positiv = User hat besseren Wert als Schlussquote gesichert."),
        ("Kelly-Multiplier",
         "Skalierungsfaktor 0.3-1.0 für Stake. 1.0 = full Kelly, 0.3 = Damper bei Trap-Zone trust band."),
        ("Trust Band",
         "Gold/Caution/Trap — basierend auf live_brier_snapshots calibration. Gold = ±3pp, Trap = >8pp Drift."),
        ("Tier-A vs Tier-B Liga",
         "Tier-A: 16 premium Sofa-coverage Ligen (Top-5 + championship + EU). Tier-B: 5 Ligen ohne voll-xG (eerste_divisie + Lower Tier)."),
        ("Bridge",
         "Skript das Sofa-extras → team_xg_history feature-cols propagiert (Bridge 1) oder per-game xG → rows (Bridge 2)."),
        ("Engine λ (Lambda)",
         "Erwartete Tore pro Team aus Dixon-Coles. λ_h × λ_a → 15×15 Poisson-Matrix → alle 1X2/OU/BTTS probs."),
        ("ON CONFLICT DO UPDATE",
         "PostgREST + Supabase-pattern. Bei UNIQUE-conflict wird Row UPSERTed (idempotent). Bridge runs sind so safe re-runnable."),
        ("Skip Player Stats (default 2026-05-18)",
         "Free-tier Storage-Saver: sofascore_player_match_stats geht nur in lokale SQLite, nicht Supabase. Override mit --include-player-stats."),
    ]
    for term, defn in glossary_terms:
        elements.append(Paragraph(f"<b>{term}</b>", h3))
        elements.append(Paragraph(defn, body))
        elements.append(Spacer(1, 4))

    elements.append(PageBreak())

    # ─── APPENDIX ──────────────────────────────────────────────────
    elements.append(Paragraph("Anhang: Storage-Architektur Details", h1))
    elements.append(Paragraph(
        "<b>Layer 1: JSON Checkpoints</b> (tools/sofascore/data/extras/, 1.5 GB)<br/>"
        "&nbsp;&nbsp;Raw API-Payloads pro game_id. Authoritative source-of-truth.<br/>"
        "&nbsp;&nbsp;Beide DBs können daraus rekonstruiert werden (load_extras_to_supabase --all).<br/>"
        "&nbsp;&nbsp;10.801 Files — ein File pro game_id × season × league.<br/>"
        "&nbsp;&nbsp;Pro File: 7 Endpoint-Payloads als JSON-Subobjects.<br/><br/>"
        "<b>Layer 2: Local SQLite Mirror</b> (tools/sofascore/data/local_extras.db, 661 MB)<br/>"
        "&nbsp;&nbsp;Safety-net + Storage für was nicht in Supabase passt.<br/>"
        "&nbsp;&nbsp;Mirror aller Sofa-tables + sofascore_player_match_stats (443k rows) + understat (424k).<br/>"
        "&nbsp;&nbsp;Updated via load_extras_to_supabase.py (default-on local mirror).<br/>"
        "&nbsp;&nbsp;Engine-Retraining kann offline laufen (Sofa-data + team_xg_history vollständig).<br/><br/>"
        "<b>Layer 3: Supabase (Cloud, primary)</b> (~470 MB used, 500 MB free-tier limit)<br/>"
        "&nbsp;&nbsp;Production reads für FODZE App + cron pipelines.<br/>"
        "&nbsp;&nbsp;Row-level-security aktiv. User-data, engine-predictions, sofa-extras (excl player-stats).<br/>"
        "&nbsp;&nbsp;Reads &lt; 1s, writes 600-1500ms typical. Free-tier IO budget important.<br/>",
        body))

    elements.append(Spacer(1, 12))
    elements.append(Paragraph("Refresh-Empfehlung", h2))
    elements.append(Paragraph(
        "Diese PDF wird durch <code>tools/venv/bin/python3 scripts/generate-data-dictionary-pdf.py</code> "
        "regeneriert. Re-run wenn Tabellen-Schemas ändern, neue Sources hinzukommen, oder Coverage-Zahlen "
        "stale sind (täglich aktuelle Werte).",
        body))

    doc.build(elements)
    print(f"✓ PDF generated: {OUTPUT_PDF}")
    print(f"  Size: {OUTPUT_PDF.stat().st_size:,} bytes")
    print(f"  Charts: {len(list(TMP_DIR.glob('*.png')))} embedded")


def main() -> int:
    env = read_env()
    supa = Supabase(env)

    conn: sqlite3.Connection | None = None
    if LOCAL_DB.exists():
        conn = sqlite3.connect(str(LOCAL_DB))

    DOCS_DIR.mkdir(exist_ok=True)
    build_pdf(supa, conn)

    if conn:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
