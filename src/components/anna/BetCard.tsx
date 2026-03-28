"use client";

export interface BetSuggestion {
  type: "single" | "combo" | "system";
  label: string;
  legs: { match: string; market: string; odds: number; edge: number }[];
  systemType?: string;
  stake: number;
  expectedReturn: number;
  probability: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export default function BetCard({ bet }: { bet: BetSuggestion }) {
  const confColor = bet.confidence === "HIGH" ? "#6aad55" : bet.confidence === "MEDIUM" ? "#d4b86a" : "#c4a265";
  const typeLabel = bet.type === "single" ? "EINZELWETTE" : bet.type === "combo" ? "KOMBI" : `SYSTEM ${bet.systemType}`;
  const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

  return (
    <div style={{
      background: "#6aad5508", border: "1px solid #6aad5518", borderRadius: 10,
      padding: "12px 14px", marginBottom: 8,
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#6aad55", letterSpacing: 0.5 }}>{typeLabel}</span>
          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 600, background: confColor + "18", color: confColor }}>{bet.confidence}</span>
        </div>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#d4b86a" }}>€{bet.stake.toFixed(0)}</span>
      </div>

      {/* Legs */}
      {bet.legs.map((leg, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < bet.legs.length - 1 ? "1px solid #c4a26510" : "none", fontSize: 12 }}>
          <div>
            <span style={{ color: "#ede4d4", fontWeight: 500 }}>{leg.market}</span>
            <span style={{ color: "#c4a26560", marginLeft: 6 }}>{leg.match}</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ color: "#c4a26570" }}>@{leg.odds.toFixed(2)}</span>
            <span style={{ color: "#6aad55", fontWeight: 600, fontSize: 11 }}>{pe(leg.edge)}</span>
          </div>
        </div>
      ))}

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px solid #c4a26515", fontSize: 11 }}>
        <span style={{ color: "#c4a26570" }}>P(Gewinn): {(bet.probability * 100).toFixed(0)}%</span>
        <span style={{ color: "#6aad55", fontWeight: 600 }}>Erwartet: €{bet.expectedReturn.toFixed(0)}</span>
      </div>
    </div>
  );
}
