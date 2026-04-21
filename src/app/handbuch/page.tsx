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
      <h2 style={S.sectionTitle}>Die 3 Prediction Engines</h2>
      <p style={S.p}>
        Oben im Spieltag kannst du zwischen 3 Engines wechseln. Jede hat Stärken und Schwächen.
      </p>

      <h3 style={S.h3}>@annafrick13 v2 + Dirichlet (Default)</h3>
      <p style={S.p}>
        LightGBM Tweedie mit 21 npxG-Features (Momentum, Volatility, PPDA, Setpiece-Share, Game-State-xG),
        Monotonic Constraints auf 10/14 physisch eindeutigen Features, Optuna-tuned ρ=−0,053.
        Danach Dirichlet-ODIR Kalibrierung pro Liga-Cluster (top5 / mid_european / lower).
      </p>
      <p style={S.p}>
        OOT-Metriken auf 6.691 Zeilen (2023-08 → 2024-06):
        Brier 0,6083 · BSS +0,0649 · ECE 0,0049 (2,6× besser kalibriert als roh).
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

      <h3 style={S.h3}>Standard (ensemble-v1)</h3>
      <p style={S.p}>
        4-Modell Ensemble: Dixon-Coles + Elo + Logistic + Market. Historischer Default der Version 7.0,
        immer noch verfügbar als Fallback.
      </p>
      <p style={S.muted}>→ Nutze wenn v2 refuses (fehlende xG-Historie) und du trotzdem 1X2 brauchst.</p>

      <h3 style={S.h3}>Engine-Vergleich im Match-Detail</h3>
      <p style={S.p}>
        Alle 3 laufen immer parallel. Im Match-Detail siehst du sie side-by-side.
      </p>
      <ul style={S.list}>
        <li>Spread &lt; 8pp → <TagAgree /> → verlässlich</li>
        <li>Spread ≥ 8pp → <TagDisagree /> → im Zweifel nicht wetten</li>
      </ul>

      <h3 style={S.h3}>Nachgeschaltete Layer (optional per Env-Flag)</h3>
      <ul style={S.list}>
        <li><span style={S.em}>Dirichlet-ODIR</span> — 3×3 W-Matrix + Bias pro Liga-Cluster, default an seit März 2026</li>
        <li><span style={S.em}>Benter-Blend</span> — Log-Pool mit Pinnacle Close, nur auf 4 Ligen aktiv (β₁ ≥ 0,15 Gate)</li>
        <li><span style={S.em}>Conformal Gate</span> — Singleton-Prediction-Sets als Kelly-Filter (off/warn/enforce/dampen), default off</li>
      </ul>
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
      <h2 style={S.sectionTitle}>Die Goldilocks-Zone</h2>
      <p style={S.p}>
        Warum <LinkPath href="/goldilocks">/goldilocks</LinkPath> nur Wetten mit Edge <span style={S.em}>2.5% bis 7.5%</span> zeigt:
      </p>
      <ul style={S.list}>
        <li><span style={S.em}>Unter 2.5%</span> — statistisches Rauschen, wahrscheinlich kein echter Edge</li>
        <li><span style={S.em}>Über 7.5%</span> — verdächtig: der Markt weiß vermutlich etwas, das du nicht weißt (Aufstellung, Verletzung, Rotation)</li>
        <li>Der Sweet Spot: groß genug für realen Profit, klein genug um realistisch zu sein</li>
      </ul>

      <h3 style={S.h3}>Grade A / B / C</h3>
      <ul style={S.list}>
        <li><TagA /> — ≥ 5%, stärkste Picks</li>
        <li><TagB /> — 4–5%, solide</li>
        <li><TagC /> — 2.5–4%, marginal</li>
      </ul>

      <p style={S.muted}>
        Auf <LinkPath href="/goldilocks">/goldilocks</LinkPath> sortiert nach Edge desc.
        Tippe eine Karte → du landest direkt beim Match in der Analyse.
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
