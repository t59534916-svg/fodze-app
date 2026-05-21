// ═══════════════════════════════════════════════════════════════════════
// src/components/matchday-card/mock-data.ts
//
// Synthetic Bundesliga 25/26 data exercising all 5 design archetypes.
// Replace with real data via useMatchdayCards() once wired to engine + DB.
// ═══════════════════════════════════════════════════════════════════════

import { color } from "@/styles/tokens";
import type { MatchData, TeamRef } from "./types";
import type { TriggerResult } from "@/lib/triggers";

// ─── Team registry (from team_metadata.logo_url + color_primary) ─────

const TEAM = {
  bayern:     { name: "Bayern",         abbr: "BAY", logo: "https://r2.thesportsdb.com/images/media/team/badge/01ogkh1716960412.png", primary: "#dc052d", primaryDark: "#b3041e", textOn: "#fff" } as TeamRef,
  dortmund:   { name: "Dortmund",       abbr: "BVB", logo: "https://r2.thesportsdb.com/images/media/team/badge/tqo8ge1716960353.png", primary: "#FDE100", primaryDark: "#d4b800", textOn: color.leather } as TeamRef,
  leverkusen: { name: "Leverkusen",     abbr: "B04", logo: "https://r2.thesportsdb.com/images/media/team/badge/3x9k851726760113.png", primary: "#E32221", primaryDark: "#b81d1c", textOn: "#fff" } as TeamRef,
  frankfurt:  { name: "Frankfurt",      abbr: "SGE", logo: "https://r2.thesportsdb.com/images/media/team/badge/rurwpy1473453269.png", primary: "#E1000F", primaryDark: "#b00007", textOn: "#fff" } as TeamRef,
  bremen:     { name: "Werder Bremen",  abbr: "SVW", logo: "https://r2.thesportsdb.com/images/media/team/badge/tkvqan1716960454.png", primary: "#1d9053", primaryDark: "#157240", textOn: "#fff" } as TeamRef,
  heidenheim: { name: "Heidenheim",     abbr: "FCH", logo: "https://r2.thesportsdb.com/images/media/team/badge/lbj7g01608236988.png", primary: "#e2001a", primaryDark: "#b00014", textOn: "#fff" } as TeamRef,
  mainz:      { name: "Mainz",          abbr: "M05", logo: "https://r2.thesportsdb.com/images/media/team/badge/fhm9v51552134916.png", primary: "#C3141E", primaryDark: "#9d1018", textOn: "#fff" } as TeamRef,
  hoffenheim: { name: "Hoffenheim",     abbr: "TSG", logo: "https://r2.thesportsdb.com/images/media/team/badge/9hwvb21621593919.png", primary: "#1961B5", primaryDark: "#144d8c", textOn: "#fff" } as TeamRef,
  augsburg:   { name: "Augsburg",       abbr: "FCA", logo: "https://r2.thesportsdb.com/images/media/team/badge/xqyyvq1473453233.png", primary: "#ba3733", primaryDark: "#962a27", textOn: "#fff" } as TeamRef,
  stpauli:    { name: "St. Pauli",      abbr: "STP", logo: "https://r2.thesportsdb.com/images/media/team/badge/5qupxa1608237013.png", primary: "#624839", primaryDark: "#4a362a", textOn: "#fff" } as TeamRef,
};

// ─── Trigger result builders (mirror production trigger-detector output) ─

const tXG = (lambdaE: number, lambdaM: number, league = "bundesliga"): TriggerResult => {
  const gap = lambdaE - lambdaM;
  return {
    type: "xg_market",
    severity: Math.min(1, Math.abs(gap) / 0.5),
    parts: [
      { kind: "text", value: "Engine λ " },
      { kind: "highlight", value: lambdaE.toFixed(2) },
      { kind: "text", value: ` vs Markt ${lambdaM.toFixed(2)} (${gap >= 0 ? "+" : ""}${gap.toFixed(2)} gap)` },
    ],
    data: { lambdaEngine: lambdaE, lambdaMarket: lambdaM, gap, league },
  };
};

const tXGWithDrift = (lambdaE: number, lambdaM: number, driftMsg: string): TriggerResult => {
  const base = tXG(lambdaE, lambdaM);
  return {
    ...base,
    parts: [...base.parts, { kind: "sub", value: driftMsg }],
  };
};

const tCoaching = (manager: string, days: number, boost: [number, number], matchNo?: number): TriggerResult => ({
  type: "coaching_change",
  severity: 0.6,
  parts: [
    { kind: "highlight", value: "NEUER TRAINER" },
    { kind: "text", value: ` ${manager} · ${days} Tage · ${boost[0]}/${boost[1]} BL-changes hatten Boost-Match in Spiel 3-5` },
    ...(matchNo ? [{ kind: "sub" as const, value: `→ this = Match #${matchNo} nach Wechsel` }] : []),
  ],
  data: { managerName: manager, daysSinceChange: days, ligaBoostRate: { boostCount: boost[0], total: boost[1] }, matchNumberAfterChange: matchNo },
});

interface StreakSide { name: string; outcome: "W" | "L" | "D"; n: number; ctx?: string; }
const tStreak = (home: StreakSide | null, away: StreakSide | null): TriggerResult => {
  const parts: TriggerResult["parts"] = [];
  if (home) {
    parts.push({ kind: "text", value: `${home.name} ` });
    parts.push({ kind: home.outcome === "L" ? "warn" : "highlight", value: `${home.outcome}${home.n}` });
    if (home.ctx) parts.push({ kind: "text", value: ` ${home.ctx}` });
  }
  if (home && away) parts.push({ kind: "text", value: " · " });
  if (away) {
    parts.push({ kind: "text", value: `${away.name} ` });
    parts.push({ kind: away.outcome === "L" ? "warn" : "highlight", value: `${away.outcome}${away.n}` });
    if (away.ctx) parts.push({ kind: "text", value: ` ${away.ctx}` });
  }
  const maxN = Math.max(home?.n ?? 0, away?.n ?? 0);
  return {
    type: "streak_pattern",
    severity: Math.min(1, maxN / 8),
    parts,
    data: { homeGeneral: home, awayGeneral: away },
  };
};

// ─── 5 mock cards ────────────────────────────────────────────────────

export const MOCK_CARDS: MatchData[] = [
  {
    id: "card1",
    home: TEAM.bayern, away: TEAM.dortmund,
    kickoff: "So 18:30 · BL", league: "bundesliga",
    archetype: "Card 1 · 3 Triggers · Gold Zone (Idealfall)",
    probH: 52, probD: 22, probA: 26,
    xgH: 1.85, xgA: 1.35, xgSum: 3.20,
    marketLabel: "Over 2.5 Goals",
    edgePct: 5.2,
    trustBand: "gold", trustHit: 0.68, trustN: 42,
    engineProb: 55, marktProb: 52, gapPp: 3,
    sigma2: 0.043, confPct: 90, confLevel: "high",
    clv: "CLV +1.2pp tracking",
    triggers: [
      tXG(3.20, 2.78),
      tCoaching("Tuchel", 11, [8, 11], 3),
      tStreak({ name: "Bayern", outcome: "W", n: 7, ctx: "Auswärts-Derby" }, { name: "Dortmund", outcome: "L", n: 3, ctx: "vs Top-3" }),
    ],
    betEuro: 14, kellyMult: 1.0,
  },
  {
    id: "card2",
    home: TEAM.leverkusen, away: TEAM.frankfurt,
    kickoff: "Sa 15:30 · BL", league: "bundesliga",
    archetype: "Card 2 · 2 Triggers · Gold Zone",
    probH: 56, probD: 22, probA: 22,
    xgH: 2.40, xgA: 1.30, xgSum: 3.70,
    marketLabel: "Home Win",
    edgePct: 4.1,
    isHomeBet: true,
    trustBand: "gold", trustHit: 0.65, trustN: 38,
    engineProb: 56, marktProb: 54, gapPp: 2,
    sigma2: 0.051, confPct: 84, confLevel: "high",
    triggers: [
      tXG(2.40, 2.08),
      tStreak({ name: "Leverkusen", outcome: "W", n: 5, ctx: "Home-Streak · 4× clean sheet in 5" }, null),
    ],
    betEuro: 11, kellyMult: 1.0,
  },
  {
    id: "card3",
    home: TEAM.bremen, away: TEAM.heidenheim,
    kickoff: "Sa 15:30 · BL", league: "bundesliga",
    archetype: "Card 3 · 1 Trigger · Caution Zone",
    probH: 45, probD: 28, probA: 27,
    xgH: 1.55, xgA: 1.40, xgSum: 2.95,
    marketLabel: "Over 2.5 Goals",
    edgePct: 3.8,
    trustBand: "caution", trustHit: 0.57, trustN: 28, trustUnderCov: true,
    engineProb: 56, marktProb: 53, gapPp: 3,
    sigma2: 0.072, confPct: 62, confLevel: "med",
    triggers: [tXG(2.95, 2.69)],
    betEuro: 5, kellyMult: 0.7,
  },
  {
    id: "card4",
    home: TEAM.mainz, away: TEAM.hoffenheim,
    kickoff: "So 15:30 · BL", league: "bundesliga",
    archetype: "Card 4 · 0 Triggers · Compact (low signal)",
    probH: 38, probD: 28, probA: 34,
    xgH: 1.45, xgA: 1.40, xgSum: 2.85,
    marketLabel: "Over 2.5 Goals",
    edgePct: 2.1,
    trustBand: "gold", trustHit: 0.66, trustN: 41,
    engineProb: 53, marktProb: 52, gapPp: 1,
    sigma2: 0.048, confPct: 87, confLevel: "high",
    noTriggers: true,
    triggers: [],
    betEuro: 4, kellyMult: 1.0,
  },
  {
    id: "card5",
    home: TEAM.augsburg, away: TEAM.stpauli,
    kickoff: "So 17:30 · BL", league: "bundesliga",
    archetype: "Card 5 · 2 Triggers · Trap Zone (verführerische Edge)",
    probH: 42, probD: 24, probA: 34,
    xgH: 1.70, xgA: 1.40, xgSum: 3.10,
    marketLabel: "Over 2.5 Goals",
    edgePct: 6.8,
    trustBand: "trap", trustHit: 0.43, trustN: 12, trustUnderCov: true,
    engineProb: 60, marktProb: 54, gapPp: 6, gapWarn: true,
    sigma2: 0.068, confPct: 67, confLevel: "med",
    driftWarn: "⚠ BL-Brier drift +0.018 letzte 4 Wochen",
    triggers: [
      tXGWithDrift(3.10, 2.62, "⚠ Liga-Calibration aktuell drift — model under-trusted hier"),
      tStreak({ name: "Augsburg", outcome: "L", n: 4, ctx: "Home" }, { name: "St. Pauli", outcome: "W", n: 3, ctx: "Auswärts" }),
    ],
    betEuro: 3, kellyMult: 0.3,
  },
];
