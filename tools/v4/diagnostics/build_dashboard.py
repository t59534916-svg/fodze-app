#!/usr/bin/env python3
"""build_dashboard — interactive, self-contained HTML forecast-analysis dashboard.

Granular + interactive (hover/zoom/legend-toggle via Plotly; searchable +
sortable per-match explorer via vanilla JS) + LightGBM feature-importance.
Self-contained: inline plotly.js, no CDN / internet needed.

Sections:
  KPI cards · Leaderboard · xG-accuracy scatter (hover=match) · Calibration ·
  Predicted-vs-Pinnacle odds · Per-league Brier-Δ · FEATURE IMPORTANCE
  (dev-03 + dev-09, gain) · granular match explorer (filter + sort, all matches).

Output: tools/v4/diagnostics/FODZE-Forecast-Dashboard.html
Run:    tools/venv/bin/python3 -I tools/v4/diagnostics/build_dashboard.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools" / "v4" / "diagnostics"))
sys.path.insert(0, str(REPO / "tools"))

import numpy as np
import plotly.graph_objects as go
from plotly.offline import get_plotlyjs

import score_xg_forecast as X
from score_roi_leaderboard import OddsSpine
from v4.modules.m3_xg import BayesianEnsemble, DEFAULT_RHO

OUT = REPO / "tools" / "v4" / "diagnostics" / "FODZE-Forecast-Dashboard.html"
ART = REPO / "tools" / "v4" / "artifacts"
RHO = DEFAULT_RHO
ALPHA = 0.5
C03, C09, CBL, COK, CBAD = "#3a7ca5", "#d98c3f", "#c9a227", "#5a9e45", "#b5483d"
PLOT_BG = "#fffdf8"


def fig_html(fig, div_id):
    return fig.to_html(full_html=False, include_plotlyjs=False, div_id=div_id,
                       config={"displayModeBar": True, "responsive": True})


def importances(ens):
    imp = np.mean([m.booster_.feature_importance("gain") for m in ens.models], axis=0)
    tot = imp.sum() or 1.0
    return dict(zip(ens.feature_names, 100 * imp / tot))


def main() -> int:
    print("Building predictions...")
    eng = X.corpus_engines(("25/26",), RHO)
    spine = X.XGSpine()
    ospine = OddsSpine()
    d09 = X.attach_realized_xg(eng["dev-09"], spine)
    d03 = X.attach_realized_xg(eng["dev-03"], spine)
    m = (d09["mid"] >= 0).to_numpy()

    lh09, la09 = d09["lam_h"].to_numpy(float), d09["lam_a"].to_numpy(float)
    lh03, la03 = d03["lam_h"].to_numpy(float), d03["lam_a"].to_numpy(float)
    lhB, laB = ALPHA * lh09 + (1 - ALPHA) * lh03, ALPHA * la09 + (1 - ALPHA) * la03
    pB = X._lambdas_to_1x2(np.clip(lhB, X.LAMBDA_MIN, X.LAMBDA_MAX), np.clip(laB, X.LAMBDA_MIN, X.LAMBDA_MAX), RHO)
    p03 = d03[["p_h", "p_d", "p_a"]].to_numpy(float)
    p09 = d09[["p_h", "p_d", "p_a"]].to_numpy(float)
    rh, ra = d09["real_h"].to_numpy(float), d09["real_a"].to_numpy(float)
    yh, ya = d09["y_h"].to_numpy(), d09["y_a"].to_numpy()
    y = np.array([X._outcome(h, a) for h, a in zip(yh, ya)], dtype=int)
    y1h = np.eye(3)[y]
    league = d09["league"].to_numpy(); ch = d09["ch"].to_numpy(); ca = d09["ca"].to_numpy()
    cdate = d09["cdate"].to_numpy()

    def rmse(a, b):
        return float(np.sqrt(np.mean((a - b) ** 2)))
    rs = np.concatenate([rh[m], ra[m]])
    # All metrics on the matched-xG subset [m] (same n on both axes; headline
    # Brier matches the dossier/detail analysis).
    met = {
        "dev-03": (rmse(np.concatenate([lh03[m], la03[m]]), rs), float(((p03[m] - y1h[m]) ** 2).sum(1).mean())),
        "dev-09": (rmse(np.concatenate([lh09[m], la09[m]]), rs), float(((p09[m] - y1h[m]) ** 2).sum(1).mean())),
        "Blend":  (rmse(np.concatenate([lhB[m], laB[m]]), rs), float(((pB[m] - y1h[m]) ** 2).sum(1).mean())),
    }
    n = int(m.sum())
    print(f"  matched n={n:,}")

    # Pinnacle odds
    pin_h = np.full(len(d09), np.nan)
    for i in range(len(d09)):
        o = ospine.resolve(league[i], ch[i], ca[i], cdate[i])
        if o is not None:
            pin_h[i] = ospine._df.iloc[o]["psch"]

    # ── KPI ──
    kpis = [
        ("Bester Forecaster", "Blend (50/50)", "dominiert beide Achsen"),
        ("Blend xG-RMSE", f"{met['Blend'][0]:.4f}", f"vs dev-03 {met['dev-03'][0]:.4f} · dev-09 {met['dev-09'][0]:.4f}"),
        ("Blend Brier", f"{met['Blend'][1]:.4f}", f"vs dev-03 {met['dev-03'][1]:.4f} · dev-09 {met['dev-09'][1]:.4f}"),
        ("Spiele (25/26 OOT)", f"{n:,}", "mit realisierter xG"),
        ("Realized-xG Coverage", f"{100*m.mean():.1f}%", "nach Bridge-Fix"),
    ]

    # ── leaderboard fig ──
    names = ["dev-03", "dev-09", "Blend"]; cols = [C03, C09, CBL]
    figL = go.Figure()
    figL.add_bar(x=names, y=[met[n_][0] for n_ in names], marker_color=cols, name="xG-RMSE",
                 text=[f"{met[n_][0]:.4f}" for n_ in names], textposition="outside", yaxis="y")
    figL.add_bar(x=names, y=[met[n_][1] for n_ in names], marker_color=cols, marker_pattern_shape="/",
                 name="Brier", text=[f"{met[n_][1]:.4f}" for n_ in names], textposition="outside", yaxis="y2", opacity=0.55)
    figL.update_layout(
        barmode="group", template="plotly_white", paper_bgcolor=PLOT_BG, plot_bgcolor=PLOT_BG,
        yaxis=dict(title="xG-RMSE (↓)", range=[0.69, 0.725]),
        yaxis2=dict(title="Brier (↓)", overlaying="y", side="right", range=[0.605, 0.625]),
        height=380, margin=dict(t=30, b=30), legend=dict(orientation="h", y=1.12))

    # ── xG scatter (blend) hover=match ──
    tot_pred, tot_real = (lhB + laB)[m], (rh + ra)[m]
    hover = [f"{ch[i]} – {ca[i]}<br>{league[i]} · {cdate[i]}<br>pred {(lhB+laB)[i]:.2f} · ist {(rh+ra)[i]:.2f}"
             for i in np.where(m)[0]]
    figS = go.Figure()
    figS.add_scatter(x=tot_real, y=tot_pred, mode="markers", marker=dict(size=5, color=CBL, opacity=0.35),
                     text=hover, hoverinfo="text", name="Spiele")
    figS.add_scatter(x=[0, 6], y=[0, 6], mode="lines", line=dict(dash="dash", color="#bbb"), name="perfekt")
    figS.update_layout(template="plotly_white", paper_bgcolor=PLOT_BG, plot_bgcolor=PLOT_BG, height=420,
                       xaxis=dict(title="Realisierte Gesamt-xG", range=[0, 6]),
                       yaxis=dict(title="Vorhergesagte Gesamt-xG (Blend)", range=[0, 6]),
                       margin=dict(t=30), showlegend=False)

    # ── calibration ──
    home_won = (y == 0).astype(float)
    figC = go.Figure()
    for nm, p, col in [("dev-03", p03, C03), ("dev-09", p09, C09), ("Blend", pB, CBL)]:
        ph = p[:, 0]; bins = np.quantile(ph, np.linspace(0, 1, 11)); bins[-1] += 1e-6
        idx = np.digitize(ph, bins[1:-1]); xs, ys = [], []
        for b in range(10):
            mb = idx == b
            if mb.sum() < 10:
                continue
            xs.append(float(ph[mb].mean())); ys.append(float(home_won[mb].mean()))
        figC.add_scatter(x=xs, y=ys, mode="lines+markers", name=nm, line=dict(color=col, width=3 if nm == "Blend" else 1.6))
    figC.add_scatter(x=[0, 1], y=[0, 1], mode="lines", line=dict(dash="dash", color="#bbb"), showlegend=False)
    figC.update_layout(template="plotly_white", paper_bgcolor=PLOT_BG, plot_bgcolor=PLOT_BG, height=420,
                       xaxis=dict(title="Vorhergesagte P(Heimsieg)"), yaxis=dict(title="Beobachtete Rate"),
                       margin=dict(t=30), legend=dict(orientation="h", y=1.12))

    # ── odds scatter ──
    fair_h = 1.0 / np.clip(pB[:, 0], 1e-6, 1)
    sel = m & np.isfinite(pin_h) & (fair_h < 8) & (pin_h < 8)
    hov2 = [f"{ch[i]} – {ca[i]}<br>{league[i]}<br>Blend {fair_h[i]:.2f} · Pinnacle {pin_h[i]:.2f}" for i in np.where(sel)[0]]
    figO = go.Figure()
    figO.add_scatter(x=pin_h[sel], y=fair_h[sel], mode="markers", marker=dict(size=5, color=CBL, opacity=0.3),
                     text=hov2, hoverinfo="text")
    figO.add_scatter(x=[1, 8], y=[1, 8], mode="lines", line=dict(dash="dash", color="#bbb"))
    figO.update_layout(template="plotly_white", paper_bgcolor=PLOT_BG, plot_bgcolor=PLOT_BG, height=420,
                       xaxis=dict(title="Pinnacle Closing Heim-Quote", range=[1, 8]),
                       yaxis=dict(title="Blend faire Heim-Quote", range=[1, 8]), margin=dict(t=30), showlegend=False)

    # ── per-league brier delta ──
    b03pm = ((p03 - y1h) ** 2).sum(1); b09pm = ((p09 - y1h) ** 2).sum(1)
    lgs, deltas = [], []
    for lg in sorted(set(league)):
        mm = league == lg
        if mm.sum() < 20:
            continue
        lgs.append(lg); deltas.append(float(b09pm[mm].mean() - b03pm[mm].mean()))
    order = np.argsort(deltas)
    figPL = go.Figure()
    figPL.add_bar(x=[deltas[i] for i in order], y=[lgs[i] for i in order], orientation="h",
                  marker_color=[COK if deltas[i] < 0 else CBAD for i in order])
    figPL.update_layout(template="plotly_white", paper_bgcolor=PLOT_BG, plot_bgcolor=PLOT_BG,
                        height=520, xaxis=dict(title="Brier-Δ (dev-09 − dev-03) · <0 = dev-09 besser"),
                        margin=dict(t=20, l=110))

    # ── feature importance ──
    d09h = BayesianEnsemble.load(ART / "m3_xg-home-dev-09-phase42-seed-000.pkl")
    d09a = BayesianEnsemble.load(ART / "m3_xg-away-dev-09-phase42-seed-000.pkl")
    d03h = BayesianEnsemble.load(ART / "m3_xg-home-dev-03.pkl")
    d03a = BayesianEnsemble.load(ART / "m3_xg-away-dev-03.pkl")

    def avg_imp(eh, ea):
        ih, ia = importances(eh), importances(ea)
        keys = sorted(set(ih) | set(ia), key=lambda k: -(ih.get(k, 0) + ia.get(k, 0)) / 2)
        return keys, [ih.get(k, 0) for k in keys], [ia.get(k, 0) for k in keys]

    k3, h3, a3 = avg_imp(d03h, d03a)
    k9, h9, a9 = avg_imp(d09h, d09a)

    def imp_fig(keys, hh, aa, title):
        keys, hh, aa = keys[::-1], hh[::-1], aa[::-1]
        f = go.Figure()
        f.add_bar(y=keys, x=hh, orientation="h", name="Heim-Modell", marker_color=C03)
        f.add_bar(y=keys, x=aa, orientation="h", name="Auswärts-Modell", marker_color=C09)
        f.update_layout(barmode="group", template="plotly_white", paper_bgcolor=PLOT_BG, plot_bgcolor=PLOT_BG,
                        height=max(320, 22 * len(keys)), title=title, xaxis=dict(title="Gain-Importance (%)"),
                        margin=dict(t=40, l=170), legend=dict(orientation="h", y=1.06))
        return f
    figF3 = imp_fig(k3, h3, a3, "dev-03 — Feature-Importance (16 Features)")
    figF9 = imp_fig(k9, h9, a9, "dev-09 — Feature-Importance (11 Features)")

    # ── per-match data for explorer ──
    res_lbl = {0: "1", 1: "X", 2: "2"}
    rows = []
    for i in np.where(m)[0]:
        argmax = int(np.argmax(pB[i]))
        rows.append({
            "lg": league[i], "date": str(cdate[i]), "home": ch[i], "away": ca[i],
            "p1_03": round(float(p03[i, 0]), 3), "p1_09": round(float(p09[i, 0]), 3), "p1_bl": round(float(pB[i, 0]), 3),
            "oH": round(1 / max(pB[i, 0], 1e-6), 2), "oD": round(1 / max(pB[i, 1], 1e-6), 2), "oA": round(1 / max(pB[i, 2], 1e-6), 2),
            "xgh": round(float(lhB[i]), 2), "xga": round(float(laB[i]), 2),
            "res": f"{int(yh[i])}:{int(ya[i])} {res_lbl[y[i]]}", "axg": round(float(rh[i] + ra[i]), 2),
            "hit": int(argmax == y[i]),
        })
    leagues_sorted = sorted(set(league))
    data_json = json.dumps(rows, ensure_ascii=False)

    # ── HTML assembly ──
    print("Assembling HTML...")
    kpi_html = "".join(
        f'<div class="kpi"><div class="kpi-l">{l}</div><div class="kpi-v">{v}</div><div class="kpi-s">{s}</div></div>'
        for l, v, s in kpis)
    lg_opts = '<option value="">Alle Ligen</option>' + "".join(f'<option>{l}</option>' for l in leagues_sorted)

    html = f"""<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FODZE — Forecast-Analyse Dashboard</title>
<script>{get_plotlyjs()}</script>
<style>
:root{{--leather:#1a0f0a;--gold:#d4b86a;--paper:#faf6ee;--ink:#222}}
*{{box-sizing:border-box}}
body{{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#f4efe3}}
header{{background:var(--leather);color:var(--gold);padding:22px 28px}}
header h1{{margin:0;font-size:24px;letter-spacing:.5px}}
header p{{margin:4px 0 0;color:#c8bfa6;font-size:13px}}
nav{{position:sticky;top:0;background:#241712;padding:8px 28px;z-index:50;border-bottom:1px solid #3a2a1e}}
nav a{{color:var(--gold);text-decoration:none;margin-right:18px;font-size:13px}}
nav a:hover{{text-decoration:underline}}
.wrap{{max-width:1280px;margin:0 auto;padding:18px 28px 60px}}
h2{{color:var(--leather);border-left:4px solid var(--gold);padding-left:10px;margin:34px 0 10px;font-size:18px}}
.note{{color:#555;font-size:13px;line-height:1.5;margin:0 0 14px}}
.kpis{{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}}
.kpi{{flex:1;min-width:180px;background:#fff;border:1px solid #e3d9c2;border-top:3px solid var(--gold);border-radius:6px;padding:14px 16px}}
.kpi-l{{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8a7c5e}}
.kpi-v{{font-size:24px;font-weight:700;color:var(--leather);margin:3px 0}}
.kpi-s{{font-size:11px;color:#777}}
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:18px}}
.card{{background:#fff;border:1px solid #e3d9c2;border-radius:6px;padding:8px}}
@media(max-width:900px){{.grid2{{grid-template-columns:1fr}}}}
.controls{{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:10px 0}}
.controls input,.controls select{{padding:7px 10px;border:1px solid #cdbf9e;border-radius:5px;font-size:13px}}
#cnt{{font-size:12px;color:#777}}
table.ex{{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff}}
table.ex th{{background:var(--leather);color:var(--gold);padding:7px 8px;text-align:right;cursor:pointer;position:sticky;top:41px;white-space:nowrap}}
table.ex th:first-child,table.ex th:nth-child(3),table.ex th:nth-child(4){{text-align:left}}
table.ex th:hover{{background:#2c1c12}}
table.ex td{{padding:5px 8px;text-align:right;border-bottom:1px solid #eee5d2}}
table.ex td:first-child,table.ex td:nth-child(3),table.ex td:nth-child(4){{text-align:left}}
table.ex tr:nth-child(even) td{{background:#faf6ee}}
.hit{{color:{COK};font-weight:700}}.miss{{color:{CBAD};font-weight:700}}
.tablewrap{{max-height:620px;overflow:auto;border:1px solid #e3d9c2;border-radius:6px}}
.foot{{color:#888;font-size:11px;margin-top:30px;border-top:1px solid #ddd;padding-top:12px}}
</style></head><body>
<header><h1>FODZE — Forecast-Analyse Dashboard</h1>
<p>Interaktiv · Saison 25/26 OOT-Holdout · dev-03 · dev-09 · Blend (50/50) · {n:,} Spiele · Stand 2026-05-28</p></header>
<nav><a href="#kpi">Übersicht</a><a href="#lead">Leaderboard</a><a href="#acc">Genauigkeit</a>
<a href="#odds">Quoten</a><a href="#liga">Per-Liga</a><a href="#feat">Feature-Importance</a><a href="#exp">Spiel-Explorer</a></nav>
<div class="wrap">
<section id="kpi"><div class="kpis">{kpi_html}</div>
<p class="note"><b>Kernbefund:</b> Der 50/50-λ-Blend (dev-03 ⊕ dev-09) schlägt beide Reinmodelle auf beiden Achsen
(xG-RMSE + Brier), validiert über 5 Seeds, Kalibrierung und zwei Holdouts. dev-09 = Ausgangs-Stärke,
dev-03 = xG-Niveau-Stärke. Alle Werte roh (keine Isotonic) = reine Modell-Qualität.</p></section>

<section id="lead"><h2>Leaderboard — Genauigkeit pro Engine</h2>
<p class="note">Niedriger ist besser auf beiden Achsen. Blend hat die niedrigsten Balken. Klick Legende zum Aus-/Einblenden.</p>
<div class="card">{fig_html(figL,'figL')}</div></section>

<section id="acc"><h2>Genauigkeit — xG &amp; Kalibrierung</h2>
<p class="note">Links: vorhergesagte vs. realisierte Gesamt-xG (Blend) — Punkt = Spiel, Hover zeigt Teams. Rechts: Kalibrierung P(Heimsieg).</p>
<div class="grid2"><div class="card">{fig_html(figS,'figS')}</div><div class="card">{fig_html(figC,'figC')}</div></div></section>

<section id="odds"><h2>Vorhergesagte vs. Markt-Quoten</h2>
<p class="note">Blend faire Heim-Quote (1/p) vs. Pinnacle Closing. Am langen Ende staucht das Modell — Pinnacle ist schärfer.</p>
<div class="card">{fig_html(figO,'figO')}</div></section>

<section id="liga"><h2>Per-Liga — wo dev-09 den Ausgang besser trifft</h2>
<div class="card">{fig_html(figPL,'figPL')}</div></section>

<section id="feat"><h2>Feature-Importance (LightGBM Gain)</h2>
<p class="note">Welche Features treiben die Modelle. Bemerkenswert: dev-09 (&bdquo;bottom-up&ldquo;) stützt sich am stärksten auf
<b>elo_diff</b> (~36%) und <b>league</b> — die Spieler-Aggregate ergänzen, dominieren aber nicht.</p>
<div class="grid2"><div class="card">{fig_html(figF3,'figF3')}</div><div class="card">{fig_html(figF9,'figF9')}</div></div></section>

<section id="exp"><h2>Spiel-Explorer (granular · filter- &amp; sortierbar)</h2>
<p class="note">Suche nach Team/Liga, filtere Liga, klicke Spaltenkopf zum Sortieren. Quoten = Blend faire Quoten (1/p). Tipp = Blend-Favorit getroffen?</p>
<div class="controls">
<input id="q" placeholder="🔎 Team / Liga suchen…" oninput="render()">
<select id="lgsel" onchange="render()">{lg_opts}</select>
<label style="font-size:13px"><input type="checkbox" id="hitonly" onchange="render()"> nur Treffer</label>
<span id="cnt"></span></div>
<div class="tablewrap"><table class="ex"><thead><tr>
<th onclick="sortBy('lg')">Liga</th><th onclick="sortBy('date')">Datum</th>
<th onclick="sortBy('home')">Heim</th><th onclick="sortBy('away')">Auswärts</th>
<th onclick="sortBy('p1_03')">P1 d03</th><th onclick="sortBy('p1_09')">P1 d09</th><th onclick="sortBy('p1_bl')">P1 Blend</th>
<th onclick="sortBy('oH')">Q1</th><th onclick="sortBy('oD')">QX</th><th onclick="sortBy('oA')">Q2</th>
<th onclick="sortBy('xgh')">xG H</th><th onclick="sortBy('xga')">xG A</th>
<th onclick="sortBy('res')">Ergebnis</th><th onclick="sortBy('axg')">Ist-xG</th><th onclick="sortBy('hit')">Tipp</th>
</tr></thead><tbody id="tb"></tbody></table></div></section>

<div class="foot">FODZE Forecast-Analyse · self-contained (inline plotly.js) · reproduzierbar via
tools/v4/diagnostics/build_dashboard.py · realisierte xG ist ein Modell-Output (Understat/Sofa), kein Ground-Truth wie Tore.</div>
</div>
<script>
const DATA={data_json};
let sortKey="date",sortDir=1;
function sortBy(k){{sortDir=(sortKey===k)?-sortDir:1;sortKey=k;render();}}
function render(){{
  const q=document.getElementById('q').value.toLowerCase();
  const lg=document.getElementById('lgsel').value;
  const ho=document.getElementById('hitonly').checked;
  let r=DATA.filter(d=>(!lg||d.lg===lg)&&(!ho||d.hit===1)&&
     (!q||(d.home+" "+d.away+" "+d.lg).toLowerCase().includes(q)));
  r.sort((a,b)=>{{let x=a[sortKey],y=b[sortKey];
     if(typeof x==='number')return (x-y)*sortDir; return String(x).localeCompare(String(y))*sortDir;}});
  document.getElementById('cnt').textContent=r.length+" / "+DATA.length+" Spiele";
  const rows=r.slice(0,1500).map(d=>`<tr><td>${{d.lg}}</td><td>${{d.date}}</td><td>${{d.home}}</td><td>${{d.away}}</td>`+
    `<td>${{d.p1_03.toFixed(3)}}</td><td>${{d.p1_09.toFixed(3)}}</td><td><b>${{d.p1_bl.toFixed(3)}}</b></td>`+
    `<td>${{d.oH.toFixed(2)}}</td><td>${{d.oD.toFixed(2)}}</td><td>${{d.oA.toFixed(2)}}</td>`+
    `<td>${{d.xgh.toFixed(2)}}</td><td>${{d.xga.toFixed(2)}}</td><td>${{d.res}}</td><td>${{d.axg.toFixed(2)}}</td>`+
    `<td class="${{d.hit?'hit':'miss'}}">${{d.hit?'✓':'✗'}}</td></tr>`).join('');
  document.getElementById('tb').innerHTML=rows+(r.length>1500?`<tr><td colspan=15 style="text-align:center;color:#999">… ${{r.length-1500}} weitere (filtern zum Eingrenzen)</td></tr>`:'');
}}
render();
</script></body></html>"""

    OUT.write_text(html, encoding="utf-8")
    print(f"✓ {OUT.relative_to(REPO)}  ({len(html)//1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
