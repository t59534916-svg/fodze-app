"use client";
import { useState } from "react";
import { useBets } from "@/hooks/useBets";

const pc = (v: number) => (v * 100).toFixed(1) + "%";

export default function BetTracker() {
  const { userBets, settleBet } = useBets();
  const [showBets, setShowBets] = useState(false);

  if (userBets.length === 0) return null;

  const settled = userBets.filter((b: any) => b.result === "won" || b.result === "lost");
  const won = settled.filter((b: any) => b.result === "won");
  const pnl = settled.reduce((s: number, b: any) => s + (b.result === "won" ? (b.odds_placed - 1) * b.stake : -b.stake), 0);

  const handleExport = () => {
    const header = "Datum,Heim,Gast,Markt,Quote,Einsatz,Modell-%,Edge,Ergebnis,Gewinn/Verlust,CLV\n";
    const rows = userBets.map((b: any) => {
      const pl = b.result === "won" ? ((b.odds_placed - 1) * b.stake).toFixed(2) : b.result === "lost" ? (-b.stake).toFixed(2) : "0";
      return [
        b.placed_at?.slice(0, 10) || "", b.home_team || "", b.away_team || "",
        b.market || "", b.odds_placed || "", b.stake || "",
        b.model_prob ? (b.model_prob * 100).toFixed(1) : "", b.edge ? (b.edge * 100).toFixed(1) : "",
        b.result || "pending", pl, b.clv || ""
      ].map(v => `"${v}"`).join(",");
    }).join("\n");
    const blob = new Blob(["\uFEFF" + header + rows], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `fodze-bets-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };

  return (
    <div style={{ background: "#c4a26508", border: "1px solid #c4a26520", borderRadius: 10, padding: 14, marginBottom: 10 }}>
      <button onClick={() => setShowBets(!showBets)} aria-expanded={showBets} aria-label={`Wett-Tracker ${showBets ? "ausblenden" : "anzeigen"}`}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", width: "100%", background: "none", border: "none", padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13 }}>📊</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#d4b86a" }}>WETT-TRACKER</span>
          <span style={{ fontSize: 10, color: "#c4a26570" }}>({userBets.length} Wetten)</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {settled.length > 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, color: pnl >= 0 ? "#6aad55" : "#c47070" }}>
              {pnl >= 0 ? "+" : ""}€{pnl.toFixed(0)} ({won.length}/{settled.length})
            </span>
          )}
          <span style={{ color: "#c4a26535", fontSize: 14 }} aria-hidden="true">{showBets ? "▾" : "▸"}</span>
        </div>
      </button>
      {showBets && (
        <div style={{ marginTop: 8, borderTop: "1px solid #c4a26510", paddingTop: 8 }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            <button onClick={handleExport}
              style={{ fontSize: 9, padding: "3px 8px", border: "1px solid #c4a26530", borderRadius: 4, background: "#c4a26510", color: "#c4a265", cursor: "pointer" }}>
              📥 CSV Export
            </button>
          </div>
          {userBets.slice(0, 20).map((bet: any) => (
            <div key={bet.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderBottom: "1px solid #c4a26508", fontSize: 10 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%",
                background: bet.result === "won" ? "#6aad55" : bet.result === "lost" ? "#c47070" : "#c4a26560" }} />
              <div style={{ flex: 1 }}>
                <span style={{ color: "#ede4d4" }}>{bet.home_team?.split(" ").pop()} – {bet.away_team?.split(" ").pop()}</span>
                <span style={{ color: "#c4a26560" }}> · {bet.market} @ {parseFloat(bet.odds_placed).toFixed(2)}</span>
              </div>
              <span style={{ color: "#c4a26570" }}>€{parseFloat(bet.stake).toFixed(0)}</span>
              {bet.result === "pending" ? (
                <div style={{ display: "flex", gap: 2 }}>
                  <button onClick={() => settleBet(bet.id, "won")} aria-label="Gewonnen"
                    style={{ fontSize: 10, padding: "6px 10px", border: "1px solid #6aad5540", borderRadius: 6, background: "#6aad5510", color: "#6aad55", cursor: "pointer", fontWeight: 600, minWidth: 36, minHeight: 32 }}>W</button>
                  <button onClick={() => settleBet(bet.id, "lost")} aria-label="Verloren"
                    style={{ fontSize: 10, padding: "6px 10px", border: "1px solid #c4707040", borderRadius: 6, background: "#c4707010", color: "#c47070", cursor: "pointer", fontWeight: 600, minWidth: 36, minHeight: 32 }}>L</button>
                </div>
              ) : (
                <span style={{ fontSize: 9, fontWeight: 600, color: bet.result === "won" ? "#6aad55" : "#c47070" }}>
                  {bet.result === "won" ? `+€${((bet.odds_placed - 1) * bet.stake).toFixed(0)}` : `-€${parseFloat(bet.stake).toFixed(0)}`}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
