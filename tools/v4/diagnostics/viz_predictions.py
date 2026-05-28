#!/usr/bin/env python3
"""viz_predictions — visual report: what was predicted, how, how accurately,
and which odds, vs reality (25/26 holdout).

Engines: dev-03, dev-09, and the recommended 50/50 λ-Blend. Panels:
  A  Predicted total-xG vs realized total-xG (Blend)            → "wie genau" (xG)
  B  Reliability of P(home win): predicted vs observed          → "wie genau" (Wkt)
  C  Predicted fair home-odds vs Pinnacle closing               → "welche Quoten"
  D  Engine accuracy bars: xG-RMSE + Brier                      → comparison
  E  Odds calibration: implied vs actual home-win % by bucket   → odds accuracy
  F  Sample matches: predicted 1/X/2 odds + total-xG vs result  → "welche Ergebnisse"

Output: tools/v4/diagnostics/viz_predictions.png

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/viz_predictions.py
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

import score_xg_forecast as X
from score_roi_leaderboard import OddsSpine
from v4.modules.m3_xg import DEFAULT_RHO

OUT = REPO_ROOT / "tools" / "v4" / "diagnostics" / "viz_predictions.png"
RHO = DEFAULT_RHO

# FODZE-ish palette
C_D03, C_D09, C_BLEND = "#3a7ca5", "#d98c3f", "#c9a227"
C_OK, C_BAD, C_GRID = "#5a9e45", "#b5483d", "#cccccc"
ALPHA = 0.5  # blend weight


def main() -> int:
    print("Building 25/26 predictions for visualization...")
    eng = X.corpus_engines(("25/26",), RHO)
    spine = X.XGSpine()
    ospine = OddsSpine()
    d09 = X.attach_realized_xg(eng["dev-09"], spine)
    d03 = X.attach_realized_xg(eng["dev-03"], spine)
    m = (d09["mid"] >= 0).to_numpy()

    lh09, la09 = d09["lam_h"].to_numpy(float), d09["lam_a"].to_numpy(float)
    lh03, la03 = d03["lam_h"].to_numpy(float), d03["lam_a"].to_numpy(float)
    lhB = ALPHA * lh09 + (1 - ALPHA) * lh03
    laB = ALPHA * la09 + (1 - ALPHA) * la03
    pB = X._lambdas_to_1x2(np.clip(lhB, X.LAMBDA_MIN, X.LAMBDA_MAX),
                           np.clip(laB, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
    p03 = d03[["p_h", "p_d", "p_a"]].to_numpy(float)
    p09 = d09[["p_h", "p_d", "p_a"]].to_numpy(float)

    rh, ra = d09["real_h"].to_numpy(float), d09["real_a"].to_numpy(float)
    yh, ya = d09["y_h"].to_numpy(), d09["y_a"].to_numpy()
    y = np.array([X._outcome(h, a) for h, a in zip(yh, ya)], dtype=int)
    y1h = np.eye(3)[y]
    league = d09["league"].to_numpy()
    ch, ca = d09["ch"].to_numpy(), d09["ca"].to_numpy()
    cdate = d09["cdate"].to_numpy()

    def rmse(a, b):
        return float(np.sqrt(np.mean((a - b) ** 2)))

    rs = np.concatenate([rh[m], ra[m]])
    # All metrics on the matched-xG subset [m] so both axes share the same n
    # (6,750) and the headline Brier matches the dossier/detail analysis.
    metrics = {
        "dev-03": (rmse(np.concatenate([lh03[m], la03[m]]), rs), float(((p03[m] - y1h[m]) ** 2).sum(1).mean())),
        "dev-09": (rmse(np.concatenate([lh09[m], la09[m]]), rs), float(((p09[m] - y1h[m]) ** 2).sum(1).mean())),
        "Blend":  (rmse(np.concatenate([lhB[m], laB[m]]), rs), float(((pB[m] - y1h[m]) ** 2).sum(1).mean())),
    }
    print(f"  matched n={m.sum():,}  metrics={metrics}")

    fig = plt.figure(figsize=(18, 15))
    fig.suptitle(f"FODZE — Engine-Vorhersagen vs. Realität · Saison 25/26 Holdout "
                 f"(n={m.sum():,} Spiele mit realisierter xG)\n"
                 f"Blend = 50% dev-03 (xG-Niveau) + 50% dev-09 (Ausgang)",
                 fontsize=15, fontweight="bold")
    gs = GridSpec(3, 3, figure=fig, height_ratios=[1, 1, 1.15], hspace=0.32, wspace=0.26,
                  left=0.06, right=0.97, top=0.90, bottom=0.04)

    # ── A: predicted total-xG vs realized ──
    axA = fig.add_subplot(gs[0, 0])
    tot_pred = (lhB + laB)[m]
    tot_real = (rh + ra)[m]
    tot_rmse = rmse(tot_pred, tot_real)  # RMSE on the plotted quantity (totals)
    hb = axA.hexbin(tot_real, tot_pred, gridsize=35, cmap="YlOrBr", mincnt=1)
    axA.plot([0, 6], [0, 6], "--", color=C_GRID, lw=1.5)
    axA.set_xlim(0, 6); axA.set_ylim(0, 6)
    axA.set_xlabel("Realisierte Gesamt-xG"); axA.set_ylabel("Vorhergesagte Gesamt-xG (Blend)")
    axA.set_title(f"A · Gesamt-xG-Genauigkeit  (RMSE {tot_rmse:.2f} · pro Seite {metrics['Blend'][0]:.3f})",
                  fontweight="bold", fontsize=11)
    fig.colorbar(hb, ax=axA, shrink=0.8, label="Spiele")

    # ── B: reliability of P(home win) ──
    axB = fig.add_subplot(gs[0, 1])
    home_won = (y == 0).astype(float)
    for name, p, col in [("dev-03", p03, C_D03), ("dev-09", p09, C_D09), ("Blend", pB, C_BLEND)]:
        ph = p[:, 0]
        bins = np.quantile(ph, np.linspace(0, 1, 11))
        bins[-1] += 1e-6
        idx = np.digitize(ph, bins[1:-1])
        xs, ys = [], []
        for b in range(10):
            mb = idx == b
            if mb.sum() < 10:
                continue
            xs.append(ph[mb].mean()); ys.append(home_won[mb].mean())
        axB.plot(xs, ys, "o-", color=col, label=name, lw=2 if name == "Blend" else 1.3,
                 ms=6 if name == "Blend" else 4, alpha=0.95 if name == "Blend" else 0.7)
    axB.plot([0, 1], [0, 1], "--", color=C_GRID, lw=1.5)
    axB.set_xlabel("Vorhergesagte P(Heimsieg)"); axB.set_ylabel("Beobachtete Heimsieg-Rate")
    axB.set_title("B · Kalibrierung P(Heimsieg)", fontweight="bold", fontsize=11)
    axB.legend(fontsize=9, loc="upper left")
    axB.grid(alpha=0.25)

    # ── C: predicted fair home-odds vs Pinnacle ──
    axC = fig.add_subplot(gs[0, 2])
    omid = np.array([ospine.resolve(league[i], ch[i], ca[i], cdate[i]) for i in range(len(d09))])
    has_o = np.array([(o is not None) for o in omid])
    pin_h = np.full(len(d09), np.nan)
    for i in range(len(d09)):
        if omid[i] is not None:
            pin_h[i] = ospine._df.iloc[omid[i]]["psch"]
    fair_h = 1.0 / np.clip(pB[:, 0], 1e-6, 1)
    sel = has_o & np.isfinite(pin_h) & (fair_h < 8) & (pin_h < 8)
    axC.scatter(pin_h[sel], fair_h[sel], s=8, alpha=0.3, color=C_BLEND, edgecolors="none")
    axC.plot([1, 8], [1, 8], "--", color=C_GRID, lw=1.5)
    axC.set_xlim(1, 8); axC.set_ylim(1, 8)
    axC.set_xlabel("Pinnacle Closing Heim-Quote"); axC.set_ylabel("Blend faire Heim-Quote (1/p)")
    axC.set_title(f"C · Vorhergesagte vs. Markt-Quoten  (n={sel.sum():,})", fontweight="bold", fontsize=11)
    axC.grid(alpha=0.25)

    # ── D: engine accuracy bars ──
    axD = fig.add_subplot(gs[1, 0])
    names = ["dev-03", "dev-09", "Blend"]
    cols = [C_D03, C_D09, C_BLEND]
    rmses = [metrics[n][0] for n in names]
    briers = [metrics[n][1] for n in names]
    xpos = np.arange(3)
    axD.bar(xpos - 0.2, rmses, 0.38, color=cols, label="xG-RMSE")
    axD2 = axD.twinx()
    axD2.bar(xpos + 0.2, briers, 0.38, color=cols, alpha=0.55, hatch="//", label="Brier")
    axD.set_xticks(xpos); axD.set_xticklabels(names)
    axD.set_ylabel("xG-RMSE (↓ besser)"); axD2.set_ylabel("Brier (↓ besser)")
    axD.set_ylim(0.69, 0.725); axD2.set_ylim(0.605, 0.625)
    axD.set_title("D · Genauigkeit pro Engine (Blend gewinnt beide)", fontweight="bold", fontsize=11)
    for i, (r, b) in enumerate(zip(rmses, briers)):
        axD.text(i - 0.2, r + 0.0005, f"{r:.4f}", ha="center", fontsize=8)
        axD2.text(i + 0.2, b + 0.0003, f"{b:.4f}", ha="center", fontsize=8)

    # ── E: odds calibration by bucket (Blend home odds) ──
    axE = fig.add_subplot(gs[1, 1:])
    edges = [1.0, 1.5, 2.0, 2.5, 3.5, 5.0, 99]
    labels = ["1.0-1.5", "1.5-2.0", "2.0-2.5", "2.5-3.5", "3.5-5.0", "5.0+"]
    implied, actual, ns = [], [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        b = (fair_h >= lo) & (fair_h < hi)
        if b.sum() < 15:
            implied.append(np.nan); actual.append(np.nan); ns.append(0); continue
        implied.append((1.0 / fair_h[b]).mean()); actual.append(home_won[b].mean()); ns.append(int(b.sum()))
    xp = np.arange(len(labels))
    axE.bar(xp - 0.2, implied, 0.38, color=C_BLEND, label="Implizit (1/Quote)")
    axE.bar(xp + 0.2, actual, 0.38, color=C_OK, label="Tatsächliche Heimsieg-Rate")
    axE.set_xticks(xp); axE.set_xticklabels([f"{l}\n(n={n})" for l, n in zip(labels, ns)], fontsize=8)
    axE.set_ylabel("P(Heimsieg)")
    axE.set_xlabel("Vorhergesagte Heim-Quoten-Bucket (Blend)")
    axE.set_title("E · Quoten-Kalibrierung: implizite vs. tatsächliche Heimsieg-Rate",
                  fontweight="bold", fontsize=11)
    axE.legend(fontsize=9)
    axE.grid(alpha=0.25, axis="y")

    # ── F: sample matches table ──
    axF = fig.add_subplot(gs[2, :])
    axF.axis("off")
    TOP = {"epl", "bundesliga", "la_liga", "serie_a", "ligue_1"}
    samp_idx = [i for i in range(len(d09)) if m[i] and league[i] in TOP]
    rng = np.random.default_rng(7)
    rng.shuffle(samp_idx)
    samp_idx = samp_idx[:12]
    samp_idx.sort(key=lambda i: (league[i], str(cdate[i])))

    def short(s):
        return (s[:15] + "…") if len(s) > 16 else s

    rows = []
    res_lbl = {0: "1", 1: "X", 2: "2"}
    colors = []
    for i in samp_idx:
        fo = [1.0 / max(pB[i, k], 1e-6) for k in range(3)]
        argmax = int(np.argmax(pB[i]))
        hit = argmax == y[i]
        rows.append([
            league[i],
            f"{short(ch[i])} – {short(ca[i])}",
            f"{fo[0]:.2f} / {fo[1]:.2f} / {fo[2]:.2f}",
            f"{(lhB[i]+laB[i]):.2f}",
            f"{int(yh[i])}:{int(ya[i])} ({res_lbl[y[i]]})",
            f"{(rh[i]+ra[i]):.2f}",
            "✓" if hit else "✗",
        ])
        colors.append(C_OK if hit else C_BAD)
    cols_hdr = ["Liga", "Spiel", "Blend-Quote 1/X/2", "Pred xG", "Ergebnis", "Ist-xG", "Tipp"]
    tbl = axF.table(cellText=rows, colLabels=cols_hdr, loc="center", cellLoc="center")
    tbl.auto_set_font_size(False); tbl.set_fontsize(9.5); tbl.scale(1, 1.7)
    for j in range(len(cols_hdr)):
        c = tbl[0, j]; c.set_facecolor("#1a0f0a"); c.set_text_props(color="#d4b86a", fontweight="bold")
    for r in range(len(rows)):
        tbl[r + 1, 6].set_text_props(color=colors[r], fontweight="bold")
        tbl[r + 1, 1].set_text_props(ha="left")
        for j in range(len(cols_hdr)):
            tbl[r + 1, j].set_facecolor("#faf6ee" if r % 2 == 0 else "#f0e9d8")
    n_hit = sum(1 for i in samp_idx if int(np.argmax(pB[i])) == y[i])
    axF.set_title(f"F · Beispiel-Spiele (Top-5 Ligen): vorhergesagte Quoten + xG vs. tatsächliches Ergebnis "
                  f"· Blend traf {n_hit}/{len(samp_idx)} Favoriten-Tipps",
                  fontweight="bold", fontsize=11, pad=12)

    fig.savefig(OUT, dpi=120, bbox_inches="tight", facecolor="white")
    print(f"✓ saved {OUT.relative_to(REPO_ROOT)}  ({OUT.stat().st_size//1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
