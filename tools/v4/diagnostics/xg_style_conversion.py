#!/usr/bin/env python3
"""xg_style_conversion — is the xG→goals compression a TEAM-STYLE effect?

User thesis: conversion is NOT a flat ~1.0. Dominant, offensive teams (e.g. FC
Bayern) pile up high xG against deep blocks → xG inflated → they UNDER-convert.
And their high defensive line concedes efficient counters → opponents OVER-convert
against them. This is a STYLE confound that raw finishing-persistence (ρ=0.29)
misses, because style is STABLE.

Tests (per team, non-penalty, sofascore_shotmap, 17 leagues × 22/23–25/26):
  A  dominance (Ø npxG/match) → own conversion (Σgoals/Σxg)
       hypothesis: NEGATIVE (dominant teams under-convert).
  B  dominance → conceded conversion (Σopp_goals/Σopp_xg)
       hypothesis: POSITIVE (their high line lets opponents over-convert).
  C  is the xG-level compression WITHIN-game or BETWEEN-team?
       pooled vs within-team vs between-team slope of goals~xg.
  D  persistence of dominance (Ø npxG season-to-season) — if high AND A/B real,
       the conditional conversion is USABLE (unlike raw finishing).
Bayern highlighted throughout.

Outputs (tools/v4/diagnostics/):
  xg_style_conversion_teams.csv · xg_style_conversion.json · xg_style_conversion.png
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/xg_style_conversion.py
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

REPO = Path(__file__).resolve().parents[3]
DB = REPO / "tools" / "sofascore" / "data" / "local_extras.db"
D = REPO / "tools" / "v4" / "diagnostics"
MIN_N = 34
BAYERN = "FC Bayern München"
C_PT, C_BAY, C_LINE, C_DIAG = "#3a7ca5", "#b5483d", "#c9a227", "#999999"


def team_matches():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    sm = pd.read_sql_query(
        "SELECT s.game_id, s.league, s.season, s.is_home, s.xg, s.situation, s.shot_type, s.goal_type "
        "FROM sofascore_shotmap s", con)
    hm = {gid: (h, a) for gid, h, a in con.execute("SELECT game_id, home_team, away_team FROM sofascore_match")}
    con.close()
    sm["xg"] = pd.to_numeric(sm["xg"], errors="coerce").fillna(0.0)
    sm = sm[sm["league"].isin(set(sm.loc[sm["xg"] > 0, "league"].unique()))].copy()
    pen = sm["situation"].eq("penalty")
    goal = sm["shot_type"].eq("goal") & sm["goal_type"].ne("own")
    sm["np_xg"] = np.where(~pen, sm["xg"], 0.0)
    sm["np_goal"] = (goal & ~pen).astype(int)
    g = sm.groupby(["game_id", "league", "season", "is_home"], as_index=False).agg(
        np_xg=("np_xg", "sum"), np_goals=("np_goal", "sum"))
    g = g[g["np_xg"] > 0].copy()
    opp = g[["game_id", "is_home", "np_xg", "np_goals"]].rename(
        columns={"is_home": "oh", "np_xg": "opp_xg", "np_goals": "opp_goals"})
    opp["oh"] = 1 - opp["oh"]
    m = g.merge(opp, left_on=["game_id", "is_home"], right_on=["game_id", "oh"], how="inner").drop(columns="oh")
    m["team"] = [hm.get(gid, ("?", "?"))[0 if ih else 1] for gid, ih in zip(m["game_id"], m["is_home"])]
    return m


def main() -> int:
    m = team_matches()
    print(f"  {len(m):,} team-matches · {m['team'].nunique()} teams")

    # per-team aggregates
    rows = []
    for team, s in m.groupby("team"):
        if len(s) < MIN_N:
            continue
        rows.append({"team": team, "n": len(s),
                     "dominance": s["np_xg"].mean(),
                     "xg_against": s["opp_xg"].mean(),
                     "own_conv": s["np_goals"].sum() / s["np_xg"].sum(),
                     "conc_conv": s["opp_goals"].sum() / s["opp_xg"].sum()})
    t = pd.DataFrame(rows)
    t["net_dom"] = t["dominance"] - t["xg_against"]

    # Test A + B
    rA, pA = stats.pearsonr(t["dominance"], t["own_conv"])
    rB, pB = stats.pearsonr(t["dominance"], t["conc_conv"])
    print(f"\n  TEST A · dominance → own conversion:  r={rA:+.3f} (p={pA:.1e})  "
          f"{'✓ dominant UNTER-konvertieren' if rA<0 else 'dominant ÜBER-konvertieren'}")
    print(f"  TEST B · dominance → conceded conversion: r={rB:+.3f} (p={pB:.1e})  "
          f"{'✓ Gegner ÜBER-konvertieren ggn. Dominante' if rB>0 else 'Gegner unter-konvertieren'}")

    # Test C: within vs between slope of the level compression
    pooled = stats.linregress(m["np_xg"], m["np_goals"])
    within = []
    for team, s in m.groupby("team"):
        if len(s) >= 40 and s["np_xg"].std() > 0:
            within.append(stats.linregress(s["np_xg"], s["np_goals"]).slope)
    within_med = float(np.median(within))
    between = stats.linregress(t["dominance"], t.apply(lambda r: m[m.team == r['team']]["np_goals"].mean(), axis=1))
    print(f"\n  TEST C · goals~xg slope:  pooled {pooled.slope:.3f} · within-team(median) {within_med:.3f} · "
          f"between-team {between.slope:.3f}")
    print(f"    (Kompression = Slope<1. within≈pooled → Spiel-Level-Effekt; "
          f"between<within → Stil-Effekt zwischen Teams)")

    # Test D: dominance persistence season-to-season
    ds = {}
    for (team, season), s in m.groupby(["team", "season"]):
        if len(s) >= 12:
            ds[(team, season)] = s["np_xg"].mean()
    order = ["22/23", "23/24", "24/25", "25/26"]
    x, y = [], []
    for (team, season), v in ds.items():
        nx = order[order.index(season) + 1] if season in order and order.index(season) + 1 < len(order) else None
        if nx and (team, nx) in ds:
            x.append(v); y.append(ds[(team, nx)])
    dom_persist = float(np.corrcoef(x, y)[0, 1]) if len(x) > 5 else np.nan
    print(f"\n  TEST D · dominance persistence (Ø npxG saison→saison): r={dom_persist:+.3f} (n={len(x)})")

    # Bayern
    bay = t[t.team == BAYERN]
    if len(bay):
        b = bay.iloc[0]
        dom_pct = 100 * (t["dominance"] < b["dominance"]).mean()
        conv_pct = 100 * (t["own_conv"] < b["own_conv"]).mean()
        print(f"\n  BAYERN: Ø npxG {b['dominance']:.2f} (Perzentil {dom_pct:.0f} = dominanteste) · "
              f"own-conv {b['own_conv']:.3f} (Perzentil {conv_pct:.0f}) · "
              f"conceded-conv {b['conc_conv']:.3f}")
        print(f"    → {'bestätigt: Top-Dominanz + ' + ('unter' if b['own_conv']<0.96 else 'über') + '-Conversion' }")

    t.round(3).sort_values("dominance", ascending=False).to_csv(D / "xg_style_conversion_teams.csv", index=False)
    out = {
        "n_team_matches": len(m), "n_teams": len(t),
        "test_A_dominance_vs_own_conv": {"r": rA, "p": pA},
        "test_B_dominance_vs_conceded_conv": {"r": rB, "p": pB},
        "test_C_slopes": {"pooled": pooled.slope, "within_team_median": within_med, "between_team": between.slope},
        "test_D_dominance_persistence_r": dom_persist,
        "bayern": ({k: (round(float(v), 3) if isinstance(v, (int, float, np.number)) else v)
                    for k, v in bay.iloc[0].to_dict().items()} if len(bay) else None),
        "interpretation": (
            f"Dominanz→eigene Conversion r={rA:+.2f} ("
            f"{'REAL & POSITIV — dominante Teams ÜBER-verwerten' if rA > 0.15 else ('negativ — unter-verwerten' if rA < -0.15 else 'schwach')}); "
            f"Dominanz→Gegner-Conversion r={rB:+.2f} ("
            f"{'Gegner unter-konvertieren ggn. Dominante (Suppression)' if rB < -0.10 else 'Gegner über-konvertieren' if rB > 0.10 else 'neutral'}); "
            f"Kompression (Slope<1) ist {'ein WITHIN-game-Effekt (Regression zur Mitte), between-team sogar >1' if between.slope > within_med else 'auch zwischen Teams'}; "
            f"Dominanz persistiert r={dom_persist:.2f} → {'STABIL, also als Conversion-Kondition nutzbar' if dom_persist > 0.4 else 'instabil'}."),
    }
    (D / "xg_style_conversion.json").write_text(json.dumps(out, indent=2, default=float))

    # ── figure ──
    fig = plt.figure(figsize=(17, 6.4))
    gs = GridSpec(1, 3, wspace=0.26)
    def scat(ax, ycol, rr, pp, ylab, title, good_low=True):
        ax.scatter(t["dominance"], t[ycol], s=18, color=C_PT, alpha=0.55, edgecolors="none")
        if len(bay):
            ax.scatter(b["dominance"], b[ycol], s=120, color=C_BAY, edgecolors="k", zorder=5, label="FC Bayern")
        sl = stats.linregress(t["dominance"], t[ycol])
        xs = np.array([t["dominance"].min(), t["dominance"].max()])
        ax.plot(xs, sl.intercept + sl.slope * xs, color=C_LINE, lw=2.2)
        ax.axhline(1.0, color=C_DIAG, ls="--", lw=1)
        ax.set_xlabel("Dominanz (Ø npxG / Spiel)"); ax.set_ylabel(ylab)
        ax.set_title(f"{title}\nr={rr:+.3f}  (p={pp:.1e})", fontweight="bold", fontsize=11)
        ax.legend(fontsize=8); ax.grid(alpha=0.2)
    scat(fig.add_subplot(gs[0, 0]), "own_conv", rA, pA, "eigene Conversion (Tore/xG)",
         "A · Dominante Teams unter-verwerten?")
    scat(fig.add_subplot(gs[0, 1]), "conc_conv", rB, pB, "Gegner-Conversion gegen sie",
         "B · Hohe Linie → Gegner über-verwerten?")
    # C: slope decomposition
    axC = fig.add_subplot(gs[0, 2])
    axC.bar(["pooled", "within-team\n(Median)", "between-team"], [pooled.slope, within_med, between.slope],
            color=[C_PT, "#5a9e45", C_BAY])
    axC.axhline(1.0, color=C_DIAG, ls="--", lw=1.2, label="Slope=1 (keine Kompression)")
    axC.set_ylabel("goals ~ xg Slope"); axC.set_ylim(0, 1.05)
    axC.set_title(f"C · Kompression: Stil (between) vs Spiel (within)\nDominanz-Persistenz r={dom_persist:.2f}",
                  fontweight="bold", fontsize=11)
    axC.legend(fontsize=8)
    for i, v in enumerate([pooled.slope, within_med, between.slope]):
        axC.text(i, v + 0.01, f"{v:.3f}", ha="center", fontsize=9)
    fig.suptitle("FODZE · Conversion als TEAM-STIL-Effekt · Sofa-Shotmap 22/23–25/26 (npxG, FC Bayern markiert)",
                 fontsize=13, fontweight="bold")
    fig.savefig(D / "xg_style_conversion.png", dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"\n  VERDIKT: {out['interpretation']}")
    print("  Outputs: xg_style_conversion_teams.csv · .json · .png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
