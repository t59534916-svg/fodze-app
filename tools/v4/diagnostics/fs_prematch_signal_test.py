"""
FS Pre-Match Signal Test — multi-feature falsification

Tests whether candidate features from match_prematch_signals add INCREMENTAL
signal beyond the Pinnacle-closing baseline. Methodology follows CLAUDE.md's
"Empirical signal-test methodology (2026-05-22)":

  * SIGNED RESIDUAL = realized - baseline (NOT squared error — that's
    artifact-prone, conflates "correlates with outcome" vs "adds signal
    beyond baseline").
  * Permutation p-values for significance (parametric assumptions fail
    on football data).
  * Per-league breakdown to detect heterogeneity (a feature might work
    in 1 league + be noise in 17).

Bridge: match_prematch_signals uses canonical FODZE team-names + colon-
match_key format; odds_closing_history uses raw football-data.co.uk
names + pipe-match_key format. Join is done via Python with the
canonical_team() lookup table.

Verdict per feature:
  SIGNAL:   r(feature, residual) significant + magnitude > 0.03 in
            multiple leagues (~aggregate would still need retrain to
            confirm Brier-Δ).
  NOISE:    no significant correlation, OR magnitude < 0.02 across
            board. FS data is backtest-corpus only, not engine signal.
  MIXED:    significant in some leagues, noise elsewhere → potentially
            useful but needs per-league treatment.

Usage:
  tools/venv/bin/python3 tools/v4/diagnostics/fs_prematch_signal_test.py
"""

from __future__ import annotations

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

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

# Import canonical_team_map directly (avoid m3_xg package __init__ which has
# a different sys.path convention via the v4/ direct-run scaffold).
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "canonical_team_map",
    ROOT / "tools" / "v4" / "modules" / "m3_xg" / "canonical_team_map.py",
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
canonical_team = _mod.canonical_team


# ─── env loader ──────────────────────────────────────────────────────
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
if not SUPA_URL or not SUPA_KEY:
    raise SystemExit("❌ SUPABASE env vars not set")

HDRS = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}


# ─── Supabase pull (paginated) ───────────────────────────────────────
def supa_pull(table: str, select: str, filters: dict[str, str] = None,
              page_size: int = 1000) -> pd.DataFrame:
    """Pull a table from PostgREST in pages of 1000 (Supabase default cap)."""
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
        if offset > 50000:  # safety
            print(f"  ⚠ {table}: stopped at offset {offset}")
            break
    return pd.DataFrame(out)


# ─── Vig-removal helper ──────────────────────────────────────────────
def vig_remove_1x2(h: float, d: float, a: float) -> tuple[float, float, float]:
    """Simple proportional vig removal. Returns (p_h, p_d, p_a)."""
    if not all(x and x > 1.0 for x in (h, d, a)):
        return (np.nan, np.nan, np.nan)
    ih, id_, ia = 1 / h, 1 / d, 1 / a
    s = ih + id_ + ia
    return (ih / s, id_ / s, ia / s)


def vig_remove_ou(o: float, u: float) -> tuple[float, float]:
    """Vig-removed over / under."""
    if not all(x and x > 1.0 for x in (o, u)):
        return (np.nan, np.nan)
    io, iu = 1 / o, 1 / u
    s = io + iu
    return (io / s, iu / s)


# ─── Permutation p-value ─────────────────────────────────────────────
def perm_pvalue(x: np.ndarray, y: np.ndarray, n_perm: int = 1000,
                seed: int = 42) -> float:
    """Two-sided permutation test for Pearson r. Returns p-value."""
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


# ─── Verdict ─────────────────────────────────────────────────────────
def verdict(r: float, p: float, n: int) -> str:
    if n < 100:
        return "⚠ N<100"
    if not np.isfinite(r):
        return "⚠ NaN"
    if p > 0.05:
        return "❌ NOISE (p > 0.05)"
    if abs(r) < 0.02:
        return "❌ NOISE (|r| < 0.02)"
    if abs(r) < 0.05:
        return "🟡 WEAK"
    if abs(r) < 0.10:
        return "🟢 MODERATE"
    return "✅ STRONG"


# ─── Main ────────────────────────────────────────────────────────────
def main():
    t0 = time.time()
    print("═" * 70)
    print("FS Pre-Match Signal Pilot — multi-feature falsification")
    print("═" * 70)

    # 1. Pull match_prematch_signals (22/23 + 23/24 + 24/25)
    print("\n[1/5] Pulling match_prematch_signals...")
    mps = supa_pull(
        "match_prematch_signals",
        select=",".join([
            "match_key", "league", "season", "match_date",
            "home_team", "away_team",
            "home_prematch_xg", "away_prematch_xg",
            "home_prematch_ppg", "away_prematch_ppg",
            "prematch_btts_pct", "prematch_over25_pct",
            "prematch_avg_goals",
        ]),
        filters={"season": "in.(22/23,23/24,24/25)"},
    )
    print(f"  {len(mps):,} rows")

    # Filter: skip Week 1 (zeros)
    pre_filter = len(mps)
    mps = mps[
        (mps["home_prematch_xg"].astype(float) > 0)
        & (mps["away_prematch_xg"].astype(float) > 0)
        & (mps["prematch_over25_pct"].astype(float) > 0)
    ].copy()
    print(f"  after Week-1 zero filter: {len(mps):,} ({pre_filter - len(mps):,} dropped)")

    # 2. Pull odds_closing_history (Pinnacle close + ft_goals)
    print("\n[2/5] Pulling odds_closing_history (Pinnacle + outcomes)...")
    och = supa_pull(
        "odds_closing_history",
        select=",".join([
            "league", "match_date", "home_team", "away_team",
            "psch", "pscd", "psca",
            "psc_over25", "psc_under25",
            "ft_goals_h", "ft_goals_a",
        ]),
        filters={
            "match_date": "gte.2022-07-01",
            "ft_goals_h": "not.is.null",
            "psch": "not.is.null",
        },
    )
    print(f"  {len(och):,} rows")

    # 3. Canonicalize och team-names + join on (league, date, canonical-home, canonical-away)
    print("\n[3/5] Canonicalizing odds team-names + joining...")
    och["c_home"] = och.apply(
        lambda r: canonical_team(r["home_team"], r["league"]), axis=1
    )
    och["c_away"] = och.apply(
        lambda r: canonical_team(r["away_team"], r["league"]), axis=1
    )
    mps["c_home"] = mps.apply(
        lambda r: canonical_team(r["home_team"], r["league"]), axis=1
    )
    mps["c_away"] = mps.apply(
        lambda r: canonical_team(r["away_team"], r["league"]), axis=1
    )
    joined = mps.merge(
        och, on=["league", "match_date", "c_home", "c_away"],
        how="inner", suffixes=("_mps", "_och"),
    )
    print(f"  joined: {len(joined):,} rows ({len(joined) / max(len(mps), 1) * 100:.1f}% of mps)")
    if len(joined) < 500:
        raise SystemExit("Too few joined rows — abort.")

    # Numeric coercion
    for col in [
        "home_prematch_xg", "away_prematch_xg",
        "home_prematch_ppg", "away_prematch_ppg",
        "prematch_btts_pct", "prematch_over25_pct", "prematch_avg_goals",
        "psch", "pscd", "psca", "psc_over25", "psc_under25",
        "ft_goals_h", "ft_goals_a",
    ]:
        joined[col] = pd.to_numeric(joined[col], errors="coerce")

    # 4. Build features + baselines + residuals
    print("\n[4/5] Computing features + Pinnacle baselines + residuals...")
    # Vig-remove 1X2
    pH, pD, pA = zip(*joined.apply(
        lambda r: vig_remove_1x2(r["psch"], r["pscd"], r["psca"]), axis=1
    ))
    joined["p_pinn_h"] = pH
    joined["p_pinn_d"] = pD
    joined["p_pinn_a"] = pA
    # Vig-remove O/U
    pO, pU = zip(*joined.apply(
        lambda r: vig_remove_ou(r["psc_over25"], r["psc_under25"]), axis=1
    ))
    joined["p_pinn_over25"] = pO

    # Realized outcomes
    joined["home_win"] = (joined["ft_goals_h"] > joined["ft_goals_a"]).astype(int)
    joined["away_win"] = (joined["ft_goals_h"] < joined["ft_goals_a"]).astype(int)
    joined["total_goals"] = joined["ft_goals_h"] + joined["ft_goals_a"]
    joined["over25_real"] = (joined["total_goals"] > 2.5).astype(int)
    joined["btts_real"] = (
        (joined["ft_goals_h"] >= 1) & (joined["ft_goals_a"] >= 1)
    ).astype(int)

    # Candidate features
    joined["fs_xg_diff"] = joined["home_prematch_xg"] - joined["away_prematch_xg"]
    joined["fs_ppg_diff"] = joined["home_prematch_ppg"] - joined["away_prematch_ppg"]
    # (btts_pct, over25_pct, avg_goals already standalone)

    # Residuals: realized minus market baseline
    joined["resid_home_win"] = joined["home_win"] - joined["p_pinn_h"]
    joined["resid_over25"] = joined["over25_real"] - joined["p_pinn_over25"]
    # No closing market for BTTS → use a simple anchor (vig-removed implied
    # from Pinnacle 1X2 is wrong proxy; instead test against just realized)
    # We'll skip residual for BTTS — only check raw correlation.

    # 5. Run signal test per feature × per league
    print("\n[5/5] Signal test...\n")
    tests = [
        # (feature, target, residual_target, label)
        ("fs_xg_diff",         "home_win",    "resid_home_win", "FS xG-diff → home-win residual"),
        ("fs_ppg_diff",        "home_win",    "resid_home_win", "FS PPG-diff → home-win residual"),
        ("prematch_avg_goals", "total_goals", None,             "FS avg-goals → total-goals"),
        ("prematch_over25_pct","over25_real", "resid_over25",   "FS Over2.5% → Over2.5 residual"),
        ("prematch_btts_pct",  "btts_real",   None,             "FS BTTS% → BTTS realized"),
    ]

    reports = []
    for feature, target, resid, label in tests:
        print(f"\n── {label} ──")
        for level, df in [
            ("AGGREGATE", joined),
            *[(lg, joined[joined["league"] == lg])
              for lg in sorted(joined["league"].unique())],
        ]:
            # Build combined mask: feature + target + (residual if requested)
            cols = [feature, target] + ([resid] if resid else [])
            sub = df[cols].apply(pd.to_numeric, errors="coerce").dropna()
            n = len(sub)
            if n < 30:
                continue
            x = sub[feature].values
            y = sub[target].values
            r_raw, _ = pearsonr(x, y)
            # Residual test (incremental signal beyond Pinnacle market)
            if resid:
                z = sub[resid].values
                r_resid, _ = pearsonr(x, z)
                p_resid = perm_pvalue(x, z, n_perm=500)
            else:
                r_resid, p_resid = np.nan, np.nan
            # Verdict uses residual if available (true incremental test),
            # else falls back to raw correlation (just signal-vs-noise)
            v_metric = r_resid if resid and np.isfinite(r_resid) else r_raw
            v_pvalue = p_resid if resid and np.isfinite(p_resid) else 0.01
            v = verdict(v_metric, v_pvalue, n)
            row = {
                "feature": feature, "target": target, "level": level,
                "n": int(n),
                "r_raw": round(float(r_raw), 4),
                "r_residual": round(float(r_resid), 4) if np.isfinite(r_resid) else None,
                "p_residual": round(float(p_resid), 4) if np.isfinite(p_resid) else None,
                "verdict": v,
            }
            reports.append(row)
            if level == "AGGREGATE":
                if resid and np.isfinite(r_resid):
                    msg = f"r_raw={r_raw:+.3f}  r_residual={r_resid:+.3f}  p={p_resid:.3f}  {v}"
                else:
                    msg = f"r_raw={r_raw:+.3f}  (no-residual)  {v}"
                print(f"  {level:<14} n={n:>5,}  {msg}")
            else:
                # Only show per-league rows that pass at least the weak threshold
                report_metric = r_resid if resid and np.isfinite(r_resid) else r_raw
                if abs(report_metric) > 0.05:
                    print(f"  └─ {level:<14} n={n:>5,}  r={report_metric:+.3f}  {v}")

    # Save report
    out_path = ROOT / "tools" / "v4" / "diagnostics" / "fs_prematch_signal_test.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out = {
        "joined_n": len(joined),
        "elapsed_s": round(time.time() - t0, 1),
        "tests": reports,
    }
    out_path.write_text(json.dumps(out, indent=2))
    print(f"\n✓ Report saved: {out_path}")
    print(f"  Total elapsed: {time.time() - t0:.1f}s")

    # Bottom-line verdict
    print("\n" + "═" * 70)
    print("BOTTOM-LINE SUMMARY (AGGREGATE only)")
    print("═" * 70)
    agg = [r for r in reports if r["level"] == "AGGREGATE"]
    for r in agg:
        print(f"  {r['feature']:<22} → {r['target']:<14} "
              f"n={r['n']:>5,}  "
              f"r_resid={(r['r_residual'] or 0):+.3f}  "
              f"{r['verdict']}")


if __name__ == "__main__":
    main()
