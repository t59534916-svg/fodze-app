"use client";
import { useState, useEffect, useMemo } from "react";
import { createClient, loadLiveOdds } from "@/lib/supabase";

// ─── Inline Dixon-Coles (minimal, no TS imports needed) ──────────────

const RHO = -0.05, MAX_GOALS = 15;
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

function buildMatrix(lamH: number, lamA: number) {
  const mx = Array.from({ length: MAX_GOALS }, () => Array(MAX_GOALS).fill(0));
  for (let i = 0; i < MAX_GOALS; i++)
    for (let j = 0; j < MAX_GOALS; j++)
      mx[i][j] = poissonPMF(i, lamH) * poissonPMF(j, lamA);
  if (lamH > 0 && lamA > 0) {
    mx[0][0] *= Math.max(0, 1 - lamH * lamA * RHO);
    mx[1][0] *= Math.max(0, 1 + lamA * RHO);
    mx[0][1] *= Math.max(0, 1 + lamH * RHO);
    mx[1][1] *= Math.max(0, 1 - RHO);
  }
  let sum = 0;
  for (const row of mx) for (const v of row) sum += v;
  if (sum > 0) for (const row of mx) for (let j = 0; j < MAX_GOALS; j++) row[j] /= sum;
  return mx;
}

type Cond = (h: number, a: number) => boolean;

function query(mx: number[][], conds: Cond[]) {
  let p = 0;
  for (let i = 0; i < mx.length; i++)
    for (let j = 0; j < mx.length; j++)
      if (conds.every(c => c(i, j))) p += mx[i][j];
  return p;
}

// ─── SGP Combo Definitions ──────────────────────────────────────────

interface SGPCombo {
  label: string;
  legs: string[];
  conditions: Cond[];
  oddsEstimate: (bestH: number, bestD: number, bestA: number, bestO25: number, bestU25: number, bestBtts: number, bestO35: number) => number;
}

const SGP_COMBOS: SGPCombo[] = [
  {
    label: "Heim + Ü2.5",
    legs: ["1", "Ü2.5"],
    conditions: [(h, a) => h > a, (h, a) => h + a > 2],
    oddsEstimate: (H, _D, _A, O) => H * O * 0.88, // typical correlation penalty ~12%
  },
  {
    label: "Heim + U2.5",
    legs: ["1", "U2.5"],
    conditions: [(h, a) => h > a, (h, a) => h + a < 3],
    oddsEstimate: (H, _D, _A, _O, U) => H * U * 0.85,
  },
  {
    label: "Gast + Ü2.5",
    legs: ["2", "Ü2.5"],
    conditions: [(h, a) => h < a, (h, a) => h + a > 2],
    oddsEstimate: (_H, _D, A, O) => A * O * 0.88,
  },
  {
    label: "Gast + U2.5",
    legs: ["2", "U2.5"],
    conditions: [(h, a) => h < a, (h, a) => h + a < 3],
    oddsEstimate: (_H, _D, A, _O, U) => A * U * 0.85,
  },
  {
    label: "Remis + U2.5",
    legs: ["X", "U2.5"],
    conditions: [(h, a) => h === a, (h, a) => h + a < 3],
    oddsEstimate: (_H, D, _A, _O, U) => D * U * 0.82,
  },
  {
    label: "Heim + BTTS Ja",
    legs: ["1", "BTTS"],
    conditions: [(h, a) => h > a, (h, a) => h > 0 && a > 0],
    oddsEstimate: (H, _D, _A, _O, _U, BTTS) => H * BTTS * 0.85,
  },
  {
    label: "Gast + BTTS Ja",
    legs: ["2", "BTTS"],
    conditions: [(h, a) => h < a, (h, a) => h > 0 && a > 0],
    oddsEstimate: (_H, _D, A, _O, _U, BTTS) => A * BTTS * 0.85,
  },
  {
    label: "Heim + Ü3.5",
    legs: ["1", "Ü3.5"],
    conditions: [(h, a) => h > a, (h, a) => h + a > 3],
    oddsEstimate: (H, _D, _A, _O, _U, _B, O35) => H * O35 * 0.85,
  },
  {
    label: "Heim 2+ Tore + Ü2.5",
    legs: ["H≥2", "Ü2.5"],
    conditions: [(h) => h >= 2, (h, a) => h + a > 2],
    oddsEstimate: (H, _D, _A, O) => H * O * 0.82,
  },
  {
    label: "Heim zu Null",
    legs: ["1", "Gast=0"],
    conditions: [(h, a) => h > a, (_h, a) => a === 0],
    oddsEstimate: (H) => H * 2.2 * 0.80, // no standard market for clean sheets
  },
];

// ─── Styles ─────────────────────────────────────────────────────────

const S = {
  page: { minHeight: "100dvh", padding: "16px 14px", background: "radial-gradient(ellipse at 50% 40%, #2a1810 0%, #1a0f0a 60%, #0d0705 100%)", color: "#ede4d4", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" } as React.CSSProperties,
  card: { background: "#0d070540", border: "1px solid #c4a26515", borderRadius: 10, padding: "14px", marginBottom: 10 } as React.CSSProperties,
  goldText: { background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" } as React.CSSProperties,
  label: { fontSize: 10, color: "#c4a26560", textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4 },
  small: { fontSize: 11, color: "#c4a26580" },
};

function pe(v: number) { return (v * 100).toFixed(1) + "%"; }

// ─── Main Component ─────────────────────────────────────────────────

export default function SGPPage() {
  const supabase = useMemo(() => createClient(), []);
  const [lg, setLg] = useState("bundesliga");
  const [matchdays, setMatchdays] = useState<any>(null);
  const [liveOdds, setLiveOddsState] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const ld = LEAGUES[lg];

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: md } = await supabase.from("matchdays").select("*").eq("league", lg).order("created_at", { ascending: false }).limit(1).single();
      setMatchdays(md);
      const live = await loadLiveOdds(supabase, lg);
      setLiveOddsState(live);
      setLoading(false);
    })();
  }, [lg]);

  // ─── Scan for SGP Exploits ──────────────────────────────────────

  const exploits = useMemo(() => {
    if (!matchdays?.data?.matches || !liveOdds.length) return [];
    const results: any[] = [];

    for (const match of matchdays.data.matches) {
      const h = match.home, a = match.away;
      if (!h?.xg_h8 || !a?.xg_a8 || h.xg_h8 === 0) continue;

      // Calculate lambdas
      const hXGpg = h.xg_h8 / (h.games || 8);
      const hXGApg = h.xga_h8 / (h.games || 8);
      const aXGpg = a.xg_a8 / (a.games || 8);
      const aXGApg = a.xga_a8 / (a.games || 8);
      const lambdaH = ld.avg * (hXGpg / ld.avg) * (aXGApg / ld.avg) * ld.hf;
      const lambdaA = ld.avg * (aXGpg / ld.avg) * (hXGApg / ld.avg);

      const mx = buildMatrix(lambdaH, lambdaA);

      // Match with live odds
      const homeName = (h.name || "").toLowerCase();
      const awayName = (a.name || "").toLowerCase();
      const lo = liveOdds.find(o => {
        const oH = o.home_team.toLowerCase(), oA = o.away_team.toLowerCase();
        return (oH.includes(homeName) || homeName.includes(oH) ||
                oH.split(" ").some((w: string) => w.length > 3 && homeName.includes(w))) &&
               (oA.includes(awayName) || awayName.includes(oA) ||
                oA.split(" ").some((w: string) => w.length > 3 && awayName.includes(w)));
      });

      if (!lo || !lo.best_h) continue;

      // Scan all SGP combos
      for (const combo of SGP_COMBOS) {
        const pExact = query(mx, combo.conditions);
        if (pExact < 0.01) continue; // skip near-impossible combos

        // Estimate what bookmaker would offer
        const bkOdds = combo.oddsEstimate(
          lo.best_h, lo.best_d || 3.5, lo.best_a,
          lo.best_over25 || 1.9, lo.best_under25 || 1.9,
          lo.best_btts || 1.75,   // fallback if no BTTS market
          lo.best_over35 || 2.50  // fallback if no Ü3.5 market
        );
        if (bkOdds <= 1) continue;

        const pMarket = 1 / bkOdds;
        const edge = pExact - pMarket;

        // Also calculate naive independent probability for comparison
        const pNaive = combo.conditions.reduce((p, c) => p * query(mx, [c]), 1);
        const correlationEffect = pExact / pNaive - 1;

        results.push({
          home: h.name,
          away: a.name,
          combo: combo.label,
          legs: combo.legs,
          pExact,
          pNaive,
          correlationEffect,
          bkOdds,
          fairOdds: 1 / pExact,
          edge,
          isExploit: edge > 0.03,
          lambdaH,
          lambdaA,
          kickoff: lo.commence_time,
        });
      }
    }

    return results.sort((a, b) => b.edge - a.edge);
  }, [matchdays, liveOdds, ld]);

  const exploitCount = exploits.filter(e => e.isExploit).length;

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <a href="/" style={{ position: "absolute", left: 14, top: 14, color: "#c4a26560", textDecoration: "none", fontSize: 12 }}>← FODZE</a>
        <h1 style={{ ...S.goldText, fontSize: 16, fontFamily: "Georgia, serif", margin: 0 }}>SGP EXPLOIT SCANNER</h1>
        <div style={S.small}>Same-Game-Parlay · Exakte Dixon-Coles Matrix</div>
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
        <div style={{ textAlign: "center", padding: 40, color: "#c4a26560" }}>Scanning...</div>
      ) : exploits.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center" }}>
          <div style={{ color: "#c4a26560", fontSize: 13 }}>Keine Matchday-Daten oder Live-Odds für {ld.name} verfügbar.</div>
          <div style={{ ...S.small, marginTop: 8 }}>Lade zuerst Spieltagsdaten über die Hauptseite.</div>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ ...S.goldText, fontSize: 22, fontWeight: 700, fontFamily: "Georgia, serif" }}>{exploitCount}</span>
                <span style={{ fontSize: 12, color: "#c4a26580", marginLeft: 6 }}>Exploits gefunden</span>
              </div>
              <div style={{ fontSize: 10, color: "#6aad55", background: "#6aad5515", padding: "3px 8px", borderRadius: 4 }}>
                {exploits.length} Combos gescannt
              </div>
            </div>
          </div>

          {/* How it works */}
          <div style={{ ...S.card, background: "#c4a26508" }}>
            <div style={{ fontSize: 10, color: "#d4b86a", fontWeight: 600, marginBottom: 4 }}>Wie funktioniert der Scanner?</div>
            <div style={{ fontSize: 10, color: "#c4a26570", lineHeight: 1.5 }}>
              Buchmacher berechnen SGP-Quoten mit pauschalen Korrelations-Penalties (~12-18%).
              FODZE nutzt die exakte 15×15 Dixon-Coles Matrix um die wahre Joint-Wahrscheinlichkeit zu berechnen.
              Wenn der Buchmacher die Korrelation falsch einschätzt → Exploit.
            </div>
          </div>

          {/* Exploit List */}
          {exploits.filter(e => e.isExploit).map((e, idx) => (
            <div key={idx} style={{ ...S.card, borderColor: e.edge > 0.08 ? "#6aad5530" : "#c4a26520" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#ede4d4" }}>
                  {e.home} vs {e.away}
                </div>
                <div style={{
                  fontSize: 9, padding: "2px 6px", borderRadius: 4,
                  background: e.edge > 0.08 ? "#6aad5520" : "#c4a26515",
                  color: e.edge > 0.08 ? "#6aad55" : "#d4b86a", fontWeight: 600
                }}>
                  {e.edge > 0.08 ? "🟢 STARK" : "🔵 VALUE"}
                </div>
              </div>

              <div style={{ fontSize: 14, fontWeight: 700, ...S.goldText, marginBottom: 6 }}>{e.combo}</div>
              <div style={{ fontSize: 10, color: "#c4a26570", marginBottom: 4 }}>
                Legs: {e.legs.join(" + ")}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={S.label}>Exakte P</div>
                  <div style={{ fontSize: 16, fontWeight: 700, ...S.goldText }}>{pe(e.pExact)}</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={S.label}>Fair Odds</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#ede4d4" }}>{e.fairOdds.toFixed(2)}</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={S.label}>Edge</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#6aad55" }}>+{pe(e.edge)}</div>
                </div>
              </div>

              {/* Correlation Analysis */}
              <div style={{ fontSize: 10, padding: "6px 8px", background: "#0d070550", borderRadius: 6, marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#c4a26560" }}>Naive (unabhängig):</span>
                  <span style={{ color: "#c4a26580" }}>{pe(e.pNaive)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#c4a26560" }}>Matrix (korreliert):</span>
                  <span style={{ color: "#d4b86a", fontWeight: 600 }}>{pe(e.pExact)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#c4a26560" }}>Korrelations-Effekt:</span>
                  <span style={{ color: e.correlationEffect > 0 ? "#6aad55" : "#ad5555" }}>
                    {e.correlationEffect > 0 ? "+" : ""}{(e.correlationEffect * 100).toFixed(1)}%
                    {e.correlationEffect > 0 ? " (Boost)" : " (Penalty)"}
                  </span>
                </div>
              </div>

              <div style={{ fontSize: 9, color: "#c4a26550" }}>
                λH={e.lambdaH.toFixed(2)} λA={e.lambdaA.toFixed(2)} · BK Est. {e.bkOdds.toFixed(2)}
                {e.kickoff && ` · ${new Date(e.kickoff).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })}`}
              </div>
            </div>
          ))}

          {/* Non-exploits (collapsed) */}
          {exploits.filter(e => !e.isExploit).length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 11, color: "#c4a26560", cursor: "pointer", marginBottom: 8 }}>
                {exploits.filter(e => !e.isExploit).length} weitere Combos (kein Exploit)
              </summary>
              {exploits.filter(e => !e.isExploit).slice(0, 20).map((e, idx) => (
                <div key={idx} style={{ ...S.card, padding: 8, opacity: 0.6 }}>
                  <div style={{ fontSize: 11, color: "#c4a26580" }}>
                    {e.home} vs {e.away} · <b>{e.combo}</b> · P={pe(e.pExact)} · Edge {(e.edge * 100).toFixed(1)}%
                  </div>
                </div>
              ))}
            </details>
          )}
        </>
      )}

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: 16, fontSize: 9, color: "#c4a26540" }}>
        FODZE · 15×15 Dixon-Coles Matrix · Exakte Joint-Wahrscheinlichkeiten · Keine naive Multiplikation
      </div>
    </div>
  );
}
