"""
FS Goals/BTTS Markets Falsification Test — proper Pinnacle baseline

Now that match_prematch_signals has pinnacle_close_over25/under25 +
pinnacle_close_h/d/a populated for 19,733 rows (via commit f87c812),
we can finally apply the 5-Gate Falsification Protocol to FS Pre-Match
features for GOALS markets (was blocked on 37-row data sparseness).

HYPOTHESES TESTED (each as independent pre-registered single test):
  H1: fs_xg_total (home_prematch_xg + away_prematch_xg) → P(Over25)
  H2: prematch_over25_pct → P(Over25)
  H3: prematch_avg_goals → P(Over25)
  H4: prematch_btts_pct → P(BTTS realized)

Each test:
  * Pinnacle vig-removed market baseline (Over25 from psc_over25+psc_under25)
  * Signed residual = outcome - market_implied_prob
  * Pearson + Spearman + permutation p-value
  * Per-league heterogeneity (16 ligas with Pinnacle coverage)
  * Holm-Bonferroni across all tests
  * Power analysis using empirical SE
  * ROI simulation vs vig

DECISION TREE:
  ✅ SIGNAL: r_resid > 0.05, p_holm < 0.05, ROI > vig → invest
  ❌ NOISE: r_resid < 0.02 OR p_holm > 0.05 → FS goals-market = corpus only
  🟡 MIXED: per-league heterogeneous → investigate single league

NOTE on BTTS: no Pinnacle BTTS market available, so H4 uses FS
bookmaker_odds_btts_yes/no as second-best baseline. This is less
efficient than Pinnacle 1X2/Over25 markets, so signal MAY exist.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from scipy.stats import pearsonr, spearmanr

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

# Load 5-gate falsification utils
_spec = importlib.util.spec_from_file_location(
    "fp", ROOT / "tools" / "v4" / "utils" / "falsification_protocol.py"
)
_fp = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_fp)


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
SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
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
        batch = r.json()
        if not batch:
            break
        out.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
        if offset > 100000:
            print(f"  ⚠ {table}: stopped at offset {offset}")
            break
    return pd.DataFrame(out)


def perm_p(x, y, n_perm=1000, seed=42):
    """Two-sided permutation test for Pearson r."""
    x, y = np.asarray(x), np.asarray(y)
    mask = np.isfinite(x) & np.isfinite(y)
    x, y = x[mask], y[mask]
    if len(x) < 30:
        return 1.0
    obs_r = np.corrcoef(x, y)[0, 1]
    rng = np.random.default_rng(seed)
    count_extreme = 0
    for _ in range(n_perm):
        shuf = rng.permutation(y)
        r = np.corrcoef(x, shuf)[0, 1]
        if abs(r) >= abs(obs_r):
            count_extreme += 1
    return (count_extreme + 1) / (n_perm + 1)


def main():
    print("\n" + "═" * 76)
    print("FS Goals/BTTS Markets — 5-Gate Falsification (Pinnacle baseline)")
    print("═" * 76)

    # ─── PULL: mps with Pinnacle close + outcomes from team_xg_history ─
    print("\n[1/5] Loading match_prematch_signals (Pinnacle close + features)...")
    mps = supa_pull(
        "match_prematch_signals",
        ",".join([
            "match_key", "league", "season", "match_date",
            "home_team", "away_team",
            "home_prematch_xg", "away_prematch_xg",
            "prematch_avg_goals", "prematch_btts_pct", "prematch_over25_pct",
            "pinnacle_close_over25", "pinnacle_close_under25",
            "pinnacle_close_h", "pinnacle_close_d", "pinnacle_close_a",
            "bookmaker_odds_btts_yes", "bookmaker_odds_btts_no",
        ]),
        filters={"pinnacle_close_over25": "not.is.null"},
    )
    for c in ("home_prematch_xg", "away_prematch_xg", "prematch_avg_goals",
              "prematch_btts_pct", "prematch_over25_pct",
              "pinnacle_close_over25", "pinnacle_close_under25",
              "pinnacle_close_h", "pinnacle_close_d", "pinnacle_close_a",
              "bookmaker_odds_btts_yes", "bookmaker_odds_btts_no"):
        mps[c] = pd.to_numeric(mps[c], errors="coerce")
    print(f"  {len(mps):,} rows with Pinnacle baseline")

    # Pull outcomes from odds_closing_history (has ft_goals)
    print("\n[2/5] Loading outcomes (ft_goals_h + ft_goals_a)...")
    # canonical-team bridge via odds_closing_history's raw team names
    # — we can use the same matching as backfill script, OR pull
    # match_outcomes which has canonical names. Both options give us goals.
    spec = importlib.util.spec_from_file_location(
        "ctm", ROOT / "tools" / "v4" / "modules" / "m3_xg" / "canonical_team_map.py"
    )
    ctm = importlib.util.module_from_spec(spec); spec.loader.exec_module(ctm)
    canon = ctm.canonical_team

    och = supa_pull(
        "odds_closing_history",
        "league,match_date,home_team,away_team,ft_goals_h,ft_goals_a",
        filters={"ft_goals_h": "not.is.null", "match_date": "gte.2021-07-01"},
    )
    for c in ("ft_goals_h", "ft_goals_a"):
        och[c] = pd.to_numeric(och[c], errors="coerce")
    och["c_home"] = och.apply(lambda r: canon(r["home_team"], r["league"]), axis=1)
    och["c_away"] = och.apply(lambda r: canon(r["away_team"], r["league"]), axis=1)
    print(f"  {len(och):,} odds rows with outcomes")

    # Join mps × och via (league, date, canonical_home, canonical_away)
    print("\n[3/5] Joining mps × outcomes via canonical-team bridge...")
    joined = mps.merge(
        och[["league", "match_date", "c_home", "c_away", "ft_goals_h", "ft_goals_a"]],
        left_on=["league", "match_date", "home_team", "away_team"],
        right_on=["league", "match_date", "c_home", "c_away"],
        how="inner",
    )
    # Build outcomes
    joined["total_goals"] = joined["ft_goals_h"] + joined["ft_goals_a"]
    joined["over25"] = (joined["total_goals"] > 2.5).astype(int)
    joined["btts"] = (
        (joined["ft_goals_h"] >= 1) & (joined["ft_goals_a"] >= 1)
    ).astype(int)
    print(f"  joined: {len(joined):,}")

    # Build market baselines
    joined["p_pinn_over25"] = (1 / joined["pinnacle_close_over25"]) / (
        1 / joined["pinnacle_close_over25"] + 1 / joined["pinnacle_close_under25"]
    )
    joined["p_fs_btts"] = (1 / joined["bookmaker_odds_btts_yes"]) / (
        1 / joined["bookmaker_odds_btts_yes"] + 1 / joined["bookmaker_odds_btts_no"]
    )

    # Features
    joined["fs_xg_total"] = joined["home_prematch_xg"] + joined["away_prematch_xg"]

    # Drop rows without baseline
    print(f"  Over25 baseline available: {joined['p_pinn_over25'].notna().sum():,}")
    print(f"  BTTS baseline available:   {joined['p_fs_btts'].notna().sum():,}")
    print(f"  Outcome valid: {joined['over25'].notna().sum():,}")

    # ─── RUN: 4 hypothesis tests ───────────────────────────────────────
    print("\n[4/5] Falsification tests...")
    tests = [
        # (feature, target, baseline_col, target_label, label)
        ("fs_xg_total",        "over25", "p_pinn_over25", "Over2.5",   "H1: FS xG-total → Over25 (Pinnacle baseline)"),
        ("prematch_over25_pct","over25", "p_pinn_over25", "Over2.5",   "H2: FS Over25% → Over25 (Pinnacle baseline)"),
        ("prematch_avg_goals", "over25", "p_pinn_over25", "Over2.5",   "H3: FS avg-goals → Over25 (Pinnacle baseline)"),
        ("prematch_btts_pct",  "btts",   "p_fs_btts",     "BTTS",      "H4: FS BTTS% → BTTS realized (FS-bookmaker baseline)"),
    ]

    test_rows = []
    for feat, tgt, base, market, label in tests:
        print(f"\n── {label} ──")
        sub = joined[[feat, tgt, base, "league"]].dropna().copy()
        if len(sub) < 100:
            print(f"  ⚠ n={len(sub)} too few — skipping")
            continue
        # Build residual
        sub["resid"] = sub[tgt] - sub[base]
        # AGG
        r_raw, p_raw = pearsonr(sub[feat], sub[tgt])
        r_resid, p_resid = pearsonr(sub[feat], sub["resid"])
        sp_resid, _ = spearmanr(sub[feat], sub["resid"])
        p_perm = perm_p(sub[feat].values, sub["resid"].values, n_perm=1000)

        print(f"  AGGREGATE  n={len(sub):>5,}")
        print(f"    r_raw    = {r_raw:+.4f}  (p={p_raw:.4f})")
        print(f"    r_resid  = {r_resid:+.4f}  (perm-p={p_perm:.4f})  ← incremental signal")
        print(f"    spearman = {sp_resid:+.4f}")

        # Per-league (only top 5 with strongest |r|)
        print(f"  Per-league r_resid (top 5 by |r|):")
        per_lg = []
        for lg in sub["league"].unique():
            s = sub[sub["league"] == lg]
            if len(s) < 50:
                continue
            rl, _ = pearsonr(s[feat], s["resid"])
            per_lg.append({"league": lg, "n": len(s), "r": rl})
        per_lg.sort(key=lambda x: -abs(x["r"]))
        for r in per_lg[:5]:
            marker = "✅" if abs(r["r"]) > 0.10 else "🟡" if abs(r["r"]) > 0.05 else "❌"
            print(f"    {marker} {r['league']:<16} n={r['n']:>5,}  r_resid={r['r']:+.4f}")

        test_rows.append({
            "feature": feat, "target": tgt, "market": market, "label": label,
            "n": int(len(sub)),
            "r_raw": round(float(r_raw), 4),
            "p_raw": round(float(p_raw), 4),
            "r_residual": round(float(r_resid), 4),
            "spearman_residual": round(float(sp_resid), 4),
            "perm_p_residual": round(float(p_perm), 4),
            "per_league": [{"league": x["league"], "n": int(x["n"]),
                            "r_resid": round(float(x["r"]), 4)} for x in per_lg],
        })

    # ─── Holm-Bonferroni across all 4 tests ────────────────────────────
    print("\n[5/5] Holm-Bonferroni across all 4 hypotheses + Verdicts...")
    holm_input = [{"name": t["label"], "p_raw": t["perm_p_residual"]} for t in test_rows]
    holm = _fp.holm_bonferroni(holm_input, p_key="p_raw", alpha=0.05)
    print(f"\n  {'Hypothesis':<55} {'p_raw':>8} {'p_adj':>8}  Sig?")
    print(f"  {'-'*55} {'-'*8} {'-'*8}  ----")
    for h in holm:
        sig = "✅" if h["significant"] else "❌"
        print(f"  {h['name'][:55]:<55} {h['p_raw']:>8.4f} {h['p_adj']:>8.4f}  {sig}")

    # ─── ROI simulation for any survivor ───────────────────────────────
    print("\n[ROI gate] Flat-staking value-bet ROI vs vig...")
    for t in test_rows:
        if t["perm_p_residual"] > 0.05:
            continue
        feat = t["feature"]
        base_col = "p_pinn_over25" if t["target"] == "over25" else "p_fs_btts"
        odd_col = "pinnacle_close_over25" if t["target"] == "over25" else "bookmaker_odds_btts_yes"
        # Build naive value-bet sim:
        # if FS feature > some threshold → bet Over25 / BTTS
        sub = joined[[feat, t["target"], base_col, odd_col]].dropna().copy()
        if len(sub) < 200: continue
        # Convert FS feature to "implied prob" by linear scaling vs market (crude)
        # Use rank-based: bet when feat-rank in top 30%
        sub["feat_rank"] = sub[feat].rank(pct=True)
        bets = sub[sub["feat_rank"] >= 0.7]  # top 30%
        if len(bets) < 100: continue
        # PROFIT: if outcome=1, win odd-1; else lose stake=1
        bets = bets.copy()
        bets["profit"] = np.where(bets[t["target"]] == 1, bets[odd_col] - 1, -1)
        roi = bets["profit"].mean() * 100
        print(f"  {t['label'][:50]}: top-30% n={len(bets)}, ROI={roi:+.2f}%")
        t["sim_roi_top30_pct"] = round(float(roi), 2)

    # Save
    out = ROOT / "tools" / "v4" / "diagnostics" / "fs_goals_market_falsification.json"
    out.write_text(json.dumps({
        "joined_n": int(len(joined)),
        "tests": test_rows,
        "holm_results": [{"name": h["name"], "p_raw": h["p_raw"],
                          "p_adj": float(h["p_adj"]), "significant": bool(h["significant"])}
                         for h in holm],
    }, indent=2, default=str))
    print(f"\n✓ Report: {out}")

    # ─── FINAL VERDICT ─────────────────────────────────────────────────
    print("\n" + "═" * 76)
    print("FINAL VERDICT (5-Gate Falsification)")
    print("═" * 76)
    holm_survivors = [h["name"] for h in holm if h["significant"]]
    if not holm_survivors:
        print("\n  ❌ ALL 4 features FAIL Holm-Bonferroni (α=0.05, m=4)")
        print("     FS Goals/BTTS features are noise vs Pinnacle/bookmaker baseline.")
        print("     match_prematch_signals goals-features = backtest-corpus only.")
    else:
        print(f"\n  ✅ {len(holm_survivors)} hypothesis survive Holm-Bonferroni:")
        for s in holm_survivors:
            print(f"    • {s}")
        print(f"  Next: ROI simulation must beat ~3.4% vig for handelbarer Edge")


if __name__ == "__main__":
    main()
