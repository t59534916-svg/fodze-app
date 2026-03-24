"use client";
import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase";

// ─── Inline engine (lightweight, no TS imports) ─────────────────────

const RHO = -0.05, MAX_GOALS = 10; // Reduced for speed (10k sims)
const LEAGUES: Record<string, { name: string; hf: number; avg: number }> = {
  bundesliga: { name: "Bundesliga", hf: 1.28, avg: 1.38 },
  bundesliga2: { name: "2. Bundesliga", hf: 1.29, avg: 1.35 },
  liga3: { name: "3. Liga", hf: 1.22, avg: 1.40 },
  epl: { name: "Premier League", hf: 1.22, avg: 1.35 },
  la_liga: { name: "La Liga", hf: 1.30, avg: 1.25 },
  serie_a: { name: "Serie A", hf: 1.27, avg: 1.32 },
};

function poissonPMF(k: number, lam: number) {
  if (lam <= 0) return k === 0 ? 1 : 0;
  let logP = -lam + k * Math.log(lam);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function simMatch(lamH: number, lamA: number): [number, number] {
  // Fast Poisson sampling via inverse CDF
  const samplePoisson = (lam: number) => {
    const L = Math.exp(-lam);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  };
  return [samplePoisson(lamH), samplePoisson(lamA)];
}

const S = {
  page: { minHeight: "100dvh", padding: "16px 14px", background: "radial-gradient(ellipse at 50% 40%, #2a1810 0%, #1a0f0a 60%, #0d0705 100%)", color: "#ede4d4", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" } as React.CSSProperties,
  card: { background: "#0d070540", border: "1px solid #c4a26515", borderRadius: 10, padding: "14px", marginBottom: 10 } as React.CSSProperties,
  goldText: { background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" } as React.CSSProperties,
  label: { fontSize: 10, color: "#c4a26560", textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4 },
  small: { fontSize: 11, color: "#c4a26580" },
};

interface TeamData {
  name: string;
  xgPgH: number; xgaPgH: number; // home attack/defense per game
  xgPgA: number; xgaPgA: number; // away attack/defense per game
  currentPts: number;
  played: number;
}

interface SimResult {
  name: string;
  currentPts: number;
  avgPts: number;
  xPts: number;
  pChampion: number;
  pTop2: number;
  pTop6: number;
  pRelegation: number;
  p5th: number; p25th: number; p50th: number; p75th: number; p95th: number;
}

// ─── Season Simulator ───────────────────────────────────────────────

function simulateSeason(
  teams: TeamData[],
  fixtures: { home: number; away: number }[],
  avg: number, hf: number,
  numSims: number
): SimResult[] {
  const n = teams.length;
  const ptsTotals: number[][] = Array.from({ length: n }, () => []);
  const champCount = Array(n).fill(0);
  const top2Count = Array(n).fill(0);
  const top6Count = Array(n).fill(0);
  const relegationCount = Array(n).fill(0);

  for (let s = 0; s < numSims; s++) {
    const pts = teams.map(t => t.currentPts);

    for (const fix of fixtures) {
      const h = teams[fix.home], a = teams[fix.away];
      const lamH = avg * (h.xgPgH / avg) * (a.xgaPgA / avg) * hf;
      const lamA = avg * (a.xgPgA / avg) * (h.xgaPgH / avg);
      const [gH, gA] = simMatch(lamH, lamA);
      if (gH > gA) { pts[fix.home] += 3; }
      else if (gH === gA) { pts[fix.home] += 1; pts[fix.away] += 1; }
      else { pts[fix.away] += 3; }
    }

    // Sort by points for ranking
    const ranked = pts.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p);
    for (let r = 0; r < ranked.length; r++) {
      const idx = ranked[r].i;
      ptsTotals[idx].push(ranked[r].p);
      if (r === 0) champCount[idx]++;
      if (r < 2) top2Count[idx]++;
      if (r < 6) top6Count[idx]++;
      if (r >= ranked.length - 3) relegationCount[idx]++;
    }
  }

  return teams.map((t, i) => {
    const sorted = ptsTotals[i].sort((a, b) => a - b);
    return {
      name: t.name,
      currentPts: t.currentPts,
      avgPts: sorted.reduce((a, b) => a + b, 0) / numSims,
      xPts: t.currentPts, // will be set below
      pChampion: champCount[i] / numSims,
      pTop2: top2Count[i] / numSims,
      pTop6: top6Count[i] / numSims,
      pRelegation: relegationCount[i] / numSims,
      p5th: sorted[Math.floor(numSims * 0.05)],
      p25th: sorted[Math.floor(numSims * 0.25)],
      p50th: sorted[Math.floor(numSims * 0.50)],
      p75th: sorted[Math.floor(numSims * 0.75)],
      p95th: sorted[Math.floor(numSims * 0.95)],
    };
  }).sort((a, b) => b.avgPts - a.avgPts);
}

// ─── Bar Chart ──────────────────────────────────────────────────────

function ProbBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
      <span style={{ fontSize: 9, color: "#c4a26560", width: 24, textAlign: "right" }}>{label}</span>
      <div style={{ flex: 1, height: 12, background: "#0d0705", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(value * 100, 0.5)}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
      <span style={{ fontSize: 9, color: "#c4a26580", width: 32, textAlign: "right" }}>{(value * 100).toFixed(1)}%</span>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export default function SeasonSimPage() {
  const supabase = useMemo(() => createClient(), []);
  const [lg, setLg] = useState("bundesliga");
  const [matchdays, setMatchdays] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [simResult, setSimResult] = useState<SimResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [remainingPct, setRemainingPct] = useState("40");
  const ld = LEAGUES[lg];

  useEffect(() => {
    (async () => {
      setLoading(true);
      setSimResult(null);
      const { data } = await supabase.from("matchdays").select("*").eq("league", lg).order("created_at", { ascending: false });
      setMatchdays(data || []);
      setLoading(false);
    })();
  }, [lg]);

  // Extract team data from latest matchday
  const teamData = useMemo(() => {
    if (!matchdays.length) return [];
    const latest = matchdays[0];
    if (!latest?.data?.matches) return [];
    const teams: Record<string, TeamData> = {};
    for (const m of latest.data.matches) {
      const h = m.home, a = m.away;
      if (h?.name && h.xg_h8 > 0) {
        teams[h.name] = {
          name: h.name,
          xgPgH: h.xg_h8 / (h.games || 8), xgaPgH: h.xga_h8 / (h.games || 8),
          xgPgA: 0, xgaPgA: 0,
          currentPts: 0, played: 0,
        };
      }
      if (a?.name && a.xg_a8 > 0) {
        const existing = teams[a.name] || { name: a.name, xgPgH: ld.avg, xgaPgH: ld.avg, xgPgA: 0, xgaPgA: 0, currentPts: 0, played: 0 };
        existing.xgPgA = a.xg_a8 / (a.games || 8);
        existing.xgaPgA = a.xga_a8 / (a.games || 8);
        teams[a.name] = existing;
      }
    }
    // Fill missing away/home with league average
    Object.values(teams).forEach(t => {
      if (t.xgPgH === 0) { t.xgPgH = ld.avg; t.xgaPgH = ld.avg; }
      if (t.xgPgA === 0) { t.xgPgA = ld.avg; t.xgaPgA = ld.avg; }
    });
    return Object.values(teams);
  }, [matchdays, ld]);

  const runSim = () => {
    if (teamData.length < 4) return;
    setRunning(true);
    setTimeout(() => {
      // Generate full double round-robin (each team plays every other home & away)
      const allFixtures: { home: number; away: number }[] = [];
      for (let i = 0; i < teamData.length; i++) {
        for (let j = 0; j < teamData.length; j++) {
          if (i !== j) allFixtures.push({ home: i, away: j });
        }
      }
      // Proper Fisher-Yates shuffle (unbiased)
      for (let i = allFixtures.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allFixtures[i], allFixtures[j]] = [allFixtures[j], allFixtures[i]];
      }
      // Estimate remaining: full season = n*(n-1) fixtures, take proportional remainder
      // Each team should have roughly equal home/away splits in the remaining fixtures
      const totalPerSeason = teamData.length * (teamData.length - 1);
      const remainingCount = Math.floor(totalPerSeason * (parseInt(remainingPct) || 40) / 100);
      const remaining = allFixtures.slice(0, remainingCount);

      const result = simulateSeason(teamData, remaining, ld.avg, ld.hf, 5000);
      setSimResult(result);
      setRunning(false);
    }, 50);
  };

  return (
    <div style={S.page}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <a href="/" style={{ position: "absolute", left: 14, top: 14, color: "#c4a26560", textDecoration: "none", fontSize: 12 }}>← FODZE</a>
        <h1 style={{ ...S.goldText, fontSize: 16, fontFamily: "Georgia, serif", margin: 0 }}>SAISON-SIMULATION</h1>
        <div style={S.small}>xPts · 5.000 Monte Carlo Simulationen</div>
      </div>

      {/* League Selector */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", marginBottom: 12 }}>
        {Object.entries(LEAGUES).map(([k, v]) => (
          <button key={k} onClick={() => setLg(k)} style={{
            background: lg === k ? "#c4a26515" : "transparent",
            border: `1px solid ${lg === k ? "#c4a26540" : "#c4a26515"}`,
            color: lg === k ? "#d4b86a" : "#c4a26560",
            borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 10
          }}>{v.name}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#c4a26560" }}>Laden...</div>
      ) : teamData.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center" }}>
          <div style={{ color: "#c4a26560" }}>Keine xG-Daten für {ld.name} verfügbar.</div>
        </div>
      ) : (
        <>
          <div style={S.card}>
            <div style={{ fontSize: 12, color: "#c4a26580", marginBottom: 8 }}>
              {teamData.length} Teams geladen · Basis: letzte 8 Heim/Auswärtsspiele
            </div>
            <button onClick={runSim} disabled={running} style={{
              width: "100%", padding: "10px 0", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13,
              background: running ? "#c4a26530" : "linear-gradient(135deg, #a68940, #d4b86a, #f5e6b8, #d4b86a, #a68940)",
              color: running ? "#c4a26560" : "#1a0f0a",
            }}>
              {running ? "SIMULIERT..." : "▶ 5.000× SAISON SIMULIEREN"}
            </button>
          </div>

          {simResult && (
            <>
              {/* How it works */}
              <div style={{ ...S.card, background: "#c4a26508" }}>
                <div style={{ fontSize: 10, color: "#d4b86a", fontWeight: 600, marginBottom: 4 }}>Methodik</div>
                <div style={{ fontSize: 10, color: "#c4a26570", lineHeight: 1.5 }}>
                  Jede der 5.000 Simulationen spielt die verbleibenden Spiele per Poisson-Sampling
                  basierend auf den Dixon-Coles λ-Werten durch. Die Tabelle zeigt die Wahrscheinlichkeit
                  für Meisterschaft, Aufstieg (Top 2), Europa (Top 6) und Abstieg (letzte 3).
                </div>
              </div>

              {/* Results Table */}
              {simResult.map((r, idx) => (
                <div key={r.name} style={{
                  ...S.card,
                  borderColor: r.pChampion > 0.1 ? "#6aad5520" : r.pRelegation > 0.2 ? "#ad555520" : "#c4a26515"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div>
                      <span style={{ fontSize: 10, color: "#c4a26540", marginRight: 6 }}>#{idx + 1}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{r.name}</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ ...S.goldText, fontSize: 18, fontWeight: 700 }}>{r.avgPts.toFixed(0)}</span>
                      <span style={{ fontSize: 9, color: "#c4a26560", marginLeft: 4 }}>Ø Pts</span>
                    </div>
                  </div>

                  <div style={{ fontSize: 9, color: "#c4a26550", marginBottom: 6 }}>
                    Spannweite: {r.p5th}–{r.p95th} Pts · Median: {r.p50th} Pts
                  </div>

                  <ProbBar label="🏆" value={r.pChampion} color="#d4b86a" />
                  <ProbBar label="↑2" value={r.pTop2} color="#6aad55" />
                  <ProbBar label="EU" value={r.pTop6} color="#4a8aad" />
                  <ProbBar label="↓" value={r.pRelegation} color="#ad5555" />
                </div>
              ))}
            </>
          )}
        </>
      )}

      <div style={{ textAlign: "center", marginTop: 16, fontSize: 9, color: "#c4a26540" }}>
        FODZE · Monte Carlo · Dixon-Coles λ · Poisson Sampling · 5.000 Simulationen
      </div>
    </div>
  );
}
