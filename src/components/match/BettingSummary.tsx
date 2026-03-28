"use client";
import { predictYellowCards, getAsianHandicap } from "@/lib/dixon-coles";
import type { RawMatch, BetCalc, TopScorer } from "@/types/match";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const fair = (p: number) => p > 0 ? (1 / p).toFixed(2) : "—";

// Styles
const sectionStyle = { fontSize: 9, fontWeight: 700 as const, color: "#d4b86a", letterSpacing: 0.8, marginBottom: 6, marginTop: 14 };
const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #c4a26508", fontSize: 12 };
const labelStyle = { color: "#ede4d4", fontWeight: 500 as const };
const probStyle = { color: "#c4a26580", fontFamily: "'SF Mono', monospace", fontSize: 11 };
const fairStyle = { color: "#c4a26560", fontFamily: "'SF Mono', monospace", fontSize: 11 };
const valueIndicator = { width: 5, height: 5, borderRadius: "50%", background: "#6aad55", marginLeft: 6, flexShrink: 0 as const };
const noDataStyle = { fontSize: 10, color: "#c4a26545", fontStyle: "italic" as const, padding: "4px 0" };

// ─── Confidence Check: is this prediction reliable? ──────────────────
// Compares internal consistency — if probabilities don't sum to ~1 or
// if xG data is missing/suspicious, mark as low confidence
function checkDataQuality(calc: any, match: RawMatch): {
  has1x2: boolean;
  hasGoals: boolean;
  hasMatrix: boolean;
  hasReferee: boolean;
  hasScorers: boolean;
  xgQuality: "good" | "weak" | "missing";
} {
  const h = match.home, a = match.away;
  const mk = calc?.mk;

  // Check xG data quality
  let xgQuality: "good" | "weak" | "missing" = "missing";
  if (h?.xg_h8 && a?.xg_a8) {
    const hPerGame = h.xg_h8 / (h.games || 8);
    const aPerGame = a.xg_a8 / (a.games || 8);
    // Suspicious: values too low (likely averages not sums) or too high
    if (hPerGame >= 0.5 && hPerGame <= 3.5 && aPerGame >= 0.5 && aPerGame <= 3.5) {
      xgQuality = "good";
    } else {
      xgQuality = "weak";
    }
  }

  // Check 1X2: probabilities must sum to ~1
  const has1x2 = mk && Math.abs(mk.H + mk.D + mk.A - 1) < 0.05;

  // Check goal markets exist
  const hasGoals = mk && mk.O25 > 0 && mk.O25 < 1;

  // Check matrix exists (needed for AH, CS, etc.)
  const hasMatrix = !!calc?.enh?.matrix;

  // Check referee data (needed for yellow cards)
  const hasReferee = !!(match.referee && match.referee.length > 2);

  // Check scorers
  const hasScorers = !!(match.top_scorers && match.top_scorers.length > 0);

  return { has1x2, hasGoals, hasMatrix, hasReferee, hasScorers, xgQuality };
}

function InsufficientData({ reason }: { reason: string }) {
  return (
    <div style={noDataStyle}>
      ⚠ {reason}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════

export default function BettingSummary({ match, calc, league }: {
  match: RawMatch; calc: any; league?: string;
}) {
  if (!calc?.mk) return null;
  const mk = calc.mk;
  const quality = checkDataQuality(calc, match);

  // ─── 1X2 ───────────────────────────────────────────────────────────
  const markets1x2 = quality.has1x2 ? [
    { label: "Heim", prob: mk.H, bet: calc.bets?.find((b: BetCalc) => b.label === "Heim" || b.label === "1") },
    { label: "Unent.", prob: mk.D, bet: calc.bets?.find((b: BetCalc) => b.label === "Unent." || b.label === "X") },
    { label: "Ausw.", prob: mk.A, bet: calc.bets?.find((b: BetCalc) => b.label === "Ausw." || b.label === "2") },
  ] : [];

  // ─── Goals ─────────────────────────────────────────────────────────
  const goalMarkets = quality.hasGoals ? [
    { label: "Ü2.5", prob: mk.O25, bet: calc.bets?.find((b: BetCalc) => b.label === "Ü2.5") },
    { label: "U2.5", prob: mk.U25 || (1 - mk.O25) },
    ...(mk.BY ? [
      { label: "BTTS Ja", prob: mk.BY },
      { label: "BTTS Nein", prob: mk.BN || (1 - mk.BY) },
    ] : []),
  ] : [];

  // ─── Asian Handicap (needs matrix) ─────────────────────────────────
  let ahLines: { label: string; prob: number; fairOdds: number }[] = [];
  if (quality.hasMatrix) {
    try {
      const ah = getAsianHandicap(calc.enh.matrix, "H");
      const relevantLines = ["-0.5", "-1", "-1.5", "-2"].filter(k => ah[k] && ah[k].P_Win > 0.05 && ah[k].P_Win < 0.95);
      ahLines = relevantLines.slice(0, 3).map(k => ({
        label: `Heim ${k}`,
        prob: ah[k].P_Win,
        fairOdds: ah[k].Fair_Odds,
      }));
    } catch { /* matrix computation failed — skip */ }
  }

  // ─── Yellow Cards (needs referee data) ─────────────────────────────
  let cards: { expected: number; over25: number; over35: number; over45: number; over55: number } | null = null;
  let cardsSource: "referee" | "league_avg" | null = null;
  if (quality.hasReferee) {
    // Parse referee string for card average
    const refMatch = match.referee!.match(/(\d+[.,]\d+)\s*(Karten|cards|card)/i);
    if (refMatch) {
      cards = predictYellowCards(match.referee, league);
      cardsSource = "referee";
    }
  }
  // Fallback: league average only if we have a known league
  if (!cards && league) {
    cards = predictYellowCards(undefined, league);
    cardsSource = "league_avg";
  }

  // ─── Top Scorers (only if admin-provided, never hallucinated) ──────
  const scorers = match.top_scorers?.slice(0, 3);

  return (
    <div style={{
      background: "#c4a2650a", border: "1px solid #c4a26515", borderRadius: 10,
      padding: "12px 14px", marginBottom: 14,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#d4b86a", letterSpacing: 1 }}>WETTÜBERSICHT</span>
        {quality.xgQuality === "weak" && (
          <span style={{ fontSize: 8, color: "#c47070", background: "#c4707012", padding: "2px 6px", borderRadius: 4 }}>xG-Daten unsicher</span>
        )}
      </div>

      {/* ═══ 1X2 ═══ */}
      <div style={sectionStyle}>1X2</div>
      {quality.has1x2 ? (
        <>
          <div style={{ display: "flex", fontSize: 9, color: "#c4a26560", marginBottom: 4, justifyContent: "space-between" }}>
            <span style={{ flex: 1 }}>Markt</span>
            <span style={{ width: 55, textAlign: "right" }}>Modell</span>
            <span style={{ width: 50, textAlign: "right" }}>Fair</span>
            <span style={{ width: 50, textAlign: "right" }}>Markt</span>
            <span style={{ width: 16 }}></span>
          </div>
          {markets1x2.map(m => (
            <div key={m.label} style={rowStyle}>
              <span style={{ ...labelStyle, flex: 1 }}>{m.label}</span>
              <span style={{ ...probStyle, width: 55, textAlign: "right" }}>{pc(m.prob)}</span>
              <span style={{ ...fairStyle, width: 50, textAlign: "right" }}>{fair(m.prob)}</span>
              <span style={{ ...probStyle, width: 50, textAlign: "right", color: m.bet?.quote ? "#ede4d4" : "#c4a26540" }}>
                {m.bet?.quote ? m.bet.quote.toFixed(2) : "—"}
              </span>
              {m.bet?.isValue ? <div style={valueIndicator} /> : <span style={{ width: 11 }} />}
            </div>
          ))}
        </>
      ) : (
        <InsufficientData reason="Nicht genug Daten für 1X2 Vorhersage" />
      )}

      {/* ═══ TORE ═══ */}
      <div style={sectionStyle}>TORE</div>
      {goalMarkets.length > 0 ? (
        goalMarkets.map(m => (
          <div key={m.label} style={rowStyle}>
            <span style={{ ...labelStyle, flex: 1 }}>{m.label}</span>
            <span style={{ ...probStyle, width: 55, textAlign: "right" }}>{pc(m.prob!)}</span>
            <span style={{ ...fairStyle, width: 50, textAlign: "right" }}>{fair(m.prob!)}</span>
            <span style={{ width: 50 }} />
            {(m as any).bet?.isValue ? <div style={valueIndicator} /> : <span style={{ width: 11 }} />}
          </div>
        ))
      ) : (
        <InsufficientData reason="Nicht genug Daten für Tor-Märkte" />
      )}

      {/* ═══ HANDICAP ═══ */}
      <div style={sectionStyle}>ASIAN HANDICAP</div>
      {ahLines.length > 0 ? (
        ahLines.map(m => (
          <div key={m.label} style={rowStyle}>
            <span style={{ ...labelStyle, flex: 1 }}>{m.label}</span>
            <span style={{ ...probStyle, width: 55, textAlign: "right" }}>{pc(m.prob)}</span>
            <span style={{ ...fairStyle, width: 50, textAlign: "right" }}>{m.fairOdds.toFixed(2)}</span>
            <span style={{ width: 61 }} />
          </div>
        ))
      ) : (
        <InsufficientData reason="Score-Matrix nicht verfügbar" />
      )}

      {/* ═══ GELBE KARTEN ═══ */}
      <div style={sectionStyle}>GELBE KARTEN</div>
      {cards ? (
        <>
          <div style={{ display: "flex", gap: 12, fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: "#ede4d4" }}>Ü3.5 <span style={{ color: "#d4b86a", fontWeight: 600 }}>{pc(cards.over35)}</span></span>
            <span style={{ color: "#ede4d4" }}>Ü4.5 <span style={{ color: "#c4a26580" }}>{pc(cards.over45)}</span></span>
            <span style={{ color: "#ede4d4" }}>Ü5.5 <span style={{ color: "#c4a26560" }}>{pc(cards.over55)}</span></span>
          </div>
          <div style={{ fontSize: 9, color: "#c4a26545" }}>
            {cardsSource === "referee" ? `${match.referee!.split(",")[0]} · ` : ""}
            Ø {cards.expected.toFixed(1)} Karten/Spiel
            {cardsSource === "league_avg" && " (Liga-Durchschnitt)"}
          </div>
        </>
      ) : (
        <InsufficientData reason="Keine Schiedsrichter-Daten verfügbar" />
      )}

      {/* ═══ TORSCHÜTZEN (nur wenn Admin-Daten vorhanden — NIE halluziniert) ═══ */}
      {quality.hasScorers && scorers && scorers.length > 0 ? (
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
      ) : null  /* Torschützen: komplett ausblenden wenn keine Admin-Daten — KEINE Schätzung */}
    </div>
  );
}
