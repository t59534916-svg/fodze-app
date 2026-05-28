#!/usr/bin/env python3
"""decision_thresholds — when to CALL a win / draw, from the calibrated probs.

The conversion/calibration work established the engine probabilities are
well-calibrated (P(draw) 26%≈26% actual; home-win reliability tracks the
diagonal). So thresholds on the probs are trustworthy. This turns that into
actionable decision rules for "ab wann Sieg / ab wann Unentschieden".

Key structural fact (from the draw analysis): P(draw) ceilings ~0.35 — a draw is
NEVER the single most-likely outcome. So:
  - WIN call  → reliability threshold on P(home)/P(away).
  - DRAW call → only as VALUE (model P > market-implied) or a CLOSENESS flag
                (|λ_h−λ_a| small + low total λ); never as a "favorite" pick.

Computes on 25/26 (Blend = 50/50 dev-03⊕dev-09, the recommended forecaster):
  1. Reliability bands: P(outcome) band → actual rate + n  (where a call is safe)
  2. Closeness: |λ_h−λ_a| buckets → actual draw rate
  3. Value: model_P − Pinnacle-implied edge → flat ROI by min-edge, per outcome
  4. Recommended thresholds

Outputs (tools/v4/diagnostics/):
  decision_thresholds.json · decision_thresholds.png
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/decision_thresholds.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

import score_xg_forecast as X
from score_roi_leaderboard import OddsSpine
from v4.modules.m3_xg import DEFAULT_RHO
from v4.utils.falsification_protocol import simulate_flat_value_bet

D = REPO / "tools" / "v4" / "diagnostics"
OUT = D / "decision_thresholds.json"
RHO = DEFAULT_RHO
C_H, C_D, C_A, C_OK = "#3a7ca5", "#c9a227", "#b5483d", "#4f8a3d"
OUTC = {"Heimsieg": ("H", 0, C_H), "Remis": ("D", 1, C_D), "Auswärtssieg": ("A", 2, C_A)}


def main() -> int:
    eng = X.corpus_engines(("25/26",), RHO)
    d09, d03 = eng["dev-09"], eng["dev-03"]
    lhB = 0.5 * d09["lam_h"].to_numpy(float) + 0.5 * d03["lam_h"].to_numpy(float)
    laB = 0.5 * d09["lam_a"].to_numpy(float) + 0.5 * d03["lam_a"].to_numpy(float)
    p = X._lambdas_to_1x2(np.clip(lhB, X.LAMBDA_MIN, X.LAMBDA_MAX), np.clip(laB, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
    y = np.array([X._outcome(h, a) for h, a in zip(d09["y_h"], d09["y_a"])])
    gap = np.abs(lhB - laB)
    n = len(y)
    print(f"  {n:,} matches (Blend probs)")

    # Pinnacle for value
    osp = OddsSpine()
    league, ch, ca, cd = (d09[c].to_numpy() for c in ("league", "ch", "ca", "cdate"))
    pin = np.full((n, 3), np.nan)
    for i in range(n):
        o = osp.resolve(league[i], ch[i], ca[i], cd[i])
        if o is not None:
            r = osp._df.iloc[o]; pin[i] = [r["psch"], r["pscd"], r["psca"]]
    has = np.isfinite(pin).all(1)
    print(f"  {int(has.sum()):,} with Pinnacle odds")

    res = {"n": n, "n_odds": int(has.sum())}

    # ── 1. reliability bands ──
    print("\n" + "─" * 64)
    print("1 · RELIABILITÄT — P(Ausgang)-Band → tatsächliche Rate")
    print("─" * 64)
    bands = [(0.0, 0.35), (0.35, 0.45), (0.45, 0.55), (0.55, 0.65), (0.65, 1.01)]
    rel = {}
    for name, (lbl, idx, _) in OUTC.items():
        rel[name] = []
        print(f"  {name}:")
        for lo, hi in bands:
            m = (p[:, idx] >= lo) & (p[:, idx] < hi)
            if m.sum() < 15:
                continue
            rate = float((y[m] == idx).mean())
            rel[name].append({"band": f"{lo:.2f}-{hi:.2f}", "n": int(m.sum()),
                              "mean_pred": float(p[m, idx].mean()), "actual_rate": rate})
            print(f"    P {lo:.2f}-{hi:.2f}: n={int(m.sum()):>4}  Ø vorherg {p[m,idx].mean():.2f}  ist {rate:.2f}")
    res["reliability"] = rel

    # ── 2. closeness → draw rate ──
    print("\n" + "─" * 64)
    print("2 · CLOSENESS |λ_h−λ_a| → Remis-Rate (Remis-Kandidat-Flag)")
    print("─" * 64)
    cb = [("<0.15", gap < 0.15), ("0.15-0.40", (gap >= 0.15) & (gap < 0.40)),
          ("0.40-0.80", (gap >= 0.40) & (gap < 0.80)), (">0.80", gap >= 0.80)]
    close = []
    for lbl, m in cb:
        if m.sum() < 15:
            continue
        dr = float((y[m] == 1).mean()); pd_ = float(p[m, 1].mean())
        close.append({"bucket": lbl, "n": int(m.sum()), "mean_p_draw": pd_, "draw_rate": dr})
        print(f"  |λ_h−λ_a| {lbl:<10} n={int(m.sum()):>4}  Ø P(Remis) {pd_:.2f}  ist-Remis {dr:.2f}")
    res["closeness"] = close

    # ── 3. value ROI by min-edge, per outcome ──
    print("\n" + "─" * 64)
    print("3 · VALUE — Modell-P > Pinnacle-implizit + Edge → flat ROI")
    print("─" * 64)
    edges = [0.0, 0.02, 0.04, 0.06, 0.08]
    val = {}
    ph, po, py = p[has], pin[has], y[has]
    for name, (lbl, idx, _) in OUTC.items():
        val[name] = []
        line = f"  {name:<13}"
        for e in edges:
            sim = simulate_flat_value_bet(ph[:, idx], po[:, idx], (py == idx).astype(int), min_edge_pp=e * 100)
            val[name].append({"min_edge_pp": e * 100, **sim})
            line += f"  E≥{int(e*100)}pp:{sim['roi_pct']:+5.1f}%(n{sim['n_bets']})"
        print(line)
    res["value_roi"] = val

    # ── 4. recommended thresholds ──
    def first_above(name, target):
        for b in rel[name]:
            if b["actual_rate"] >= target and b["n"] >= 30:
                return b["band"], b["actual_rate"], b["n"]
        return None
    rec = {
        "win_call_home": first_above("Heimsieg", 0.55),
        "win_call_away": first_above("Auswärtssieg", 0.50),
        "draw_note": "P(Remis) deckelt ~0.35 → nie Favorit; Remis nur via Value oder Closeness",
        "draw_value_edge_pp": next((v["min_edge_pp"] for v in val["Remis"] if v["roi_pct"] > 0 and v["n_bets"] >= 30), None),
        "draw_prone_flag": "|λ_h−λ_a| < 0.15  (Remis-Rate " + (f"{close[0]['draw_rate']:.0%}" if close else "?") + ")",
    }
    res["recommended"] = rec
    print("\n" + "─" * 64)
    print("4 · EMPFEHLUNG")
    print("─" * 64)
    print(f"  Heimsieg-Tipp ab:  {rec['win_call_home']}")
    print(f"  Auswärts-Tipp ab:  {rec['win_call_away']}")
    print(f"  Remis: {rec['draw_note']}")
    print(f"    Remis-Value ab Edge: {rec['draw_value_edge_pp']} pp · Remis-prone: {rec['draw_prone_flag']}")

    # ── figure ──
    fig = plt.figure(figsize=(17, 5.6))
    gs = GridSpec(1, 3, wspace=0.26)
    axA = fig.add_subplot(gs[0, 0])
    for name, (lbl, idx, col) in OUTC.items():
        xs = [b["mean_pred"] for b in rel[name]]; ys = [b["actual_rate"] for b in rel[name]]
        axA.plot(xs, ys, "o-", color=col, label=name, lw=2)
    axA.plot([0, 1], [0, 1], "--", color="#999", lw=1.2)
    axA.axhline(0.5, color="#bbb", lw=0.8, ls=":")
    axA.set_xlabel("Vorhergesagte P(Ausgang)"); axA.set_ylabel("Tatsächliche Rate")
    axA.set_title("1 · Reliabilität: ab welchem P ist ein Tipp sicher?", fontweight="bold", fontsize=11)
    axA.legend(fontsize=9); axA.grid(alpha=0.25)
    axB = fig.add_subplot(gs[0, 1])
    xs = [c["bucket"] for c in close]
    axB.bar(xs, [c["draw_rate"] for c in close], color=C_D, alpha=0.85, label="ist-Remis")
    axB.plot(xs, [c["mean_p_draw"] for c in close], "ko-", label="Ø P(Remis)")
    axB.axhline(0.35, color=C_A, ls="--", lw=1.2, label="P(Remis)-Decke ~0.35")
    axB.set_xlabel("|λ_h − λ_a| (Ausgeglichenheit)"); axB.set_ylabel("Remis-Rate")
    axB.set_title("2 · Remis-Kandidat: enge λ → mehr Remis", fontweight="bold", fontsize=11)
    axB.legend(fontsize=8); axB.grid(alpha=0.2, axis="y")
    axC = fig.add_subplot(gs[0, 2])
    for name, (lbl, idx, col) in OUTC.items():
        axC.plot([v["min_edge_pp"] for v in val[name]], [v["roi_pct"] for v in val[name]], "o-", color=col, label=name, lw=2)
    axC.axhline(0, color="#999", ls="--", lw=1.2)
    axC.set_xlabel("Min-Edge (Modell-P − Markt) pp"); axC.set_ylabel("flat ROI %")
    axC.set_title("3 · Value: ab welchem Edge lohnt der Tipp?\n(alle <0 = Pinnacle schlägt uns)", fontweight="bold", fontsize=11)
    axC.legend(fontsize=9); axC.grid(alpha=0.25)
    fig.suptitle("FODZE · Entscheidungs-Schwellen: Sieg vs. Unentschieden (Blend, 25/26, kalibrierte Probs)",
                 fontsize=13, fontweight="bold")
    fig.savefig(D / "decision_thresholds.png", dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)

    OUT.write_text(json.dumps(res, indent=2, default=float))
    print(f"\n  ✓ {OUT.relative_to(REPO)} · decision_thresholds.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
