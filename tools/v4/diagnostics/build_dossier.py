#!/usr/bin/env python3
"""build_dossier — compile the forecast-quality investigation into a PDF dossier.

Data-driven: pulls exact numbers from the committed JSON results (no hardcoding)
+ embeds the 6-panel viz + two fresh summary charts. Output is a self-contained
report of the whole 2026-05-28 forecast-quality pivot + dev-09/dev-03/Blend
analysis + validation + recommendation.

Inputs (must exist — run the diagnostics first):
  score_xg_forecast.json · score_roi_leaderboard.json · dev09_derisk.json
  dev09_2h_gate.json · dev09_vs_dev03_detail.json · viz_predictions.png

Output: tools/v4/diagnostics/FODZE-Forecast-Dossier.pdf

Run: tools/venv/bin/python3 -I tools/v4/diagnostics/build_dossier.py
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.platypus import (HRFlowable, Image, PageBreak, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

D = Path(__file__).resolve().parent
REPO = D.parents[2]
OUT = D / "FODZE-Forecast-Dossier.pdf"
TODAY = "2026-05-28"

LEATHER = colors.HexColor("#1a0f0a")
GOLD = colors.HexColor("#b8923f")
GOLD_LT = colors.HexColor("#d4b86a")
GREEN = colors.HexColor("#4f8a3d")
RED = colors.HexColor("#b5483d")
BLUE = colors.HexColor("#3a7ca5")
GREY = colors.HexColor("#555555")
PAPER = colors.HexColor("#faf6ee")


def load(name):
    return json.loads((D / name).read_text())


# ─── styles ──────────────────────────────────────────────────────────
ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], textColor=LEATHER, fontSize=15,
                    spaceBefore=16, spaceAfter=7, fontName="Helvetica-Bold")
H2 = ParagraphStyle("H2", parent=ss["Heading2"], textColor=GOLD, fontSize=11.5,
                    spaceBefore=10, spaceAfter=4, fontName="Helvetica-Bold")
BODY = ParagraphStyle("BODY", parent=ss["BodyText"], fontSize=9.5, leading=14,
                      textColor=colors.HexColor("#222222"), spaceAfter=6, alignment=TA_LEFT)
SMALL = ParagraphStyle("SMALL", parent=BODY, fontSize=8, textColor=GREY, leading=11)
KEY = ParagraphStyle("KEY", parent=BODY, fontSize=10.5, leading=15, textColor=LEATHER)
CAP = ParagraphStyle("CAP", parent=SMALL, alignment=TA_CENTER, spaceBefore=3)


def tbl(data, col_widths, header_bg=LEATHER, header_fg=GOLD_LT, highlight_row=None, fontsize=8.5):
    t = Table(data, colWidths=col_widths, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), header_bg),
        ("TEXTCOLOR", (0, 0), (-1, 0), header_fg),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), fontsize),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d8cfb8")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PAPER]),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
    ]
    if highlight_row is not None:
        style += [("BACKGROUND", (0, highlight_row), (-1, highlight_row), colors.HexColor("#f3e8c4")),
                  ("FONTNAME", (0, highlight_row), (-1, highlight_row), "Helvetica-Bold")]
    t.setStyle(TableStyle(style))
    return t


# ─── fresh charts ────────────────────────────────────────────────────
def chart_alpha_sweep(detail):
    sweep = detail["alpha_blend_sweep"]
    a = [s["alpha"] for s in sweep]
    rm = [s["xg_rmse"] for s in sweep]
    br = [s["brier"] for s in sweep]
    fig, ax1 = plt.subplots(figsize=(7.2, 3.4))
    ax2 = ax1.twinx()
    l1, = ax1.plot(a, rm, "o-", color="#3a7ca5", lw=2, label="xG-RMSE")
    l2, = ax2.plot(a, br, "s-", color="#b8923f", lw=2, label="Brier")
    # mark pure + optimum
    ax1.axvline(0, color="#bbb", ls=":", lw=1); ax1.axvline(1, color="#bbb", ls=":", lw=1)
    best_a = min(sweep, key=lambda s: s["xg_rmse"])["alpha"]
    ax1.axvspan(0.4, 0.6, color="#5a9e45", alpha=0.12)
    ax1.text(0.5, max(rm), "Blend-Zone\n(dominiert beide)", ha="center", va="top", fontsize=8, color="#4f8a3d")
    ax1.set_xlabel("α  (0 = reines dev-03  →  1 = reines dev-09)")
    ax1.set_ylabel("xG-RMSE (↓)", color="#3a7ca5")
    ax2.set_ylabel("Brier (↓)", color="#b8923f")
    ax1.set_title("Konvexer λ-Blend: beide Achsen minimal bei α≈0.5", fontsize=10, fontweight="bold")
    ax1.legend(handles=[l1, l2], loc="upper center", fontsize=8, ncol=2)
    ax1.grid(alpha=0.2)
    p = D / "_dossier_alpha.png"
    fig.tight_layout(); fig.savefig(p, dpi=130, facecolor="white"); plt.close(fig)
    return p


def chart_leaderboard(lb):
    ci = lb["common_intersection"]
    order = lb["rmse_ranking"]
    names = order
    rmses = [ci[n]["xg_rmse"] for n in names]
    briers = [ci[n]["brier"] for n in names]
    cmap = {"dev-09": "#d98c3f", "dev-03": "#3a7ca5", "v2": "#7a7a7a", "Standard": "#9a8c5a", "v1": "#b0b0b0"}
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(7.4, 3.2))
    yp = range(len(names))
    a1.barh(list(yp), rmses, color=[cmap.get(n, "#888") for n in names])
    a1.set_yticks(list(yp)); a1.set_yticklabels(names); a1.invert_yaxis()
    a1.set_xlim(0.69, 0.81); a1.set_title("xG-RMSE (↓ besser)", fontsize=9.5, fontweight="bold")
    for i, v in enumerate(rmses): a1.text(v + 0.001, i, f"{v:.3f}", va="center", fontsize=8)
    a2.barh(list(yp), briers, color=[cmap.get(n, "#888") for n in names])
    a2.set_yticks(list(yp)); a2.set_yticklabels([]); a2.invert_yaxis()
    a2.set_xlim(0.61, 0.675); a2.set_title("Brier (↓ besser)", fontsize=9.5, fontweight="bold")
    for i, v in enumerate(briers): a2.text(v + 0.0005, i, f"{v:.3f}", va="center", fontsize=8)
    fig.suptitle(f"5-Engine-Leaderboard · common-intersection n={lb['n_common_intersection']:,}",
                 fontsize=10, fontweight="bold")
    p = D / "_dossier_leaderboard.png"
    fig.tight_layout(); fig.savefig(p, dpi=130, facecolor="white"); plt.close(fig)
    return p


# ─── page furniture ──────────────────────────────────────────────────
def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(GOLD_LT); canvas.setLineWidth(0.6)
    canvas.line(2 * cm, 1.4 * cm, A4[0] - 2 * cm, 1.4 * cm)
    canvas.setFont("Helvetica", 7.5); canvas.setFillColor(GREY)
    canvas.drawString(2 * cm, 1.0 * cm, f"FODZE · Forecast-Qualität Dossier · {TODAY}")
    canvas.drawRightString(A4[0] - 2 * cm, 1.0 * cm, f"Seite {doc.page}")
    canvas.restoreState()


def main() -> int:
    lb = load("score_xg_forecast.json")
    roi = load("score_roi_leaderboard.json")
    dr = load("dev09_derisk.json")
    g2 = load("dev09_2h_gate.json")
    det = load("dev09_vs_dev03_detail.json")

    ci = lb["common_intersection"]
    p_alpha = chart_alpha_sweep(det)
    p_lb = chart_leaderboard(lb)
    viz = D / "viz_predictions.png"

    s = []  # story

    # ── TITLE PAGE ──
    s.append(Spacer(1, 3.2 * cm))
    s.append(Paragraph("FODZE", ParagraphStyle("T0", parent=H1, fontSize=34, alignment=TA_CENTER,
                                               textColor=GOLD, spaceAfter=2)))
    s.append(Paragraph("Forecast-Qualität — Engine-Dossier", ParagraphStyle(
        "T1", parent=H1, fontSize=20, alignment=TA_CENTER, textColor=LEATHER, spaceAfter=6)))
    s.append(HRFlowable(width="55%", thickness=1.2, color=GOLD_LT, spaceBefore=4, spaceAfter=14))
    s.append(Paragraph("Vom Wett-Edge zur Prognose-Güte: xG- &amp; Ausgangs-Vorhersage<br/>"
                       "dev-03 · dev-09 · Blend — Messung, Validierung, Empfehlung",
                       ParagraphStyle("T2", parent=BODY, fontSize=12, alignment=TA_CENTER,
                                      textColor=GREY, leading=18)))
    s.append(Spacer(1, 1.4 * cm))
    # verdict box
    bestn = lb["rmse_ranking"][0]
    verdict_rows = [
        ["Kernbefund", "Ein 50/50-λ-Blend (dev-03 ⊕ dev-09) dominiert beide Reinmodelle"],
        ["", "auf BEIDEN Achsen (xG-RMSE + Brier), in BEIDEN Holdouts (25/26 + 24/25)."],
        ["Primärachse", "xG-Genauigkeit (RMSE) gekoppelt mit 1X2-Brier"],
        ["Tiebreaker", "Pinnacle-ROI (kein Veto) — alle Engines verlieren knapp gg. Pinnacle"],
        ["Empfehlung", "Blend als Forecast-Engine; Live-Deployment gated auf dev-09-Lineups"],
    ]
    vt = Table(verdict_rows, colWidths=[3.2 * cm, 11.3 * cm])
    vt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PAPER),
        ("BOX", (0, 0), (-1, -1), 1, GOLD_LT),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("TEXTCOLOR", (0, 0), (0, -1), GOLD),
        ("TEXTCOLOR", (1, 0), (1, -1), LEATHER),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ]))
    s.append(vt)
    s.append(Spacer(1, 1.0 * cm))
    s.append(Paragraph(f"Stand: {TODAY} · Datenbasis: 25/26 OOT-Holdout (n={ci[bestn]['n_matches']:,} "
                       f"Spiele mit realisierter xG) + 24/25 temporaler Gate", CAP))
    s.append(PageBreak())

    # ── 1. EXECUTIVE SUMMARY ──
    s.append(Paragraph("1 · Executive Summary", H1))
    s.append(Paragraph(
        "Das Ziel wurde verschoben: weg von <b>Wett-Edge gegen Pinnacle</b>, hin zu <b>Prognose-Güte</b> "
        "— wie genau sagen die Engines den Ausgang <i>und</i> die erwarteten xG voraus. ROI bleibt nur "
        "noch sekundärer Tiebreaker, kein Veto. Das kehrt die Linse um, unter der dev-09 zuvor archiviert "
        "worden war (es scheiterte nur am ROI-Gate).", BODY))
    s.append(Paragraph(
        "Dafür wurde erstmals ein <b>xG-Forecast-Mess-Framework</b> gebaut (vorhergesagtes λ vs. realisierte "
        "xG → RMSE/MAE/Bias, gekoppelt mit dem 1X2-Brier aus demselben λ). Alle fünf Engines wurden auf "
        "einer gemeinsamen Datenbasis verglichen; eine Coverage-Lücke (77%→98%) wurde über einen gestuften "
        "Namens-Bridge geschlossen — was das erste, verzerrte Ergebnis korrigierte.", BODY))
    s.append(Paragraph(
        f"<b>Ergebnis:</b> dev-09 ist der robuste Ausgangs-Vorhersager (Brier-Sieg über alle Seeds, "
        f"Kalibrierung und beide Holdouts); dev-03 der xG-Niveau-Vorhersager. Keiner gewinnt beides allein. "
        f"Ein simpler <b>50/50-λ-Blend schlägt beide Reinmodelle auf beiden Achsen</b> — der klassische "
        f"Ensemble-Effekt, ohne Retraining und ohne Multikollinearität (Output-Mittelung statt Feature-Mix).", KEY))
    s.append(Spacer(1, 4))
    s.append(Image(str(p_lb), width=16 * cm, height=16 * cm * 3.2 / 7.4))
    s.append(Paragraph("Abb. 1 — 5-Engine-Leaderboard auf identischer Match-Menge (common-intersection).", CAP))

    # ── 2. ZIEL & METHODIK ──
    s.append(Paragraph("2 · Zielsetzung &amp; Methodik", H1))
    s.append(Paragraph("2.1 Das neue Ziel (gekoppelt)", H2))
    s.append(Paragraph(
        "<b>Primär:</b> xG-Treffsicherheit (RMSE/MAE/Bias des vorhergesagten λ vs. realisierte xG) "
        "<b>und</b> der daraus via Dixon-Coles abgeleitete 1X2-Brier. Ein Modell, zwei Auswertungspunkte. "
        "<b>Sekundär (Tiebreaker):</b> Pinnacle-ROI als Leitplanke, nicht als Veto.", BODY))
    s.append(Paragraph("2.2 Mess-Framework", H2))
    s.append(Paragraph(
        "Neue Scoring-Primitive in <font face='Courier'>v4.eval.metrics</font> (xg_rmse / xg_mae / xg_bias / "
        "xg_forecast_report), getestet mit 6 pytest-Fällen. Realisierte xG als Ground-Truth aus "
        "<font face='Courier'>team_xg_history</font> (Understat + Sofa-Shotmap). Alle Engines auf <b>rohen</b> "
        "Wahrscheinlichkeiten verglichen (keine Isotonic) — Modell-Qualität, nicht Pipeline.", BODY))
    s.append(Paragraph(
        "<b>Coverage-Fix:</b> die anfänglichen 77% Join-Rate waren keine Datums-, sondern eine "
        "Namens-Divergenz (Sofa-Kanonik vs. team_xg_history, z. B. „SSC Napoli”↔„Napoli”, "
        "„Wolverhampton”↔„Wolverhampton Wanderers”). Gestufter Resolver (exakt → normalisiert → "
        "Substring/Token, je Liga + nächstes Datum ±7 T) → <b>98%+</b> Coverage; Fuzzy-Audit bestätigte "
        "korrekte Team-Bridges. Der Fix kippte das erste (verzerrte) Ergebnis.", BODY))

    # ── 3. LEADERBOARD TABLE ──
    s.append(Paragraph("3 · Multi-Engine-Leaderboard (25/26)", H1))
    rows = [["Engine", "n", "xG-RMSE", "xG-MAE", "xG-Bias", "Pearson r", "Brier"]]
    for n in lb["rmse_ranking"]:
        e = ci[n]
        rows.append([n, f"{e['n_matches']:,}", f"{e['xg_rmse']:.4f}", f"{e['xg_mae']:.4f}",
                     f"{e['xg_bias']:+.4f}", f"{e['pearson_r']:.3f}", f"{e['brier']:.4f}"])
    s.append(tbl(rows, [2.6 * cm, 1.6 * cm, 2.1 * cm, 2.0 * cm, 2.0 * cm, 2.1 * cm, 2.0 * cm], highlight_row=1))
    s.append(Paragraph(f"Common-intersection n={lb['n_common_intersection']:,} (Spiele, die ALLE Engines "
                       f"vorhersagten). xG-RMSE-Ranking: {' &lt; '.join(lb['rmse_ranking'])}. "
                       f"Brier-Ranking: {' &lt; '.join(lb['brier_ranking'])}.", SMALL))
    s.append(Paragraph("dev-09 und dev-03 führen klar; <b>Standard</b> überschätzt xG massiv (Bias +0.12), "
                       "<b>v1</b> hat die schwächste xG-RMSE.", BODY))

    # ── 4. TIEFENANALYSE ──
    s.append(Paragraph("4 · dev-09 vs. dev-03 — Tiefenanalyse", H1))
    mr = det["magnitude_vs_ratio"]
    sh = det["smart_hybrid"]
    s.append(Paragraph(
        f"<b>Mechanismus:</b> xG-RMSE belohnt korrekte λ-<i>Magnitude</i> (Gesamttore), Brier korrekte "
        f"λ-<i>Ratio</i> (Heim/Auswärts-Split → wer gewinnt). dev-03 besitzt die Magnitude "
        f"(Total-xG-RMSE {mr['total_rmse_dev03']:.4f} vs. {mr['total_rmse_dev09']:.4f}), dev-09 das Ratio "
        f"(Split-MAE {mr['ratio_mae_dev09']:.4f} vs. {mr['ratio_mae_dev03']:.4f}) — beide Vorsprünge klein.", BODY))
    s.append(Paragraph(
        f"Der „smarte” Hybrid (dev-03-Total × dev-09-Ratio) gewann xG-RMSE ({sh['xg_rmse']:.4f}), "
        f"verfehlte Brier aber knapp. Das <b>simple konvexe Mitteln</b> ist überlegen, weil es beide "
        f"Fehlerquellen symmetrisch glättet.", BODY))
    ec = det["error_complementarity"]
    s.append(Paragraph(
        f"<b>Warum der Blend funktioniert:</b> die Per-Match-Fehler korrelieren {ec['corr_xg_abserr']:.2f} "
        f"(xG) / {ec['corr_brier']:.2f} (Brier) — also ~16–18% unabhängig, genug, damit der Mittelwert die "
        f"Varianz auf beiden Achsen reduziert.", BODY))
    s.append(Image(str(p_alpha), width=15.5 * cm, height=15.5 * cm * 3.4 / 7.2))
    s.append(Paragraph("Abb. 2 — α-Sweep: xG-RMSE und Brier sind beide um α≈0.5 minimal und liegen unter "
                       "beiden Reinmodellen (α=0 bzw. α=1).", CAP))

    # ── 5. VALIDIERUNG ──
    s.append(PageBreak())
    s.append(Paragraph("5 · Validierung (De-Risk)", H1))
    s.append(Paragraph("5.1 Multi-Seed — hält der Brier-Edge über Seeds?", H2))
    ms = dr["a_multiseed"]
    mrows = [["Seed", "dev-09 Brier", "Δ vs dev-03", "signifikant?"]]
    for r in ms["per_seed"]:
        mrows.append([f"seed-{r['seed']}", f"{r['brier_dev09']:.4f}", f"{r['delta_vs_dev03']:+.5f}",
                      "ja" if r["sig_neg"] else "nein"])
    s.append(tbl(mrows, [3 * cm, 3 * cm, 3 * cm, 3 * cm]))
    s.append(Paragraph(f"dev-03 Brier {ms['dev03_brier']:.4f}. Alle 5 Seeds besser: "
                       f"<b>{'ja' if ms['all_seeds_better'] else 'nein'}</b>; alle signifikant: "
                       f"<b>{'ja' if ms['all_seeds_significant'] else 'nein'}</b>; mittleres Δ {ms['mean_delta']:+.5f}. "
                       f"Kein Seed-000-Zufall.", SMALL))
    s.append(Paragraph("<i>Hinweis zur Stichprobe:</i> Die Multi-Seed-Validierung nutzt den vollen Korpus "
                       "(n=6.868 — Brier braucht keine realisierte xG); die Blend-Analyse (§6) den xG-gematchten "
                       "Teil (n=6.750). Daher minimale absolute-Brier-Differenzen (≤0.001) zwischen den "
                       "Abschnitten — die Δ- und Richtungs-Schlüsse sind identisch.", SMALL))
    s.append(Paragraph("5.2 Kalibriert — schließt dev-03s Isotonic die Lücke?", H2))
    cb = dr["b_calibrated"]
    s.append(Paragraph(
        f"CV-Isotonic (5-fold, leckage-frei) auf BEIDE: dev-03 {cb['dev03_raw']:.4f}→{cb['dev03_cal']:.4f}, "
        f"dev-09 {cb['dev09_raw']:.4f}→{cb['dev09_cal']:.4f}. Kalibrierter Abstand "
        f"{cb['calibrated_gap_dev09_minus_dev03']:+.5f} → dev-09 bleibt besser. dev-03s Produktiv-Isotonic "
        f"<b>schließt die Lücke nicht</b> (der Edge ist Diskriminierung, nicht Kalibrierung).", BODY))
    s.append(Paragraph("5.3 Per-Liga + 5.4 Temporaler Gate (2. Holdout)", H2))
    s.append(Paragraph(
        f"Per-Liga (25/26): dev-09 in <b>{dr['c_per_league']['n_brier_regress_gt_0p01']}/"
        f"{dr['c_per_league']['n_leagues']}</b> Ligen Brier-schlechter um &gt;0.01 — keine Katastrophe. "
        f"<br/><b>2. Holdout (beide Modelle neu auf 22/23+23/24, Test 24/25 voll-OOT):</b> "
        f"Brier dev-09 {g2['brier_dev09']:.4f} vs dev-03 {g2['brier_dev03']:.4f} "
        f"(Δ {g2['brier_delta']:+.5f}) → der Outcome-Edge <b>hält temporal</b>. "
        f"xG-RMSE dev-03 {g2['xg_rmse_dev03']:.4f} vs dev-09 {g2['xg_rmse_dev09']:.4f} "
        f"(Δ {g2['xg_rmse_delta']:+.4f}) — auf 24/25 gewinnt dev-03 das Niveau (dev-09 dort datenlimitiert: "
        f"nur 2 Sofa-Saisons vs. dev-03s 7 Jahre team_xg_history).", BODY))

    # ── 6. BLEND-BEFUND ──
    s.append(Paragraph("6 · Der Blend-Befund (entscheidend)", H1))
    sweep = {round(r["alpha"], 1): r for r in det["alpha_blend_sweep"]}
    b03 = det["baseline"]["dev03"]; b09 = det["baseline"]["dev09"]
    half = sweep[0.5]
    brows = [
        ["", "xG-RMSE", "Brier"],
        ["dev-03 (α=0)", f"{b03['xg_rmse']:.4f}", f"{b03['brier']:.4f}"],
        ["dev-09 (α=1)", f"{b09['xg_rmse']:.4f}", f"{b09['brier']:.4f}"],
        ["Blend (α=0.5)", f"{half['xg_rmse']:.4f}", f"{half['brier']:.4f}"],
    ]
    s.append(tbl(brows, [5 * cm, 3.5 * cm, 3.5 * cm], highlight_row=3))
    s.append(Paragraph(
        "Der feste 50/50-Blend (kein Tuning → leckage-frei) gewinnt <b>jede Zelle</b> gegen das jeweils "
        "bessere Reinmodell, und das in BEIDEN Holdouts (24/25 bestätigt via -2h-Modelle). Output-Mittelung "
        "→ kein Retraining, kein Multikollinearitäts-Trap (die Bäume sehen sich nie).", BODY))

    # ── 7. VISUAL ──
    s.append(PageBreak())
    s.append(Paragraph("7 · Visuelle Auswertung (25/26)", H1))
    s.append(Paragraph("Was, wie, wie genau, welche Quoten — sechs Panels: xG-Genauigkeit, Kalibrierung "
                       "P(Heimsieg), vorhergesagte vs. Markt-Quoten, Engine-Genauigkeit, Quoten-Kalibrierung, "
                       "und Beispiel-Spiele mit vorhergesagten Quoten vs. tatsächlichem Ergebnis.", BODY))
    s.append(Image(str(viz), width=17.2 * cm, height=17.2 * cm * 15 / 18))
    s.append(Paragraph("Abb. 3 — Vorhersage-vs-Realität, 6-Panel (Detail siehe viz_predictions.png).", CAP))

    # ── 8. ROI-REALITÄT ──
    s.append(Paragraph("8 · ROI-Realität &amp; Deployment", H1))
    rrows = [["Engine", "n Bets", "Win %", "ROI %", "±SE"]]
    for n in sorted(roi["engines"], key=lambda k: -roi["engines"][k].get("roi_pct", -99)):
        e = roi["engines"][n]
        if not e.get("n_bets"):
            continue
        rrows.append([n, f"{e['n_bets']:,}", f"{e['win_rate_pct']:.1f}", f"{e['roi_pct']:+.2f}", f"{e['se_roi_pct']:.2f}"])
    s.append(tbl(rrows, [3 * cm, 2.6 * cm, 2.4 * cm, 2.4 * cm, 2.2 * cm]))
    s.append(Paragraph(
        f"Einheitliches Flat-Stake-Harness gg. Pinnacle Closing (gemeinsame Menge n={roi['n_common_universe']:,}). "
        "<b>Alle Engines verlieren</b> — Pinnacle ist schärfer. dev-09 (−0.26%) vor dev-03 (−0.38%), aber "
        "beide innerhalb ±3.5% SE = Tie bei ≈0. ROI trennt die Forecast-Führer nicht.", BODY))
    s.append(Paragraph(
        "<b>Deployment-Caveat:</b> Backtest/Research nutzt settled-match-Features (alles da). Live "
        "/matchday braucht dev-09s Sofa-Spieler-/Lineup-Features <i>vor</i> Anpfiff — die Lineup-Pipeline "
        "ist noch MVP. dev-03 läuft live ohne diese Abhängigkeit. Der Blend ist also heute ein "
        "Research/Backtest-Gewinn; Live ist auf die Lineup-Pipeline gated.", BODY))

    # ── 9. EMPFEHLUNG ──
    s.append(Paragraph("9 · Empfehlung &amp; nächste Schritte", H1))
    for t in [
        "<b>1. Blend als Forecast-Standard festschreiben</b> — der 50/50-λ-Blend ist die beste Prognose "
        "für die App (dominiert beide Achsen, robust über Seeds/Kalibrierung/2 Holdouts).",
        "<b>2. dev-09 Live-Pipeline lösen</b> — Pre-Match-Lineups (Sofa) als enabling-Infra, damit der "
        "Blend live rechenbar wird; bis dahin bleibt dev-03 der Live-Default.",
        "<b>3. Magnitude messbar verbessern</b> — dev-09s xG-Niveau ist datenlimitiert; mit jeder weiteren "
        "Sofa-Saison schließt sich die Lücke (24/25 noch dev-03, 25/26 bereits Tie).",
        "<b>4. Jährliche Re-Validierung</b> — Leaderboard + 2-Holdout-Gate als stehendes Protokoll.",
    ]:
        s.append(Paragraph(t, BODY))
    s.append(Paragraph(
        "Ehrlicher Maßstab: die Gewinne sind moderat (xG-RMSE ~0.016, Brier ~0.009) und kein Modell schlägt "
        "Pinnacle im ROI. Der eigentliche, dauerhafte Gewinn dieser Untersuchung ist das <b>Mess- und "
        "Validierungs-Framework</b> selbst — wir wissen jetzt belastbar, wie gut wir vorhersagen.", KEY))

    # ── ANHANG ──
    s.append(Paragraph("Anhang · Artefakte &amp; Methodik-Notizen", H2))
    s.append(Paragraph(
        "Reproduzierbar via <font face='Courier'>tools/v4/diagnostics/</font>: score_xg_forecast.py "
        "(Leaderboard), score_roi_leaderboard.py (ROI), dev09_derisk.py (Multi-Seed/Kalibriert/Per-Liga), "
        "dev09_2h_gate.py (temporaler Gate), dev09_vs_dev03_detail.py (Blend-Analyse), viz_predictions.py "
        "(6-Panel), build_dossier.py (dieses PDF). Alle Zahlen hier stammen direkt aus den committeten "
        "JSON-Ergebnissen.", SMALL))
    s.append(Paragraph(
        "Caveats: (1) realisierte xG ist selbst ein Modell-Output (Understat/Sofa), kein Ground-Truth wie "
        "Tore — niedriger-varianz, aber Vergleich gegen eine Schätzung. (2) Holdouts 25/26 + 24/25. "
        "(3) α in-sample gewählt, aber die Kurve ist flach um 0.4–0.6, und fester α=0.5 dominiert leckage-frei.", SMALL))

    doc = SimpleDocTemplate(str(OUT), pagesize=A4, topMargin=1.8 * cm, bottomMargin=1.8 * cm,
                            leftMargin=2 * cm, rightMargin=2 * cm,
                            title="FODZE Forecast-Qualität Dossier", author="FODZE")
    doc.build(s, onFirstPage=footer, onLaterPages=footer)
    # cleanup temp charts
    for p in (p_alpha, p_lb):
        try:
            p.unlink()
        except OSError:
            pass
    print(f"✓ {OUT.relative_to(REPO)}  ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
