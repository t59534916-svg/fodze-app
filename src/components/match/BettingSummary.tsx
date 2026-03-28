"use client";
import { predictYellowCards, getAsianHandicap } from "@/lib/dixon-coles";
import type { RawMatch, BetCalc, TopScorer } from "@/types/match";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const fair = (p: number) => p > 0 ? (1 / p).toFixed(2) : "—";

// Section header style
const sectionStyle = { fontSize: 9, fontWeight: 700 as const, color: "#d4b86a", letterSpacing: 0.8, marginBottom: 6, marginTop: 14 };
const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #c4a26508", fontSize: 12 };
const labelStyle = { color: "#ede4d4", fontWeight: 500 as const };
const probStyle = { color: "#c4a26580", fontFamily: "'SF Mono', monospace", fontSize: 11 };
const fairStyle = { color: "#c4a26560", fontFamily: "'SF Mono', monospace", fontSize: 11 };
const valueIndicator = { width: 5, height: 5, borderRadius: "50%", background: "#6aad55", marginLeft: 6, flexShrink: 0 as const };

export default function BettingSummary({ match, calc, league }: {
  match: RawMatch; calc: any; league?: string;
}) {
  if (!calc?.mk) return null;
  const mk = calc.mk;

  // 1X2 markets with fair odds
  const markets1x2 = [
    { label: "Heim", prob: mk.H, bet: calc.bets?.find((b: BetCalc) => b.label === "Heim" || b.label === "1") },
    { label: "Unent.", prob: mk.D, bet: calc.bets?.find((b: BetCalc) => b.label === "Unent." || b.label === "X") },
    { label: "Ausw.", prob: mk.A, bet: calc.bets?.find((b: BetCalc) => b.label === "Ausw." || b.label === "2") },
  ];

  // Goal markets
  const goalMarkets = [
    { label: "Ü2.5", prob: mk.O25, bet: calc.bets?.find((b: BetCalc) => b.label === "Ü2.5") },
    { label: "U2.5", prob: mk.U25 || (1 - mk.O25) },
    { label: "BTTS Ja", prob: mk.BY || mk.BTTS },
    { label: "BTTS Nein", prob: mk.BN || (mk.BY ? 1 - mk.BY : undefined) },
  ].filter(m => m.prob != null && m.prob > 0);

  // Asian Handicap
  let ahLines: { label: string; prob: number; fairOdds: number }[] = [];
  if (calc.enh?.matrix) {
    const ah = getAsianHandicap(calc.enh.matrix, "H");
    const relevantLines = ["-0.5", "-1", "-1.5", "-2"].filter(k => ah[k]);
    ahLines = relevantLines.slice(0, 3).map(k => ({
      label: `Heim ${k}`,
      prob: ah[k].P_Win,
      fairOdds: ah[k].Fair_Odds,
    }));
  }

  // Yellow cards
  const cards = predictYellowCards(match.referee, league);

  // Top scorers (optional)
  const scorers = match.top_scorers?.slice(0, 3);

  return (
    <div style={{
      background: "#c4a2650a", border: "1px solid #c4a26515", borderRadius: 10,
      padding: "12px 14px", marginBottom: 14,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#d4b86a", letterSpacing: 1, marginBottom: 10 }}>
        WETTÜBERSICHT
      </div>

      {/* ─── 1X2 ──────────────────────────────────────────── */}
      <div style={sectionStyle}>1X2</div>
      <div style={{ display: "flex", fontSize: 9, color: "#c4a26560", marginBottom: 4, justifyContent: "space-between" }}>
        <span style={{ flex: 1 }}>Markt</span>
        <span style={{ width: 55, textAlign: "right" }}>Modell</span>
        <span style={{ width: 50, textAlign: "right" }}>Fair</span>
        <span style={{ width: 50, textAlign: "right" }}>Markt</span>
        <span style={{ width: 16 }}></span>
      </div>
      {markets1x2.map(m => (
        <div key={m.label} style={{ ...rowStyle }}>
          <span style={{ ...labelStyle, flex: 1 }}>{m.label}</span>
          <span style={{ ...probStyle, width: 55, textAlign: "right" }}>{pc(m.prob)}</span>
          <span style={{ ...fairStyle, width: 50, textAlign: "right" }}>{fair(m.prob)}</span>
          <span style={{ ...probStyle, width: 50, textAlign: "right", color: m.bet?.quote ? "#ede4d4" : "#c4a26540" }}>
            {m.bet?.quote ? m.bet.quote.toFixed(2) : "—"}
          </span>
          {m.bet?.isValue ? <div style={valueIndicator} /> : <span style={{ width: 11 }} />}
        </div>
      ))}

      {/* ─── TORE ─────────────────────────────────────────── */}
      {goalMarkets.length > 0 && (
        <>
          <div style={sectionStyle}>TORE</div>
          {goalMarkets.map(m => (
            <div key={m.label} style={rowStyle}>
              <span style={{ ...labelStyle, flex: 1 }}>{m.label}</span>
              <span style={{ ...probStyle, width: 55, textAlign: "right" }}>{pc(m.prob!)}</span>
              <span style={{ ...fairStyle, width: 50, textAlign: "right" }}>{fair(m.prob!)}</span>
              <span style={{ width: 50 }} />
              {(m as any).bet?.isValue ? <div style={valueIndicator} /> : <span style={{ width: 11 }} />}
            </div>
          ))}
        </>
      )}

      {/* ─── HANDICAP ─────────────────────────────────────── */}
      {ahLines.length > 0 && (
        <>
          <div style={sectionStyle}>ASIAN HANDICAP</div>
          {ahLines.map(m => (
            <div key={m.label} style={rowStyle}>
              <span style={{ ...labelStyle, flex: 1 }}>{m.label}</span>
              <span style={{ ...probStyle, width: 55, textAlign: "right" }}>{pc(m.prob)}</span>
              <span style={{ ...fairStyle, width: 50, textAlign: "right" }}>{m.fairOdds.toFixed(2)}</span>
              <span style={{ width: 61 }} />
            </div>
          ))}
        </>
      )}

      {/* ─── GELBE KARTEN ─────────────────────────────────── */}
      <div style={sectionStyle}>GELBE KARTEN</div>
      <div style={{ display: "flex", gap: 12, fontSize: 11, marginBottom: 4 }}>
        <span style={{ color: "#ede4d4" }}>Ü3.5 <span style={{ color: "#d4b86a", fontWeight: 600 }}>{pc(cards.over35)}</span></span>
        <span style={{ color: "#ede4d4" }}>Ü4.5 <span style={{ color: "#c4a26580" }}>{pc(cards.over45)}</span></span>
        <span style={{ color: "#ede4d4" }}>Ü5.5 <span style={{ color: "#c4a26560" }}>{pc(cards.over55)}</span></span>
      </div>
      <div style={{ fontSize: 9, color: "#c4a26560" }}>
        {match.referee ? `${match.referee.split(",")[0]} · ` : ""}Ø {cards.expected.toFixed(1)} Karten/Spiel
      </div>

      {/* ─── TORSCHÜTZEN (optional) ───────────────────────── */}
      {scorers && scorers.length > 0 && (
        <>
          <div style={sectionStyle}>TORSCHÜTZEN (Top {scorers.length})</div>
          {scorers.map((s: TopScorer, i: number) => (
            <div key={i} style={{ ...rowStyle, borderBottom: i < scorers.length - 1 ? "1px solid #c4a26508" : "none" }}>
              <span style={{ color: "#d4b86a", fontWeight: 700, width: 16 }}>#{i + 1}</span>
              <span style={{ ...labelStyle, flex: 1 }}>
                {s.name} <span style={{ color: "#c4a26560", fontSize: 10 }}>({s.team === "H" ? match.home?.name?.split(" ").pop() : match.away?.name?.split(" ").pop()})</span>
              </span>
              <span style={{ ...probStyle, color: "#6aad55" }}>{pc(s.prob)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
