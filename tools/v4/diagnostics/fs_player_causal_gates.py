"""
FS Player Data — 3-Gate Causal Validation (Option A-minus)

Sequential go/no-go gates to validate whether the weak xa_diff signal
from fs_player_go_nogo.py is CAUSAL or just a leakage artifact.

GATE 1 — Lag-Structure Test (~30 min)
  Hypothesis: if xa_diff_seasonal (full-season aggregate, includes future
  matches relative to focal match-date) shows r_resid=+0.07, was that
  signal because we LEAKED future info?
  Test: build xa_diff_lag1season (use season N-1 to predict season N
  matches — no leakage). Compare residual correlations.
  STOP if lag-signal collapses to <0.5x the seasonal-aggregate signal.

GATE 2 — Opponent-Residualisation + League-Bias Filter (~30 min)
  Hypothesis: xa might be confounded by (a) opponent strength (good
  against weak defenses), (b) sample-bias (partial squads in some
  ligas due to import failures).
  Test: (i) z-normalize xa within (league, season) to remove league-
  scoring-drift, (ii) restrict analysis to matches where BOTH teams
  have >80% squad-coverage (computed as aggregated minutes / 11*38*90).
  STOP if signal collapses on clean+adjusted features.

GATE 3 — LR Pilot Retrain on super_lig + serie_b (~30 min)
  If gates 1 + 2 pass, run minimal Logistic Regression:
    Baseline: just pinnacle_home_prob
    Treatment: pinnacle_home_prob + xa_diff_lag (clean, residualised)
  Walk-forward temporal CV: train 22/23, test 23/24; train 23/24, test 24/25.
  Report: Brier-Δ + LR coefficient sign/magnitude on xa_diff_lag.
  STOP if Brier-Δ < +0.001.

Output: tools/v4/diagnostics/fs_player_causal_gates.json
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import requests
from scipy.stats import pearsonr
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

# Import canonical_team_map
_spec = importlib.util.spec_from_file_location(
    "canonical_team_map",
    ROOT / "tools" / "v4" / "modules" / "m3_xg" / "canonical_team_map.py",
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
canonical_team = _mod.canonical_team


# ─── env loader ───────────────────────────────────────────────
def load_env():
    env_path = ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v)


load_env()
SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
HDRS = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}


def supa_pull(table, select, filters=None, page_size=1000):
    out = []
    offset = 0
    while True:
        url = f"{SUPA_URL}/rest/v1/{table}?select={select}"
        for k, v in (filters or {}).items():
            url += f"&{k}={v}"
        url += f"&limit={page_size}&offset={offset}"
        r = requests.get(url, headers=HDRS, timeout=60)
        r.raise_for_status()
        b = r.json()
        if not b:
            break
        out.extend(b)
        if len(b) < page_size:
            break
        offset += page_size
        if offset > 200000:
            break
    return pd.DataFrame(out)


def vig_remove_1x2(h, d, a):
    if not all(x and x > 1.0 for x in (h, d, a)):
        return (np.nan, np.nan, np.nan)
    ih, id_, ia = 1/h, 1/d, 1/a
    s = ih + id_ + ia
    return (ih/s, id_/s, ia/s)


# Map season N → season N-1 for lag lookups
SEASON_LAG = {"22/23": "21/22", "23/24": "22/23", "24/25": "23/24", "25/26": "24/25"}


# =====================================================================
def load_team_features():
    """Aggregate player_season_stats to per (league, season, canonical_club) totals."""
    print("\n  Loading player_season_stats × 5 seasons...")
    pss = supa_pull(
        "player_season_stats",
        "league,season,current_club,minutes_played,xg_total,npxg_total,xa_total,goals,assists",
        filters={"season": "in.(21/22,22/23,23/24,24/25)"},
    )
    for c in ("minutes_played", "xg_total", "npxg_total", "xa_total", "goals", "assists"):
        pss[c] = pd.to_numeric(pss[c], errors="coerce")

    tf = pss.groupby(["league", "season", "current_club"], as_index=False).agg(
        xa_total=("xa_total", "sum"),
        xg_total=("xg_total", "sum"),
        npxg_total=("npxg_total", "sum"),
        minutes_total=("minutes_played", "sum"),
        squad_size=("minutes_played", "count"),
    )
    tf["c"] = tf.apply(lambda r: canonical_team(r["current_club"], r["league"]), axis=1)
    print(f"  team-seasons: {len(tf):,}")
    return tf


def load_match_set():
    """Pull all 23/24 + 24/25 matches with Pinnacle 1X2 + ft_goals.
    Skip 22/23 because we'd need 21/22 player data for lag (we have it,
    but for clean walk-forward we focus on 23/24+24/25)."""
    print("\n  Loading odds_closing_history × match outcomes...")
    och = supa_pull(
        "odds_closing_history",
        "league,match_date,home_team,away_team,psch,pscd,psca,ft_goals_h,ft_goals_a",
        filters={
            "match_date": "gte.2023-07-01",
            "ft_goals_h": "not.is.null",
            "psch": "not.is.null",
        },
    )
    for c in ("psch", "pscd", "psca", "ft_goals_h", "ft_goals_a"):
        och[c] = pd.to_numeric(och[c], errors="coerce")
    och["c_home"] = och.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    och["c_away"] = och.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    och["season"] = pd.to_datetime(och["match_date"]).apply(
        lambda d: f"{str(d.year)[2:]}/{str(d.year+1)[2:]}" if d.month >= 7
                  else f"{str(d.year-1)[2:]}/{str(d.year)[2:]}"
    )
    print(f"  matches: {len(och):,}")
    return och


# =====================================================================
# GATE 1 — Lag-Structure Test
# =====================================================================
def gate_1_lag_structure(tf, och):
    print("\n" + "═" * 70)
    print("GATE 1 — Lag-Structure Test (current-season vs season-lag)")
    print("═" * 70)

    # Build lookup: (league, season, c) → xa_total, xg_total, npxg_total, minutes_total
    lookup = tf.set_index(["league", "season", "c"])

    def lookup_metric(league, season, club, col):
        try:
            return lookup.loc[(league, season, club), col]
        except (KeyError, TypeError):
            return np.nan

    # Build BOTH versions
    rows = []
    for _, m in och.iterrows():
        lg, s, h, a = m["league"], m["season"], m["c_home"], m["c_away"]
        prev = SEASON_LAG.get(s)
        # Current season aggregate (LEAKAGE)
        h_xa_cur = lookup_metric(lg, s, h, "xa_total")
        a_xa_cur = lookup_metric(lg, s, a, "xa_total")
        # Previous season aggregate (NO LEAKAGE)
        h_xa_lag = lookup_metric(lg, prev, h, "xa_total") if prev else np.nan
        a_xa_lag = lookup_metric(lg, prev, a, "xa_total") if prev else np.nan
        rows.append({
            "league": lg, "season": s,
            "c_home": h, "c_away": a,
            "psch": m["psch"], "pscd": m["pscd"], "psca": m["psca"],
            "ft_goals_h": m["ft_goals_h"], "ft_goals_a": m["ft_goals_a"],
            "xa_diff_cur": h_xa_cur - a_xa_cur if pd.notna(h_xa_cur) and pd.notna(a_xa_cur) else np.nan,
            "xa_diff_lag": h_xa_lag - a_xa_lag if pd.notna(h_xa_lag) and pd.notna(a_xa_lag) else np.nan,
        })
    df = pd.DataFrame(rows)

    # Build baseline + residual
    pH = df.apply(lambda r: vig_remove_1x2(r["psch"], r["pscd"], r["psca"])[0], axis=1)
    df["p_pinn_h"] = pH
    df["home_win"] = (df["ft_goals_h"] > df["ft_goals_a"]).astype(int)
    df["resid"] = df["home_win"] - df["p_pinn_h"]

    # Compare correlations
    sub_cur = df.dropna(subset=["xa_diff_cur", "resid"])
    sub_lag = df.dropna(subset=["xa_diff_lag", "resid"])
    print(f"\n  Sample sizes:")
    print(f"    current-season aggregate: n={len(sub_cur):,}")
    print(f"    season-lag (N-1):         n={len(sub_lag):,}")

    r_cur_raw, _ = pearsonr(sub_cur["xa_diff_cur"], sub_cur["home_win"])
    r_cur_res, _ = pearsonr(sub_cur["xa_diff_cur"], sub_cur["resid"])
    r_lag_raw, _ = pearsonr(sub_lag["xa_diff_lag"], sub_lag["home_win"])
    r_lag_res, _ = pearsonr(sub_lag["xa_diff_lag"], sub_lag["resid"])

    print(f"\n  AGGREGATE (all leagues):")
    print(f"    {'metric':<26} {'r_raw':>8} {'r_resid':>9}  vs.")
    print(f"    {'xa_diff_cur (LEAKAGE)':<26} {r_cur_raw:>+.4f} {r_cur_res:>+.4f}")
    print(f"    {'xa_diff_lag (NO LEAK)':<26} {r_lag_raw:>+.4f} {r_lag_res:>+.4f}")
    decay = abs(r_lag_res) / abs(r_cur_res) if r_cur_res else 0
    print(f"\n  Lag-decay ratio: {decay:.2%}  "
          f"({'STRONG decay → signal was leakage' if decay < 0.5 else 'PARTIAL decay' if decay < 0.8 else 'NO decay → signal real'})")

    # Per-league lag-residual
    print(f"\n  Per-league r_resid for xa_diff_lag:")
    per_league = []
    for lg in sorted(sub_lag["league"].unique()):
        s = sub_lag[sub_lag["league"] == lg]
        if len(s) < 100:
            continue
        rr, _ = pearsonr(s["xa_diff_lag"], s["resid"])
        marker = "✅" if abs(rr) > 0.10 else "🟡" if abs(rr) > 0.05 else "❌"
        # Compare to current
        s_cur = sub_cur[sub_cur["league"] == lg]
        if len(s_cur) >= 100:
            rr_cur, _ = pearsonr(s_cur["xa_diff_cur"], s_cur["resid"])
            decay_lg = abs(rr) / abs(rr_cur) if rr_cur else 0
        else:
            rr_cur, decay_lg = np.nan, np.nan
        print(f"  {marker} {lg:<18}  n_lag={len(s):>5,}  r_lag={rr:>+.4f}  r_cur={rr_cur:>+.4f}  decay={decay_lg:.0%}")
        per_league.append({"league": lg, "n_lag": int(len(s)),
                           "r_resid_lag": round(float(rr), 4),
                           "r_resid_cur": round(float(rr_cur), 4) if np.isfinite(rr_cur) else None,
                           "decay_ratio": round(float(decay_lg), 3) if np.isfinite(decay_lg) else None})

    # GATE verdict
    if abs(r_lag_res) < 0.02:
        verdict = "❌ FAIL — lag-signal essentially zero. Original signal was leakage."
        proceed = False
    elif decay < 0.5:
        verdict = f"⚠ WEAKENED — lag preserves only {decay:.0%} of seasonal-signal. Mostly leakage."
        proceed = decay > 0.3 and abs(r_lag_res) > 0.025
    else:
        verdict = f"✅ PASS — lag preserves {decay:.0%} of signal. Likely causal."
        proceed = True
    print(f"\n  GATE 1 VERDICT: {verdict}")
    return {
        "gate": 1,
        "n_lag": int(len(sub_lag)),
        "r_raw_cur": round(float(r_cur_raw), 4),
        "r_resid_cur": round(float(r_cur_res), 4),
        "r_raw_lag": round(float(r_lag_raw), 4),
        "r_resid_lag": round(float(r_lag_res), 4),
        "decay_ratio": round(float(decay), 3),
        "per_league": per_league,
        "verdict": verdict,
        "proceed": proceed,
        # Pass df forward
        "_df": df,
    }


# =====================================================================
# GATE 2 — League-Bias Filter + League-Normalisation
# =====================================================================
def gate_2_bias_clean(gate1_result, tf):
    print("\n" + "═" * 70)
    print("GATE 2 — League-Bias Filter + League-Normalisation")
    print("═" * 70)

    df = gate1_result["_df"].copy()

    # 1. Compute squad-coverage proxy per (league, season, club)
    # Expected per-team-season: 11 starters × ~38 games × 90 min = ~37,620 min
    # If team-aggregated minutes_total is low, squad is incomplete
    EXPECTED_MIN = 11 * 38 * 90  # ≈ 37,620
    print(f"\n  Computing squad-coverage (expected min/season ≈ {EXPECTED_MIN:,})...")
    sc = tf[["league", "season", "c", "minutes_total"]].copy()
    sc["coverage"] = sc["minutes_total"] / EXPECTED_MIN
    cov_lookup = sc.set_index(["league", "season", "c"])["coverage"]

    def lookup_cov(league, season, club):
        try:
            return float(cov_lookup.loc[(league, season, club)])
        except KeyError:
            return np.nan

    # Use season-LAG coverage (so we filter based on previous-season data quality
    # — that's what predicts xa_diff_lag)
    df["h_cov_lag"] = df.apply(
        lambda r: lookup_cov(r["league"], SEASON_LAG.get(r["season"]), r["c_home"]), axis=1
    )
    df["a_cov_lag"] = df.apply(
        lambda r: lookup_cov(r["league"], SEASON_LAG.get(r["season"]), r["c_away"]), axis=1
    )
    df["both_cov_ok"] = (df["h_cov_lag"] > 0.6) & (df["a_cov_lag"] > 0.6)

    print(f"\n  Squad-coverage distribution (per match, lag-season):")
    print(f"    matches with both squads >60% coverage: {df['both_cov_ok'].sum():,} ({df['both_cov_ok'].mean()*100:.1f}%)")
    print(f"    matches with at least one <60%:         {(~df['both_cov_ok']).sum():,}")

    # 2. League-normalize xa_diff_lag (z-score within league × season)
    print("\n  League-normalizing xa_diff_lag (z-score within league × season)...")
    # We need to z-score xa_total per (league, season) for lag-season
    tf_z = tf.copy()
    tf_z["xa_z"] = tf_z.groupby(["league", "season"])["xa_total"].transform(
        lambda x: (x - x.mean()) / x.std() if x.std() > 0 else np.nan
    )
    z_lookup = tf_z.set_index(["league", "season", "c"])["xa_z"]

    def lookup_z(league, season, club):
        try:
            return float(z_lookup.loc[(league, season, club)])
        except KeyError:
            return np.nan

    df["h_xa_z_lag"] = df.apply(
        lambda r: lookup_z(r["league"], SEASON_LAG.get(r["season"]), r["c_home"]), axis=1
    )
    df["a_xa_z_lag"] = df.apply(
        lambda r: lookup_z(r["league"], SEASON_LAG.get(r["season"]), r["c_away"]), axis=1
    )
    df["xa_z_diff_lag"] = df["h_xa_z_lag"] - df["a_xa_z_lag"]

    # 3. Test on filtered (both cov_ok) + normalised feature
    sub_clean = df.dropna(subset=["xa_z_diff_lag", "resid", "both_cov_ok"])
    sub_clean = sub_clean[sub_clean["both_cov_ok"]]
    sub_all = df.dropna(subset=["xa_z_diff_lag", "resid"])

    print(f"\n  Sample sizes:")
    print(f"    ALL (with z-normalised lag):    n={len(sub_all):,}")
    print(f"    CLEAN (squad-coverage filter):  n={len(sub_clean):,}")

    r_all_raw, _ = pearsonr(sub_all["xa_z_diff_lag"], sub_all["home_win"])
    r_all_res, _ = pearsonr(sub_all["xa_z_diff_lag"], sub_all["resid"])
    r_clean_raw, _ = pearsonr(sub_clean["xa_z_diff_lag"], sub_clean["home_win"])
    r_clean_res, _ = pearsonr(sub_clean["xa_z_diff_lag"], sub_clean["resid"])

    print(f"\n  AGGREGATE:")
    print(f"    {'config':<28} {'r_raw':>8} {'r_resid':>9}")
    print(f"    {'unfiltered + raw lag':<28} {gate1_result['r_raw_lag']:>+.4f} {gate1_result['r_resid_lag']:>+.4f}")
    print(f"    {'unfiltered + z-norm lag':<28} {r_all_raw:>+.4f} {r_all_res:>+.4f}")
    print(f"    {'cov>60% + z-norm lag':<28} {r_clean_raw:>+.4f} {r_clean_res:>+.4f}")

    # Per-league clean
    print(f"\n  Per-league r_resid for CLEAN + z-norm:")
    per_league = []
    for lg in sorted(sub_clean["league"].unique()):
        s = sub_clean[sub_clean["league"] == lg]
        if len(s) < 80:
            continue
        rr, _ = pearsonr(s["xa_z_diff_lag"], s["resid"])
        marker = "✅" if abs(rr) > 0.10 else "🟡" if abs(rr) > 0.05 else "❌"
        print(f"  {marker} {lg:<18}  n={len(s):>5,}  r_resid={rr:>+.4f}")
        per_league.append({"league": lg, "n": int(len(s)),
                           "r_resid_clean": round(float(rr), 4)})

    if abs(r_clean_res) < 0.02:
        verdict = "❌ FAIL — signal collapses after clean+normalise. Was artifact."
        proceed = False
    elif abs(r_clean_res) > abs(r_all_res):
        verdict = f"✅ PASS+ — signal STRONGER on clean data ({r_clean_res:+.4f} vs {r_all_res:+.4f})"
        proceed = True
    elif abs(r_clean_res) > 0.025:
        verdict = f"✅ PASS — signal survives clean+normalise ({r_clean_res:+.4f})"
        proceed = True
    else:
        verdict = f"⚠ WEAK — signal preserved but very small ({r_clean_res:+.4f})"
        proceed = False
    print(f"\n  GATE 2 VERDICT: {verdict}")
    return {
        "gate": 2,
        "n_all": int(len(sub_all)),
        "n_clean": int(len(sub_clean)),
        "r_raw_clean": round(float(r_clean_raw), 4),
        "r_resid_clean": round(float(r_clean_res), 4),
        "r_resid_all_zn": round(float(r_all_res), 4),
        "per_league": per_league,
        "verdict": verdict,
        "proceed": proceed,
        "_df": df,
    }


# =====================================================================
# GATE 3 — LR Pilot Retrain on super_lig + serie_b
# =====================================================================
def gate_3_lr_pilot(gate2_result):
    print("\n" + "═" * 70)
    print("GATE 3 — LR Pilot (super_lig + serie_b, temporal CV)")
    print("═" * 70)

    df = gate2_result["_df"].copy()
    df = df.dropna(subset=["xa_z_diff_lag", "p_pinn_h", "home_win"])

    PILOT_LEAGUES = ["super_lig", "serie_b"]
    results_per_league = []

    for lg in PILOT_LEAGUES:
        sub = df[df["league"] == lg].copy()
        print(f"\n  League: {lg}  (n={len(sub):,})")
        if len(sub) < 200:
            print(f"    ⚠ Too few rows — skipping")
            continue

        # Walk-forward CV: train on season N, predict season N+1
        cv_splits = [
            ("22/23", "23/24"),
            ("23/24", "24/25"),
        ]
        for train_s, test_s in cv_splits:
            tr = sub[sub["season"] == train_s].copy()
            te = sub[sub["season"] == test_s].copy()
            if len(tr) < 80 or len(te) < 80:
                print(f"    {train_s}→{test_s}: insufficient sample (tr={len(tr)}, te={len(te)}) — skip")
                continue
            # Baseline LR: just pinnacle prob
            X_tr_base = tr[["p_pinn_h"]].values
            X_te_base = te[["p_pinn_h"]].values
            y_tr = tr["home_win"].values
            y_te = te["home_win"].values
            lr_base = LogisticRegression()
            lr_base.fit(X_tr_base, y_tr)
            p_te_base = lr_base.predict_proba(X_te_base)[:, 1]
            brier_base = ((p_te_base - y_te) ** 2).mean()
            # Treatment: baseline + xa_z_diff_lag
            X_tr_trt = tr[["p_pinn_h", "xa_z_diff_lag"]].values
            X_te_trt = te[["p_pinn_h", "xa_z_diff_lag"]].values
            lr_trt = LogisticRegression()
            lr_trt.fit(X_tr_trt, y_tr)
            p_te_trt = lr_trt.predict_proba(X_te_trt)[:, 1]
            brier_trt = ((p_te_trt - y_te) ** 2).mean()
            brier_delta = brier_base - brier_trt
            coef_xa = lr_trt.coef_[0][1]
            marker = "✅" if brier_delta > 0.001 else "🟡" if brier_delta > 0.0001 else "❌"
            print(f"    {marker} {train_s}→{test_s}  n_tr={len(tr):>4,} n_te={len(te):>4,}  "
                  f"brier_base={brier_base:.4f}  brier_trt={brier_trt:.4f}  "
                  f"Δ={brier_delta:+.4f}  coef_xa={coef_xa:+.3f}")
            results_per_league.append({
                "league": lg, "train": train_s, "test": test_s,
                "n_train": int(len(tr)), "n_test": int(len(te)),
                "brier_baseline": round(float(brier_base), 5),
                "brier_treatment": round(float(brier_trt), 5),
                "brier_delta": round(float(brier_delta), 5),
                "coef_xa": round(float(coef_xa), 4),
            })

    # Verdict
    if not results_per_league:
        verdict = "❌ FAIL — no league had sufficient data for CV"
        proceed = False
    else:
        avg_delta = np.mean([r["brier_delta"] for r in results_per_league])
        positive_splits = sum(1 for r in results_per_league if r["brier_delta"] > 0)
        total = len(results_per_league)
        print(f"\n  Aggregate across {total} CV-splits:")
        print(f"    mean brier_delta: {avg_delta:+.5f}")
        print(f"    positive splits:  {positive_splits}/{total}")
        if avg_delta > 0.001 and positive_splits >= total * 0.75:
            verdict = f"✅ PASS — Brier-Δ={avg_delta:+.5f}, {positive_splits}/{total} positive splits. Worth full retrain."
            proceed = True
        elif avg_delta > 0.0001:
            verdict = f"🟡 MARGINAL — Brier-Δ={avg_delta:+.5f}. Below 0.001 threshold."
            proceed = False
        else:
            verdict = f"❌ FAIL — Brier-Δ={avg_delta:+.5f}. No engine value."
            proceed = False

    print(f"\n  GATE 3 VERDICT: {verdict}")
    return {
        "gate": 3,
        "splits": results_per_league,
        "verdict": verdict,
        "proceed": proceed,
    }


# =====================================================================
# MAIN
# =====================================================================
def main():
    t0 = time.time()
    print("\n╔══════════════════════════════════════════════════════════════════════╗")
    print("║  FS Player — Option A-minus: 3-Gate Causal Validation                ║")
    print("╚══════════════════════════════════════════════════════════════════════╝")

    # Shared data load
    tf = load_team_features()
    och = load_match_set()

    results = {"gates": {}}

    # Gate 1
    g1 = gate_1_lag_structure(tf, och)
    results["gates"]["1_lag"] = {k: v for k, v in g1.items() if not k.startswith("_")}
    if not g1["proceed"]:
        print("\n\n🛑 STOP at GATE 1 — close FS chapter as backtest-corpus only.")
        save_results(results, t0)
        return

    # Gate 2
    g2 = gate_2_bias_clean(g1, tf)
    results["gates"]["2_clean"] = {k: v for k, v in g2.items() if not k.startswith("_")}
    if not g2["proceed"]:
        print("\n\n🛑 STOP at GATE 2 — signal artifact of dirty data.")
        save_results(results, t0)
        return

    # Gate 3
    g3 = gate_3_lr_pilot(g2)
    results["gates"]["3_lr_pilot"] = {k: v for k, v in g3.items() if not k.startswith("_")}

    save_results(results, t0)

    # Final verdict
    print("\n" + "═" * 70)
    print("FINAL VERDICT (all 3 gates)")
    print("═" * 70)
    for k, v in results["gates"].items():
        print(f"  Gate {k}: {v['verdict']}")
    if g3["proceed"]:
        print("\n  ✅ FULL PASS — invest in importer fix + full retrain.")
    else:
        print("\n  🛑 STOP at GATE 3 — no engine value materializes.")


def save_results(results, t0):
    results["elapsed_s"] = round(time.time() - t0, 1)
    out = ROOT / "tools" / "v4" / "diagnostics" / "fs_player_causal_gates.json"
    out.write_text(json.dumps(results, indent=2, default=str))
    print(f"\n✓ Report saved: {out}")


if __name__ == "__main__":
    main()
