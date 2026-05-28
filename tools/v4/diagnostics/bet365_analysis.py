"""
bet365_analysis.py — How does v4 (dev-02-elo) perform against Bet365 closing?

Data source: football-data.co.uk CSVs in Historie/data-2526/.
  - B365CH / B365CD / B365CA = Bet365 CLOSING 1X2 odds
  - PSCH / PSCD / PSCA       = Pinnacle CLOSING (for comparison)

These are the same matches as our existing holdout — joined via fuzzy
team-name match (canonical-team mirror).

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/bet365_analysis.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import pearsonr, beta as scipy_beta

from v4.data.loaders import load_team_xg_history
from v4.modules.m3_xg import XGPredictor
from v4.modules.m6_market import BenterBlender, remove_vig
from v4.modules.m7_kelly.goldilocks import DEFAULT_LIGA_TIERS

ARTIFACTS = REPO_ROOT / "tools" / "v4" / "artifacts"
HOLDOUT = REPO_ROOT / "tools" / "backtest" / "odds-close-25-26.parquet"
FD_DIR = REPO_ROOT / "Historie" / "data-2526"
PLOT_DIR = REPO_ROOT / "tools" / "v4" / "reports"

# Map football-data.co.uk file codes → our internal league codes
FD_LEAGUE_MAP = {
    "E0": "epl",
    "E1": "championship",
    "E2": "league_one",
    "E3": "league_two",
    "D1": "bundesliga",
    "D2": "bundesliga2",
    "F1": "ligue_1",
    "F2": "ligue_2",
    "I1": "serie_a",
    "I2": "serie_b",
    "SP1": "la_liga",
    "SP2": "la_liga2",
    "N1": "eredivisie",
    "B1": "jupiler_pro",
    "P1": "primeira_liga",
    "SC0": "scottish_prem",
    "T1": "super_lig",
    "G1": "greek_sl",
}

USER_GOLDILOCKS = {
    "sharp":    (0.015, 0.050),
    "moderate": (0.015, 0.085),
    "soft":     (0.015, 0.085),
}
FALLBACK_TIER = "moderate"
SEED = 42


def _normalize_team(name: str) -> str:
    """Lowercase + strip common prefixes/suffixes for fuzzy matching."""
    if pd.isna(name):
        return ""
    s = str(name).lower().strip()
    # Strip diacritics (basic)
    replacements = {
        "ä": "a", "ö": "o", "ü": "u", "ß": "ss",
        "à": "a", "á": "a", "â": "a", "ã": "a",
        "è": "e", "é": "e", "ê": "e", "ë": "e",
        "ì": "i", "í": "i", "î": "i", "ï": "i",
        "ò": "o", "ó": "o", "ô": "o", "õ": "o",
        "ù": "u", "ú": "u", "û": "u",
        "ñ": "n", "ç": "c",
    }
    for old, new in replacements.items():
        s = s.replace(old, new)
    # Strip common prefixes
    for prefix in ["fc ", "1. fc ", "1.fc ", "sc ", "ac ", "as ", "sv ", "rb ", "vfl ",
                   "tsg ", "vfb ", "sg ", "fsv ", "bsc ", "dsc "]:
        if s.startswith(prefix):
            s = s[len(prefix):]
    # Strip common suffixes
    for suffix in [" fc", " cf", " ac", " sc", " united", " utd", " city",
                   " town", " county", " athletic", " rovers", " wanderers"]:
        if s.endswith(suffix):
            s = s[:-len(suffix)]
    s = s.strip()
    return s


def _team_match(name_a: str, name_b: str) -> bool:
    """Fuzzy match: exact normalized OR substring (≥4 chars)."""
    a = _normalize_team(name_a)
    b = _normalize_team(name_b)
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) >= 4 and a in b:
        return True
    if len(b) >= 4 and b in a:
        return True
    return False


def load_bet365_odds() -> pd.DataFrame:
    """Load all football-data.co.uk CSVs, return unified Bet365-odds table."""
    print("=" * 78)
    print("Step 0a — Load Bet365 closing odds from football-data.co.uk")
    print("=" * 78)

    all_rows = []
    fd_files = sorted(FD_DIR.glob("*.csv"))
    print(f"  Found {len(fd_files)} CSV files in {FD_DIR.relative_to(REPO_ROOT)}/")

    for csv_path in fd_files:
        code = csv_path.stem
        liga = FD_LEAGUE_MAP.get(code)
        if liga is None:
            print(f"    skip {code} (no league mapping)")
            continue
        try:
            df = pd.read_csv(csv_path)
        except Exception as e:
            print(f"    skip {code}: {e}")
            continue
        required = {"Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG",
                    "B365CH", "B365CD", "B365CA", "PSCH", "PSCD", "PSCA"}
        missing = required - set(df.columns)
        if missing:
            # fallback: use opening Bet365 if closing missing
            if "B365H" in df.columns and "B365CH" not in df.columns:
                df["B365CH"] = df["B365H"]
                df["B365CD"] = df["B365D"]
                df["B365CA"] = df["B365A"]
                print(f"    {code} ({liga}): using OPENING B365 (closing not in file)")
            else:
                print(f"    skip {code}: missing {missing}")
                continue
        df["league"] = liga
        df["match_date"] = pd.to_datetime(df["Date"], dayfirst=True)
        # Drop rows missing Bet365 closing
        df = df.dropna(subset=["B365CH", "B365CD", "B365CA",
                                "FTHG", "FTAG"])
        keep = df[["league", "match_date", "HomeTeam", "AwayTeam",
                   "FTHG", "FTAG",
                   "B365CH", "B365CD", "B365CA",
                   "PSCH", "PSCD", "PSCA"]].copy()
        all_rows.append(keep)
        print(f"    {code} → {liga}: {len(keep)} matches, dates "
              f"{keep['match_date'].min().date()} → {keep['match_date'].max().date()}")

    df_b365 = pd.concat(all_rows, ignore_index=True)
    print(f"\n  Total Bet365 closing-odds rows: {len(df_b365):,} across "
          f"{df_b365['league'].nunique()} leagues")
    return df_b365


def join_with_holdout(df_b365: pd.DataFrame, df_holdout: pd.DataFrame) -> pd.DataFrame:
    """Inner-join Bet365 odds with holdout via fuzzy team-name match.

    Returns df with columns: league, match_date, home_team, away_team,
    decimal_odds_bet365_{H,D,A}, decimal_odds_pinnacle_{H,D,A},
    ft_goals_h, ft_goals_a, and the original holdout match-key.
    """
    print()
    print("=" * 78)
    print("Step 0b — Join Bet365 odds with holdout (fuzzy team match)")
    print("=" * 78)
    rows = []
    misses = []
    # Index Bet365 by league + month for fast lookup
    df_b365 = df_b365.copy()
    df_b365["month_key"] = df_b365["match_date"].dt.to_period("M").astype(str)

    holdout_by_month = df_holdout.copy()
    holdout_by_month["month_key"] = holdout_by_month["match_date"].dt.to_period("M").astype(str)

    for i, h in holdout_by_month.iterrows():
        candidates = df_b365[(df_b365["league"] == h["league"])
                             & (df_b365["month_key"] == h["month_key"])]
        if len(candidates) == 0:
            continue
        # Find Bet365 row where teams match (any order)
        best_match = None
        for _, c in candidates.iterrows():
            if _team_match(h["home_team"], c["HomeTeam"]) and \
               _team_match(h["away_team"], c["AwayTeam"]):
                # Also require same calendar date (within 2 days slop)
                if abs((c["match_date"] - h["match_date"]).days) <= 2:
                    best_match = c
                    break
        if best_match is None:
            misses.append((h["league"], h["home_team"], h["away_team"],
                          h["match_date"].date()))
            continue
        rows.append({
            "league": h["league"],
            "match_date": h["match_date"],
            "home_team": h["home_team"],
            "away_team": h["away_team"],
            "b365_h": float(best_match["B365CH"]),
            "b365_d": float(best_match["B365CD"]),
            "b365_a": float(best_match["B365CA"]),
            "psc_h": float(best_match["PSCH"]),
            "psc_d": float(best_match["PSCD"]),
            "psc_a": float(best_match["PSCA"]),
            "ft_goals_h": int(best_match["FTHG"]),
            "ft_goals_a": int(best_match["FTAG"]),
        })

    df_joined = pd.DataFrame(rows)
    cov = len(df_joined) / len(df_holdout) * 100
    print(f"  Joined: {len(df_joined):,} of {len(df_holdout):,} holdout matches "
          f"({cov:.1f}% coverage)")
    print(f"  Misses: {len(misses):,}")
    if misses[:5]:
        print(f"  Sample misses:")
        for liga, ht, at, dt in misses[:5]:
            print(f"    {liga} {dt}: {ht} vs {at}")
    return df_joined


def _outcome_label(h: float, a: float) -> str:
    if h > a: return "H"
    if h < a: return "A"
    return "D"


def _clopper_pearson(k: int, n: int, alpha: float = 0.05) -> Tuple[float, float]:
    if n == 0: return 0.0, 1.0
    lo = scipy_beta.ppf(alpha/2, k, n-k+1) if k > 0 else 0.0
    hi = scipy_beta.ppf(1-alpha/2, k+1, n-k) if k < n else 1.0
    return float(lo), float(hi)


def _bootstrap_roi_ci(profits: np.ndarray, stakes: np.ndarray,
                     n_resamples: int = 1000) -> Tuple[float, float, float]:
    rng = np.random.default_rng(SEED)
    n = len(profits)
    if n == 0: return 0.0, 0.0, 0.0
    boot = np.empty(n_resamples)
    for r in range(n_resamples):
        idx = rng.integers(0, n, size=n)
        s = stakes[idx].sum()
        boot[r] = profits[idx].sum() / s if s > 0 else 0.0
    return (float(np.percentile(boot, 2.5)),
            float(np.percentile(boot, 50)),
            float(np.percentile(boot, 97.5)))


def build_diagnostic_df(df_joined: pd.DataFrame) -> pd.DataFrame:
    """Run v4 dev-02-elo on joined matches, build per-outcome decision rows
    with both Bet365 and Pinnacle edges."""
    print()
    print("=" * 78)
    print("Step 0c — Generate v4 dev-02-elo predictions on joined matches")
    print("=" * 78)
    pred = XGPredictor.from_artifacts(
        home_path=ARTIFACTS / "m3_xg-home-dev-02-elo.pkl",
        away_path=ARTIFACTS / "m3_xg-away-dev-02-elo.pkl",
    )
    blender = BenterBlender.load(ARTIFACTS / "m6_benter-dev-02-elo.pkl")
    history = load_team_xg_history()
    match_pairs = df_joined[["league", "match_date", "home_team", "away_team"]].rename(
        columns={"home_team": "home", "away_team": "away"}
    )
    t0 = time.time()
    preds = pred.predict_batch(match_pairs, history)
    print(f"  Predicted in {time.time()-t0:.1f}s")

    # Blend
    model = preds[["prob_h", "prob_d", "prob_a"]].values
    model = model / model.sum(axis=1, keepdims=True)
    pinn_arr = df_joined[["psc_h", "psc_d", "psc_a"]].values
    b365_arr = df_joined[["b365_h", "b365_d", "b365_a"]].values
    market_pinn = np.array([remove_vig(o, method="shin") for o in pinn_arr])
    market_b365 = np.array([remove_vig(o, method="shin") for o in b365_arr])

    blend = np.zeros_like(model)
    for liga in df_joined["league"].unique():
        m = df_joined["league"].values == liga
        blend[m] = blender.blend(model[m], market_pinn[m], liga)

    rows = []
    for i, row in df_joined.iterrows():
        actual = _outcome_label(row["ft_goals_h"], row["ft_goals_a"])
        tier = DEFAULT_LIGA_TIERS.get(row["league"], FALLBACK_TIER)
        for outcome_idx, (label, b365_col, psc_col) in enumerate([
            ("H", "b365_h", "psc_h"),
            ("D", "b365_d", "psc_d"),
            ("A", "b365_a", "psc_a"),
        ]):
            p = float(blend[i, outcome_idx])
            o_b365 = float(row[b365_col])
            o_pinn = float(row[psc_col])
            p_mk_b365 = float(market_b365[i, outcome_idx])
            p_mk_pinn = float(market_pinn[i, outcome_idx])
            won = (actual == label)
            edge_b365 = p * o_b365 - 1.0
            edge_pinn = p * o_pinn - 1.0
            rows.append({
                "match_date": row["match_date"],
                "league": row["league"],
                "tier": tier,
                "outcome_label": label,
                "p_blended": p,
                "decimal_odds_bet365": o_b365,
                "decimal_odds_pinnacle": o_pinn,
                "p_implied_bet365": p_mk_b365,
                "p_implied_pinnacle": p_mk_pinn,
                "edge_bet365": edge_b365,
                "edge_pinnacle": edge_pinn,
                "won": 1 if won else 0,
            })
    df = pd.DataFrame(rows)
    print(f"  Built df: {len(df):,} (match, outcome) decisions")
    # Edge stats
    print(f"\n  Edge distribution (positive-edge only):")
    pos_b = df[df["edge_bet365"] > 0]
    pos_p = df[df["edge_pinnacle"] > 0]
    print(f"    Bet365 positive-edge:   n={len(pos_b):,}  mean={pos_b['edge_bet365'].mean()*100:.2f}%")
    print(f"    Pinnacle positive-edge: n={len(pos_p):,}  mean={pos_p['edge_pinnacle'].mean()*100:.2f}%")
    return df


# ──────────────────────────────────────────────────────────────────────
# 1. Edge vs Realized ROI with bootstrap bands
# ──────────────────────────────────────────────────────────────────────

KELLY_CAP = 0.04


def _kelly_stake(edge: float, odds: float) -> float:
    return min(edge / (odds - 1.0), KELLY_CAP) if edge > 0 else 0.0


def analysis_1(df: pd.DataFrame) -> Dict:
    print()
    print("=" * 78)
    print("Analysis 1 — Edge_Bet365 vs Realized ROI (95% bootstrap bands)")
    print("=" * 78)

    # Decision rule: bet on any outcome with edge_bet365 > 0
    # (we'll later filter by Goldilocks)
    pos = df[df["edge_bet365"] > 0].reset_index(drop=True).copy()
    pos["stake"] = pos.apply(
        lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"]), axis=1
    )
    pos["profit"] = np.where(
        pos["won"] == 1,
        pos["stake"] * (pos["decimal_odds_bet365"] - 1.0),
        -pos["stake"],
    )
    n_pos = len(pos)
    overall_roi = pos["profit"].sum() / pos["stake"].sum() if pos["stake"].sum() > 0 else 0
    overall_ci_lo, overall_ci_med, overall_ci_hi = _bootstrap_roi_ci(
        pos["profit"].values, pos["stake"].values, n_resamples=1000)
    print(f"\n  All positive-edge Bet365 bets: n={n_pos:,}")
    print(f"  Overall ROI: {overall_roi*100:+.2f}%   95% CI: "
          f"[{overall_ci_lo*100:+.2f}%, {overall_ci_med*100:+.2f}%, {overall_ci_hi*100:+.2f}%]")

    # 0.5%-wide bins from 0 to 10%
    edge_bins = np.linspace(0.0, 0.10, 21)
    bin_centers = (edge_bins[:-1] + edge_bins[1:]) / 2

    rng = np.random.default_rng(SEED)
    point_roi = np.full(len(edge_bins) - 1, np.nan)
    ci_lo = np.full(len(edge_bins) - 1, np.nan)
    ci_hi = np.full(len(edge_bins) - 1, np.nan)
    bin_n = np.zeros(len(edge_bins) - 1, dtype=int)

    for i in range(len(edge_bins) - 1):
        mask = (pos["edge_bet365"].values >= edge_bins[i]) & \
               (pos["edge_bet365"].values < edge_bins[i + 1])
        n = int(mask.sum())
        bin_n[i] = n
        if n < 10: continue
        stakes = pos["stake"].values[mask]
        profits = pos["profit"].values[mask]
        s_tot = stakes.sum()
        if s_tot <= 0: continue
        point_roi[i] = profits.sum() / s_tot
        boot = np.empty(1000)
        for r in range(1000):
            idx = rng.integers(0, n, size=n)
            sb = stakes[idx].sum()
            boot[r] = profits[idx].sum() / sb if sb > 0 else 0.0
        ci_lo[i] = np.percentile(boot, 2.5)
        ci_hi[i] = np.percentile(boot, 97.5)

    # Find crossover (where 95% lower band first turns negative)
    crossover = float("nan")
    for i in range(len(bin_centers)):
        if not np.isnan(ci_lo[i]) and ci_lo[i] < 0:
            crossover = float(bin_centers[i])
            break
    print(f"\n  Edge bins (0.5% wide):")
    print(f"  {'edge_center':>12}  {'n':>4}  {'roi%':>7}  {'ci_lo%':>8}  {'ci_hi%':>8}")
    for i, c in enumerate(bin_centers):
        if bin_n[i] < 10: continue
        print(f"  {c*100:>+12.2f}  {bin_n[i]:>4}  {point_roi[i]*100:>+7.2f}  "
              f"{ci_lo[i]*100:>+8.2f}  {ci_hi[i]*100:>+8.2f}")
    print(f"\n  Crossover (lower CI first negative): {crossover*100:+.2f}%")

    # Plot
    fig, ax = plt.subplots(figsize=(12, 6.5))
    valid = ~np.isnan(point_roi)
    ax.plot(bin_centers[valid] * 100, point_roi[valid] * 100, "o-",
            color="tab:blue", label="Bet365 Realized ROI", linewidth=2, markersize=7)
    ax.fill_between(bin_centers[valid] * 100, ci_lo[valid] * 100, ci_hi[valid] * 100,
                    color="tab:blue", alpha=0.20, label="95% bootstrap band")
    ax.axhline(0, color="black", alpha=0.5, linewidth=0.7)
    ax.axvline(crossover * 100, color="red", linestyle="--",
               label=f"Crossover {crossover*100:+.2f}%")
    ax.axvline(1.5, color="orange", linestyle=":",
               label="Current Goldilocks min (1.5%)")
    ax.set_xlabel("Edge (p_v4 × Bet365_odds − 1), %")
    ax.set_ylabel("Realized ROI, %")
    ax.set_title(f"Edge_Bet365 vs Realized ROI (95% bootstrap bands, 1000 resamples)\n"
                 f"v4 dev-02-elo predictions × Bet365 closing odds (n={n_pos:,} positive-edge decisions)")
    ax.legend(loc="lower left")
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plot_path = PLOT_DIR / "bet365_edge_roi.png"
    plt.savefig(plot_path, dpi=130)
    plt.close()
    print(f"\n  Plot saved: {plot_path.relative_to(REPO_ROOT)}")

    return {"crossover": crossover, "n_pos": n_pos, "overall_roi": overall_roi,
            "ci_lo": overall_ci_lo, "ci_med": overall_ci_med, "ci_hi": overall_ci_hi,
            "bin_centers": bin_centers.tolist(),
            "point_roi": point_roi.tolist(),
            "ci_lo_arr": ci_lo.tolist(), "ci_hi_arr": ci_hi.tolist()}


# ──────────────────────────────────────────────────────────────────────
# 2. Market-Disagreement vs Profit on Bet365
# ──────────────────────────────────────────────────────────────────────

def analysis_2(df: pd.DataFrame) -> Dict:
    print()
    print("=" * 78)
    print("Analysis 2 — Market disagreement vs profit (Bet365)")
    print("=" * 78)
    pos = df[df["edge_bet365"] > 0].reset_index(drop=True).copy()
    pos["disagree"] = (pos["p_blended"] - pos["p_implied_bet365"]).abs()
    pos["profit_per_unit"] = np.where(
        pos["won"] == 1, pos["decimal_odds_bet365"] - 1.0, -1.0)

    groups = {
        "edge < 1.0%":      pos[pos["edge_bet365"] < 0.01],
        "edge 1.0–2.0%":    pos[(pos["edge_bet365"] >= 0.01) & (pos["edge_bet365"] < 0.02)],
        "edge > 2.0%":      pos[pos["edge_bet365"] >= 0.02],
        "edge ≥ 1.5%":      pos[pos["edge_bet365"] >= 0.015],
    }
    print(f"\n  Correlation: |p_v4 − p_implied_bet365| vs profit-per-unit-stake")
    print(f"  {'group':<18}  {'n':>4}  {'corr':>8}  {'p-value':>9}  "
          f"{'avg_disag':>10}  {'roi%':>7}")
    results = {}
    for name, sub in groups.items():
        n = len(sub)
        if n < 20: continue
        c, pv = pearsonr(sub["disagree"].values, sub["profit_per_unit"].values)
        avg_d = float(sub["disagree"].mean())
        roi = (sub.apply(lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"])
                         * (r["decimal_odds_bet365"] - 1 if r["won"] else -1), axis=1).sum()
               / sub.apply(lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"]),
                          axis=1).sum())
        print(f"  {name:<18}  {n:>4}  {c:>+8.4f}  {pv:>9.4f}  "
              f"{avg_d:>10.4f}  {roi*100:>+7.2f}")
        results[name] = {"n": n, "corr": float(c), "p_value": float(pv),
                        "avg_disagree": avg_d, "roi": float(roi)}
    return {"groups": results}


# ──────────────────────────────────────────────────────────────────────
# 3. Crossover via rolling-mean (27-bet window)
# ──────────────────────────────────────────────────────────────────────

def analysis_3(df: pd.DataFrame) -> Dict:
    print()
    print("=" * 78)
    print("Analysis 3 — Rolling-mean crossover (27-bet window)")
    print("=" * 78)
    pos = df[df["edge_bet365"] > 0].reset_index(drop=True).copy()
    pos["profit_per_unit"] = np.where(
        pos["won"] == 1, pos["decimal_odds_bet365"] - 1.0, -1.0)
    sorted_pos = pos.sort_values("edge_bet365").reset_index(drop=True)
    window = 27
    sorted_pos["roll"] = sorted_pos["profit_per_unit"].rolling(
        window=window, center=True, min_periods=window // 2).mean()

    # Find first systematically-negative point (next 50 rows mean < -0.05)
    cross = float("nan")
    valid = sorted_pos.dropna(subset=["roll"]).reset_index(drop=True)
    for i in range(len(valid)):
        nxt = valid["roll"].iloc[i:i+50]
        if len(nxt) >= 30 and nxt.mean() < -0.05:
            cross = float(valid["edge_bet365"].iloc[i])
            break
    print(f"  Rolling-mean ({window}-bet window) first systematically-neg edge: "
          f"{cross*100:+.2f}%" if not np.isnan(cross) else "  No systematic neg crossover detected")
    return {"crossover": cross, "window": window}


# ──────────────────────────────────────────────────────────────────────
# 4. Per-tier crossover on Bet365
# ──────────────────────────────────────────────────────────────────────

def _find_tier_crossover(sub: pd.DataFrame) -> float:
    if len(sub) < 50: return float("nan")
    edge_bins = np.linspace(0, 0.10, 21)
    centers = (edge_bins[:-1] + edge_bins[1:]) / 2
    sub = sub.copy()
    sub["stake"] = sub.apply(
        lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"]), axis=1)
    sub["profit"] = np.where(sub["won"] == 1,
                              sub["stake"] * (sub["decimal_odds_bet365"] - 1.0),
                              -sub["stake"])
    rng = np.random.default_rng(SEED)
    for i in range(len(centers)):
        mask = (sub["edge_bet365"].values >= edge_bins[i]) & \
               (sub["edge_bet365"].values < edge_bins[i+1])
        n = int(mask.sum())
        if n < 10: continue
        stakes = sub["stake"].values[mask]
        profits = sub["profit"].values[mask]
        s = stakes.sum()
        if s <= 0: continue
        boot = np.empty(500)
        for r in range(500):
            idx = rng.integers(0, n, size=n)
            sb = stakes[idx].sum()
            boot[r] = profits[idx].sum() / sb if sb > 0 else 0
        if np.percentile(boot, 2.5) < 0:
            return float(centers[i])
    return float("nan")


def analysis_4(df: pd.DataFrame) -> Dict:
    print()
    print("=" * 78)
    print("Analysis 4 — Per-tier crossover (Bet365)")
    print("=" * 78)
    pos = df[df["edge_bet365"] > 0].reset_index(drop=True)
    print(f"\n  {'tier':<10}  {'n_pos':>5}  {'ROI@>0.5%':>10}  {'ROI@>1.5%':>10}  {'crossover':>10}")
    results = {}
    for tier in ["sharp", "moderate", "soft"]:
        sub = pos[pos["tier"] == tier]
        n = len(sub)
        if n < 20:
            print(f"  {tier:<10}  {n:>5}  (insufficient)")
            continue
        sub5 = sub[sub["edge_bet365"] >= 0.005].copy()
        sub5["stake"] = sub5.apply(
            lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"]), axis=1)
        sub5["profit"] = np.where(sub5["won"] == 1,
                                   sub5["stake"]*(sub5["decimal_odds_bet365"]-1),
                                   -sub5["stake"])
        roi5 = sub5["profit"].sum()/sub5["stake"].sum() if sub5["stake"].sum()>0 else 0
        sub15 = sub[sub["edge_bet365"] >= 0.015].copy()
        sub15["stake"] = sub15.apply(
            lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"]), axis=1)
        sub15["profit"] = np.where(sub15["won"] == 1,
                                    sub15["stake"]*(sub15["decimal_odds_bet365"]-1),
                                    -sub15["stake"])
        roi15 = sub15["profit"].sum()/sub15["stake"].sum() if sub15["stake"].sum()>0 else 0
        cx = _find_tier_crossover(sub)
        cx_str = f"{cx*100:+.2f}%" if not np.isnan(cx) else "n/a"
        print(f"  {tier:<10}  {n:>5}  {roi5*100:>+10.2f}%  {roi15*100:>+10.2f}%  {cx_str:>10}")
        results[tier] = {"n": n, "roi_at_05": roi5, "roi_at_15": roi15,
                        "crossover": cx}
    return {"tier_results": results}


# ──────────────────────────────────────────────────────────────────────
# 5. Direct Bet365 vs Pinnacle comparison
# ──────────────────────────────────────────────────────────────────────

def analysis_5(df: pd.DataFrame) -> Dict:
    print()
    print("=" * 78)
    print("Analysis 5 — Pinnacle vs Bet365 ROI head-to-head")
    print("=" * 78)
    # Per outcome where BOTH markets have positive edge, compare profit
    both_pos = df[(df["edge_bet365"] > 0) | (df["edge_pinnacle"] > 0)].copy()
    print(f"\n  Decisions with positive edge on Bet365 OR Pinnacle: {len(both_pos):,}")

    # Compare odds: which book offers HIGHER odds on average (bettor-friendly)?
    pos_either = df[(df["edge_bet365"] > 0) & (df["edge_pinnacle"] > 0)]
    if len(pos_either):
        avg_b365 = pos_either["decimal_odds_bet365"].mean()
        avg_pinn = pos_either["decimal_odds_pinnacle"].mean()
        print(f"  Avg odds on overlapping positive-edge bets (n={len(pos_either):,}):")
        print(f"    Bet365:   {avg_b365:.3f}")
        print(f"    Pinnacle: {avg_pinn:.3f}")
        print(f"    Δ:        {avg_b365 - avg_pinn:+.4f}   "
              f"({'Bet365 higher (better for bettor)' if avg_b365 > avg_pinn else 'Pinnacle higher'})")

    # Bin by edge_bet365 size, compute ROI on Bet365 odds vs Pinnacle odds
    # over the SAME bet set (entry rule = edge_bet365 ≥ X)
    entry_rules = [0.005, 0.010, 0.015, 0.020, 0.025, 0.030]
    print(f"\n  ROI comparison — bet only when edge_bet365 ≥ X, settle at both books:")
    print(f"  {'entry':<10}  {'n':>4}  {'ROI_B365':>9}  {'CI_B365':>22}  {'ROI_Pinn':>9}  "
          f"{'Δ_B365−Pinn':>12}")
    rng = np.random.default_rng(SEED)
    results = {}
    for X in entry_rules:
        sub = df[df["edge_bet365"] >= X].copy()
        n = len(sub)
        if n < 30:
            print(f"  ≥{X*100:.2f}%      {n:>4}  (insufficient)")
            continue
        # Stake = Kelly with Bet365 edge + odds
        sub["stake"] = sub.apply(
            lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"]), axis=1)
        sub["profit_b365"] = np.where(sub["won"] == 1,
                                       sub["stake"] * (sub["decimal_odds_bet365"] - 1.0),
                                       -sub["stake"])
        # Same bets but settled at Pinnacle odds (counter-factual)
        sub["profit_pinn"] = np.where(sub["won"] == 1,
                                       sub["stake"] * (sub["decimal_odds_pinnacle"] - 1.0),
                                       -sub["stake"])
        s = sub["stake"].sum()
        roi_b = sub["profit_b365"].sum() / s
        roi_p = sub["profit_pinn"].sum() / s
        # Bootstrap CI for Bet365 ROI
        boot = np.empty(1000)
        for r in range(1000):
            idx = rng.integers(0, n, size=n)
            sb = sub["stake"].values[idx].sum()
            boot[r] = sub["profit_b365"].values[idx].sum() / sb if sb > 0 else 0
        ci_lo = np.percentile(boot, 2.5)
        ci_hi = np.percentile(boot, 97.5)
        ci_str = f"[{ci_lo*100:+.2f}, {ci_hi*100:+.2f}]"
        print(f"  ≥{X*100:.2f}%      {n:>4}  {roi_b*100:>+9.2f}  {ci_str:>22}  "
              f"{roi_p*100:>+9.2f}  {(roi_b-roi_p)*100:>+12.2f}")
        results[f">={X*100:.2f}%"] = {
            "n": n, "roi_b365": float(roi_b), "roi_pinn": float(roi_p),
            "ci_lo": float(ci_lo), "ci_hi": float(ci_hi),
            "delta": float(roi_b - roi_p),
        }

    # Compare proposed new Goldilocks (0.8–2.5%) to current (1.5–5%)
    print(f"\n  Goldilocks comparison on Bet365:")
    for label, lo, hi in [("Current (≥1.5%, ≤5.0%)", 0.015, 0.050),
                          ("Proposed (0.8–2.5%)",    0.008, 0.025),
                          ("Tight (1.0–2.0%)",       0.010, 0.020),
                          ("Loose (0.5–3.0%)",       0.005, 0.030)]:
        sub = df[(df["edge_bet365"] >= lo) & (df["edge_bet365"] <= hi)].copy()
        n = len(sub)
        if n < 30:
            print(f"  {label:<30}  n={n}, insufficient")
            continue
        sub["stake"] = sub.apply(
            lambda r: _kelly_stake(r["edge_bet365"], r["decimal_odds_bet365"]), axis=1)
        sub["profit"] = np.where(sub["won"] == 1,
                                  sub["stake"] * (sub["decimal_odds_bet365"] - 1.0),
                                  -sub["stake"])
        s = sub["stake"].sum()
        roi = sub["profit"].sum() / s if s > 0 else 0
        win = float(sub["won"].mean())
        ci_lo, ci_med, ci_hi = _bootstrap_roi_ci(
            sub["profit"].values, sub["stake"].values, n_resamples=1000)
        print(f"  {label:<30}  n={n:>4}  win={win:.3f}  ROI={roi*100:+.2f}%  "
              f"CI=[{ci_lo*100:+.2f}, {ci_hi*100:+.2f}]")
        results[label] = {"n": n, "win": win, "roi": float(roi),
                         "ci_lo": float(ci_lo), "ci_hi": float(ci_hi)}
    return results


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────

def main() -> int:
    df_b365 = load_bet365_odds()

    # Load existing holdout
    df_holdout = pd.read_parquet(HOLDOUT)
    df_holdout["match_date"] = pd.to_datetime(df_holdout["match_date"])
    df_holdout = df_holdout.dropna(subset=["ft_goals_h", "ft_goals_a",
                                            "psch", "pscd", "psca"]).reset_index(drop=True)

    df_joined = join_with_holdout(df_b365, df_holdout)
    if len(df_joined) < 200:
        print(f"✗ Insufficient join coverage: {len(df_joined)} matches")
        return 1

    df = build_diagnostic_df(df_joined)
    a1 = analysis_1(df)
    a2 = analysis_2(df)
    a3 = analysis_3(df)
    a4 = analysis_4(df)
    a5 = analysis_5(df)

    # Final summary
    print()
    print("=" * 78)
    print("FINAL SUMMARY — Bet365 deployment analysis")
    print("=" * 78)
    print(f"\n  Bet365 closing odds coverage: {len(df_joined):,} matches "
          f"({len(df_joined)/len(df_holdout)*100:.1f}% of 25/26 holdout)")
    print(f"  Positive-edge decisions on Bet365: {a1['n_pos']:,}")
    print(f"\n  Bet365 Crossover (95% CI lower-band first negative): "
          f"{a1['crossover']*100:+.2f}%")
    print(f"  Bet365 Crossover (rolling-mean systematic-neg): "
          f"{a3['crossover']*100:+.2f}%" if not np.isnan(a3['crossover']) else "n/a")
    print(f"\n  Overall ROI on Bet365 with all positive-edge bets:")
    print(f"    Point: {a1['overall_roi']*100:+.2f}%")
    print(f"    95% CI: [{a1['ci_lo']*100:+.2f}%, {a1['ci_med']*100:+.2f}%, {a1['ci_hi']*100:+.2f}%]")

    sharp_cx = a4["tier_results"].get("sharp", {}).get("crossover", float("nan"))
    mod_cx = a4["tier_results"].get("moderate", {}).get("crossover", float("nan"))
    print(f"\n  Tier crossovers:")
    print(f"    sharp:    {sharp_cx*100:+.2f}%" if not np.isnan(sharp_cx) else "    sharp: n/a")
    print(f"    moderate: {mod_cx*100:+.2f}%" if not np.isnan(mod_cx) else "    moderate: n/a")

    # Final ja/no recommendation
    print()
    print("=" * 78)
    print("Final recommendation: Lohnt sich Bet365-Deployment mit aktuellem Modell?")
    print("=" * 78)

    # Decision logic
    overall_significant_positive = a1["ci_lo"] > 0
    overall_point_positive = a1["overall_roi"] > 0
    crossover_after_15 = (not np.isnan(a1["crossover"]) and a1["crossover"] >= 0.015) or \
                        np.isnan(a1["crossover"])
    print()
    if overall_significant_positive:
        print(f"  ✅ JA — Bet365 deployment empfohlen")
        print(f"     Overall ROI 95% CI lower-bound = {a1['ci_lo']*100:+.2f}% > 0")
    elif overall_point_positive and crossover_after_15:
        print(f"  🟡 BEDINGT JA — Punkt-ROI positiv ({a1['overall_roi']*100:+.2f}%), "
              f"aber CI nicht signifikant")
        print(f"     CI: [{a1['ci_lo']*100:+.2f}%, {a1['ci_hi']*100:+.2f}%]")
        print(f"     Conservative empfehlung: nur deployment unter strenger Beobachtung")
    elif a1["overall_roi"] > -0.01 and not np.isnan(a1["crossover"]) and a1["crossover"] > 0.025:
        print(f"  🟡 BEDINGT JA mit angepasstem Goldilocks — Punkt-ROI nahe Null aber Crossover spät")
        print(f"     Crossover bei {a1['crossover']*100:.2f}% → tight Goldilocks [1.0%, 2.5%] testen")
    else:
        print(f"  ❌ NEIN — Bet365 deployment nicht empfohlen mit aktuellem Modell")
        print(f"     Overall ROI {a1['overall_roi']*100:+.2f}%, "
              f"CI lower {a1['ci_lo']*100:+.2f}%")
        print(f"     Reasoning: Selbst mit Bet365 (softer als Pinnacle) hat das Modell")
        print(f"     keinen statistisch signifikanten Edge.")

    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
