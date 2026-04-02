#!/usr/bin/env python3
"""
FODZE v2.1 Backtest — Walk-Forward on D1 (Bundesliga), E0 (EPL), D2 (2. Bundesliga)
═══════════════════════════════════════════════════════════════════════════════════════

Loads the trained model JSON, replays all OOS matches (post 2023-08-01),
computes predictions, and evaluates against actual results + Pinnacle odds.

Usage:
    python3 tools/backtest_v2.py                     # All 3 leagues
    python3 tools/backtest_v2.py --league D1          # Bundesliga only
    python3 tools/backtest_v2.py --edge-threshold 0.05
    python3 tools/backtest_v2.py --csv-out results.csv
"""

import os, sys, json, math, argparse
import numpy as np
import pandas as pd
from collections import defaultdict

# ─── Setup paths ────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, "..")
sys.path.insert(0, SCRIPT_DIR)

# ─── Monkey-patch retrain_v2 for D2 BEFORE importing ───────────
import retrain_v2
retrain_v2.DIV_TO_LEAGUE["D2"] = "bundesliga2"
retrain_v2.LEAGUE_AVGS["bundesliga2"] = 1.29
retrain_v2.LEAGUE_HFS["bundesliga2"] = 1.26

from retrain_v2 import (
    load_csv_data, load_full_understat_data, load_tactics_data,
    load_players_data, load_roster_rotation, load_shots_data,
    compute_features, compute_elo, dc_matrix, matrix_1x2,
    FEATURE_NAMES, OOT_CUTOFF, FULL_CSV, TACTICS_CSV, PLAYERS_CSV,
    ROSTER_CSV, SHOTS_CSV,
)

MODEL_PATH = os.path.join(PROJECT_ROOT, "public", "lgbm-model-v2.json")
HISTORIE_DIR = os.path.join(PROJECT_ROOT, "Historie")

BACKTEST_LEAGUES = {"bundesliga": "D1", "epl": "E0", "bundesliga2": "D2"}
DIV_TO_NAME = {"D1": "Bundesliga", "E0": "Premier League", "D2": "2. Bundesliga"}


# ═══════════════════════════════════════════════════════════════════
# LightGBM Tree Traversal (Python mirror of lgbm-runtime.ts)
# ═══════════════════════════════════════════════════════════════════

def traverse_tree(node, features):
    if "leaf_value" in node:
        return node["leaf_value"]
    val = features[node["split_feature"]]
    if val <= node["threshold"]:
        return traverse_tree(node["left_child"], features)
    else:
        return traverse_tree(node["right_child"], features)


def predict_lambda(model_data, features):
    score = sum(traverse_tree(t, features) for t in model_data["trees"])
    return max(0.3, min(4.5, math.exp(score)))


def validate_golden_tests(model, tol=1e-4):
    tests = model.get("golden_tests", [])
    if not tests:
        print("  ⚠ No golden tests in model")
        return True
    all_pass = True
    for g in tests:
        pH = predict_lambda(model["home_model"], g["features"])
        pA = predict_lambda(model["away_model"], g["features"])
        dH = abs(pH - g["expected_h"])
        dA = abs(pA - g["expected_a"])
        ok = dH < tol and dA < tol
        if not ok:
            print(f"  ❌ {g['match']}: H={pH:.4f} vs {g['expected_h']:.4f}, A={pA:.4f} vs {g['expected_a']:.4f}")
            all_pass = False
    return all_pass


# ═══════════════════════════════════════════════════════════════════
# Odds Loader (extends load_csv_data with betting columns)
# ═══════════════════════════════════════════════════════════════════

def load_odds_data():
    """Load Pinnacle + best odds from Historie CSVs."""
    import glob
    odds_lookup = {}
    for folder in sorted(glob.glob(os.path.join(HISTORIE_DIR, "data*"))):
        for csv_file in glob.glob(os.path.join(folder, "*.csv")):
            bn = os.path.basename(csv_file)
            if bn not in ("D1.csv", "E0.csv", "D2.csv"):
                continue
            try:
                df = pd.read_csv(csv_file, encoding="latin-1", on_bad_lines="skip")
            except Exception:
                continue
            df.columns = [c.strip().strip("\ufeff") for c in df.columns]
            if "Date" not in df.columns or "HomeTeam" not in df.columns:
                continue

            # Parse dates
            df["date_parsed"] = pd.to_datetime(df["Date"], format="%d/%m/%Y", errors="coerce")
            mask = df["date_parsed"].isna()
            if mask.any():
                df.loc[mask, "date_parsed"] = pd.to_datetime(df.loc[mask, "Date"], format="%d/%m/%y", errors="coerce")

            for _, row in df.iterrows():
                if pd.isna(row.get("date_parsed")):
                    continue
                key = (row["date_parsed"].strftime("%Y-%m-%d"), str(row["HomeTeam"]), str(row["AwayTeam"]))
                odds = {}
                for col in ["PSH", "PSD", "PSA", "B365H", "B365D", "B365A", "MaxH", "MaxD", "MaxA"]:
                    try:
                        odds[col] = float(row[col]) if pd.notna(row.get(col)) else None
                    except (ValueError, KeyError):
                        odds[col] = None
                # O/U 2.5
                for col in ["P>2.5", "P<2.5", "B365>2.5", "B365<2.5"]:
                    try:
                        odds[col.replace(">", "O").replace("<", "U")] = float(row[col]) if pd.notna(row.get(col)) else None
                    except (ValueError, KeyError):
                        odds[col.replace(">", "O").replace("<", "U")] = None
                odds_lookup[key] = odds

    return odds_lookup


# ═══════════════════════════════════════════════════════════════════
# Metrics
# ═══════════════════════════════════════════════════════════════════

def compute_metrics(predictions):
    """Compute Brier, LogLoss, Accuracy, Calibration from prediction list."""
    if not predictions:
        return {}

    brier_sum, logloss_sum, correct, n = 0, 0, 0, len(predictions)

    # Calibration buckets
    cal_buckets = defaultdict(lambda: {"sum_pred": 0, "sum_actual": 0, "n": 0})

    for p in predictions:
        pH, pD, pA = p["pH"], p["pD"], p["pA"]
        aH = 1 if p["result"] == "H" else 0
        aD = 1 if p["result"] == "D" else 0
        aA = 1 if p["result"] == "A" else 0

        # Brier
        brier_sum += (pH - aH) ** 2 + (pD - aD) ** 2 + (pA - aA) ** 2

        # Log-loss
        eps = 1e-6
        logloss_sum += -(aH * math.log(max(pH, eps)) + aD * math.log(max(pD, eps)) + aA * math.log(max(pA, eps)))

        # Accuracy
        pred_outcome = ["H", "D", "A"][[pH, pD, pA].index(max(pH, pD, pA))]
        if pred_outcome == p["result"]:
            correct += 1

        # Calibration (H outcome)
        bucket = int(pH * 10)
        bucket = min(bucket, 9)
        cal_buckets[bucket]["sum_pred"] += pH
        cal_buckets[bucket]["sum_actual"] += aH
        cal_buckets[bucket]["n"] += 1

    return {
        "n": n,
        "brier": brier_sum / n,
        "logloss": logloss_sum / n,
        "accuracy": correct / n,
        "calibration": {k: {"pred": v["sum_pred"] / v["n"], "actual": v["sum_actual"] / v["n"], "n": v["n"]}
                        for k, v in sorted(cal_buckets.items()) if v["n"] > 0},
    }


def simulate_betting(predictions, edge_threshold=0.03, kelly_fraction=0.25, bankroll=1000):
    """Simulate flat-stake and Kelly betting on value bets vs Pinnacle."""
    flat_bets = []
    kelly_bankroll = [bankroll]
    current_bankroll = bankroll

    for p in predictions:
        if not p.get("pinnacle_h"):
            continue

        # Vig-free Pinnacle probabilities
        imp = 1 / p["pinnacle_h"] + 1 / p["pinnacle_d"] + 1 / p["pinnacle_a"]
        fair_h = (1 / p["pinnacle_h"]) / imp
        fair_d = (1 / p["pinnacle_d"]) / imp
        fair_a = (1 / p["pinnacle_a"]) / imp

        # Check each outcome for value
        for label, model_p, fair_p, odds in [
            ("H", p["pH"], fair_h, p["pinnacle_h"]),
            ("D", p["pD"], fair_d, p["pinnacle_d"]),
            ("A", p["pA"], fair_a, p["pinnacle_a"]),
        ]:
            edge = model_p - fair_p
            if edge < edge_threshold:
                continue

            won = p["result"] == label
            profit = odds - 1 if won else -1

            flat_bets.append({
                "match": f"{p['home']} vs {p['away']}",
                "date": p["date"],
                "league": p["league"],
                "label": label,
                "model_p": model_p,
                "fair_p": fair_p,
                "edge": edge,
                "odds": odds,
                "won": won,
                "profit": profit,
            })

            # Kelly
            kelly_raw = (model_p * odds - 1) / (odds - 1) if odds > 1 else 0
            kelly_bet = current_bankroll * max(0, kelly_raw) * kelly_fraction
            kelly_bet = min(kelly_bet, current_bankroll * 0.05)  # Cap at 5%
            if won:
                current_bankroll += kelly_bet * (odds - 1)
            else:
                current_bankroll -= kelly_bet
            kelly_bankroll.append(current_bankroll)

    total_staked = len(flat_bets)
    flat_profit = sum(b["profit"] for b in flat_bets)
    flat_wins = sum(1 for b in flat_bets if b["won"])

    return {
        "n_bets": total_staked,
        "flat_profit": flat_profit,
        "flat_yield": flat_profit / total_staked if total_staked > 0 else 0,
        "hit_rate": flat_wins / total_staked if total_staked > 0 else 0,
        "kelly_final": current_bankroll,
        "kelly_roi": (current_bankroll - bankroll) / bankroll,
        "kelly_max_dd": min(kelly_bankroll) / bankroll - 1 if kelly_bankroll else 0,
        "bets": flat_bets,
    }


# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="FODZE v2.1 Backtest")
    parser.add_argument("--league", type=str, help="Filter: D1, E0, or D2")
    parser.add_argument("--edge-threshold", type=float, default=0.03, help="Min edge for value bets")
    parser.add_argument("--kelly-fraction", type=float, default=0.25, help="Kelly fraction")
    parser.add_argument("--bankroll", type=float, default=1000, help="Starting bankroll")
    parser.add_argument("--csv-out", type=str, help="Export predictions to CSV")
    args = parser.parse_args()

    print("═" * 70)
    print("FODZE v2.1 Backtest — D1 (Bundesliga) + E0 (EPL) + D2 (2. BuLi)")
    print("═" * 70)

    # ─── 1. Load Model ───
    print("\n═══ 1. LOADING MODEL ═══")
    model = json.load(open(MODEL_PATH))
    rho = model["rho_optimal"]
    n_features = len(model["feature_names"])
    print(f"  Features: {n_features}, Rho: {rho:.4f}")
    print(f"  Trees: {len(model['home_model']['trees'])}H + {len(model['away_model']['trees'])}A")

    # Golden tests
    print("\n═══ 2. GOLDEN TESTS ═══")
    if validate_golden_tests(model):
        print(f"  ✅ All {len(model.get('golden_tests', []))} golden tests pass")
    else:
        print("  ❌ GOLDEN TESTS FAILED — aborting")
        sys.exit(1)

    # ─── 3. Load Data ───
    print("\n═══ 3. LOADING DATA ═══")
    csv_all = load_csv_data()
    train_df = csv_all[csv_all["date_parsed"] < OOT_CUTOFF]
    test_df = csv_all[csv_all["date_parsed"] >= OOT_CUTOFF]
    print(f"  Total: {len(csv_all)}, Train: {len(train_df)}, Test: {len(test_df)}")

    full_lookup = load_full_understat_data(FULL_CSV)
    tactics_data = load_tactics_data(TACTICS_CSV)
    players_data = load_players_data(PLAYERS_CSV)
    roster_data = load_roster_rotation(ROSTER_CSV)
    shots_data = load_shots_data(SHOTS_CSV)
    print(f"  Understat: {len(full_lookup)} matches, {len(tactics_data)} tactics, {len(shots_data)} shots")

    # ─── 4. Elo + Features ───
    print("\n═══ 4. COMPUTING FEATURES ═══")
    elo = compute_elo(train_df)
    all_features = compute_features(
        csv_all, elo, {},
        full_lookup=full_lookup, use_npxg=True,
        tactics_data=tactics_data, players_data=players_data,
        roster_data=roster_data, shots_data=shots_data,
    )

    # Filter OOS + target leagues
    target_leagues = set(BACKTEST_LEAGUES.keys())
    if args.league:
        div_to_league = {v: k for k, v in BACKTEST_LEAGUES.items()}
        if args.league in div_to_league:
            target_leagues = {div_to_league[args.league]}
        else:
            print(f"  ❌ Unknown league: {args.league}. Use D1, E0, or D2.")
            sys.exit(1)

    oos_features = [
        f for f in all_features
        if pd.notna(f["date"]) and f["date"] >= OOT_CUTOFF and f["league"] in target_leagues
    ]
    print(f"  OOS matches: {len(oos_features)} ({', '.join(sorted(target_leagues))})")

    # ─── 5. Load Odds ───
    print("\n═══ 5. LOADING ODDS ═══")
    odds_lookup = load_odds_data()
    print(f"  Odds entries: {len(odds_lookup)}")

    # ─── 6. Predictions ───
    print("\n═══ 6. RUNNING PREDICTIONS ═══")
    predictions = []
    no_odds_count = 0

    for f in oos_features:
        features = f["features"]
        if len(features) != n_features:
            continue

        lam_h = predict_lambda(model["home_model"], features)
        lam_a = predict_lambda(model["away_model"], features)

        mx = dc_matrix(lam_h, lam_a, rho=rho)
        pH, pD, pA = matrix_1x2(mx)

        # O/U 2.5
        n_mx = len(mx)
        p_over25 = sum(mx[i][j] for i in range(n_mx) for j in range(n_mx) if i + j >= 3)

        # Actual result
        gf, ga = f["gf"], f["ga"]
        result = "H" if gf > ga else "D" if gf == ga else "A"

        # Lookup odds
        date_str = f["date"].strftime("%Y-%m-%d") if pd.notna(f["date"]) else ""
        odds_key = (date_str, f["ht"], f["at"])
        odds = odds_lookup.get(odds_key, {})

        pred = {
            "date": date_str,
            "home": f["ht"],
            "away": f["at"],
            "league": f["league"],
            "div": BACKTEST_LEAGUES.get(f["league"], "?"),
            "gf": gf, "ga": ga,
            "result": result,
            "lam_h": lam_h, "lam_a": lam_a,
            "pH": pH, "pD": pD, "pA": pA,
            "p_over25": p_over25,
            "pinnacle_h": odds.get("PSH"),
            "pinnacle_d": odds.get("PSD"),
            "pinnacle_a": odds.get("PSA"),
            "pinnacle_o25": odds.get("PO2.5"),
            "pinnacle_u25": odds.get("PU2.5"),
        }
        predictions.append(pred)
        if not odds.get("PSH"):
            no_odds_count += 1

    print(f"  Predictions: {len(predictions)} ({no_odds_count} without Pinnacle odds)")

    # Lambda sanity
    lam_h_arr = [p["lam_h"] for p in predictions]
    lam_a_arr = [p["lam_a"] for p in predictions]
    print(f"  λH: mean={np.mean(lam_h_arr):.3f}, std={np.std(lam_h_arr):.3f}")
    print(f"  λA: mean={np.mean(lam_a_arr):.3f}, std={np.std(lam_a_arr):.3f}")

    # ─── 7. Metrics ───
    print("\n═══ 7. RESULTS ═══")

    # Overall
    m_all = compute_metrics(predictions)
    print(f"\n  GESAMT ({m_all['n']} Matches):")
    print(f"    Brier:    {m_all['brier']:.4f}")
    print(f"    LogLoss:  {m_all['logloss']:.4f}")
    print(f"    Accuracy: {m_all['accuracy']*100:.1f}%")

    # Per league
    for lg_name, div in sorted(BACKTEST_LEAGUES.items(), key=lambda x: x[1]):
        if lg_name not in target_leagues:
            continue
        lg_preds = [p for p in predictions if p["league"] == lg_name]
        if not lg_preds:
            continue
        m = compute_metrics(lg_preds)
        print(f"\n  {DIV_TO_NAME.get(div, div)} ({m['n']} Matches):")
        print(f"    Brier:    {m['brier']:.4f}")
        print(f"    LogLoss:  {m['logloss']:.4f}")
        print(f"    Accuracy: {m['accuracy']*100:.1f}%")

    # Calibration
    print(f"\n  Kalibrierung (Heimsieg-Buckets):")
    cal = m_all.get("calibration", {})
    print(f"    {'Bucket':>8s}  {'Pred':>6s}  {'Actual':>6s}  {'N':>5s}")
    for k in range(10):
        if k in cal:
            c = cal[k]
            print(f"    {k*10:>2d}-{(k+1)*10:>2d}%   {c['pred']*100:>5.1f}%  {c['actual']*100:>5.1f}%  {c['n']:>5d}")

    # ─── 8. Profitability ───
    print(f"\n═══ 8. PROFITABILITÄT (Edge ≥ {args.edge_threshold*100:.0f}%) ═══")

    bt = simulate_betting(
        predictions,
        edge_threshold=args.edge_threshold,
        kelly_fraction=args.kelly_fraction,
        bankroll=args.bankroll,
    )

    print(f"\n  Value Bets:   {bt['n_bets']}")
    print(f"  Hit Rate:     {bt['hit_rate']*100:.1f}%")
    print(f"  Flat-Stake:   {bt['flat_profit']:+.1f}u ({bt['flat_yield']*100:+.1f}% Yield)")
    print(f"  Kelly Final:  {bt['kelly_final']:.0f}€ (Start {args.bankroll:.0f}€)")
    print(f"  Kelly ROI:    {bt['kelly_roi']*100:+.1f}%")
    print(f"  Kelly Max DD: {bt['kelly_max_dd']*100:.1f}%")

    # Per league breakdown
    for lg_name, div in sorted(BACKTEST_LEAGUES.items(), key=lambda x: x[1]):
        if lg_name not in target_leagues:
            continue
        lg_bets = [b for b in bt["bets"] if b["league"] == lg_name]
        if not lg_bets:
            continue
        lg_profit = sum(b["profit"] for b in lg_bets)
        lg_wins = sum(1 for b in lg_bets if b["won"])
        n = len(lg_bets)
        print(f"\n  {DIV_TO_NAME.get(div, div)}: {n} Bets, {lg_wins}/{n} Hit ({lg_wins/n*100:.0f}%), {lg_profit:+.1f}u Yield")

    # Top value bets
    if bt["bets"]:
        print(f"\n  Top 10 Value Bets:")
        sorted_bets = sorted(bt["bets"], key=lambda b: b["edge"], reverse=True)[:10]
        for b in sorted_bets:
            icon = "✅" if b["won"] else "❌"
            print(f"    {icon} {b['date']} {b['match']:40s} {b['label']} @ {b['odds']:.2f} Edge {b['edge']*100:.1f}% → {b['profit']:+.2f}u")

    # ─── 9. CSV Export ───
    if args.csv_out:
        df = pd.DataFrame(predictions)
        df.to_csv(args.csv_out, index=False)
        print(f"\n  CSV exported: {args.csv_out} ({len(df)} rows)")

    print(f"\n{'═' * 70}")
    print(f"  Backtest complete. {len(predictions)} matches, {bt['n_bets']} value bets.")
    print(f"{'═' * 70}")


if __name__ == "__main__":
    main()
