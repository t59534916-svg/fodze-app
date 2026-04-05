"use client";
import { useState, useEffect, useMemo } from "react";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import { LEAGUES, vigAdjustBest } from "@/lib/dixon-coles";
import { color, fontSize, fontWeight, space, radius } from "@/styles/tokens";

// ─── Types ──────────────────────────────────────────────────────────

interface GoldilocksBet {
  league: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  market: string;       // "1", "X", "2", "Ü2.5", "U2.5"
  bestOdds: number;
  pinnacleOdds: number;
  fairProb: number;     // Pinnacle vig-free
  impliedProb: number;  // From best odds
  edge: number;         // fairProb - impliedProb
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
    minHeight: 32, display: "inline-flex", alignItems: "center",
  }),
  card: {
    background: color.surface,
    border: `1px solid ${color.border}`,
    borderRadius: radius.md,
    padding: space[4],
    marginBottom: space[3],
    transition: "border-color 0.15s",
  },
  cardHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginBottom: space[3],
  },
  league: { fontSize: fontSize.xs, color: color.textMuted },
  grade: (g: string) => ({
    fontSize: fontSize.xs, fontWeight: fontWeight.bold,
    padding: `1px ${space[2]}px`, borderRadius: radius.sm,
    background: g === "A" ? "#6aad5530" : g === "B" ? "#d4b86a30" : "#a8907030",
    color: g === "A" ? "#6aad55" : g === "B" ? color.gold : color.textMuted,
  }),
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
  edgeBox: {
    textAlign: "right" as const,
  },
  edgeValue: (e: number) => ({
    fontSize: fontSize.base, fontWeight: fontWeight.bold,
    color: e >= 0.05 ? "#6aad55" : e >= 0.04 ? color.gold : color.textMuted,
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

// ─── Market Labels ──────────────────────────────────────────────────

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

  // Load live odds and compute Goldilocks bets
  useEffect(() => {
    (async () => {
      setLoading(true);
      const { loadLiveOdds } = await import("@/lib/supabase");
      const leagueKeys = Object.keys(LEAGUES).filter(k => leagueStatus[k] || k in LEAGUES);
      const allBets: GoldilocksBet[] = [];

      await Promise.all(leagueKeys.map(async (league) => {
        try {
          const odds = await loadLiveOdds(supabase, league);
          const ld = LEAGUES[league];

          for (const o of odds) {
            const sh = o.sharp_h as number, sd = o.sharp_d as number, sa = o.sharp_a as number;
            const bh = o.best_h as number, bd = o.best_d as number, ba = o.best_a as number;
            if (!sh || sh <= 1 || !bh || bh <= 1 || !sd || !sa) continue;

            // Pinnacle vig-free probabilities
            const sharpVig = vigAdjustBest([sh, sd, sa]);
            const [pinnH, pinnD, pinnA] = sharpVig.probs;

            const markets: { key: string; fairProb: number; bestOdds: number; pinnOdds: number }[] = [
              { key: "1", fairProb: pinnH, bestOdds: bh, pinnOdds: sh },
              { key: "X", fairProb: pinnD, bestOdds: bd, pinnOdds: sd },
              { key: "2", fairProb: pinnA, bestOdds: ba, pinnOdds: sa },
            ];

            // O/U 2.5
            const so25 = o.sharp_over25 as number, su25 = o.sharp_under25 as number;
            const bo25 = o.best_over25 as number, bu25 = o.best_under25 as number;
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

              // Goldilocks zone: 2.5% - 7.5%
              if (edge >= 0.025 && edge <= 0.075) {
                const grade: "A" | "B" | "C" = edge >= 0.05 ? "A" : edge >= 0.04 ? "B" : "C";
                allBets.push({
                  league,
                  leagueName: ld?.name || league,
                  homeTeam: o.home_team,
                  awayTeam: o.away_team,
                  kickoff: o.commence_time || "",
                  market: mkt.key,
                  bestOdds: mkt.bestOdds,
                  pinnacleOdds: mkt.pinnOdds,
                  fairProb: mkt.fairProb,
                  impliedProb,
                  edge,
                  grade,
                });
              }
            }
          }
        } catch { /* skip league */ }
      }));

      // Sort by edge descending
      allBets.sort((a, b) => b.edge - a.edge);
      setBets(allBets);
      setLastFetch(new Date().toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }));
      setLoading(false);
    })();
  }, [supabase, leagueStatus]);

  // Filter bets
  const filtered = useMemo(() => {
    return bets.filter(b => {
      if (filter === "A") return b.grade === "A";
      if (filter === "B") return b.grade === "B";
      if (filter === "1X2") return ["1", "X", "2"].includes(b.market);
      if (filter === "OU") return ["Ü2.5", "U2.5"].includes(b.market);
      return true;
    });
  }, [bets, filter]);

  // Stats
  const gradeA = bets.filter(b => b.grade === "A").length;
  const gradeB = bets.filter(b => b.grade === "B").length;
  const gradeC = bets.filter(b => b.grade === "C").length;
  const avgEdge = bets.length > 0 ? bets.reduce((s, b) => s + b.edge, 0) / bets.length : 0;

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
      {/* Header */}
      <div style={S.header}>
        <div style={S.count}>{bets.length}</div>
        <div style={S.title}>Goldilocks Bets</div>
        <div style={S.subtitle}>
          Edge 2.5%–7.5% · {gradeA}× A · {gradeB}× B · {gradeC}× C · Ø {(avgEdge * 100).toFixed(1)}%
          {lastFetch && ` · ${lastFetch}`}
        </div>
      </div>

      {/* Filter Chips */}
      <div style={S.chips}>
        {([
          ["all", `Alle (${bets.length})`],
          ["A", `Grade A (${gradeA})`],
          ["B", `Grade B (${gradeB})`],
          ["1X2", "1X2"],
          ["OU", "Ü/U 2.5"],
        ] as [FilterType, string][]).map(([key, label]) => (
          <div key={key} style={S.chip(filter === key)} onClick={() => setFilter(key)}>
            {label}
          </div>
        ))}
      </div>

      {/* Bet Cards */}
      {filtered.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: 28, marginBottom: space[3] }}>🔍</div>
          Keine Goldilocks-Bets mit diesem Filter gefunden.
        </div>
      ) : (
        filtered.map((bet, i) => (
          <div key={`${bet.homeTeam}-${bet.market}-${i}`} style={S.card}>
            {/* Card Header: League + Grade */}
            <div style={S.cardHeader}>
              <div style={S.league}>{bet.leagueName}</div>
              <div style={S.grade(bet.grade)}>{bet.grade}</div>
            </div>

            {/* Match Name */}
            <div style={S.matchName}>{bet.homeTeam} vs {bet.awayTeam}</div>

            {/* Bet Row */}
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

            {/* Detail Row */}
            <div style={S.detailRow}>
              <span>Pinnacle: {bet.pinnacleOdds.toFixed(2)} → Fair {(bet.fairProb * 100).toFixed(1)}%</span>
              <span>Best: {bet.bestOdds.toFixed(2)} → Implied {(bet.impliedProb * 100).toFixed(1)}%</span>
            </div>
          </div>
        ))
      )}

      {/* Footer Explainer */}
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
