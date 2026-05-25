"""
Lineup-Aware MVP — EPL 22/23 + 23/24 (Understat per-match player data)

Hypothesis: Sum of starting-XI rolling xg_per_90 (computed from PRIOR
matches in same season — no leakage) provides INCREMENTAL signal beyond
Pinnacle closing odds.

Why this might work where season-aggregate-FS failed:
  - Per-match starter data captures lineup rotation (rested stars, injuries)
  - Pinnacle SHOULD know lineup by closing time, but lineup-weighting in
    market-pricing might be imperfect
  - Edge candidates: home-advantage-aware lineup quality, injury impact

Design:
  - Cold-start: cumulative within-season; player needs ≥90 prior min to qualify
  - Cold-start unqualified players contribute 0 to team-sum (conservative)
  - Walk-forward CV: train 22/23 LR(pinnacle + feature), test 23/24
  - Brier-Δ + LR coefficient + per-decile residual analysis

If Brier-Δ > +0.002: SIGNAL → expand to other Top-5 leagues + multi-season
If Brier-Δ < +0.001: NOISE → lineup-aware via this aggregation doesn't help
"""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from scipy.stats import pearsonr
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

# Canonical-team loader
_spec = importlib.util.spec_from_file_location(
    "ctm", ROOT / "tools" / "v4" / "modules" / "m3_xg" / "canonical_team_map.py"
)
_ctm = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_ctm)
canon = _ctm.canonical_team


def load_env():
    env_path = ROOT / ".env.local"
    if not env_path.exists(): return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v)


load_env()
SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
HDRS = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}
LOCAL_DB = ROOT / "tools" / "sofascore" / "data" / "local_extras.db"


def supa_pull(table, select, filters=None):
    out, off = [], 0
    while True:
        url = f"{SUPA_URL}/rest/v1/{table}?select={select}"
        for k, v in (filters or {}).items(): url += f"&{k}={v}"
        url += f"&limit=1000&offset={off}"
        r = requests.get(url, headers=HDRS, timeout=60); r.raise_for_status()
        b = r.json()
        if not b: break
        out.extend(b)
        if len(b) < 1000: break
        off += 1000
        if off > 100000: break
    return pd.DataFrame(out)


def vig_remove_h(h, d, a):
    if not all(x and x > 1 for x in (h, d, a)): return np.nan
    ih = 1/h; id_ = 1/d; ia = 1/a
    return ih / (ih + id_ + ia)


# =====================================================================
# 1. Load Understat per-match player data + compute rolling features
# =====================================================================
def build_player_features(seasons=("2022/23", "2023/24"), league="epl"):
    print(f"\n[1/5] Loading understat per-match for {league} × {seasons}...")
    conn = sqlite3.connect(LOCAL_DB)
    seasons_in = "','".join(seasons)
    df = pd.read_sql(
        f"""SELECT match_id, league, season, match_date, home_team, away_team,
                  is_home, player_id, player_name, position, is_starter,
                  time_minutes, goals, assists, shots, key_passes, xg, xa, xg_chain
            FROM understat_player_match_stats
            WHERE league='{league}' AND season IN ('{seasons_in}')""",
        conn
    )
    df["match_date"] = pd.to_datetime(df["match_date"])
    print(f"  rows: {len(df):,} · matches: {df['match_id'].nunique()} · players: {df['player_id'].nunique()}")

    # Sort temporally per player to enable cumulative ROLLING (prior-only, no leakage)
    df = df.sort_values(["player_id", "match_date", "match_id"]).reset_index(drop=True)

    # Per-player cumulative sums BEFORE current row (shift by one)
    for col in ("xg", "xa", "time_minutes", "shots"):
        df[f"cum_{col}_prior"] = df.groupby("player_id")[col].cumsum() - df[col]

    # Compute per-90 rolling values; need ≥90 prior minutes to qualify
    qual = df["cum_time_minutes_prior"] >= 90
    df["xg_per_90"] = np.where(qual, df["cum_xg_prior"] / (df["cum_time_minutes_prior"] / 90), np.nan)
    df["xa_per_90"] = np.where(qual, df["cum_xa_prior"] / (df["cum_time_minutes_prior"] / 90), np.nan)
    df["shots_per_90"] = np.where(qual, df["cum_shots_prior"] / (df["cum_time_minutes_prior"] / 90), np.nan)

    n_qual = qual.sum()
    print(f"  qualified player-match rows (≥90 prior min): {n_qual:,} / {len(df):,}  "
          f"({n_qual/len(df)*100:.1f}%)")
    return df


# =====================================================================
# 2. Aggregate per match: starting 11 sums (home / away)
# =====================================================================
def aggregate_team_features(df):
    print("\n[2/5] Aggregating starting-XI features per match...")
    starters = df[df["is_starter"] == 1].copy()
    print(f"  starter rows: {len(starters):,} (avg per match: {len(starters)/df['match_id'].nunique():.1f})")

    # Sum across starting 11, treating NaN (cold-start) as 0
    team_agg = starters.groupby(["match_id", "is_home"]).agg(
        xg_strength=("xg_per_90", lambda x: x.fillna(0).sum()),
        xa_strength=("xa_per_90", lambda x: x.fillna(0).sum()),
        shots_strength=("shots_per_90", lambda x: x.fillna(0).sum()),
        n_qualified=("xg_per_90", lambda x: x.notna().sum()),
    ).reset_index()

    # Pivot to wide: home_* / away_* columns per match
    home = team_agg[team_agg["is_home"] == 1].rename(columns={
        "xg_strength": "h_xg_str", "xa_strength": "h_xa_str",
        "shots_strength": "h_sh_str", "n_qualified": "h_n_qual"
    }).drop(columns="is_home")
    away = team_agg[team_agg["is_home"] == 0].rename(columns={
        "xg_strength": "a_xg_str", "xa_strength": "a_xa_str",
        "shots_strength": "a_sh_str", "n_qualified": "a_n_qual"
    }).drop(columns="is_home")
    matches = home.merge(away, on="match_id")
    matches["xg_diff"] = matches["h_xg_str"] - matches["a_xg_str"]
    matches["xa_diff"] = matches["h_xa_str"] - matches["a_xa_str"]
    matches["sh_diff"] = matches["h_sh_str"] - matches["a_sh_str"]
    matches["xg_xa_diff"] = matches["xg_diff"] + matches["xa_diff"]
    matches["min_qual"] = matches[["h_n_qual", "a_n_qual"]].min(axis=1)

    # Attach match meta (date, season, teams)
    meta = df[["match_id", "match_date", "season", "home_team", "away_team", "league"]].drop_duplicates("match_id")
    out = matches.merge(meta, on="match_id")
    out["season_short"] = out["season"].map({"2022/23": "22/23", "2023/24": "23/24"})
    out["c_home"] = out["home_team"].apply(lambda x: canon(x, out["league"].iloc[0]))
    out["c_away"] = out["away_team"].apply(lambda x: canon(x, out["league"].iloc[0]))
    print(f"  match-level features: {len(out):,} matches")
    print(f"  min(qualified-starters): median={int(out['min_qual'].median())}, p10={int(out['min_qual'].quantile(.1))}")
    return out


# =====================================================================
# 3. Join Pinnacle baseline + outcomes
# =====================================================================
def join_with_market(matches):
    print("\n[3/5] Loading odds_closing_history × EPL 22/23+23/24...")
    och = supa_pull(
        "odds_closing_history",
        "league,match_date,home_team,away_team,psch,pscd,psca,ft_goals_h,ft_goals_a",
        filters={"league": "eq.epl", "match_date": "gte.2022-07-01",
                 "match_date": "lt.2024-08-01",
                 "ft_goals_h": "not.is.null", "psch": "not.is.null"},
    )
    for c in ("psch", "pscd", "psca", "ft_goals_h", "ft_goals_a"):
        och[c] = pd.to_numeric(och[c], errors="coerce")
    och["c_home"] = och["home_team"].apply(lambda x: canon(x, "epl"))
    och["c_away"] = och["away_team"].apply(lambda x: canon(x, "epl"))
    och["match_date"] = pd.to_datetime(och["match_date"])
    print(f"  odds rows: {len(och):,}")

    j = matches.merge(och[["c_home", "c_away", "match_date", "psch", "pscd", "psca",
                            "ft_goals_h", "ft_goals_a"]],
                      on=["c_home", "c_away", "match_date"], how="inner")
    print(f"  joined: {len(j):,} (from {len(matches):,} matches)")

    j["p_pinn_h"] = j.apply(lambda r: vig_remove_h(r["psch"], r["pscd"], r["psca"]), axis=1)
    j["home_win"] = (j["ft_goals_h"] > j["ft_goals_a"]).astype(int)
    j = j.dropna(subset=["p_pinn_h", "home_win"])
    return j


# =====================================================================
# 4. Walk-forward CV: train 22/23, test 23/24
# =====================================================================
def permutation_brier_pvalue(p_treat, p_base, y, n_perm=500, seed=42):
    """Permutation test: are the residuals from treatment significantly
    different from baseline? Shuffle the label between treat/base and
    check how often the observed brier-Δ is matched."""
    rng = np.random.default_rng(seed)
    obs_delta = ((p_base - y) ** 2).mean() - ((p_treat - y) ** 2).mean()
    if obs_delta <= 0: return 1.0
    count = 0
    n = len(y)
    # Swap predictions randomly: for each row, pick base or treat
    for _ in range(n_perm):
        mask = rng.integers(0, 2, n).astype(bool)
        p_a = np.where(mask, p_base, p_treat)
        p_b = np.where(mask, p_treat, p_base)
        perm_delta = ((p_a - y) ** 2).mean() - ((p_b - y) ** 2).mean()
        if abs(perm_delta) >= abs(obs_delta):
            count += 1
    return (count + 1) / (n_perm + 1)


def run_lr_cv(df):
    print("\n[4/5] Walk-forward LR (train 22/23, test 23/24)...")
    tr = df[df["season_short"] == "22/23"].copy()
    te = df[df["season_short"] == "23/24"].copy()
    print(f"  train: {len(tr):,}  test: {len(te):,}")

    if len(tr) < 100 or len(te) < 100:
        return {"error": "insufficient sample"}

    results = []
    candidate_features = [
        ("xg_diff", "starting-11 xg_per_90 sum diff"),
        ("xa_diff", "starting-11 xa_per_90 sum diff"),
        ("xg_xa_diff", "combined xg+xa diff"),
        ("sh_diff", "starting-11 shots_per_90 sum diff"),
    ]

    # Baseline LR — just Pinnacle
    X_tr_base = tr[["p_pinn_h"]].values
    X_te_base = te[["p_pinn_h"]].values
    y_tr = tr["home_win"].values
    y_te = te["home_win"].values
    lr0 = LogisticRegression()
    lr0.fit(X_tr_base, y_tr)
    p0 = lr0.predict_proba(X_te_base)[:, 1]
    brier_baseline = float(((p0 - y_te) ** 2).mean())

    print(f"\n  Baseline LR (Pinnacle only):  Brier={brier_baseline:.5f}")
    print(f"  {'Feature':<22} {'r_raw':>8} {'Brier_trt':>10} {'Brier_Δ':>10} {'coef':>7}  p-val  Verdict")
    print(f"  {'-'*22} {'-'*8} {'-'*10} {'-'*10} {'-'*7}  -----  -------")

    for feat, label in candidate_features:
        # Drop rows with NaN feature
        tr_clean = tr.dropna(subset=[feat]).copy()
        te_clean = te.dropna(subset=[feat]).copy()
        if len(tr_clean) < 100 or len(te_clean) < 100:
            print(f"  {feat:<24}  insufficient after dropna")
            continue

        # Standardize feature (helps LR convergence)
        feat_mean, feat_std = tr_clean[feat].mean(), tr_clean[feat].std()
        if feat_std == 0:
            continue
        tr_clean["f_norm"] = (tr_clean[feat] - feat_mean) / feat_std
        te_clean["f_norm"] = (te_clean[feat] - feat_mean) / feat_std

        # Raw correlation with outcome (sanity)
        r_raw, _ = pearsonr(te_clean[feat], te_clean["home_win"])

        X_tr = tr_clean[["p_pinn_h", "f_norm"]].values
        X_te = te_clean[["p_pinn_h", "f_norm"]].values
        y_tr_c = tr_clean["home_win"].values
        y_te_c = te_clean["home_win"].values

        lr1 = LogisticRegression()
        lr1.fit(X_tr, y_tr_c)
        p1 = lr1.predict_proba(X_te)[:, 1]
        brier_trt = float(((p1 - y_te_c) ** 2).mean())

        # Re-compute baseline on SAME test subset for fair comparison
        p_base_sub = lr0.predict_proba(te_clean[["p_pinn_h"]].values)[:, 1]
        brier_base_sub = float(((p_base_sub - y_te_c) ** 2).mean())
        brier_delta = brier_base_sub - brier_trt
        coef = float(lr1.coef_[0][1])

        # Permutation p-value for Brier-Δ significance
        p_val = permutation_brier_pvalue(p1, p_base_sub, y_te_c, n_perm=500)
        verdict = ("✅ SIGNAL" if brier_delta > 0.002 and p_val < 0.05
                   else "🟢 marginal" if brier_delta > 0.0005 and p_val < 0.10
                   else "🟡 weak" if brier_delta > 0
                   else "❌ NOISE/HARM")
        print(f"  {feat:<22} {r_raw:>+.4f} {brier_trt:>10.5f} {brier_delta:>+9.5f} {coef:>+6.3f}  p={p_val:.3f}  {verdict}")
        results.append({"feature": feat, "label": label,
                        "n_train": int(len(tr_clean)), "n_test": int(len(te_clean)),
                        "r_raw_test": round(float(r_raw), 4),
                        "brier_baseline": round(brier_base_sub, 5),
                        "brier_treatment": round(brier_trt, 5),
                        "brier_delta": round(brier_delta, 5),
                        "perm_p_value": round(float(p_val), 4),
                        "lr_coef": round(coef, 3),
                        "verdict": verdict})
    return {"baseline_brier_full": brier_baseline,
            "test_n_full": int(len(te)),
            "feature_results": results}


# =====================================================================
# 5. Decile residual analysis on best feature
# =====================================================================
def decile_analysis(df, best_feat):
    print(f"\n[5/5] Decile residual analysis on {best_feat}...")
    sub = df[df["season_short"] == "23/24"].dropna(subset=[best_feat, "p_pinn_h"])
    sub["decile"] = pd.qcut(sub[best_feat], 10, labels=False, duplicates="drop")
    bins = sub.groupby("decile").agg(
        n=("home_win", "count"),
        mean_feat=(best_feat, "mean"),
        y_rate=("home_win", "mean"),
        pinn_p=("p_pinn_h", "mean"),
    )
    bins["resid"] = bins["y_rate"] - bins["pinn_p"]
    print(f"  {'dec':>4} {'n':>5} {'mean_feat':>10} {'y_rate':>8} {'pinn_p':>8}  resid")
    decile_rows = []
    for d, row in bins.iterrows():
        print(f"  {int(d):>4} {int(row['n']):>5} {row['mean_feat']:>+9.3f} {row['y_rate']:8.3f} {row['pinn_p']:8.3f}  {row['resid']:+.3f}")
        decile_rows.append({"decile": int(d), "n": int(row['n']),
                            "mean_feature": round(float(row["mean_feat"]), 3),
                            "y_rate": round(float(row["y_rate"]), 3),
                            "pinn_p": round(float(row["pinn_p"]), 3),
                            "residual": round(float(row["resid"]), 3)})
    return decile_rows


# =====================================================================
# MAIN
# =====================================================================
def main():
    t0 = time.time()
    print("╔══════════════════════════════════════════════════════════════════════╗")
    print("║  Lineup-Aware MVP — EPL Understat per-match player data              ║")
    print("╚══════════════════════════════════════════════════════════════════════╝")

    player_df = build_player_features()
    match_feat = aggregate_team_features(player_df)
    joined = join_with_market(match_feat)
    cv = run_lr_cv(joined)

    # Decile analysis on best-performing feature
    if "feature_results" in cv and cv["feature_results"]:
        best = max(cv["feature_results"], key=lambda r: r["brier_delta"])
        deciles = decile_analysis(joined, best["feature"])
        cv["best_feature"] = best
        cv["best_feature_deciles"] = deciles

    cv["elapsed_s"] = round(time.time() - t0, 1)
    out = ROOT / "tools" / "v4" / "diagnostics" / "lineup_aware_mvp.json"
    out.write_text(json.dumps(cv, indent=2, default=str))
    print(f"\n✓ Report saved: {out}")

    # Final verdict
    print("\n" + "═" * 70)
    print("FINAL VERDICT")
    print("═" * 70)
    if "feature_results" in cv and cv["feature_results"]:
        best = max(cv["feature_results"], key=lambda r: r["brier_delta"])
        bd = best["brier_delta"]
        print(f"  Best feature: {best['feature']} ({best['label']})")
        print(f"  Brier-Δ:      {bd:+.5f}  (LR coef={best['lr_coef']:+.3f})")
        if bd > 0.002:
            print(f"\n  ✅ STRONG SIGNAL — expand to other Top-5 leagues + multi-season retrain")
        elif bd > 0.0005:
            print(f"\n  🟢 MARGINAL signal — worth testing on more leagues/seasons before committing")
        elif bd > 0:
            print(f"\n  🟡 WEAK — close to baseline. Likely not engine-useful.")
        else:
            print(f"\n  ❌ NO SIGNAL — lineup-aware via this aggregation does not help.")


if __name__ == "__main__":
    main()
