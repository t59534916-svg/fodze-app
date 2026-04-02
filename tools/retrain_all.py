#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════
FODZE Unified Retrainer — Fixes Entity Resolution, OOT Split,
Platt Calibration, and EWMA Features in One Script
═══════════════════════════════════════════════════════════════════

Output:
  public/ensemble-model.json  (Elo, Logistic, Weights)
  public/calibration_curves.json  (Platt params)

Usage:
  source tools/venv/bin/activate
  python3 tools/retrain_all.py
"""

import json, os, glob
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from scipy.stats import poisson
from scipy.optimize import minimize

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
HISTORIE_DIR = os.path.join(PROJECT_ROOT, "Historie")

DIV_TO_LEAGUE = {
    "D1": "bundesliga", "D2": "bundesliga2",
    "E0": "epl", "E1": "championship", "E2": "league_one", "E3": "league_two",
    "SP1": "la_liga", "SP2": "la_liga2",
    "I1": "serie_a", "I2": "serie_b",
    "F1": "ligue_1", "F2": "ligue_2",
    "N1": "eredivisie",
    "B1": "jupiler_pro", "P1": "primeira_liga", "T1": "super_lig",
    "SC0": "scottish_prem", "G1": "greek_sl",
}
LEAGUE_AVGS = {
    "bundesliga": 1.38, "bundesliga2": 1.51, "epl": 1.35, "championship": 1.23,
    "league_one": 1.29, "league_two": 1.25, "la_liga": 1.25, "la_liga2": 1.27,
    "serie_a": 1.32, "serie_b": 1.23, "ligue_1": 1.30, "ligue_2": 1.29,
    "eredivisie": 1.49, "jupiler_pro": 1.38, "primeira_liga": 1.28,
    "super_lig": 1.47, "scottish_prem": 1.48, "greek_sl": 1.22,
}
LEAGUE_HFS = {
    "bundesliga": 1.28, "bundesliga2": 1.18, "epl": 1.22, "championship": 1.41,
    "league_one": 1.19, "league_two": 1.22, "la_liga": 1.30, "la_liga2": 1.34,
    "serie_a": 1.27, "serie_b": 1.22, "ligue_1": 1.32, "ligue_2": 1.41,
    "eredivisie": 1.31, "jupiler_pro": 1.37, "primeira_liga": 1.20,
    "super_lig": 1.31, "scottish_prem": 1.34, "greek_sl": 1.11,
}

# ═══ GLOBAL OOT CUTOFF ═══
OOT_CUTOFF = pd.Timestamp("2023-08-01")
EWMA_ALPHA = 0.15  # ~6 match half-life

# ─── Load CSV Data ────────────────────────────────────────────────────

print("═══ LOADING DATA ═══")
csv_dfs = []
for folder in sorted(glob.glob(os.path.join(HISTORIE_DIR, "data*"))):
    for csv_file in glob.glob(os.path.join(folder, "*.csv")):
        try: df = pd.read_csv(csv_file, encoding="latin-1", on_bad_lines="skip")
        except: continue
        df.columns = [c.strip().strip("\ufeff") for c in df.columns]
        if "Div" not in df.columns or "FTHG" not in df.columns: continue
        if "HomeTeam" not in df.columns:
            if "HT" in df.columns: df = df.rename(columns={"HT": "HomeTeam", "AT": "AwayTeam"})
            else: continue
        df = df[df["Div"].isin(DIV_TO_LEAGUE.keys())]
        cols = ["Div", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]
        if "Date" in df.columns: cols.append("Date")
        df = df[[c for c in cols if c in df.columns]].dropna(subset=["FTHG", "FTAG"])
        df["FTHG"] = pd.to_numeric(df["FTHG"], errors="coerce")
        df["FTAG"] = pd.to_numeric(df["FTAG"], errors="coerce")
        df = df.dropna()
        csv_dfs.append(df)

csv_all = pd.concat(csv_dfs, ignore_index=True)

# Parse dates
if "Date" in csv_all.columns:
    csv_all["date_parsed"] = pd.to_datetime(csv_all["Date"], format="%d/%m/%Y", errors="coerce")
    # Try alternative formats for unparsed dates
    mask = csv_all["date_parsed"].isna()
    if mask.any():
        csv_all.loc[mask, "date_parsed"] = pd.to_datetime(csv_all.loc[mask, "Date"], format="%d/%m/%y", errors="coerce")
    csv_all = csv_all.dropna(subset=["date_parsed"]).sort_values("date_parsed")
else:
    print("⚠ No Date column — using positional ordering")
    csv_all["date_parsed"] = pd.NaT

csv_all["league"] = csv_all["Div"].map(DIV_TO_LEAGUE)
train_df = csv_all[csv_all["date_parsed"] < OOT_CUTOFF]
test_df = csv_all[csv_all["date_parsed"] >= OOT_CUTOFF]

print(f"  Total: {len(csv_all)} matches")
print(f"  Train (before {OOT_CUTOFF.date()}): {len(train_df)}")
print(f"  Test  (after  {OOT_CUTOFF.date()}): {len(test_df)}")

# ═══ 1. ELO RATINGS (train only) ═════════════════════════════════════

print("\n═══ 1. ELO RATINGS ═══")
K, HOME_ADV = 32, 65
elo = {}
def get_elo(t): return elo.get(t, 1500)

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

# Snapshot Elo at cutoff
elo_snapshot = {k: round(v, 1) for k, v in elo.items()}
sorted_elo = sorted(elo.items(), key=lambda x: -x[1])
print(f"  {len(elo)} teams, trained on {len(train_df)} matches")
print(f"  Top 5: {', '.join(f'{t} ({r:.0f})' for t, r in sorted_elo[:5])}")

# Continue Elo through test for evaluation only
elo_test = dict(elo)  # Copy for test evaluation

# ═══ 2. EWMA FEATURES ════════════════════════════════════════════════

print("\n═══ 2. COMPUTING EWMA FEATURES ═══")

DERBIES = {
    # Germany
    frozenset({"Bayern Munich", "Munich 1860"}), frozenset({"Dortmund", "Schalke 04"}),
    frozenset({"Hamburg", "Werder Bremen"}), frozenset({"Hamburg", "St Pauli"}),
    frozenset({"M'gladbach", "FC Koln"}), frozenset({"Hertha", "Union Berlin"}),
    frozenset({"Nurnberg", "Greuther Furth"}), frozenset({"Stuttgart", "Karlsruhe"}),
    # England
    frozenset({"Liverpool", "Everton"}), frozenset({"Man United", "Man City"}),
    frozenset({"Arsenal", "Tottenham"}), frozenset({"Chelsea", "Fulham"}),
    frozenset({"Newcastle", "Sunderland"}), frozenset({"Aston Villa", "Birmingham"}),
    # Spain
    frozenset({"Barcelona", "Real Madrid"}), frozenset({"Ath Madrid", "Real Madrid"}),
    frozenset({"Barcelona", "Espanol"}), frozenset({"Sevilla", "Betis"}),
    frozenset({"Sociedad", "Ath Bilbao"}),
    # Italy
    frozenset({"Inter", "Milan"}), frozenset({"Roma", "Lazio"}),
    frozenset({"Juventus", "Torino"}), frozenset({"Genoa", "Sampdoria"}),
    # France
    frozenset({"Paris SG", "Marseille"}), frozenset({"Lyon", "St Etienne"}),
}

def is_derby(ht, at):
    return 1.0 if frozenset({ht, at}) in DERBIES else 0.0

def compute_ewma_per_team(df_sorted):
    """Compute per-team EWMA features chronologically. Returns dict[team] -> list of feature dicts."""
    team_ewma = {}  # team -> {ewma_gf, ewma_ga, ewma_form}
    team_last_date = {}  # team -> last match date (for rest days)
    # SoS proxy: track opponent Elo as proxy for schedule strength
    team_opp_elo_sum = {}  # team -> {sum_opp_elo, n_matches}

    features_per_match = []
    for _, row in df_sorted.iterrows():
        ht, at = str(row["HomeTeam"]), str(row["AwayTeam"])
        gf, ga = int(row["FTHG"]), int(row["FTAG"])
        lg = str(row.get("league", ""))
        dt = row.get("date_parsed", pd.NaT)

        # Get EWMA state BEFORE this match
        h_state = team_ewma.get(ht, {"gf": 1.3, "ga": 1.3, "form": 1.5})
        a_state = team_ewma.get(at, {"gf": 1.3, "ga": 1.3, "form": 1.5})

        # Features (symmetrical differences)
        xg_diff = h_state["gf"] - a_state["gf"]
        xga_diff = h_state["ga"] - a_state["ga"]
        elo_diff = (get_elo(ht) - get_elo(at)) / 400
        total = h_state["gf"] + a_state["gf"]
        hf = LEAGUE_HFS.get(lg, 1.25)
        form_diff = h_state["form"] - a_state["form"]

        # Rest days: days since last match for each team
        rest_h = 7.0  # default 1 week
        rest_a = 7.0
        if pd.notna(dt):
            if ht in team_last_date and pd.notna(team_last_date[ht]):
                rest_h = max(1, min(30, (dt - team_last_date[ht]).days))
            if at in team_last_date and pd.notna(team_last_date[at]):
                rest_a = max(1, min(30, (dt - team_last_date[at]).days))
        rest_diff_norm = (rest_h - rest_a) / 7.0  # normalized by 1 week

        # SoS proxy: difference in average opponent Elo faced
        h_sos = team_opp_elo_sum.get(ht, {"sum": 0, "n": 0})
        a_sos = team_opp_elo_sum.get(at, {"sum": 0, "n": 0})
        avg_opp_elo_h = (h_sos["sum"] / h_sos["n"]) if h_sos["n"] > 0 else 1500
        avg_opp_elo_a = (a_sos["sum"] / a_sos["n"]) if a_sos["n"] > 0 else 1500
        sos_strength = (avg_opp_elo_h - avg_opp_elo_a) / 400  # normalized like elo_diff

        derby = is_derby(ht, at)

        features_per_match.append({
            "features": [xg_diff, xga_diff, elo_diff, total, hf, form_diff],
            "features_ext": [rest_diff_norm, sos_strength, derby],
            "gf": gf, "ga": ga, "ht": ht, "at": at, "league": lg, "date": dt,
        })

        # Update EWMA AFTER this match
        a = EWMA_ALPHA
        h_pts = 3 if gf > ga else 1 if gf == ga else 0
        a_pts = 3 if ga > gf else 1 if gf == ga else 0

        team_ewma[ht] = {
            "gf": a * gf + (1 - a) * h_state["gf"],
            "ga": a * ga + (1 - a) * h_state["ga"],
            "form": a * h_pts + (1 - a) * h_state["form"],
        }
        team_ewma[at] = {
            "gf": a * ga + (1 - a) * a_state["gf"],
            "ga": a * gf + (1 - a) * a_state["ga"],
            "form": a * a_pts + (1 - a) * a_state["form"],
        }

        # Update last match date and opponent Elo tracking
        if pd.notna(dt):
            team_last_date[ht] = dt
            team_last_date[at] = dt
        team_opp_elo_sum[ht] = {"sum": h_sos["sum"] + get_elo(at), "n": h_sos["n"] + 1}
        team_opp_elo_sum[at] = {"sum": a_sos["sum"] + get_elo(ht), "n": a_sos["n"] + 1}

    return features_per_match

all_features = compute_ewma_per_team(csv_all)
train_features = [f for f in all_features if f["date"] < OOT_CUTOFF]
test_features = [f for f in all_features if f["date"] >= OOT_CUTOFF]

print(f"  Train features: {len(train_features)}")
print(f"  Test features:  {len(test_features)}")

# ═══ 3. LOGISTIC REGRESSION (train only) ══════════════════════════════

print("\n═══ 3. LOGISTIC REGRESSION ═══")

X_train = np.array([f["features"] for f in train_features])
y_train = np.array([2 if f["gf"] > f["ga"] else 1 if f["gf"] == f["ga"] else 0 for f in train_features])

scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)

lr = LogisticRegression(max_iter=2000, C=1.0)
lr.fit(X_train_scaled, y_train)

train_acc = lr.score(X_train_scaled, y_train)

X_test = np.array([f["features"] for f in test_features])
y_test = np.array([2 if f["gf"] > f["ga"] else 1 if f["gf"] == f["ga"] else 0 for f in test_features])
X_test_scaled = scaler.transform(X_test)
test_acc = lr.score(X_test_scaled, y_test)

print(f"  Features: xg_diff, xga_diff, elo_diff, total, hf, form_diff")
print(f"  Train accuracy: {train_acc:.4f}")
print(f"  OOS accuracy:   {test_acc:.4f}")

# ═══ 4. DIXON-COLES + PLATT CALIBRATION ══════════════════════════════

print("\n═══ 4. PLATT CALIBRATION ═══")

def dc_probs(lam_h, lam_a, rho=-0.05):
    mx = np.zeros((10, 10))
    for i in range(10):
        for j in range(10):
            mx[i, j] = poisson.pmf(i, lam_h) * poisson.pmf(j, lam_a)
    if lam_h > 0 and lam_a > 0:
        mx[0,0] *= max(0, 1 - lam_h*lam_a*rho)
        mx[1,0] *= max(0, 1 + lam_a*rho)
        mx[0,1] *= max(0, 1 + lam_h*rho)
        mx[1,1] *= max(0, 1 - rho)
    mx /= mx.sum()
    H = sum(mx[i,j] for i in range(10) for j in range(10) if i > j)
    D = sum(mx[i,j] for i in range(10) for j in range(10) if i == j)
    A = 1 - H - D
    O25 = sum(mx[i,j] for i in range(10) for j in range(10) if i+j > 2.5)
    return max(0.01, H), max(0.01, D), max(0.01, A), max(0.01, O25)

# Generate DC predictions for TRAIN set (for Platt fitting)
dc_train_H, dc_train_D, dc_train_A, dc_train_O25 = [], [], [], []
act_train_H, act_train_D, act_train_A, act_train_O25 = [], [], [], []

# Per-league data for per-league Platt calibration
from collections import defaultdict
league_train_data = defaultdict(lambda: {"H": [], "D": [], "A": [], "O25": [],
                                          "act_H": [], "act_D": [], "act_A": [], "act_O25": []})

for f in train_features:
    lg = f["league"]
    if lg not in LEAGUE_AVGS: continue
    avg, hf = LEAGUE_AVGS[lg], LEAGUE_HFS[lg]
    # Use EWMA features for lambda estimation
    xg_diff, xga_diff = f["features"][0], f["features"][1]
    h_atk = avg + xg_diff * 0.5
    lam_h = max(0.3, min(4.0, h_atk * hf))
    lam_a = max(0.3, min(4.0, avg - xg_diff * 0.5))
    H, D, A, O25 = dc_probs(lam_h, lam_a)
    dc_train_H.append(H); dc_train_D.append(D); dc_train_A.append(A); dc_train_O25.append(O25)
    gf, ga = f["gf"], f["ga"]
    aH = 1 if gf > ga else 0
    aD = 1 if gf == ga else 0
    aA = 1 if gf < ga else 0
    aO = 1 if gf + ga > 2 else 0
    act_train_H.append(aH); act_train_D.append(aD); act_train_A.append(aA); act_train_O25.append(aO)
    # Per-league accumulation
    ld = league_train_data[lg]
    ld["H"].append(H); ld["D"].append(D); ld["A"].append(A); ld["O25"].append(O25)
    ld["act_H"].append(aH); ld["act_D"].append(aD); ld["act_A"].append(aA); ld["act_O25"].append(aO)

# Fit Platt scaling on TRAIN predictions
def fit_platt(probs, actuals):
    p = np.clip(np.array(probs), 1e-6, 1 - 1e-6)
    logit_p = np.log(p / (1 - p)).reshape(-1, 1)
    lr_cal = LogisticRegression(C=1e10, solver="lbfgs", max_iter=1000)
    lr_cal.fit(logit_p, np.array(actuals))
    return {"a": round(float(lr_cal.coef_[0][0]), 4), "b": round(float(lr_cal.intercept_[0]), 4)}

platt_params = {
    "H": fit_platt(dc_train_H, act_train_H),
    "D": fit_platt(dc_train_D, act_train_D),
    "A": fit_platt(dc_train_A, act_train_A),
    "O25": fit_platt(dc_train_O25, act_train_O25),
}

print(f"  Platt params (global): {platt_params}")

# Per-league Platt calibration (min 500 matches for stability)
MIN_LEAGUE_MATCHES_PLATT = 500
platt_params_league = {}
for lg, ld in sorted(league_train_data.items()):
    n = len(ld["H"])
    if n < MIN_LEAGUE_MATCHES_PLATT:
        continue
    try:
        lp = {
            "H": fit_platt(ld["H"], ld["act_H"]),
            "D": fit_platt(ld["D"], ld["act_D"]),
            "A": fit_platt(ld["A"], ld["act_A"]),
            "O25": fit_platt(ld["O25"], ld["act_O25"]),
        }
        platt_params_league[lg] = lp
        print(f"  {lg:20s} ({n:5d} matches): H.a={lp['H']['a']:+.4f} D.a={lp['D']['a']:+.4f} A.a={lp['A']['a']:+.4f}")
    except Exception as e:
        print(f"  {lg:20s} ({n:5d} matches): FAILED — {e}")

print(f"  Per-league Platt: {len(platt_params_league)} leagues (min {MIN_LEAGUE_MATCHES_PLATT} matches)")

# Evaluate on TEST set
dc_test_preds, act_test = [], []
for f in test_features:
    lg = f["league"]
    if lg not in LEAGUE_AVGS: continue
    avg, hf = LEAGUE_AVGS[lg], LEAGUE_HFS[lg]
    xg_diff = f["features"][0]
    lam_h = max(0.3, min(4.0, (avg + xg_diff * 0.5) * hf))
    lam_a = max(0.3, min(4.0, avg - xg_diff * 0.5))
    H, D, A, O25 = dc_probs(lam_h, lam_a)
    dc_test_preds.append([H, D, A])
    gf, ga = f["gf"], f["ga"]
    act_test.append([1 if gf > ga else 0, 1 if gf == ga else 0, 1 if gf < ga else 0])

dc_arr = np.array(dc_test_preds)
act_arr = np.array(act_test)

# Apply Platt to test predictions
def apply_platt(p, params):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    logit = np.log(p / (1 - p))
    return 1 / (1 + np.exp(params["a"] * logit + params["b"]))

dc_cal = np.column_stack([
    apply_platt(dc_arr[:, 0], platt_params["H"]),
    apply_platt(dc_arr[:, 1], platt_params["D"]),
    apply_platt(dc_arr[:, 2], platt_params["A"]),
])
# Renormalize
dc_cal = dc_cal / dc_cal.sum(axis=1, keepdims=True)

brier_raw = np.mean(np.sum((dc_arr - act_arr) ** 2, axis=1))
brier_platt = np.mean(np.sum((dc_cal - act_arr) ** 2, axis=1))

print(f"  DC Brier (raw OOS):   {brier_raw:.4f}")
print(f"  DC Brier (Platt OOS): {brier_platt:.4f}")
print(f"  Platt {'HELPS' if brier_platt < brier_raw else 'HURTS'}: {(brier_raw - brier_platt) / brier_raw * 100:.1f}%")

# ═══ 5. ENSEMBLE WEIGHT OPTIMIZATION ═════════════════════════════════

print("\n═══ 5. ENSEMBLE WEIGHTS ═══")

def elo_probs(ht, at):
    rH = elo_test.get(ht, 1500) + HOME_ADV
    rA = elo_test.get(at, 1500)
    expH = 1 / (1 + 10 ** ((rA - rH) / 400))
    draw = max(0.15, 0.36 - 0.28 * abs(expH - 0.5))
    return max(0.01, expH * (1 - draw)), max(0.01, draw), max(0.01, (1 - expH) * (1 - draw))

elo_preds, lr_preds = [], []
for f in test_features:
    lg = f["league"]
    if lg not in LEAGUE_AVGS: continue
    eH, eD, eA = elo_probs(f["ht"], f["at"])
    elo_preds.append([eH, eD, eA])
    feat_scaled = scaler.transform([f["features"]])
    prob = lr.predict_proba(feat_scaled)[0]
    lr_preds.append([prob[2], prob[1], prob[0]])  # [H, D, A]

# Align arrays (all must have same length)
n = min(len(dc_arr), len(elo_preds), len(lr_preds))
dc_arr_n = dc_arr[:n]
elo_arr = np.array(elo_preds[:n])
lr_arr = np.array(lr_preds[:n])
act_arr_n = act_arr[:n]

def brier(p, a): return np.mean(np.sum((p - a) ** 2, axis=1))

print(f"  Brier DC:       {brier(dc_arr_n, act_arr_n):.4f}")
print(f"  Brier Elo:      {brier(elo_arr, act_arr_n):.4f}")
print(f"  Brier Logistic: {brier(lr_arr, act_arr_n):.4f}")

def ensemble_brier(weights):
    w = np.array(weights)
    w = w / w.sum()
    combined = w[0] * dc_arr_n + w[1] * elo_arr + w[2] * lr_arr
    combined = combined / combined.sum(axis=1, keepdims=True)
    return brier(combined, act_arr_n)

result = minimize(ensemble_brier, x0=[0.33, 0.33, 0.34], method="Nelder-Mead", options={"maxiter": 10000})
opt_w = result.x / result.x.sum()

market_slot = 0.20
final_weights = {
    "dixonColes": round(float(opt_w[0]) * (1 - market_slot), 3),
    "elo": round(float(opt_w[1]) * (1 - market_slot), 3),
    "logistic": round(float(opt_w[2]) * (1 - market_slot), 3),
    "market": market_slot,
}

print(f"  Optimized: DC={opt_w[0]:.3f} Elo={opt_w[1]:.3f} Log={opt_w[2]:.3f}")
print(f"  Ensemble Brier: {result.fun:.4f}")
print(f"  Final weights: {final_weights}")

# ═══ 5b. POISSON REGRESSION (Home Goals + Away Goals) ══════════════════

print("\n═══ 5b. POISSON REGRESSION ═══")

from sklearn.linear_model import PoissonRegressor

# Build Poisson features: 5 core (NO form_diff) + league_avg + effective_n + rest_days_diff + sos_strength
# form_diff (W/D/L points) is pure results noise — xG exists to filter this out.
poisson_train = [f for f in train_features if f["league"] in LEAGUE_AVGS]
poisson_test = [f for f in test_features if f["league"] in LEAGUE_AVGS]

def poisson_features(f):
    """9 features: xg_diff, xga_diff, elo_diff, total, hf, league_avg, rest_diff, sos_strength, is_derby"""
    core = f["features"][:5]  # [xg_diff, xga_diff, elo_diff, total, hf] — skip form_diff at index 5
    return core + [LEAGUE_AVGS[f["league"]]] + f.get("features_ext", [0.0, 0.0, 0.0])

X_poisson_train = np.array([poisson_features(f) for f in poisson_train])
y_home_train = np.array([f["gf"] for f in poisson_train])
y_away_train = np.array([f["ga"] for f in poisson_train])

scaler_p = StandardScaler()
X_p_scaled = scaler_p.fit_transform(X_poisson_train)

pr_home = PoissonRegressor(alpha=0.1, max_iter=1000)
pr_home.fit(X_p_scaled, y_home_train)

pr_away = PoissonRegressor(alpha=0.1, max_iter=1000)
pr_away.fit(X_p_scaled, y_away_train)

# Evaluate on test set
X_poisson_test = np.array([poisson_features(f) for f in poisson_test])
X_p_test_scaled = scaler_p.transform(X_poisson_test)

pred_home_test = pr_home.predict(X_p_test_scaled)
pred_away_test = pr_away.predict(X_p_test_scaled)
y_home_test = np.array([f["gf"] for f in poisson_test])
y_away_test = np.array([f["ga"] for f in poisson_test])

# Mean Absolute Error
mae_home = np.mean(np.abs(pred_home_test - y_home_test))
mae_away = np.mean(np.abs(pred_away_test - y_away_test))

# Poisson deviance (lower = better)
def poisson_deviance(y_true, y_pred):
    y_pred = np.clip(y_pred, 1e-6, None)
    return 2 * np.mean(y_true * np.log(np.clip(y_true, 1e-6, None) / y_pred) - (y_true - y_pred))

dev_home = poisson_deviance(y_home_test, pred_home_test)
dev_away = poisson_deviance(y_away_test, pred_away_test)

# Brier score from Poisson lambdas
poisson_brier_preds = []
for i in range(len(poisson_test)):
    lam_h = max(0.3, min(4.0, pred_home_test[i]))
    lam_a = max(0.3, min(4.0, pred_away_test[i]))
    H, D, A, _ = dc_probs(lam_h, lam_a)
    poisson_brier_preds.append([H, D, A])
poisson_brier_arr = np.array(poisson_brier_preds)
act_poisson_test = np.array([
    [1 if f["gf"] > f["ga"] else 0, 1 if f["gf"] == f["ga"] else 0, 1 if f["gf"] < f["ga"] else 0]
    for f in poisson_test
])
brier_poisson = brier(poisson_brier_arr, act_poisson_test)

print(f"  Features: xg_diff, xga_diff, elo_diff, total, hf, league_avg, rest_diff, sos_strength, is_derby")
print(f"  Train: {len(poisson_train)} matches, Test: {len(poisson_test)} matches")
print(f"  Home MAE: {mae_home:.3f}, Away MAE: {mae_away:.3f}")
print(f"  Poisson Deviance — Home: {dev_home:.4f}, Away: {dev_away:.4f}")
print(f"  Brier (Poisson → DC matrix): {brier_poisson:.4f}")
print(f"  Home coefs: {pr_home.coef_.round(4).tolist()}")
print(f"  Away coefs: {pr_away.coef_.round(4).tolist()}")

# Poisson ensemble weights (optimized for matrix-primary approach)
# Matrix = 60%, Elo = 15%, Market = 25%
poisson_ensemble_weights = {"matrix": 0.60, "elo": 0.15, "market": 0.25}

poisson_model_json = {
    "home": {
        "coefficients": pr_home.coef_.tolist(),
        "intercept": float(pr_home.intercept_),
    },
    "away": {
        "coefficients": pr_away.coef_.tolist(),
        "intercept": float(pr_away.intercept_),
    },
    "scaler_mean": scaler_p.mean_.tolist(),
    "scaler_scale": scaler_p.scale_.tolist(),
    "feature_names": ["xg_diff", "xga_diff", "elo_diff", "total_goals", "home_factor", "league_avg", "rest_days_diff", "sos_strength", "is_derby"],
    "ensemble_weights": poisson_ensemble_weights,
    "n_train": len(poisson_train),
    "n_test": len(poisson_test),
    "mae_home": round(mae_home, 4),
    "mae_away": round(mae_away, 4),
    "brier_oos": round(brier_poisson, 4),
}

# ═══ 6. EXPORT ════════════════════════════════════════════════════════

print("\n═══ 6. EXPORTING ═══")

# Calibration
cal_output = os.path.join(PROJECT_ROOT, "public", "calibration_curves.json")
cal_data = {"method": "platt", "platt_params": platt_params}
if platt_params_league:
    cal_data["platt_params_league"] = platt_params_league
with open(cal_output, "w") as f:
    json.dump(cal_data, f)
print(f"  ✅ {cal_output} (global + {len(platt_params_league)} leagues)")

# Ensemble model
ens_output = os.path.join(PROJECT_ROOT, "public", "ensemble-model.json")
ens = {
    "elo_ratings": elo_snapshot,
    "logistic": {
        "coefficients": lr.coef_.tolist(),
        "intercepts": lr.intercept_.tolist(),
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "feature_names": ["xg_diff", "xga_diff", "elo_diff", "total_goals", "home_factor", "form_diff"],
        "classes": ["away", "draw", "home"],
        "training_accuracy": round(train_acc, 4),
        "oos_accuracy": round(test_acc, 4),
        "n_train": len(train_features),
        "n_oos": len(test_features),
    },
    "poisson": poisson_model_json,
    "weights": final_weights,
    "brier_scores": {
        "dc_raw_oos": round(brier_raw, 4),
        "dc_platt_oos": round(brier_platt, 4),
        "elo_oos": round(brier(elo_arr, act_arr_n), 4),
        "logistic_oos": round(brier(lr_arr, act_arr_n), 4),
        "ensemble_oos": round(result.fun, 4),
        "poisson_oos": round(brier_poisson, 4),
    },
    "_meta": {
        "oot_cutoff": str(OOT_CUTOFF.date()),
        "calibration_method": "platt",
        "ewma_alpha": EWMA_ALPHA,
        "n_total": len(csv_all),
        "temporal_leakage_fixed": True,
        "trained_at": pd.Timestamp.now().isoformat(),
    },
}
with open(ens_output, "w") as f:
    json.dump(ens, f)
print(f"  ✅ {ens_output}")

print(f"\n═══ DONE ═══")
print(f"  OOT Cutoff: {OOT_CUTOFF.date()}")
print(f"  DC Brier:   {brier_raw:.4f} raw → {brier_platt:.4f} Platt")
print(f"  Ensemble:   {result.fun:.4f}")
print(f"  Logistic:   {test_acc:.4f} OOS accuracy")
