"use client";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useApp } from "@/contexts/AppContext";
import AppShell from "@/components/layout/AppShell";
import BetHistoryShare from "@/components/performance/BetHistoryShare";
import LiveCalibration from "@/components/performance/LiveCalibration";
import ClvChart from "@/components/performance/ClvChart";
import CrossEngineBacktest from "@/components/performance/CrossEngineBacktest";
import { computeBetStats, computeClvStats } from "@/lib/bet-metrics";
import { color, fontSize, fontWeight, fontFamily, space, radius } from "@/styles/tokens";
import { text } from "@/styles/components";

const S = {
  card: { background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.md, padding: `${space[5]}px`, marginBottom: space[4] } as React.CSSProperties,
  goldText: { background: `linear-gradient(135deg, ${color.goldDark}, ${color.goldLight}, ${color.goldShine}, ${color.gold}, ${color.goldDark})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" } as React.CSSProperties,
  label: { ...text.label, marginBottom: space[2] } as React.CSSProperties,
  val: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, fontFamily: fontFamily.serif } as React.CSSProperties,
  small: { ...text.muted } as React.CSSProperties,
};

// ─── Backtest Results (from fodze_xg_backtest.py, 14,359 games 2017-2025) ───
const BACKTEST = {
  totalGames: 14359,
  oosGames: 1274,
  seasons: "2017–2025",
  leagues: "BL, PL, La Liga, Serie A, Ligue 1",
  brierModel: 0.6013,
  brierMarket: 0.6247,
  brierDelta: -0.0234,
  accuracy: 52.3,
  calError: 0.0047,
  calErrorOOS: 0.0188,
  bettingAvg: { bets: 312, wr: 53.8, roi: 2.15, clv: 0.0042 },
  bettingMax: { bets: 421, wr: 54.2, roi: 3.87, clv: 0.0068 },
  edgeThreshold: 3,
  kellyFraction: 0.25,
};

// ─── Simulated P&L data (cumulative ROI per 50-bet block, avg odds) ───
const PNL_DATA = [
  { bet: 0, roi: 0 },
  { bet: 25, roi: -1.2 },
  { bet: 50, roi: 0.8 },
  { bet: 75, roi: -0.5 },
  { bet: 100, roi: 1.4 },
  { bet: 125, roi: 0.3 },
  { bet: 150, roi: 2.8 },
  { bet: 175, roi: 1.9 },
  { bet: 200, roi: 3.5 },
  { bet: 225, roi: 2.1 },
  { bet: 250, roi: 4.2 },
  { bet: 275, roi: 3.8 },
  { bet: 312, roi: 2.15 },
];

// ─── SVG Chart Components ───

function CalibrationChart({ curves }: { curves: Record<string, number[]> | null }) {
  if (!curves) return <div style={S.small}>Kalibrierungskurven laden...</div>;

  const W = 320, H = 220, P = 30; // width, height, padding
  const markets = [
    { key: "H", label: "Heim", color: "#d4b86a" },
    { key: "D", label: "Remis", color: "#8b6914" },
    { key: "A", label: "Gast", color: "#a68940" },
    { key: "O25", label: "Ü2.5", color: "#6aad55" },
  ];

  const toX = (i: number) => P + (i / 100) * (W - 2 * P);
  const toY = (v: number) => H - P - v * (H - 2 * P);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 480 }}>
      {/* Grid */}
      {[0, 0.25, 0.5, 0.75, 1].map(v => (
        <g key={v}>
          <line x1={P} y1={toY(v)} x2={W - P} y2={toY(v)} stroke="#c4a26510" strokeWidth={0.5} />
          <text x={P - 4} y={toY(v) + 3} textAnchor="end" fontSize={7} fill="#c4a26540">{(v * 100).toFixed(0)}%</text>
        </g>
      ))}
      {[0, 0.25, 0.5, 0.75, 1].map(v => (
        <g key={`x${v}`}>
          <line x1={toX(v * 100)} y1={P} x2={toX(v * 100)} y2={H - P} stroke="#c4a26510" strokeWidth={0.5} />
          <text x={toX(v * 100)} y={H - P + 12} textAnchor="middle" fontSize={7} fill="#c4a26540">{(v * 100).toFixed(0)}%</text>
        </g>
      ))}

      {/* Perfect calibration line */}
      <line x1={P} y1={toY(0)} x2={W - P} y2={toY(1)} stroke="#c4a26520" strokeWidth={1} strokeDasharray="4 3" />
      <text x={W - P + 2} y={toY(1) + 3} fontSize={6} fill="#c4a26530">perfekt</text>

      {/* Calibration curves */}
      {markets.map(m => {
        const data = curves[m.key];
        if (!data || data.length < 101) return null;
        const points = data.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
        return (
          <g key={m.key}>
            <polyline points={points} fill="none" stroke={m.color} strokeWidth={1.5} opacity={0.8} />
          </g>
        );
      })}

      {/* Legend */}
      {markets.map((m, i) => (
        <g key={`leg-${m.key}`} transform={`translate(${P + 5 + i * 65}, ${P - 8})`}>
          <line x1={0} y1={0} x2={12} y2={0} stroke={m.color} strokeWidth={2} />
          <text x={15} y={3} fontSize={7} fill={m.color}>{m.label}</text>
        </g>
      ))}

      {/* Axis labels */}
      <text x={W / 2} y={H - 2} textAnchor="middle" fontSize={8} fill="#c4a26560">Modell-Vorhersage (raw)</text>
      <text x={4} y={H / 2} textAnchor="middle" fontSize={8} fill="#c4a26560" transform={`rotate(-90, 4, ${H / 2})`}>Kalibriert</text>
    </svg>
  );
}

function PnLChart() {
  const W = 320, H = 180, P = 35;
  const maxBet = Math.max(...PNL_DATA.map(d => d.bet));
  const minROI = Math.min(...PNL_DATA.map(d => d.roi));
  const maxROI = Math.max(...PNL_DATA.map(d => d.roi));
  const roiRange = maxROI - minROI || 1;

  const toX = (b: number) => P + (b / maxBet) * (W - 2 * P);
  const toY = (r: number) => H - P - ((r - minROI) / roiRange) * (H - 2 * P);

  const points = PNL_DATA.map(d => `${toX(d.bet)},${toY(d.roi)}`).join(" ");
  const areaPoints = `${toX(0)},${toY(0)} ` + points + ` ${toX(PNL_DATA[PNL_DATA.length - 1].bet)},${toY(0)}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 480 }}>
      {/* Zero line */}
      <line x1={P} y1={toY(0)} x2={W - P} y2={toY(0)} stroke="#c4a26530" strokeWidth={0.5} strokeDasharray="4 3" />
      <text x={P - 4} y={toY(0) + 3} textAnchor="end" fontSize={7} fill="#c4a26560">0%</text>

      {/* Grid */}
      {[-2, 2, 4].filter(v => v >= minROI && v <= maxROI).map(v => (
        <g key={v}>
          <line x1={P} y1={toY(v)} x2={W - P} y2={toY(v)} stroke="#c4a26510" strokeWidth={0.5} />
          <text x={P - 4} y={toY(v) + 3} textAnchor="end" fontSize={7} fill="#c4a26540">{v > 0 ? "+" : ""}{v}%</text>
        </g>
      ))}

      {/* X axis labels */}
      {[0, 100, 200, 312].map(b => (
        <text key={b} x={toX(b)} y={H - P + 12} textAnchor="middle" fontSize={7} fill="#c4a26540">{b}</text>
      ))}

      {/* Area fill */}
      <polygon points={areaPoints} fill="#d4b86a08" />

      {/* P&L line */}
      <polyline points={points} fill="none" stroke="#d4b86a" strokeWidth={2} />

      {/* End point */}
      <circle cx={toX(312)} cy={toY(2.15)} r={3} fill="#d4b86a" />
      <text x={toX(312) + 6} y={toY(2.15) + 3} fontSize={8} fill="#d4b86a" fontWeight={700}>+2.15%</text>

      {/* Labels */}
      <text x={W / 2} y={H - 2} textAnchor="middle" fontSize={8} fill="#c4a26560">Anzahl Wetten</text>
      <text x={6} y={H / 2} textAnchor="middle" fontSize={8} fill="#c4a26560" transform={`rotate(-90, 6, ${H / 2})`}>Kum. ROI</text>
    </svg>
  );
}

// ─── Stat Card ───
function Stat({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div style={{ textAlign: "center", flex: "1 1 80px", minWidth: 80 }}>
      <div style={S.label}>{label}</div>
      <div style={{ ...S.val, ...S.goldText }}>{value}</div>
      {sub && <div style={{ ...S.small, color: good ? "#6aad55" : good === false ? "#ad5555" : "#c4a26560" }}>{sub}</div>}
    </div>
  );
}

// ─── Grade Distribution Bar ───
function GradeBar() {
  const grades = [
    { label: "A", pct: 18, color: "#6aad55", desc: "Edge ≥ 8%" },
    { label: "B", pct: 24, color: "#8bbd65", desc: "Edge 5–8%" },
    { label: "C", pct: 31, color: "#c4a265", desc: "Edge 3–5%" },
    { label: "D", pct: 15, color: "#ad7755", desc: "Edge < 3%" },
    { label: "F", pct: 12, color: "#ad5555", desc: "Neg. EV" },
  ];
  return (
    <div>
      <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", height: 24, marginBottom: 6 }}>
        {grades.map(g => (
          <div key={g.label} style={{ flex: `${g.pct} 0 0`, background: g.color + "30", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: g.color }}>{g.label}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {grades.map(g => (
          <span key={g.label} style={{ fontSize: 9, color: g.color }}>{g.label}: {g.pct}% ({g.desc})</span>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ───
function LivePerformance() {
  const { userBets } = useApp();

  const stats = useMemo(() => computeBetStats(userBets), [userBets]);
  // Brier needs ≥5 settled observations with model_prob so early noise
  // doesn't anchor the display.
  const brier = useMemo(() => {
    const withProb = stats.settled.filter(b => b.model_prob && b.model_prob > 0);
    if (withProb.length < 5) return null;
    return (
      withProb.reduce((s, b) => {
        const actual = b.result === "won" ? 1 : 0;
        return s + ((b.model_prob || 0) - actual) ** 2;
      }, 0) / withProb.length
    );
  }, [stats.settled]);

  // Live CLV — only surfaces once the closing-odds cron has caught up on
  // settled bets. Before that, the card just stays hidden.
  const clvStats = useMemo(() => computeClvStats(userBets), [userBets]);

  const { settled, won, pnl, totalStake, roi, winRate, avgEdge } = stats;

  if (settled.length === 0) return (
    <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.md, padding: space[5], marginBottom: space[4], textAlign: "center" }}>
      <div style={{ fontSize: fontSize.sm, color: color.textMuted }}>Noch keine abgerechneten Wetten für Live-Performance</div>
    </div>
  );

  return (
    <div style={{ background: "linear-gradient(135deg, #5a8c4a08, #c4a26508)", border: "1px solid #6aad5520", borderRadius: radius.md, padding: space[5], marginBottom: space[4] }}>
      <div style={{ ...text.label, color: "#6aad55", marginBottom: 8 }}>LIVE PERFORMANCE</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 70, textAlign: "center" }}>
          <div style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, fontFamily: fontFamily.mono, color: pnl >= 0 ? "#6aad55" : "#c47070" }}>
            {pnl >= 0 ? "+" : ""}€{pnl.toFixed(0)}
          </div>
          <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>P&L</div>
        </div>
        <div style={{ flex: 1, minWidth: 70, textAlign: "center" }}>
          <div style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, fontFamily: fontFamily.mono, color: roi >= 0 ? "#6aad55" : "#c47070" }}>
            {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
          </div>
          <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>ROI</div>
        </div>
        <div style={{ flex: 1, minWidth: 70, textAlign: "center" }}>
          <div style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, fontFamily: fontFamily.mono, color: color.goldShine }}>
            {won.length}/{settled.length}
          </div>
          <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>{winRate.toFixed(0)}% Win</div>
        </div>
        {brier !== null && (
          <div style={{ flex: 1, minWidth: 70, textAlign: "center" }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, fontFamily: fontFamily.mono, color: brier < 0.25 ? "#6aad55" : color.goldShine }}>
              {brier.toFixed(4)}
            </div>
            <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>Brier</div>
          </div>
        )}
        {clvStats && (
          <div style={{ flex: 1, minWidth: 70, textAlign: "center" }}>
            <div style={{
              fontSize: fontSize.xl, fontWeight: fontWeight.bold, fontFamily: fontFamily.mono,
              color: clvStats.avgClv > 0 ? "#6aad55" : clvStats.avgClv < 0 ? "#c47070" : color.goldShine,
            }}>
              {clvStats.avgClv >= 0 ? "+" : ""}{clvStats.avgClv.toFixed(2)}%
            </div>
            <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>Ø CLV</div>
          </div>
        )}
      </div>
      <div style={{ fontSize: fontSize.xs, color: color.textFaint, marginTop: 8, textAlign: "center" }}>
        {settled.length} Wetten · Ø Edge {(avgEdge * 100).toFixed(1)}% · €{totalStake.toFixed(0)} Einsatz
        {clvStats && ` · CLV aus ${clvStats.count} Wetten`}
      </div>
    </div>
  );
}

export default function PerformancePage() {
  const [curves, setCurves] = useState<Record<string, number[]> | null>(null);
  const [tab, setTab] = useState<"overview" | "calibration" | "pnl" | "backtest">("overview");

  useEffect(() => {
    fetch("/calibration_curves.json")
      .then(r => r.json())
      .then(setCurves)
      .catch(() => {});
  }, []);

  return (
    <AppShell>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <h1 style={{ ...S.goldText, fontSize: 18, fontFamily: "Georgia, serif", margin: 0 }}>Modell-Performance</h1>
        <div style={S.small}>Dixon-Coles Bivariate Poisson · Dirichlet-ODIR Kalibrierung · v2 LightGBM Tweedie</div>
      </div>

      {/* Tab Bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, justifyContent: "center" }}>
        {(["overview", "calibration", "pnl", "backtest"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: tab === t ? "#c4a26515" : "transparent",
            border: `1px solid ${tab === t ? "#c4a26540" : "#c4a26515"}`,
            color: tab === t ? "#d4b86a" : "#c4a26560",
            borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 11, fontWeight: tab === t ? 600 : 400
          }}>
            {t === "overview" ? "Übersicht" : t === "calibration" ? "Kalibrierung" : t === "pnl" ? "P&L Simulation" : "Cross-Engine"}
          </button>
        ))}
      </div>

      {/* ═══ OVERVIEW TAB ═══ */}
      {tab === "overview" && (
        <>
          {/* Live post-match Backtest — links to /backtest which
              scores every captured prediction × outcome pair in real
              time (Brier/Log-Loss/Favorit-Hitrate per Engine). Distinct
              from the static backtest figures in the "Cross-Engine"
              tab below which come from the 2017-2025 historical run. */}
          <Link href="/backtest" style={{ textDecoration: "none" }}>
            <div style={{
              ...S.card,
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: `linear-gradient(135deg, ${color.value}15, ${color.goldMid}08)`,
              border: `1px solid ${color.value}35`,
              cursor: "pointer",
            }}>
              <div>
                <div style={{ color: color.gold, fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>
                  Post-Match Backtest →
                </div>
                <div style={{ ...S.small, marginTop: 2, fontSize: 10 }}>
                  Live-Scoring jedes Matches: Vorhersage × tatsächlicher Ausgang · Brier / Log-Loss pro Engine
                </div>
              </div>
              <div style={{ color: color.value, fontSize: 20 }}>→</div>
            </div>
          </Link>

          {/* Live Performance from actual bets */}
          <LivePerformance />

          {/* Live AI calibration from actual bets */}
          <LiveCalibration />

          {/* Live CLV trend from actual bets */}
          <ClvChart />

          {/* Past bets with share button */}
          <BetHistoryShare />

          {/* Training Info */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>
              Trainingsdaten <span style={{ fontSize: 9, color: "#c4a26560", fontWeight: 400 }}>— historischer Snapshot v7.0</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Stat label="Spiele" value={BACKTEST.totalGames.toLocaleString()} sub={BACKTEST.seasons} />
              <Stat label="OOS-Holdout" value={BACKTEST.oosGames.toLocaleString()} sub="2025/26 unseen" />
              <Stat label="Ligen" value="5" sub={BACKTEST.leagues} />
            </div>
            <div style={{ fontSize: 10, color: "#c4a26570", marginTop: 8, lineHeight: 1.5 }}>
              Aktuelle v2+Dirichlet Zahlen auf dem <strong style={{ color: "#d4b86a" }}>Cross-Engine</strong> Tab
              (6.691 OOT-Zeilen, 19 Ligen, Stand 2023-08-01 cutoff).
            </div>
          </div>

          {/* Model Quality */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>Modell-Qualität</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Stat label="Brier Score" value={BACKTEST.brierModel.toFixed(4)} sub={`Markt: ${BACKTEST.brierMarket} (Δ ${BACKTEST.brierDelta})`} good />
              <Stat label="Accuracy" value={`${BACKTEST.accuracy}%`} sub="1X2 Korrektrate" good />
              <Stat label="Cal. Error" value={BACKTEST.calError.toFixed(4)} sub={`OOS: ${BACKTEST.calErrorOOS}`} good />
            </div>
          </div>

          {/* What This Means */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 6 }}>Was bedeutet das?</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "#c4a26590" }}>
              <p style={{ margin: "0 0 8px" }}>
                <strong style={{ color: "#d4b86a" }}>Brier Score {BACKTEST.brierModel}</strong> — Unser Modell ist präziser als der Wettmarkt ({BACKTEST.brierMarket}).
                Ein niedrigerer Score = bessere Vorhersagen. Der Vorsprung von {Math.abs(BACKTEST.brierDelta).toFixed(4)} mag klein wirken, ist aber
                über {BACKTEST.totalGames.toLocaleString()} Spiele statistisch signifikant.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong style={{ color: "#d4b86a" }}>Calibration Error {BACKTEST.calError}</strong> — Wenn das Modell 30% sagt, passiert es tatsächlich ~30% der Zeit.
                Isotonische Regression korrigiert systematische Über-/Unterschätzungen.
              </p>
              <p style={{ margin: 0 }}>
                <strong style={{ color: "#d4b86a" }}>52.3% Accuracy</strong> — Klingt wenig, aber der Break-even bei Sportwetten liegt bei ~47-48% (wegen Buchmacher-Marge).
                Jedes Prozent darüber ist Profit.
              </p>
            </div>
          </div>

          {/* Grade Distribution */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>Grade-Verteilung (typischer Spieltag)</div>
            <GradeBar />
          </div>

          {/* Betting Simulation */}
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>Wett-Simulation (Edge ≥ {BACKTEST.edgeThreshold}%, ¼Kelly)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              <Stat label="Wetten" value={String(BACKTEST.bettingAvg.bets)} sub="Avg Odds" />
              <Stat label="Trefferquote" value={`${BACKTEST.bettingAvg.wr}%`} good />
              <Stat label="ROI" value={`+${BACKTEST.bettingAvg.roi}%`} sub="nach 312 Bets" good />
              <Stat label="CLV (Sim.)" value={`+${(BACKTEST.bettingAvg.clv * 100).toFixed(2)}%`} sub="Backtest, nicht live" good />
            </div>
            <div style={{ ...S.small, padding: "8px 10px", background: "#6aad5510", borderRadius: 6, border: "1px solid #6aad5520" }}>
              Bei Max Odds: {BACKTEST.bettingMax.bets} Wetten, {BACKTEST.bettingMax.wr}% Trefferquote, <strong style={{ color: "#6aad55" }}>+{BACKTEST.bettingMax.roi}% ROI</strong>
            </div>
          </div>
        </>
      )}

      {/* ═══ CALIBRATION TAB ═══ */}
      {tab === "calibration" && (
        <>
          <div style={{ ...S.card, background: "#c4a26508", borderColor: "#c4a26525" }}>
            <div style={{ fontSize: 11, color: "#c4a265", fontWeight: 600, marginBottom: 4 }}>Hinweis</div>
            <div style={{ fontSize: 11, color: "#c4a26590", lineHeight: 1.5 }}>
              Diese Kurven zeigen die <strong>Legacy-Isotonic-Kalibrierung</strong> aus v7.0.
              Live läuft seit dem letzten Deploy <strong style={{ color: "#d4b86a" }}>Dirichlet-ODIR per Liga-Cluster</strong>.
              ECE auf 6.691 OOT-Zeilen: 0,0049 (2,6× besser als roh). Details + Pro-Engine-Coverage auf dem <strong style={{ color: "#d4b86a" }}>Cross-Engine</strong> Tab.
            </div>
          </div>

          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>Isotonische Kalibrierungskurven (Legacy-Fallback)</div>
            <CalibrationChart curves={curves} />
            <div style={{ ...S.small, marginTop: 8 }}>
              Gestrichelte Linie = perfekte Kalibrierung (Vorhersage = Realität).
              Je näher eine Kurve an der Diagonale, desto besser kalibriert der Markt.
              Bleiben als Fallback geladen falls Dirichlet-JSON fehlt.
            </div>
          </div>

          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 6 }}>Wie Kalibrierung funktioniert</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "#c4a26590" }}>
              <p style={{ margin: "0 0 8px" }}>
                <strong style={{ color: "#d4b86a" }}>1. Raw Prediction</strong> — Dixon-Coles berechnet: Heim 45%, Remis 27%, Gast 28%
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong style={{ color: "#d4b86a" }}>2. Isotonische Regression</strong> — Vergleicht die Raw-Vorhersage mit 14.359 historischen Ergebnissen.
                Lernt: "Wenn das Modell 45% sagt, passiert es tatsächlich 42% der Zeit" → korrigiert auf 42%.
              </p>
              <p style={{ margin: 0 }}>
                <strong style={{ color: "#d4b86a" }}>3. Sicherheits-Clamps</strong> — Remis max 45% (zu wenig Trainingsdaten an den Extremen),
                Heim/Gast max 95% (kein Spiel ist 100% sicher).
              </p>
            </div>
          </div>

          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 6 }}>101-Punkt Lookup (Auszug)</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 10, color: "#c4a26580", borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>{["Raw %", "Heim", "Remis", "Gast", "Ü2.5"].map(h => (
                    <th key={h} style={{ padding: "4px 8px", borderBottom: "1px solid #c4a26520", textAlign: "right", color: "#c4a26560" }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {curves && [10, 20, 30, 40, 50, 60, 70, 80, 90].map(i => (
                    <tr key={i}>
                      <td style={{ padding: "3px 8px", textAlign: "right", color: "#d4b86a" }}>{i}%</td>
                      {["H", "D", "A", "O25"].map(k => (
                        <td key={k} style={{ padding: "3px 8px", textAlign: "right" }}>
                          {((curves[k]?.[i] ?? 0) * 100).toFixed(1)}%
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══ P&L TAB ═══ */}
      {tab === "pnl" && (
        <>
          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 8 }}>Kumulative ROI — ¼Kelly, Edge ≥ 3%, Avg Odds</div>
            <PnLChart />
            <div style={{ ...S.small, marginTop: 8 }}>
              Simulation basierend auf {BACKTEST.totalGames.toLocaleString()} Spielen ({BACKTEST.seasons}).
              Einsatz: ¼Kelly-Fraktion, gekappt bei 5% Bankroll. Nur Wetten mit Edge ≥ 3%.
            </div>
          </div>

          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 6 }}>Strategie-Vergleich</div>
            <table style={{ fontSize: 11, color: "#c4a26580", borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>{["Strategie", "Bets", "WR", "ROI", "CLV"].map(h => (
                  <th key={h} style={{ padding: "6px 8px", borderBottom: "1px solid #c4a26520", textAlign: "right", color: "#c4a26560" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: "5px 8px", color: "#d4b86a" }}>Avg Odds, Edge≥3%</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{BACKTEST.bettingAvg.bets}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{BACKTEST.bettingAvg.wr}%</td>
                  <td style={{ padding: "5px 8px", textAlign: "right", color: "#6aad55" }}>+{BACKTEST.bettingAvg.roi}%</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>+{(BACKTEST.bettingAvg.clv * 100).toFixed(2)}%</td>
                </tr>
                <tr>
                  <td style={{ padding: "5px 8px", color: "#d4b86a" }}>Max Odds, Edge≥3%</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{BACKTEST.bettingMax.bets}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{BACKTEST.bettingMax.wr}%</td>
                  <td style={{ padding: "5px 8px", textAlign: "right", color: "#6aad55", fontWeight: 700 }}>+{BACKTEST.bettingMax.roi}%</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>+{(BACKTEST.bettingMax.clv * 100).toFixed(2)}%</td>
                </tr>
                <tr>
                  <td style={{ padding: "5px 8px", color: "#ad5555" }}>Flat 1u, alle Spiele</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>14,359</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>—</td>
                  <td style={{ padding: "5px 8px", textAlign: "right", color: "#ad5555" }}>-4.8%</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>—</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={S.card}>
            <div style={{ ...S.label, marginBottom: 6 }}>Interpretation</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "#c4a26590" }}>
              <p style={{ margin: "0 0 8px" }}>
                <strong style={{ color: "#6aad55" }}>+2.15% ROI (Avg Odds)</strong> — Wer seit 2017 jede Value-Bet mit Edge ≥ 3% bei
                durchschnittlichen Buchmacherquoten gespielt hätte, wäre nach 312 Wetten 2.15% im Plus.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong style={{ color: "#6aad55" }}>+3.87% ROI (Max Odds)</strong> — Mit den besten verfügbaren Quoten (Odds-Vergleich) steigt der ROI auf 3.87%.
                Das zeigt: <em>Quote Shopping</em> ist genauso wichtig wie die Vorhersage selbst.
              </p>
              <p style={{ margin: 0 }}>
                <strong style={{ color: "#ad5555" }}>-4.8% Flat Betting</strong> — Blind auf alles wetten verliert 4.8% — die Buchmacher-Marge.
                Das Modell identifiziert die ~20% der Wetten, die diese Marge umkehren.
              </p>
            </div>
          </div>

          <div style={{ ...S.card, background: "#c4a26508", borderColor: "#c4a26525" }}>
            <div style={{ fontSize: 11, color: "#c4a265", fontWeight: 600, marginBottom: 4 }}>Disclaimer</div>
            <div style={{ fontSize: 10, color: "#c4a26570", lineHeight: 1.5 }}>
              Vergangene Performance ist keine Garantie für zukünftige Ergebnisse.
              Alle Simulationen basieren auf historischen Daten und optimierten Parametern.
              Echte Ergebnisse hängen von Quotenverfügbarkeit, Timing und Disziplin ab.
              Spiele verantwortungsvoll.
            </div>
          </div>
        </>
      )}

      {/* ═══ CROSS-ENGINE TAB ═══ */}
      {tab === "backtest" && <CrossEngineBacktest />}

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: 16 }}>
        <div style={{ fontSize: 9, color: "#c4a26540" }}>
          FODZE v7 · Dixon-Coles Bivariate Poisson (15×15) · v2 LightGBM Tweedie (21 Features, ρ=-0.053) · Dirichlet-ODIR per Liga-Cluster
        </div>
      </div>
    </AppShell>
  );
}
