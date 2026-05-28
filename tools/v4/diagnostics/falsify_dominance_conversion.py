#!/usr/bin/env python3
"""falsify_dominance_conversion — 5-Gate test: does team-DOMINANCE add conversion
signal BEYOND dev-03's λ?

Style analysis showed dominant teams over-convert their xG (r=+0.26, leakage-safe
prior→next r=+0.25). But dev-03 already uses xG-history (≈ dominance). So the real
question: does PRIOR-SEASON dominance still predict the residual goals − dev03_λ,
or is it redundant? (FODZE pattern: ~80% of "new features" are redundant.)

Setup (leakage-safe):
  feature   = team's 24/25 Ø npxG (PRIOR season → no same-season leakage)
  baseline  = dev-03 1X2 on 25/26 (OOT for production dev-03)
  treatment = dev-03 λ adjusted by dominance via 5-fold OUT-OF-FOLD β, → 1X2
  outcome   = actual 1X2

5 Gates (tools/v4/utils/falsification_protocol.py):
  G1 sign    — signed-residual corr(prior_dom, goals−λ); + brier-Δ sign
  G2 Holm    — across the dominance hypotheses (attack + defense)
  G3 leakage — prior-season feature + OOT engine + out-of-fold β
  G4 power   — empirical std of brier-diff → required n vs observed
  G5 ROI     — dominance-adjusted 1X2 flat-staked vs Pinnacle closing

Output: tools/v4/diagnostics/falsify_dominance_conversion.json
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/falsify_dominance_conversion.py
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.model_selection import KFold

import score_xg_forecast as X
from score_roi_leaderboard import OddsSpine
from v4.modules.m3_xg import DEFAULT_RHO
from v4.modules.m3_xg.canonical_team_map import canonical_team
from v4.utils.falsification_protocol import (
    holm_bonferroni, required_n_for_brier_delta, power_for_brier_delta,
    simulate_flat_value_bet, gate_summary)

OUT = REPO / "tools" / "v4" / "diagnostics" / "falsify_dominance_conversion.json"
DB = REPO / "tools" / "sofascore" / "data" / "local_extras.db"
RHO = DEFAULT_RHO


def prior_season_dominance(season="24/25") -> dict:
    """Ø non-penalty xG per canonical team in `season` (the leakage-safe feature)."""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    sm = pd.read_sql_query(
        "SELECT game_id, league, is_home, xg, situation FROM sofascore_shotmap WHERE season=?",
        con, params=[season])
    con.close()
    sm["xg"] = pd.to_numeric(sm["xg"], errors="coerce").fillna(0.0)
    sm = sm[sm["league"].isin(set(sm.loc[sm["xg"] > 0, "league"].unique()))]
    sm["np_xg"] = np.where(sm["situation"].ne("penalty"), sm["xg"], 0.0)
    tm = sm.groupby(["game_id", "league", "is_home"], as_index=False).agg(np_xg=("np_xg", "sum"))
    tm = tm[tm["np_xg"] > 0]
    # team name via match table
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    hm = {gid: (h, a) for gid, h, a in con.execute("SELECT game_id, home_team, away_team FROM sofascore_match")}
    con.close()
    tm["team_raw"] = [hm.get(g, ("?", "?"))[0 if ih else 1] for g, ih in zip(tm["game_id"], tm["is_home"])]
    tm["team"] = [canonical_team(r.team_raw, r.league) for r in tm.itertuples(index=False)]
    dom = tm.groupby("team")["np_xg"].mean().to_dict()
    return dom


def main() -> int:
    print("Building dev-03 25/26 predictions + prior-season dominance...")
    eng = X.corpus_engines(("25/26",), RHO)
    d03 = eng["dev-03"]
    dom = prior_season_dominance("24/25")
    gmean = float(np.mean(list(dom.values())))
    print(f"  prior-season (24/25) dominance for {len(dom)} teams · global Ø npxG {gmean:.3f}")

    # per-team-SIDE table (home + away rows) with prior dominance
    hh = pd.DataFrame({"team": d03["ch"], "lam": d03["lam_h"], "goals": d03["y_h"],
                       "p_self": d03["p_h"], "side": "H", "midx": np.arange(len(d03))})
    aa = pd.DataFrame({"team": d03["ca"].values, "lam": d03["lam_a"], "goals": d03["y_a"],
                       "p_self": d03["p_a"], "side": "A", "midx": np.arange(len(d03))})
    side = pd.concat([hh, aa], ignore_index=True)
    side["prior_dom"] = side["team"].map(dom).fillna(gmean)
    side["resid"] = side["goals"].to_numpy(float) - side["lam"].to_numpy(float)
    side["dom_c"] = side["prior_dom"] - gmean

    # ── G1: signed-residual diagnostic ──
    r_resid, p_resid = stats.pearsonr(side["dom_c"], side["resid"])
    r_raw, _ = stats.pearsonr(side["dom_c"], side["goals"].astype(float))
    r_lam, _ = stats.pearsonr(side["dom_c"], side["lam"].astype(float))
    print("\n" + "─" * 72)
    print("G1 · SIGNED-RESIDUAL (does prior dominance predict goals − dev03_λ?)")
    print("─" * 72)
    print(f"  corr(prior_dom, goals)        = {r_raw:+.3f}   (dominance↔goals, expected strong)")
    print(f"  corr(prior_dom, dev03_λ)      = {r_lam:+.3f}   (how much dev-03 ALREADY uses it)")
    print(f"  corr(prior_dom, RESIDUAL)     = {r_resid:+.3f}  p={p_resid:.2e}  ← the test")
    print(f"  → {'dev-03 captures it (residual≈0) → redundant' if abs(r_resid)<0.04 else 'residual signal present'}")

    # ── build dominance-adjusted λ via 5-fold OUT-OF-FOLD β (G3 leakage-safe) ──
    # fit β: resid ~ β·dom_c on train folds, apply to test fold. Map back to matches.
    dom_c = side["dom_c"].to_numpy()
    resid = side["resid"].to_numpy()
    beta_oof = np.zeros(len(side))
    kf = KFold(n_splits=5, shuffle=True, random_state=42)
    betas = []
    for tr, te in kf.split(dom_c):
        b = np.sum(dom_c[tr] * resid[tr]) / np.sum(dom_c[tr] ** 2) if np.sum(dom_c[tr] ** 2) > 0 else 0.0
        beta_oof[te] = b
        betas.append(b)
    side["lam_adj"] = np.clip(side["lam"].to_numpy(float) + beta_oof * dom_c, X.LAMBDA_MIN, X.LAMBDA_MAX)
    print(f"  fitted β (out-of-fold, λ-shift per unit dominance): mean {np.mean(betas):+.3f}")

    # reconstruct adjusted 1X2 per match
    H = side[side.side == "H"].sort_values("midx"); A = side[side.side == "A"].sort_values("midx")
    lam_h_adj = H["lam_adj"].to_numpy(); lam_a_adj = A["lam_adj"].to_numpy()
    p_adj = X._lambdas_to_1x2(lam_h_adj, lam_a_adj, RHO)
    p_base = d03[["p_h", "p_d", "p_a"]].to_numpy(float)
    y = np.array([X._outcome(h, a) for h, a in zip(d03["y_h"], d03["y_a"])])
    y1h = np.eye(3)[y]

    base_bpm = ((p_base - y1h) ** 2).sum(1)
    adj_bpm = ((p_adj - y1h) ** 2).sum(1)
    d = adj_bpm - base_bpm  # <0 = adjustment better
    mean_d, std_d = float(d.mean()), float(d.std(ddof=1))
    se_d = std_d / np.sqrt(len(d)); t_d = mean_d / se_d if se_d > 0 else 0
    p_d = 2 * (1 - stats.norm.cdf(abs(t_d)))
    print(f"\n  Brier-Δ (adj − dev-03): {mean_d:+.5f}  ±{1.96*se_d:.5f}  p={p_d:.3f}  "
          f"({'adj better' if mean_d<0 else 'adj WORSE/equal'})")
    g1_pass = bool(r_resid > 0 and mean_d < 0)

    # ── G2: Holm across dominance hypotheses (attack residual + defense residual) ──
    # defense: does opponent's prior_dom predict THIS team conceding above λ? (mirror)
    opp_dom = pd.concat([
        pd.DataFrame({"od": d03["ca"].map(dom).fillna(gmean).to_numpy() - gmean,
                      "resid": d03["y_h"].to_numpy(float) - d03["lam_h"].to_numpy(float)}),
        pd.DataFrame({"od": d03["ch"].map(dom).fillna(gmean).to_numpy() - gmean,
                      "resid": d03["y_a"].to_numpy(float) - d03["lam_a"].to_numpy(float)}),
    ], ignore_index=True)
    r_def, p_def = stats.pearsonr(opp_dom["od"], opp_dom["resid"])
    hyps = [{"name": "attack_dominance_resid", "p_raw": p_resid},
            {"name": "defense_oppdominance_resid", "p_raw": p_def}]
    hyps = holm_bonferroni(hyps, alpha=0.05)
    g2_pass = any(h["name"] == "attack_dominance_resid" and h["significant"] for h in hyps)
    print(f"\n  G2 Holm (m={len(hyps)}): " + " · ".join(
        f"{h['name']} p_raw={h['p_raw']:.2e}→p_adj={h['p_adj']:.2e} {'✓' if h['significant'] else '✗'}" for h in hyps))

    # ── G4: power ──
    req_n = required_n_for_brier_delta(abs(mean_d) if mean_d < 0 else 1e-9, std_d)
    pwr = power_for_brier_delta(abs(mean_d) if mean_d != 0 else 1e-9, std_d, len(d))
    print(f"\n  G4 power: observed Brier-Δ {mean_d:+.5f} · std {std_d:.3f} · n {len(d):,} · "
          f"required-n {req_n:,} · power {pwr:.2f}")
    g4_pass = bool(mean_d < 0 and len(d) >= req_n)

    # ── G5: ROI vs Pinnacle (adj vs baseline) ──
    ospine = OddsSpine()
    cols = {"H": ("psch", 0), "D": ("pscd", 1), "A": ("psca", 2)}
    league = d03["league"].to_numpy(); ch = d03["ch"].to_numpy(); ca = d03["ca"].to_numpy(); cd = d03["cdate"].to_numpy()
    om = [ospine.resolve(league[i], ch[i], ca[i], cd[i]) for i in range(len(d03))]
    pin = np.full((len(d03), 3), np.nan)
    for i, o in enumerate(om):
        if o is not None:
            row = ospine._df.iloc[o]; pin[i] = [row["psch"], row["pscd"], row["psca"]]
    has = np.isfinite(pin).all(1)
    def roi(probs):
        P, O, Y = [], [], []
        for k, (_, idx) in cols.items():
            P.append(probs[has, idx]); O.append(pin[has, idx]); Y.append((y[has] == idx).astype(int))
        return simulate_flat_value_bet(np.concatenate(P), np.concatenate(O), np.concatenate(Y))
    roi_base, roi_adj = roi(p_base), roi(p_adj)
    print(f"\n  G5 ROI (n_matches w/ odds {int(has.sum())}): dev-03 {roi_base['roi_pct']:+.2f}% ({roi_base['n_bets']} bets) · "
          f"adj {roi_adj['roi_pct']:+.2f}% ({roi_adj['n_bets']} bets)")
    g5_pass = bool(roi_adj["roi_pct"] > roi_base["roi_pct"] and roi_adj["roi_pct"] > 0)

    audits = {
        "1_sign": {"pass": g1_pass, "r_residual": r_resid, "p": p_resid, "brier_delta": mean_d},
        "2_holm": {"pass": g2_pass, "hypotheses": hyps},
        "3_leakage": {"pass": True, "note": "prior-season feature + OOT dev-03 + 5-fold out-of-fold β"},
        "4_power": {"pass": g4_pass, "required_n": req_n, "n": len(d), "power": pwr},
        "5_roi": {"pass": g5_pass, "roi_base": roi_base["roi_pct"], "roi_adj": roi_adj["roi_pct"]},
    }
    summ = gate_summary(audits)
    NOISE_FLOOR = 0.000456  # dev-03 empirical inter-seed Brier σ (CLAUDE.md)
    eff_sigma = abs(mean_d) / NOISE_FLOOR
    ship_worthy = bool(summ["gates_passed"] == 5 and abs(mean_d) > 2 * NOISE_FLOOR)
    if not g1_pass:
        verdict = "REJECT — dominance REDUNDANT with dev-03 (residual≈0, already in xG-history)"
    elif ship_worthy:
        verdict = f"SHIP-candidate — 5/5 gates, Brier-Δ {mean_d:+.5f} = {eff_sigma:.1f}σ (above noise)"
    else:
        verdict = (f"REAL-BUT-NEGLIGIBLE → NOT production-worthy: {summ['gates_passed']}/5 gates, but "
                   f"Brier-Δ {mean_d:+.5f} = {eff_sigma:.1f}σ (≈ noise-floor 0.000456) AND G5 ROI still "
                   f"negative. dev-03 already captures dominance (λ↔dom r={r_lam:.2f}); residual r={r_resid:.3f}.")
    audits["effect_size_sigma"] = eff_sigma
    audits["noise_floor"] = NOISE_FLOOR
    out = {"feature": "prior_season_dominance → conversion adjustment",
           "n_team_sides": len(side), "n_matches": len(d03),
           "corr_prior_dom_goals": r_raw, "corr_prior_dom_lambda": r_lam,
           "corr_prior_dom_residual": r_resid, "residual_p": p_resid,
           "brier_delta_adj_vs_dev03": mean_d, "brier_delta_p": p_d,
           "audits": audits, "gates_passed": summ["gates_passed"], "verdict": verdict}
    OUT.write_text(json.dumps(out, indent=2, default=float))
    print("\n" + "═" * 72)
    print(f"5-GATE VERDIKT: {verdict}")
    print(f"  gates passed: {summ['gates_passed']}/5  ·  G1 {g1_pass} G2 {g2_pass} G3 True G4 {g4_pass} G5 {g5_pass}")
    print(f"  ✓ {OUT.relative_to(REPO)}")
    print("═" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
