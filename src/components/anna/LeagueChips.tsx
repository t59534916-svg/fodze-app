"use client";
import { useApp } from "@/contexts/AppContext";
import { LEAGUES } from "@/lib/dixon-coles";

const FLAG: Record<string, string> = {
  bundesliga: "🇩🇪", bundesliga2: "🇩🇪", liga3: "🇩🇪", epl: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  la_liga: "🇪🇸", serie_a: "🇮🇹", ligue_1: "🇫🇷", championship: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  eredivisie: "🇳🇱", cl: "🏆", el: "🏆",
};

export default function LeagueChips({ selected, onToggle, onConfirm }: {
  selected: Set<string>;
  onToggle: (key: string) => void;
  onConfirm: () => void;
}) {
  const { leagueStatus } = useApp();

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {Object.entries(LEAGUES).map(([key, val]) => {
          const hasData = !!leagueStatus[key];
          const isSelected = selected.has(key);
          return (
            <button key={key} onClick={() => hasData && onToggle(key)} disabled={!hasData}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 500,
                cursor: hasData ? "pointer" : "not-allowed",
                border: isSelected ? "1.5px solid #d4b86a" : "1px solid #c4a26520",
                background: isSelected ? "#d4b86a18" : "transparent",
                color: isSelected ? "#d4b86a" : hasData ? "#c4a26570" : "#c4a26530",
                opacity: hasData ? 1 : 0.4,
                transition: "all 0.15s",
              }}>
              <span style={{ fontSize: 14 }}>{FLAG[key] || "⚽"}</span>
              {val.name}
              {hasData && <span style={{ width: 5, height: 5, borderRadius: "50%", background: isSelected ? "#d4b86a" : "#6aad55" }} />}
            </button>
          );
        })}
      </div>
      {selected.size > 0 && (
        <button onClick={onConfirm} style={{
          width: "100%", padding: "10px 16px", borderRadius: 8, border: "none",
          background: "linear-gradient(135deg, #a68940, #d4b86a)", color: "#1a0f0a",
          fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}>
          {selected.size} Liga{selected.size > 1 ? "n" : ""} analysieren →
        </button>
      )}
    </div>
  );
}
