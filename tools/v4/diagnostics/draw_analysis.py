#!/usr/bin/env python3
"""draw_analysis — does the model under-predict draws, or is it just argmax?

User observation: "we never tip X (draw) because argmax only picks draw when
λ_home ≈ λ_away exactly". Two separate questions, answered empirically on 25/26:

  (1) ARGMAX ARTIFACT — how often is draw the single most-likely outcome?
      (Expected: rarely — draw is rarely the modal 1X2 outcome.)
  (2) PROBABILITY CALIBRATION — is mean P(draw) ≈ actual draw rate, or does
      the model UNDER-predict draws (the classic Poisson/Dixon-Coles flaw)?
  (3) CLOSE-GAME TEST — among balanced λ (|λ_h-λ_a| small), what is the actual
      draw rate vs the model's P(draw)? (The user's "1.2 vs 1.1 = draw-likely".)

Output: tools/v4/diagnostics/draw_analysis.json
Run:    tools/venv/bin/python3 -I tools/v4/diagnostics/draw_analysis.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import score_xg_forecast as X
from v4.modules.m3_xg import DEFAULT_RHO

OUT = REPO / "tools" / "v4" / "diagnostics" / "draw_analysis.json"
RHO = DEFAULT_RHO


def main() -> int:
    eng = X.corpus_engines(("25/26",), RHO)
    d09, d03 = eng["dev-09"], eng["dev-03"]
    lhB = 0.5 * d09["lam_h"].to_numpy(float) + 0.5 * d03["lam_h"].to_numpy(float)
    laB = 0.5 * d09["lam_a"].to_numpy(float) + 0.5 * d03["lam_a"].to_numpy(float)
    pB = X._lambdas_to_1x2(np.clip(lhB, X.LAMBDA_MIN, X.LAMBDA_MAX), np.clip(laB, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
    p03 = d03[["p_h", "p_d", "p_a"]].to_numpy(float)
    p09 = d09[["p_h", "p_d", "p_a"]].to_numpy(float)
    yh, ya = d09["y_h"].to_numpy(), d09["y_a"].to_numpy()
    y = np.array([X._outcome(h, a) for h, a in zip(yh, ya)], dtype=int)
    n = len(y)
    draw_rate = float((y == 1).mean())

    print("═" * 72)
    print(f"REMIS-ANALYSE · 25/26 · n={n:,}")
    print("═" * 72)
    print(f"  Tatsächliche Verteilung: Heim {100*(y==0).mean():.1f}% · "
          f"REMIS {100*draw_rate:.1f}% · Auswärts {100*(y==2).mean():.1f}%")
    print()

    engines = {"dev-03": p03, "dev-09": p09, "Blend": pB}
    res = {"n": n, "actual_draw_rate": draw_rate, "engines": {}}

    print(f"  {'Engine':<8} {'tippt X':>8} {'Ø P(X)':>8} {'IstRemis':>9} {'maxP(X)':>8} {'X-Brier':>8}")
    for name, p in engines.items():
        argmax = p.argmax(1)
        tip_x = float((argmax == 1).mean())
        mean_px = float(p[:, 1].mean())
        max_px = float(p[:, 1].max())
        draw_brier = float(np.mean((p[:, 1] - (y == 1).astype(float)) ** 2))
        res["engines"][name] = {
            "tip_x_rate": tip_x, "mean_p_draw": mean_px, "max_p_draw": max_px,
            "actual_draw_rate": draw_rate, "draw_brier": draw_brier,
            "calibration_gap": mean_px - draw_rate,
            "tip_h_rate": float((argmax == 0).mean()), "tip_a_rate": float((argmax == 2).mean()),
        }
        print(f"  {name:<8} {100*tip_x:>7.1f}% {mean_px:>8.3f} {draw_rate:>8.3f} {max_px:>8.3f} {draw_brier:>8.4f}")
    print()
    print("  → Ø P(X) vs Ist-Remisrate = Kalibrierung. tippt-X = wie oft argmax=Remis.")
    print()

    # ── draw reliability (Blend) ──
    print("─" * 72)
    print("  REMIS-KALIBRIERUNG (Blend): vorhergesagte P(X)-Bins vs. Ist-Remisrate")
    print("─" * 72)
    px = pB[:, 1]
    edges = [0, 0.20, 0.24, 0.27, 0.30, 0.33, 1.0]
    rel = []
    print(f"  {'P(X)-Bin':>12} {'n':>5} {'Ø vorherg.':>11} {'Ist-Remis':>10}")
    for lo, hi in zip(edges[:-1], edges[1:]):
        b = (px >= lo) & (px < hi)
        if b.sum() < 10:
            continue
        pred = float(px[b].mean()); act = float((y[b] == 1).mean())
        rel.append({"bin": f"{lo:.2f}-{hi:.2f}", "n": int(b.sum()), "pred": pred, "actual": act})
        print(f"  {lo:.2f}-{hi:.2f}  {int(b.sum()):>5} {pred:>11.3f} {act:>10.3f}")
    res["draw_reliability_blend"] = rel
    print()

    # ── close-game test (Blend) ──
    print("─" * 72)
    print("  CLOSE-GAME-TEST (Blend): |λ_h − λ_a| Buckets")
    print("─" * 72)
    gap = np.abs(lhB - laB)
    buckets = [("sehr ausgeglichen <0.2", gap < 0.2),
               ("ausgeglichen 0.2-0.5", (gap >= 0.2) & (gap < 0.5)),
               ("klar >0.5", gap >= 0.5)]
    cg = []
    print(f"  {'Bucket':<24} {'n':>5} {'Ø P(X)':>8} {'IstRemis':>9} {'tippt X':>8}")
    for lbl, b in buckets:
        if b.sum() < 10:
            continue
        mp = float(pB[b, 1].mean()); ar = float((y[b] == 1).mean())
        tx = float((pB[b].argmax(1) == 1).mean())
        cg.append({"bucket": lbl, "n": int(b.sum()), "mean_p_draw": mp, "actual_draw_rate": ar, "tip_x_rate": tx})
        print(f"  {lbl:<24} {int(b.sum()):>5} {mp:>8.3f} {ar:>8.3f} {100*tx:>7.1f}%")
    res["close_game_blend"] = cg
    print()

    # ── verdict ──
    gap_bl = res["engines"]["Blend"]["calibration_gap"]
    if abs(gap_bl) < 0.015:
        verdict = (f"PROBABILITY OK — Blend Ø P(X) {res['engines']['Blend']['mean_p_draw']:.3f} ≈ Ist {draw_rate:.3f} "
                   f"(Gap {gap_bl:+.3f}). Das 'keine Remis'-Problem ist ein ARGMAX-Artefakt, kein Modellfehler. "
                   f"Remis sind als WAHRSCHEINLICHKEIT korrekt — nur selten das Einzelmaximum.")
    elif gap_bl < 0:
        verdict = (f"UNTERSCHÄTZUNG — Blend Ø P(X) {res['engines']['Blend']['mean_p_draw']:.3f} < Ist {draw_rate:.3f} "
                   f"(Gap {gap_bl:+.3f}). Das Modell vergibt zu wenig Remis-Wkt (klassischer DC-Bias) → "
                   f"ρ-Tuning oder Draw-Kalibrierung könnte helfen.")
    else:
        verdict = f"ÜBERSCHÄTZUNG — Ø P(X) > Ist (Gap {gap_bl:+.3f}), ungewöhnlich."
    res["verdict"] = verdict
    print("═" * 72)
    print("VERDIKT:", verdict)
    print("═" * 72)
    OUT.write_text(json.dumps(res, indent=2))
    print(f"  ✓ {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
