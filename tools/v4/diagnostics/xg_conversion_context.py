#!/usr/bin/env python3
"""xg_conversion_context — is xG→goals conversion conditionable on team / opponent
/ form, or is it noise? (persistence-gated, then shrunk)

User: "factor team form + opponent strengths/weaknesses into the xG→goals
expectation / the threshold of when a team converts against a given opponent."

The honest core: team finishing-over-xG is mostly NOISE (regresses to ~1.0);
GK/defense suppression persists more. So we MEASURE persistence first (split-half
+ season-to-season), then SHRINK each rating toward 1.0 by its reliability — a
low-reliability signal moves the expectation only a little (no noise-fitting).

Signals (per team, non-penalty, from sofascore_shotmap):
  attack_finish  = Σ goals      / Σ xG          (>1 = clinical finishers)
  def_suppress   = Σ opp_goals  / Σ opp_xG      (<1 = good defense/GK)
  gk_prevented   = Σ(xgot_faced − goals_conceded) / match   (shot-stopping, where xGOT)

Conditional expectation for matchup A(att) vs B(def):
  exp_conversion = shrunk_attack(A) × shrunk_defense(B)   (each centered at 1.0)
  exp_goals      = npxG × exp_conversion

Outputs (tools/v4/diagnostics/):
  xg_conversion_team_ratings.csv   per team: raw + shrunk attack/defense/GK + n
  xg_conversion_context.json       persistence r's, reliabilities, form result
  xg_conversion_context.png        split-half scatters + shrunk top/bottom teams

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/xg_conversion_context.py
"""
from __future__ import annotations

import json
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
MIN_N = 30          # min team-matches for a stable rating
C_ATT, C_DEF, C_DIAG = "#3a7ca5", "#b5483d", "#999999"


def team_match_table() -> pd.DataFrame:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    sm = pd.read_sql_query(
        "SELECT s.game_id, s.league, s.season, s.is_home, s.xg, s.xgot, s.situation, s.shot_type, s.goal_type, "
        "m.start_timestamp AS ts FROM sofascore_shotmap s "
        "LEFT JOIN sofascore_match m ON s.game_id=m.game_id", con)
    con.close()
    sm["xg"] = pd.to_numeric(sm["xg"], errors="coerce").fillna(0.0)
    sm["xgot"] = pd.to_numeric(sm["xgot"], errors="coerce").fillna(0.0)
    sm = sm[sm["league"].isin(set(sm.loc[sm["xg"] > 0, "league"].unique()))].copy()
    pen = sm["situation"].eq("penalty")
    goal = sm["shot_type"].eq("goal") & sm["goal_type"].ne("own")
    sm["np_xg"] = np.where(~pen, sm["xg"], 0.0)
    sm["np_xgot"] = np.where(~pen, sm["xgot"], 0.0)
    sm["np_goal"] = (goal & ~pen).astype(int)
    g = sm.groupby(["game_id", "league", "season", "is_home"], as_index=False).agg(
        np_xg=("np_xg", "sum"), np_xgot=("np_xgot", "sum"), np_goals=("np_goal", "sum"),
        ts=("ts", "max"))
    g = g[g["np_xg"] > 0].copy()
    # self-join to attach opponent (defense faced)
    opp = g[["game_id", "is_home", "np_xg", "np_xgot", "np_goals"]].rename(
        columns={"is_home": "oh", "np_xg": "opp_xg", "np_xgot": "opp_xgot", "np_goals": "opp_goals"})
    opp["oh"] = 1 - opp["oh"]
    m = g.merge(opp, left_on=["game_id", "is_home"], right_on=["game_id", "oh"], how="inner").drop(columns="oh")
    home_map = {}
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    for gid, h, a in con.execute("SELECT game_id, home_team, away_team FROM sofascore_match"):
        home_map[gid] = (h, a)
    con.close()
    m["team"] = [home_map.get(gid, ("?", "?"))[0 if ih else 1] for gid, ih in zip(m["game_id"], m["is_home"])]
    return m.sort_values(["team", "ts"]).reset_index(drop=True)


def ratio(num, den):
    return float(num.sum() / den.sum()) if den.sum() > 0 else np.nan


def split_half_reliability(df, num_col, den_col, seed=42, min_half=15):
    """Per-team random split → corr of ratio across halves → Spearman-Brown ρ."""
    rng = np.random.default_rng(seed)
    a_vals, b_vals = [], []
    for _, sub in df.groupby("team"):
        if len(sub) < 2 * min_half:
            continue
        idx = rng.permutation(len(sub))
        h = len(sub) // 2
        A, B = sub.iloc[idx[:h]], sub.iloc[idx[h:]]
        ra, rb = ratio(A[num_col], A[den_col]), ratio(B[num_col], B[den_col])
        if np.isfinite(ra) and np.isfinite(rb):
            a_vals.append(ra); b_vals.append(rb)
    a_vals, b_vals = np.array(a_vals), np.array(b_vals)
    if len(a_vals) < 5:
        return {"n_teams": len(a_vals), "r_half": np.nan, "rho_full": np.nan, "a": a_vals, "b": b_vals}
    r = float(np.corrcoef(a_vals, b_vals)[0, 1])
    rho = 2 * r / (1 + r) if (1 + r) != 0 else np.nan
    return {"n_teams": len(a_vals), "r_half": r, "rho_full": float(rho), "a": a_vals, "b": b_vals}


def season_to_season(df, num_col, den_col):
    rows = {}
    for (team, season), sub in df.groupby(["team", "season"]):
        if len(sub) < 15:
            continue
        rows[(team, season)] = ratio(sub[num_col], sub[den_col])
    order = ["22/23", "23/24", "24/25", "25/26"]
    x, y = [], []
    for (team, season), v in rows.items():
        if season not in order:
            continue
        nxt = order[order.index(season) + 1] if order.index(season) + 1 < len(order) else None
        if nxt and (team, nxt) in rows and np.isfinite(v) and np.isfinite(rows[(team, nxt)]):
            x.append(v); y.append(rows[(team, nxt)])
    if len(x) < 5:
        return {"n_pairs": len(x), "r": np.nan}
    return {"n_pairs": len(x), "r": float(np.corrcoef(x, y)[0, 1])}


def main() -> int:
    print("Loading + aggregating per team-match (with opponent join)...")
    m = team_match_table()
    n_teams = m["team"].nunique()
    print(f"  {len(m):,} team-matches · {n_teams} teams · {m['league'].nunique()} leagues")
    glob_finish = ratio(m["np_goals"], m["np_xg"])

    # ── persistence (the gate) ──
    sh_att = split_half_reliability(m, "np_goals", "np_xg")
    sh_def = split_half_reliability(m, "opp_goals", "opp_xg")
    ss_att = season_to_season(m, "np_goals", "np_xg")
    ss_def = season_to_season(m, "opp_goals", "opp_xg")

    print("\n" + "─" * 70)
    print("PERSISTENZ-TEST (das Gate)")
    print("─" * 70)
    print(f"  Attack-Finishing  split-half r={sh_att['r_half']:+.3f}  ρ_full={sh_att['rho_full']:+.3f}  "
          f"saison-zu-saison r={ss_att['r']:+.3f}")
    print(f"  Defense-Suppress  split-half r={sh_def['r_half']:+.3f}  ρ_full={sh_def['rho_full']:+.3f}  "
          f"saison-zu-saison r={ss_def['r']:+.3f}")
    rel_att = max(0.0, sh_att["rho_full"] if np.isfinite(sh_att["rho_full"]) else 0.0)
    rel_def = max(0.0, sh_def["rho_full"] if np.isfinite(sh_def["rho_full"]) else 0.0)
    print(f"  → Shrinkage-Gewicht (Reliabilität): Attack {rel_att:.2f} · Defense {rel_def:.2f}")
    print("    (Anteil der Team-Abweichung von 1.0, dem wir trauen; Rest = Rauschen → zu 1.0 geschrumpft)")

    # ── form: does prior-5 finishing predict next-match finishing? ──
    m2 = m.copy()
    m2["cum_g"] = m2.groupby("team")["np_goals"].cumsum().shift(0)
    fr_prior, fr_next = [], []
    for _, sub in m2.groupby("team"):
        sub = sub.reset_index(drop=True)
        for i in range(5, len(sub) - 1):
            pg, px = sub["np_goals"].iloc[i - 5:i].sum(), sub["np_xg"].iloc[i - 5:i].sum()
            if px <= 0:
                continue
            nxt_x = sub["np_xg"].iloc[i]
            if nxt_x <= 0:
                continue
            fr_prior.append(pg / px); fr_next.append(sub["np_goals"].iloc[i] / nxt_x)
    form_r = float(np.corrcoef(fr_prior, fr_next)[0, 1]) if len(fr_prior) > 50 else np.nan
    print(f"\n  FORM: prior-5 Finishing → nächstes-Spiel Finishing  r={form_r:+.3f}  (n={len(fr_prior):,})")
    print(f"    {'→ Form trägt kaum (Rauschen)' if abs(form_r)<0.06 else '→ Form trägt etwas'}")

    # ── per-team ratings + shrinkage ──
    rows = []
    for team, sub in m.groupby("team"):
        if len(sub) < MIN_N:
            continue
        af = ratio(sub["np_goals"], sub["np_xg"])
        ds = ratio(sub["opp_goals"], sub["opp_xg"])
        gp = float((sub["opp_xgot"] - sub["opp_goals"]).mean())  # GK goals-prevented/match (def)
        rows.append({"team": team, "n": len(sub),
                     "attack_finish": round(af, 3), "attack_shrunk": round(1 + rel_att * (af - 1), 3),
                     "def_suppress": round(ds, 3), "def_shrunk": round(1 + rel_def * (ds - 1), 3),
                     "gk_prevented_per_match": round(gp, 3)})
    rt = pd.DataFrame(rows).sort_values("attack_shrunk", ascending=False).reset_index(drop=True)
    rt.to_csv(D / "xg_conversion_team_ratings.csv", index=False)

    out = {
        "global_finish_ratio": round(glob_finish, 4), "n_team_matches": len(m), "n_teams_rated": len(rt),
        "persistence": {
            "attack_split_half_r": sh_att["r_half"], "attack_rho_full": sh_att["rho_full"],
            "attack_season_to_season_r": ss_att["r"],
            "defense_split_half_r": sh_def["r_half"], "defense_rho_full": sh_def["rho_full"],
            "defense_season_to_season_r": ss_def["r"]},
        "shrinkage_weight": {"attack": rel_att, "defense": rel_def},
        "form_prior5_to_next_r": form_r, "form_n": len(fr_prior),
        "interpretation": (
            f"Attack-Finishing ist {'überwiegend Rauschen' if rel_att<0.35 else 'teilweise real'} "
            f"(ρ={rel_att:.2f}) → stark zu 1.0 geschrumpft. "
            f"Defense/GK persistiert {'stärker' if rel_def>rel_att else 'ähnlich'} (ρ={rel_def:.2f}). "
            f"Form (prior-5→next) r={form_r:+.3f} = {'vernachlässigbar' if abs(form_r)<0.06 else 'schwach'}."),
    }
    (D / "xg_conversion_context.json").write_text(json.dumps(out, indent=2))

    # ── figure ──
    fig = plt.figure(figsize=(16, 11))
    gs = GridSpec(2, 2, hspace=0.32, wspace=0.22)
    # split-half scatters
    for ax, sh, lbl, col in [(fig.add_subplot(gs[0, 0]), sh_att, "Attack-Finishing", C_ATT),
                             (fig.add_subplot(gs[0, 1]), sh_def, "Defense-Suppression", C_DEF)]:
        ax.scatter(sh["a"], sh["b"], s=22, color=col, alpha=0.6, edgecolors="none")
        lim = [0.5, 1.5]
        ax.plot(lim, lim, "--", color=C_DIAG, lw=1.2)
        ax.set_xlim(lim); ax.set_ylim(lim)
        ax.set_xlabel("Quote Hälfte A"); ax.set_ylabel("Quote Hälfte B")
        ax.set_title(f"{lbl} · Split-Half-Persistenz\nr={sh['r_half']:+.3f} → ρ_full={sh['rho_full']:+.3f} "
                     f"({'überwiegend Rauschen' if (sh['rho_full'] or 0)<0.35 else 'real'})",
                     fontweight="bold", fontsize=11)
        ax.grid(alpha=0.2)
    # shrunk attack top/bottom
    axC = fig.add_subplot(gs[1, 0])
    top = pd.concat([rt.head(10), rt.tail(10)])
    axC.barh(top["team"], top["attack_shrunk"], color=[C_ATT if v >= 1 else C_DIAG for v in top["attack_shrunk"]])
    axC.axvline(1.0, color=C_DIAG, ls="--", lw=1.2)
    axC.invert_yaxis()
    axC.set_xlabel("geschrumpfte Attack-Finishing-Quote (1.0 = Liga-Norm)")
    axC.set_title(f"Top/Bottom-10 Finisher (nach Shrinkage ρ={rel_att:.2f})\n"
                  f"Spannweite eng = wenig echtes Team-Signal", fontweight="bold", fontsize=11)
    axC.tick_params(labelsize=7.5)
    # shrunk defense top/bottom
    axD = fig.add_subplot(gs[1, 1])
    rd = rt.sort_values("def_shrunk")
    topd = pd.concat([rd.head(10), rd.tail(10)])
    axD.barh(topd["team"], topd["def_shrunk"], color=[C_DEF if v <= 1 else C_DIAG for v in topd["def_shrunk"]])
    axD.axvline(1.0, color=C_DIAG, ls="--", lw=1.2)
    axD.invert_yaxis()
    axD.set_xlabel("geschrumpfte Defense-Suppression (<1.0 = Gegner trifft seltener)")
    axD.set_title(f"Beste/schwächste Abwehr+TW (nach Shrinkage ρ={rel_def:.2f})", fontweight="bold", fontsize=11)
    axD.tick_params(labelsize=7.5)
    fig.suptitle("FODZE · Conversion-Kontext: Team-Finishing & Gegner-Abwehr — Persistenz & Shrinkage "
                 "(Sofa-Shotmap 22/23–25/26, npxG)", fontsize=13, fontweight="bold")
    fig.savefig(D / "xg_conversion_context.png", dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)

    print(f"\n  global finishing {glob_finish:.3f} · {len(rt)} teams rated")
    print("  Outputs: xg_conversion_team_ratings.csv · xg_conversion_context.json · xg_conversion_context.png")
    print(f"\n  VERDIKT: {out['interpretation']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
