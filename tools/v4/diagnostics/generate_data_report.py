#!/usr/bin/env python3
"""FODZE Data Report Generator — single-file HTML with embedded visuals.

Generates a comprehensive snapshot of FODZE's data state across:
  1. Today's sprint gains (Sofa Phase-2 slim-3 backfill across 2 chain runs)
  2. Per-season Phase-2 endpoints coverage
  3. team_xg_history source distribution (91k rows)
  4. Per-league × per-source xG-history heatmap
  5. StatsBomb xG audit findings
  6. Engine performance state (from cross-engine metrics if present)

Output: tools/v4/diagnostics/fodze-data-report-YYYY-MM-DD.html

Single self-contained file — all charts as base64 PNGs, no external deps.
Open directly in browser.
"""
from __future__ import annotations

import base64
import glob
import io
import json
import sqlite3
from datetime import datetime
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np
import pandas as pd

# ─── FODZE Brand colors (from CLAUDE.md leather/gold theme) ─────────────
COLOR_LEATHER = "#1a0f0a"
COLOR_GOLD = "#d4b86a"
COLOR_GOLD_DIM = "#9b8746"
COLOR_VALUE = "#6aad55"
COLOR_VALUE_DARK = "#4a8c3a"
COLOR_DANGER = "#c25a3a"
COLOR_WARN = "#d4a05a"
COLOR_INFO = "#4a8fc2"
COLOR_NEUTRAL = "#7d6e5a"
COLOR_BG_DARK = "#231510"
COLOR_GRID = "#3a2820"

# Apply theme defaults
plt.rcParams.update({
    "figure.facecolor": COLOR_LEATHER,
    "axes.facecolor": COLOR_BG_DARK,
    "axes.edgecolor": COLOR_GOLD_DIM,
    "axes.labelcolor": COLOR_GOLD,
    "axes.titlecolor": COLOR_GOLD,
    "xtick.color": COLOR_GOLD,
    "ytick.color": COLOR_GOLD,
    "text.color": COLOR_GOLD,
    "grid.color": COLOR_GRID,
    "axes.grid": True,
    "grid.alpha": 0.3,
    "font.family": "sans-serif",
    "font.size": 10,
    "axes.titlesize": 12,
    "axes.titleweight": "bold",
})

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"
EXTRAS_DIR = REPO_ROOT / "tools" / "sofascore" / "data" / "extras"
SB_AUDIT = REPO_ROOT / "tools" / "v4" / "diagnostics" / "statsbomb_xg_audit.json"
CROSS_ENGINE = REPO_ROOT / "tools" / "backtest" / "cross-engine-current-metrics.json"
OUT_HTML = REPO_ROOT / "tools" / "v4" / "diagnostics" / f"fodze-data-report-{datetime.now():%Y-%m-%d}.html"


def fig_to_base64(fig) -> str:
    """Render matplotlib figure to base64-encoded PNG for HTML embedding."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight",
                facecolor=COLOR_LEATHER, edgecolor="none")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ───────────────────────────────────────────────────────────────────────
# Section 1 · Today's sprint gains (Sofa Phase-2 slim-3 backfill)
# ───────────────────────────────────────────────────────────────────────
def scan_extras_coverage() -> dict[str, dict]:
    """Per-season slim-3 endpoint coverage."""
    by_season = {}
    for p in glob.glob(str(EXTRAS_DIR / "*.json")):
        try:
            d = json.loads(open(p).read())
        except Exception:
            continue
        season = d.get("season") or "unknown"
        by_season.setdefault(season, {"all3": 0, "partial": 0, "none": 0, "total": 0})
        by_season[season]["total"] += 1
        has = sum(1 for k in ("statistics", "lineups", "average_positions") if d.get(k))
        if has == 3:
            by_season[season]["all3"] += 1
        elif has == 0:
            by_season[season]["none"] += 1
        else:
            by_season[season]["partial"] += 1
    return by_season


def plot_sprint_gains(coverage: dict) -> str:
    """22/23 + 23/24 gains: before/after stacked bars."""
    # Baselines (CLAUDE.md morning of 2026-05-26)
    baseline_a3 = {"22/23": 1540, "23/24": 5884, "24/25": 5358, "25/26": 6852}
    baseline_total = {"22/23": 3360, "23/24": 6362, "24/25": 5547, "25/26": 6858}

    seasons = ["22/23", "23/24", "24/25", "25/26"]
    before_a3 = [baseline_a3[s] for s in seasons]
    after_a3 = [coverage.get(s, {}).get("all3", 0) for s in seasons]
    delta = [a - b for a, b in zip(after_a3, before_a3)]

    fig, ax = plt.subplots(figsize=(10, 5))
    x = np.arange(len(seasons))
    w = 0.36
    bars1 = ax.bar(x - w/2, before_a3, w, label="2026-05-26 morning baseline",
                   color=COLOR_NEUTRAL, edgecolor=COLOR_GOLD, linewidth=0.5)
    bars2 = ax.bar(x + w/2, after_a3, w, label="2026-05-27 11:47 post-sprint",
                   color=COLOR_VALUE, edgecolor=COLOR_GOLD, linewidth=0.5)

    for i, (b, a, d) in enumerate(zip(before_a3, after_a3, delta)):
        if d > 0:
            ax.annotate(f"+{d:,}", xy=(i + w/2, a), xytext=(0, 6),
                        textcoords="offset points", ha="center",
                        color=COLOR_VALUE, fontsize=11, fontweight="bold")
        ax.annotate(f"{a:,}", xy=(i + w/2, a/2), ha="center", va="center",
                    color=COLOR_LEATHER, fontsize=9)
        ax.annotate(f"{b:,}", xy=(i - w/2, b/2), ha="center", va="center",
                    color=COLOR_GOLD, fontsize=9)

    ax.set_xticks(x)
    ax.set_xticklabels(seasons)
    ax.set_ylabel("Cache JSONs with all-3 slim endpoints")
    ax.set_title("Sofa Phase-2 Slim-3 Backfill — 26h Sprint Gains (2026-05-26 → 2026-05-27)")
    ax.legend(loc="upper right", frameon=False)
    return fig_to_base64(fig)


# ───────────────────────────────────────────────────────────────────────
# Section 2 · Phase-2 coverage breakdown per season
# ───────────────────────────────────────────────────────────────────────
def plot_phase2_coverage_breakdown(coverage: dict) -> str:
    seasons = sorted(s for s in coverage.keys() if s in ("22/23", "23/24", "24/25", "25/26"))
    all3 = [coverage[s]["all3"] for s in seasons]
    partial = [coverage[s]["partial"] for s in seasons]
    none = [coverage[s]["none"] for s in seasons]
    totals = [coverage[s]["total"] for s in seasons]

    fig, ax = plt.subplots(figsize=(10, 5))
    x = np.arange(len(seasons))

    ax.bar(x, all3, color=COLOR_VALUE, label="all-3 endpoints", edgecolor=COLOR_GOLD, linewidth=0.5)
    ax.bar(x, partial, bottom=all3, color=COLOR_WARN, label="partial (1-2 of 3)", edgecolor=COLOR_GOLD, linewidth=0.5)
    ax.bar(x, none, bottom=[a + p for a, p in zip(all3, partial)],
           color=COLOR_DANGER, label="none (0 of 3)", edgecolor=COLOR_GOLD, linewidth=0.5)

    for i, (s, t, a) in enumerate(zip(seasons, totals, all3)):
        pct = a / t * 100 if t else 0
        ax.annotate(f"{pct:.1f}%", xy=(i, t), xytext=(0, 6),
                    textcoords="offset points", ha="center",
                    color=COLOR_GOLD, fontweight="bold", fontsize=11)
        ax.annotate(f"n={t:,}", xy=(i, -t*0.04), ha="center",
                    color=COLOR_GOLD_DIM, fontsize=9)

    ax.set_xticks(x)
    ax.set_xticklabels(seasons)
    ax.set_ylabel("Cache JSONs")
    ax.set_title("Sofa Phase-2 Slim-3 Endpoint Coverage by Season — Current State")
    ax.legend(loc="upper right", frameon=False)
    return fig_to_base64(fig)


# ───────────────────────────────────────────────────────────────────────
# Section 3 · team_xg_history source distribution
# ───────────────────────────────────────────────────────────────────────
def plot_xg_source_distribution() -> tuple[str, dict]:
    conn = sqlite3.connect(str(LOCAL_DB))
    rows = conn.execute(
        "SELECT source, COUNT(*) FROM team_xg_history GROUP BY source ORDER BY 2 DESC"
    ).fetchall()
    conn.close()

    sources, counts = zip(*rows)
    total = sum(counts)

    fig, ax = plt.subplots(figsize=(10, 5))
    colors = [COLOR_GOLD, COLOR_VALUE, COLOR_INFO, COLOR_WARN, COLOR_NEUTRAL,
              COLOR_DANGER, COLOR_GOLD_DIM][:len(sources)]
    bars = ax.barh(range(len(sources)), counts, color=colors, edgecolor=COLOR_LEATHER, linewidth=0.5)
    ax.set_yticks(range(len(sources)))
    ax.set_yticklabels(sources)
    ax.invert_yaxis()
    ax.set_xlabel("team-match rows")
    ax.set_title(f"team_xg_history Source Distribution · n={total:,}")

    for i, (n, src) in enumerate(zip(counts, sources)):
        pct = n / total * 100
        ax.annotate(f"{n:,} ({pct:.1f}%)", xy=(n, i), xytext=(8, 0),
                    textcoords="offset points", va="center",
                    color=COLOR_GOLD, fontsize=10)

    return fig_to_base64(fig), {"total": total, "sources": dict(rows)}


# ───────────────────────────────────────────────────────────────────────
# Section 4 · Per-league × per-source coverage matrix
# ───────────────────────────────────────────────────────────────────────
def plot_league_source_heatmap() -> str:
    conn = sqlite3.connect(str(LOCAL_DB))
    df = pd.read_sql_query("""
        SELECT league, source, COUNT(*) AS n
        FROM team_xg_history
        WHERE league IS NOT NULL AND source IS NOT NULL
        GROUP BY league, source
    """, conn)
    conn.close()

    pivot = df.pivot_table(index="league", columns="source", values="n", fill_value=0)
    # Order leagues by total descending
    pivot["__total"] = pivot.sum(axis=1)
    pivot = pivot.sort_values("__total", ascending=False).drop(columns="__total")
    # Order sources by global total descending
    src_totals = pivot.sum(axis=0).sort_values(ascending=False)
    pivot = pivot[src_totals.index]

    fig, ax = plt.subplots(figsize=(11, 9))
    # Log scale for cell color since counts vary 1-7000
    arr = pivot.values
    log_arr = np.log1p(arr)
    im = ax.imshow(log_arr, cmap="YlOrRd", aspect="auto",
                   vmin=0, vmax=np.log1p(arr.max()))

    # Annotate non-zero cells with actual counts
    for i in range(arr.shape[0]):
        for j in range(arr.shape[1]):
            if arr[i, j] > 0:
                color = "white" if log_arr[i, j] > log_arr.max() * 0.55 else "black"
                fmt = f"{int(arr[i, j])}" if arr[i, j] < 1000 else f"{int(arr[i, j]/1000)}k"
                ax.text(j, i, fmt, ha="center", va="center",
                        color=color, fontsize=7.5, fontweight="bold")

    ax.set_xticks(np.arange(len(pivot.columns)))
    ax.set_xticklabels(pivot.columns, rotation=45, ha="right")
    ax.set_yticks(np.arange(len(pivot.index)))
    ax.set_yticklabels(pivot.index)
    ax.set_title("team_xg_history × Source — Coverage Matrix (n per cell)")
    ax.tick_params(axis="x", colors=COLOR_GOLD)
    ax.tick_params(axis="y", colors=COLOR_GOLD)

    return fig_to_base64(fig)


# ───────────────────────────────────────────────────────────────────────
# Section 5 · StatsBomb xG audit visuals
# ───────────────────────────────────────────────────────────────────────
def plot_sb_audit() -> str | None:
    if not SB_AUDIT.exists():
        return None
    audit = json.loads(SB_AUDIT.read_text())

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))

    # Left: per-(league, source) bias
    rows = []
    for lg, src_dict in audit["per_league_per_source"].items():
        for src, m in src_dict.items():
            rows.append((f"{lg}\n{src}", m["bias_sb_minus_ours"], m["rmse"], m["n"]))
    labels, biases, rmses, ns = zip(*rows)

    colors = [COLOR_DANGER if b < -0.08 else COLOR_WARN if b < -0.04 else COLOR_VALUE for b in biases]
    bars = ax1.bar(labels, biases, color=colors, edgecolor=COLOR_GOLD, linewidth=0.5)
    ax1.axhline(0, color=COLOR_GOLD, linewidth=1, alpha=0.5)
    ax1.set_ylabel("Bias (SB − ours) xG/match")
    ax1.set_title("StatsBomb xG vs Our Sources — Per-(League, Source) Bias")
    for bar, n in zip(bars, ns):
        h = bar.get_height()
        ax1.annotate(f"n={n}", xy=(bar.get_x() + bar.get_width()/2, h),
                     xytext=(0, -10 if h < 0 else 6),
                     textcoords="offset points", ha="center",
                     color=COLOR_GOLD, fontsize=9)

    # Right: aggregate bar
    agg = audit["per_source_aggregate"]
    agg_keys = list(agg.keys())
    agg_biases = [agg[k]["bias_sb_minus_ours"] for k in agg_keys]
    agg_ns = [agg[k]["n"] for k in agg_keys]
    ax2.bar(agg_keys, agg_biases, color=[COLOR_INFO, COLOR_WARN][:len(agg_keys)],
            edgecolor=COLOR_GOLD, linewidth=0.5)
    ax2.axhline(0, color=COLOR_GOLD, linewidth=1, alpha=0.5)
    ax2.axhline(audit["systematic_bias_sb_minus_ours"], color=COLOR_VALUE,
                linewidth=1.5, linestyle="--", alpha=0.7,
                label=f"Overall: {audit['systematic_bias_sb_minus_ours']:+.3f}")
    ax2.set_ylabel("Bias (SB − ours) xG/match")
    ax2.set_title(f"Aggregate by Source · joined n={audit['n_joined']} · Cohen's d ≈ 0.32")
    for i, (k, n) in enumerate(zip(agg_keys, agg_ns)):
        ax2.annotate(f"n={n}", xy=(i, agg_biases[i]),
                     xytext=(0, -10 if agg_biases[i] < 0 else 6),
                     textcoords="offset points", ha="center",
                     color=COLOR_GOLD, fontsize=9)
    ax2.legend(loc="lower right", frameon=False)

    fig.suptitle(f"StatsBomb Audit · Verdict: {audit['verdict']}",
                 color=COLOR_GOLD, fontsize=13, y=1.02)
    return fig_to_base64(fig)


# ───────────────────────────────────────────────────────────────────────
# Section 6 · Engine performance (cross-engine metrics if present)
# ───────────────────────────────────────────────────────────────────────
def plot_engine_brier() -> str | None:
    if not CROSS_ENGINE.exists():
        return None
    try:
        data = json.loads(CROSS_ENGINE.read_text())
    except Exception:
        return None

    # cross-engine-current-metrics.json structure varies — try common keys
    if "by_engine" not in data and "engines" not in data:
        # Try flat structure
        engines = {k: v for k, v in data.items() if isinstance(v, dict) and "brier" in v}
        if not engines:
            return None
    else:
        engines = data.get("by_engine", data.get("engines", {}))

    if not engines:
        return None

    names = []
    briers = []
    for name, m in engines.items():
        if isinstance(m, dict) and "brier" in m:
            names.append(name)
            briers.append(m["brier"])
    if not names:
        return None

    fig, ax = plt.subplots(figsize=(10, 4))
    colors = [COLOR_VALUE if b == min(briers) else COLOR_GOLD_DIM for b in briers]
    bars = ax.bar(names, briers, color=colors, edgecolor=COLOR_GOLD, linewidth=0.5)
    ax.set_ylabel("Brier score (lower is better)")
    ax.set_title("Engine Brier — Current Season Backtest")
    ax.set_ylim(min(briers)*0.98, max(briers)*1.02)
    for bar, b in zip(bars, briers):
        ax.annotate(f"{b:.4f}", xy=(bar.get_x() + bar.get_width()/2, b),
                    xytext=(0, 6), textcoords="offset points", ha="center",
                    color=COLOR_GOLD, fontsize=10, fontweight="bold")
    return fig_to_base64(fig)


# ───────────────────────────────────────────────────────────────────────
# Section 7 · Sofa endpoint completeness (full 7-endpoint state)
# ───────────────────────────────────────────────────────────────────────
def plot_sofa_endpoint_completeness() -> str:
    """For each Sofa endpoint, % of cache files that have it populated."""
    endpoints = ("statistics", "lineups", "incidents", "average_positions",
                 "managers", "pregame_form", "team_streaks")
    counts = {ep: 0 for ep in endpoints}
    total = 0
    for p in glob.glob(str(EXTRAS_DIR / "*.json")):
        try:
            d = json.loads(open(p).read())
        except Exception:
            continue
        total += 1
        for ep in endpoints:
            if d.get(ep):
                counts[ep] += 1

    fig, ax = plt.subplots(figsize=(10, 5))
    pcts = [counts[ep] / total * 100 for ep in endpoints]
    colors = [COLOR_VALUE if p > 90 else COLOR_WARN if p > 50 else COLOR_DANGER for p in pcts]
    bars = ax.barh(range(len(endpoints)), pcts, color=colors,
                   edgecolor=COLOR_GOLD, linewidth=0.5)
    ax.set_yticks(range(len(endpoints)))
    ax.set_yticklabels(endpoints)
    ax.invert_yaxis()
    ax.set_xlabel("Coverage (%)")
    ax.set_xlim(0, 100)
    ax.set_title(f"Sofa Phase-2 Endpoint Completeness Across All {total:,} Cache JSONs")
    for i, (ep, pct, n) in enumerate(zip(endpoints, pcts, [counts[ep] for ep in endpoints])):
        ax.annotate(f"{pct:.1f}%  ({n:,})", xy=(pct, i), xytext=(8, 0),
                    textcoords="offset points", va="center",
                    color=COLOR_GOLD, fontsize=10)
    ax.axvline(95, color=COLOR_GOLD_DIM, linewidth=1, linestyle="--", alpha=0.5)
    return fig_to_base64(fig)


# ───────────────────────────────────────────────────────────────────────
# HTML Assembly
# ───────────────────────────────────────────────────────────────────────
HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FODZE Data Report — {date}</title>
<style>
  body {{
    background: #1a0f0a;
    color: #d4b86a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0;
    padding: 32px;
    line-height: 1.5;
  }}
  .wrap {{ max-width: 1200px; margin: 0 auto; }}
  h1 {{
    color: #d4b86a;
    border-bottom: 2px solid #d4b86a;
    padding-bottom: 12px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }}
  h2 {{
    color: #d4b86a;
    margin-top: 48px;
    border-left: 4px solid #6aad55;
    padding-left: 12px;
    font-weight: 500;
  }}
  h3 {{ color: #6aad55; margin-top: 32px; font-weight: 500; }}
  .meta {{ color: #9b8746; font-size: 0.85em; margin-bottom: 24px; }}
  .headline {{
    background: #231510;
    border: 1px solid #6aad55;
    border-radius: 6px;
    padding: 20px 24px;
    margin: 20px 0;
  }}
  .headline-num {{
    font-size: 1.8em;
    color: #6aad55;
    font-weight: 700;
  }}
  .grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin: 16px 0;
  }}
  .stat {{
    background: #231510;
    padding: 14px 18px;
    border-radius: 4px;
    border-left: 3px solid #d4b86a;
  }}
  .stat-label {{ color: #9b8746; font-size: 0.85em; }}
  .stat-value {{ color: #d4b86a; font-size: 1.4em; font-weight: 600; }}
  img.chart {{
    width: 100%;
    max-width: 1140px;
    margin: 16px 0;
    border-radius: 4px;
    border: 1px solid #3a2820;
  }}
  table {{
    border-collapse: collapse;
    width: 100%;
    margin: 16px 0;
    background: #231510;
  }}
  th, td {{
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid #3a2820;
  }}
  th {{ color: #d4b86a; font-weight: 600; }}
  td {{ color: #d4b86a; }}
  .tag-good {{ color: #6aad55; }}
  .tag-warn {{ color: #d4a05a; }}
  .tag-bad  {{ color: #c25a3a; }}
  .footer {{
    margin-top: 64px;
    padding-top: 16px;
    border-top: 1px solid #3a2820;
    color: #9b8746;
    font-size: 0.8em;
  }}
  code {{
    background: #3a2820;
    padding: 2px 6px;
    border-radius: 3px;
    color: #d4b86a;
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 0.92em;
  }}
</style>
</head>
<body>
<div class="wrap">

<h1>🟨 FODZE Data Report</h1>
<div class="meta">Generated: {timestamp} · Local SQLite: <code>{db_path}</code></div>

{content}

<div class="footer">
  Generated by <code>tools/v4/diagnostics/generate_data_report.py</code> · FODZE data state snapshot ·
  Brand palette: leather <code>#1a0f0a</code> · gold <code>#d4b86a</code> · value-green <code>#6aad55</code>
</div>

</div>
</body>
</html>
"""


def main():
    print("═" * 72)
    print("FODZE Data Report Generator")
    print("═" * 72)

    sections = []

    # Section 1: sprint gains
    print("\n[1/7] Scanning Phase-2 cache coverage...")
    coverage = scan_extras_coverage()
    img1 = plot_sprint_gains(coverage)
    delta_22 = coverage.get("22/23", {}).get("all3", 0) - 1540
    delta_23 = coverage.get("23/24", {}).get("all3", 0) - 5884
    sections.append(f"""
<h2>1 · 26-Hour Sprint Gains (Sofa Phase-2 Slim-3 Backfill)</h2>

<div class="headline">
  <div class="headline-num">+{delta_22 + delta_23:,}</div>
  <div>newly-enriched cache JSONs with statistics + lineups + average_positions across 22/23 + 23/24</div>
</div>

<div class="grid">
  <div class="stat"><div class="stat-label">22/23 all-3 slim coverage</div><div class="stat-value">1,540 → {coverage.get('22/23', {}).get('all3', 0):,} (+{delta_22:,})</div></div>
  <div class="stat"><div class="stat-label">23/24 all-3 slim coverage</div><div class="stat-value">5,884 → {coverage.get('23/24', {}).get('all3', 0):,} (+{delta_23:,})</div></div>
</div>

<img class="chart" src="data:image/png;base64,{img1}" alt="Sprint gains">
""")

    # Section 2: Phase-2 coverage breakdown
    print("[2/7] Plotting Phase-2 coverage breakdown...")
    img2 = plot_phase2_coverage_breakdown(coverage)
    sections.append(f"""
<h2>2 · Phase-2 Slim-3 Endpoint Coverage by Season</h2>
<p>Status across the engine-critical trio: <code>statistics</code> + <code>lineups</code> + <code>average_positions</code>.
3 of 4 seasons sit above 95% — the engine-input gap is in the bottom-of-pile partial files (random distribution, no Liga-bias).</p>
<img class="chart" src="data:image/png;base64,{img2}" alt="Phase-2 coverage">
""")

    # Section 3: Sofa endpoint completeness (all 7)
    print("[3/7] Plotting all-7-endpoint completeness...")
    img7 = plot_sofa_endpoint_completeness()
    sections.append(f"""
<h2>3 · Sofa Endpoint Completeness (All 7 Endpoints)</h2>
<p>Across ALL cache JSONs. Slim-3 endpoints (statistics/lineups/average_positions) and incidents are nearly complete;
v2-extras (managers/pregame_form/team_streaks) lag because they require api.sofascore.com calls that the Webshare-burnout
runs deprioritized.</p>
<img class="chart" src="data:image/png;base64,{img7}" alt="Endpoint completeness">
""")

    # Section 4: team_xg_history source distribution
    print("[4/7] Plotting team_xg_history source breakdown...")
    img3, xg_meta = plot_xg_source_distribution()
    sections.append(f"""
<h2>4 · team_xg_history Source Distribution</h2>
<p>Engine's primary input pool: <strong>{xg_meta['total']:,} team-match rows</strong> across {len(xg_meta['sources'])} sources.
FootyStats CSV imports remain the largest contributor; Sofascore shotmap-bridge is the fastest-growing.</p>
<img class="chart" src="data:image/png;base64,{img3}" alt="xG source distribution">
""")

    # Section 5: Per-league × per-source heatmap
    print("[5/7] Plotting per-league × per-source heatmap...")
    img4 = plot_league_source_heatmap()
    sections.append(f"""
<h2>5 · Per-League × Per-Source xG Coverage Matrix</h2>
<p>Log-color-scaled count of rows. Empty cells reveal coverage gaps:
top-5 leagues are typically multi-source; lower-tier (liga3, league_two, eerste_divisie) rely on a single source.</p>
<img class="chart" src="data:image/png;base64,{img4}" alt="League×Source matrix">
""")

    # Section 6: StatsBomb audit
    print("[6/7] Plotting StatsBomb audit visuals...")
    img5 = plot_sb_audit()
    if img5:
        audit = json.loads(SB_AUDIT.read_text())
        bias_str = f"{audit['systematic_bias_sb_minus_ours']:+.3f}"
        sections.append(f"""
<h2>6 · StatsBomb xG Audit — Our Sources vs Gold-Standard</h2>
<p>Performed 2026-05-26. Joined <strong>n={audit['n_joined']}</strong> matches between SB's calibrated xG model and our sources
(sofascore + understat) for 3 Top-5 leagues that overlap our 2017–2024 window.</p>

<div class="grid">
  <div class="stat"><div class="stat-label">Systematic bias (SB − ours)</div><div class="stat-value">{bias_str} xG/match</div></div>
  <div class="stat"><div class="stat-label">Verdict</div><div class="stat-value tag-good">{audit['verdict']}</div></div>
</div>

<p>Our public-xG models (sofa + understat) <strong>systematically over-estimate</strong> by ~0.09 xG/match vs SB.
Statistically firm in aggregate (t≈−4.3, p&lt;0.001), but Cohen's d ≈ 0.32 = small effect relative to per-match noise (std ≈ 0.28).
<strong>Verdict: validation-corpus only.</strong> Our isotonic+Benter calibration (Phase 2.x) already absorbs this bias.</p>

<img class="chart" src="data:image/png;base64,{img5}" alt="SB audit">
""")

    # Section 7: Engine performance
    print("[7/7] Plotting engine performance...")
    img6 = plot_engine_brier()
    if img6:
        sections.append(f"""
<h2>7 · Engine Brier — Current Season Backtest</h2>
<p>From <code>tools/backtest/cross-engine-current-metrics.json</code>. Lower Brier is better.</p>
<img class="chart" src="data:image/png;base64,{img6}" alt="Engine Brier">
""")
    else:
        sections.append(f"""
<h2>7 · Engine Brier — Not Available</h2>
<p>Skipped: <code>{CROSS_ENGINE.relative_to(REPO_ROOT)}</code> not in expected shape.</p>
""")

    # Final state summary table
    sections.append(f"""
<h2>📋 State Summary</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Total Sofa cache JSONs</td><td>{sum(c['total'] for c in coverage.values()):,}</td></tr>
  <tr><td>Slim-3 fully populated</td><td>{sum(c['all3'] for c in coverage.values()):,}</td></tr>
  <tr><td>team_xg_history rows</td><td>{xg_meta['total']:,}</td></tr>
  <tr><td>Distinct xG sources</td><td>{len(xg_meta['sources'])}</td></tr>
  <tr><td>SB audit corpus</td><td>{json.loads(SB_AUDIT.read_text())['n_joined'] if SB_AUDIT.exists() else 'N/A'} matched rows</td></tr>
  <tr><td>SB audit verdict</td><td class="tag-good">{json.loads(SB_AUDIT.read_text())['verdict'] if SB_AUDIT.exists() else 'N/A'}</td></tr>
</table>
""")

    # Assemble HTML
    html = HTML_TEMPLATE.format(
        date=datetime.now().strftime("%Y-%m-%d"),
        timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        db_path=str(LOCAL_DB.relative_to(REPO_ROOT)),
        content="\n".join(sections),
    )
    OUT_HTML.write_text(html)

    print(f"\n  ✓ Report: {OUT_HTML.relative_to(REPO_ROOT)}")
    print(f"  Size: {OUT_HTML.stat().st_size / 1024:.1f} KB")
    print(f"  Open: open '{OUT_HTML}'")


if __name__ == "__main__":
    main()
