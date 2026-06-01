#!/usr/bin/env python3
"""Weg 2 — Welcher Markt trägt das SCHÄRFSTE Signal? (forecast-quality, nicht ROI)

Hypothese (user 2026-06-01): 1X2 erbt das volle Poisson-Tor-Rauschen. Aggregiertere
Märkte (Über/Unter 2.5, BTTS, Doppelte Chance) summieren über einen Teil dieser
Varianz → das Modell-Signal könnte dort einen HÖHEREN Skill-über-Null-Wissen haben.

Misst auf dem 25/26-OOT-Set (v2-oot-predictions.parquet, das messbare dev-03-Proxy)
PRO MARKT:
  - Brier (roh, zur Transparenz — aber NICHT marktübergreifend vergleichbar:
    1X2 ist 3-Klassen [0..2], die anderen binär [0..1])
  - **Brier-Skill-Score** BSS = 1 − Brier_modell / Brier_klimatologie  → DAS
    marktübergreifend vergleichbare Maß (unitless: Anteil des über blindem Raten
    der Basisrate extrahierten Skills). Klimatologie = per-Liga Basisrate, auf dem-
    selben Set gefittet (großzügiger Boden, identisch zu headroom_eval.py).
  - ECE (10 equal-width bins) für die binären Märkte (Kalibrierung).

Märkte: 1X2 (3-Klassen) · Ü/U 2.5 · BTTS · Doppelte Chance (1X/12/X2, je binär).
Reines Lesen aus dem Parquet — kein Retrain, Sommerpause irrelevant.
Output: /tmp/market_sharpness.json
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
PARQUET = REPO / "tools" / "backtest" / "v2-oot-predictions.parquet"
OUT = Path("/tmp/market_sharpness.json")
SEED = 20260601
N_BOOT = 2000


def brier_binary(p, y):
    return float(np.mean((p - y) ** 2))


def brier_multiclass(P, Y1h):
    return float(np.mean(np.sum((P - Y1h) ** 2, axis=1)))


def ece_binary(p, y, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    e, n = 0.0, len(p)
    for i in range(bins):
        m = (p >= edges[i]) & (p < edges[i + 1]) if i < bins - 1 else (p >= edges[i]) & (p <= edges[i + 1])
        if m.sum() == 0:
            continue
        e += (m.sum() / n) * abs(p[m].mean() - y[m].mean())
    return float(e)


def boot_bss(brier_model_per_row, brier_clim_per_row, rng):
    """Bootstrap CI of BSS = 1 - mean(model)/mean(clim)."""
    n = len(brier_model_per_row)
    vals = np.empty(N_BOOT)
    for b in range(N_BOOT):
        ix = rng.integers(0, n, n)
        bm = brier_model_per_row[ix].mean()
        bc = brier_clim_per_row[ix].mean()
        vals[b] = 1.0 - bm / bc if bc > 0 else 0.0
    lo, hi = np.percentile(vals, [2.5, 97.5])
    return float(lo), float(hi)


def main() -> int:
    df = pd.read_parquet(PARQUET)
    if "split_label" in df.columns:
        df = df[df["split_label"] == "oot-test"].copy()
    df = df.dropna(subset=["prob_h_raw", "prob_d_raw", "prob_a_raw",
                           "actual_h_goals", "actual_a_goals", "ft_result", "league"]).reset_index(drop=True)
    n = len(df)
    rng = np.random.default_rng(SEED)
    print("═" * 78)
    print(f"  MARKT-SCHÄRFE (forecast-quality)  ·  25/26 OOT  ·  n={n}")
    print("═" * 78)

    gh = df["actual_h_goals"].to_numpy(int)
    ga = df["actual_a_goals"].to_numpy(int)
    res = df["ft_result"].to_numpy(str)
    lg = df["league"].to_numpy(str)

    # normalise raw 1X2 to sum 1
    P = df[["prob_h_raw", "prob_d_raw", "prob_a_raw"]].to_numpy(float)
    P = P / P.sum(axis=1, keepdims=True)

    out = {"n": n, "markets": {}}

    def per_league_baseline(y_or_idx, kind):
        """Return per-row climatology prob using the row's league base rate."""
        base = np.zeros_like(P) if kind == "1x2" else np.zeros(n)
        for l in np.unique(lg):
            m = lg == l
            if kind == "1x2":
                # base rate of H/D/A in this league
                for k, lab in enumerate(["H", "D", "A"]):
                    base[m, k] = (res[m] == lab).mean()
            else:
                base[m] = y_or_idx[m].mean()
        return base

    # ── 1X2 (3-class) ──
    Y1h = np.zeros((n, 3))
    for i, r in enumerate(res):
        Y1h[i, {"H": 0, "D": 1, "A": 2}[r]] = 1.0
    clim_1x2 = per_league_baseline(None, "1x2")
    bm_rows = np.sum((P - Y1h) ** 2, axis=1)
    bc_rows = np.sum((clim_1x2 - Y1h) ** 2, axis=1)
    bss = 1.0 - bm_rows.mean() / bc_rows.mean()
    lo, hi = boot_bss(bm_rows, bc_rows, rng)
    out["markets"]["1X2"] = {"type": "3-class", "n": n,
                             "brier": float(bm_rows.mean()), "brier_clim": float(bc_rows.mean()),
                             "bss": float(bss), "bss_ci95": [lo, hi]}

    def add_binary(name, p, y):
        p = np.asarray(p, float); y = np.asarray(y, float)
        ok = ~np.isnan(p)
        p, y, lg_ = p[ok], y[ok], lg[ok]
        nn = len(p)
        # per-league base rate climatology
        clim = np.zeros(nn)
        for l in np.unique(lg_):
            m = lg_ == l
            clim[m] = y[m].mean()
        bm_rows = (p - y) ** 2
        bc_rows = (clim - y) ** 2
        bss = 1.0 - bm_rows.mean() / bc_rows.mean() if bc_rows.mean() > 0 else 0.0
        lo, hi = boot_bss(bm_rows, bc_rows, np.random.default_rng(SEED))
        out["markets"][name] = {"type": "binary", "n": int(nn),
                                "brier": float(bm_rows.mean()), "brier_clim": float(bc_rows.mean()),
                                "bss": float(bss), "bss_ci95": [lo, hi],
                                "ece": ece_binary(p, y), "base_rate": float(y.mean())}

    # ── Ü/U 2.5 ──
    if "prob_o25_raw" in df.columns:
        y_over = ((gh + ga) >= 3).astype(float)
        add_binary("Ü/U2.5", df["prob_o25_raw"].to_numpy(float), y_over)
    # ── BTTS ──
    if "prob_btts_raw" in df.columns:
        y_btts = ((gh > 0) & (ga > 0)).astype(float)
        add_binary("BTTS", df["prob_btts_raw"].to_numpy(float), y_btts)
    # ── Double Chance (derived from 1X2) ──
    add_binary("DC-1X", P[:, 0] + P[:, 1], np.isin(res, ["H", "D"]).astype(float))
    add_binary("DC-12", P[:, 0] + P[:, 2], np.isin(res, ["H", "A"]).astype(float))
    add_binary("DC-X2", P[:, 1] + P[:, 2], np.isin(res, ["D", "A"]).astype(float))

    OUT.write_text(json.dumps(out, indent=2))

    print(f"  {'Markt':<10}{'Typ':<9}{'n':>6}{'Brier':>9}{'Brier_clim':>12}{'BSS':>9}  {'BSS CI95':>20}  {'ECE':>7}")
    for name, d in out["markets"].items():
        ci = d.get("bss_ci95", [float('nan'), float('nan')])
        ece = f"{d['ece']:.4f}" if "ece" in d else "   —  "
        robust = "robust+" if ci[0] > 0 else ("≈0" if ci[1] > 0 else "neg")
        print(f"  {name:<10}{d['type']:<9}{d['n']:>6}{d['brier']:>9.4f}{d['brier_clim']:>12.4f}"
              f"{d['bss']:>9.4f}  [{ci[0]:+.4f},{ci[1]:+.4f}] {robust:<7}  {ece:>7}")
    print("\n  BSS = Anteil des über blindem Basisraten-Raten extrahierten Skills (höher=schärfer).")
    print("  Vergleichbar ÜBER Märkte (unitless); roher Brier NICHT (3-Klassen vs binär).")
    print(f"  ✓ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
