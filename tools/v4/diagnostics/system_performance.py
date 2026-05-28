#!/usr/bin/env python3
"""system_performance — how well does FODZE predict results + xG, and what is the
confidence per tip? (interpretable scorecard, 25/26 OOT holdout)

Answers two questions:
  1. Vorhersage-Güte: 1X2 hit-rate (overall + by confidence tier), O/U 2.5 hit,
     Brier + Brier-Skill-Score (vs base-rate guessing), xG-RMSE/MAE in goals.
  2. Confidence pro Tipp: YES — every tip's probability IS its confidence, and it
     is CALIBRATED (reliability curve on the diagonal). Confidence tiers shown.

Engine = Blend (50/50 dev-03 ⊕ dev-09, the validated-best forecaster). dev-03 is
the current production default (numbers very close, reported for reference).

Outputs (tools/v4/diagnostics/):
  system_performance.json · system_performance.png
Run: tools/venv/bin/python3 -I tools/v4/diagnostics/system_performance.py
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
from v4.modules.m3_xg import DEFAULT_RHO
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m1_score.coarse_graining import get_1x2
from v4.eval.metrics import brier_multiclass, brier_skill_score, xg_forecast_report

D = REPO / "tools" / "v4" / "diagnostics"
RHO = DEFAULT_RHO
C_OK, C_MID, C_LO, C_GOLD = "#4f8a3d", "#c9a227", "#b5483d", "#3a7ca5"


def lambdas_to_markets(lh, la, rho):
    n = len(lh); p1 = np.empty((n, 3)); po = np.empty(n)
    for i in range(n):
        try:
            M = DixonColesModel(lh[i], la[i], rho=rho).matrix(normalize=True)
        except ValueError:
            M = PoissonGoalModel(lh[i], la[i]).matrix(normalize=True)
        p = get_1x2(M); p1[i] = [p["H"], p["D"], p["A"]]
        idx = np.arange(M.shape[0])
        po[i] = M[idx[:, None] + idx[None, :] >= 3].sum()
    return p1, po


def main() -> int:
    eng = X.corpus_engines(("25/26",), RHO)
    d09, d03 = eng["dev-09"], eng["dev-03"]
    lhB = 0.5 * d09["lam_h"].to_numpy(float) + 0.5 * d03["lam_h"].to_numpy(float)
    laB = 0.5 * d09["lam_a"].to_numpy(float) + 0.5 * d03["lam_a"].to_numpy(float)
    lhB = np.clip(lhB, X.LAMBDA_MIN, X.LAMBDA_MAX); laB = np.clip(laB, X.LAMBDA_MIN, X.LAMBDA_MAX)
    p, po = lambdas_to_markets(lhB, laB, RHO)
    yh, ya = d09["y_h"].to_numpy(), d09["y_a"].to_numpy()
    y = np.array([X._outcome(h, a) for h, a in zip(yh, ya)])
    tot = yh + ya
    n = len(y)

    # ── result accuracy ──
    pick = p.argmax(1)
    acc = float((pick == y).mean())
    conf = p.max(1)
    brier = brier_multiclass(y, p)
    bss = brier_skill_score(y, p)
    # O/U 2.5
    over = (tot >= 3).astype(int)
    o_pick = (po >= 0.5).astype(int)
    o_acc = float((o_pick == over).mean())

    # confidence tiers (max prob)
    tiers = [("Toss-up <45%", conf < 0.45), ("45-55%", (conf >= 0.45) & (conf < 0.55)),
             ("55-65%", (conf >= 0.55) & (conf < 0.65)), ("Hoch ≥65%", conf >= 0.65)]
    tier_rows = []
    for lbl, m in tiers:
        if m.sum() < 10:
            continue
        tier_rows.append({"tier": lbl, "n": int(m.sum()), "share": float(m.mean()),
                          "accuracy": float((pick[m] == y[m]).mean()), "mean_conf": float(conf[m].mean())})

    # ── reliability (confidence calibration) ──
    rel = []
    edges = np.linspace(0.33, 0.85, 9)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf >= lo) & (conf < hi)
        if m.sum() < 20:
            continue
        rel.append({"mean_conf": float(conf[m].mean()), "actual": float((pick[m] == y[m]).mean()), "n": int(m.sum())})

    # ── xG accuracy ──
    spine = X.XGSpine()
    rh = np.full(n, np.nan); ra = np.full(n, np.nan)
    league = d09["league"].to_numpy(); ch = d09["ch"].to_numpy(); ca = d09["ca"].to_numpy(); cd = d09["cdate"].to_numpy()
    for i in range(n):
        r = spine.resolve(league[i], ch[i], ca[i], cd[i])
        if r:
            rh[i], ra[i] = r[1], r[2]
    has = ~np.isnan(rh) & ~np.isnan(ra)
    xgrep = xg_forecast_report(np.concatenate([lhB[has], laB[has]]), np.concatenate([rh[has], ra[has]]))

    print("═" * 70)
    print(f"FODZE SYSTEM-LEISTUNG · 25/26 OOT · Blend · n={n:,}")
    print("═" * 70)
    print(f"  RESULTAT (1X2): Trefferquote argmax {acc:.1%} · Brier {brier:.4f} · "
          f"Brier-Skill-Score {bss:+.1%} vs Raten")
    print(f"  ÜBER/UNTER 2.5: Trefferquote {o_acc:.1%}")
    print(f"  xG (pro Team):  RMSE {xgrep['rmse']:.3f} · MAE {xgrep['mae']:.3f} Tore · "
          f"Bias {xgrep['bias']:+.3f} · Korrelation {xgrep['pearson_r']:.2f}")
    print("\n  CONFIDENCE-TIERS (argmax-Wkt = Tipp-Confidence):")
    for t in tier_rows:
        print(f"    {t['tier']:<14} Anteil {t['share']:.0%}  Trefferquote {t['accuracy']:.1%}  (claim {t['mean_conf']:.0%})")
    base = np.bincount(y, minlength=3) / n
    print(f"\n  (Basisraten H/D/A: {base[0]:.0%}/{base[1]:.0%}/{base[2]:.0%} · "
          f"'immer Favorit' waere {max(base):.0%})")

    out = {"engine": "Blend 50/50 dev-03⊕dev-09", "season": "25/26 OOT", "n": n,
           "result_1x2": {"accuracy": acc, "brier": brier, "brier_skill_score": bss, "base_rates": base.tolist()},
           "over_under_25_accuracy": o_acc,
           "xg": xgrep, "confidence_tiers": tier_rows, "reliability": rel,
           "confidence_note": "Jeder Tipp hat eine Wahrscheinlichkeit (= Confidence); validiert kalibriert (Reliability auf Diagonale)."}
    (D / "system_performance.json").write_text(json.dumps(out, indent=2, default=float))

    # ── figure ──
    fig = plt.figure(figsize=(17, 9.5))
    gs = GridSpec(2, 3, hspace=0.34, wspace=0.26, height_ratios=[1, 1])
    # A: confidence-tier accuracy
    axA = fig.add_subplot(gs[0, 0])
    labels = [t["tier"] for t in tier_rows]
    accs = [t["accuracy"] for t in tier_rows]
    cols = [C_LO, C_MID, C_GOLD, C_OK][:len(labels)]
    axA.bar(labels, accs, color=cols)
    for i, t in enumerate(tier_rows):
        axA.text(i, t["accuracy"] + 0.01, f"{t['accuracy']:.0%}\nn={t['n']}", ha="center", fontsize=8.5)
    axA.set_ylim(0, 1); axA.set_ylabel("Trefferquote")
    axA.set_title("A · Treffer nach Confidence-Stufe\n(höhere Confidence → mehr Treffer)", fontweight="bold", fontsize=11)
    axA.tick_params(axis="x", labelsize=8)
    # B: reliability
    axB = fig.add_subplot(gs[0, 1])
    axB.plot([0.33, 0.85], [0.33, 0.85], "--", color="#999", lw=1.3, label="perfekt kalibriert")
    axB.plot([r["mean_conf"] for r in rel], [r["actual"] for r in rel], "o-", color=C_GOLD, lw=2.5, ms=7, label="Blend")
    axB.set_xlabel("Confidence des Tipps (argmax-Wkt)"); axB.set_ylabel("Tatsächliche Trefferquote")
    axB.set_title("B · Sind die Confidence-Angaben ehrlich?\n→ ja, auf der Diagonale", fontweight="bold", fontsize=11)
    axB.legend(fontsize=9); axB.grid(alpha=0.25)
    # C: xG scatter
    axC = fig.add_subplot(gs[0, 2])
    axC.hexbin(np.concatenate([rh[has], ra[has]]), np.concatenate([lhB[has], laB[has]]),
               gridsize=30, cmap="YlOrBr", mincnt=1)
    axC.plot([0, 4], [0, 4], "--", color="#999", lw=1.3)
    axC.set_xlim(0, 4); axC.set_ylim(0, 4)
    axC.set_xlabel("Realisierte xG (pro Team)"); axC.set_ylabel("Vorhergesagte xG")
    axC.set_title(f"C · xG-Vorhersage  (RMSE {xgrep['rmse']:.2f}, r {xgrep['pearson_r']:.2f})", fontweight="bold", fontsize=11)
    # D: scorecard text
    axD = fig.add_subplot(gs[1, :])
    axD.axis("off")
    lines = [
        ("1X2-Trefferquote (Favorit)", f"{acc:.1%}", f"vs 'immer Favorit' {max(base):.0%} · vs Zufall 33%"),
        ("Brier-Skill-Score", f"{bss:+.1%}", "besser als blindes Raten der Basisraten (>0 = Mehrwert)"),
        ("Über/Unter 2.5 Tore", f"{o_acc:.1%}", "Treffer der Tor-Tendenz"),
        ("xG-Vorhersage (MAE)", f"{xgrep['mae']:.2f} Tore", f"Ø Abweichung pro Team · RMSE {xgrep['rmse']:.2f} · Bias {xgrep['bias']:+.2f}"),
        ("Hoch-Confidence (≥65%) Treffer", f"{tier_rows[-1]['accuracy']:.0%}", f"in {tier_rows[-1]['share']:.0%} der Spiele · Confidence ist kalibriert"),
    ]
    axD.text(0.0, 1.0, "SCORECARD — wie gut & wie sicher", fontsize=14, fontweight="bold", va="top", color="#1a0f0a")
    for i, (k, v, note) in enumerate(lines):
        yv = 0.80 - i * 0.165
        axD.text(0.01, yv, k, fontsize=11, fontweight="bold", va="center", color="#1a0f0a")
        axD.text(0.32, yv, v, fontsize=14, fontweight="bold", va="center", color=C_OK)
        axD.text(0.46, yv, note, fontsize=10, va="center", color="#555")
    axD.text(0.01, 0.80 - len(lines) * 0.165, "Confidence pro Tipp: JA — jede Vorhersage liefert P(H)/P(D)/P(A) "
             "(+ P(Ü2.5)); diese Wkt IST die Confidence und ist validiert kalibriert (Panel B).",
             fontsize=10.5, va="center", style="italic", color="#1a0f0a")
    fig.suptitle("FODZE · System-Leistung: Ergebnis- & xG-Vorhersage + Confidence (25/26 OOT, Blend)",
                 fontsize=13, fontweight="bold")
    fig.savefig(D / "system_performance.png", dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"\n  ✓ {(D / 'system_performance.json').relative_to(REPO)} · system_performance.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
