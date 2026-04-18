"use client";
import { useRouter } from "next/navigation";
import { LEAGUES } from "@/lib/dixon-coles";
import { useApp } from "@/contexts/AppContext";
import { color } from "@/styles/tokens";

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

// Classifies how "fresh" a matchday date is.
// Today = HEUTE badge (gold pulse). Tomorrow = MORGEN. Future = no badge.
// Past = no badge (App shows the latest day that was seeded; a future
// refresh will overwrite it).
function dateProximity(iso: string): "today" | "tomorrow" | "future" | "past" {
  if (!iso) return "past";
  const d = new Date(iso + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays > 1) return "future";
  return "past";
}

export default function LeagueGrid({ onLoadLeague }: { onLoadLeague: (key: string) => void }) {
  const router = useRouter();
  const { league, setLeague, leagueStatus } = useApp();

  // Count leagues with data for Anna's Analysen tile
  const leaguesWithData = Object.keys(leagueStatus).length;

  const handleClick = (key: string) => {
    setLeague(key);
    if (leagueStatus[key]) {
      onLoadLeague(key);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, color: `${color.goldMid}70`, letterSpacing: 0.5, marginBottom: 10, fontWeight: 600 }}>LIGA WÄHLEN</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {Object.entries(LEAGUES).map(([key, val]) => {
          const info = leagueStatus[key];
          const hasData = !!info;
          const isSelected = league === key;
          const proximity = hasData ? dateProximity(info!.date) : "past";
          const showHeute = proximity === "today";
          const showMorgen = proximity === "tomorrow";
          return (
            <button key={key} onClick={() => handleClick(key)} className="league-tile"
              aria-label={`${val.name}${hasData ? ` — ${info!.label}${showHeute ? ", heute" : ""}` : " — Keine Daten"}`}
              aria-pressed={isSelected}
              style={{
                padding: "12px", borderRadius: 10, cursor: "pointer",
                minHeight: 72, width: "100%", textAlign: "left" as const,
                border: isSelected ? "1.5px solid #d4b86a" : showHeute ? "1.5px solid #d4b86a40" : "1px solid #c4a26515",
                background: isSelected ? `${color.goldMid}12` : "#0d070530",
                opacity: hasData ? 1 : 0.45,
                position: "relative",
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>{FLAG[key] || "⚽"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: color.text }}>{val.name}</div>
                  {hasData ? (
                    <div style={{ fontSize: 10, color: `${color.goldMid}70`, marginTop: 2 }}>
                      {info.label} · {formatDate(info.date)}
                    </div>
                  ) : (
                    <div style={{ fontSize: 10, color: `${color.goldMid}50`, marginTop: 2 }}>Keine Daten</div>
                  )}
                </div>
                {showHeute && (
                  <span style={{
                    fontSize: 8, fontWeight: 700, color: "#1a0f0a",
                    background: color.gold, padding: "2px 6px", borderRadius: 10,
                    letterSpacing: 0.5, flexShrink: 0,
                  }}>HEUTE</span>
                )}
                {showMorgen && (
                  <span style={{
                    fontSize: 8, fontWeight: 700, color: color.gold,
                    background: `${color.gold}20`, padding: "2px 6px", borderRadius: 10,
                    letterSpacing: 0.5, flexShrink: 0,
                    border: "1px solid #d4b86a40",
                  }}>MORGEN</span>
                )}
                {hasData && !showHeute && !showMorgen && (
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: color.value, flexShrink: 0 }} aria-hidden="true" />
                )}
              </div>
            </button>
          );
        })}

        {/* Anna's Analysen — Full Report Mode */}
        <button onClick={() => router.push("/fuck-betting")} className="league-tile"
          aria-label="Anna's Analysen — Vollständiger Analyse-Report"
          style={{
            padding: "12px", borderRadius: 10, cursor: "pointer",
            minHeight: 72, width: "100%", textAlign: "left" as const,
            gridColumn: "1 / -1",
            border: "1px solid #d4b86a30",
            background: "linear-gradient(135deg, #d4b86a08, #c4a26508)",
            opacity: leaguesWithData > 0 ? 1 : 0.45,
          }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/anna-avatar-1.jpg" alt="" width={32} height={32} style={{ borderRadius: "50%", objectFit: "cover", border: "1.5px solid #d4b86a40" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: color.gold }}>Anna&apos;s Analysen</div>
              <div style={{ fontSize: 10, color: color.textMuted, marginTop: 2 }}>
                {leaguesWithData > 0
                  ? `Alle Spiele · Voller Report · Ohne Quoten`
                  : "Keine Daten"}
              </div>
            </div>
            {leaguesWithData > 0 && <div style={{ fontSize: 10, color: color.gold, fontWeight: 600 }}>{leaguesWithData} Ligen</div>}
          </div>
        </button>
      </div>
    </div>
  );
}
