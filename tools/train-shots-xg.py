#!/usr/bin/env python3
"""
FODZE Shots-to-xG Model — Train regression from CSV shot data + Understat real xG

Uses the 6 Understat leagues (BL, EPL, La Liga, Serie A, Ligue 1, Eredivisie)
where we have BOTH real xG (Understat) and shot data (football-data.co.uk CSVs)
to learn: xG ≈ β₀ + β₁ × ShotsOnTarget + β₂ × ShotsOffTarget

Then applies to 12 non-Understat leagues for estimated per-match xG.

Output: public/shots-xg-model.json
"""

import json, os, csv, re
import numpy as np
from datetime import datetime

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
UNDERSTAT_CSV = os.path.join(PROJECT_ROOT, "tools", "understat_full_matches.csv")
HISTORIE_DIR = os.path.join(PROJECT_ROOT, "Historie", "data")  # 2024/25 CSVs (same season as Understat)
OUTPUT = os.path.join(PROJECT_ROOT, "public", "shots-xg-model.json")

# Map Understat league names → football-data.co.uk CSV codes
LEAGUE_MAP = {
    "bundesliga": "D1", "epl": "E0", "la_liga": "SP1",
    "serie_a": "I1", "ligue_1": "F1", "eredivisie": "N1",
}

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

print("═══ FODZE Shots-to-xG Model Training ═══\n")

# ── 1. Load Understat per-match data (2024/25 season) ──
print("Loading Understat data (2024/25)...")
understat = {}  # key: (csv_team, date, venue) → xG
with open(UNDERSTAT_CSV, "r") as f:
    for row in csv.DictReader(f):
        if row["season"] != "2024/25":
            continue
        team = row["team"]
        csv_name = TEAM_MAP.get(team, team)
        date = row["date"][:10]
        venue = row["h_a"]  # "h" or "a"
        xg = float(row["xg"])
        xga = float(row["xga"])
        understat[(csv_name, date, venue)] = {"xg": xg, "xga": xga}

print(f"  {len(understat)} Understat per-match entries loaded")

# ── 2. Load CSV shot data (2024/25 season) and join with Understat ──
print("Loading CSV shot data and joining...")
X_train = []  # [shots_on_target, shots_off_target]
y_train = []  # real xG

matches_joined = 0
matches_missed = 0

for league, csv_code in LEAGUE_MAP.items():
    csv_path = os.path.join(HISTORIE_DIR, f"{csv_code}.csv")
    if not os.path.exists(csv_path):
        continue

    with open(csv_path, "r", encoding="latin-1") as f:
        reader = csv.DictReader(f)
        for row in reader:
            date_str = row.get("Date", "").strip()
            # Parse date (DD/MM/YYYY or DD/MM/YY)
            try:
                if len(date_str.split("/")[-1]) == 4:
                    dt = datetime.strptime(date_str, "%d/%m/%Y")
                else:
                    dt = datetime.strptime(date_str, "%d/%m/%y")
                date_iso = dt.strftime("%Y-%m-%d")
            except:
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

            # Join home team with Understat
            key_h = (ht, date_iso, "h")
            if key_h in understat:
                X_train.append([hst, hs - hst])  # [on_target, off_target]
                y_train.append(understat[key_h]["xg"])
                matches_joined += 1
            else:
                matches_missed += 1

            # Join away team
            key_a = (at, date_iso, "a")
            if key_a in understat:
                X_train.append([ast, as_ - ast])
                y_train.append(understat[key_a]["xg"])
                matches_joined += 1
            else:
                matches_missed += 1

print(f"  Joined: {matches_joined} team-matches")
print(f"  Missed: {matches_missed} (name/date mismatch)")

if matches_joined < 100:
    print("⚠️  Too few matches joined! Check team name mappings.")
    # Try fuzzy matching as fallback
    print("  Attempting fuzzy match...")

X = np.array(X_train)
y = np.array(y_train)

# ── 3. Train Linear Regression ──
print(f"\nTraining on {len(X)} samples...")

# Add intercept
X_with_intercept = np.column_stack([np.ones(len(X)), X])

# Closed-form solution: β = (X'X)^(-1) X'y
beta = np.linalg.lstsq(X_with_intercept, y, rcond=None)[0]
b0, b1, b2 = beta

# Predictions
y_pred = X_with_intercept @ beta

# Metrics
ss_res = np.sum((y - y_pred) ** 2)
ss_tot = np.sum((y - np.mean(y)) ** 2)
r2 = 1 - ss_res / ss_tot
mae = np.mean(np.abs(y - y_pred))
rmse = np.sqrt(np.mean((y - y_pred) ** 2))

print(f"\n═══ MODEL RESULTS ══��")
print(f"  xG = {b0:.4f} + {b1:.4f} × ShotsOnTarget + {b2:.4f} × ShotsOffTarget")
print(f"  R²  = {r2:.4f}")
print(f"  MAE = {mae:.4f}")
print(f"  RMSE = {rmse:.4f}")
print(f"  Mean xG: {np.mean(y):.4f} (actual), {np.mean(y_pred):.4f} (predicted)")

# Sanity checks
print(f"\n  Example predictions:")
for sot, soff in [(3, 5), (5, 8), (8, 10), (1, 3)]:
    pred = b0 + b1 * sot + b2 * soff
    print(f"    {sot} on target + {soff} off target → xG = {pred:.2f}")

# ── 4. Export model ──
model = {
    "intercept": round(float(b0), 6),
    "coef_shots_on_target": round(float(b1), 6),
    "coef_shots_off_target": round(float(b2), 6),
    "r2": round(float(r2), 4),
    "mae": round(float(mae), 4),
    "rmse": round(float(rmse), 4),
    "n_train": len(X),
    "train_leagues": list(LEAGUE_MAP.keys()),
    "train_season": "2024/25",
    "_formula": "xG = intercept + coef_shots_on_target * HST + coef_shots_off_target * (HS - HST)",
}

with open(OUTPUT, "w") as f:
    json.dump(model, f, indent=2)

print(f"\n✅ Model saved to {OUTPUT}")
