#!/usr/bin/env python3
"""
FODZE Shots-to-xG Model — Train regression from CSV shot data + Understat real xG

Fits a SEPARATE linear regression per Understat league (BL, EPL, La Liga,
Serie A, Ligue 1, Eredivisie) plus a POOLED fallback across all of them.

Runtime (scripts/backfill-shots-xg.mjs) picks per-league coefficients
first and falls back to the pooled model for leagues where we have shot
CSVs but no real-xG training data (Championship, Liga 2, Serie B, etc.).

Model shape: xG ≈ β₀ + β₁ × ShotsOnTarget + β₂ × ShotsOffTarget

Why per league matters: Nebenliga shots are on average lower quality
(longer range, more blocks, more pressure) than Top-5 shots. A pooled
model trained on Top-5 overestimates xG in Championship/Liga 2 by
0.1–0.2 per match — small per match, large cumulative across 8-game
windows the engines consume.

Output: public/shots-xg-model.json
  {
    "pooled": { intercept, coef_*, r2, mae, rmse, n_train, ... },
    "leagues": {
      "bundesliga": { intercept, coef_*, r2, mae, rmse, n_train },
      "epl":        { ... },
      ...
    },
    "train_season": "2024/25",
    "_formula": "xG = intercept + coef_on_target*HST + coef_off_target*(HS-HST)"
  }
"""

import json, os, csv
import numpy as np
from datetime import datetime

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
UNDERSTAT_CSV = os.path.join(PROJECT_ROOT, "tools", "understat_full_matches.csv")
HISTORIE_DIR = os.path.join(PROJECT_ROOT, "Historie", "data")
OUTPUT = os.path.join(PROJECT_ROOT, "public", "shots-xg-model.json")

# Map Understat league names → football-data.co.uk CSV codes
LEAGUE_MAP = {
    "bundesliga": "D1", "epl": "E0", "la_liga": "SP1",
    "serie_a": "I1", "ligue_1": "F1", "eredivisie": "N1",
}

# Minimum sample size before we trust a per-league fit. Below this we
# fall back to the pooled model (and log a warning). 300 team-matches
# = ~150 matches = half a Top-5 season — enough for a 3-param linear
# regression to stabilize within ~5% of the asymptotic coefficients.
MIN_SAMPLES_PER_LEAGUE = 300

# Map Understat team names → CSV team names (subset for matching)
TEAM_MAP = {
    "Bayern Munich": "Bayern Munich", "RasenBallsport Leipzig": "RB Leipzig",
    "Borussia Dortmund": "Dortmund", "Bayer Leverkusen": "Leverkusen",
    "Eintracht Frankfurt": "Ein Frankfurt", "VfB Stuttgart": "Stuttgart",
    "Freiburg": "Freiburg", "Hoffenheim": "Hoffenheim",
    "Wolfsburg": "Wolfsburg", "Borussia M.Gladbach": "M'gladbach",
    "Werder Bremen": "Werder Bremen", "Augsburg": "Augsburg",
    "Mainz 05": "Mainz", "Union Berlin": "Union Berlin",
    "Bochum": "Bochum", "FC Cologne": "FC Koln", "Heidenheim": "Heidenheim",
    "Manchester City": "Man City", "Manchester United": "Man United",
    "Tottenham": "Tottenham", "Newcastle United": "Newcastle",
    "West Ham": "West Ham", "Brighton": "Brighton", "Wolverhampton Wanderers": "Wolves",
    "Bournemouth": "Bournemouth", "Nottingham Forest": "Nott'm Forest",
    "Crystal Palace": "Crystal Palace", "Brentford": "Brentford",
    "Barcelona": "Barcelona", "Atletico Madrid": "Ath Madrid",
    "Athletic Club": "Ath Bilbao", "Real Sociedad": "Sociedad",
    "Real Betis": "Betis", "Villarreal": "Villarreal", "Sevilla": "Sevilla",
    "Valencia": "Valencia", "Celta Vigo": "Celta", "Getafe": "Getafe",
    "Osasuna": "Osasuna", "Mallorca": "Mallorca", "Rayo Vallecano": "Vallecano",
    "Inter": "Inter", "AC Milan": "Milan", "Roma": "Roma",
    "Napoli": "Napoli", "Lazio": "Lazio", "Fiorentina": "Fiorentina",
    "Torino": "Torino", "Sassuolo": "Sassuolo", "Verona": "Verona",
    "Paris Saint Germain": "Paris SG", "Monaco": "Monaco",
    "Marseille": "Marseille", "Lille": "Lille", "Lyon": "Lyon",
    "Nice": "Nice", "Rennes": "Rennes", "Lens": "Lens",
    "Strasbourg": "Strasbourg", "Toulouse": "Toulouse",
    "Ajax": "Ajax", "PSV": "PSV Eindhoven", "Feyenoord": "Feyenoord",
    "AZ": "AZ Alkmaar", "Twente": "Twente", "Utrecht": "Utrecht",
}

print("═══ FODZE Shots-to-xG Model Training (per-league + pooled) ═══\n")

# ── 1. Load Understat per-match data (2024/25 season) ──
print("Loading Understat data (2024/25)...")
understat = {}  # key: (csv_team, date, venue) → {xg, xga, league}

# Reverse lookup: Understat league slugs inside CSV → our league key
UNDERSTAT_SLUG = {
    "Bundesliga": "bundesliga", "EPL": "epl", "La_liga": "la_liga",
    "Serie_A": "serie_a", "Ligue_1": "ligue_1", "Eredivisie": "eredivisie",
}

with open(UNDERSTAT_CSV, "r") as f:
    for row in csv.DictReader(f):
        if row["season"] != "2024/25":
            continue
        team = row["team"]
        csv_name = TEAM_MAP.get(team, team)
        date = row["date"][:10]
        venue = row["h_a"]
        xg = float(row["xg"])
        xga = float(row["xga"])
        # league may or may not be in the CSV — best-effort attach it here
        league_raw = row.get("league", "")
        understat[(csv_name, date, venue)] = {
            "xg": xg, "xga": xga,
            "league_raw": league_raw,
        }

print(f"  {len(understat)} Understat per-match entries loaded\n")

# ── 2. Per-league training sets ──
print("Joining CSV shot data per league...")
per_league = {lg: {"X": [], "y": []} for lg in LEAGUE_MAP}
matches_missed = 0

for league, csv_code in LEAGUE_MAP.items():
    csv_path = os.path.join(HISTORIE_DIR, f"{csv_code}.csv")
    if not os.path.exists(csv_path):
        print(f"  {league}: CSV missing ({csv_code}.csv)")
        continue

    with open(csv_path, "r", encoding="latin-1") as f:
        reader = csv.DictReader(f)
        for row in reader:
            date_str = row.get("Date", "").strip()
            try:
                if len(date_str.split("/")[-1]) == 4:
                    dt = datetime.strptime(date_str, "%d/%m/%Y")
                else:
                    dt = datetime.strptime(date_str, "%d/%m/%y")
                date_iso = dt.strftime("%Y-%m-%d")
            except Exception:
                continue

            ht = row.get("HomeTeam", "").strip()
            at = row.get("AwayTeam", "").strip()

            try:
                hs = int(row.get("HS", 0))
                as_ = int(row.get("AS", 0))
                hst = int(row.get("HST", 0))
                ast = int(row.get("AST", 0))
            except (ValueError, TypeError):
                continue

            key_h = (ht, date_iso, "h")
            if key_h in understat:
                per_league[league]["X"].append([hst, hs - hst])
                per_league[league]["y"].append(understat[key_h]["xg"])
            else:
                matches_missed += 1

            key_a = (at, date_iso, "a")
            if key_a in understat:
                per_league[league]["X"].append([ast, as_ - ast])
                per_league[league]["y"].append(understat[key_a]["xg"])
            else:
                matches_missed += 1

total_joined = sum(len(d["X"]) for d in per_league.values())
print(f"  Joined {total_joined} team-matches across {len(LEAGUE_MAP)} leagues")
print(f"  Missed {matches_missed} (name/date mismatch — common for newly promoted teams)\n")

# ── 3. Fit one OLS model per league ──
def fit_ols(X_list, y_list):
    """Fit xG = β₀ + β₁·SOT + β₂·SOFF; return coefs + metrics."""
    if len(X_list) == 0:
        return None
    X = np.array(X_list, dtype=float)
    y = np.array(y_list, dtype=float)
    X1 = np.column_stack([np.ones(len(X)), X])
    beta, *_ = np.linalg.lstsq(X1, y, rcond=None)
    y_pred = X1 @ beta
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    mae = float(np.mean(np.abs(y - y_pred)))
    rmse = float(np.sqrt(np.mean((y - y_pred) ** 2)))
    return {
        "intercept": round(float(beta[0]), 6),
        "coef_shots_on_target": round(float(beta[1]), 6),
        "coef_shots_off_target": round(float(beta[2]), 6),
        "r2": round(r2, 4),
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "n_train": len(X),
        "mean_xg_actual": round(float(np.mean(y)), 4),
        "mean_xg_predicted": round(float(np.mean(y_pred)), 4),
    }

print("═══ PER-LEAGUE FITS ═══")
leagues_out = {}
low_sample_warnings = []

for league in LEAGUE_MAP:
    data = per_league[league]
    n = len(data["X"])
    if n < MIN_SAMPLES_PER_LEAGUE:
        low_sample_warnings.append((league, n))
        print(f"  {league:14s} SKIP (only {n} samples, min {MIN_SAMPLES_PER_LEAGUE}) — will use pooled")
        continue
    fit = fit_ols(data["X"], data["y"])
    if fit is None:
        continue
    leagues_out[league] = fit
    print(f"  {league:14s} n={fit['n_train']:4d}  R²={fit['r2']:.3f}  "
          f"xG = {fit['intercept']:+.3f} + {fit['coef_shots_on_target']:.3f}·SOT "
          f"+ {fit['coef_shots_off_target']:.3f}·SOFF   "
          f"Ø actual={fit['mean_xg_actual']} pred={fit['mean_xg_predicted']}")

print()

# ── 4. Pooled fallback (all leagues combined) ──
print("═══ POOLED FALLBACK ═══")
X_all, y_all = [], []
for data in per_league.values():
    X_all.extend(data["X"])
    y_all.extend(data["y"])
pooled = fit_ols(X_all, y_all)
print(f"  pooled         n={pooled['n_train']:4d}  R²={pooled['r2']:.3f}  "
      f"xG = {pooled['intercept']:+.3f} + {pooled['coef_shots_on_target']:.3f}·SOT "
      f"+ {pooled['coef_shots_off_target']:.3f}·SOFF   "
      f"Ø actual={pooled['mean_xg_actual']} pred={pooled['mean_xg_predicted']}\n")

# Sanity checks on sample predictions against both pooled and a per-league fit
sample_leagues = [l for l in ("bundesliga", "epl") if l in leagues_out]
print("Sample predictions (pooled vs per-league):")
for sot, soff in [(3, 5), (5, 8), (8, 10), (1, 3)]:
    pool_pred = pooled["intercept"] + pooled["coef_shots_on_target"] * sot + pooled["coef_shots_off_target"] * soff
    line = f"  {sot} SOT + {soff} SOFF → pooled={pool_pred:.2f}"
    for lg in sample_leagues:
        m = leagues_out[lg]
        lg_pred = m["intercept"] + m["coef_shots_on_target"] * sot + m["coef_shots_off_target"] * soff
        line += f"  {lg}={lg_pred:.2f}"
    print(line)

# ── 5. Export model ──
output = {
    "pooled": pooled,
    "leagues": leagues_out,
    "train_season": "2024/25",
    "min_samples_per_league": MIN_SAMPLES_PER_LEAGUE,
    "_formula": "xG = intercept + coef_shots_on_target * SOT + coef_shots_off_target * (Shots - SOT)",
    "_notes": (
        "Per-league models are applied when the target league key is in `leagues`. "
        "Otherwise the runtime falls back to `pooled`. The pooled fit is trained on "
        "Top-5 + Eredivisie, which overestimates xG in lower-quality leagues "
        "(Championship, Liga 2, Serie B) by ~0.1–0.2 per match — use pooled "
        "results for these leagues with that caveat in mind."
    ),
}
if low_sample_warnings:
    output["_low_sample_skipped"] = [{"league": lg, "n": n} for lg, n in low_sample_warnings]

with open(OUTPUT, "w") as f:
    json.dump(output, f, indent=2)

print(f"\n✅ Model saved to {OUTPUT}")
print(f"   Per-league fits: {len(leagues_out)}")
print(f"   Pooled fallback: n={pooled['n_train']}")
if low_sample_warnings:
    print(f"   Low-sample skipped: {', '.join(f'{lg} ({n})' for lg, n in low_sample_warnings)}")
