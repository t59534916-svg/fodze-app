#!/usr/bin/env python3
"""xg_to_goals — penalty-adjusted xG→goals calibration, per league + aggregate.

"Which xG value in a game yields how many goals" — penalty-stripped, because a
penalty (fixed xG ~0.79) and ESPECIALLY a missed penalty distort the relation.
Rebounds/tap-ins after a penalty STAY counted (they are separate shot events
with situation != 'penalty'), per the user's request.

Definitions (per team-match, from sofascore_shotmap):
  npxG      = Σ xg  WHERE situation != 'penalty'
  np_goals  = #(shot_type='goal' AND situation != 'penalty' AND goal_type != 'own')
  raw_xg / raw_goals = same incl. penalties (for the penalty-distortion contrast)
  pen_taken / pen_goals / pen_xg = penalty bookkeeping
Own goals (goal_type='own') are excluded from a team's goal tally (not its shots).

Coverage: 17 leagues with Sofa-xG × seasons 22/23–25/26.

Outputs (tools/v4/diagnostics/):
  xg_to_goals_team_match.csv   — granular per-team-match dataset (league column →
                                 "together" = all rows, "separate" = filter by league)
  xg_to_goals_calibration.csv  — binned npxG → mean np_goals, per league + __ALL__
  xg_to_goals_overview.png     — all-leagues-together graphic
  xg_to_goals_per_league.png   — per-league small-multiples graphic

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/xg_to_goals.py
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

REPO = Path(__file__).resolve().parents[3]
DB = REPO / "tools" / "sofascore" / "data" / "local_extras.db"
D = REPO / "tools" / "v4" / "diagnostics"
BINS = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 99]
BIN_LBL = ["0–0.5", "0.5–1", "1–1.5", "1.5–2", "2–2.5", "2.5–3", "3+"]
C_NP, C_RAW, C_DIAG, C_OK = "#c9a227", "#b5483d", "#999999", "#4f8a3d"


def load() -> pd.DataFrame:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    sm = pd.read_sql_query(
        "SELECT game_id, league, season, is_home, xg, situation, shot_type, goal_type "
        "FROM sofascore_shotmap", con)
    matches = pd.read_sql_query("SELECT game_id, home_team, away_team FROM sofascore_match", con)
    con.close()
    sm["xg"] = pd.to_numeric(sm["xg"], errors="coerce").fillna(0.0)
    # leagues that actually carry xG
    xg_leagues = set(sm.loc[sm["xg"] > 0, "league"].unique())
    sm = sm[sm["league"].isin(xg_leagues)].copy()
    is_pen = sm["situation"].eq("penalty")
    is_goal = sm["shot_type"].eq("goal") & sm["goal_type"].ne("own")
    sm["np_xg"] = np.where(~is_pen, sm["xg"], 0.0)
    sm["pen_xg"] = np.where(is_pen, sm["xg"], 0.0)
    sm["np_goal"] = (is_goal & ~is_pen).astype(int)
    sm["raw_goal"] = is_goal.astype(int)
    sm["pen_taken"] = is_pen.astype(int)
    sm["pen_goal"] = (is_pen & sm["shot_type"].eq("goal")).astype(int)
    g = sm.groupby(["game_id", "league", "season", "is_home"], as_index=False).agg(
        np_xg=("np_xg", "sum"), raw_xg=("xg", "sum"), pen_xg=("pen_xg", "sum"),
        np_goals=("np_goal", "sum"), raw_goals=("raw_goal", "sum"),
        pen_taken=("pen_taken", "sum"), pen_goals=("pen_goal", "sum"))
    g = g[g["raw_xg"] > 0].copy()  # keep only team-matches with real xG data
    # team name (dict.get with default — some shotmap game_ids lack a match row)
    home_map = dict(zip(matches["game_id"], matches["home_team"]))
    away_map = dict(zip(matches["game_id"], matches["away_team"]))
    g["team"] = [(home_map.get(gid, "?") if ih else away_map.get(gid, "?"))
                 for gid, ih in zip(g["game_id"], g["is_home"])]
    for c in ("np_xg", "raw_xg", "pen_xg"):
        g[c] = g[c].round(3)
    return g.sort_values(["league", "season", "game_id", "is_home"]).reset_index(drop=True)


def calibration(g: pd.DataFrame) -> pd.DataFrame:
    rows = []
    def per(df, name):
        df = df.copy()
        df["bin"] = pd.cut(df["np_xg"], BINS, labels=BIN_LBL, right=False)
        for lbl, sub in df.groupby("bin", observed=True):
            if len(sub) < 5:
                continue
            rows.append({"league": name, "bin": str(lbl), "n": len(sub),
                         "mean_npxg": round(sub["np_xg"].mean(), 3),
                         "mean_np_goals": round(sub["np_goals"].mean(), 3),
                         "mean_raw_xg": round(sub["raw_xg"].mean(), 3),
                         "mean_raw_goals": round(sub["raw_goals"].mean(), 3)})
    per(g, "__ALL__")
    for lg in sorted(g["league"].unique()):
        per(g[g["league"] == lg], lg)
    return pd.DataFrame(rows)


def conv_ratios(g: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for lg in ["__ALL__"] + sorted(g["league"].unique()):
        sub = g if lg == "__ALL__" else g[g["league"] == lg]
        rows.append({
            "league": lg, "team_matches": len(sub),
            "np_ratio": round(sub["np_goals"].sum() / max(sub["np_xg"].sum(), 1e-9), 4),
            "raw_ratio": round(sub["raw_goals"].sum() / max(sub["raw_xg"].sum(), 1e-9), 4),
            "npxg_per_match": round(sub["np_xg"].mean(), 3),
            "np_goals_per_match": round(sub["np_goals"].mean(), 3),
            "pen_per_match": round(sub["pen_taken"].mean(), 3),
            "pen_conv": round(sub["pen_goals"].sum() / max(sub["pen_taken"].sum(), 1e-9), 3),
        })
    return pd.DataFrame(rows)


def _binned(df):
    df = df.copy()
    df["bin"] = pd.cut(df["np_xg"], BINS, labels=BIN_LBL, right=False)
    rb = df.copy(); rb["rbin"] = pd.cut(df["raw_xg"], BINS, labels=BIN_LBL, right=False)
    npx = df.groupby("bin", observed=True).agg(x=("np_xg", "mean"), y=("np_goals", "mean"), n=("np_goals", "size"))
    rawx = rb.groupby("rbin", observed=True).agg(x=("raw_xg", "mean"), y=("raw_goals", "mean"))
    return npx[npx["n"] >= 5], rawx


def fig_overview(g, ratios):
    npx, rawx = _binned(g)
    fig = plt.figure(figsize=(15, 6.2))
    gs = GridSpec(1, 2, width_ratios=[1, 1.1], wspace=0.22)
    # A: overall calibration np vs raw
    axA = fig.add_subplot(gs[0, 0])
    axA.plot([0, 3.2], [0, 3.2], "--", color=C_DIAG, lw=1.3, label="xG = Tore (ideal)")
    axA.plot(rawx["x"], rawx["y"], "s-", color=C_RAW, lw=2, ms=6, label="MIT Elfmetern (roh)")
    axA.plot(npx["x"], npx["y"], "o-", color=C_NP, lw=2.6, ms=7, label="OHNE Elfmeter (npxG)")
    axA.set_xlabel("xG im Spiel (pro Team)"); axA.set_ylabel("Ø tatsächliche Tore")
    r = ratios.loc[ratios.league == "__ALL__"].iloc[0]
    axA.set_title(f"A · xG → Tore (alle {len(g):,} Team-Spiele, 17 Ligen)\n"
                  f"npxG-Quote {r['np_ratio']:.3f} Tore/xG · roh {r['raw_ratio']:.3f}", fontweight="bold", fontsize=11)
    axA.legend(fontsize=9, loc="upper left"); axA.grid(alpha=0.25)
    # B: per-league np conversion ratio bars
    axB = fig.add_subplot(gs[0, 1])
    rl = ratios[ratios.league != "__ALL__"].sort_values("np_ratio")
    cols = [C_OK if v >= 1 else C_RAW for v in rl["np_ratio"]]
    axB.barh(rl["league"], rl["np_ratio"], color=cols)
    axB.axvline(1.0, color=C_DIAG, ls="--", lw=1.3)
    axB.axvline(r["np_ratio"], color=C_NP, ls=":", lw=1.5, label=f"Schnitt {r['np_ratio']:.3f}")
    axB.set_xlabel("npxG-Quote (Tore je npxG) · 1.0 = perfekt kalibriert")
    axB.set_title("B · Finishing pro Liga (penalty-bereinigt)\n>1 übertrifft xG, <1 bleibt drunter",
                  fontweight="bold", fontsize=11)
    axB.legend(fontsize=8); axB.grid(alpha=0.2, axis="x")
    for i, v in enumerate(rl["np_ratio"]):
        axB.text(v + 0.005, i, f"{v:.3f}", va="center", fontsize=7.5)
    fig.suptitle("FODZE · xG → Tore, penalty-bereinigt · Sofascore-Shotmap 22/23–25/26",
                 fontsize=13, fontweight="bold")
    p = D / "xg_to_goals_overview.png"
    fig.savefig(p, dpi=125, bbox_inches="tight", facecolor="white"); plt.close(fig)
    return p


def fig_per_league(g):
    lgs = sorted(g["league"].unique())
    ncol = 4; nrow = int(np.ceil(len(lgs) / ncol))
    fig, axes = plt.subplots(nrow, ncol, figsize=(15, 3.0 * nrow))
    axes = axes.flatten()
    for ax, lg in zip(axes, lgs):
        npx, _ = _binned(g[g["league"] == lg])
        ax.plot([0, 3.2], [0, 3.2], "--", color=C_DIAG, lw=1)
        ax.plot(npx["x"], npx["y"], "o-", color=C_NP, lw=2, ms=4)
        ratio = g[g.league == lg]["np_goals"].sum() / max(g[g.league == lg]["np_xg"].sum(), 1e-9)
        ax.set_title(f"{lg}  (Quote {ratio:.2f}, n={len(g[g.league==lg]):,})", fontsize=9, fontweight="bold")
        ax.set_xlim(0, 3.2); ax.set_ylim(0, 3.2); ax.grid(alpha=0.2); ax.tick_params(labelsize=7)
    for ax in axes[len(lgs):]:
        ax.axis("off")
    fig.suptitle("FODZE · xG → Tore pro Liga (npxG, penalty-bereinigt) · npxG (x) vs. Ø Tore (y) · gestrichelt = ideal",
                 fontsize=12, fontweight="bold", y=1.005)
    fig.tight_layout()
    p = D / "xg_to_goals_per_league.png"
    fig.savefig(p, dpi=120, bbox_inches="tight", facecolor="white"); plt.close(fig)
    return p


def main() -> int:
    print("Loading shotmap + aggregating per team-match...")
    g = load()
    print(f"  {len(g):,} team-matches across {g['league'].nunique()} leagues, {g['season'].nunique()} seasons")
    cal = calibration(g)
    ratios = conv_ratios(g)

    g.to_csv(D / "xg_to_goals_team_match.csv", index=False)
    cal.to_csv(D / "xg_to_goals_calibration.csv", index=False)
    ratios.to_csv(D / "xg_to_goals_conversion_ratios.csv", index=False)
    pA = fig_overview(g, ratios)
    pB = fig_per_league(g)

    allr = ratios.loc[ratios.league == "__ALL__"].iloc[0]
    print(f"\n  OVERALL (penalty-bereinigt): npxG-Quote {allr['np_ratio']:.3f} Tore/xG "
          f"(roh mit Elfmetern {allr['raw_ratio']:.3f})")
    print(f"  Ø npxG/Spiel {allr['npxg_per_match']:.2f} · Ø np-Tore/Spiel {allr['np_goals_per_match']:.2f} · "
          f"Ø Elfmeter/Spiel {allr['pen_per_match']:.3f} · Elfmeter-Quote {allr['pen_conv']:.2f}")
    print("\n  per-league npxG-Quote (Tore je npxG):")
    for _, r in ratios[ratios.league != "__ALL__"].sort_values("np_ratio", ascending=False).iterrows():
        print(f"    {r['league']:<16} {r['np_ratio']:.3f}  (roh {r['raw_ratio']:.3f}, n={r['team_matches']:,})")
    print("\n  Outputs:")
    for f in ("xg_to_goals_team_match.csv", "xg_to_goals_calibration.csv",
              "xg_to_goals_conversion_ratios.csv", pA.name, pB.name):
        print(f"    tools/v4/diagnostics/{f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
