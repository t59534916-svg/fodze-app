#!/usr/bin/env python3
"""Granular re-verification of the calibration mis-fit finding.

Checks (on the SAME real-TS calibrated rows): (1) ECE implementation via a 2nd
method (per-class) + a per-bin reliability table for v2; (2) does the DEAD
per-league Platt JSON fix v2, or hurt it too (changes the fix recommendation);
(3) is benterBlend truly identity for the parquet engines (so 'calibrate1X2(raw)'
is accurate).
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

REPO = Path(__file__).resolve().parents[2]
BT = REPO / "tools" / "backtest"
raw_rows = json.loads((BT / ".engine_raw.json").read_text())          # engine, league, ft_result, raw
cal_blob = json.loads((BT / ".engine_calib_rows.json").read_text())   # rows: engine, ft_result, raw, cal
cal_rows = cal_blob["rows"]
assert len(raw_rows) == len(cal_rows), "row misalignment"
curves = json.loads((REPO / "public" / "calibration_curves.json").read_text())
benter = json.loads((REPO / "public" / "benter-weights.json").read_text())["engines"]
IDX = {"H": 0, "D": 1, "A": 2}


def ece_conf(P, Y, bins=10):
    conf = P.max(1); correct = (P.argmax(1) == Y).astype(float)
    edges = np.linspace(0, 1, bins + 1); e = 0.0; n = len(Y)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf >= lo) & (conf < hi) if hi < 1 else (conf >= lo) & (conf <= hi)
        if m.sum(): e += m.sum() / n * abs(correct[m].mean() - conf[m].mean())
    return e


def ece_classwise(P, Y, bins=10):
    """Mean over the 3 one-vs-rest class calibration errors (independent method)."""
    Y1h = np.eye(3)[Y]; edges = np.linspace(0, 1, bins + 1); tot = 0.0
    for c in range(3):
        p = P[:, c]; y = Y1h[:, c]; e = 0.0; n = len(Y)
        for lo, hi in zip(edges[:-1], edges[1:]):
            m = (p >= lo) & (p < hi) if hi < 1 else (p >= lo) & (p <= hi)
            if m.sum(): e += m.sum() / n * abs(y[m].mean() - p[m].mean())
        tot += e
    return tot / 3


def platt(p, ab):
    a, b = ab["a"], ab["b"]; p = np.clip(p, 1e-6, 1 - 1e-6)
    return 1 / (1 + np.exp(a * np.log(p / (1 - p)) + b))


def apply_league_platt(raw, league):
    """Mirror src/lib/calibration.ts platt path (per-league override → global)."""
    out = np.empty_like(raw)
    for i, mk in enumerate(["H", "D", "A"]):
        lp = (curves.get("platt_params_league", {}).get(league) or {}).get(mk) or curves["platt_params"][mk]
        out[:, i] = platt(raw[:, i], lp)
    s = out.sum(1, keepdims=True)
    return out / np.where(s > 0, s, 1)


def benter_apply(raw, engine):
    """Replicate benterBlend for the parquet engines (pinn=null → passthrough
    unless weights pull; v2 global=(1,0) → identity). Returns (out, n_changed)."""
    e = benter.get("ensemble" if engine == "Standard" else engine)
    # pinnacleImplied is null in our harness → benterBlend returns model unchanged
    return raw.copy(), 0  # by-construction passthrough (null pinn); verified below


def main():
    leagues = np.array([r["league"] for r in raw_rows])
    engines = np.array([r["engine"] for r in raw_rows])
    Raw = np.array([r["raw"] for r in cal_rows])
    Cal = np.array([r["cal"] for r in cal_rows])
    Y = np.array([IDX[r["ft_result"]] for r in cal_rows])

    print("═" * 78)
    print("  GRANULAR CALIBRATION RE-CHECK")
    print("═" * 78)

    # (3) benter identity: confirm benterBlend(raw, null pinn) == raw for v2 by re-deriving
    #     — our TS driver passed pinn=null; with v2 β=(1,0) AND null pinn the blend is identity.
    #     Cross-check: raw (from .engine_raw) == raw echoed in .engine_calib_rows (post-benter input).
    raw_src = np.array([r["raw"] for r in raw_rows])
    benter_identity = np.allclose(raw_src, Raw, atol=1e-9)
    print(f"\n  (3) benter identity (raw == driver's pre-calibration input): {benter_identity}")
    print(f"      → 'calibrate1X2(raw)' framing is {'ACCURATE' if benter_identity else 'WRONG — benter moved probs'}")

    # (1) ECE two ways + per-bin reliability for v2
    for eng in ["Standard", "v1", "v2"]:
        m = engines == eng
        pr, pc, y = Raw[m], Cal[m], Y[m]
        print(f"\n  (1) {eng}  n={m.sum()}")
        print(f"      Brier raw {((pr-np.eye(3)[y])**2).sum(1).mean():.4f} → cal {((pc-np.eye(3)[y])**2).sum(1).mean():.4f}")
        print(f"      ECE(confidence) raw {ece_conf(pr,y):.4f} → cal {ece_conf(pc,y):.4f}")
        print(f"      ECE(classwise)  raw {ece_classwise(pr,y):.4f} → cal {ece_classwise(pc,y):.4f}  (independent method)")

    # per-bin reliability for v2 (granular — where does calibration distort?)
    m = engines == "v2"; pr, pc, y = Raw[m], Cal[m], Y[m]
    print(f"\n  (1b) v2 reliability by confidence bin (raw vs cal):")
    print(f"      {'bin':<12}{'n_raw':>7}{'acc_raw':>9}{'conf_raw':>9}   {'n_cal':>7}{'acc_cal':>9}{'conf_cal':>9}")
    for lo, hi in [(0.4,0.5),(0.5,0.6),(0.6,0.7),(0.7,0.8),(0.8,1.0)]:
        def stat(P):
            conf=P.max(1); correct=(P.argmax(1)==y); mm=(conf>=lo)&(conf<hi)
            return (mm.sum(), correct[mm].mean() if mm.sum() else float('nan'), conf[mm].mean() if mm.sum() else float('nan'))
        nr,ar,cr = stat(pr); nc,ac,cc = stat(pc)
        print(f"      [{lo:.1f},{hi:.1f})    {nr:>7}{ar:>9.3f}{cr:>9.3f}   {nc:>7}{ac:>9.3f}{cc:>9.3f}")

    # (2) does the DEAD per-league Platt JSON fix v2, or hurt it too?
    platt_p = apply_league_platt(pr, None)  # global platt (per-league handled per-row below)
    # per-row per-league platt
    lv2 = leagues[m]
    platt_rows = np.array([apply_league_platt(pr[i:i+1], lv2[i])[0] for i in range(len(pr))])
    print(f"\n  (2) v2 under the DEAD per-league Platt JSON (the unused alternative):")
    print(f"      Brier  raw {((pr-np.eye(3)[y])**2).sum(1).mean():.4f} · hardcoded-iso {((pc-np.eye(3)[y])**2).sum(1).mean():.4f} · platt-JSON {((platt_rows-np.eye(3)[y])**2).sum(1).mean():.4f}")
    print(f"      ECE    raw {ece_conf(pr,y):.4f} · hardcoded-iso {ece_conf(pc,y):.4f} · platt-JSON {ece_conf(platt_rows,y):.4f}")
    pj_brier = ((platt_rows-np.eye(3)[y])**2).sum(1).mean(); raw_brier=((pr-np.eye(3)[y])**2).sum(1).mean()
    print(f"      → per-league Platt JSON {'ALSO HURTS v2 (≈ raw best → skip-calibration is the fix)' if pj_brier > raw_brier+0.002 else 'HELPS v2 (revive it instead of skipping!)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
