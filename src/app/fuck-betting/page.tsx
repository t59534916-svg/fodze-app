"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import Kit from "@/components/shared/Kit";
import {
  LEAGUES, getHomeFactor, buildMatrix, deriveAllMarkets,
  getCorrectScores, getAsianHandicap, getHtFt, getGoalBothHalves,
  predictYellowCards, getHT1X2, getHTCorrectScores,
  getFirstGoalTime, getWinningMargin, calcLambdas,
} from "@/lib/dixon-coles";
import type { MatchdayData, RawMatch } from "@/types/match";

// ─── Types ─────────────────────────────────────────────────────────

interface MatchReport {
  home: string;
  away: string;
  league: string;
  leagueName: string;
  kickoff: string;
  lambdaH: number;
  lambdaA: number;
  matrix: number[][];
  // Full Time
  ft1X2: { H: number; D: number; A: number };
  dc: { "1X": number; "X2": number; "12": number };
  goalsOU: { O15: number; O25: number; O35: number; O45: number; O55: number };
  btts: { yes: number; no: number };
  correctScores: { score: string; p: number }[];
  winningMargin: Record<string, number>;
  asianHandicap: Record<string, { P_Win: number; P_Push: number; P_Loss: number; Fair_Odds: number }>;
  // Half Time
  ht1X2: { H: number; D: number; A: number };
  htCorrectScores: { score: string; p: number }[];
  htft: Record<string, number>;
  goalBothHalves: { yes: number; no: number };
  // Goals per team
  homeGoals: { O05: number; O15: number; O25: number };
  awayGoals: { O05: number; O15: number; O25: number };
  // Yellow Cards
  yellowCards: { expected: number; over25: number; over35: number; over45: number; over55: number };
  // Timing
  firstGoalBefore30: number;
  firstGoalBefore60: number;
  // Raw match data for analysis
  rawMatch: RawMatch;
  xgPerGameH: number;  // xg_h8 / games
  xgaPerGameH: number; // xga_h8 / games
  xgPerGameA: number;  // xg_a8 / games
  xgaPerGameA: number; // xga_a8 / games
  // Brief analysis
  analysis: string;
}

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const toOdds = (p: number) => p > 0.01 ? (1 / p).toFixed(2) : "—";

function formatKickoff(ko: string): string {
  if (!ko) return "";
  // "2026-04-04 15:30" → "Fr. 4.4. 15:30"
  const match = ko.match(/^(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})?/);
  if (!match) return ko;
  try {
    const d = new Date(match[1] + "T12:00:00");
    const days = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
    const dayStr = `${days[d.getDay()]}. ${d.getDate()}.${d.getMonth() + 1}.`;
    return match[2] ? `${dayStr} ${match[2]}` : dayStr;
  } catch { return ko; }
}

// ─── Generate analysis text ───────────────────────────────────────

function parseForm(form: string | undefined): { w: number; d: number; l: number; streak: string; len: number } {
  if (!form) return { w: 0, d: 0, l: 0, streak: "", len: 0 };
  const results = form.trim().split(/\s+/).filter(r => ["W", "D", "L"].includes(r));
  const w = results.filter(r => r === "W").length;
  const d = results.filter(r => r === "D").length;
  const l = results.filter(r => r === "L").length;
  // Current streak
  let streak = "";
  if (results.length > 0) {
    const last = results[results.length - 1];
    let count = 0;
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i] === last) count++;
      else break;
    }
    streak = `${count}${last}`;
  }
  return { w, d, l, streak, len: results.length };
}

function generateAnalysis(r: MatchReport): string {
  const { ft1X2, goalsOU, lambdaH, lambdaA, btts, ht1X2, correctScores, rawMatch: m } = r;
  const lines: string[] = [];
  const totalXG = lambdaH + lambdaA;
  const h = m.home;
  const a = m.away;
  const formH = parseForm(h.form);
  const formA = parseForm(a.form);
  const tags = m.tags || [];

  // ── 1. Main verdict with reasoning ──
  if (ft1X2.H > 0.5) {
    const reasons: string[] = [];
    if (r.xgPerGameH > 1.5) reasons.push(`stark offensiv zuhause (${r.xgPerGameH.toFixed(2)} xG/Spiel)`);
    if (r.xgaPerGameA > 1.5) reasons.push(`${r.away} defensiv anfällig auswärts (${r.xgaPerGameA.toFixed(2)} xGA/Spiel kassiert)`);
    if (formH.w >= 3 && formH.len >= 4) reasons.push(`${formH.w} von ${formH.len} Heimspielen gewonnen`);
    if (formA.l >= 2) reasons.push(`${r.away} zuletzt ${formA.l} Niederlagen in ${formA.len} Auswärtsspielen`);
    if (reasons.length === 0) reasons.push(`das xG-Profil spricht klar für die Heimmannschaft`);
    lines.push(`${r.home} geht als klarer Favorit ins Spiel (${pc(ft1X2.H)}), weil ${reasons.join(", ")}.`);
  } else if (ft1X2.A > 0.5) {
    const reasons: string[] = [];
    if (r.xgPerGameA > 1.3) reasons.push(`offensiv stark auswärts (${r.xgPerGameA.toFixed(2)} xG/Spiel)`);
    if (r.xgaPerGameH > 1.5) reasons.push(`${r.home} defensive Schwächen zuhause (${r.xgaPerGameH.toFixed(2)} xGA/Spiel kassiert)`);
    if (formA.w >= 3) reasons.push(`${formA.w} Siege in den letzten ${formA.len} Auswärtsspielen`);
    if (formH.l >= 2) reasons.push(`${r.home} zuletzt ${formH.l} Heimniederlagen`);
    if (reasons.length === 0) reasons.push(`die xG-Daten deuten auf eine auswärtsstarke Mannschaft`);
    lines.push(`${r.away} ist trotz Auswärtsspiel Favorit (${pc(ft1X2.A)}), denn ${reasons.join(", ")}.`);
  } else if (ft1X2.H > ft1X2.A + 0.08) {
    lines.push(`${r.home} mit leichtem Heimvorteil (${pc(ft1X2.H)} vs. ${pc(ft1X2.A)}). Der Unterschied ist aber gering — ${r.away} kann hier durchaus punkten.`);
    if (r.xgPerGameH > r.xgPerGameA) {
      lines.push(`${r.home} erzielt zuhause im Schnitt ${r.xgPerGameH.toFixed(2)} xG pro Spiel, ${r.away} kommt auswärts auf ${r.xgPerGameA.toFixed(2)}.`);
    }
  } else if (ft1X2.A > ft1X2.H + 0.08) {
    lines.push(`${r.away} leicht favorisiert (${pc(ft1X2.A)}), obwohl sie auswärts spielen. ${r.home} überzeugt zuhause nicht (${r.xgPerGameH.toFixed(2)} xG/Spiel).`);
  } else {
    lines.push(`Ein sehr ausgeglichenes Spiel — ${r.home} (${pc(ft1X2.H)}) und ${r.away} (${pc(ft1X2.A)}) sind nahezu gleichstark. Das Unentschieden hat mit ${pc(ft1X2.D)} eine realistische Chance.`);
  }

  // ── 2. Form analysis ──
  if (formH.len > 0 || formA.len > 0) {
    const formParts: string[] = [];
    if (formH.streak.length > 1) {
      const n = parseInt(formH.streak);
      const type = formH.streak.endsWith("W") ? "Siege" : formH.streak.endsWith("L") ? "Niederlagen" : "Unentschieden";
      if (n >= 3) formParts.push(`${r.home} mit ${n} ${type} in Serie zuhause`);
    }
    if (formA.streak.length > 1) {
      const n = parseInt(formA.streak);
      const type = formA.streak.endsWith("W") ? "Siege" : formA.streak.endsWith("L") ? "Niederlagen" : "Unentschieden";
      if (n >= 3) formParts.push(`${r.away} mit ${n} ${type} in Serie auswärts`);
    }
    if (formParts.length > 0) lines.push(formParts.join(". ") + ".");
  }

  // ── 3. xG-based goal expectation ──
  if (totalXG > 3.2) {
    lines.push(`Das Modell erwartet ein torreiches Spiel: ${r.home} generiert ${r.xgPerGameH.toFixed(2)} xG/Spiel zuhause, ${r.away} lässt auswärts ${r.xgaPerGameA.toFixed(2)} xG zu. Zusammen ergeben sich ${totalXG.toFixed(1)} erwartete Tore — Über 2.5 kommt auf ${pc(goalsOU.O25)}.`);
  } else if (totalXG < 2.2) {
    const lowReasons: string[] = [];
    if (r.xgPerGameH < 1.2) lowReasons.push(`${r.home} offensiv schwach (${r.xgPerGameH.toFixed(2)} xG/Spiel)`);
    if (r.xgPerGameA < 1.0) lowReasons.push(`${r.away} tut sich auswärts schwer (${r.xgPerGameA.toFixed(2)} xG/Spiel)`);
    if (r.xgaPerGameH < 1.1) lowReasons.push(`${r.home} defensiv stabil zuhause`);
    if (r.xgaPerGameA < 1.1) lowReasons.push(`${r.away} auch defensiv kompakt auswärts`);
    lines.push(`Ein torarmes Spiel ist wahrscheinlich (${totalXG.toFixed(1)} erw. Tore)${lowReasons.length > 0 ? ": " + lowReasons.join(", ") : ""}. Unter 2.5 bei ${pc(1 - goalsOU.O25)}.`);
  } else {
    lines.push(`Mit ${totalXG.toFixed(1)} erwarteten Toren ein durchschnittliches Spiel in Sachen Torquote. Über 2.5 Tore bei ${pc(goalsOU.O25)}, Unter 2.5 bei ${pc(1 - goalsOU.O25)}.`);
  }

  // ── 4. BTTS analysis ──
  if (btts.yes > 0.6) {
    lines.push(`Beide Teams dürften treffen (${pc(btts.yes)}): ${r.home} trifft in ${pc(r.homeGoals.O05)} der Heimspiele, ${r.away} in ${pc(r.awayGoals.O05)} auswärts.`);
  } else if (btts.yes < 0.4) {
    if (r.homeGoals.O05 > r.awayGoals.O05) {
      lines.push(`${r.away} tut sich schwer, auswärts zu treffen — BTTS Nein bei ${pc(btts.no)}. Clean Sheet ${r.home} bei ${pc(1 - r.awayGoals.O05)}.`);
    } else {
      lines.push(`${r.home} könnte ohne Tor bleiben — BTTS Nein bei ${pc(btts.no)}.`);
    }
  }

  // ── 5. HT analysis ──
  if (ht1X2.D > 0.42) {
    lines.push(`Die erste Halbzeit wird voraussichtlich torarm: HT-Unentschieden bei ${pc(ht1X2.D)}. Das 0:0 zur Pause ist der wahrscheinlichste HT-Stand (${pc(r.htCorrectScores[0]?.p || 0)}).`);
  } else if (ft1X2.H > 0.5 && ht1X2.H > 0.3) {
    lines.push(`${r.home} könnte schon zur Halbzeit führen (${pc(ht1X2.H)}).`);
  }

  // ── 6. Correct Score insight ──
  if (correctScores.length >= 3) {
    const top3 = correctScores.slice(0, 3).map(cs => `${cs.score} (${pc(cs.p)})`).join(", ");
    lines.push(`Die wahrscheinlichsten Endstände: ${top3}.`);
  }

  // ── 7. Tags (derby, etc.) ──
  if (tags.includes("DERBY")) {
    lines.push(`Als Derby-Begegnung typisch unberechenbar — Form-Tabellen spielen hier weniger eine Rolle, die Intensität steigt.`);
  }
  if (tags.includes("TOP_MATCH")) {
    lines.push(`Spitzenspiel der Liga — beide Mannschaften auf hohem Niveau, enge Partie erwartet.`);
  }

  // ── 8. Injuries / Context from AI ──
  const injuryParts: string[] = [];
  if (h.injuries) injuryParts.push(`${r.home}: ${h.injuries}`);
  if (a.injuries) injuryParts.push(`${r.away}: ${a.injuries}`);
  if (injuryParts.length > 0) {
    lines.push(`Verletzungen: ${injuryParts.join(" | ")}`);
  }

  if (m.context) {
    lines.push(m.context);
  }

  if (m.referee) {
    lines.push(`Schiedsrichter: ${m.referee}.`);
  }

  // ── 9. Key market summary ──
  const keyMarkets: string[] = [];
  if (goalsOU.O15 > 0.8) keyMarkets.push(`Ü1.5 sehr sicher (${pc(goalsOU.O15)})`);
  if (r.asianHandicap["-1"]?.P_Win > 0.55 && ft1X2.H > 0.45) keyMarkets.push(`HC -1 Heim bei ${pc(r.asianHandicap["-1"].P_Win)}`);
  if (r.goalBothHalves.yes > 0.5) keyMarkets.push(`Tor in beiden Halbzeiten bei ${pc(r.goalBothHalves.yes)}`);
  if (keyMarkets.length > 0) {
    lines.push(`Auffällige Märkte: ${keyMarkets.join(", ")}.`);
  }

  return lines.join("\n\n");
}

// ─── Styles ────────────────────────────────────────────────────────

const S = {
  card: { background: "#c4a26508", border: "1px solid #c4a26518", borderRadius: 10, padding: 12, marginBottom: 8 } as React.CSSProperties,
  sectionLabel: { fontSize: 9, fontWeight: 700, color: "#a89070", letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: 6 } as React.CSSProperties,
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", fontSize: 12 } as React.CSSProperties,
  label: { color: "#a89070", fontSize: 11 } as React.CSSProperties,
  val: { color: "#ede4d4", fontWeight: 600, fontSize: 12, fontFamily: "monospace" } as React.CSSProperties,
  valHigh: { color: "#6aad55", fontWeight: 700, fontSize: 12, fontFamily: "monospace" } as React.CSSProperties,
  bar: (w: number, color: string) => ({ width: `${Math.max(w * 100, 2)}%`, height: 5, borderRadius: 3, background: color, transition: "width 0.3s" }) as React.CSSProperties,
  tag: (c: string) => ({ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: c + "15", color: c, fontWeight: 600 }) as React.CSSProperties,
};

// ─── Prob Row ──────────────────────────────────────────────────────

function PRow({ label, p, highlight }: { label: string; p: number; highlight?: boolean }) {
  return (
    <div style={S.row}>
      <span style={S.label}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 50, height: 5, borderRadius: 3, background: "#c4a26510", overflow: "hidden" }}>
          <div style={S.bar(p, highlight ? "#6aad55" : "#d4b86a")} />
        </div>
        <span style={highlight ? S.valHigh : S.val}>{pc(p)}</span>
        <span style={{ fontSize: 9, color: "#c4a26540" }}>{toOdds(p)}</span>
      </div>
    </div>
  );
}

// ─── Match Report Card ─────────────────────────────────────────────

function MatchReportCard({ report }: { report: MatchReport }) {
  const [expanded, setExpanded] = useState(false);
  const r = report;

  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
      {/* Header */}
      <button onClick={() => setExpanded(!expanded)} style={{
        width: "100%", padding: "12px 14px", border: "none", background: "transparent",
        cursor: "pointer", textAlign: "left" as const,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
            <Kit team={r.home} size={16} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{r.home}</span>
            <span style={{ fontSize: 10, color: "#c4a26540" }}>vs</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{r.away}</span>
            <Kit team={r.away} size={16} />
          </div>
          <span style={{ color: "#c4a26535", fontSize: 14 }}>{expanded ? "▾" : "▸"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
          <span style={S.tag("#d4b86a")}>{r.leagueName}</span>
          {r.kickoff && <span style={{ fontSize: 9, color: "#c4a26550" }}>{formatKickoff(r.kickoff)}</span>}
          <span style={{ fontSize: 9, color: "#a89070", marginLeft: "auto" }}>
            {r.lambdaH.toFixed(2)} : {r.lambdaA.toFixed(2)} xG
          </span>
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "0 14px 14px" }}>
          {/* Analysis */}
          <div style={{ background: "#c4a26508", borderRadius: 8, padding: 10, marginBottom: 10, border: "1px solid #c4a26510" }}>
            <div style={{ fontSize: 11, color: "#ede4d4", lineHeight: 1.6 }}>
              {r.analysis.split("\n\n").map((paragraph, pi) => (
                <p key={pi} style={{ margin: pi === 0 ? 0 : "6px 0 0" }}>{paragraph}</p>
              ))}
            </div>
          </div>

          {/* ── 1X2 Full Time ── */}
          <div style={S.sectionLabel}>Ergebnis (Vollzeit)</div>
          <PRow label="Heim" p={r.ft1X2.H} highlight={r.ft1X2.H > 0.45} />
          <PRow label="Unentschieden" p={r.ft1X2.D} />
          <PRow label="Auswärts" p={r.ft1X2.A} highlight={r.ft1X2.A > 0.45} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Double Chance ── */}
          <div style={S.sectionLabel}>Doppelte Chance</div>
          <PRow label="1X (Heim o. Unent.)" p={r.dc["1X"]} />
          <PRow label="X2 (Unent. o. Ausw.)" p={r.dc["X2"]} />
          <PRow label="12 (Heim o. Ausw.)" p={r.dc["12"]} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Goals Over/Under Full Time ── */}
          <div style={S.sectionLabel}>Tore Über/Unter (Vollzeit)</div>
          <PRow label="Über 1.5" p={r.goalsOU.O15} highlight={r.goalsOU.O15 > 0.7} />
          <PRow label="Über 2.5" p={r.goalsOU.O25} highlight={r.goalsOU.O25 > 0.55} />
          <PRow label="Über 3.5" p={r.goalsOU.O35} />
          <PRow label="Über 4.5" p={r.goalsOU.O45} />
          <PRow label="Über 5.5" p={r.goalsOU.O55} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── BTTS ── */}
          <div style={S.sectionLabel}>Beide Teams treffen</div>
          <PRow label="Ja" p={r.btts.yes} highlight={r.btts.yes > 0.55} />
          <PRow label="Nein" p={r.btts.no} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Team Goals ── */}
          <div style={S.sectionLabel}>Tore pro Team</div>
          <PRow label={`${r.home} Über 0.5`} p={r.homeGoals.O05} />
          <PRow label={`${r.home} Über 1.5`} p={r.homeGoals.O15} />
          <PRow label={`${r.home} Über 2.5`} p={r.homeGoals.O25} />
          <PRow label={`${r.away} Über 0.5`} p={r.awayGoals.O05} />
          <PRow label={`${r.away} Über 1.5`} p={r.awayGoals.O15} />
          <PRow label={`${r.away} Über 2.5`} p={r.awayGoals.O25} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT 1X2 ── */}
          <div style={S.sectionLabel}>Halbzeit-Ergebnis</div>
          <PRow label="Heim" p={r.ht1X2.H} />
          <PRow label="Unentschieden" p={r.ht1X2.D} highlight={r.ht1X2.D > 0.4} />
          <PRow label="Auswärts" p={r.ht1X2.A} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT Correct Scores ── */}
          <div style={S.sectionLabel}>Halbzeit Genauer Spielstand</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
            {r.htCorrectScores.slice(0, 8).map(cs => (
              <div key={cs.score} style={{
                background: "#c4a26508", borderRadius: 6, padding: "4px 6px", textAlign: "center",
                border: "1px solid #c4a26510",
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#d4b86a" }}>{cs.score}</div>
                <div style={{ fontSize: 9, color: "#a89070" }}>{pc(cs.p)}</div>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT/FT ── */}
          <div style={S.sectionLabel}>Halbzeit / Endstand</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
            {Object.entries(r.htft).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([key, p]) => (
              <div key={key} style={{
                background: p > 0.15 ? "#6aad5510" : "#c4a26508", borderRadius: 6, padding: "4px 6px", textAlign: "center",
                border: p > 0.15 ? "1px solid #6aad5520" : "1px solid #c4a26510",
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: p > 0.15 ? "#6aad55" : "#ede4d4" }}>{key}</div>
                <div style={{ fontSize: 9, color: "#a89070" }}>{pc(p)}</div>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Goal In Both Halves ── */}
          <div style={S.sectionLabel}>Tor in beiden Halbzeiten</div>
          <PRow label="Ja" p={r.goalBothHalves.yes} />
          <PRow label="Nein" p={r.goalBothHalves.no} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Correct Score FT ── */}
          <div style={S.sectionLabel}>Genauer Spielstand (Vollzeit)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
            {r.correctScores.slice(0, 12).map(cs => (
              <div key={cs.score} style={{
                background: cs.p > 0.08 ? "#d4b86a10" : "#c4a26508", borderRadius: 6, padding: "4px 6px", textAlign: "center",
                border: cs.p > 0.08 ? "1px solid #d4b86a25" : "1px solid #c4a26510",
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: cs.p > 0.08 ? "#d4b86a" : "#ede4d4" }}>{cs.score}</div>
                <div style={{ fontSize: 9, color: "#a89070" }}>{pc(cs.p)} <span style={{ color: "#c4a26530" }}>{toOdds(cs.p)}</span></div>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Winning Margin ── */}
          <div style={S.sectionLabel}>Siegtordifferenz</div>
          {Object.entries(r.winningMargin).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([margin, p]) => (
            <PRow key={margin} label={margin} p={p} />
          ))}
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Asian Handicap ── */}
          <div style={S.sectionLabel}>Handicap (Heim)</div>
          {["-1.5", "-1", "-0.5", "0", "+0.5", "+1", "+1.5"].map(line => {
            const ah = r.asianHandicap[line];
            if (!ah) return null;
            return <PRow key={line} label={`HC ${line}`} p={ah.P_Win} highlight={ah.P_Win > 0.55} />;
          })}
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Yellow Cards ── */}
          <div style={S.sectionLabel}>Gelbe Karten</div>
          <div style={S.row}>
            <span style={S.label}>Erwartete Karten</span>
            <span style={S.val}>{r.yellowCards.expected.toFixed(1)}</span>
          </div>
          <PRow label="Über 2.5" p={r.yellowCards.over25} />
          <PRow label="Über 3.5" p={r.yellowCards.over35} />
          <PRow label="Über 4.5" p={r.yellowCards.over45} />
          <PRow label="Über 5.5" p={r.yellowCards.over55} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── First Goal Timing ── */}
          <div style={S.sectionLabel}>Erstes Tor</div>
          <PRow label="Vor Minute 30" p={r.firstGoalBefore30} />
          <PRow label="Vor Minute 60" p={r.firstGoalBefore60} />
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────

export default function FuckBettingPage() {
  const router = useRouter();
  const { supabase, leagueStatus } = useApp();
  const [allData, setAllData] = useState<{ league: string; data: MatchdayData }[]>([]);
  const [loading, setLoading] = useState(true);

  // Load all leagues with data
  useEffect(() => {
    (async () => {
      setLoading(true);
      const { loadLatestMatchday } = await import("@/lib/supabase");
      const leagueKeys = Object.keys(LEAGUES).filter(k => leagueStatus[k]);
      const results = await Promise.all(leagueKeys.map(async (key) => {
        const md = await loadLatestMatchday(supabase, key);
        return md ? { league: key, data: md.data as MatchdayData } : null;
      }));
      setAllData(results.filter((r): r is NonNullable<typeof r> => r !== null));
      setLoading(false);
    })();
  }, [supabase, leagueStatus]);

  // Build reports for all matches
  const reports = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const result: MatchReport[] = [];

    for (const { league, data } of allData) {
      if (!data?.matches) continue;
      const ld = LEAGUES[league];
      if (!ld) continue;

      // Matchday-level date as fallback
      const matchdayDate = data.date || "";

      for (const match of data.matches) {
        const h = match.home;
        const a = match.away;
        if (!h?.xg_h8 || !a?.xg_a8) continue;

        // Resolve kickoff: full datetime > time-only + matchday date > matchday date
        let kickoff = match.kickoff || "";
        if (kickoff && !/^\d{4}-/.test(kickoff) && matchdayDate) {
          // kickoff is time-only ("15:30") — prepend matchday date
          kickoff = `${matchdayDate} ${kickoff}`;
        } else if (!kickoff && matchdayDate) {
          kickoff = matchdayDate;
        }

        // Compute lambdas
        const hf = getHomeFactor(h.name, ld.hf);
        const { lambdaH, lambdaA } = calcLambdas(
          h.xg_h8, h.xga_h8 || 0,
          a.xg_a8, a.xga_a8 || 0,
          h.games || 8, a.games || 8,
          ld.avg, hf
        );

        // Build matrix
        const mx = buildMatrix(lambdaH, lambdaA);
        const mk = deriveAllMarkets(mx);
        const cs = getCorrectScores(mx, 12);
        const ah = getAsianHandicap(mx, "H");
        const htft = getHtFt(lambdaH, lambdaA);
        const gbh = getGoalBothHalves(lambdaH, lambdaA);
        const yc = predictYellowCards(undefined, league);
        const ht1x2 = getHT1X2(lambdaH, lambdaA);
        const htCS = getHTCorrectScores(lambdaH, lambdaA);
        const wm = getWinningMargin(mx);

        const report: MatchReport = {
          home: h.name,
          away: a.name,
          league,
          leagueName: ld.name,
          kickoff,
          lambdaH,
          lambdaA,
          matrix: mx,
          ft1X2: { H: mk.H, D: mk.D, A: mk.A },
          dc: { "1X": mk.DC_1X, "X2": mk.DC_X2, "12": mk.DC_12 },
          goalsOU: { O15: mk.O15, O25: mk.O25, O35: mk.O35, O45: mk.O45, O55: mk.O55 },
          btts: { yes: mk.BY, no: mk.BN },
          correctScores: cs,
          winningMargin: wm,
          asianHandicap: ah,
          ht1X2: ht1x2,
          htCorrectScores: htCS,
          htft,
          goalBothHalves: gbh,
          homeGoals: { O05: mk.HO05, O15: mk.HO15, O25: mk.HO25 },
          awayGoals: { O05: mk.AO05, O15: mk.AO15, O25: mk.AO25 },
          yellowCards: yc,
          firstGoalBefore30: getFirstGoalTime(lambdaH, lambdaA, 30),
          firstGoalBefore60: getFirstGoalTime(lambdaH, lambdaA, 60),
          rawMatch: match,
          xgPerGameH: (h.xg_h8 || 0) / (h.games || 8),
          xgaPerGameH: (h.xga_h8 || 0) / (h.games || 8),
          xgPerGameA: (a.xg_a8 || 0) / (a.games || 8),
          xgaPerGameA: (a.xga_a8 || 0) / (a.games || 8),
          analysis: "",
        };
        report.analysis = generateAnalysis(report);

        result.push(report);
      }
    }

    // Sort: nearest future date first, then past
    result.sort((a, b) => {
      const da = a.kickoff || "9999";
      const db = b.kickoff || "9999";
      const aFuture = da >= today;
      const bFuture = db >= today;
      if (aFuture && !bFuture) return -1;
      if (!aFuture && bFuture) return 1;
      if (aFuture && bFuture) return da.localeCompare(db);
      return db.localeCompare(da);
    });

    return result;
  }, [allData]);

  // Group by date
  const grouped = useMemo(() => {
    const map = new Map<string, MatchReport[]>();
    for (const r of reports) {
      const date = r.kickoff?.slice(0, 10) || "Unbekannt";
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(r);
    }
    return Array.from(map.entries());
  }, [reports]);

  function formatDateLabel(iso: string): string {
    if (iso === "Unbekannt") return iso;
    try {
      const d = new Date(iso + "T12:00:00");
      const days = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
      return `${days[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
    } catch { return iso; }
  }

  return (
    <AppShell>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => router.push("/")} style={{
          background: "transparent", border: "none", color: "#a89070", fontSize: 12,
          cursor: "pointer", padding: "4px 0", marginBottom: 8,
        }}>
          ← Zurück
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/anna-avatar-1.jpg" alt="" width={44} height={44} style={{ borderRadius: "50%", objectFit: "cover", border: "2px solid #d4b86a40" }} />
          <div>
            <h1 style={{
              fontSize: 20, fontWeight: 700, color: "#d4b86a", margin: 0, letterSpacing: 0.5,
              fontFamily: "Georgia, serif",
            }}>
              Anna&apos;s Analysen
            </h1>
            <p style={{ fontSize: 11, color: "#a89070", margin: "2px 0 0" }}>
              Vollständige Wahrscheinlichkeitsanalyse. Ohne Wettquoten. Nur Mathematik.
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#a89070" }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>Lade Daten aller Ligen...</div>
          <div style={{ fontSize: 10 }}>Dixon-Coles Matrix wird berechnet</div>
        </div>
      ) : reports.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#a89070" }}>
          <div style={{ fontSize: 14 }}>Keine Spieldaten verfügbar</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>Erst Ligen auf der Startseite laden</div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 10, color: "#a89070", marginBottom: 12 }}>
            {reports.length} Spiele aus {new Set(reports.map(r => r.league)).size} Ligen
          </div>

          {grouped.map(([date, matches]) => (
            <div key={date} style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: "#d4b86a", letterSpacing: "0.05em",
                padding: "6px 0", borderBottom: "1px solid #c4a26520", marginBottom: 8,
              }}>
                {formatDateLabel(date)}
              </div>
              {matches.map((r, i) => (
                <MatchReportCard key={`${r.home}-${r.away}-${i}`} report={r} />
              ))}
            </div>
          ))}
        </>
      )}
    </AppShell>
  );
}
