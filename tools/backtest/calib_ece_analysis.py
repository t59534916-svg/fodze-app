#!/usr/bin/env python3
"""Calibration mis-fit audit: per-engine RAW vs CALIBRATED Brier + ECE + sharpness.

The active production 1X2 calibration is the hardcoded GLOBAL isotonic curves in
src/lib/calibration.ts (CAL_H/D/A, "trained on 14,359 games 2017-2025" — the
ensemble/DC era), applied to every engine's Kelly/edge track. The decisive
question is NOT Brier alone but ECE (calibration error):
  - cal ECE < raw ECE  → calibration IMPROVES reliability (a sharpness trade-off,
                          arguably fine for Kelly even if Brier rises).
  - cal ECE >= raw ECE → calibration WORSENS (or fails to help) reliability while
                          also raising Brier → a genuine DEFECT for that engine.

Input: tools/backtest/.engine_calib_rows.json (from engine_per_row_calib.mts).
Run:   tools/venv/bin/python3 tools/backtest/calib_ece_analysis.py
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
IN = REPO / "tools" / "backtest" / ".engine_calib_rows.json"
OUT = REPO / "tools" / "backtest" / "calib-ece-audit.json"
IDX = {"H": 0, "D": 1, "A": 2}


def brier(P, Y):
    Y1h = np.eye(3)[Y]
    return float(((P - Y1h) ** 2).sum(1).mean())


def ece(P, Y, bins=10):
    """Confidence ECE: bin by max-prob, |accuracy - confidence| weighted."""
    conf = P.max(1)
    correct = (P.argmax(1) == Y).astype(float)
    edges = np.linspace(0, 1, bins + 1)
    e = 0.0
    n = len(Y)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf >= lo) & (conf < hi) if hi < 1 else (conf >= lo) & (conf <= hi)
        if m.sum() == 0:
            continue
        e += (m.sum() / n) * abs(correct[m].mean() - conf[m].mean())
    return float(e)


def main() -> int:
    blob = json.loads(IN.read_text())
    print("═" * 74)
    print(f"  CALIBRATION MIS-FIT AUDIT — active method = {blob['active_method']}")
    print("  (hardcoded global isotonic curves in calibration.ts, ensemble-era)")
    print("═" * 74)
    by = defaultdict(lambda: {"raw": [], "cal": [], "y": []})
    for r in blob["rows"]:
        by[r["engine"]]["raw"].append(r["raw"])
        by[r["engine"]]["cal"].append(r["cal"])
        by[r["engine"]]["y"].append(IDX[r["ft_result"]])

    print(f"\n  {'engine':<10}{'n':>6}{'Brier raw':>11}{'Brier cal':>11}{'BΔ':>8}"
          f"{'ECE raw':>9}{'ECE cal':>9}{'ECEΔ':>8}{'sharp r→c':>12}  verdict")
    res = {}
    for eng, d in by.items():
        Praw = np.array(d["raw"]); Pcal = np.array(d["cal"]); Y = np.array(d["y"])
        br, bc = brier(Praw, Y), brier(Pcal, Y)
        er, ec = ece(Praw, Y), ece(Pcal, Y)
        sr, sc = float(Praw.max(1).mean()), float(Pcal.max(1).mean())
        # defect = calibration both raises Brier AND fails to reduce ECE
        defect = (bc > br + 0.002) and (ec >= er - 0.002)
        verdict = "DEFECT (worse Brier, no ECE gain)" if defect else (
            "ECE-improved (sharpness trade)" if ec < er - 0.002 else "~neutral")
        res[eng] = {"n": len(Y), "brier_raw": round(br, 4), "brier_cal": round(bc, 4),
                    "brier_delta": round(bc - br, 4), "ece_raw": round(er, 4),
                    "ece_cal": round(ec, 4), "ece_delta": round(ec - er, 4),
                    "sharp_raw": round(sr, 3), "sharp_cal": round(sc, 3), "defect": defect, "verdict": verdict}
        print(f"  {eng:<10}{len(Y):>6}{br:>11.4f}{bc:>11.4f}{bc-br:>+8.4f}"
              f"{er:>9.4f}{ec:>9.4f}{ec-er:>+8.4f}{sr:>6.2f}→{sc:<5.2f}  {verdict}")

    print("\n" + "─" * 74)
    defects = [e for e, r in res.items() if r["defect"]]
    print(f"  Engines where calibration is a DEFECT (worse Brier + no ECE benefit): "
          f"{', '.join(defects) if defects else 'none'}")
    # the v2 case is the one that matters (v2 + dev-03 are the sharp production engines)
    if "v2" in res:
        v = res["v2"]
        print(f"\n  v2 (sharp engine, dev-03 behaves like it): Brier {v['brier_raw']}→{v['brier_cal']} "
              f"({v['brier_delta']:+}), ECE {v['ece_raw']}→{v['ece_cal']} ({v['ece_delta']:+}).")
        if v["defect"]:
            print("  → The ensemble-era curves DISTORT v2's already-good calibration. Refit per-engine"
                  "\n    (or use the dead per-league Platt, or bypass calibration for sharp engines).")
        else:
            print("  → Calibration improves v2's ECE — the Brier rise is a sharpness/reliability trade,"
                  "\n    defensible for Kelly. NOT a clear defect; weigh carefully before changing.")
    OUT.write_text(json.dumps(res, indent=2))
    print(f"\n  ✓ {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
