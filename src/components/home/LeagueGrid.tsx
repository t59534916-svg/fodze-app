"use client";
import { useRouter } from "next/navigation";
import { LEAGUES } from "@/lib/dixon-coles";
import { useApp } from "@/contexts/AppContext";

const FLAG: Record<string, string> = {
  bundesliga: "🇩🇪", bundesliga2: "🇩🇪", liga3: "🇩🇪", epl: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  la_liga: "🇪🇸", serie_a: "🇮🇹", ligue_1: "🇫🇷", championship: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  eredivisie: "🇳🇱", cl: "🏆", el: "🏆",
};

// Format ISO date to short German: "2026-04-04" → "Fr. 4.4."
function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso + "T12:00:00");
    const days = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
    return `${days[d.getDay()]}. ${d.getDate()}.${d.getMonth() + 1}.`;
  } catch { return iso; }
}

export default function LeagueGrid({ onLoadLeague }: { onLoadLeague: (key: string) => void }) {
  const router = useRouter();
  const { league, setLeague, leagueStatus } = useApp();

  // Count leagues with data for "Fuck Betting" tile
  const leaguesWithData = Object.keys(leagueStatus).length;

  const handleClick = (key: string) => {
    setLeague(key);
    if (leagueStatus[key]) {
      onLoadLeague(key);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, color: "#c4a26570", letterSpacing: 0.5, marginBottom: 10, fontWeight: 600 }}>LIGA WÄHLEN</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {Object.entries(LEAGUES).map(([key, val]) => {
          const info = leagueStatus[key];
          const hasData = !!info;
          const isSelected = league === key;
          return (
            <button key={key} onClick={() => handleClick(key)} className="league-tile"
              aria-label={`${val.name}${hasData ? ` — ${info!.label}` : " — Keine Daten"}`}
              aria-pressed={isSelected}
              style={{
                padding: "12px", borderRadius: 10, cursor: "pointer",
                minHeight: 72, width: "100%", textAlign: "left" as const,
                border: isSelected ? "1.5px solid #d4b86a" : "1px solid #c4a26515",
                background: isSelected ? "#c4a26512" : "#0d070530",
                opacity: hasData ? 1 : 0.45,
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>{FLAG[key] || "⚽"}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{val.name}</div>
                  {hasData ? (
                    <div style={{ fontSize: 10, color: "#c4a26570", marginTop: 2 }}>
                      {info.label} · {formatDate(info.date)}
                    </div>
                  ) : (
                    <div style={{ fontSize: 10, color: "#c4a26550", marginTop: 2 }}>Keine Daten</div>
                  )}
                </div>
                {hasData && <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#6aad55", flexShrink: 0 }} aria-hidden="true" />}
              </div>
            </button>
          );
        })}

        {/* Fuck Betting — Full Report Mode */}
        <button onClick={() => router.push("/fuck-betting")} className="league-tile"
          aria-label="Fuck Betting — Vollständiger Analyse-Report"
          style={{
            padding: "12px", borderRadius: 10, cursor: "pointer",
            minHeight: 72, width: "100%", textAlign: "left" as const,
            gridColumn: "1 / -1",
            border: "1px solid #e0707030",
            background: "linear-gradient(135deg, #e0707008, #c4a26508)",
            opacity: leaguesWithData > 0 ? 1 : 0.45,
          }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>F</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e07070" }}>Fuck Betting</div>
              <div style={{ fontSize: 10, color: "#a89070", marginTop: 2 }}>
                {leaguesWithData > 0
                  ? `Alle Spiele · Voller Report · Ohne Quoten`
                  : "Keine Daten"}
              </div>
            </div>
            {leaguesWithData > 0 && <div style={{ fontSize: 10, color: "#e07070", fontWeight: 600 }}>{leaguesWithData} Ligen</div>}
          </div>
        </button>
      </div>
    </div>
  );
}
