"""
FS Player Data — 1h Go/No-Go Minimal Stack

Three sequential tests per data-science roadmap:
  Phase A (15-20 min): Survival-bias check — are the 34k landed rows
    representative of the ~48k that should have landed? KS-test on
    position/league/minutes/age distributions of landed vs lost.
  Phase B (20 min): Team-aggregated signal test — derive team-level
    features from player_season_stats (top3_xg_share, squad_size,
    mean_regular_age, etc.) and test:
      * Pearson + Spearman correlation with home_win residual
      * Mutual Information (captures non-linear signal Pearson misses)
      * Binned-LOESS-like means: feature decile vs outcome rate
  Phase C (15 min): Poisson proxy for Over2.5 — use FS player xG to
    derive per-team lambda, simulate P(Over2.5), compare calibration
    Brier vs season-average baseline.

Verdict:
  ✅ SIGNAL → invest in importer fixes + dev-03 retrain
  ❌ NOISE → close FS player chapter as backtest-only

Usage:
  tools/venv/bin/python3 tools/v4/diagnostics/fs_player_go_nogo.py
"""

from __future__ import annotations

import csv
import importlib.util
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import requests
from scipy.stats import ks_2samp, pearsonr, spearmanr
from sklearn.feature_selection import mutual_info_classif

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

# Import canonical_team_map (bypass v4/__init__ scaffold)
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

CSV_DIR = ROOT / "tools" / "footystats" / "csv"

FILENAME_PREFIX_TO_LEAGUE = {
    "england-championship": "championship",
    "england-efl-league-one": "league_one",
    "england-efl-league-two": "league_two",
    "germany-2-bundesliga": "bundesliga2",
    "germany-3-liga": "liga3",
    "spain-segunda-division": "la_liga2",
    "italy-serie-b": "serie_b",
    "france-ligue-2": "ligue_2",
    "netherlands-eredivisie": "eredivisie",
    "portugal-liga-nos": "primeira_liga",
    "belgium-pro-league": "jupiler_pro",
    "turkey-super-lig": "super_lig",
    "scotland-premiership": "scottish_prem",
    "greece-super-league": "greek_sl",
    "austria-bundesliga": "austria_bl",
    "switzerland-super-league": "swiss_sl",
}


def supa_pull(table: str, select: str, filters: dict = None, page_size: int = 1000) -> pd.DataFrame:
    out = []
    offset = 0
    while True:
        url = f"{SUPA_URL}/rest/v1/{table}?select={select}"
        for k, v in (filters or {}).items():
            url += f"&{k}={v}"
        url += f"&limit={page_size}&offset={offset}"
        r = requests.get(url, headers=HDRS, timeout=60)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        out.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
        if offset > 200000:
            print(f"  ⚠ {table}: stopped at offset {offset}")
            break
    return pd.DataFrame(out)


def vig_remove_1x2(h: float, d: float, a: float):
    if not all(x and x > 1.0 for x in (h, d, a)):
        return (np.nan, np.nan, np.nan)
    ih, id_, ia = 1 / h, 1 / d, 1 / a
    s = ih + id_ + ia
    return (ih / s, id_ / s, ia / s)


# =====================================================================
# PHASE A: SURVIVAL-BIAS CHECK
# =====================================================================
def phase_a_survival_bias():
    print("\n" + "═" * 70)
    print("PHASE A — Survival-Bias Check (CSV vs DB)")
    print("═" * 70)

    # 1. Load all 80 player CSVs locally
    csv_records = []
    csv_files = sorted(CSV_DIR.glob("*-players-*.csv"))
    print(f"\n  Reading {len(csv_files)} player CSVs from disk...")
    for f in csv_files:
        # Infer league + season from filename
        name = f.stem.lower()
        league = None
        for prefix, key in FILENAME_PREFIX_TO_LEAGUE.items():
            if name.startswith(prefix + "-players-"):
                league = key
                break
        if not league:
            continue
        m = name.split("-players-")[1].rstrip("-stats")
        # e.g. "2024-to-2025-stats" → 24/25
        parts = m.split("-")
        if len(parts) >= 3 and parts[0].isdigit() and parts[2].isdigit():
            season = f"{parts[0][2:]}/{parts[2][2:]}"
        else:
            continue
        # Read CSV
        with open(f, encoding="utf-8") as fh:
            rdr = csv.DictReader(fh)
            for row in rdr:
                csv_records.append({
                    "full_name": row.get("full_name", "").strip(),
                    "current_club": row.get("Current Club", "").strip(),
                    "league": league,
                    "season": season,
                    "position": row.get("position", "").strip(),
                    "age": int(row["age"]) if row.get("age", "").isdigit() else None,
                    "minutes_played": int(row["minutes_played_overall"])
                        if row.get("minutes_played_overall", "").isdigit() else None,
                    "birthday_raw": row.get("birthday", "").strip(),
                })
    csv_df = pd.DataFrame(csv_records)
    print(f"  CSV total: {len(csv_df):,} player-rows")

    # 2. Canonicalize team-name to match DB
    csv_df["canon_club"] = csv_df.apply(
        lambda r: canonical_team(r["current_club"], r["league"]), axis=1
    )

    # 3. Load DB rows
    print("\n  Loading player_season_stats from DB...")
    db_df = supa_pull("player_season_stats", "league,season,full_name,current_club,position,age,minutes_played")
    db_df["join_key"] = db_df["league"] + "|" + db_df["season"] + "|" + db_df["full_name"] + "|" + db_df["current_club"]
    db_keys = set(db_df["join_key"])
    print(f"  DB total:  {len(db_df):,} rows · {len(db_keys):,} unique join-keys")

    # 4. For each CSV row: is it in DB?
    csv_df["join_key"] = (
        csv_df["league"] + "|" + csv_df["season"] + "|" + csv_df["full_name"] + "|" + csv_df["canon_club"]
    )
    csv_df["landed"] = csv_df["join_key"].isin(db_keys)
    landed = csv_df[csv_df["landed"]]
    lost = csv_df[~csv_df["landed"]]
    print(f"\n  Landed: {len(landed):,} ({len(landed)/len(csv_df)*100:.1f}%)")
    print(f"  Lost:   {len(lost):,}  ({len(lost)/len(csv_df)*100:.1f}%)")

    if len(lost) < 100:
        print("  ⚠ Very few lost — survival-bias check skipped")
        return {"phase": "A", "lost_n": int(len(lost)), "verdict": "INCONCLUSIVE"}

    # 5. Distribution comparison: landed vs lost
    print("\n  Distribution differences (landed vs lost):")
    bias_findings = []

    # Position
    pos_landed = landed["position"].value_counts(normalize=True).head(4)
    pos_lost = lost["position"].value_counts(normalize=True).head(4)
    print(f"\n  Position distribution (top 4):")
    for pos in pos_landed.index:
        l = pos_landed.get(pos, 0)
        ll = pos_lost.get(pos, 0)
        diff = (ll - l) * 100
        marker = "⚠" if abs(diff) > 5 else " "
        print(f"    {marker} {pos:<14}  landed={l*100:5.1f}%  lost={ll*100:5.1f}%  Δ={diff:+5.1f}pp")
        bias_findings.append({"dim": "position", "value": pos, "landed_pct": round(float(l)*100, 2),
                             "lost_pct": round(float(ll)*100, 2), "diff_pp": round(diff, 2)})

    # League — count landed-rate per league
    print(f"\n  Survival-rate per league (high = good, low = batch failed):")
    surv_by_league = csv_df.groupby("league")["landed"].mean().sort_values()
    for lg, rate in surv_by_league.head(8).items():  # worst 8
        n_lost = (csv_df[csv_df.league == lg]["landed"] == False).sum()
        marker = "🔴" if rate < 0.5 else "🟡" if rate < 0.8 else "🟢"
        print(f"    {marker} {lg:<18} {rate*100:5.1f}%  (lost {n_lost})")

    # KS-test on minutes_played (numeric)
    minutes_landed = landed["minutes_played"].dropna()
    minutes_lost = lost["minutes_played"].dropna()
    if len(minutes_landed) > 100 and len(minutes_lost) > 100:
        ks_stat, ks_p = ks_2samp(minutes_landed, minutes_lost)
        print(f"\n  KS-test minutes_played: stat={ks_stat:.3f} p={ks_p:.4f}")
        print(f"    landed: mean={minutes_landed.mean():.0f} median={minutes_landed.median():.0f}")
        print(f"    lost:   mean={minutes_lost.mean():.0f} median={minutes_lost.median():.0f}")

    # Age (with epoch-birthday detection)
    age_landed = landed["age"].dropna()
    age_lost = lost["age"].dropna()
    if len(age_landed) > 100:
        ks_stat_age, ks_p_age = ks_2samp(age_landed, age_lost)
        print(f"\n  KS-test age: stat={ks_stat_age:.3f} p={ks_p_age:.4f}")
        epoch_lost = (lost["birthday_raw"].apply(lambda x: x in ("28800", "0", ""))).sum()
        print(f"  Epoch-birthday rows in LOST: {epoch_lost} ({epoch_lost/max(len(lost),1)*100:.1f}%)")

    # Verdict
    sig_diffs = sum(1 for b in bias_findings if abs(b["diff_pp"]) > 5)
    verdict = "BIAS DETECTED" if sig_diffs >= 2 else "ACCEPTABLE"
    print(f"\n  Verdict: {verdict} ({sig_diffs} dimensions with |Δ|>5pp)")
    return {"phase": "A", "lost_n": int(len(lost)),
            "lost_pct": round(len(lost)/len(csv_df)*100, 1),
            "verdict": verdict, "bias_findings": bias_findings,
            "ks_minutes_p": round(ks_p, 4) if len(minutes_landed) > 100 else None}


# =====================================================================
# PHASE B: TEAM-AGGREGATED SIGNAL TEST
# =====================================================================
def phase_b_team_signal():
    print("\n" + "═" * 70)
    print("PHASE B — Team-Aggregated Signal Test (1X2)")
    print("═" * 70)

    # 1. Pull player_season_stats
    print("\n  Loading player_season_stats...")
    pss = supa_pull(
        "player_season_stats",
        "league,season,full_name,current_club,position,age,minutes_played,xg_total,npxg_total,xa_total,goals,assists,key_passes_total,interceptions,clearances",
        filters={"season": "in.(22/23,23/24,24/25)"},
    )
    for c in ("minutes_played", "xg_total", "npxg_total", "xa_total", "goals", "assists", "key_passes_total", "interceptions", "clearances", "age"):
        pss[c] = pd.to_numeric(pss[c], errors="coerce")
    print(f"  {len(pss):,} player-season rows")

    # 2. Aggregate to team-season
    def safe_top3_share(g, col):
        s = g[col].dropna().sort_values(ascending=False).head(3).sum()
        t = g[col].dropna().sum()
        return s / t if t > 0 else np.nan

    print("  Aggregating to team-season features...")
    team_features = pss.groupby(["league", "season", "current_club"]).apply(
        lambda g: pd.Series({
            "squad_size": len(g),
            "regulars": (g["minutes_played"] >= 900).sum(),
            "total_xg": g["xg_total"].sum(),
            "total_npxg": g["npxg_total"].sum(),
            "total_xa": g["xa_total"].sum(),
            "total_goals": g["goals"].sum(),
            "total_key_passes": g["key_passes_total"].sum(),
            "top3_xg_share": safe_top3_share(g, "xg_total"),
            "top3_xa_share": safe_top3_share(g, "xa_total"),
            "mean_regular_age": g[g["minutes_played"] >= 900]["age"].mean(),
            "std_regular_age": g[g["minutes_played"] >= 900]["age"].std(),
            "fwd_count": (g["position"] == "Forward").sum(),
            "def_count": (g["position"] == "Defender").sum(),
            "total_interceptions": g["interceptions"].sum(),
            "total_clearances": g["clearances"].sum(),
        }), include_groups=False
    ).reset_index()
    team_features["current_club_canon"] = team_features.apply(
        lambda r: canonical_team(r["current_club"], r["league"]), axis=1
    )
    print(f"  {len(team_features):,} team-seasons")

    # 3. Pull odds_closing_history for outcomes
    print("\n  Loading odds_closing_history (Pinnacle 1X2 + ft_goals)...")
    och = supa_pull(
        "odds_closing_history",
        "league,match_date,home_team,away_team,psch,pscd,psca,ft_goals_h,ft_goals_a",
        filters={"match_date": "gte.2022-07-01", "ft_goals_h": "not.is.null", "psch": "not.is.null"},
    )
    for c in ("psch", "pscd", "psca", "ft_goals_h", "ft_goals_a"):
        och[c] = pd.to_numeric(och[c], errors="coerce")
    och["c_home"] = och.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    och["c_away"] = och.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    och["season"] = pd.to_datetime(och["match_date"]).apply(
        lambda d: f"{str(d.year)[2:]}/{str(d.year + 1)[2:]}" if d.month >= 7
                  else f"{str(d.year - 1)[2:]}/{str(d.year)[2:]}"
    )
    print(f"  {len(och):,} odds-rows")

    # 4. Join: each match × home team features × away team features
    print("\n  Joining matches × team-features...")
    home_join = team_features.add_prefix("h_").rename(
        columns={"h_league": "league", "h_season": "season", "h_current_club_canon": "c_home"}
    )
    away_join = team_features.add_prefix("a_").rename(
        columns={"a_league": "league", "a_season": "season", "a_current_club_canon": "c_away"}
    )
    j1 = och.merge(home_join, on=["league", "season", "c_home"], how="inner")
    joined = j1.merge(away_join, on=["league", "season", "c_away"], how="inner")
    print(f"  Joined: {len(joined):,} matches (from {len(och):,} odds-rows)")

    if len(joined) < 500:
        print("  ⚠ Too few joined — abort phase B")
        return {"phase": "B", "joined_n": int(len(joined)), "verdict": "ABORTED"}

    # 5. Build features + baseline + outcome
    pH, pD, pA = zip(*joined.apply(
        lambda r: vig_remove_1x2(r["psch"], r["pscd"], r["psca"]), axis=1
    ))
    joined["p_pinn_h"] = pH
    joined["home_win"] = (joined["ft_goals_h"] > joined["ft_goals_a"]).astype(int)
    joined["resid"] = joined["home_win"] - joined["p_pinn_h"]
    joined["total_goals"] = joined["ft_goals_h"] + joined["ft_goals_a"]
    joined["over25"] = (joined["total_goals"] > 2.5).astype(int)

    candidates = [
        ("xg_diff", joined["h_total_xg"] - joined["a_total_xg"]),
        ("npxg_diff", joined["h_total_npxg"] - joined["a_total_npxg"]),
        ("xa_diff", joined["h_total_xa"] - joined["a_total_xa"]),
        ("top3_xg_share_diff", joined["h_top3_xg_share"] - joined["a_top3_xg_share"]),
        ("regulars_diff", joined["h_regulars"] - joined["a_regulars"]),
        ("mean_age_diff", joined["h_mean_regular_age"] - joined["a_mean_regular_age"]),
        ("def_count_diff", joined["h_def_count"] - joined["a_def_count"]),
        ("interceptions_diff", joined["h_total_interceptions"] - joined["a_total_interceptions"]),
    ]

    print(f"\n{'Feature':<22} {'n':>6}  {'r_raw':>8}  {'r_resid':>9}  {'spear_r':>8}  {'MI':>6}  Verdict")
    print("-" * 80)
    phase_b_results = []
    for name, feature in candidates:
        sub = pd.DataFrame({"f": feature, "y": joined["home_win"], "r": joined["resid"]}).dropna()
        if len(sub) < 100:
            continue
        x = sub["f"].values
        y = sub["y"].values
        r = sub["r"].values
        r_raw, _ = pearsonr(x, y)
        r_resid, _ = pearsonr(x, r)
        spear, _ = spearmanr(x, y)
        # Mutual Information (non-linear capture)
        mi = mutual_info_classif(x.reshape(-1, 1), y, random_state=42)[0]
        # Verdict gates
        v = "❌ NOISE"
        if abs(r_resid) > 0.05 and abs(r_resid) > abs(r_raw) * 0.3:
            v = "🟢 MODERATE"
        elif abs(r_resid) > 0.03:
            v = "🟡 WEAK"
        elif mi > 0.01:
            v = "🟡 NON-LINEAR?"
        print(f"{name:<22} {len(sub):>6,}  {r_raw:>+.4f}  {r_resid:>+.4f}  {spear:>+.4f}  {mi:>.4f}  {v}")
        phase_b_results.append({"feature": name, "n": int(len(sub)),
                                "r_raw": round(float(r_raw), 4),
                                "r_residual": round(float(r_resid), 4),
                                "spearman": round(float(spear), 4),
                                "mutual_info": round(float(mi), 4),
                                "verdict": v})

    # 6. Best-feature LOESS-like binned-means
    best = max(phase_b_results, key=lambda r: abs(r["r_residual"]))
    print(f"\n  LOESS-binned analysis of best feature: {best['feature']} (r_resid={best['r_residual']})")
    feature = next(f for n, f in candidates if n == best["feature"])
    sub = pd.DataFrame({"f": feature, "y": joined["home_win"], "p": joined["p_pinn_h"]}).dropna()
    sub["decile"] = pd.qcut(sub["f"], 10, labels=False, duplicates="drop")
    bins = sub.groupby("decile").agg(
        n=("y", "count"), mean_f=("f", "mean"),
        mean_y=("y", "mean"), mean_p=("p", "mean")
    )
    bins["resid"] = bins["mean_y"] - bins["mean_p"]
    print("  decile  n      mean_feat   y_rate   pinn_p   resid")
    for d, row in bins.iterrows():
        print(f"    {d:<5} {int(row['n']):>5,}   {row['mean_f']:>+7.2f}  {row['mean_y']:.3f}  {row['mean_p']:.3f}  {row['resid']:+.3f}")

    # Overall verdict
    any_signal = any(abs(r["r_residual"]) > 0.03 or r["mutual_info"] > 0.01 for r in phase_b_results)
    return {"phase": "B", "joined_n": int(len(joined)),
            "features": phase_b_results,
            "verdict": "SIGNAL" if any_signal else "NOISE"}


# =====================================================================
# PHASE C: POISSON PROXY FOR OVER2.5
# =====================================================================
def phase_c_poisson_over25():
    print("\n" + "═" * 70)
    print("PHASE C — Poisson Proxy for Over2.5 (FS-xG vs Season-Avg)")
    print("═" * 70)

    # 1. Compute per-team avg goals + xg per match per season from team_xg_history
    print("\n  Loading team_xg_history for goals/xg baselines...")
    txh = supa_pull(
        "team_xg_history",
        "team,league,match_date,xg,xga,goals_for,goals_against,venue,source",
        filters={"match_date": "gte.2022-07-01", "match_date": "lte.2026-06-30"},
    )
    for c in ("xg", "xga", "goals_for", "goals_against"):
        txh[c] = pd.to_numeric(txh[c], errors="coerce")
    txh["season"] = pd.to_datetime(txh["match_date"]).apply(
        lambda d: f"{str(d.year)[2:]}/{str(d.year + 1)[2:]}" if d.month >= 7
                  else f"{str(d.year - 1)[2:]}/{str(d.year)[2:]}"
    )
    print(f"  {len(txh):,} team-match rows")

    # 2. Per (team, league, season): avg xg-for + xg-against
    team_avg = txh.groupby(["team", "league", "season"]).agg(
        xg_for=("xg", "mean"),
        xg_against=("xga", "mean"),
        goals_for=("goals_for", "mean"),
        goals_against=("goals_against", "mean"),
        n=("match_date", "count"),
    ).reset_index()
    team_avg = team_avg[team_avg["n"] >= 5]  # need enough games
    print(f"  Team-season averages: {len(team_avg):,}")

    # League seasonal-avg total goals (baseline)
    league_avg = txh.groupby(["league", "season"]).agg(
        league_avg_goals=("goals_for", lambda x: x.mean() * 2)  # both teams
    ).reset_index()

    # 3. Build holdout match set: 24/25 with closing odds + outcomes
    print("\n  Loading 24/25 odds_closing_history for holdout...")
    och = supa_pull(
        "odds_closing_history",
        "league,match_date,home_team,away_team,ft_goals_h,ft_goals_a",
        filters={"match_date": "gte.2024-07-01", "match_date": "lt.2025-07-01",
                 "ft_goals_h": "not.is.null"},
    )
    for c in ("ft_goals_h", "ft_goals_a"):
        och[c] = pd.to_numeric(och[c], errors="coerce")
    och["c_home"] = och.apply(lambda r: canonical_team(r["home_team"], r["league"]), axis=1)
    och["c_away"] = och.apply(lambda r: canonical_team(r["away_team"], r["league"]), axis=1)
    och["total_goals"] = och["ft_goals_h"] + och["ft_goals_a"]
    och["over25"] = (och["total_goals"] > 2.5).astype(int)
    och["season"] = "24/25"
    print(f"  {len(och):,} 24/25 matches with outcomes")

    # 4. Join holdout × team-avg
    h = team_avg.rename(columns={"team": "c_home",
                                 "xg_for": "h_xg_for", "xg_against": "h_xg_against",
                                 "goals_for": "h_goals_for", "goals_against": "h_goals_against"})
    a = team_avg.rename(columns={"team": "c_away",
                                 "xg_for": "a_xg_for", "xg_against": "a_xg_against",
                                 "goals_for": "a_goals_for", "goals_against": "a_goals_against"})
    j1 = och.merge(h[["c_home", "league", "season", "h_xg_for", "h_xg_against"]],
                   on=["c_home", "league", "season"], how="inner")
    joined = j1.merge(a[["c_away", "league", "season", "a_xg_for", "a_xg_against"]],
                      on=["c_away", "league", "season"], how="inner")
    joined = joined.merge(league_avg, on=["league", "season"], how="left")
    print(f"  Joined holdout: {len(joined):,}")

    if len(joined) < 200:
        print("  ⚠ Too few joined")
        return {"phase": "C", "joined_n": int(len(joined)), "verdict": "ABORTED"}

    # 5. Two predictors:
    #    A. Poisson(lambda_h = (h_xg_for + a_xg_against)/2,
    #               lambda_a = (a_xg_for + h_xg_against)/2)
    #    B. Season-avg baseline: lambda = league_avg_goals / 2 each side
    def p_over25_poisson(lh, la, n_sim=5000, seed=42):
        if not (np.isfinite(lh) and np.isfinite(la)):
            return np.nan
        rng = np.random.default_rng(seed + int(lh * 100))
        h = rng.poisson(lh, n_sim)
        a = rng.poisson(la, n_sim)
        return ((h + a) > 2.5).mean()

    print("\n  Computing P(Over2.5) for both models...")
    joined["lh_xg"] = (joined["h_xg_for"] + joined["a_xg_against"]) / 2
    joined["la_xg"] = (joined["a_xg_for"] + joined["h_xg_against"]) / 2
    joined["p_over25_xg"] = joined.apply(
        lambda r: p_over25_poisson(r["lh_xg"], r["la_xg"]), axis=1
    )
    # baseline: league-average split 50/50 to home/away
    joined["lh_base"] = joined["league_avg_goals"] / 2
    joined["la_base"] = joined["league_avg_goals"] / 2
    joined["p_over25_base"] = joined.apply(
        lambda r: p_over25_poisson(r["lh_base"], r["la_base"]), axis=1
    )

    # 6. Brier scores
    valid = joined.dropna(subset=["p_over25_xg", "p_over25_base", "over25"])
    print(f"  Valid for scoring: {len(valid):,}")
    brier_xg = ((valid["p_over25_xg"] - valid["over25"]) ** 2).mean()
    brier_base = ((valid["p_over25_base"] - valid["over25"]) ** 2).mean()
    # Naive constant baseline (P=0.55, common Over25 rate)
    brier_const = ((0.55 - valid["over25"]) ** 2).mean()

    print(f"\n  Brier Scores (lower=better):")
    print(f"    Naive constant (P=0.55):      {brier_const:.5f}")
    print(f"    League-seasonal-avg Poisson:  {brier_base:.5f}  (Δ vs constant: {brier_const-brier_base:+.5f})")
    print(f"    FS-xG Poisson:                {brier_xg:.5f}  (Δ vs baseline:  {brier_base-brier_xg:+.5f})")

    delta_pp = (brier_base - brier_xg) * 100
    if delta_pp > 0.5:
        v = "✅ SIGNAL (FS-xG meaningfully better)"
    elif delta_pp > 0.1:
        v = "🟡 MARGINAL (small improvement)"
    elif delta_pp > -0.1:
        v = "❌ NOISE (no improvement)"
    else:
        v = "❌ WORSE (FS-xG degrades vs baseline)"
    print(f"\n  Verdict: {v}")

    # Per-league check
    print(f"\n  Per-league Brier-Δ (FS-xG vs baseline):")
    for lg in sorted(valid["league"].unique()):
        sub = valid[valid["league"] == lg]
        if len(sub) < 30:
            continue
        b_xg = ((sub["p_over25_xg"] - sub["over25"]) ** 2).mean()
        b_base = ((sub["p_over25_base"] - sub["over25"]) ** 2).mean()
        d = (b_base - b_xg) * 1000
        if abs(d) > 5:  # only show interesting deltas
            print(f"    {lg:<18}  n={len(sub):>4,}  brier_xg={b_xg:.4f}  brier_base={b_base:.4f}  Δ×1000={d:+.1f}")

    return {"phase": "C",
            "n": int(len(valid)),
            "brier_constant": round(float(brier_const), 5),
            "brier_baseline": round(float(brier_base), 5),
            "brier_fsxg": round(float(brier_xg), 5),
            "delta_brier_pp": round(float(delta_pp), 3),
            "verdict": v}


# =====================================================================
# MAIN
# =====================================================================
def main():
    t0 = time.time()
    print("\n╔══════════════════════════════════════════════════════════════════════╗")
    print("║  FS Player Data — 1h Go/No-Go Minimal Stack                          ║")
    print("╚══════════════════════════════════════════════════════════════════════╝")

    results = {"phases": {}}
    for fn, label in [
        (phase_a_survival_bias, "A"),
        (phase_b_team_signal, "B"),
        (phase_c_poisson_over25, "C"),
    ]:
        try:
            results["phases"][label] = fn()
        except Exception as e:
            print(f"\n✗ Phase {label} failed: {e}")
            import traceback
            traceback.print_exc()
            results["phases"][label] = {"phase": label, "error": str(e), "verdict": "FAILED"}

    results["elapsed_s"] = round(time.time() - t0, 1)

    # Save report
    out = ROOT / "tools" / "v4" / "diagnostics" / "fs_player_go_nogo.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"\n✓ Report saved: {out}")

    # FINAL VERDICT
    print("\n" + "═" * 70)
    print("FINAL GO/NO-GO VERDICT")
    print("═" * 70)
    a = results["phases"].get("A", {}).get("verdict", "?")
    b = results["phases"].get("B", {}).get("verdict", "?")
    c = results["phases"].get("C", {}).get("verdict", "?")
    print(f"  Phase A (bias):    {a}")
    print(f"  Phase B (signal):  {b}")
    print(f"  Phase C (Over25):  {c}")
    print(f"  Total elapsed: {time.time() - t0:.1f}s")

    # Decision tree
    go_signals = sum(1 for v in (b, c) if "SIGNAL" in v or "MODERATE" in v)
    if go_signals >= 1 and "BIAS" not in a:
        print(f"\n  → GO: invest in importer fixes + dev-03 retrain")
    elif "BIAS" in a:
        print(f"\n  → CONDITIONAL: fix importer FIRST to remove bias, then re-test")
    else:
        print(f"\n  → NO-GO: close FS player chapter as backtest-corpus only")


if __name__ == "__main__":
    main()
