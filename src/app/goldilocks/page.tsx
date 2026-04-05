"use client";
import { useState, useEffect, useMemo } from "react";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import { LEAGUES, vigAdjustBest } from "@/lib/dixon-coles";
import { color, fontSize, fontWeight, space, radius } from "@/styles/tokens";
import { card, badge } from "@/styles/components";

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
  pinnacleOdds: number;
  fairProb: number;
  impliedProb: number;
  edge: number;
  grade: "A" | "B" | "C";
}

// ─── Styles ─────────────────────────────────────────────────────────

const S = {
  header: {
    textAlign: "center" as const, marginBottom: space[5], padding: `${space[4]}px 0`,
  },
  title: {
    fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: color.gold,
    marginBottom: space[2],
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
  betCard: { ...card(), padding: space[4], marginBottom: space[3] },
  cardHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginBottom: space[3],
  },
  league: { fontSize: fontSize.xs, color: color.textMuted },
  matchName: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.text,
    marginBottom: space[2],
  },
  betRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: space[3], flexWrap: "wrap" as const,
  },
  betLabel: {
    fontSize: fontSize.base, fontWeight: fontWeight.bold, color: color.gold,
  },
  betOdds: {
    fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: color.goldShine,
    fontFamily: "Georgia, serif",
  },
  edgeBox: { textAlign: "right" as const },
  edgeValue: (e: number) => ({
    fontSize: fontSize.base, fontWeight: fontWeight.bold,
    color: e >= EDGE_GRADE_A ? color.value : e >= EDGE_GRADE_B ? color.gold : color.textMuted,
  }),
  probText: { fontSize: fontSize.xs, color: color.textMuted },
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

const MARKET_LABELS: Record<string, string> = {
  "1": "Heim", "X": "Remis", "2": "Gast", "Ü2.5": "Über 2.5", "U2.5": "Unter 2.5",
};

type FilterType = "all" | "A" | "B" | "1X2" | "OU";

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
      const { loadLiveOdds } = await import("@/lib/supabase");
      const leagueKeys = Object.keys(LEAGUES).filter(k => leagueStatus[k]);
      const allBets: GoldilocksBet[] = [];

      await Promise.all(leagueKeys.map(async (league) => {
        try {
          const odds = await loadLiveOdds(supabase, league);
          const ld = LEAGUES[league];

          for (const o of odds) {
            const sh = o.sharp_h, sd = o.sharp_d, sa = o.sharp_a;
            const bh = o.best_h, bd = o.best_d, ba = o.best_a;
            if (!sh || sh <= 1 || !bh || bh <= 1 || !sd || !sa || !bd || !ba) continue;

            const sharpVig = vigAdjustBest([sh, sd, sa]);
            const [pinnH, pinnD, pinnA] = sharpVig.probs;

            const markets: { key: string; fairProb: number; bestOdds: number; pinnOdds: number }[] = [
              { key: "1", fairProb: pinnH, bestOdds: bh, pinnOdds: sh },
              { key: "X", fairProb: pinnD, bestOdds: bd, pinnOdds: sd },
              { key: "2", fairProb: pinnA, bestOdds: ba, pinnOdds: sa },
            ];

            const so25 = o.sharp_over25, su25 = o.sharp_under25;
            const bo25 = o.best_over25, bu25 = o.best_under25;
            if (so25 && so25 > 1 && bo25 && bo25 > 1) {
              const ouVig = vigAdjustBest([so25, su25 || 1.01]);
              markets.push({ key: "Ü2.5", fairProb: ouVig.probs[0], bestOdds: bo25, pinnOdds: so25 });
              if (bu25 && bu25 > 1) {
                markets.push({ key: "U2.5", fairProb: ouVig.probs[1], bestOdds: bu25, pinnOdds: su25 || 0 });
              }
            }

            for (const mkt of markets) {
              const impliedProb = 1 / mkt.bestOdds;
              const edge = mkt.fairProb - impliedProb;

              if (edge >= EDGE_MIN && edge <= EDGE_MAX) {
                const grade: "A" | "B" | "C" = edge >= EDGE_GRADE_A ? "A" : edge >= EDGE_GRADE_B ? "B" : "C";
                allBets.push({
                  league, leagueName: ld?.name || league,
                  homeTeam: o.home_team, awayTeam: o.away_team,
                  kickoff: o.commence_time || "",
                  market: mkt.key, bestOdds: mkt.bestOdds, pinnacleOdds: mkt.pinnOdds,
                  fairProb: mkt.fairProb, impliedProb, edge, grade,
                });
              }
            }
          }
        } catch (err) {
          console.warn(`[Goldilocks] Failed to load odds for ${league}:`, err);
        }
      }));

      allBets.sort((a, b) => b.edge - a.edge);
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
      return true;
    });
  }, [bets, filter]);

  const { gradeA, gradeB, gradeC, avgEdge } = useMemo(() => {
    let a = 0, b = 0, c = 0, sum = 0;
    for (const bet of bets) {
      if (bet.grade === "A") a++; else if (bet.grade === "B") b++; else c++;
      sum += bet.edge;
    }
    return { gradeA: a, gradeB: b, gradeC: c, avgEdge: bets.length ? sum / bets.length : 0 };
  }, [bets]);

  if (loading) {
    return (
      <AppShell>
        <div style={S.loading}>
          <div style={{ fontSize: 36, marginBottom: space[3] }}>🎯</div>
          Lade Goldilocks Bets...
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div style={S.header}>
        <div style={S.count}>{bets.length}</div>
        <div style={S.title}>Goldilocks Bets</div>
        <div style={S.subtitle}>
          Edge 2.5%–7.5% · {gradeA}× A · {gradeB}× B · {gradeC}× C · Ø {(avgEdge * 100).toFixed(1)}%
          {lastFetch && ` · ${lastFetch}`}
        </div>
      </div>

      <div style={S.chips}>
        {([
          ["all", `Alle (${bets.length})`],
          ["A", `Grade A (${gradeA})`],
          ["B", `Grade B (${gradeB})`],
          ["1X2", "1X2"],
          ["OU", "Ü/U 2.5"],
        ] as [FilterType, string][]).map(([key, label]) => (
          <button key={key} style={S.chip(filter === key)} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: 28, marginBottom: space[3] }}>🔍</div>
          Keine Goldilocks-Bets mit diesem Filter gefunden.
        </div>
      ) : (
        filtered.map((bet, i) => (
          <div key={`${bet.league}-${bet.homeTeam}-${bet.market}-${i}`} style={S.betCard}>
            <div style={S.cardHeader}>
              <div style={S.league}>{bet.leagueName}</div>
              <div style={GRADE_BADGE[bet.grade]}>{bet.grade}</div>
            </div>
            <div style={S.matchName}>{bet.homeTeam} vs {bet.awayTeam}</div>
            <div style={S.betRow}>
              <div>
                <div style={S.betLabel}>{MARKET_LABELS[bet.market] || bet.market}</div>
                <div style={{ fontSize: fontSize.xs, color: color.textFaint }}>
                  {bet.kickoff ? new Date(bet.kickoff).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}
                </div>
              </div>
              <div style={S.betOdds}>@ {bet.bestOdds.toFixed(2)}</div>
              <div style={S.edgeBox}>
                <div style={S.edgeValue(bet.edge)}>+{(bet.edge * 100).toFixed(1)}%</div>
                <div style={S.probText}>Prob {(bet.fairProb * 100).toFixed(0)}%</div>
              </div>
            </div>
            <div style={S.detailRow}>
              <span>Pinnacle: {bet.pinnacleOdds.toFixed(2)} → Fair {(bet.fairProb * 100).toFixed(1)}%</span>
              <span>Best: {bet.bestOdds.toFixed(2)} → Implied {(bet.impliedProb * 100).toFixed(1)}%</span>
            </div>
          </div>
        ))
      )}

      <div style={S.footer}>
        <div style={S.footerTitle}>Was ist Goldilocks?</div>
        <div style={S.footerText}>
          Der Goldilocks Guard filtert Wetten nach dem Prinzip &quot;nicht zu klein, nicht zu groß&quot;:
          Ein Edge unter 2.5% ist statistisches Rauschen. Über 7.5% deutet auf fehlende Informationen hin.
          Die Zone 2.5%–7.5% ist der Sweet Spot — groß genug für realen Profit, klein genug um realistisch zu sein.
          Grade A (≥5%) sind die stärksten Picks, Grade B (4–5%) sind solide, Grade C (2.5–4%) marginal.
        </div>
      </div>
    </AppShell>
  );
}
