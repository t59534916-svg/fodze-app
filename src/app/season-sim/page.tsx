"use client";
import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase";

// ─── Inline engine (lightweight, no TS imports) ─────────────────────

const RHO = -0.05, MAX_GOALS = 15; // Full 15×15 matrix for accuracy
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
  input: { background: "#0d0705", border: "1px solid #c4a26525", borderRadius: 6, color: "#ede4d4", padding: "6px 8px", fontSize: 11, width: "100%" } as React.CSSProperties,
  textarea: { background: "#0d0705", border: "1px solid #c4a26525", borderRadius: 6, color: "#ede4d4", padding: "8px", fontSize: 10, width: "100%", fontFamily: "monospace", resize: "vertical" as const } as React.CSSProperties,
};

interface TeamData {
  name: string;
  xgPgH: number; xgaPgH: number; // home attack/defense per game
  xgPgA: number; xgaPgA: number; // away attack/defense per game
  currentPts: number;
  currentGD: number;
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

// ─── Balanced Round-Robin Generator ─────────────────────────────────
// Generates a proper balanced round-robin where each team plays every
// other team exactly once at home. No duplicate matchups.

function generateBalancedRoundRobin(teamCount: number): { home: number; away: number }[] {
  const fixtures: { home: number; away: number }[] = [];
  for (let i = 0; i < teamCount; i++) {
    for (let j = 0; j < teamCount; j++) {
      if (i !== j) fixtures.push({ home: i, away: j });
    }
  }
  return fixtures;
}

// ─── Parse user-pasted fixtures ─────────────────────────────────────
// Expected format: "HomeTeam - AwayTeam" per line

function parseFixtures(text: string, teams: TeamData[]): { home: number; away: number }[] | null {
  const nameToIdx: Record<string, number> = {};
  teams.forEach((t, i) => { nameToIdx[t.name.toLowerCase().trim()] = i; });

  const lines = text.trim().split("\n").filter(l => l.trim());
  if (lines.length === 0) return null;

  const fixtures: { home: number; away: number }[] = [];
  for (const line of lines) {
    // Support "Home - Away" or "Home vs Away" or "Home;Away"
    const parts = line.split(/\s*[-–—]\s*|\s+vs\.?\s+|;/).map(s => s.trim().toLowerCase());
    if (parts.length < 2) continue;
    const hIdx = nameToIdx[parts[0]];
    const aIdx = nameToIdx[parts[1]];
    if (hIdx !== undefined && aIdx !== undefined && hIdx !== aIdx) {
      fixtures.push({ home: hIdx, away: aIdx });
    }
  }
  return fixtures.length > 0 ? fixtures : null;
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
    const gd = teams.map(t => t.currentGD);

    for (const fix of fixtures) {
      const h = teams[fix.home], a = teams[fix.away];
      const lamH = avg * (h.xgPgH / avg) * (a.xgaPgA / avg) * hf;
      const lamA = avg * (a.xgPgA / avg) * (h.xgaPgH / avg);
      const [gH, gA] = simMatch(lamH, lamA);
      gd[fix.home] += gH - gA;
      gd[fix.away] += gA - gH;
      if (gH > gA) { pts[fix.home] += 3; }
      else if (gH === gA) { pts[fix.home] += 1; pts[fix.away] += 1; }
      else { pts[fix.away] += 3; }
    }

    // Sort by points, then goal difference for tiebreaking
    const ranked = pts.map((p, i) => ({ i, p, gd: gd[i] }))
      .sort((a, b) => b.p - a.p || b.gd - a.gd);
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
      xPts: t.currentPts,
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
  const [fixturesText, setFixturesText] = useState("");
  const [fixtureMode, setFixtureMode] = useState<"generated" | "custom">("generated");
  const [showStandings, setShowStandings] = useState(false);
  const ld = LEAGUES[lg];

  useEffect(() => {
    (async () => {
      setLoading(true);
      setSimResult(null);
      setFixturesText("");
      const { data } = await supabase.from("matchdays").select("*").eq("league", lg).order("created_at", { ascending: false });
      setMatchdays(data || []);
      setLoading(false);
    })();
  }, [lg]);

  // Extract team data from ALL matchdays (aggregate xG from multiple matchdays)
  const teamData = useMemo(() => {
    if (!matchdays.length) return [];
    const teams: Record<string, TeamData> = {};

    // Iterate over all matchdays to collect xG data for all teams
    for (const md of matchdays) {
      if (!md?.data?.matches) continue;
      for (const m of md.data.matches) {
        const h = m.home, a = m.away;
        if (h?.name && h.xg_h8 > 0 && !teams[h.name]) {
          teams[h.name] = {
            name: h.name,
            xgPgH: h.xg_h8 / (h.games || 8), xgaPgH: h.xga_h8 / (h.games || 8),
            xgPgA: 0, xgaPgA: 0,
            currentPts: 0, currentGD: 0, played: 0,
          };
        }
        if (a?.name && a.xg_a8 > 0 && !teams[a.name]) {
          teams[a.name] = {
            name: a.name, xgPgH: ld.avg, xgaPgH: ld.avg,
            xgPgA: a.xg_a8 / (a.games || 8), xgaPgA: a.xga_a8 / (a.games || 8),
            currentPts: 0, currentGD: 0, played: 0,
          };
        }
        // Fill in away data for home-only teams
        if (a?.name && a.xg_a8 > 0 && teams[a.name] && teams[a.name].xgPgA === 0) {
          teams[a.name].xgPgA = a.xg_a8 / (a.games || 8);
          teams[a.name].xgaPgA = a.xga_a8 / (a.games || 8);
        }
        // Fill in home data for away-only teams
        if (h?.name && h.xg_h8 > 0 && teams[h.name] && teams[h.name].xgPgH === 0) {
          teams[h.name].xgPgH = h.xg_h8 / (h.games || 8);
          teams[h.name].xgaPgH = h.xga_h8 / (h.games || 8);
        }
      }
    }
    // Fill missing away/home with league average
    Object.values(teams).forEach(t => {
      if (t.xgPgH === 0) { t.xgPgH = ld.avg; t.xgaPgH = ld.avg; }
      if (t.xgPgA === 0) { t.xgPgA = ld.avg; t.xgaPgA = ld.avg; }
    });
    return Object.values(teams).sort((a, b) => a.name.localeCompare(b.name));
  }, [matchdays, ld]);

  const updateTeamPts = (name: string, pts: number) => {
    const t = teamData.find(t => t.name === name);
    if (t) t.currentPts = pts;
  };

  const updateTeamGD = (name: string, gd: number) => {
    const t = teamData.find(t => t.name === name);
    if (t) t.currentGD = gd;
  };

  const runSim = () => {
    if (teamData.length < 4) return;
    setRunning(true);
    setTimeout(() => {
      let fixtures: { home: number; away: number }[];
      let usedCustom = false;

      if (fixtureMode === "custom" && fixturesText.trim()) {
        const parsed = parseFixtures(fixturesText, teamData);
        if (parsed && parsed.length > 0) {
          fixtures = parsed;
          usedCustom = true;
        } else {
          // Fallback to generated if parsing fails
          fixtures = generateBalancedRoundRobin(teamData.length);
        }
      } else {
        fixtures = generateBalancedRoundRobin(teamData.length);
      }

      const result = simulateSeason(teamData, fixtures, ld.avg, ld.hf, 5000);
      setSimResult(result);
      setFixtureMode(usedCustom ? "custom" : "generated");
      setRunning(false);
    }, 50);
  };

  return (
    <div style={S.page}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <a href="/" style={{ position: "absolute", left: 14, top: 14, color: "#c4a26560", textDecoration: "none", fontSize: 12 }}>&#8592; FODZE</a>
        <h1 style={{ ...S.goldText, fontSize: 16, fontFamily: "Georgia, serif", margin: 0 }}>SAISON-SIMULATION</h1>
        <div style={S.small}>xPts &middot; 5.000 Monte Carlo Simulationen</div>
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
          <div style={{ color: "#c4a26560" }}>Keine xG-Daten f&uuml;r {ld.name} verf&uuml;gbar.</div>
        </div>
      ) : (
        <>
          {/* Current Standings Input */}
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: "#c4a26580" }}>
                {teamData.length} Teams geladen &middot; Basis: alle verf&uuml;gbaren Spieltage
              </div>
              <button onClick={() => setShowStandings(!showStandings)} style={{
                background: "transparent", border: "1px solid #c4a26525", borderRadius: 4,
                color: "#c4a26580", cursor: "pointer", fontSize: 9, padding: "2px 8px"
              }}>{showStandings ? "Tabelle ausblenden" : "Aktuelle Tabelle eingeben"}</button>
            </div>

            {showStandings && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 6 }}>
                  Aktuelle Punkte und Tordifferenz eingeben (Standard: 0)
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px", gap: 4, alignItems: "center" }}>
                  <div style={{ fontSize: 9, color: "#c4a26550", fontWeight: 600 }}>Team</div>
                  <div style={{ fontSize: 9, color: "#c4a26550", fontWeight: 600, textAlign: "center" }}>Pts</div>
                  <div style={{ fontSize: 9, color: "#c4a26550", fontWeight: 600, textAlign: "center" }}>GD</div>
                  {teamData.map(t => (
                    <div key={t.name} style={{ display: "contents" }}>
                      <div style={{ fontSize: 10, color: "#ede4d4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                      <input type="number" defaultValue={t.currentPts} onChange={e => updateTeamPts(t.name, parseInt(e.target.value) || 0)}
                        style={{ ...S.input, width: 56, textAlign: "center", padding: "3px 4px" }} />
                      <input type="number" defaultValue={t.currentGD} onChange={e => updateTeamGD(t.name, parseInt(e.target.value) || 0)}
                        style={{ ...S.input, width: 56, textAlign: "center", padding: "3px 4px" }} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Fixture Input */}
          <div style={S.card}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <button onClick={() => setFixtureMode("generated")} style={{
                background: fixtureMode === "generated" ? "#c4a26515" : "transparent",
                border: `1px solid ${fixtureMode === "generated" ? "#c4a26540" : "#c4a26515"}`,
                color: fixtureMode === "generated" ? "#d4b86a" : "#c4a26560",
                borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 10, flex: 1,
              }}>Generierter Spielplan</button>
              <button onClick={() => setFixtureMode("custom")} style={{
                background: fixtureMode === "custom" ? "#c4a26515" : "transparent",
                border: `1px solid ${fixtureMode === "custom" ? "#c4a26540" : "#c4a26515"}`,
                color: fixtureMode === "custom" ? "#d4b86a" : "#c4a26560",
                borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 10, flex: 1,
              }}>Echte Restspiele eintragen</button>
            </div>

            {fixtureMode === "generated" ? (
              <div style={{ fontSize: 10, color: "#c4a26560", lineHeight: 1.5 }}>
                Vollst&auml;ndige Hin- und R&uuml;ckrunde (jedes Team spielt gegen jedes andere einmal heim und einmal ausw&auml;rts).
                Ergebnis ist eine faire Sch&auml;tzung der relativen Teamst&auml;rke.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 10, color: "#c4a26560", marginBottom: 6, lineHeight: 1.5 }}>
                  Verbleibende Spiele eintragen, ein Spiel pro Zeile:
                  <br /><span style={{ fontFamily: "monospace", color: "#d4b86a" }}>Heimteam - Auswärtsteam</span>
                </div>
                <textarea
                  value={fixturesText}
                  onChange={e => setFixturesText(e.target.value)}
                  rows={8}
                  placeholder={"Bayern München - Borussia Dortmund\nRB Leipzig - Bayer Leverkusen\n..."}
                  style={S.textarea}
                />
                {fixturesText.trim() && (
                  <div style={{ fontSize: 9, color: "#c4a26560", marginTop: 4 }}>
                    {(() => {
                      const parsed = parseFixtures(fixturesText, teamData);
                      return parsed ? `${parsed.length} Spiele erkannt` : "Keine g\u00fcltigen Spiele erkannt (Teamnamen m\u00fcssen exakt passen)";
                    })()}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Run Button */}
          <div style={S.card}>
            <button onClick={runSim} disabled={running} style={{
              width: "100%", padding: "10px 0", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13,
              background: running ? "#c4a26530" : "linear-gradient(135deg, #a68940, #d4b86a, #f5e6b8, #d4b86a, #a68940)",
              color: running ? "#c4a26560" : "#1a0f0a",
            }}>
              {running ? "SIMULIERT..." : "\u25B6 5.000\u00D7 SAISON SIMULIEREN"}
            </button>
          </div>

          {simResult && (
            <>
              {/* Simulation mode label */}
              <div style={{ ...S.card, background: fixtureMode === "custom" ? "#6aad5508" : "#c4a26508", borderColor: fixtureMode === "custom" ? "#6aad5520" : "#c4a26515" }}>
                <div style={{ fontSize: 10, fontWeight: 600, marginBottom: 4, color: fixtureMode === "custom" ? "#6aad55" : "#d4b86a" }}>
                  {fixtureMode === "custom" ? "Simulation mit echtem Spielplan" : "Simulation mit generiertem Spielplan"}
                </div>
                <div style={{ fontSize: 10, color: "#c4a26570", lineHeight: 1.5 }}>
                  {fixtureMode === "custom"
                    ? "Basierend auf den eingetragenen Restspielen. Ergebnisse spiegeln den tats\u00E4chlichen verbleibenden Spielplan wider."
                    : "Basierend auf einem generierten Round-Robin-Spielplan (Hin- und R\u00FCckrunde). Zeigt die relative Teamst\u00E4rke, nicht den realen Saisonverlauf."}
                  {" "}Jede der 5.000 Simulationen spielt die Spiele per Poisson-Sampling
                  basierend auf den Dixon-Coles &lambda;-Werten durch.
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
                      {r.currentPts > 0 && (
                        <span style={{ fontSize: 9, color: "#c4a26550", marginLeft: 6 }}>({r.currentPts} Pts aktuell)</span>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ ...S.goldText, fontSize: 18, fontWeight: 700 }}>{r.avgPts.toFixed(0)}</span>
                      <span style={{ fontSize: 9, color: "#c4a26560", marginLeft: 4 }}>&Oslash; Pts</span>
                    </div>
                  </div>

                  <div style={{ fontSize: 9, color: "#c4a26550", marginBottom: 6 }}>
                    Spannweite: {r.p5th}&ndash;{r.p95th} Pts &middot; Median: {r.p50th} Pts
                  </div>

                  <ProbBar label="M" value={r.pChampion} color="#d4b86a" />
                  <ProbBar label="T2" value={r.pTop2} color="#6aad55" />
                  <ProbBar label="EU" value={r.pTop6} color="#4a8aad" />
                  <ProbBar label="Ab" value={r.pRelegation} color="#ad5555" />
                </div>
              ))}
            </>
          )}
        </>
      )}

      <div style={{ textAlign: "center", marginTop: 16, fontSize: 9, color: "#c4a26540" }}>
        FODZE &middot; Monte Carlo &middot; Dixon-Coles &lambda; &middot; Poisson Sampling &middot; 5.000 Simulationen
      </div>
    </div>
  );
}
