"use client";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import { LEAGUES, vigAdjustBest } from "@/lib/dixon-coles";
import { computeEngineProbs, classifyEdgeSource, type EdgeSource } from "@/lib/goldilocks-engine";
import { fuzzyTeamMatch } from "@/lib/team-resolver";
import { color, fontSize, fontWeight, space, radius } from "@/styles/tokens";
import { card, badge } from "@/styles/components";
import type { MatchdayData, RawMatch } from "@/types/match";

// ─── Constants ──────────────────────────────────────────────────────

const EDGE_MIN = 0.025;
const EDGE_MAX = 0.075;
const EDGE_GRADE_A = 0.05;
const EDGE_GRADE_B = 0.04;

// ─── Types ──────────────────────────────────────────────────────────

interface GoldilocksBet {
  league: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  market: string;
  bestOdds: number;
  // Market-derived fair prob (Pinnacle sharp, vig-removed) — always set.
  marketFairProb: number;
  pinnacleOdds: number;
  // Engine-derived fair prob (FODZE ensemble) — set only when the stored
  // matchday JSON has enough xG data for the engine to speak.
  engineFairProb?: number;
  impliedProb: number;
  // Edge selected for display + grading (the stronger of the two sources
  // when both agree, or the only one that triggered).
  edge: number;
  marketEdge: number;
  engineEdge?: number;
  grade: "A" | "B" | "C";
  // Which source(s) detected this edge inside the Goldilocks zone.
  source: EdgeSource;
}

// ─── Styles ─────────────────────────────────────────────────────────

const S = {
  header: {
    textAlign: "center" as const, marginBottom: space[5], padding: `${space[4]}px 0`,
  },
  title: {
    fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: color.gold,
    marginTop: 0, marginBottom: space[2],
  },
  subtitle: { fontSize: fontSize.sm, color: color.textMuted },
  chips: {
    display: "flex", gap: space[2], flexWrap: "wrap" as const,
    justifyContent: "center", marginBottom: space[5],
  },
  chip: (active: boolean) => ({
    padding: `${space[2]}px ${space[4]}px`,
    borderRadius: radius.full,
    border: `1px solid ${active ? color.gold : color.border}`,
    background: active ? `${color.gold}20` : "transparent",
    color: active ? color.gold : color.textMuted,
    fontSize: fontSize.xs, fontWeight: fontWeight.medium,
    cursor: "pointer", transition: "all 0.15s",
    minHeight: 44, display: "inline-flex", alignItems: "center",
  }),
  betCard: {
    ...card(), padding: space[4], marginBottom: space[3],
    display: "block", textDecoration: "none", cursor: "pointer",
  },
  cardHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginBottom: space[3],
  },
  league: { fontSize: fontSize.xs, color: color.textMuted },
  matchName: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.text,
    marginBottom: space[3],
  },
  betRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    alignItems: "center",
    gap: space[3],
  },
  betLabel: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.text,
  },
  betOdds: {
    fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: color.textMuted,
    fontFamily: "Georgia, serif", textAlign: "center" as const,
    minWidth: 56,
  },
  edgeBox: { textAlign: "right" as const, minWidth: 64 },
  edgeValue: (e: number) => ({
    fontSize: fontSize.xl, fontWeight: fontWeight.bold,
    color: e >= EDGE_GRADE_A ? color.value : e >= EDGE_GRADE_B ? color.gold : color.textMuted,
    lineHeight: 1, fontFamily: "Georgia, serif",
  }),
  probText: { fontSize: fontSize.xs, color: color.textMuted, marginTop: 2 },
  detailRow: {
    display: "flex", justifyContent: "space-between",
    fontSize: fontSize.xs, color: color.textFaint, marginTop: space[2],
    paddingTop: space[2], borderTop: `1px solid ${color.border}`,
  },
  footer: {
    marginTop: space[6], padding: space[4],
    background: color.surface, borderRadius: radius.md,
    border: `1px solid ${color.border}`,
  },
  footerTitle: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.gold,
    marginBottom: space[2],
  },
  footerText: { fontSize: fontSize.xs, color: color.textMuted, lineHeight: 1.5 },
  empty: {
    textAlign: "center" as const, padding: `${space[7]}px ${space[4]}px`,
    color: color.textMuted, fontSize: fontSize.sm,
  },
  loading: {
    textAlign: "center" as const, padding: `${space[7]}px ${space[4]}px`,
    color: color.textFaint, fontSize: fontSize.sm,
  },
  count: {
    fontSize: 40, fontWeight: fontWeight.bold, color: color.goldShine,
    fontFamily: "Georgia, serif", lineHeight: 1,
  },
};

const GRADE_BADGE: Record<string, ReturnType<typeof badge>> = {
  A: badge("value"), B: badge("gold"), C: badge("neutral"),
};

const SOURCE_BADGE: Record<EdgeSource, ReturnType<typeof badge>> = {
  consensus: badge("value"),
  market: badge("info"),
  engine: badge("gold"),
};

const SOURCE_LABEL: Record<EdgeSource, string> = {
  consensus: "Konsens",
  market: "Markt",
  engine: "Engine",
};

const SOURCE_TOOLTIP: Record<EdgeSource, string> = {
  consensus: "Markt & FODZE-Engine stimmen überein — stärkstes Signal",
  market: "Nur Pinnacle-Sharp-Line signalisiert Edge — Engine hat keine Meinung oder widerspricht",
  engine: "Nur FODZE-Engine sieht Edge — Pinnacle preist es nicht so. In Top-Ligen eher Modell-Fehler, in Liga 3 / Greek SL real möglich",
};

const MARKET_LABELS: Record<string, string> = {
  "1": "Heim", "X": "Remis", "2": "Gast", "Ü2.5": "Über 2.5", "U2.5": "Unter 2.5",
};

type FilterType = "all" | "A" | "B" | "1X2" | "OU" | "consensus";

// ─── Component ──────────────────────────────────────────────────────

export default function GoldilocksPage() {
  const { supabase, leagueStatus } = useApp();
  const [bets, setBets] = useState<GoldilocksBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");
  const [lastFetch, setLastFetch] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { loadLiveOdds, loadLatestMatchday } = await import("@/lib/supabase");
      const leagueKeys = Object.keys(LEAGUES).filter(k => leagueStatus[k]);
      const allBets: GoldilocksBet[] = [];

      await Promise.all(leagueKeys.map(async (league) => {
        try {
          // Parallel: live odds (always) + latest stored matchday (only if
          // present — we gracefully fall back to market-only when missing).
          // We deliberately do NOT enrich xG history on-the-fly here; that
          // would add 2 queries per team × 10 matches × 18 leagues = way too
          // many RPCs. Engine-edge is therefore only available for matchdays
          // that were seeded with enriched data (top-5 leagues, mostly).
          const [odds, cached] = await Promise.all([
            loadLiveOdds(supabase, league),
            loadLatestMatchday(supabase, league).catch(() => null),
          ]);
          const ld = LEAGUES[league];
          const matchdayData: MatchdayData | null = cached?.data || null;

          for (const o of odds) {
            const sh = o.sharp_h, sd = o.sharp_d, sa = o.sharp_a;
            const bh = o.best_h, bd = o.best_d, ba = o.best_a;
            if (!sh || sh <= 1 || !bh || bh <= 1 || !sd || !sa || !bd || !ba) continue;

            // ── Market-edge (Pinnacle sharp, vig-removed) ──────────────
            const sharpVig = vigAdjustBest([sh, sd, sa]);
            const [pinnH, pinnD, pinnA] = sharpVig.probs;

            // ── Engine-edge (FODZE ensemble) ───────────────────────────
            // Match live_odds row → stored matchday match via fuzzy team
            // name compare (live_odds uses OddsAPI names which don't always
            // match FODZE names). Engine probs are undefined when we can't
            // find the match or it lacks xG data — the calling code treats
            // that as "market-only" and doesn't invent engine edges.
            let enginePr: ReturnType<typeof computeEngineProbs> | null = null;
            if (matchdayData?.matches) {
              const ourMatch = matchdayData.matches.find(
                (m: RawMatch) =>
                  fuzzyTeamMatch(m.home?.name || "", o.home_team) &&
                  fuzzyTeamMatch(m.away?.name || "", o.away_team),
              );
              if (ourMatch && ld) {
                enginePr = computeEngineProbs({
                  match: ourMatch,
                  league,
                  leagueAvg: ld.avg,
                  leagueHf: ld.hf,
                });
              }
            }

            // Each market: compute BOTH edges, classify, emit row only if
            // at least one source places it in the Goldilocks zone.
            type MarketEntry = {
              key: string;
              marketFair: number;
              engineFair: number | undefined;
              bestOdds: number;
              pinnOdds: number;
            };
            const markets: MarketEntry[] = [
              { key: "1", marketFair: pinnH, engineFair: enginePr?.h, bestOdds: bh, pinnOdds: sh },
              { key: "X", marketFair: pinnD, engineFair: enginePr?.d, bestOdds: bd, pinnOdds: sd },
              { key: "2", marketFair: pinnA, engineFair: enginePr?.a, bestOdds: ba, pinnOdds: sa },
            ];

            const so25 = o.sharp_over25, su25 = o.sharp_under25;
            const bo25 = o.best_over25, bu25 = o.best_under25;
            if (so25 && so25 > 1 && bo25 && bo25 > 1) {
              const ouVig = vigAdjustBest([so25, su25 || 1.01]);
              markets.push({ key: "Ü2.5", marketFair: ouVig.probs[0], engineFair: enginePr?.o25, bestOdds: bo25, pinnOdds: so25 });
              if (bu25 && bu25 > 1) {
                markets.push({ key: "U2.5", marketFair: ouVig.probs[1], engineFair: enginePr?.u25, bestOdds: bu25, pinnOdds: su25 || 0 });
              }
            }

            for (const mkt of markets) {
              const impliedProb = 1 / mkt.bestOdds;
              const marketEdge = mkt.marketFair - impliedProb;
              const engineEdge = mkt.engineFair != null ? mkt.engineFair - impliedProb : undefined;

              const marketInZone = marketEdge >= EDGE_MIN && marketEdge <= EDGE_MAX;
              const engineInZone = engineEdge != null && engineEdge >= EDGE_MIN && engineEdge <= EDGE_MAX;
              const source = classifyEdgeSource(marketInZone, engineInZone);
              if (!source) continue;

              // Display-edge: when both agree, use the larger of the two so
              // the grade reflects the strongest signal. When only one
              // source triggered, use that one's edge.
              const displayEdge =
                source === "consensus"
                  ? Math.max(marketEdge, engineEdge as number)
                  : source === "engine"
                  ? (engineEdge as number)
                  : marketEdge;

              const grade: "A" | "B" | "C" =
                displayEdge >= EDGE_GRADE_A ? "A" : displayEdge >= EDGE_GRADE_B ? "B" : "C";

              allBets.push({
                league, leagueName: ld?.name || league,
                homeTeam: o.home_team, awayTeam: o.away_team,
                kickoff: o.commence_time || "",
                market: mkt.key, bestOdds: mkt.bestOdds, pinnacleOdds: mkt.pinnOdds,
                marketFairProb: mkt.marketFair,
                engineFairProb: mkt.engineFair,
                impliedProb,
                edge: displayEdge,
                marketEdge,
                engineEdge,
                grade,
                source,
              });
            }
          }
        } catch (err) {
          console.warn(`[Goldilocks] Failed to load odds for ${league}:`, err);
        }
      }));

      // Sort: consensus first (same edge size), then by edge descending.
      allBets.sort((a, b) => {
        if (a.source !== b.source) {
          const rank = { consensus: 0, market: 1, engine: 2 } as const;
          return rank[a.source] - rank[b.source];
        }
        return b.edge - a.edge;
      });
      setBets(allBets);
      setLastFetch(new Date().toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }));
      setLoading(false);
    })();
  }, [supabase, leagueStatus]);

  const filtered = useMemo(() => {
    return bets.filter(b => {
      if (filter === "A") return b.grade === "A";
      if (filter === "B") return b.grade === "B";
      if (filter === "1X2") return ["1", "X", "2"].includes(b.market);
      if (filter === "OU") return ["Ü2.5", "U2.5"].includes(b.market);
      if (filter === "consensus") return b.source === "consensus";
      return true;
    });
  }, [bets, filter]);

  const { gradeA, gradeB, gradeC, count1X2, countOU, avgEdge, countConsensus } = useMemo(() => {
    let a = 0, b = 0, c = 0, c1 = 0, co = 0, sum = 0, cons = 0;
    for (const bet of bets) {
      if (bet.grade === "A") a++; else if (bet.grade === "B") b++; else c++;
      if (bet.market === "1" || bet.market === "X" || bet.market === "2") c1++;
      else if (bet.market === "Ü2.5" || bet.market === "U2.5") co++;
      if (bet.source === "consensus") cons++;
      sum += bet.edge;
    }
    return {
      gradeA: a, gradeB: b, gradeC: c,
      count1X2: c1, countOU: co, countConsensus: cons,
      avgEdge: bets.length ? sum / bets.length : 0,
    };
  }, [bets]);

  if (loading) {
    return (
      <AppShell>
        <div style={S.loading} role="status" aria-live="polite">
          <div style={{ fontSize: 36, marginBottom: space[3] }} aria-hidden="true">🎯</div>
          Lade Goldilocks Bets...
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <header style={S.header}>
        <div style={S.count}>{bets.length}</div>
        <h1 style={S.title}>Goldilocks Bets</h1>
        <div style={S.subtitle}>
          Edge 2.5%–7.5% · {gradeA}× A · {gradeB}× B · {gradeC}× C · Ø {(avgEdge * 100).toFixed(1)}%
          {lastFetch && ` · ${lastFetch}`}
        </div>
      </header>

      <div style={S.chips} role="tablist" aria-label="Filter">
        {([
          ["all", `Alle (${bets.length})`],
          ["consensus", `Konsens (${countConsensus})`],
          ["A", `Grade A (${gradeA})`],
          ["B", `Grade B (${gradeB})`],
          ["1X2", `1X2 (${count1X2})`],
          ["OU", `Ü/U 2.5 (${countOU})`],
        ] as [FilterType, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            style={S.chip(filter === key)}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div aria-live="polite" aria-busy={loading}>
        {filtered.length === 0 ? (
          <div style={S.empty}>
            <div style={{ fontSize: 28, marginBottom: space[3] }} aria-hidden="true">🔍</div>
            Keine Goldilocks-Bets mit diesem Filter gefunden.
          </div>
        ) : (
          filtered.map((bet, i) => (
            <Link
              key={`${bet.league}-${bet.homeTeam}-${bet.market}-${i}`}
              href={`/matchday?league=${encodeURIComponent(bet.league)}&home=${encodeURIComponent(bet.homeTeam)}&away=${encodeURIComponent(bet.awayTeam)}`}
              style={S.betCard}
              aria-label={`${bet.homeTeam} gegen ${bet.awayTeam} — ${MARKET_LABELS[bet.market] || bet.market} @ ${bet.bestOdds.toFixed(2)}, Edge ${(bet.edge * 100).toFixed(1)} Prozent, Grade ${bet.grade}`}
            >
              <div style={S.cardHeader}>
                <div style={S.league}>{bet.leagueName}</div>
                <div style={{ display: "flex", gap: space[2], alignItems: "center" }}>
                  <div style={SOURCE_BADGE[bet.source]} title={SOURCE_TOOLTIP[bet.source]}>
                    {SOURCE_LABEL[bet.source]}
                  </div>
                  <div style={GRADE_BADGE[bet.grade]}>{bet.grade}</div>
                </div>
              </div>
              <div style={S.matchName}>{bet.homeTeam} vs {bet.awayTeam}</div>
              <div style={S.betRow}>
                <div>
                  <div style={S.betLabel}>{MARKET_LABELS[bet.market] || bet.market}</div>
                  <div style={{ fontSize: fontSize.xs, color: color.textFaint, marginTop: 2 }}>
                    {bet.kickoff ? new Date(bet.kickoff).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}
                  </div>
                </div>
                <div style={S.betOdds}>@ {bet.bestOdds.toFixed(2)}</div>
                <div style={S.edgeBox}>
                  <div style={S.edgeValue(bet.edge)}>+{(bet.edge * 100).toFixed(1)}%</div>
                  <div style={S.probText}>
                    {bet.source === "engine" && bet.engineFairProb != null
                      ? `Engine ${(bet.engineFairProb * 100).toFixed(0)}%`
                      : `Fair ${(bet.marketFairProb * 100).toFixed(0)}%`}
                  </div>
                </div>
              </div>
              <div style={S.detailRow}>
                <span>Markt (Pinn.): +{(bet.marketEdge * 100).toFixed(1)}%</span>
                <span>
                  Engine:{" "}
                  {bet.engineEdge != null
                    ? `${bet.engineEdge >= 0 ? "+" : ""}${(bet.engineEdge * 100).toFixed(1)}%`
                    : "—"}
                </span>
              </div>
            </Link>
          ))
        )}
      </div>

      <div style={S.footer}>
        <div style={S.footerTitle}>Was ist Goldilocks?</div>
        <div style={S.footerText}>
          Der Goldilocks Guard filtert Wetten nach dem Prinzip &quot;nicht zu klein, nicht zu groß&quot;:
          Ein Edge unter 2.5% ist statistisches Rauschen. Über 7.5% deutet auf fehlende Informationen hin.
          Die Zone 2.5%–7.5% ist der Sweet Spot — groß genug für realen Profit, klein genug um realistisch zu sein.
          Grade A (≥5%) sind die stärksten Picks, Grade B (4–5%) sind solide, Grade C (2.5–4%) marginal.
        </div>
        <div style={{ ...S.footerTitle, marginTop: space[4] }}>Zwei unabhängige Edge-Quellen</div>
        <div style={S.footerText}>
          <strong style={{ color: color.gold }}>Markt:</strong> Pinnacle-Sharp-Quote vig-bereinigt (industriestandard, stark in Top-Ligen).
          &nbsp;<strong style={{ color: color.gold }}>Engine:</strong> FODZE-Ensemble aus xG-Poisson + Elo + Logistic (unabhängig vom Markt).
          &nbsp;<strong style={{ color: color.gold }}>Konsens:</strong> beide sehen Edge — statistisch das robusteste Signal und unser Haupt-Filter für Wetten mit echter Confidence.
          Engine-Edges ohne Konsens in Top-Ligen sind vorsichtig zu behandeln (Pinnacle ist dort meist scharf);
          in unteren Ligen (Liga 3, Greek SL, League Two) kann Engine allein aber echte Fehler im Markt aufzeigen.
        </div>
      </div>
    </AppShell>
  );
}
