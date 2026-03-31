"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/contexts/AppContext";
import { ENGINES } from "@/lib/engine-registry";
import { useMatchday } from "@/hooks/useMatchday";
import { useBets } from "@/hooks/useBets";
import AppShell from "@/components/layout/AppShell";
import Kit from "@/components/shared/Kit";
import GoldButton from "@/components/shared/GoldButton";
import MatchCard from "@/components/match/MatchCard";
import MatchDetail from "@/components/match/MatchDetail";
import BetTracker from "@/components/matchday/BetTracker";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

const S = {
  card: { background: "#c4a26508", border: "1px solid #c4a26520", borderRadius: 10, padding: 14, marginBottom: 10 },
  outlineBtn: { background: "#c4a26510", border: "1px solid #c4a26530", borderRadius: 8, padding: "10px 16px", color: "#c4a265", cursor: "pointer", fontSize: 12 },
  goldText: { background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" },
};

export default function MatchdayPage() {
  const router = useRouter();
  const { effectiveBudget, bankroll, dayBudget, setDayBudget, league, engine, setEngine } = useApp();
  const {
    data, matches, processed, valueMatches, totalStake, topTips, comboLegs,
    oddsData, oddsHistory, saving, setOdds, handleSaveOdds, handleDelHist, loadCached,
  } = useMatchday();
  const { placingBet, handlePlaceBet } = useBets();

  const [selectedMatch, setSelectedMatch] = useState<number | null>(null);
  const [showTips, setShowTips] = useState(false);
  const [tipSort, setTipSort] = useState<"ev" | "conf">("ev");
  const br = effectiveBudget;

  // Auto-load cached matchday if no data
  useEffect(() => {
    if (!data) {
      loadCached().catch(() => {});
    }
  }, [data, loadCached]);

  if (!data) return (
    <AppShell>
      <div style={{ textAlign: "center", padding: "60px 20px" }}>
        <div style={{ fontSize: 36, marginBottom: 16 }}>⚽</div>
        <div style={{ fontSize: 14, color: "#c4a26560", marginBottom: 16 }}>Kein Spieltag geladen</div>
        <button onClick={() => router.push("/")} style={{ ...S.outlineBtn, fontSize: 13 }}>← Zur Startseite</button>
      </div>
    </AppShell>
  );

  const sortedTips = tipSort === "conf"
    ? [...topTips].sort((a, b) => {
        const confOrder: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
        return (confOrder[b.confidence] || 0) - (confOrder[a.confidence] || 0) || (b.ev || b.edge) - (a.ev || a.edge);
      })
    : topTips;

  return (
    <AppShell>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, ...S.goldText }}>{data?.league} — {data?.matchday}</div>
          <div style={{ fontSize: 10, color: "#c4a26560" }}>{matches.length} Spiele · {data?.data_confidence}</div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {br > 0 && (
            <div style={{ border: "1px solid #c4a26520", borderRadius: 6, padding: "3px 8px" }}>
              <label htmlFor="day-budget" style={{ fontSize: 8, color: "#8a7560" }}>BDG </label>
              <input id="day-budget" type="number" value={dayBudget} onChange={e => setDayBudget(e.target.value)} placeholder={String(bankroll || "—")}
                aria-label="Tagesbudget in Euro"
                style={{ background: "transparent", border: "none", width: 48, fontSize: 12, fontWeight: 600, color: "#d4b86a", padding: 0, textAlign: "right" }} />
            </div>
          )}
          <button onClick={() => router.push("/")} style={S.outlineBtn}>←</button>
        </div>
      </div>
      {/* Engine Toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: 12, background: "#c4a2650a", borderRadius: 8, border: "1px solid #c4a26515", overflow: "hidden" }}>
        {ENGINES.map(eng => {
          const active = engine === eng.id;
          return (
            <button key={eng.id} onClick={() => setEngine(eng.id)}
              style={{
                flex: 1, padding: "6px 10px", border: "none", cursor: "pointer",
                background: active ? "#d4b86a18" : "transparent",
                color: active ? "#d4b86a" : "#c4a26550",
                fontSize: 11, fontWeight: active ? 700 : 400,
                letterSpacing: active ? "0.3px" : "0",
                transition: "all 0.2s",
                borderRight: eng.id !== ENGINES[ENGINES.length - 1].id ? "1px solid #c4a26515" : "none",
              }}
            >
              {eng.name}
            </button>
          );
        })}
      </div>

      {/* Budget Bar */}
      {br > 0 && (
        <div style={{ ...S.card, padding: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 9, color: "#c4a26570" }}>
            <span>Einsatz €{totalStake.toFixed(0)}</span>
            <span style={{ color: "#6aad55" }}>Frei €{Math.max(0, br - totalStake).toFixed(0)}</span>
            <span style={{ color: totalStake / br > 0.15 ? "#c47070" : "#c4a265" }}>{pc(totalStake / br)}</span>
          </div>
          <div style={{ height: 3, borderRadius: 2, background: "#c4a26510" }}>
            <div style={{ height: "100%", borderRadius: 2, width: `${Math.min((totalStake / br) / 0.15 * 100, 100)}%`,
              background: totalStake / br > 0.15 ? "#c47070" : "linear-gradient(90deg, #a68940, #f5e6b8, #a68940)",
              backgroundSize: "200% 100%", animation: "goldShimmer 4s ease-in-out infinite", transition: "width 0.3s" }} />
          </div>
        </div>
      )}

      {/* Top 5 Tipps */}
      {sortedTips.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <button onClick={() => setShowTips(!showTips)} aria-expanded={showTips} aria-label={`Top ${sortedTips.length} Tipps ${showTips ? "ausblenden" : "anzeigen"}`}
            style={{ ...S.card, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
              background: "linear-gradient(135deg, #5a8c4a10, #c4a26508)", border: "1px solid #6aad5525" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14 }}>🏆</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#6aad55" }}>TOP {sortedTips.length} TIPPS</span>
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button onClick={e => { e.stopPropagation(); setTipSort("ev"); }}
                style={{ ...S.outlineBtn, fontSize: 9, padding: "2px 6px", background: tipSort === "ev" ? "#6aad5520" : "transparent", color: tipSort === "ev" ? "#6aad55" : "#c4a26570" }}>EV</button>
              <button onClick={e => { e.stopPropagation(); setTipSort("conf"); }}
                style={{ ...S.outlineBtn, fontSize: 9, padding: "2px 6px", background: tipSort === "conf" ? "#d4b86a20" : "transparent", color: tipSort === "conf" ? "#d4b86a" : "#c4a26570" }}>Konfidenz</button>
              <span style={{ color: "#c4a26535", fontSize: 14 }} aria-hidden="true">{showTips ? "▾" : "▸"}</span>
            </div>
          </button>
          {showTips && (
            <div style={{ ...S.card, marginTop: -1, borderTop: "none", borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
              {sortedTips.map((tip, ti) => {
                const confColor = tip.confidence === "HIGH" ? "#6aad55" : tip.confidence === "MEDIUM" ? "#d4b86a" : "#c4a265";
                return (
                  <div key={ti} onClick={() => { setSelectedMatch(tip.matchIdx); setShowTips(false); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", cursor: "pointer",
                      borderBottom: ti < sortedTips.length - 1 ? "1px solid #c4a26510" : "none" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#d4b86a", width: 16 }}>#{ti + 1}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                        <Kit team={tip.home} size={12} />
                        <span style={{ color: "#ede4d4" }}>{tip.home?.split(" ").pop()}</span>
                        <span style={{ color: "#c4a26530" }}>–</span>
                        <Kit team={tip.away} size={12} />
                        <span style={{ color: "#ede4d4" }}>{tip.away?.split(" ").pop()}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#c4a26570", marginTop: 2 }}>
                        {tip.label} · Edge {pe(tip.edge)} · Quote {tip.quote.toFixed(2)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, fontWeight: 600, background: confColor + "18", color: confColor }}>{tip.confidence}</div>
                      {br > 0 && <div style={{ fontSize: 10, color: "#6aad55", marginTop: 2 }}>€{(tip.kelly * br).toFixed(0)}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Match List */}
      <div style={S.card}>
        {processed.map((m: any, i: number) => {
          const isOpen = selectedMatch === i;
          return (
            <div key={i}>
              <MatchCard
                match={m} calc={m.calc} isOpen={isOpen}
                onClick={() => setSelectedMatch(isOpen ? null : i)}
              />
              {isOpen && (
                <div className="expand-in">
                <MatchDetail
                  match={m} calc={m.calc} idx={i}
                  odds={oddsData[i]} oddsHistory={oddsHistory[i] || []}
                  saving={saving === i}
                  onSetOdds={(f, v) => setOdds(i, f, v)}
                  onSaveOdds={() => handleSaveOdds(i)}
                  onDelHist={() => handleDelHist(i)}
                  onPlaceBet={handlePlaceBet}
                  placingBet={placingBet}
                  budget={br}
                  league={league}
                />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Value Summary */}
      {valueMatches.length > 0 && (
        <div style={{ ...S.card, background: "#5a8c4a10", border: "1px solid #6aad5520" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#6aad55" }}>{valueMatches.length} Value-Bet{valueMatches.length > 1 ? "s" : ""}</span>
            {br > 0 && <span style={{ fontSize: 11, color: "#6aad55" }}>€{totalStake.toFixed(0)} / €{br.toFixed(0)}</span>}
          </div>
          {valueMatches.map((m: any, mi: number) => (
            <div key={mi} style={{ fontSize: 11, color: "#6aad55aa", marginBottom: 2 }}>
              {m.home?.name} — {m.away?.name}: {m.calc.bets.filter((b: any) => b.isValue).map((b: any) => `${b.label} ${pe(b.edge)}${br > 0 ? ` €${(b.kelly * br).toFixed(0)}` : ""}`).join(", ")}
            </div>
          ))}
        </div>
      )}

      {/* Combo Builder Button */}
      {processed.some((m: any) => m.calc?.hasOdds) && (
        <GoldButton onClick={() => router.push("/matchday/combos")} style={{ marginBottom: 10 }}>
          KOMBI-BUILDER →
        </GoldButton>
      )}

      {/* Bet Tracker */}
      <BetTracker />

      <div style={{ fontSize: 9, color: "#c4a26520", textAlign: "center", marginTop: 14, letterSpacing: 0.5 }}>
        * vig-bereinigt · Sportwetten = Glücksspiel · spielen-mit-verantwortung.de
      </div>
    </AppShell>
  );
}
