"use client";
// ═══════════════════════════════════════════════════════════════════════
// /simulator — Monte Carlo BANKROLL-growth simulator
//
// NOT a match-prediction page. The user supplies edge + average odds +
// Kelly fraction as INPUTS, and `runMonteCarlo` projects N bankroll
// trajectories from those parameters. There is no FODZE engine in scope:
// no MatchdayContext, no dixon-coles λ-build, no v2/v3/dev-03 dispatch.
//
// Reviewed for engine-duplication cleanup 2026-05-28: this page intentionally
// does not consume engine-registry.ts because its purpose is downstream of
// engine output — testing what bankroll trajectories look like GIVEN a
// stated edge, not computing the edge itself. Leave as-is.
// ═══════════════════════════════════════════════════════════════════════
import { useState, useMemo, useCallback } from "react";
import AppShell from "@/components/layout/AppShell";
import { color, fontSize, fontWeight, fontFamily, space, radius } from "@/styles/tokens";
import { text } from "@/styles/components";

const S = {
  card: { background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.md, padding: `${space[5]}px`, marginBottom: space[4] } as React.CSSProperties,
  goldText: { background: `linear-gradient(135deg, ${color.goldDark}, ${color.goldLight}, ${color.goldShine}, ${color.gold}, ${color.goldDark})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" } as React.CSSProperties,
  label: { ...text.label, marginBottom: space[2] } as React.CSSProperties,
  small: { ...text.muted } as React.CSSProperties,
  input: { background: color.leather, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: `${space[3]}px ${space[4]}px`, color: color.text, fontSize: fontSize.sm, width: "100%" } as React.CSSProperties,
};

// ─── Monte Carlo Engine ─────────────────────────────────────────────

interface SimConfig {
  bankroll: number;
  edge: number;       // average edge per bet (0.05 = 5%)
  avgOdds: number;    // average decimal odds
  kellyFrac: number;  // fraction of kelly (0.25 = quarter kelly)
  numBets: number;    // total bets to simulate
  numSims: number;    // number of simulations
}

function runSimulation(cfg: SimConfig): number[] {
  const { bankroll, edge, avgOdds, kellyFrac, numBets } = cfg;
  const pWin = (1 / avgOdds) + edge; // model probability
  const b = avgOdds - 1;
  const kellyFull = (b * pWin - (1 - pWin)) / b;
  const stake = Math.max(0, Math.min(kellyFull * kellyFrac, 0.05)); // capped at 5%

  const trajectory: number[] = [bankroll];
  let current = bankroll;

  for (let i = 0; i < numBets; i++) {
    const betAmount = current * stake;
    const won = Math.random() < pWin;
    current = won ? current + betAmount * b : current - betAmount;
    current = Math.max(0, current);
    trajectory.push(current);
  }

  return trajectory;
}

function runMonteCarlo(cfg: SimConfig): { trajectories: number[][]; stats: any } {
  const trajectories: number[][] = [];
  for (let i = 0; i < cfg.numSims; i++) {
    trajectories.push(runSimulation(cfg));
  }

  const finals = trajectories.map(t => t[t.length - 1]);
  finals.sort((a, b) => a - b);

  const profitable = finals.filter(f => f > cfg.bankroll).length;
  const busted = finals.filter(f => f <= 0).length;
  const median = finals[Math.floor(finals.length / 2)];
  const p5 = finals[Math.floor(finals.length * 0.05)];
  const p25 = finals[Math.floor(finals.length * 0.25)];
  const p75 = finals[Math.floor(finals.length * 0.75)];
  const p95 = finals[Math.floor(finals.length * 0.95)];
  const avg = finals.reduce((a, b) => a + b, 0) / finals.length;
  const maxDrawdown = trajectories.map(t => {
    let peak = t[0], maxDD = 0;
    for (const v of t) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, (peak - v) / peak); }
    return maxDD;
  });
  const avgMaxDD = maxDrawdown.reduce((a, b) => a + b, 0) / maxDrawdown.length;

  // Risk of Ruin: probability of losing X% of bankroll at any point
  const rorThresholds = [0.25, 0.50, 0.75, 1.0]; // 25%, 50%, 75%, 100%
  const rorProbs = rorThresholds.map(threshold => {
    const count = trajectories.filter(t => {
      const minVal = Math.min(...t);
      return minVal <= cfg.bankroll * (1 - threshold);
    }).length;
    return count / cfg.numSims;
  });

  // Drawdown duration: average number of bets spent below peak
  const ddDurations = trajectories.map(t => {
    let peak = t[0], ddBets = 0;
    for (const v of t) { peak = Math.max(peak, v); if (v < peak * 0.95) ddBets++; }
    return ddBets;
  });
  const avgDDDuration = ddDurations.reduce((a, b) => a + b, 0) / ddDurations.length;

  // Longest losing streak (consecutive losses)
  const longestStreaks = trajectories.map(t => {
    let streak = 0, maxStreak = 0;
    for (let i = 1; i < t.length; i++) {
      if (t[i] < t[i-1]) { streak++; maxStreak = Math.max(maxStreak, streak); }
      else { streak = 0; }
    }
    return maxStreak;
  });
  const avgLongestStreak = longestStreaks.reduce((a, b) => a + b, 0) / longestStreaks.length;

  return {
    trajectories: trajectories.slice(0, 50),
    stats: {
      profitable,
      profitablePct: profitable / cfg.numSims,
      busted,
      bustedPct: busted / cfg.numSims,
      median,
      avg,
      p5, p25, p75, p95,
      avgMaxDD,
      roi: (avg - cfg.bankroll) / cfg.bankroll,
      medianRoi: (median - cfg.bankroll) / cfg.bankroll,
      // Risk of Ruin additions
      rorProbs, // [p_lose25%, p_lose50%, p_lose75%, p_lose100%]
      avgDDDuration,
      avgLongestStreak,
    },
  };
}

// ─── SVG Chart ──────────────────────────────────────────────────────

function TrajectoryChart({ trajectories, bankroll, numBets }: { trajectories: number[][]; bankroll: number; numBets: number }) {
  const W = 360, H = 200, P = 35;

  const allVals = trajectories.flat();
  const maxVal = Math.max(...allVals, bankroll * 1.5);
  const minVal = Math.min(...allVals, 0);
  const range = maxVal - minVal || 1;

  const toX = (b: number) => P + (b / numBets) * (W - 2 * P);
  const toY = (v: number) => H - P - ((v - minVal) / range) * (H - 2 * P);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 520 }}>
      {/* Grid */}
      <line x1={P} y1={toY(bankroll)} x2={W - P} y2={toY(bankroll)} stroke="#c4a26530" strokeWidth={1} strokeDasharray="4 3" />
      <text x={P - 4} y={toY(bankroll) + 3} textAnchor="end" fontSize={7} fill="#c4a26560">Start</text>

      {/* Trajectories */}
      {trajectories.map((t, ti) => {
        const final = t[t.length - 1];
        const color = final > bankroll ? "#6aad55" : "#ad5555";
        const step = Math.max(1, Math.floor(t.length / 80));
        const pts = t.filter((_, i) => i % step === 0 || i === t.length - 1).map((v, i) => `${toX(i * step)},${toY(v)}`).join(" ");
        return <polyline key={ti} points={pts} fill="none" stroke={color} strokeWidth={0.5} opacity={0.15} />;
      })}

      {/* Median trajectory (thicker) */}
      {trajectories.length > 0 && (() => {
        const medianT: number[] = [];
        for (let i = 0; i <= numBets; i++) {
          const vals = trajectories.map(t => t[Math.min(i, t.length - 1)]).sort((a, b) => a - b);
          medianT.push(vals[Math.floor(vals.length / 2)]);
        }
        const step = Math.max(1, Math.floor(medianT.length / 80));
        const pts = medianT.filter((_, i) => i % step === 0 || i === medianT.length - 1).map((v, i) => `${toX(i * step)},${toY(v)}`).join(" ");
        return <polyline points={pts} fill="none" stroke="#d4b86a" strokeWidth={2} />;
      })()}

      {/* Axes */}
      <text x={W / 2} y={H - 2} textAnchor="middle" fontSize={8} fill="#c4a26560">Anzahl Wetten</text>
      {[0, Math.round(numBets / 2), numBets].map(b => (
        <text key={b} x={toX(b)} y={H - P + 12} textAnchor="middle" fontSize={7} fill="#c4a26540">{b}</text>
      ))}
    </svg>
  );
}

// ─── Distribution Chart ─────────────────────────────────────────────

function DistributionChart({ trajectories, bankroll }: { trajectories: number[][]; bankroll: number }) {
  const finals = trajectories.map(t => t[t.length - 1]).sort((a, b) => a - b);
  const W = 360, H = 120, P = 35;
  const bins = 30;
  const min = Math.min(...finals), max = Math.max(...finals);
  const binWidth = (max - min) / bins || 1;
  const counts = Array(bins).fill(0);
  for (const f of finals) {
    const bi = Math.min(Math.floor((f - min) / binWidth), bins - 1);
    counts[bi]++;
  }
  const maxCount = Math.max(...counts);
  const barW = (W - 2 * P) / bins;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 520 }}>
      {counts.map((c, i) => {
        const x = P + i * barW;
        const barH = (c / maxCount) * (H - 2 * P);
        const val = min + i * binWidth;
        const color = val >= bankroll ? "#6aad55" : "#ad5555";
        return <rect key={i} x={x} y={H - P - barH} width={barW - 1} height={barH} fill={color} opacity={0.4} />;
      })}
      {/* Break-even line */}
      {(() => {
        const range = max - min || 1;
        const beX = P + ((bankroll - min) / range) * (W - 2 * P);
        return <line x1={beX} y1={P} x2={beX} y2={H - P} stroke="#d4b86a" strokeWidth={1} strokeDasharray="3 2" />;
      })()}
      <text x={W / 2} y={H - 2} textAnchor="middle" fontSize={8} fill="#c4a26560">Endkapital (€)</text>
    </svg>
  );
}

// ─── Stat Card ──────────────────────────────────────────────────────

function Stat({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div style={{ textAlign: "center", flex: "1 1 70px", minWidth: 70 }}>
      <div style={S.label}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, ...S.goldText }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: good ? "#6aad55" : good === false ? "#ad5555" : "#c4a26560" }}>{sub}</div>}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export default function SimulatorPage() {
  const [bankroll, setBankroll] = useState("1000");
  const [edge, setEdge] = useState("5");
  const [avgOdds, setAvgOdds] = useState("2.10");
  const [kellyFrac, setKellyFrac] = useState("25");
  const [numBets, setNumBets] = useState("200");
  const [numSims, setNumSims] = useState("1000");
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);

  const runSim = useCallback(() => {
    setRunning(true);
    setTimeout(() => {
      const cfg: SimConfig = {
        bankroll: parseFloat(bankroll) || 1000,
        edge: (parseFloat(edge) || 5) / 100,
        avgOdds: parseFloat(avgOdds) || 2.1,
        kellyFrac: (parseFloat(kellyFrac) || 25) / 100,
        numBets: parseInt(numBets) || 200,
        numSims: parseInt(numSims) || 1000,
      };
      const r = runMonteCarlo(cfg);
      setResult(r);
      setRunning(false);
    }, 50);
  }, [bankroll, edge, avgOdds, kellyFrac, numBets, numSims]);

  const s = result?.stats;

  return (
    <AppShell>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <h1 style={{ ...S.goldText, fontSize: 16, fontFamily: "Georgia, serif", margin: 0 }}>MONTE CARLO SIMULATOR</h1>
        <div style={S.small}>Varianz & Drawdown · 1.000 Simulationen</div>
      </div>

      {/* Input Parameters */}
      <div style={S.card}>
        <div style={{ ...S.label, marginBottom: 8 }}>PARAMETER</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 2 }}>Bankroll (€)</div>
            <input value={bankroll} onChange={e => setBankroll(e.target.value)} type="number" style={S.input} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 2 }}>Ø Edge (%)</div>
            <input value={edge} onChange={e => setEdge(e.target.value)} type="number" step="0.5" style={S.input} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 2 }}>Ø Quote</div>
            <input value={avgOdds} onChange={e => setAvgOdds(e.target.value)} type="number" step="0.1" style={S.input} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 2 }}>Kelly-Fraktion (%)</div>
            <input value={kellyFrac} onChange={e => setKellyFrac(e.target.value)} type="number" style={S.input} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 2 }}>Anzahl Wetten</div>
            <input value={numBets} onChange={e => setNumBets(e.target.value)} type="number" style={S.input} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#c4a26560", marginBottom: 2 }}>Simulationen</div>
            <input value={numSims} onChange={e => setNumSims(e.target.value)} type="number" style={S.input} />
          </div>
        </div>

        <button onClick={runSim} disabled={running} style={{
          width: "100%", padding: "10px 0", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13,
          background: running ? "#c4a26530" : "linear-gradient(135deg, #a68940, #d4b86a, #f5e6b8, #d4b86a, #a68940)",
          color: running ? "#c4a26560" : "#1a0f0a",
        }}>
          {running ? "SIMULIERT..." : "▶ SIMULATION STARTEN"}
        </button>
      </div>

      {/* Presets */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          { label: "Konservativ", e: "3", o: "1.85", k: "25" },
          { label: "Moderat", e: "5", o: "2.10", k: "33" },
          { label: "Aggressiv", e: "8", o: "2.50", k: "50" },
          { label: "FODZE Default", e: "5", o: "2.15", k: "25" },
        ].map(p => (
          <button key={p.label} onClick={() => { setEdge(p.e); setAvgOdds(p.o); setKellyFrac(p.k); }} style={{
            background: "#c4a26510", border: "1px solid #c4a26520", color: "#c4a26580",
            borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 9
          }}>{p.label}</button>
        ))}
      </div>

      {/* Results */}
      {s && (
        <>
          {/* Key Stats */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>ERGEBNIS ({numSims} Simulationen)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Stat label="Profitabel" value={`${(s.profitablePct * 100).toFixed(0)}%`}
                sub={`${s.profitable} von ${numSims}`} good={s.profitablePct > 0.5} />
              <Stat label="Median ROI" value={`${s.medianRoi > 0 ? "+" : ""}${(s.medianRoi * 100).toFixed(1)}%`}
                good={s.medianRoi > 0} />
              <Stat label="Ø Drawdown" value={`${(s.avgMaxDD * 100).toFixed(0)}%`}
                sub="max. Rückgang" good={false} />
              <Stat label="Bust Rate" value={`${(s.bustedPct * 100).toFixed(1)}%`}
                sub={`${s.busted} Pleiten`} good={s.bustedPct < 0.01} />
            </div>
          </div>

          {/* Trajectory Chart */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>BANKROLL-VERLAUF (50 Pfade)</div>
            <TrajectoryChart trajectories={result.trajectories} bankroll={parseFloat(bankroll)} numBets={parseInt(numBets)} />
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 6 }}>
              <span style={{ fontSize: 9, color: "#d4b86a" }}>━ Median</span>
              <span style={{ fontSize: 9, color: "#6aad55" }}>━ Profit</span>
              <span style={{ fontSize: 9, color: "#ad5555" }}>━ Verlust</span>
            </div>
          </div>

          {/* Distribution */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>ENDKAPITAL-VERTEILUNG</div>
            <DistributionChart trajectories={result.trajectories} bankroll={parseFloat(bankroll)} />
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 6 }}>
              <span style={{ fontSize: 9, color: "#6aad55" }}>▓ Profit</span>
              <span style={{ fontSize: 9, color: "#ad5555" }}>▓ Verlust</span>
              <span style={{ fontSize: 9, color: "#d4b86a" }}>┊ Break-even</span>
            </div>
          </div>

          {/* Percentiles */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>PERZENTILE</div>
            <table style={{ width: "100%", fontSize: 11, color: "#c4a26580", borderCollapse: "collapse" }}>
              <tbody>
                {[
                  { label: "Worst Case (5%)", val: s.p5, color: "#ad5555" },
                  { label: "Pessimistisch (25%)", val: s.p25, color: "#c4a265" },
                  { label: "Median (50%)", val: s.median, color: "#d4b86a" },
                  { label: "Optimistisch (75%)", val: s.p75, color: "#6aad55" },
                  { label: "Best Case (95%)", val: s.p95, color: "#6aad55" },
                ].map(r => (
                  <tr key={r.label}>
                    <td style={{ padding: "4px 0", color: "#c4a26560" }}>{r.label}</td>
                    <td style={{ padding: "4px 0", textAlign: "right", fontWeight: 600, color: r.color }}>
                      €{r.val.toFixed(0)}
                      <span style={{ fontSize: 9, marginLeft: 4, opacity: 0.7 }}>
                        ({r.val > parseFloat(bankroll) ? "+" : ""}{((r.val - parseFloat(bankroll)) / parseFloat(bankroll) * 100).toFixed(0)}%)
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Risk of Ruin */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>RISK OF RUIN</div>
            <table style={{ width: "100%", fontSize: 11, color: "#c4a26580", borderCollapse: "collapse" }}>
              <tbody>
                {[
                  { label: "25% Bankroll verlieren", p: s.rorProbs[0], color: "#c4a265" },
                  { label: "50% Bankroll verlieren", p: s.rorProbs[1], color: "#ad7755" },
                  { label: "75% Bankroll verlieren", p: s.rorProbs[2], color: "#ad5555" },
                  { label: "Totalverlust (Bust)", p: s.rorProbs[3], color: "#ad3333" },
                ].map(r => (
                  <tr key={r.label}>
                    <td style={{ padding: "4px 0", color: "#c4a26560" }}>{r.label}</td>
                    <td style={{ padding: "4px 0", textAlign: "right" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                        <div style={{ width: 60, height: 8, background: "#0d0705", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${Math.max(r.p * 100, 1)}%`, height: "100%", background: r.color, borderRadius: 3 }} />
                        </div>
                        <span style={{ fontWeight: 600, color: r.color, minWidth: 40, textAlign: "right" }}>{(r.p * 100).toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 8, fontSize: 10, color: "#c4a26560", borderTop: "1px solid #c4a26515", paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
              <span>Ø Drawdown-Dauer: <b style={{color:"#c4a265"}}>{s.avgDDDuration.toFixed(0)} Wetten</b></span>
              <span>Ø längste Pechsträhne: <b style={{color:"#ad5555"}}>{s.avgLongestStreak.toFixed(0)} Verluste</b></span>
            </div>
          </div>

          {/* Interpretation */}
          <div style={{ ...S.card, background: "#c4a26508" }}>
            <div style={{ fontSize: 10, color: "#d4b86a", fontWeight: 600, marginBottom: 4 }}>Was bedeutet das?</div>
            <div style={{ fontSize: 11, color: "#c4a26570", lineHeight: 1.6 }}>
              {s.profitablePct >= 0.8 ? (
                <p style={{ margin: "0 0 6px" }}>
                  <strong style={{ color: "#6aad55" }}>Starke Strategie.</strong> In {(s.profitablePct * 100).toFixed(0)}% der Simulationen bist du nach {numBets} Wetten
                  im Plus. Der Median-ROI von {s.medianRoi > 0 ? "+" : ""}{(s.medianRoi * 100).toFixed(1)}% zeigt: die Strategie ist langfristig profitabel.
                </p>
              ) : s.profitablePct >= 0.5 ? (
                <p style={{ margin: "0 0 6px" }}>
                  <strong style={{ color: "#c4a265" }}>Marginal profitabel.</strong> In {(s.profitablePct * 100).toFixed(0)}% der Fälle profitabel — das ist ein schmaler Edge.
                  Erhöhe die Anzahl der Wetten oder den Edge um stabilere Ergebnisse zu erzielen.
                </p>
              ) : (
                <p style={{ margin: "0 0 6px" }}>
                  <strong style={{ color: "#ad5555" }}>Vorsicht.</strong> Nur {(s.profitablePct * 100).toFixed(0)}% der Simulationen sind profitabel.
                  Der Edge ist zu klein für diese Strategie. Reduziere den Kelly-Anteil oder suche höhere Edges.
                </p>
              )}
              <p style={{ margin: 0, fontSize: 10 }}>
                Erwarteter Max-Drawdown: <strong>{(s.avgMaxDD * 100).toFixed(0)}%</strong> — selbst mit profitabler Strategie
                wirst du Phasen erleben, in denen {(s.avgMaxDD * 100).toFixed(0)}% deiner Bankroll temporär verloren gehen.
                Das ist normal, nicht ein Zeichen dass das Modell versagt.
              </p>
            </div>
          </div>
        </>
      )}

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: 16, fontSize: 9, color: "#c4a26540" }}>
        FODZE · Monte Carlo · {numSims} Simulationen · ¼Kelly · Geometrische Verteilung
      </div>
    </AppShell>
  );
}
