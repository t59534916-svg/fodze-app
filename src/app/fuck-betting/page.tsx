"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import Kit from "@/components/shared/Kit";
import EngineLoader from "@/components/shared/EngineLoader";
import { TEAM_COLORS } from "@/lib/team-colors";
import {
  LEAGUES, getHomeFactor, buildMatrix, deriveAllMarkets, queryMatrix,
  getCorrectScores, getAsianHandicap, getHtFt, getGoalBothHalves,
  predictYellowCards, getHT1X2, getHTCorrectScores, getSecondHalfMarkets,
  getFirstGoalTime, getWinningMargin, calcLambdas,
  type SecondHalfMarkets,
} from "@/lib/dixon-coles";
import { calcMatchPoissonMLv2 } from "@/lib/poisson-ml-engine-v2";
import { isLGBMModelLoaded, getLGBMRho } from "@/lib/lgbm-runtime";
import { TEAM_SCRAPER_MAP } from "@/lib/scrapers/team-map";
import { resolveTeam } from "@/lib/team-resolver";
import { computeSoSRatings, type SoSRatings } from "@/lib/sos";
import { parseAbsences } from "@/lib/absence-parser";
import type { StandingsRow, LiveOdds } from "@/lib/supabase";
import type { MatchdayData, RawMatch } from "@/types/match";
import { generateAnalysis, parseForm, type MatchReport } from "@/lib/analysis-narrative";
import ProbabilityRing from "@/components/match/ProbabilityRing";
import EdgeBadge from "@/components/shared/EdgeBadge";
import XGQualityChips from "@/components/shared/XGQualityChips";
import { conversionFrom, sosFrom } from "@/lib/xg-quality";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const toOdds = (p: number) => p > 0.01 ? (1 / p).toFixed(2) : "—";

function posColor(pos: number, leagueSize: number = 18): string {
  if (pos <= 4) return "#6aad55";           // CL grün
  if (pos <= 6) return "#5a9ec4";           // EL blau
  if (pos === 7) return "#d4b86a";          // Conference gold
  if (pos > leagueSize - 3) return "#e07070"; // Abstieg rot
  return "#a89070";                          // Mittelfeld
}

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

// parseForm + generateAnalysis + the MatchReport interface are now owned
// by src/lib/analysis-narrative.ts (see the top-of-file import). Only UI
// helpers (posColor, formatKickoff, computeConfidence) stay here.

function computeConfidence(r: MatchReport): number {
  let score = 0;

  // 1. Engine quality (0-30)
  if (r.engine === "annafrick13-v2") score += 30;
  else score += 15;

  // 2. Data quality (0-25)
  if (r.dataQuality === "HIGH") score += 25;
  else score += 5;

  // 3. xG history depth — more history = more reliable (0-15)
  const hHist = r.rawMatch.home?.xg_h_history?.length || 0;
  const aHist = r.rawMatch.away?.xg_a_history?.length || 0;
  const histDepth = Math.min(hHist, aHist);
  score += Math.min(histDepth / 8 * 15, 15);

  // 4. Form data available (0-10)
  if (r.formH && r.formH.trim().length > 0) score += 5;
  if (r.formA && r.formA.trim().length > 0) score += 5;

  // 5. Lambda plausibility — extreme values lower confidence (0-10)
  const totalLambda = r.lambdaH + r.lambdaA;
  if (totalLambda >= 1.5 && totalLambda <= 5.0) score += 10;
  else if (totalLambda >= 1.0 && totalLambda <= 6.0) score += 5;

  // 6. Prediction clarity — strong favorite = more confident (0-10)
  const maxProb = Math.max(r.ft1X2.H, r.ft1X2.D, r.ft1X2.A);
  if (maxProb > 0.6) score += 10;
  else if (maxProb > 0.45) score += 6;
  else score += 3; // Very balanced = harder to predict

  return Math.min(Math.round(score), 100);
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

function MatchReportCard({ report, sos }: { report: MatchReport; sos?: SoSRatings }) {
  const [expanded, setExpanded] = useState(false);
  const r = report;

  // xG-Quality signals (conversion + SoS) — same contract as MatchCard.
  // Shows short chips next to team names when deviation is actionable.
  // Especially important in less-coverage leagues (shots-model / goals-
  // proxy) where raw xG can mislead without this context.
  const homeConv = conversionFrom(r.rawMatch.home?.xg_h_history);
  const awayConv = conversionFrom(r.rawMatch.away?.xg_a_history);
  const homeSos = sosFrom(r.rawMatch.home?.xg_h_history, sos);
  const awaySos = sosFrom(r.rawMatch.away?.xg_a_history, sos);

  // Best-edge for the EdgeBadge — compute model_prob - implied_prob per
  // 1X2 outcome using bestOdds (user's available line), take the max.
  // Mirrors what MatchdayContext's calculateBetsEnhanced does, but
  // fuck-betting doesn't carry a pre-computed bets array on the report.
  const bestEdge = (() => {
    if (!r.bestOdds?.h || !r.bestOdds?.d || !r.bestOdds?.a) return null;
    const candidates: { side: "h" | "d" | "a"; edge: number }[] = [
      { side: "h", edge: r.ft1X2.H - 1 / r.bestOdds.h },
      { side: "d", edge: r.ft1X2.D - 1 / r.bestOdds.d },
      { side: "a", edge: r.ft1X2.A - 1 / r.bestOdds.a },
    ];
    return candidates.reduce((best, c) => c.edge > best.edge ? c : best);
  })();
  const hasValue = bestEdge !== null && bestEdge.edge > 0.025; // Goldilocks floor

  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
      {/* Header */}
      <button onClick={() => setExpanded(!expanded)} style={{
        width: "100%", padding: "12px 14px", border: "none", background: "transparent",
        cursor: "pointer", textAlign: "left" as const,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, flexWrap: "wrap" }}>
            <Kit team={r.home} size={16} />
            {r.homePos && <span style={{ fontSize: 9, fontWeight: 700, color: posColor(r.homePos), background: posColor(r.homePos) + "15", padding: "1px 4px", borderRadius: 3, minWidth: 16, textAlign: "center" }}>{r.homePos}.</span>}
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{r.home}</span>
            <XGQualityChips conversion={homeConv} sos={homeSos} />
            <span style={{ fontSize: 10, color: "#c4a26540" }}>vs</span>
            {r.awayPos && <span style={{ fontSize: 9, fontWeight: 700, color: posColor(r.awayPos), background: posColor(r.awayPos) + "15", padding: "1px 4px", borderRadius: 3, minWidth: 16, textAlign: "center" }}>{r.awayPos}.</span>}
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{r.away}</span>
            <Kit team={r.away} size={16} />
            <XGQualityChips conversion={awayConv} sos={awaySos} />
          </div>
          <span style={{ color: "#c4a26535", fontSize: 14 }}>{expanded ? "▾" : "▸"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span style={S.tag("#d4b86a")}>{r.leagueName}</span>
          {r.engine === "annafrick13-v2" && (
            <span style={S.tag("#6aad55")}>@annafrick13</span>
          )}
          {r.dataQuality === "LOW" && (
            <span style={S.tag("#e07070")}>Ohne xG</span>
          )}
          <span style={S.tag(r.confidence >= 75 ? "#6aad55" : r.confidence >= 50 ? "#d4b86a" : "#e07070")}>
            {r.confidence}% Konfidenz
          </span>
          {/* EdgeBadge with Goldilocks-zone meter — tells the reader at a
              glance whether the best 1X2 edge is a real value signal (green
              2.5–7.5%), too thin (amber), or a suspected value-trap
              (warn >7.5%). Same contract as MatchCard. */}
          {bestEdge && (
            <EdgeBadge edge={bestEdge.edge} />
          )}
          {r.kickoff && <span style={{ fontSize: 9, color: "#c4a26550" }}>{formatKickoff(r.kickoff)}</span>}
          <span style={{ fontSize: 9, color: "#a89070", marginLeft: "auto" }}>
            {r.lambdaH.toFixed(2)} : {r.lambdaA.toFixed(2)} xG
          </span>
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "0 14px 14px" }}>
          {/* Hero: ProbabilityRing with favorite in the middle. Same
              visual contract as MatchDetail so the user recognizes the
              signal across screens. Glow follows the value-bet arc. */}
          <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 14px" }}>
            <ProbabilityRing
              h={r.ft1X2.H} d={r.ft1X2.D} a={r.ft1X2.A}
              size={130} stroke={11}
              hasValue={hasValue}
              valueSide={bestEdge?.side ?? null}
            />
          </div>
          {/* Data quality warning */}
          {r.dataQuality === "LOW" && (
            <div style={{
              background: "#e0707010", border: "1px solid #e0707025", borderRadius: 8,
              padding: "8px 10px", marginBottom: 8, display: "flex", alignItems: "center", gap: 8,
            }}>
              <span style={{ fontSize: 14 }}>&#9888;</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#e07070" }}>Verminderte Datenqualität</div>
                <div style={{ fontSize: 9, color: "#a89070", marginTop: 1 }}>
                  Keine xG-Daten verfügbar. Analyse basiert auf Liga-Durchschnittswerten und Heimvorteil.
                  Wahrscheinlichkeiten sind weniger präzise.
                </div>
              </div>
            </div>
          )}

          {/* Analysis */}
          <div style={{ background: "#c4a26508", borderRadius: 8, padding: 10, marginBottom: 10, border: "1px solid #c4a26510" }}>
            <div style={{ fontSize: 11, color: "#ede4d4", lineHeight: 1.6 }}>
              {(r.analysis ?? "").split("\n\n").map((paragraph, pi) => (
                <p key={pi} style={{ margin: pi === 0 ? 0 : "6px 0 0" }}>{paragraph}</p>
              ))}
            </div>
          </div>

          {/* ── xG Comparison Bars (Team Colors) ── */}
          {(() => {
            const [hPrimary] = TEAM_COLORS[r.home] || ["#d4b86a", "#fff"];
            const [aPrimary] = TEAM_COLORS[r.away] || ["#a89070", "#fff"];
            const maxXG = Math.max(r.xgPerGameH, r.xgPerGameA, r.xgaPerGameH, r.xgaPerGameA, 0.5);
            return (<>
              <div style={S.sectionLabel}>xGoals-Vergleich (pro Spiel)</div>
              {/* xG Offensive */}
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3, letterSpacing: "0.05em" }}>OFFENSIV (xGoals erzielt)</div>
              {[
                { name: r.home, val: r.xgPerGameH, color: hPrimary },
                { name: r.away, val: r.xgPerGameA, color: aPrimary },
              ].map(({ name, val, color }) => (
                <div key={name + "xg"} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: "#a89070", width: 70, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name.split(" ").pop()}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: "#c4a26510", overflow: "hidden" }}>
                    <div style={{ width: `${(val / maxXG) * 100}%`, height: "100%", borderRadius: 4, background: color, opacity: 0.85, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: "#ede4d4", fontWeight: 600, fontFamily: "monospace", width: 36, textAlign: "right" }}>{val.toFixed(2)}</span>
                </div>
              ))}
              {/* xGA Defensive */}
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3, marginTop: 6, letterSpacing: "0.05em" }}>DEFENSIV (xGoals-Against kassiert)</div>
              {[
                { name: r.home, val: r.xgaPerGameH, color: hPrimary },
                { name: r.away, val: r.xgaPerGameA, color: aPrimary },
              ].map(({ name, val, color }) => (
                <div key={name + "xga"} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: "#a89070", width: 70, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name.split(" ").pop()}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: "#c4a26510", overflow: "hidden" }}>
                    <div style={{ width: `${(val / maxXG) * 100}%`, height: "100%", borderRadius: 4, background: color, opacity: 0.45, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: "#c4a26570", fontFamily: "monospace", width: 36, textAlign: "right" }}>{val.toFixed(2)}</span>
                </div>
              ))}
              <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />
            </>);
          })()}

          {/* ── Form Visual ── */}
          {(r.formH || r.formA) && (<>
            <div style={S.sectionLabel}>Form (letzte 5)</div>
            {[{ name: r.home, form: r.formH }, { name: r.away, form: r.formA }].map(({ name, form }) => form ? (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#a89070", width: 80, textAlign: "right" }}>{name.split(" ").pop()}</span>
                <div style={{ display: "flex", gap: 3 }}>
                  {form.trim().split(/\s+/).map((r2, i) => (
                    <span key={i} style={{
                      width: 18, height: 18, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 9, fontWeight: 700,
                      background: r2 === "W" ? "#6aad5520" : r2 === "D" ? "#d4b86a15" : "#e0707015",
                      color: r2 === "W" ? "#6aad55" : r2 === "D" ? "#d4b86a" : "#e07070",
                      border: `1px solid ${r2 === "W" ? "#6aad5530" : r2 === "D" ? "#d4b86a25" : "#e0707025"}`,
                    }}>{r2}</span>
                  ))}
                </div>
              </div>
            ) : null)}
            <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />
          </>)}

          {/* ── 1X2 Full Time ── */}
          <div style={S.sectionLabel}>Ergebnis (Vollzeit)</div>
          <PRow label="Heim" p={r.ft1X2.H} highlight={r.ft1X2.H > 0.45} />
          <PRow label="Unentschieden" p={r.ft1X2.D} />
          <PRow label="Auswärts" p={r.ft1X2.A} highlight={r.ft1X2.A > 0.45} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Double Chance & Draw No Bet ── */}
          <div style={S.sectionLabel}>Doppelte Chance / Draw No Bet</div>
          <PRow label="1X (Heim o. Unent.)" p={r.dc["1X"]} />
          <PRow label="X2 (Unent. o. Ausw.)" p={r.dc["X2"]} />
          <PRow label="12 (Heim o. Ausw.)" p={r.dc["12"]} />
          <PRow label="DNB Heim" p={r.drawNoBetH} highlight={r.drawNoBetH > 0.6} />
          <PRow label="DNB Auswärts" p={r.drawNoBetA} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Goals Over/Under Full Time ── */}
          <div style={S.sectionLabel}>Tore Über/Unter (Vollzeit)</div>
          <PRow label="Über 1.5" p={r.goalsOU.O15} highlight={r.goalsOU.O15 > 0.7} />
          <PRow label="Über 2.5" p={r.goalsOU.O25} highlight={r.goalsOU.O25 > 0.55} />
          <PRow label="Über 3.5" p={r.goalsOU.O35} />
          <PRow label="Über 4.5" p={r.goalsOU.O45} />
          <PRow label="Über 5.5" p={r.goalsOU.O55} />
          <PRow label="Gerade Tore" p={r.evenGoals} />
          <PRow label="Ungerade Tore" p={r.oddGoals} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── BTTS ── */}
          <div style={S.sectionLabel}>Beide Teams treffen</div>
          <PRow label="Ja" p={r.btts.yes} highlight={r.btts.yes > 0.55} />
          <PRow label="Nein" p={r.btts.no} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Clean Sheet & Win to Nil ── */}
          <div style={S.sectionLabel}>Clean Sheet / Win to Nil</div>
          <PRow label={`${r.home} Clean Sheet`} p={r.cleanSheetH} highlight={r.cleanSheetH > 0.35} />
          <PRow label={`${r.away} Clean Sheet`} p={r.cleanSheetA} />
          <PRow label={`${r.home} Win to Nil`} p={r.winToNilH} />
          <PRow label={`${r.away} Win to Nil`} p={r.winToNilA} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Team Goals ── */}
          <div style={S.sectionLabel}>Tore pro Team</div>
          <PRow label={`${r.home} Ü0.5`} p={r.homeGoals.O05} />
          <PRow label={`${r.home} Ü1.5`} p={r.homeGoals.O15} />
          <PRow label={`${r.home} Ü2.5`} p={r.homeGoals.O25} />
          <PRow label={`${r.away} Ü0.5`} p={r.awayGoals.O05} />
          <PRow label={`${r.away} Ü1.5`} p={r.awayGoals.O15} />
          <PRow label={`${r.away} Ü2.5`} p={r.awayGoals.O25} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Exact Team Goals ── */}
          <div style={S.sectionLabel}>Exakte Tore pro Team</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3 }}>{r.home}</div>
              {["0 Tore", "1 Tor", "2 Tore", "3+ Tore"].map((label, i) => (
                <PRow key={`h${i}`} label={label} p={r.homeExact[i]} />
              ))}
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#a89070", marginBottom: 3 }}>{r.away}</div>
              {["0 Tore", "1 Tor", "2 Tore", "3+ Tore"].map((label, i) => (
                <PRow key={`a${i}`} label={label} p={r.awayExact[i]} />
              ))}
            </div>
          </div>
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Race to 2 Goals ── */}
          <div style={S.sectionLabel}>Race to 2 Goals</div>
          <PRow label={r.home} p={r.raceTo2H} highlight={r.raceTo2H > 0.45} />
          <PRow label={r.away} p={r.raceTo2A} />
          <PRow label="Keiner erreicht 2" p={r.raceTo2Neither} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT 1X2 ── */}
          <div style={S.sectionLabel}>Halbzeit-Ergebnis</div>
          <PRow label="Heim" p={r.ht1X2.H} />
          <PRow label="Unentschieden" p={r.ht1X2.D} highlight={r.ht1X2.D > 0.4} />
          <PRow label="Auswärts" p={r.ht1X2.A} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── HT Goals Over/Under ── */}
          <div style={S.sectionLabel}>Halbzeit Tore Über/Unter</div>
          <PRow label="HT Über 0.5" p={r.htGoalsOU.O05} highlight={r.htGoalsOU.O05 > 0.65} />
          <PRow label="HT Über 1.5" p={r.htGoalsOU.O15} />
          <PRow label="HT Über 2.5" p={r.htGoalsOU.O25} />
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

          {/* ── 2nd Half Markets ── */}
          <div style={S.sectionLabel}>2. Halbzeit (ab 0:0 HT)</div>
          <PRow label="Heim" p={r.secondHalf.H} />
          <PRow label="Unentschieden" p={r.secondHalf.D} />
          <PRow label="Auswärts" p={r.secondHalf.A} />
          <PRow label="2H Über 0.5" p={r.secondHalf.O05} />
          <PRow label="2H Über 1.5" p={r.secondHalf.O15} />
          <PRow label="2H Über 2.5" p={r.secondHalf.O25} />
          <PRow label="2H BTTS Ja" p={r.secondHalf.BY} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Goal In Both Halves ── */}
          <div style={S.sectionLabel}>Tor in beiden Halbzeiten</div>
          <PRow label="Ja" p={r.goalBothHalves.yes} />
          <PRow label="Nein" p={r.goalBothHalves.no} />
          <div style={{ height: 1, background: "#c4a26510", margin: "8px 0" }} />

          {/* ── Score Matrix Heatmap ── */}
          <div style={S.sectionLabel}>Score-Matrix (Wahrscheinlichkeit)</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 9 }}>
              <thead>
                <tr>
                  <th style={{ padding: 2, color: "#a89070", fontSize: 8 }}></th>
                  {[0,1,2,3,4,5,6].map(j => <th key={j} style={{ padding: 2, color: "#a89070", fontSize: 8, textAlign: "center" }}>{r.away.split(" ").pop()} {j}</th>)}
                </tr>
              </thead>
              <tbody>
                {r.heatmap.map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: 2, color: "#a89070", fontSize: 8, fontWeight: 600 }}>{r.home.split(" ").pop()} {i}</td>
                    {row.map((p, j) => {
                      const intensity = Math.min(p / 0.12, 1);
                      const bg = i === j ? `rgba(212,184,106,${intensity * 0.5})` // Draw = gold
                        : i > j ? `rgba(106,173,85,${intensity * 0.5})` // Home win = green
                        : `rgba(224,112,112,${intensity * 0.5})`; // Away win = red
                      return (
                        <td key={j} style={{
                          padding: "3px 2px", textAlign: "center", borderRadius: 2,
                          background: bg, color: p > 0.04 ? "#ede4d4" : "#c4a26550",
                          fontWeight: p > 0.07 ? 700 : 400, fontFamily: "monospace",
                        }}>
                          {(p * 100).toFixed(1)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 4, fontSize: 8, color: "#a89070" }}>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(106,173,85,0.4)", marginRight: 3 }} />Heim</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(212,184,106,0.4)", marginRight: 3 }} />Unent.</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(224,112,112,0.4)", marginRight: 3 }} />Ausw.</span>
          </div>
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
          {["-2.5", "-2", "-1.5", "-1", "-0.5", "0", "+0.5", "+1", "+1.5"].map(line => {
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

// ─── Standings Table ──────────────────────────────────────────────

function StandingsTable({ rows, leagueName }: { rows: StandingsRow[]; leagueName: string }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  const leagueSize = rows.length;
  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden", marginBottom: 8 }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", padding: "8px 12px", border: "none", background: "transparent",
        cursor: "pointer", textAlign: "left" as const, display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#d4b86a", letterSpacing: "0.05em" }}>
          Tabelle {leagueName}
        </span>
        <span style={{ color: "#c4a26535", fontSize: 12 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 8px 8px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #c4a26520" }}>
                {["#", "", "Team", "Sp", "S", "U", "N", "T", "GT", "TD", "Pkt"].map(h => (
                  <th key={h} style={{ padding: "3px 4px", color: "#a89070", fontWeight: 600, textAlign: h === "Team" || h === "" ? "left" : "center", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pc2 = posColor(r.pos, leagueSize);
                const isZone = r.pos <= 4 || r.pos > leagueSize - 3;
                return (
                  <tr key={r.team} style={{ borderBottom: "1px solid #c4a26508", background: isZone ? pc2 + "08" : "transparent" }}>
                    <td style={{ padding: "3px 4px", fontWeight: 700, color: pc2, textAlign: "center" }}>{r.pos}</td>
                    <td style={{ padding: "3px 2px" }}><Kit team={r.fodzeName} size={12} /></td>
                    <td style={{ padding: "3px 4px", color: "#ede4d4", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>{r.fodzeName}</td>
                    <td style={{ padding: "3px 4px", color: "#a89070", textAlign: "center" }}>{r.played}</td>
                    <td style={{ padding: "3px 4px", color: "#6aad55", textAlign: "center" }}>{r.won}</td>
                    <td style={{ padding: "3px 4px", color: "#d4b86a", textAlign: "center" }}>{r.drawn}</td>
                    <td style={{ padding: "3px 4px", color: "#e07070", textAlign: "center" }}>{r.lost}</td>
                    <td style={{ padding: "3px 4px", color: "#a89070", textAlign: "center" }}>{r.gf}</td>
                    <td style={{ padding: "3px 4px", color: "#a89070", textAlign: "center" }}>{r.ga}</td>
                    <td style={{ padding: "3px 4px", color: r.gd > 0 ? "#6aad55" : r.gd < 0 ? "#e07070" : "#a89070", textAlign: "center", fontWeight: 600 }}>{r.gd > 0 ? "+" : ""}{r.gd}</td>
                    <td style={{ padding: "3px 4px", color: "#ede4d4", fontWeight: 700, textAlign: "center" }}>{r.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 8, color: "#a89070" }}>
            <span><span style={{ color: "#6aad55" }}>●</span> CL</span>
            <span><span style={{ color: "#5a9ec4" }}>●</span> EL</span>
            <span><span style={{ color: "#e07070" }}>●</span> Abstieg</span>
          </div>
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
  const [standings, setStandings] = useState<Map<string, StandingsRow[]>>(new Map());
  const [sosMap, setSosMap] = useState<Map<string, SoSRatings>>(new Map());
  const [oddsMap, setOddsMap] = useState<Map<string, LiveOdds>>(new Map());
  const [loading, setLoading] = useState(true);
  // Loading progress — surfaced in the header so the user sees which league
  // is being fetched and how far along we are. Previously a static
  // "Lade Daten..." spinner gave zero feedback for the 3-8s the load takes
  // across 19 leagues.
  const [progress, setProgress] = useState({
    phase: "idle" as "idle" | "data" | "compute" | "done",
    leaguesDone: 0,
    totalLeagues: 0,
    inFlight: [] as string[], // which leagues are currently fetching
    failed: [] as string[],   // which leagues timed out or errored
  });

  // Load all leagues with data + enrich with xG history for @annafrick13 v2
  useEffect(() => {
    (async () => {
      setLoading(true);
      setAllData([]);
      setStandings(new Map());
      setSosMap(new Map());
      setOddsMap(new Map());

      const {
        loadLatestMatchday,
        loadAllTeamXGHistory,        // batched per-league, replaces N+1 loadTeamXGHistory calls
        toXGHistoryEntries,
        loadLiveOdds,
      } = await import("@/lib/supabase");
      const { computeStandings } = await import("@/lib/supabase");
      const leagueKeys = Object.keys(LEAGUES).filter(k => leagueStatus[k]);

      setProgress({
        phase: "data",
        leaguesDone: 0,
        totalLeagues: leagueKeys.length,
        inFlight: leagueKeys.map((k) => LEAGUES[k]?.name || k),
        failed: [],
      });

      // Per-league pipeline — all parallel, each with a hard per-league
      // timeout so one hung query doesn't block the page forever.
      // Previous version had no timeout: if Supabase pool-queued any of
      // the 76 concurrent requests, the user would see "stuck at League X"
      // with no recovery.
      const resolveUnderstat = (name: string) => {
        const mapped = TEAM_SCRAPER_MAP[name];
        return mapped?.understat || name;
      };

      const LEAGUE_TIMEOUT_MS = 15_000;
      const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms),
          ),
        ]);

      await Promise.all(
        leagueKeys.map(async (key) => {
          const leagueName = LEAGUES[key]?.name || key;
          let succeeded = false;
          try {
            // 3 queries per league (was 4): we derive standings from the
            // same xG rows we already fetched. loadLeagueStandings → loadLeagueXGHistory
            // was a redundant duplicate fetch of the same underlying table.
            const [md, leagueXG, odds] = await withTimeout(
              Promise.all([
                loadLatestMatchday(supabase, key),
                loadAllTeamXGHistory(supabase, key, 3000),
                loadLiveOdds(supabase, key).catch(() => [] as LiveOdds[]),
              ]),
              LEAGUE_TIMEOUT_MS,
              leagueName,
            );

            // Derive standings from the home-perspective rows of the same
            // dataset — identical to what loadLeagueStandings was doing
            // internally, but without a second network roundtrip.
            const homeRowsForStandings = leagueXG
              .filter((r: any) => r.venue === "home")
              .filter((r: any) => r.match_date >= "2025-07-01");
            const standingRows = computeStandings(homeRowsForStandings);

            if (md) {
              const data = md.data as MatchdayData;
              const ld = LEAGUES[key];
              const fallbackXG = ld ? ld.avg * 8 * 0.55 : 12;
              const fallbackXGA = ld ? ld.avg * 8 * 0.45 : 10;

              // Bucket xG rows by (team, venue), keep last 8 per bucket.
              // Data came back ordered by match_date DESC so slice(0,8)
              // is already "last 8 matches newest-first".
              const byTeamVenue = new Map<string, typeof leagueXG>();
              for (const r of leagueXG) {
                const k = `${r.team}|${r.venue}`;
                let bucket = byTeamVenue.get(k);
                if (!bucket) { bucket = []; byTeamVenue.set(k, bucket); }
                if (bucket.length < 8) bucket.push(r);
              }
              const lookupHist = (name: string, venue: "home" | "away") => {
                // Exact Understat name match, case-insensitive fallback,
                // substring fallback. Same tiered logic as loadTeamXGHistory
                // but against the in-memory bucket.
                const understatName = resolveUnderstat(name);
                let found = byTeamVenue.get(`${understatName}|${venue}`);
                if (found?.length) return found;
                const lower = understatName.toLowerCase();
                for (const [k, v] of byTeamVenue.entries()) {
                  const [t, ven] = k.split("|");
                  if (ven !== venue) continue;
                  if (t.toLowerCase() === lower) return v;
                }
                // Substring (length-guarded)
                for (const [k, v] of byTeamVenue.entries()) {
                  const [t, ven] = k.split("|");
                  if (ven !== venue) continue;
                  const tl = t.toLowerCase();
                  if ((tl.includes(lower) || lower.includes(tl)) && tl.length > 3 && lower.length > 3) {
                    return v;
                  }
                }
                return null;
              };

              if (data.matches) {
                for (const match of data.matches) {
                  if (match.home?.name && !match.home.xg_h_history?.length) {
                    const hist = lookupHist(match.home.name, "home");
                    if (hist && hist.length > 0) {
                      // Reverse to chronological order (oldest-first) for the
                      // engine EWMA — matches what loadTeamXGHistory did via
                      // .reverse() after ASC query.
                      const chrono = [...hist].reverse();
                      match.home.xg_h_history = toXGHistoryEntries(chrono);
                      if (!match.home.xg_h8) {
                        match.home.xg_h8 = +chrono.reduce((s, g) => s + Number(g.xg || 0), 0).toFixed(2);
                        match.home.xga_h8 = +chrono.reduce((s, g) => s + Number(g.xga || 0), 0).toFixed(2);
                        match.home.games = chrono.length;
                      }
                    } else if (!match.home.xg_h8) {
                      match.home.xg_h8 = +fallbackXG.toFixed(2);
                      match.home.xga_h8 = +fallbackXGA.toFixed(2);
                      match.home.games = 8;
                    }
                  }
                  if (match.away?.name && !match.away.xg_a_history?.length) {
                    const hist = lookupHist(match.away.name, "away");
                    if (hist && hist.length > 0) {
                      const chrono = [...hist].reverse();
                      match.away.xg_a_history = toXGHistoryEntries(chrono);
                      if (!match.away.xg_a8) {
                        match.away.xg_a8 = +chrono.reduce((s, g) => s + Number(g.xg || 0), 0).toFixed(2);
                        match.away.xga_a8 = +chrono.reduce((s, g) => s + Number(g.xga || 0), 0).toFixed(2);
                        match.away.games = chrono.length;
                      }
                    } else if (!match.away.xg_a8) {
                      match.away.xg_a8 = +fallbackXGA.toFixed(2);
                      match.away.xga_a8 = +fallbackXG.toFixed(2);
                      match.away.games = 8;
                    }
                  }
                }
              }

              // SoS from the home-perspective rows within the same dataset —
              // no extra query.
              if (ld) {
                const homeRows = leagueXG.filter((r) => r.venue === "home");
                if (homeRows.length > 0) {
                  const sosMatches = homeRows.map((m) => ({
                    team: m.team, opponent: m.opponent, xg: m.xg, xga: m.xga,
                  }));
                  setSosMap((prev) => {
                    const next = new Map(prev);
                    next.set(key, computeSoSRatings(sosMatches, ld.avg));
                    return next;
                  });
                }
              }

              // Incremental state: commit this league's data as it's ready.
              setAllData((prev) => {
                // Preserve league order by key to keep the UI stable across
                // re-renders (otherwise leagues would appear in load-order).
                const next = [...prev, { league: key, data }];
                next.sort((a, b) => leagueKeys.indexOf(a.league) - leagueKeys.indexOf(b.league));
                return next;
              });
              setStandings((prev) => {
                const next = new Map(prev);
                next.set(key, standingRows);
                return next;
              });
              setOddsMap((prev) => {
                const next = new Map(prev);
                for (const o of odds) {
                  next.set(`${o.home_team.toLowerCase()}|${o.away_team.toLowerCase()}`, o);
                }
                return next;
              });
              succeeded = true;
            }
          } catch (e: any) {
            // Timeout or unexpected error — league is skipped, not blocking.
            // Logged so admin can check which league's Supabase query is slow.
            console.warn(`[fuck-betting] league ${key} (${leagueName}) skipped:`, e?.message || e);
          } finally {
            // Progress always advances — even timeouts/errors. Bar ALWAYS
            // reaches 100% so "stuck" is impossible.
            setProgress((prev) => ({
              ...prev,
              leaguesDone: prev.leaguesDone + 1,
              inFlight: prev.inFlight.filter((n) => n !== leagueName),
              failed: succeeded ? prev.failed : [...prev.failed, leagueName],
            }));
          }
        }),
      );

      setProgress((prev) => ({ ...prev, phase: "compute" }));
      // One microtask to let React paint the "compute" phase before the
      // heavy useMemo kicks in. Without this the UI appears frozen.
      await new Promise((r) => setTimeout(r, 0));
      setLoading(false);
      setProgress((prev) => ({ ...prev, phase: "done" }));
    })();
  }, [supabase, leagueStatus]);

  // Helper: find live odds for a match (fuzzy team name matching)
  const findOdds = (homeName: string, awayName: string): LiveOdds | null => {
    // Try exact lowercase match
    const key = `${homeName.toLowerCase()}|${awayName.toLowerCase()}`;
    if (oddsMap.has(key)) return oddsMap.get(key)!;
    // Try resolving via team-resolver
    const hRes = resolveTeam(homeName);
    const aRes = resolveTeam(awayName);
    for (const [k, v] of oddsMap.entries()) {
      const [oh, oa] = k.split("|");
      // Check if resolved names match odds-api names
      if (hRes?.oddsApi?.toLowerCase() === oh && aRes?.oddsApi?.toLowerCase() === oa) return v;
      if (hRes?.csv?.toLowerCase() === oh && aRes?.csv?.toLowerCase() === oa) return v;
      // Substring match
      if (oh.includes(homeName.toLowerCase().split(" ").pop()!) && oa.includes(awayName.toLowerCase().split(" ").pop()!)) return v;
    }
    return null;
  };

  // Helper: find team position in standings (try FODZE name, then Understat name)
  const findPos = (teamName: string, leagueStandings: StandingsRow[] | undefined): StandingsRow | null => {
    if (!leagueStandings) return null;
    // Try FODZE name match
    let row = leagueStandings.find(s => s.fodzeName === teamName);
    if (row) return row;
    // Try Understat name match
    const resolved = resolveTeam(teamName);
    if (resolved) {
      row = leagueStandings.find(s => s.team === resolved.csv || s.team === (resolved.understat || ""));
      if (row) return row;
    }
    // Substring fallback
    const lower = teamName.toLowerCase();
    row = leagueStandings.find(s => s.team.toLowerCase().includes(lower) || lower.includes(s.team.toLowerCase()));
    return row || null;
  };

  // Build reports for all matches
  const reports = useMemo(() => {
    // Skip compute while data is still streaming in. Without this, every
    // per-league setAllData() call re-runs this heavy loop from scratch
    // (N=19 leagues × ~10 matches × full matrix build) even though the
    // UI only renders reports AFTER loading flips to false. We were paying
    // ~19× the compute cost for zero visible benefit.
    if (loading) return [];
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
        if (!h?.name || !a?.name) continue;

        // Determine data quality: HIGH when we have real per-match xG history
        // (either Understat or shots-model), LOW when matchday JSON had xg_h8=0
        // AND no history was found → the load logic synthesized a Liga-avg
        // fallback so the engine can still run, but the user should see that
        // predictions are odds-driven rather than team-specific.
        const hasRealXG = !!(h.xg_h_history?.length || a.xg_a_history?.length);
        const dataQuality: "HIGH" | "LOW" = hasRealXG ? "HIGH" : "LOW";

        // xG summaries are now guaranteed to be populated by the load logic
        // above (either from history, explicit matchday values, or Liga-avg
        // synthesis). No further fallback needed here.
        const xgH8 = h.xg_h8 || ld.avg * 8 * 0.55;
        const xgaH8 = h.xga_h8 || ld.avg * 8 * 0.45;
        const xgA8 = a.xg_a8 || ld.avg * 8 * 0.45;
        const xgaA8 = a.xga_a8 || ld.avg * 8 * 0.55;
        const hGames = h.games || 8;
        const aGames = a.games || 8;

        // Resolve kickoff: full datetime > time-only + matchday date > matchday date
        let kickoff = match.kickoff || "";
        if (kickoff && !/^\d{4}-/.test(kickoff) && matchdayDate) {
          kickoff = `${matchdayDate} ${kickoff}`;
        } else if (!kickoff && matchdayDate) {
          kickoff = matchdayDate;
        }

        // Compute lambdas — try @annafrick13 v2 first, fallback to standard
        const hf = getHomeFactor(h.name, ld.hf);
        let lambdaH: number;
        let lambdaA: number;
        let engine: "annafrick13-v2" | "standard" = "standard";
        let effectiveRho = -0.05;

        // Parse injuries → structured absences (mirrors MatchdayContext.calcMatch:289-300).
        // Without this, fuck-betting's predictions ignore suspended stars — the
        // Goldilocks gate then rejects legitimate edges because the model didn't
        // see the absence hit on λ.
        const homeAbsences = parseAbsences(h.injuries, h.name || "");
        const awayAbsences = parseAbsences(a.injuries, a.name || "");
        const absences =
          homeAbsences.length > 0 || awayAbsences.length > 0
            ? { home: homeAbsences, away: awayAbsences }
            : undefined;

        // Try v2: needs LightGBM model + per-match xG history
        const hHist = h.xg_h_history;
        const aHist = a.xg_a_history;
        if (isLGBMModelLoaded() && hHist?.length && aHist?.length) {
          const leagueSos = sosMap.get(league);
          const v2Result = calcMatchPoissonMLv2({
            xgHS: xgH8, xgaHC: xgaH8, hGames,
            xgAS: xgA8, xgaAC: xgaA8, aGames,
            leagueAvg: ld.avg, homeFactor: hf, league,
            tags: match.tags || [],
            hHistory: hHist, aHistory: aHist,
            homeTeam: h.name, awayTeam: a.name,
            fraction: 0.25,
            sosRatings: leagueSos,
            absences,
          });
          if (v2Result) {
            lambdaH = v2Result.lambdaH;
            lambdaA = v2Result.lambdaA;
            engine = "annafrick13-v2";
            effectiveRho = getLGBMRho();
          } else {
            // v2 refused (missing data) → standard fallback
            const std = calcLambdas(xgH8, xgaH8, xgA8, xgaA8, hGames, aGames, ld.avg, hf);
            lambdaH = std.lambdaH;
            lambdaA = std.lambdaA;
          }
        } else {
          // No model or no history → standard engine
          const std = calcLambdas(xgH8, xgaH8, xgA8, xgaA8, hGames, aGames, ld.avg, hf);
          lambdaH = std.lambdaH;
          lambdaA = std.lambdaA;
        }

        // For v2: compute EWMA-based xG per game from history (more accurate than raw sums)
        let xgPgH = xgH8 / hGames;
        let xgaPgH = xgaH8 / hGames;
        let xgPgA = xgA8 / aGames;
        let xgaPgA = xgaA8 / aGames;
        if (engine === "annafrick13-v2" && hHist?.length && aHist?.length) {
          // EWMA from per-match history — same alpha as v2 engine
          const ewma = (hist: typeof hHist, key: "xg" | "xga") => {
            const alpha = 0.85;
            let wSum = 0, wVal = 0;
            for (let i = 0; i < hist.length; i++) {
              const w = Math.pow(alpha, hist.length - 1 - i);
              wSum += w;
              const entry = hist[i];
              wVal += w * ((key === "xg" ? (entry.npxg ?? entry.xg) : (entry.npxga ?? entry.xga)));
            }
            return wSum > 0 ? wVal / wSum : xgH8 / hGames;
          };
          xgPgH = ewma(hHist, "xg");
          xgaPgH = ewma(hHist, "xga");
          xgPgA = ewma(aHist, "xg");
          xgaPgA = ewma(aHist, "xga");
        }

        // Build matrix (use optimized rho for v2, default for standard)
        const mx = buildMatrix(lambdaH, lambdaA, effectiveRho);
        const mk = deriveAllMarkets(mx);
        const cs = getCorrectScores(mx, 12);
        const ah = getAsianHandicap(mx, "H");
        const htft = getHtFt(lambdaH, lambdaA);
        const gbh = getGoalBothHalves(lambdaH, lambdaA);
        const yc = predictYellowCards(undefined, league);
        const ht1x2 = getHT1X2(lambdaH, lambdaA);
        const htCS = getHTCorrectScores(lambdaH, lambdaA);
        const wm = getWinningMargin(mx);
        const sh = getSecondHalfMarkets(lambdaH, lambdaA, 0, 0); // Pre-match: 0-0 HT state

        // HT Goals O/U from HT matrix
        const HT_FACTOR = 0.44;
        const htMx = buildMatrix(lambdaH * HT_FACTOR, lambdaA * HT_FACTOR);
        const htO05 = 1 - htMx[0][0];
        const htO15 = queryMatrix(htMx, [{ type: "total_goals", op: ">", value: 1.5 }]);
        const htO25 = queryMatrix(htMx, [{ type: "total_goals", op: ">", value: 2.5 }]);

        // Exact team goals: P(home=0), P(home=1), P(home=2), P(home=3+)
        const homeExact = [0, 0, 0, 0];
        const awayExact = [0, 0, 0, 0];
        for (let i = 0; i < mx.length; i++) {
          for (let j = 0; j < mx[0].length; j++) {
            const idx = Math.min(i, 3);
            homeExact[idx] += mx[i][j];
            const jdx = Math.min(j, 3);
            awayExact[jdx] += mx[i][j];
          }
        }

        // Odd/Even total goals
        let oddGoals = 0;
        for (let i = 0; i < mx.length; i++)
          for (let j = 0; j < mx[0].length; j++)
            if ((i + j) % 2 === 1) oddGoals += mx[i][j];

        // Race to 2 goals (P that home reaches 2 first, away reaches 2 first, or neither reaches 2)
        // Approximate via matrix: P(home>=2 & away<=1) + P(home>=2 & away>=2 & home scored 2nd faster)
        // Simplified: use conditional probabilities from exact scores
        let raceTo2H = 0, raceTo2A = 0;
        for (let i = 0; i < mx.length; i++) {
          for (let j = 0; j < mx[0].length; j++) {
            if (i >= 2 && j < 2) raceTo2H += mx[i][j]; // Home has 2+, away has 0-1
            else if (j >= 2 && i < 2) raceTo2A += mx[i][j]; // Away has 2+, home has 0-1
            else if (i >= 2 && j >= 2) {
              // Both reach 2+: split proportionally by lambda (who scores faster)
              const hShare = lambdaH / (lambdaH + lambdaA);
              raceTo2H += mx[i][j] * hShare;
              raceTo2A += mx[i][j] * (1 - hShare);
            }
          }
        }
        const raceTo2Neither = 1 - raceTo2H - raceTo2A;

        // Clean sheet & Win to nil
        const csH = mk.CS_H; // P(away=0)
        const csA = mk.CS_A; // P(home=0)
        const wtnH = queryMatrix(mx, [{ type: "goal_diff", op: ">", value: 0 }, { type: "away_goals", op: "==", value: 0 }]);
        const wtnA = queryMatrix(mx, [{ type: "goal_diff", op: "<", value: 0 }, { type: "home_goals", op: "==", value: 0 }]);

        // Draw No Bet
        const dnbH = mk.H / (mk.H + mk.A);
        const dnbA = mk.A / (mk.H + mk.A);

        // Heatmap: 7x7 slice of matrix
        const heatmap = mx.slice(0, 7).map(row => row.slice(0, 7));

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
          cleanSheetH: csH,
          cleanSheetA: csA,
          winToNilH: wtnH,
          winToNilA: wtnA,
          drawNoBetH: dnbH,
          drawNoBetA: dnbA,
          htGoalsOU: { O05: htO05, O15: htO15, O25: htO25 },
          secondHalf: sh,
          homeExact,
          awayExact,
          oddGoals,
          evenGoals: 1 - oddGoals,
          raceTo2H,
          raceTo2A,
          raceTo2Neither,
          heatmap,
          formH: h.form || "",
          formA: a.form || "",
          dataQuality,
          engine,
          rawMatch: match,
          xgPerGameH: xgPgH,
          xgaPerGameH: xgaPgH,
          xgPerGameA: xgPgA,
          xgaPerGameA: xgaPgA,
          homePos: null,
          awayPos: null,
          homePoints: null,
          awayPoints: null,
          confidence: 0,
          analysis: "",
        };

        // Lookup live odds
        const matchOdds = findOdds(h.name, a.name);
        if (matchOdds) {
          report.bestOdds = {
            h: matchOdds.best_h || 0, d: matchOdds.best_d || 0, a: matchOdds.best_a || 0,
            o25: matchOdds.best_over25 || 0, u25: matchOdds.best_under25 || 0,
          };
          if (matchOdds.sharp_h) {
            report.sharpOdds = { h: matchOdds.sharp_h, d: matchOdds.sharp_d || 0, a: matchOdds.sharp_a || 0 };
          }
          report.numBookmakers = matchOdds.num_bookmakers;
        }

        // Lookup table positions
        const leagueStandings = standings.get(league);
        const hRow = findPos(h.name, leagueStandings);
        const aRow = findPos(a.name, leagueStandings);
        if (hRow) { report.homePos = hRow.pos; report.homePoints = hRow.points; }
        if (aRow) { report.awayPos = aRow.pos; report.awayPoints = aRow.points; }

        report.confidence = computeConfidence(report);
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
  }, [allData, standings, sosMap, oddsMap, loading]);

  // Group by league, then by date within each league
  const groupedByLeague = useMemo(() => {
    const leagueMap = new Map<string, MatchReport[]>();
    for (const r of reports) {
      if (!leagueMap.has(r.league)) leagueMap.set(r.league, []);
      leagueMap.get(r.league)!.push(r);
    }
    return Array.from(leagueMap.entries());
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
        <EngineLoader
          phase={progress.phase}
          leaguesDone={progress.leaguesDone}
          totalLeagues={progress.totalLeagues}
          inFlight={progress.inFlight}
          failed={progress.failed}
        />
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

          {groupedByLeague.map(([league, matches]) => {
            const leagueStandings = standings.get(league);
            const ld = LEAGUES[league];
            // Sub-group by date within league
            const byDate = new Map<string, MatchReport[]>();
            for (const r of matches) {
              const date = r.kickoff?.slice(0, 10) || "Unbekannt";
              if (!byDate.has(date)) byDate.set(date, []);
              byDate.get(date)!.push(r);
            }
            return (
              <div key={league} style={{ marginBottom: 20 }}>
                <div style={{
                  fontSize: 13, fontWeight: 700, color: "#d4b86a", letterSpacing: "0.05em",
                  padding: "8px 0 6px", borderBottom: "2px solid #c4a26530", marginBottom: 8,
                }}>
                  {ld?.name || league}
                  {(() => {
                    const leagueData = allData.find(d => d.league === league)?.data;
                    const upd = (leagueData as any)?.last_updated;
                    return upd ? <span style={{ fontWeight: 400, fontSize: 10, color: "#a89070", marginLeft: 8 }}>Update: {upd}</span> : null;
                  })()}
                </div>

                {/* Standings Table (collapsible) */}
                {leagueStandings && leagueStandings.length > 0 && (
                  <StandingsTable rows={leagueStandings} leagueName={ld?.name || league} />
                )}

                {/* Matches grouped by date */}
                {Array.from(byDate.entries()).map(([date, dateMatches]) => (
                  <div key={date}>
                    <div style={{
                      fontSize: 10, fontWeight: 600, color: "#a89070", letterSpacing: "0.05em",
                      padding: "4px 0", marginBottom: 4, marginTop: 4,
                    }}>
                      {formatDateLabel(date)}
                    </div>
                    {dateMatches.map((r, i) => (
                      <MatchReportCard key={`${r.home}-${r.away}-${i}`} report={r} sos={sosMap.get(r.league)} />
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </AppShell>
  );
}
