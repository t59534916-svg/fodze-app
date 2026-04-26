"use client";
import { useState } from "react";
import Link from "next/link";
import AppShell from "@/components/layout/AppShell";
import { color, fontSize, fontWeight, fontFamily, radius, space } from "@/styles/tokens";
import { badge, card } from "@/styles/components";

// ─── Types ────────────────────────────────────────────────────────

type SectionKey =
  | "einstieg"
  | "seiten"
  | "engines"
  | "value"
  | "goldilocks"
  | "bankroll"
  | "workflow"
  | "faq";

interface Section {
  key: SectionKey;
  title: string;
}

const SECTIONS: Section[] = [
  { key: "einstieg",   title: "Erste Schritte" },
  { key: "seiten",     title: "Hauptseiten" },
  { key: "engines",    title: "Die 3 Engines" },
  { key: "value",      title: "Value Betting" },
  { key: "goldilocks", title: "Goldilocks-Zone" },
  { key: "bankroll",   title: "Bankroll-Regeln" },
  { key: "workflow",   title: "Workflow-Tipps" },
  { key: "faq",        title: "FAQ" },
];

// ─── Shared tag styles — delegate to the design-system badge() factory ──
// (critique item: custom tagGood/tagWarn/tagGold inlined three times)
const TagA = () => <span style={badge("value")}>A</span>;
const TagB = () => <span style={badge("gold")}>B</span>;
const TagC = () => <span style={badge("gold")}>C</span>;
const TagDF = () => <span style={badge("warn")}>D/F</span>;
const TagAgree = () => <span style={badge("value")}>einig</span>;
const TagDisagree = () => <span style={badge("warn")}>uneinig</span>;

// ─── Styles ───────────────────────────────────────────────────────
// Reduced gold palette: only color.goldShine for section titles,
// color.gold for inline highlights. Removes 4→2 gold variants.

const S = {
  header: {
    textAlign: "center" as const,
    marginBottom: space[5],
    paddingTop: space[4],
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: color.goldShine,
    marginTop: 0,
    marginBottom: space[2],
    fontFamily: fontFamily.serif,
  } as React.CSSProperties,
  subtitle: {
    fontSize: fontSize.sm,
    color: color.textMuted,
  } as React.CSSProperties,
  progress: {
    fontSize: fontSize.xs,
    color: color.textFaint,
    marginTop: space[2],
    fontFamily: fontFamily.mono,
    fontVariantNumeric: "tabular-nums" as const,
  } as React.CSSProperties,
  nav: {
    display: "grid",
    // 2 columns on mobile, 4 on ≥480px via media query in <style>. The
    // previous auto-fit minmax(120px, 1fr) created unpredictable 1-4
    // column splits depending on viewport.
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: space[2],
    marginBottom: space[5],
  } as React.CSSProperties,
  navBtn: (active: boolean) => ({
    padding: `${space[3]}px ${space[3]}px`,
    minHeight: 44,
    borderRadius: radius.sm,
    border: `1px solid ${active ? color.gold : color.border}`,
    background: active ? `${color.gold}15` : "transparent",
    color: active ? color.gold : color.text,
    fontSize: fontSize.xs,
    fontWeight: active ? fontWeight.semibold : fontWeight.medium,
    cursor: "pointer",
    transition: "all 0.15s",
    textAlign: "center" as const,
    letterSpacing: "0.02em",
  }),
  card: { ...card(), marginBottom: space[3] } as React.CSSProperties,
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: color.goldShine,
    marginTop: 0,
    marginBottom: space[3],
    fontFamily: fontFamily.serif,
  } as React.CSSProperties,
  h3: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: color.gold,
    marginTop: space[4],
    marginBottom: space[2],
    letterSpacing: "0.03em",
  } as React.CSSProperties,
  p: {
    fontSize: fontSize.sm,
    color: color.text,
    lineHeight: 1.6,
    margin: `0 0 ${space[3]}px 0`,
  } as React.CSSProperties,
  muted: {
    fontSize: fontSize.xs,
    color: color.textMuted,
    lineHeight: 1.5,
  } as React.CSSProperties,
  list: {
    fontSize: fontSize.sm,
    color: color.text,
    lineHeight: 1.7,
    paddingLeft: space[5],
    margin: `0 0 ${space[3]}px 0`,
  } as React.CSSProperties,
  // Inline highlight — used sparingly. Max 2-3 per paragraph.
  em: { color: color.gold, fontWeight: fontWeight.semibold } as React.CSSProperties,
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    background: color.goldGhost,
    color: color.gold,
    padding: "1px 5px",
    borderRadius: 3,
  } as React.CSSProperties,
  linkPath: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    background: color.goldGhost,
    color: color.gold,
    padding: "1px 5px",
    borderRadius: 3,
    textDecoration: "none",
    borderBottom: `1px dashed ${color.goldMuted}`,
    transition: "all 0.15s",
  } as React.CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: fontSize.xs,
    marginBottom: space[3],
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: `${space[2]}px ${space[3]}px`,
    borderBottom: `1px solid ${color.border}`,
    color: color.textMuted,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    fontSize: 10,
  } as React.CSSProperties,
  td: {
    padding: `${space[2]}px ${space[3]}px`,
    borderBottom: `1px solid ${color.border}60`,
    color: color.text,
  } as React.CSSProperties,
  example: {
    background: color.leather2,
    padding: space[3],
    borderRadius: radius.sm,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    marginBottom: space[3],
    lineHeight: 1.6,
  } as React.CSSProperties,
  // Prev/Next navigation strip at bottom of each section
  pager: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: space[2],
    marginBottom: space[4],
  } as React.CSSProperties,
  pagerBtn: (disabled: boolean, dir: "prev" | "next") => ({
    padding: `${space[3]}px ${space[4]}px`,
    minHeight: 48,
    borderRadius: radius.sm,
    border: `1px solid ${disabled ? color.border : color.goldMuted}`,
    background: disabled ? "transparent" : color.goldGhost,
    color: disabled ? color.textFaint : color.gold,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    cursor: disabled ? "default" : "pointer",
    transition: "all 0.15s",
    opacity: disabled ? 0.4 : 1,
    textAlign: dir === "prev" ? ("left" as const) : ("right" as const),
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
    alignItems: dir === "prev" ? ("flex-start" as const) : ("flex-end" as const),
  }),
  pagerLabel: {
    fontSize: 10,
    color: color.textFaint,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    fontWeight: fontWeight.medium,
  } as React.CSSProperties,
  pagerTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  } as React.CSSProperties,
  disclaimer: {
    ...card("warn"),
    fontSize: fontSize.sm,
    color: color.text,
    lineHeight: 1.6,
  } as React.CSSProperties,
  disclaimerTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: color.warn,
    marginBottom: space[2],
    letterSpacing: "0.03em",
  } as React.CSSProperties,
  disclaimerLink: {
    color: color.gold,
    textDecoration: "underline",
    textDecorationColor: color.goldMuted,
  } as React.CSSProperties,
};

// ─── Helper: clickable in-app path ────────────────────────────────
// Replaces <code style={S.code}>/matchday</code> with a real link.
function LinkPath({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} style={S.linkPath}>
      {children}
    </Link>
  );
}

// ─── Section Renderers ─────────────────────────────────────────────

function Einstieg() {
  return (
    <>
      <h2 style={S.sectionTitle}>Erste Schritte</h2>
      <ol style={S.list}>
        <li>Login mit deinem Account</li>
        <li>Liga auf der <LinkPath href="/">Startseite</LinkPath> auswählen</li>
        <li>Bankroll + Risikoprofil (K/M/A) im Profil festlegen</li>
        <li>Spieltag aufrufen → Spiel antippen → Analyse lesen</li>
        <li>Quoten eintragen → Edge + Kelly wird berechnet</li>
        <li>Wette extern platzieren → in App eintragen fürs Tracking</li>
      </ol>
      <p style={S.muted}>
        Die App trackt deine Wetten und rechnet sie nach Spielende automatisch ab.
        Performance-Statistik auf <LinkPath href="/performance">/performance</LinkPath>.
      </p>
    </>
  );
}

function Seiten() {
  return (
    <>
      <h2 style={S.sectionTitle}>Die Hauptseiten</h2>

      <h3 style={S.h3}>Home</h3>
      <p style={S.p}>
        Liga-Übersicht mit Status-Indikator. <LinkPath href="/">Home öffnen</LinkPath>
      </p>

      <h3 style={S.h3}>Analyse · <LinkPath href="/matchday">/matchday</LinkPath></h3>
      <p style={S.p}>
        Zentrale Wett-Seite. Pro Spiel: Trikots, Wahrscheinlichkeits-Bar, Tags, Quoten-Eingabe.
        Tippen für Match-Detail mit 3 Tabs: <span style={S.em}>Überblick</span> (inkl. Engine-Vergleich),
        <span style={S.em}> Quoten</span> und <span style={S.em}>Statistik</span>.
      </p>

      <h3 style={S.h3}>Value · <LinkPath href="/goldilocks">/goldilocks</LinkPath></h3>
      <p style={S.p}>
        Automatisch gefilterte Wetten mit Edge 2.5%–7.5%. Dein primärer Einstiegspunkt.
        Tippen einer Karte → direkt zum Match in der Analyse.
      </p>

      <h3 style={S.h3}>Anna&apos;s Analysen · <LinkPath href="/fuck-betting">/fuck-betting</LinkPath></h3>
      <p style={S.p}>
        Quotenfreier Vollreport. 30+ Markt-Sektionen pro Match. Für Tiefenanalyse.
      </p>

      <h3 style={S.h3}>Stats · <LinkPath href="/performance">/performance</LinkPath></h3>
      <p style={S.p}>
        Deine Wett-Historie, Live-Kalibrierung, Teilen-Funktion (1080×1350 Instagram-Wettscheine).
        Zusätzlich vier Tabs: <span style={S.em}>Übersicht</span>, <span style={S.em}>Kalibrierung</span>
        (Isotonic-Kurven als Legacy-Fallback), <span style={S.em}>P&amp;L Simulation</span>,
        <span style={S.em}> Cross-Engine</span> (aktuelle OOT-Brier/BSS/ECE/Coverage pro Engine, 4×4 Kelly-Matrix).
        Plus per-Liga CLV-Breakdown mit z-Score und Kelly-Multiplier.
      </p>

      <h3 style={S.h3}>System-Status · <LinkPath href="/health">/health</LinkPath></h3>
      <p style={S.p}>
        Live Engine-Health-Dashboard (URL-only, kein Navbar-Tab). Vier Sections:
        <span style={S.em}> Calibration Layer</span> (welche Phase 2.x Layer geladen sind, mit env-Wert + Brier-Effekt),
        <span style={S.em}> Supabase Tabellen</span> (row counts + freshness + status pills),
        <span style={S.em}> Datenquellen-Freshness</span> (per-source last update mit fresh/stale/dead flags),
        <span style={S.em}> Bet Portfolio</span> (CLV-Coverage). Ersetzt 30-min SQL-Probing durch 5-Sekunden Browser-Visit.
      </p>

      <h3 style={S.h3}>Kombis &amp; Simulator</h3>
      <p style={S.p}>
        <LinkPath href="/matchday/combos">Kombi-Builder</LinkPath> für System-Wetten ·
        {" "}
        <LinkPath href="/simulator">Simulator</LinkPath> für Monte-Carlo-Experimente.
      </p>
    </>
  );
}

function Engines() {
  return (
    <>
      <h2 style={S.sectionTitle}>Die Prediction Engines</h2>
      <p style={S.p}>
        Oben im Spieltag kannst du zwischen den Engines wechseln. Jede hat Stärken und Schwächen.
      </p>

      <h3 style={S.h3}>@annafrick13 v2 + Dirichlet (Default)</h3>
      <p style={S.p}>
        LightGBM Tweedie mit 21 npxG-Features (Momentum, Volatility, PPDA, Setpiece-Share, Game-State-xG),
        Monotonic Constraints auf 10/14 physisch eindeutigen Features.
        Danach Dirichlet-ODIR Kalibrierung pro Liga-Cluster (top5 / mid_european / lower).
      </p>
      <p style={S.p}>
        OOT-Metriken auf 6.691 Zeilen (2023-08 → 2024-06):
        Brier 0,6083 · BSS +0,0649 · ECE 0,0049 (3× besser kalibriert als roh).
        Details + Per-Liga-Breakdown im <LinkPath href="/performance">Cross-Engine</LinkPath> Tab.
      </p>
      <p style={S.muted}>→ Default seit Deploy. Nutze wenn du unsicher bist — schlägt Climatology in 18/18 Ligen.</p>

      <h3 style={S.h3}>@annafrick13 v1 (poisson-ml)</h3>
      <p style={S.p}>
        Poisson GLM mit 9 Features + Dixon-Coles 15×15 Matrix. Alle Märkte aus einer konsistenten Quelle.
      </p>
      <p style={S.p}>
        OOT-Brier 0,6518 · BSS −0,0019 (verliert knapp gegen Climatology).
      </p>
      <p style={S.muted}>→ Wähle nur für konsistente Over/Under + Correct Score; bei 1X2 ist v2 besser.</p>

      <h3 style={S.h3}>@annafrick13 v3 Lean (Preview)</h3>
      <p style={S.p}>
        LightGBM Tweedie mit 20 dense Features (xG core + Elo + h2h + physis + discipline). Optuna 50-trial
        getuned, 90-Tage Recency-Decay gegen Time-Drift. Trainiert auf 76.611 FootyStats rows.
      </p>
      <p style={S.p}>
        Holdout-Brier 0,6318 (n=6498) — drift home +1,2% / away −1,8% (Time-Drift fully contained).
      </p>
      <p style={S.muted}>
        → Preview-only — routet intern zu v2. Schema-Gap zu v2 (0,024 Brier) ist strukturell, nicht
        hyperparameter-fixable: v2 hat Understat-trained npxg/ppda/deep features, die v3 wegen 0%-Coverage
        in current schema droppen musste.
      </p>

      <h3 style={S.h3}>Standard (ensemble-v1)</h3>
      <p style={S.p}>
        4-Modell Ensemble: Dixon-Coles + Elo + Logistic + Market. Historischer Default der Version 7.0,
        immer noch verfügbar als Fallback.
      </p>
      <p style={S.muted}>→ Nutze wenn v2 refuses (fehlende xG-Historie) und du trotzdem 1X2 brauchst.</p>

      <h3 style={S.h3}>Engine-Vergleich im Match-Detail</h3>
      <p style={S.p}>
        Alle Engines laufen immer parallel. Im Match-Detail siehst du sie side-by-side.
      </p>
      <ul style={S.list}>
        <li>Spread &lt; 8pp → <TagAgree /> → verlässlich</li>
        <li>Spread ≥ 8pp → <TagDisagree /> → im Zweifel nicht wetten</li>
      </ul>

      <h3 style={S.h3}>Phase 2.x Calibration Layer (alle 4 LIVE seit 2026-04-26)</h3>
      <p style={S.p}>
        Nachgeschaltete Layer, die auf jede Engine-Prediction angewendet werden. Live-Status pro Layer
        siehst du auf <LinkPath href="/health">/health</LinkPath>.
      </p>
      <ul style={S.list}>
        <li>
          <span style={S.em}>Dirichlet 1X2</span> — 3-Cluster ODIR (top5 / mid_european / lower).
          Gemessen −0,0019 Brier, ECE 0,0146 → 0,0049
        </li>
        <li>
          <span style={S.em}>Benter Market×Modell-Blend</span> — Per-Liga β₁/β₂ aus n=5586 OOT.
          In 6 von 16 Ligen schlägt das Modell den Markt (z.B. super_lig β₂=1,31, EPL β₂=1,17)
        </li>
        <li>
          <span style={S.em}>Conformal Staking-Gate</span> — Singleton-Prediction-Sets, mode=warn (Set-Size logging,
          aber Kelly-Stake unverändert). Coverage 96,7% empirisch @ α=0,05
        </li>
        <li>
          <span style={S.em}>Per-Liga Overdispersion α</span> — Fitted Negative-Binomial-α pro Liga statt
          konservative Defaults. Tighter O25/U25 PMFs (serie_a −52%, la_liga −31%)
        </li>
      </ul>
      <p style={S.muted}>
        Alle 4 Layer per Environment-Variables aktiviert; failure-safe (corrupt JSON → fallback auf Default,
        keine Production-Risk).
      </p>
    </>
  );
}

function ValueBetting() {
  return (
    <>
      <h2 style={S.sectionTitle}>Value Betting Basics</h2>

      <h3 style={S.h3}>Wie eine Wette Value wird</h3>
      <div style={S.example}>
        Modell-Wahrscheinlichkeit: 40% → faire Quote 2.50<br />
        Buchmacher-Quote:         2.80 → impliziert 35.7%<br />
        <span style={{ color: color.value }}>Edge: +4.3% → Grade B ✅</span>
      </div>
      <p style={S.p}>
        Nur wenn die Buchmacher-Quote höher ist als dein Modell es fair findet, hast du Edge.
      </p>

      <h3 style={S.h3}>Edge-Grading (Goldilocks-aligned)</h3>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Grade</th>
            <th style={S.th}>Edge</th>
            <th style={S.th}>Empfehlung</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style={S.td}><TagA /></td><td style={S.td}>5,0–7,5%</td><td style={S.td}>Stärkste Picks — Kelly voll fahren (gecappt)</td></tr>
          <tr><td style={S.td}><TagB /></td><td style={S.td}>4,0–5,0%</td><td style={S.td}>Solide — Kelly voll fahren</td></tr>
          <tr><td style={S.td}><TagC /></td><td style={S.td}>2,5–4,0%</td><td style={S.td}>Marginal — nur wenn sonst nichts</td></tr>
          <tr><td style={S.td}><TagDF /></td><td style={S.td}>&lt; 2,5% oder &gt; 7,5%</td><td style={S.td}>Skip (Rauschen bzw. verdächtig)</td></tr>
        </tbody>
      </table>
      <p style={S.muted}>
        Konsistent mit der <LinkPath href="/goldilocks">Goldilocks-Zone</LinkPath>. Alles außerhalb
        [2,5% – 7,5%] wird nicht angezeigt — nicht weil die App vorsichtig ist, sondern weil die
        Zahlen außerhalb der Bande nicht zuverlässig ROI bringen.
      </p>

      <h3 style={S.h3}>Kelly-Kriterium</h3>
      <p style={S.p}>
        Optimale Einsatzgröße, basierend auf deinem Risikoprofil:
      </p>
      <ul style={S.list}>
        <li><span style={S.em}>K</span> (Konservativ) = ¼ Kelly</li>
        <li><span style={S.em}>M</span> (Moderat) = ⅓ Kelly <span style={S.muted}>— Default</span></li>
        <li><span style={S.em}>A</span> (Aggressiv) = ½ Kelly</li>
      </ul>
      <p style={S.muted}>
        Voll-Kelly (1.0) ist zu riskant. Selbst Profis nutzen ⅛–½.
      </p>
    </>
  );
}

function Goldilocks() {
  return (
    <>
      <h2 style={S.sectionTitle}>Die Goldilocks-Zone (per-Liga 3-Tier)</h2>
      <p style={S.p}>
        <LinkPath href="/goldilocks">/goldilocks</LinkPath> filtert Wetten nach Edge — aber die Schwelle ist
        <span style={S.em}> liga-spezifisch</span>. Sharper Markt = enger Korridor; weicher Markt = breiterer.
        Was in EPL Value ist, wäre in League Two Rauschen.
      </p>

      <h3 style={S.h3}>Die 3 Liga-Tiers</h3>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Tier</th>
            <th style={S.th}>Goldilocks</th>
            <th style={S.th}>Trap-Soft</th>
            <th style={S.th}>Trap-Hard</th>
            <th style={S.th}>Beispiel-Ligen</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={S.td}><span style={badge("value")}>Sharp</span></td>
            <td style={S.td}>1,5–5%</td>
            <td style={S.td}>8%</td>
            <td style={S.td}>10%</td>
            <td style={S.td}>EPL, La Liga, Serie A, Bundesliga, Ligue 1, CL/EL</td>
          </tr>
          <tr>
            <td style={S.td}><span style={badge("gold")}>Moderate</span></td>
            <td style={S.td}>2,5–7,5%</td>
            <td style={S.td}>10%</td>
            <td style={S.td}>12%</td>
            <td style={S.td}>Championship, BL2, La Liga 2, Serie B, Ligue 2, Eredivisie, Primeira, Jupiler Pro, Süper Lig, Swiss SL, Austria BL, Scottish Prem (12 Ligen)</td>
          </tr>
          <tr>
            <td style={S.td}><span style={badge("warn")}>Soft</span></td>
            <td style={S.td}>3,5–8,5%</td>
            <td style={S.td}>12%</td>
            <td style={S.td}>15%</td>
            <td style={S.td}>Liga 3, League One, League Two, Greek SL, Eerste Divisie</td>
          </tr>
        </tbody>
      </table>

      <h3 style={S.h3}>Was die Schwellen bedeuten</h3>
      <ul style={S.list}>
        <li><span style={S.em}>Goldilocks-Range</span> — angezeigte Wetten, Kelly-Stake aktiv</li>
        <li><span style={S.em}>Soft-Skip</span> (zwischen Goldilocks-Max und Trap-Hard) — kein Bet, aber auch keine Trap-Warnung. Kann legitime Information sein, lohnt aber nicht das Risiko</li>
        <li><span style={S.em}>Hard-Trap</span> (über Trap-Hard) — TRAP?-Pill: der Markt weiß vermutlich etwas, das du nicht weißt (Lineup, Injury, Rotation). NICHT folgen</li>
      </ul>

      <h3 style={S.h3}>EdgeBadge-Lesart auf MatchCard</h3>
      <p style={S.p}>
        Jede Match-Karte hat ein EdgeBadge mit per-Liga-Meter. Pille zeigt Zone:
        <span style={badge("value")}>ZONE</span> = goldilocks, <span style={badge("gold")}>SOFT</span> = soft-skip,
        <span style={badge("warn")}>TRAP?</span> = hard-trap. Ohne Pill = innerhalb Range, normaler Bet.
      </p>

      <h3 style={S.h3}>Grade A / B / C (Moderate-Tier-Referenz)</h3>
      <ul style={S.list}>
        <li><TagA /> — ≥ 5%, stärkste Picks</li>
        <li><TagB /> — 4–5%, solide</li>
        <li><TagC /> — 2,5–4%, marginal</li>
      </ul>

      <p style={S.muted}>
        Auf <LinkPath href="/goldilocks">/goldilocks</LinkPath> sortiert nach Edge desc, automatisch je Liga
        in der korrekten Range gefiltert. Tippe eine Karte → du landest direkt beim Match in der Analyse.
        Die Per-Liga-Tiers werden in <LinkPath href="/handbuch">src/lib/league-liquidity.ts</LinkPath> gepflegt.
      </p>
    </>
  );
}

function Bankroll() {
  return (
    <>
      <h2 style={S.sectionTitle}>Bankroll-Regeln</h2>
      <p style={S.p}>Das einzige wofür du selbst verantwortlich bist.</p>

      <h3 style={S.h3}>1. Bankroll = was du verlieren darfst</h3>
      <p style={S.p}>
        Nicht dein Sparkonto. Nicht die Miete. Der Betrag, bei dem dir ein Totalverlust egal wäre.
      </p>

      <h3 style={S.h3}>2. Einzelwette ≤ 5% der Bankroll</h3>
      <p style={S.p}>
        Auch bei Grade-A mit Kelly-Empfehlung von 12% — cappe auf 5%. Varianz ist brutal.
      </p>

      <h3 style={S.h3}>3. Tagesbudget einhalten</h3>
      <p style={S.p}>
        Im Spieltag-Header oben rechts kannst du ein Tagesbudget setzen. App warnt wenn drüber.
      </p>

      <h3 style={S.h3}>4. Tracking ist nicht optional</h3>
      <p style={S.p}>
        Jede Wette eintragen → Auto-Settlement → <LinkPath href="/performance">Performance</LinkPath> zeigt ob du wirklich besser bist als der Markt.
      </p>
      <p style={S.muted}>
        ROI nach 200+ Wetten negativ? Dann hast du keinen Edge. Pause.
      </p>

      <h3 style={S.h3}>5. Tilt-Schutz</h3>
      <ul style={S.list}>
        <li>Nach 3 Verlusten in Folge → Pause</li>
        <li>Kein &quot;aufholen&quot; durch höhere Einsätze</li>
        <li>Kein &quot;all-in&quot; bei Grade-A</li>
      </ul>
    </>
  );
}

function Workflow() {
  return (
    <>
      <h2 style={S.sectionTitle}>Der ideale Wettprozess</h2>
      <ol style={S.list}>
        <li>Morgens: <LinkPath href="/goldilocks">Goldilocks</LinkPath> anschauen — welche Spiele haben Value?</li>
        <li>Interessantes Spiel öffnen → Engine-Vergleich checken (einig/uneinig?)</li>
        <li>Kontext lesen: Verletzungen, Form, Derby-Status</li>
        <li>Quoten mit deinem Buchmacher vergleichen (Best-of-30 im System)</li>
        <li>Kelly-Stake einhalten</li>
        <li>Wette platzieren + in App eintragen</li>
        <li>Auto-Settlement läuft täglich</li>
      </ol>

      <h3 style={S.h3}>Pro-Tipps</h3>
      <ul style={S.list}>
        <li>Top-5-Ligen haben die vollständigste xG-Historie — Brier 0,6083 (v2+Dirichlet); niedrigere Ligen streuen +0,03 bis +0,05 höher</li>
        <li>Ü/U 2.5 hat oft weniger Varianz als 1X2 — kommt aus der gleichen Dixon-Coles-Matrix, ist aber weniger Extrem-resistent</li>
        <li>Abendquoten sind schärfer. Frühe Freitags-Openings haben oft +3–5 bps mehr Edge, verschwinden bis Samstagmorgen</li>
        <li>Kombi-Wetten = Varianz-Gift. Singles fast immer besser.</li>
        <li>Mehrere Bookies nutzen → immer beste Quote picken (Max-Close schlägt Pinnacle-Close um +0,11 auf Home, +0,25 auf Away im Schnitt)</li>
      </ul>

      <h3 style={S.h3}>Häufige Fehler</h3>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Fehler</th>
            <th style={S.th}>Besser</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style={S.td}>Alle Spiele wetten</td><td style={S.td}>Nur Grade A/B</td></tr>
          <tr><td style={S.td}>Bauchgefühl über Modell</td><td style={S.td}>Engines einig + Edge gut → folgen</td></tr>
          <tr><td style={S.td}>Einsatz nach Verlust verdoppeln</td><td style={S.td}>Kelly-Empfehlung einhalten</td></tr>
          <tr><td style={S.td}>Lieblings-Team bewetten</td><td style={S.td}>Gegen Modell prüfen</td></tr>
          <tr><td style={S.td}>5-Leg-Kombis</td><td style={S.td}>Max 2–3 Legs, nur Grade-A-Picks</td></tr>
        </tbody>
      </table>
    </>
  );
}

function Faq() {
  return (
    <>
      <h2 style={S.sectionTitle}>FAQ</h2>

      <h3 style={S.h3}>Welche Engine soll ich nutzen?</h3>
      <p style={S.p}>
        v2 + Dirichlet ist Default und schlägt Climatology in 18/18 Ligen (BSS +0,0649, ECE 0,0049).
        Standard (ensemble-v1) nur als Fallback wenn v2 refuses. v1 Poisson-GLM ist verfügbar, aber OOT-Brier
        ist 7pp schlechter als v2 — keine Empfehlung für 1X2.
      </p>

      <h3 style={S.h3}>Warum zeigt Liga X &quot;Ohne xG&quot;?</h3>
      <p style={S.p}>
        Keine xG-History für die Liga (z.B. 3. Liga). Modell nutzt Liga-Durchschnitt als Fallback —
        weniger präzise, aber besser als Bauchgefühl.
      </p>

      <h3 style={S.h3}>Warum fehlt der Engine-Vergleich bei einem Spiel?</h3>
      <p style={S.p}>
        Mindestens eine Engine hatte keine xG-Historie. Nur Engines mit gültigen Daten werden gezeigt.
      </p>

      <h3 style={S.h3}>Meine Quote ist besser als die hier — darf ich wetten?</h3>
      <p style={S.p}>
        Ja. Die angezeigten Quoten sind Best-of-30-Bookies. Bessere Quoten = mehr Edge. Super.
      </p>

      <h3 style={S.h3}>Wie wird meine Wette abgerechnet?</h3>
      <p style={S.p}>
        Automatisch via GitHub Actions Cron (täglich 02:17 + 08:17 UTC, Montags zusätzlich 12:17).
        Du musst nichts tun.
      </p>

      <h3 style={S.h3}>Warum wechselt Engine zurück auf Standard?</h3>
      <p style={S.p}>
        v1/v2 fallbacken auf Standard wenn xG-Historie fehlt. Feature, kein Bug —
        verhindert dass v2 mit schlechten Daten halluziniert.
      </p>

      <h3 style={S.h3}>Wo sehe ich was gerade in Production aktiv ist?</h3>
      <p style={S.p}>
        Auf <LinkPath href="/health">/health</LinkPath>. Zeigt für jede Calibration-Layer (Dirichlet/Benter/
        Conformal/Overdispersion) den Loaded-Status, env-Wert und gemessenen Brier-Effekt. Plus Supabase-Tabellen
        mit Zeilen + Freshness, Datenquellen-Stati (frisch/stale/dead), und deine Bet-Coverage. Ein Klick
        statt 30 Minuten SQL-Probing.
      </p>

      <h3 style={S.h3}>Warum sehe ich für mein Spiel keinen BET-Button?</h3>
      <p style={S.p}>
        Der BET-Button erscheint nur für Bets, die das Modell als <span style={S.em}>isValue=true</span>
        klassifiziert (Edge im per-Liga Goldilocks-Korridor). Wenn du eine Wette tracken willst, die das
        Modell nicht als Value sieht (z.B. Liebhaber-Bet auf Heim-Sieg ohne Edge), nutze den
        <span style={S.em}> Manuelle Wette Tracken</span> Block oben auf <LinkPath href="/matchday">/matchday</LinkPath> —
        bypassed den Engine-Filter komplett, schreibt direkt in die bets-Tabelle.
      </p>

      <h3 style={S.h3}>Warum andere Goldilocks-Range pro Liga?</h3>
      <p style={S.p}>
        Sharper Markt = enger Korridor. EPL-Linien sind so präzise, dass +5% Edge schon verdächtig ist.
        Bei League Two oder Greek SL ist +5% Edge dagegen normal, weil die Linien weicher sind. Die 3-Tier-
        Klassifikation in <span style={S.em}>src/lib/league-liquidity.ts</span> mapped jede Liga zu Sharp/
        Moderate/Soft mit eigenen Schwellen. Details: Goldilocks-Section.
      </p>

      <h3 style={S.h3}>Was macht die CLV-Feedback Kelly-Dampening?</h3>
      <p style={S.p}>
        Wenn deine Closing-Line-Value-Statistik in einer Liga schlecht wird (z-score &lt; -1 über die
        letzten 40 settled Bets), halbiert die App automatisch deinen Kelly-Stake für diese Liga.
        Volumen-basiertes Window — funktioniert auch in Nebenligen mit wenig Spielen pro Woche.
        Pro-Liga-Multiplier siehst du im <LinkPath href="/performance">/performance</LinkPath> Tab.
      </p>

      <h3 style={S.h3}>Wo wurden die Closing-Quoten denn vor Bet-Settlement gespeichert?</h3>
      <p style={S.p}>
        Seit 2026-04-26 persistiert der snapshot-closing-odds Cron alle in-window Match-Closes nach
        <span style={S.em}> odds_closing_history</span> (auch ohne aktive User-Bet). Das heißt: auch
        wenn du nach Kickoff platzierst, kann <span style={S.em}>fetch-results.mjs</span> beim Settlement
        den CLV nachträglich rechnen. Vorher gingen retroaktive Bets ohne CLV-Tracking unter.
      </p>
    </>
  );
}

// ─── Section dispatcher ──────────────────────────────────────────

function renderSection(key: SectionKey): React.ReactNode {
  switch (key) {
    case "einstieg":   return <Einstieg />;
    case "seiten":     return <Seiten />;
    case "engines":    return <Engines />;
    case "value":      return <ValueBetting />;
    case "goldilocks": return <Goldilocks />;
    case "bankroll":   return <Bankroll />;
    case "workflow":   return <Workflow />;
    case "faq":        return <Faq />;
  }
}

// ─── Main Page ────────────────────────────────────────────────────

export default function HandbuchPage() {
  const [sectionKey, setSectionKey] = useState<SectionKey>("einstieg");

  const idx = SECTIONS.findIndex((s) => s.key === sectionKey);
  const prev = idx > 0 ? SECTIONS[idx - 1] : null;
  const next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1] : null;
  const tablistId = "handbuch-tablist";
  const panelId = `handbuch-panel-${sectionKey}`;
  const tabId = `handbuch-tab-${sectionKey}`;

  return (
    <AppShell>
      <style>{`
        @media (min-width: 480px) {
          .handbuch-nav { grid-template-columns: repeat(4, 1fr) !important; }
        }
      `}</style>

      <header style={S.header}>
        <h1 style={S.title}>Handbuch</h1>
        <div style={S.subtitle}>So nutzt du FODZE richtig</div>
        <div style={S.progress} aria-live="polite">
          Sektion {idx + 1} / {SECTIONS.length}
        </div>
      </header>

      <nav
        style={S.nav}
        className="handbuch-nav"
        role="tablist"
        aria-label="Handbuch-Sektionen"
        id={tablistId}
      >
        {SECTIONS.map((sec) => {
          const active = sec.key === sectionKey;
          return (
            <button
              key={sec.key}
              type="button"
              role="tab"
              id={`handbuch-tab-${sec.key}`}
              aria-selected={active}
              aria-controls={`handbuch-panel-${sec.key}`}
              tabIndex={active ? 0 : -1}
              style={S.navBtn(active)}
              onClick={() => setSectionKey(sec.key)}
            >
              {sec.title}
            </button>
          );
        })}
      </nav>

      <article
        style={S.card}
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId}
        tabIndex={0}
      >
        {renderSection(sectionKey)}
      </article>

      {/* Prev/Next — linear reading path */}
      <nav style={S.pager} aria-label="Sektion wechseln">
        <button
          type="button"
          disabled={!prev}
          onClick={() => prev && setSectionKey(prev.key)}
          style={S.pagerBtn(!prev, "prev")}
          aria-label={prev ? `Zurück zu ${prev.title}` : "Keine vorherige Sektion"}
        >
          <span style={S.pagerLabel}>← Zurück</span>
          <span style={S.pagerTitle}>{prev ? prev.title : "—"}</span>
        </button>
        <button
          type="button"
          disabled={!next}
          onClick={() => next && setSectionKey(next.key)}
          style={S.pagerBtn(!next, "next")}
          aria-label={next ? `Weiter zu ${next.title}` : "Keine nächste Sektion"}
        >
          <span style={S.pagerLabel}>Weiter →</span>
          <span style={S.pagerTitle}>{next ? next.title : "—"}</span>
        </button>
      </nav>

      <aside style={S.disclaimer} aria-label="Verantwortungsvolles Spielen">
        <div style={S.disclaimerTitle}>⚠️ Verantwortungsvolles Spielen</div>
        <p style={{ margin: 0 }}>
          Sportwetten sind Glücksspiel. Die App garantiert keine Gewinne.
          Wer mehr wettet als er verlieren kann, hat ein Problem.
        </p>
        <p style={{ margin: `${space[2]}px 0 0 0`, fontSize: fontSize.xs, color: color.textMuted }}>
          Hilfe:{" "}
          <a
            href="https://www.spielen-mit-verantwortung.de"
            target="_blank"
            rel="noopener noreferrer"
            style={S.disclaimerLink}
          >
            spielen-mit-verantwortung.de
          </a>
          {" · Hotline DE: "}
          <a href="tel:08001372700" style={{ ...S.disclaimerLink, fontFamily: fontFamily.mono }}>
            0800 137 27 00
          </a>
          {" (kostenlos, 24/7)"}
        </p>
      </aside>
    </AppShell>
  );
}
