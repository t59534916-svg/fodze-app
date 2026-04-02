#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
@annafrick13 v2.0 — LightGBM Tweedie Training Pipeline

Replaces PoissonRegressor with LightGBM Tweedie:
  - 14 features (npxG, PPDA, Deep + momentum + volatility)
  - Monotonic constraints on elo_diff, npxg_diff
  - Optuna-tuned tweedie_variance_power
  - Optimized Dixon-Coles rho
  - Tree JSON export for browser-side inference

Output:
  public/lgbm-model-v2.json  (Tree structure + golden tests)

Usage:
  source tools/venv/bin/activate
  python3 tools/retrain_v2.py
  python3 tools/retrain_v2.py --no-optuna       # Skip tuning, use defaults
  python3 tools/retrain_v2.py --use-npxg-csv    # Use npxG CSV if available
═══════════════════════════════════════════════════════════════════
"""

import json, os, glob, argparse
import numpy as np
import pandas as pd
import lightgbm as lgb
from scipy.stats import poisson
from scipy.optimize import minimize_scalar
from collections import defaultdict

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
HISTORIE_DIR = os.path.join(PROJECT_ROOT, "Historie")
NPXG_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "understat_npxg_matches.csv")
FULL_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "understat_full_matches.csv")
TACTICS_CSV = os.path.join(PROJECT_ROOT, "backups", "understat-2026-03-30", "understat_tactics.csv")
PLAYERS_CSV = os.path.join(PROJECT_ROOT, "backups", "understat-2026-03-30", "understat_players.csv")
ROSTER_CSV = os.path.join(PROJECT_ROOT, "backups", "understat-2026-03-30", "understat_match_rosters.csv")

DIV_TO_LEAGUE = {"D1": "bundesliga", "E0": "epl", "SP1": "la_liga", "I1": "serie_a", "F1": "ligue_1"}
LEAGUE_AVGS = {"bundesliga": 1.38, "epl": 1.35, "la_liga": 1.25, "serie_a": 1.32, "ligue_1": 1.30}
LEAGUE_HFS = {"bundesliga": 1.28, "epl": 1.22, "la_liga": 1.30, "serie_a": 1.27, "ligue_1": 1.32}

OOT_CUTOFF = pd.Timestamp("2023-08-01")
EWMA_ALPHA = 0.85

# Feature names (19 total — v2.1 adds tactics, players, roster features)
FEATURE_NAMES = [
    "npxg_diff_ewma",        # 0:  EWMA npxG/g diff (SoS-proxied)
    "npxga_diff_ewma",       # 1:  EWMA npxGA/g diff
    "elo_diff",              # 2:  (Elo_H - Elo_A) / 400
    "total_npxg",            # 3:  EWMA npxG/g sum
    "home_factor",           # 4:  League/team HF
    "league_avg",            # 5:  League goals/game
    "rest_days_diff",        # 6:  (rest_H - rest_A) / 7
    "sos_strength",          # 7:  SoS diff (avg opp Elo)
    "is_derby",              # 8:  Binary
    "npxg_momentum",         # 9:  last_3_avg - season_avg
    "npxg_volatility",       # 10: rolling_std(npxg_diff, 8)
    "h2h_npxg_diff",         # 11: Last 5 H2H npxg differential
    "ppda_ratio_diff",       # 12: EWMA(ppda_att/ppda_def) diff — pressing
    "deep_completions_diff", # 13: EWMA(deep - deep_allowed) diff — final-third
    "setpiece_xg_share_diff",# 14: SetPiece xG / Total xG diff (season-level)
    "late_game_xg_share_diff", # 15: xG in 76+ min / Total xG diff (season-level)
    "losing_state_xg_diff",  # 16: xG when losing - xGA when losing (season-level)
    "top3_xgchain_share_diff", # 17: Top-3 player xG_chain share diff (season-level)
    "squad_rotation_rate_diff", # 18: EWMA rotation rate diff (per-match)
]

# Monotonic constraints: +1 = increasing, -1 = decreasing, 0 = none
# New features 14-18: all unconstrained (no clear monotonic relationship)
MONO_HOME = [+1, -1, +1, 0, +1, 0, +1, 0, 0, +1, 0, 0, 0, +1, 0, 0, 0, 0, 0]
MONO_AWAY = [-1, +1, -1, 0, -1, 0, -1, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, 0, 0]

# ─── Derby pairs ────────────────────────────────────────────────
DERBIES = {
    frozenset({"Bayern Munich", "Munich 1860"}), frozenset({"Dortmund", "Schalke 04"}),
    frozenset({"Hamburg", "Werder Bremen"}), frozenset({"Hamburg", "St Pauli"}),
    frozenset({"M'gladbach", "FC Koln"}), frozenset({"Hertha", "Union Berlin"}),
    frozenset({"Nurnberg", "Greuther Furth"}), frozenset({"Stuttgart", "Karlsruhe"}),
    frozenset({"Liverpool", "Everton"}), frozenset({"Man United", "Man City"}),
    frozenset({"Arsenal", "Tottenham"}), frozenset({"Chelsea", "Fulham"}),
    frozenset({"Newcastle", "Sunderland"}), frozenset({"Aston Villa", "Birmingham"}),
    frozenset({"Barcelona", "Real Madrid"}), frozenset({"Ath Madrid", "Real Madrid"}),
    frozenset({"Barcelona", "Espanol"}), frozenset({"Sevilla", "Betis"}),
    frozenset({"Sociedad", "Ath Bilbao"}),
    frozenset({"Inter", "Milan"}), frozenset({"Roma", "Lazio"}),
    frozenset({"Juventus", "Torino"}), frozenset({"Genoa", "Sampdoria"}),
    frozenset({"Paris SG", "Marseille"}), frozenset({"Lyon", "St Etienne"}),
}


# ═══════════════════════════════════════════════════════════════════
# DATA LOADING
# ═══════════════════════════════════════════════════════════════════

def load_csv_data():
    """Load historical match data from CSV files."""
    csv_dfs = []
    for folder in sorted(glob.glob(os.path.join(HISTORIE_DIR, "data*"))):
        for csv_file in glob.glob(os.path.join(folder, "*.csv")):
            try:
                df = pd.read_csv(csv_file, encoding="latin-1", on_bad_lines="skip")
            except Exception:
                continue
            df.columns = [c.strip().strip("\ufeff") for c in df.columns]
            if "Div" not in df.columns or "FTHG" not in df.columns:
                continue
            if "HomeTeam" not in df.columns:
                if "HT" in df.columns:
                    df = df.rename(columns={"HT": "HomeTeam", "AT": "AwayTeam"})
                else:
                    continue
            df = df[df["Div"].isin(DIV_TO_LEAGUE.keys())]
            cols = ["Div", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]
            if "Date" in df.columns:
                cols.append("Date")
            df = df[[c for c in cols if c in df.columns]].dropna(subset=["FTHG", "FTAG"])
            df["FTHG"] = pd.to_numeric(df["FTHG"], errors="coerce")
            df["FTAG"] = pd.to_numeric(df["FTAG"], errors="coerce")
            df = df.dropna()
            csv_dfs.append(df)

    csv_all = pd.concat(csv_dfs, ignore_index=True)

    if "Date" in csv_all.columns:
        csv_all["date_parsed"] = pd.to_datetime(csv_all["Date"], format="%d/%m/%Y", errors="coerce")
        mask = csv_all["date_parsed"].isna()
        if mask.any():
            csv_all.loc[mask, "date_parsed"] = pd.to_datetime(
                csv_all.loc[mask, "Date"], format="%d/%m/%y", errors="coerce"
            )
        csv_all = csv_all.dropna(subset=["date_parsed"]).sort_values("date_parsed")
    else:
        csv_all["date_parsed"] = pd.NaT

    csv_all["league"] = csv_all["Div"].map(DIV_TO_LEAGUE)
    return csv_all


def load_npxg_data(npxg_csv_path):
    """Load npxG data from per-match CSV if available."""
    if not os.path.exists(npxg_csv_path):
        return {}
    df = pd.read_csv(npxg_csv_path)
    lookup = {}
    for _, row in df.iterrows():
        key = f"{row['date']}|{row['home']}|{row['away']}"
        lookup[key] = {
            "home_npxg": float(row["home_npxg"]),
            "away_npxg": float(row["away_npxg"]),
        }
    return lookup


def load_full_understat_data(full_csv_path):
    """Load full Understat data (teamsData format) with npxG per team-match.
    Returns lookup: (date, team) → {npxg, npxga, ppda, deep, xpts, pts, ...}
    """
    if not os.path.exists(full_csv_path):
        return {}
    df = pd.read_csv(full_csv_path)
    lookup = {}
    for _, row in df.iterrows():
        key = (str(row["date"]), str(row["team"]))
        lookup[key] = {
            "npxg": float(row.get("npxg", 0)),
            "npxga": float(row.get("npxga", 0)),
            "xg": float(row.get("xg", 0)),
            "xga": float(row.get("xga", 0)),
            "ppda_att": int(row.get("ppda_att", 0)),
            "ppda_def": max(1, int(row.get("ppda_def", 1))),
            "deep": int(row.get("deep", 0)),
            "deep_allowed": int(row.get("deep_allowed", 0)),
            "xpts": float(row.get("xpts", 0)),
            "pts": int(row.get("pts", 0)),
            "h_a": str(row.get("h_a", "")),
        }
    return lookup


def load_tactics_data(tactics_csv_path):
    """Load tactics data → season-level features per team.
    Returns: {(league, season, team): {setpiece_xg_share, late_game_xg_share, losing_state_xg_diff}}
    """
    if not os.path.exists(tactics_csv_path):
        return {}
    df = pd.read_csv(tactics_csv_path)
    result = {}

    for (league, season, team), grp in df.groupby(["league", "season", "team"]):
        key = (str(league), str(season), str(team))

        # Total xG (from situation=OpenPlay + SetPiece + others)
        sit = grp[grp["category"] == "situation"]
        total_xg = sit["xg"].sum()
        setpiece_xg = sit[sit["statistic"].isin(["SetPiece", "FromCorner", "DirectFreekick"])]["xg"].sum()
        setpiece_share = setpiece_xg / max(total_xg, 0.1)

        # Late game xG share (76+ minutes)
        timing = grp[grp["category"] == "timing"]
        total_timing_xg = timing["xg"].sum()
        late_xg = timing[timing["statistic"] == "76+"]["xg"].sum()
        late_share = late_xg / max(total_timing_xg, 0.1)

        # Losing state performance
        gs = grp[grp["category"] == "gameState"]
        losing = gs[gs["statistic"].isin(["Goal diff -1", "Goal diff < -1"])]
        losing_xg = losing["xg"].sum()
        losing_xga = losing["xga"].sum()
        losing_diff = losing_xg - losing_xga

        result[key] = {
            "setpiece_xg_share": round(setpiece_share, 4),
            "late_game_xg_share": round(late_share, 4),
            "losing_state_xg_diff": round(losing_diff, 4),
        }

    return result


def load_players_data(players_csv_path):
    """Load player data → top-3 xG chain share per team-season.
    Returns: {(league, season, team): {top3_xgchain_share}}
    """
    if not os.path.exists(players_csv_path):
        return {}
    df = pd.read_csv(players_csv_path)
    result = {}

    for (league, season, team), grp in df.groupby(["league", "season", "team"]):
        key = (str(league), str(season), str(team))
        total_chain = grp["xg_chain"].sum()
        top3_chain = grp.nlargest(3, "xg_chain")["xg_chain"].sum()
        share = top3_chain / max(total_chain, 0.1)
        result[key] = {"top3_xgchain_share": round(share, 4)}

    return result


def load_roster_rotation(roster_csv_path):
    """Load roster data → per-match rotation rate.
    Returns: {(date, team): rotation_rate} where rotation_rate = fraction of starters with < 45 min.
    """
    if not os.path.exists(roster_csv_path):
        return {}
    df = pd.read_csv(roster_csv_path)
    result = {}

    # Group by match and team side
    for (match_id, h_a), grp in df.groupby(["match_id", "h_a"]):
        team = grp.iloc[0]["home_team"] if h_a == "h" else grp.iloc[0]["away_team"]
        date = str(grp.iloc[0]["date"])
        # Count players who started (not subs) with < 45 min = rotated out early
        starters = grp[grp["roster_in"] == 0]  # roster_in=0 means starter
        if len(starters) == 0:
            continue
        short_minutes = (starters["time_minutes"] < 45).sum()
        rotation_rate = short_minutes / len(starters)
        result[(date, str(team))] = rotation_rate

    return result


# ═══════════════════════════════════════════════════════════════════
# ELO RATINGS
# ═══════════════════════════════════════════════════════════════════

def compute_elo(train_df):
    """Compute Elo ratings on training data."""
    K, HOME_ADV = 32, 65
    elo = {}

    def get_elo(t):
        return elo.get(t, 1500)

    for _, row in train_df.iterrows():
        ht, at = str(row["HomeTeam"]), str(row["AwayTeam"])
        gf, ga = int(row["FTHG"]), int(row["FTAG"])
        rH, rA = get_elo(ht) + HOME_ADV, get_elo(at)
        expH = 1 / (1 + 10 ** ((rA - rH) / 400))
        actual = 1 if gf > ga else 0.5 if gf == ga else 0
        gd = abs(gf - ga)
        gd_mult = 1 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8
        elo[ht] = get_elo(ht) + K * gd_mult * (actual - expH)
        elo[at] = get_elo(at) + K * gd_mult * ((1 - actual) - (1 - expH))

    return elo


# ═══════════════════════════════════════════════════════════════════
# STANDINGS & MOTIVATION INDEX
# ═══════════════════════════════════════════════════════════════════

def compute_standings_at_match(league_matches_before):
    """Compute league standings from matches played so far (no look-ahead)."""
    points = defaultdict(int)
    for m in league_matches_before:
        ht, at, gf, ga = m["ht"], m["at"], m["gf"], m["ga"]
        if gf > ga:
            points[ht] += 3
        elif gf == ga:
            points[ht] += 1
            points[at] += 1
        else:
            points[at] += 3
    return points


def motivation_index(team, points_table, n_teams=18):
    """
    Compute motivation index: how close is the team to relegation or title?
    Returns value in [-1, 1]:
      - Negative = mid-table (low motivation)
      - Positive = near relegation or title race (high motivation)
    """
    if not points_table:
        return 0.0

    sorted_teams = sorted(points_table.items(), key=lambda x: -x[1])
    team_pts = points_table.get(team, 0)

    if len(sorted_teams) < 4:
        return 0.0

    leader_pts = sorted_teams[0][1]
    # Relegation zone: bottom 3 (for 18-team leagues)
    rel_cutoff = max(3, n_teams // 6)
    rel_pts = sorted_teams[-rel_cutoff][1] if len(sorted_teams) >= rel_cutoff else 0

    # Distance to title (normalized)
    title_gap = (leader_pts - team_pts) / max(1, leader_pts)
    # Distance to relegation (normalized)
    rel_gap = (team_pts - rel_pts) / max(1, leader_pts)

    # High motivation when close to either extreme
    title_urgency = max(0, 1 - title_gap * 3)  # Close to title
    rel_urgency = max(0, 1 - rel_gap * 3)      # Close to relegation

    return max(title_urgency, rel_urgency)


# ═══════════════════════════════════════════════════════════════════
# FEATURE ENGINEERING (13 features)
# ═══════════════════════════════════════════════════════════════════

def compute_features(csv_all, elo_ratings, npxg_lookup, full_lookup=None, use_npxg=False,
                     tactics_data=None, players_data=None, roster_data=None):
    """Compute 14-feature vectors chronologically with strict shift(1)."""
    team_ewma = {}       # team -> {gf, ga}
    team_last_date = {}  # team -> last match date
    team_opp_elo_sum = {}  # team -> {sum, n}
    team_npxg_history = defaultdict(list)  # team -> list of per-match npxg_diff
    team_season_npxg = defaultdict(list)   # team -> season npxg values
    h2h_history = defaultdict(list)  # frozenset(ht,at) -> list of (npxg_diff)
    team_ppda_ewma = {}  # team -> EWMA of ppda_att/ppda_def ratio
    team_deep_ewma = {}  # team -> EWMA of (deep - deep_allowed)
    team_rotation_ewma = {}  # team -> EWMA of squad rotation rate

    features_per_match = []

    for _, row in csv_all.iterrows():
        ht, at = str(row["HomeTeam"]), str(row["AwayTeam"])
        gf, ga = int(row["FTHG"]), int(row["FTAG"])
        lg = str(row.get("league", ""))
        dt = row.get("date_parsed", pd.NaT)

        if lg not in LEAGUE_AVGS:
            continue

        # --- npxG lookup (fallback to goals-based EWMA) ---
        npxg_key = ""
        if pd.notna(dt):
            npxg_key = f"{dt.strftime('%Y-%m-%d')}|{ht}|{at}"

        npxg_data = npxg_lookup.get(npxg_key, None) if use_npxg else None

        # Get EWMA state BEFORE this match (strict shift(1))
        h_state = team_ewma.get(ht, {"gf": 1.3, "ga": 1.3})
        a_state = team_ewma.get(at, {"gf": 1.3, "ga": 1.3})

        # Feature 0: npxg_diff_ewma
        npxg_diff_ewma = h_state["gf"] - a_state["gf"]

        # Feature 1: npxga_diff_ewma
        npxga_diff_ewma = h_state["ga"] - a_state["ga"]

        # Feature 2: elo_diff
        elo_h = elo_ratings.get(ht, 1500)
        elo_a = elo_ratings.get(at, 1500)
        elo_diff = (elo_h - elo_a) / 400

        # Feature 3: total_npxg
        total_npxg = h_state["gf"] + a_state["gf"]

        # Feature 4: home_factor
        hf = LEAGUE_HFS.get(lg, 1.25)

        # Feature 5: league_avg
        league_avg = LEAGUE_AVGS.get(lg, 1.30)

        # Feature 6: rest_days_diff
        rest_h, rest_a = 7.0, 7.0
        if pd.notna(dt):
            if ht in team_last_date and pd.notna(team_last_date[ht]):
                rest_h = max(1, min(30, (dt - team_last_date[ht]).days))
            if at in team_last_date and pd.notna(team_last_date[at]):
                rest_a = max(1, min(30, (dt - team_last_date[at]).days))
        rest_diff = (rest_h - rest_a) / 7.0

        # Feature 7: sos_strength
        h_sos = team_opp_elo_sum.get(ht, {"sum": 0, "n": 0})
        a_sos = team_opp_elo_sum.get(at, {"sum": 0, "n": 0})
        avg_opp_h = (h_sos["sum"] / h_sos["n"]) if h_sos["n"] > 0 else 1500
        avg_opp_a = (a_sos["sum"] / a_sos["n"]) if a_sos["n"] > 0 else 1500
        sos_strength = (avg_opp_h - avg_opp_a) / 400

        # Feature 8: is_derby
        derby = 1.0 if frozenset({ht, at}) in DERBIES else 0.0

        # Feature 9: npxg_momentum (last 3 - season average)
        h_recent = team_npxg_history.get(ht, [])
        a_recent = team_npxg_history.get(at, [])
        h_season = team_season_npxg.get(ht, [])
        a_season = team_season_npxg.get(at, [])

        h_last3 = np.mean(h_recent[-3:]) if len(h_recent) >= 3 else (np.mean(h_recent) if h_recent else 0)
        h_season_avg = np.mean(h_season) if h_season else 0
        a_last3 = np.mean(a_recent[-3:]) if len(a_recent) >= 3 else (np.mean(a_recent) if a_recent else 0)
        a_season_avg = np.mean(a_season) if a_season else 0

        npxg_momentum = (h_last3 - h_season_avg) - (a_last3 - a_season_avg)

        # Feature 10: npxg_volatility (rolling std of npxg_diff over last 8)
        h_vol = np.std(h_recent[-8:]) if len(h_recent) >= 4 else 0.5
        a_vol = np.std(a_recent[-8:]) if len(a_recent) >= 4 else 0.5
        npxg_volatility = (h_vol + a_vol) / 2

        # Feature 11: h2h_npxg_diff (last 5 H2H meetings)
        pair_key = frozenset({ht, at})
        h2h = h2h_history.get(pair_key, [])
        h2h_diff = np.mean(h2h[-5:]) if h2h else 0.0

        # Feature 12: ppda_ratio_diff (EWMA of ppda_att/ppda_def — pressing intensity)
        # State read BEFORE this match (strict shift(1))
        h_ppda = team_ppda_ewma.get(ht, 11.1)  # Default: league avg ~11.1
        a_ppda = team_ppda_ewma.get(at, 11.1)
        ppda_ratio_diff = h_ppda - a_ppda

        # Feature 13: deep_completions_diff (EWMA of deep - deep_allowed)
        h_deep_net = team_deep_ewma.get(ht, 0.0)
        a_deep_net = team_deep_ewma.get(at, 0.0)
        deep_completions_diff = h_deep_net - a_deep_net

        # Features 14-17: Season-level tactics/players lookups
        # Determine season from date (Aug-Jul = season year)
        season_str = ""
        if pd.notna(dt):
            y = dt.year
            m = dt.month
            season_start = y if m >= 7 else y - 1
            season_str = f"{season_start}/{str(season_start + 1)[-2:]}"

        h_tact = tactics_data.get((lg, season_str, ht), {}) if tactics_data else {}
        a_tact = tactics_data.get((lg, season_str, at), {}) if tactics_data else {}
        h_play = players_data.get((lg, season_str, ht), {}) if players_data else {}
        a_play = players_data.get((lg, season_str, at), {}) if players_data else {}

        setpiece_diff = h_tact.get("setpiece_xg_share", 0.15) - a_tact.get("setpiece_xg_share", 0.15)
        late_game_diff = h_tact.get("late_game_xg_share", 0.20) - a_tact.get("late_game_xg_share", 0.20)
        losing_state_diff = h_tact.get("losing_state_xg_diff", 0.0) - a_tact.get("losing_state_xg_diff", 0.0)
        top3_chain_diff = h_play.get("top3_xgchain_share", 0.35) - a_play.get("top3_xgchain_share", 0.35)

        # Feature 18: Squad rotation rate EWMA (read BEFORE this match)
        h_rotation = team_rotation_ewma.get(ht, 0.0)
        a_rotation = team_rotation_ewma.get(at, 0.0)
        rotation_diff = h_rotation - a_rotation

        features = [
            npxg_diff_ewma,       # 0
            npxga_diff_ewma,      # 1
            elo_diff,             # 2
            total_npxg,           # 3
            hf,                   # 4
            league_avg,           # 5
            rest_diff,            # 6
            sos_strength,         # 7
            derby,                # 8
            npxg_momentum,        # 9
            npxg_volatility,      # 10
            h2h_diff,             # 11
            ppda_ratio_diff,      # 12
            deep_completions_diff, # 13
            setpiece_diff,        # 14
            late_game_diff,       # 15
            losing_state_diff,    # 16
            top3_chain_diff,      # 17
            rotation_diff,        # 18
        ]

        features_per_match.append({
            "features": features,
            "gf": gf, "ga": ga,
            "ht": ht, "at": at,
            "league": lg, "date": dt,
        })

        # ─── UPDATE STATE AFTER THIS MATCH (shift(1) maintained) ───

        # Determine match npxg values — priority: full_lookup > npxg_lookup > goals
        date_str = dt.strftime("%Y-%m-%d") if pd.notna(dt) else ""
        h_full = full_lookup.get((date_str, ht)) if full_lookup else None
        a_full = full_lookup.get((date_str, at)) if full_lookup else None

        if h_full and a_full:
            m_npxg_h = h_full["npxg"]
            m_npxg_a = a_full["npxg"]
        elif npxg_data:
            m_npxg_h = npxg_data["home_npxg"]
            m_npxg_a = npxg_data["away_npxg"]
        else:
            # Fallback: use actual goals as proxy (same as v1 xG-based EWMA)
            m_npxg_h = gf
            m_npxg_a = ga

        a_coef = EWMA_ALPHA
        team_ewma[ht] = {
            "gf": a_coef * m_npxg_h + (1 - a_coef) * h_state["gf"],
            "ga": a_coef * m_npxg_a + (1 - a_coef) * h_state["ga"],
        }
        team_ewma[at] = {
            "gf": a_coef * m_npxg_a + (1 - a_coef) * a_state["gf"],
            "ga": a_coef * m_npxg_h + (1 - a_coef) * a_state["ga"],
        }

        if pd.notna(dt):
            team_last_date[ht] = dt
            team_last_date[at] = dt

        team_opp_elo_sum[ht] = {"sum": h_sos["sum"] + elo_a, "n": h_sos["n"] + 1}
        team_opp_elo_sum[at] = {"sum": a_sos["sum"] + elo_h, "n": a_sos["n"] + 1}

        # Track per-match npxg for momentum & volatility
        npxg_diff_this = m_npxg_h - m_npxg_a
        team_npxg_history[ht].append(npxg_diff_this)
        team_npxg_history[at].append(-npxg_diff_this)
        team_season_npxg[ht].append(npxg_diff_this)
        team_season_npxg[at].append(-npxg_diff_this)

        # Update PPDA + Deep EWMA AFTER this match (strict shift(1))
        if h_full and a_full:
            ppda_def_h = max(1, h_full.get("ppda_def", 1))
            ppda_ratio_h = h_full.get("ppda_att", 0) / ppda_def_h
            deep_net_h = h_full.get("deep", 0) - h_full.get("deep_allowed", 0)

            ppda_def_a = max(1, a_full.get("ppda_def", 1))
            ppda_ratio_a = a_full.get("ppda_att", 0) / ppda_def_a
            deep_net_a = a_full.get("deep", 0) - a_full.get("deep_allowed", 0)

            prev_ppda_h = team_ppda_ewma.get(ht, 11.1)
            prev_ppda_a = team_ppda_ewma.get(at, 11.1)
            prev_deep_h = team_deep_ewma.get(ht, 0.0)
            prev_deep_a = team_deep_ewma.get(at, 0.0)

            team_ppda_ewma[ht] = a_coef * ppda_ratio_h + (1 - a_coef) * prev_ppda_h
            team_ppda_ewma[at] = a_coef * ppda_ratio_a + (1 - a_coef) * prev_ppda_a
            team_deep_ewma[ht] = a_coef * deep_net_h + (1 - a_coef) * prev_deep_h
            team_deep_ewma[at] = a_coef * deep_net_a + (1 - a_coef) * prev_deep_a

        # H2H tracking (from home team perspective)
        h2h_history[pair_key].append(npxg_diff_this)

        # Update rotation EWMA AFTER this match
        if roster_data:
            date_str_rot = dt.strftime("%Y-%m-%d") if pd.notna(dt) else ""
            h_rot = roster_data.get((date_str_rot, ht), 0.0)
            a_rot = roster_data.get((date_str_rot, at), 0.0)
            prev_h_rot = team_rotation_ewma.get(ht, 0.0)
            prev_a_rot = team_rotation_ewma.get(at, 0.0)
            team_rotation_ewma[ht] = a_coef * h_rot + (1 - a_coef) * prev_h_rot
            team_rotation_ewma[at] = a_coef * a_rot + (1 - a_coef) * prev_a_rot

    return features_per_match


# ═══════════════════════════════════════════════════════════════════
# DIXON-COLES MATRIX
# ═══════════════════════════════════════════════════════════════════

def dc_matrix(lam_h, lam_a, rho=-0.05, size=10):
    """Build Dixon-Coles corrected Poisson matrix."""
    mx = np.zeros((size, size))
    for i in range(size):
        for j in range(size):
            mx[i, j] = poisson.pmf(i, lam_h) * poisson.pmf(j, lam_a)
    if lam_h > 0 and lam_a > 0:
        mx[0, 0] *= max(0, 1 - lam_h * lam_a * rho)
        mx[1, 0] *= max(0, 1 + lam_a * rho)
        mx[0, 1] *= max(0, 1 + lam_h * rho)
        mx[1, 1] *= max(0, 1 - rho)
    # Strict renormalization
    mx /= mx.sum()
    return mx


def matrix_1x2(mx):
    """Extract 1X2 from matrix."""
    H = sum(mx[i, j] for i in range(mx.shape[0]) for j in range(mx.shape[1]) if i > j)
    D = sum(mx[i, j] for i in range(mx.shape[0]) for j in range(mx.shape[1]) if i == j)
    A = 1 - H - D
    return max(0.01, H), max(0.01, D), max(0.01, A)


# ═══════════════════════════════════════════════════════════════════
# RHO OPTIMIZATION
# ═══════════════════════════════════════════════════════════════════

def optimize_rho(pred_h, pred_a, actual_h, actual_a):
    """Optimize Dixon-Coles rho on low-scoring cells (0-0, 1-0, 0-1, 1-1)."""

    def neg_log_likelihood(rho):
        ll = 0
        for i in range(len(pred_h)):
            lam_h = max(0.3, min(4.5, pred_h[i]))
            lam_a = max(0.3, min(4.5, pred_a[i]))
            mx = dc_matrix(lam_h, lam_a, rho=rho)
            gh, ga = int(actual_h[i]), int(actual_a[i])
            if gh < mx.shape[0] and ga < mx.shape[1]:
                p = max(1e-10, mx[gh, ga])
                ll += np.log(p)
        return -ll

    result = minimize_scalar(neg_log_likelihood, bounds=(-0.15, 0.05), method="bounded")
    return result.x


# ═══════════════════════════════════════════════════════════════════
# LIGHTGBM TREE EXPORT
# ═══════════════════════════════════════════════════════════════════

def lgbm_tree_to_dict(tree):
    """Convert LightGBM tree dict to our simplified format."""
    if "leaf_value" in tree:
        return {"leaf_value": tree["leaf_value"]}
    return {
        "split_feature": tree["split_feature"],
        "threshold": tree["threshold"],
        "left_child": lgbm_tree_to_dict(tree["left_child"]),
        "right_child": lgbm_tree_to_dict(tree["right_child"]),
    }


def export_lgbm_model(model, name):
    """Export LightGBM model as simplified tree JSON."""
    booster = model.booster_
    model_dump = booster.dump_model()
    trees = []
    for tree_info in model_dump["tree_info"]:
        trees.append(lgbm_tree_to_dict(tree_info["tree_structure"]))

    # LightGBM Tweedie uses log link: prediction = exp(init_score + sum(tree_outputs))
    # The init_score is the raw score before any trees are added.
    # We extract it by getting the booster's prediction with no trees (init only).
    booster_obj = model.booster_

    # Get initial score: predict with num_iteration=0 returns raw init_score
    # For Tweedie, this is log(mean(y_train))
    # Method: raw_score - sum_of_all_trees = init_score
    # Or: use booster inner_predict with start_iteration=0, num_iteration=0
    # predict(raw_score=True, num_iteration=0) returns the init_score (log(mean(y)) for Tweedie)
    n_features = len(model.feature_names_in_) if hasattr(model, "feature_names_in_") else len(trees[0].get("split_feature", [0]))
    dummy = [[0.0] * n_features]
    avg_output = float(booster_obj.predict(dummy, raw_score=True, num_iteration=0)[0])

    lr_param = float(model.learning_rate)

    return {
        "trees": trees,
        "learning_rate": lr_param,
        "initial_score": avg_output,
        "n_trees": len(trees),
    }


# ═══════════════════════════════════════════════════════════════════
# GOLDEN TESTS
# ═══════════════════════════════════════════════════════════════════

def generate_golden_tests(model_home, model_away, test_features, n=10):
    """Generate deterministic test cases for TypeScript verification."""
    golden = []
    indices = np.linspace(0, len(test_features) - 1, n, dtype=int)
    for idx in indices:
        f = test_features[idx]
        features = f["features"]
        pred_h = model_home.predict([features])[0]
        pred_a = model_away.predict([features])[0]
        golden.append({
            "features": [round(x, 6) for x in features],
            "expected_h": round(float(pred_h), 6),
            "expected_a": round(float(pred_a), 6),
            "match": f"{f['ht']} vs {f['at']} ({f['date'].strftime('%Y-%m-%d') if pd.notna(f['date']) else '?'})",
        })
    return golden


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-optuna", action="store_true", help="Skip Optuna tuning")
    parser.add_argument("--use-npxg-csv", action="store_true", help="Use npxG CSV data")
    parser.add_argument("--use-full-csv", action="store_true", help="Use full Understat CSV (npxG + PPDA + deep)")
    parser.add_argument("--use-tactics", action="store_true", help="Use tactics CSV (setpiece, timing, gameState)")
    parser.add_argument("--use-players", action="store_true", help="Use players CSV (xG chain)")
    parser.add_argument("--use-roster", action="store_true", help="Use roster CSV (rotation rate)")
    parser.add_argument("--n-trials", type=int, default=30, help="Optuna trials")
    args = parser.parse_args()

    print("═" * 60)
    print("@annafrick13 v2.0 — LightGBM Tweedie Training")
    print("═" * 60)

    # ─── 1. Load Data ───
    print("\n═══ 1. LOADING DATA ═══")
    csv_all = load_csv_data()
    train_df = csv_all[csv_all["date_parsed"] < OOT_CUTOFF]
    test_df = csv_all[csv_all["date_parsed"] >= OOT_CUTOFF]
    print(f"  Total: {len(csv_all)}, Train: {len(train_df)}, Test: {len(test_df)}")

    npxg_lookup = {}
    full_lookup = {}
    if args.use_full_csv:
        full_lookup = load_full_understat_data(FULL_CSV)
        print(f"  Full Understat data: {len(full_lookup)} team-match entries (npxG + PPDA + deep)")
    elif args.use_npxg_csv:
        npxg_lookup = load_npxg_data(NPXG_CSV)
        print(f"  npxG data: {len(npxg_lookup)} matches loaded")
    else:
        print(f"  npxG: using goals-based EWMA (no npxG CSV)")

    # Load new v2.1 data sources
    tactics_data = {}
    players_data = {}
    roster_data = {}
    if args.use_tactics:
        tactics_data = load_tactics_data(TACTICS_CSV)
        print(f"  Tactics data: {len(tactics_data)} team-season entries")
    if args.use_players:
        players_data = load_players_data(PLAYERS_CSV)
        print(f"  Players data: {len(players_data)} team-season entries")
    if args.use_roster:
        roster_data = load_roster_rotation(ROSTER_CSV)
        print(f"  Roster data: {len(roster_data)} match-team entries")

    # ─── 2. Elo Ratings ───
    print("\n═══ 2. ELO RATINGS ═══")
    elo = compute_elo(train_df)
    print(f"  {len(elo)} teams")

    # ─── 3. Feature Engineering ───
    print(f"\n═══ 3. COMPUTING {len(FEATURE_NAMES)}-FEATURE VECTORS ═══")
    use_npxg = args.use_npxg_csv or args.use_full_csv
    all_features = compute_features(csv_all, elo, npxg_lookup, full_lookup=full_lookup, use_npxg=use_npxg,
                                    tactics_data=tactics_data, players_data=players_data, roster_data=roster_data)
    train_features = [f for f in all_features if pd.notna(f["date"]) and f["date"] < OOT_CUTOFF]
    test_features = [f for f in all_features if pd.notna(f["date"]) and f["date"] >= OOT_CUTOFF]
    print(f"  Train: {len(train_features)}, Test: {len(test_features)}")
    print(f"  Features: {FEATURE_NAMES}")

    X_train = np.array([f["features"] for f in train_features])
    y_home_train = np.array([f["gf"] for f in train_features])
    y_away_train = np.array([f["ga"] for f in train_features])

    X_test = np.array([f["features"] for f in test_features])
    y_home_test = np.array([f["gf"] for f in test_features])
    y_away_test = np.array([f["ga"] for f in test_features])

    # ─── 4. Optuna Tuning ───
    best_tweedie_power = 1.08  # default

    if not args.no_optuna:
        print(f"\n═══ 4. OPTUNA TUNING ({args.n_trials} trials) ═══")
        import optuna
        optuna.logging.set_verbosity(optuna.logging.WARNING)

        def objective(trial):
            tweedie_power = trial.suggest_float("tweedie_variance_power", 1.0, 1.15)
            lr = trial.suggest_float("learning_rate", 0.02, 0.1, log=True)
            n_est = trial.suggest_int("n_estimators", 200, 800, step=100)
            max_depth = trial.suggest_int("max_depth", 3, 5)
            min_leaf = trial.suggest_int("min_data_in_leaf", 30, 100, step=10)

            params = {
                "objective": "tweedie",
                "tweedie_variance_power": tweedie_power,
                "learning_rate": lr,
                "n_estimators": n_est,
                "max_depth": max_depth,
                "min_data_in_leaf": min_leaf,
                "num_leaves": 2 ** max_depth - 1,
                "verbose": -1,
                "n_jobs": -1,
            }

            # Train home + away models
            model_h = lgb.LGBMRegressor(monotone_constraints=MONO_HOME, **params)
            model_h.fit(X_train, y_home_train)

            model_a = lgb.LGBMRegressor(monotone_constraints=MONO_AWAY, **params)
            model_a.fit(X_train, y_away_train)

            # Evaluate: Brier score from matrix
            pred_h = np.clip(model_h.predict(X_test), 0.3, 4.5)
            pred_a = np.clip(model_a.predict(X_test), 0.3, 4.5)

            brier_sum = 0
            for i in range(len(X_test)):
                mx = dc_matrix(pred_h[i], pred_a[i])
                H, D, A = matrix_1x2(mx)
                actual = [
                    1 if y_home_test[i] > y_away_test[i] else 0,
                    1 if y_home_test[i] == y_away_test[i] else 0,
                    1 if y_home_test[i] < y_away_test[i] else 0,
                ]
                brier_sum += sum((p - a) ** 2 for p, a in zip([H, D, A], actual))

            return brier_sum / len(X_test)

        study = optuna.create_study(direction="minimize")
        study.optimize(objective, n_trials=args.n_trials, show_progress_bar=True)

        best = study.best_params
        best_tweedie_power = best["tweedie_variance_power"]
        print(f"  Best Brier: {study.best_value:.4f}")
        print(f"  Best params: {best}")
    else:
        print("\n═══ 4. SKIPPING OPTUNA (using defaults) ═══")
        best = {
            "tweedie_variance_power": 1.08,
            "learning_rate": 0.05,
            "n_estimators": 500,
            "max_depth": 4,
            "min_data_in_leaf": 50,
        }

    # ─── 5. Train Final Models ───
    print("\n═══ 5. TRAINING FINAL MODELS ═══")

    final_params = {
        "objective": "tweedie",
        "tweedie_variance_power": best.get("tweedie_variance_power", 1.08),
        "learning_rate": best.get("learning_rate", 0.05),
        "n_estimators": best.get("n_estimators", 500),
        "max_depth": best.get("max_depth", 4),
        "min_data_in_leaf": best.get("min_data_in_leaf", 50),
        "num_leaves": 2 ** best.get("max_depth", 4) - 1,
        "verbose": -1,
        "n_jobs": -1,
    }

    print(f"  Params: {final_params}")

    model_home = lgb.LGBMRegressor(monotone_constraints=MONO_HOME, **final_params)
    model_home.fit(X_train, y_home_train)

    model_away = lgb.LGBMRegressor(monotone_constraints=MONO_AWAY, **final_params)
    model_away.fit(X_train, y_away_train)

    # Evaluate
    pred_h = np.clip(model_home.predict(X_test), 0.3, 4.5)
    pred_a = np.clip(model_away.predict(X_test), 0.3, 4.5)

    mae_h = np.mean(np.abs(pred_h - y_home_test))
    mae_a = np.mean(np.abs(pred_a - y_away_test))
    print(f"  Home MAE: {mae_h:.4f}, Away MAE: {mae_a:.4f}")

    # ─── 6. Optimize Rho ───
    print("\n═══ 6. OPTIMIZING RHO ═══")
    rho_opt = optimize_rho(pred_h, pred_a, y_home_test, y_away_test)
    print(f"  Optimal rho: {rho_opt:.4f}")

    # ─── 7. Brier Score ───
    print("\n═══ 7. EVALUATION ═══")

    brier_preds = []
    actual_1x2 = []
    for i in range(len(X_test)):
        mx = dc_matrix(pred_h[i], pred_a[i], rho=rho_opt)
        H, D, A = matrix_1x2(mx)
        brier_preds.append([H, D, A])
        actual_1x2.append([
            1 if y_home_test[i] > y_away_test[i] else 0,
            1 if y_home_test[i] == y_away_test[i] else 0,
            1 if y_home_test[i] < y_away_test[i] else 0,
        ])

    brier_arr = np.array(brier_preds)
    act_arr = np.array(actual_1x2)
    brier_score = np.mean(np.sum((brier_arr - act_arr) ** 2, axis=1))

    print(f"  Brier Score (OOS): {brier_score:.4f}")
    print(f"  (v1 Poisson GLM was ~0.5884)")

    # Feature importance
    print("\n  Feature Importance (Home model):")
    imp = model_home.feature_importances_
    for i in np.argsort(imp)[::-1]:
        print(f"    {FEATURE_NAMES[i]:25s} {imp[i]:5d}")

    # ─── 8. Golden Tests ───
    print("\n═══ 8. GOLDEN TESTS ═══")
    golden = generate_golden_tests(model_home, model_away, test_features, n=10)
    for g in golden[:3]:
        print(f"  {g['match']}: H={g['expected_h']:.3f}, A={g['expected_a']:.3f}")

    # ─── 9. Export ───
    print("\n═══ 9. EXPORTING ═══")

    home_export = export_lgbm_model(model_home, "home")
    away_export = export_lgbm_model(model_away, "away")

    output = {
        "version": "2.0",
        "engine": "poisson-ml-v2",
        "home_model": home_export,
        "away_model": away_export,
        "rho_optimal": round(rho_opt, 4),
        "feature_names": FEATURE_NAMES,
        "golden_tests": golden,
        "team_season_features": {
            f"{k[0]}|{k[1]}|{k[2]}": {**v, **players_data.get(k, {})}
            for k, v in tactics_data.items()
        } if tactics_data else {},
        "meta": {
            "n_train": len(train_features),
            "n_test": len(test_features),
            "brier_oos": round(brier_score, 4),
            "mae_home": round(mae_h, 4),
            "mae_away": round(mae_a, 4),
            "tweedie_power": best.get("tweedie_variance_power", 1.08),
            "max_depth": best.get("max_depth", 4),
            "n_estimators": best.get("n_estimators", 500),
            "learning_rate": best.get("learning_rate", 0.05),
            "min_data_in_leaf": best.get("min_data_in_leaf", 50),
            "oot_cutoff": str(OOT_CUTOFF.date()),
            "npxg_used": args.use_npxg_csv or args.use_full_csv,
            "full_understat_data": args.use_full_csv,
            "tactics_used": args.use_tactics,
            "players_used": args.use_players,
            "roster_used": args.use_roster,
            "trained_at": pd.Timestamp.now().isoformat(),
        },
    }

    output_path = os.path.join(PROJECT_ROOT, "public", "lgbm-model-v2.json")
    with open(output_path, "w") as f:
        json.dump(output, f)
    print(f"  Model: {output_path}")

    # File size
    size_kb = os.path.getsize(output_path) / 1024
    print(f"  Size: {size_kb:.0f} KB ({home_export['n_trees']} + {away_export['n_trees']} trees)")

    print(f"\n{'═' * 60}")
    print(f"  @annafrick13 v2.0 — DONE")
    print(f"  Brier: {brier_score:.4f} (target: < 0.5884)")
    print(f"  Rho: {rho_opt:.4f}")
    print(f"  Trees: {home_export['n_trees']}H + {away_export['n_trees']}A")
    print(f"{'═' * 60}")


if __name__ == "__main__":
    main()
