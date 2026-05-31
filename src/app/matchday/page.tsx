"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/contexts/AppContext";
import { ENGINES } from "@/lib/engine-registry";
import { LEAGUES } from "@/lib/dixon-coles";
import { fuzzyTeamMatch } from "@/lib/team-resolver";
import { useMatchday } from "@/hooks/useMatchday";
import { useBets } from "@/hooks/useBets";
import AppShell from "@/components/layout/AppShell";
import Kit from "@/components/shared/Kit";
import GoldButton from "@/components/shared/GoldButton";
import MatchCard from "@/components/match/MatchCard";
import MatchDetail from "@/components/match/MatchDetail";
import BetTracker from "@/components/matchday/BetTracker";
import ManualBetForm from "@/components/matchday/ManualBetForm";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

// Static row — count-up/stagger animations were removed per user
// feedback ("visuals die nix nützen"). Numbers render final on mount.
function TipRow({ tip, ti, last, br, onSelect }: {
  tip: any; ti: number; last: boolean; br: number; onSelect: () => void;
}) {
  const confColor = tip.confidence === "HIGH" ? "#6aad55" : tip.confidence === "MEDIUM" ? "#d4b86a" : "#c4a265";
  return (
    <div onClick={onSelect}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "8px 0", cursor: "pointer",
        borderBottom: !last ? "1px solid #c4a26510" : "none",
      }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: "#d4b86a", width: 16 }}>#{ti + 1}</span>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
          <Kit team={tip.home} size={12} />
          <span style={{ color: "#ede4d4" }}>{tip.home?.split(" ").pop()}</span>
          <span style={{ color: "#c4a26530" }}>–</span>
          <Kit team={tip.away} size={12} />
          <span style={{ color: "#ede4d4" }}>{tip.away?.split(" ").pop()}</span>
        </div>
        <div style={{ fontSize: 10, color: "#a89070", marginTop: 2 }}>
          {tip.label} · Edge {pe(tip.edge)} · Quote {tip.quote.toFixed(2)}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, fontWeight: 600, background: confColor + "18", color: confColor }}>{tip.confidence}</div>
        {br > 0 && <div style={{ fontSize: 10, color: "#6aad55", marginTop: 2 }}>€{(tip.kelly * br).toFixed(0)}</div>}
      </div>
    </div>
  );
}

const S = {
  card: { background: "#c4a26508", border: "1px solid #c4a26520", borderRadius: 10, padding: 14, marginBottom: 10 },
  outlineBtn: { background: "#c4a26510", border: "1px solid #c4a26530", borderRadius: 8, padding: "10px 16px", color: "#c4a265", cursor: "pointer", fontSize: 12 },
  goldText: { background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" },
};

export default function MatchdayPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { effectiveBudget, bankroll, dayBudget, setDayBudget, league, setLeague, engine, setEngine } = useApp();
  const {
    data, matches, processed, valueMatches, totalStake, topTips, comboLegs,
    convictionPicks, convictionHitFloor,
    oddsData, oddsHistory, saving, setOdds, handleSaveOdds, handleDelHist, loadCached,
  } = useMatchday();
  const { placingBet, handlePlaceBet } = useBets();

  const [selectedMatch, setSelectedMatch] = useState<number | null>(null);
  const [showTips, setShowTips] = useState(false);
  const [tipSort, setTipSort] = useState<"ev" | "conf">("ev");
  const br = effectiveBudget;

  // Deep-link from /goldilocks: ?league=X&home=Y&away=Z
  // Runs once per unique searchParams — forces the right league to load even
  // before React propagates the context update.
  const deepLinkHandledRef = useRef<string | null>(null);
  useEffect(() => {
    const qpLeague = searchParams.get("league");
    if (!qpLeague) return;
    const key = `${qpLeague}|${searchParams.get("home") || ""}|${searchParams.get("away") || ""}`;
    if (deepLinkHandledRef.current === key) return;
    deepLinkHandledRef.current = key;
    if (qpLeague !== league) setLeague(qpLeague);
    loadCached(qpLeague).catch(() => {});
  }, [searchParams, league, setLeague, loadCached]);

  // Auto-load cached matchday if no data (and no deep-link is driving load)
  useEffect(() => {
    if (!data && !searchParams.get("league")) {
      loadCached().catch(() => {});
    }
  }, [data, loadCached, searchParams]);

  // Preselect + scroll to the deep-linked match once `processed` populates.
  // Goldilocks sources teams from `live_odds.*` while matchday uses
  // `matchdays.data.matches[].home.name` — conventions may differ, so we
  // fall back to the shared `fuzzyTeamMatch` resolver.
  const preselectDoneRef = useRef(false);
  useEffect(() => {
    if (preselectDoneRef.current) return;
    const qpHome = searchParams.get("home");
    const qpAway = searchParams.get("away");
    if (!qpHome || !qpAway || processed.length === 0) return;

    const idx = processed.findIndex((m) =>
      fuzzyTeamMatch(m.home?.name || "", qpHome) &&
      fuzzyTeamMatch(m.away?.name || "", qpAway),
    );
    if (idx >= 0) {
      preselectDoneRef.current = true;
      setSelectedMatch(idx);
      // Defer scroll until the expanded card is in the DOM
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-match-idx="${idx}"]`);
        (el as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [processed, searchParams]);

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
          <div style={{ fontSize: 15, fontWeight: 600, ...S.goldText }}>{(data?.league && LEAGUES[data.league]?.name) || data?.league} — {data?.matchday}</div>
          <div style={{ fontSize: 10, color: "#c4a26560" }}>
            {matches.length} Spiele{data?.data_confidence ? ` · ${data.data_confidence}` : ""}
            {(data as any)?.last_updated ? ` · Update: ${(data as any).last_updated}` : ""}
          </div>
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
          const isPreview = eng.preview === true;
          return (
            <button key={eng.id} onClick={() => setEngine(eng.id)}
              title={isPreview ? `${eng.description} — noch nicht trainiert, fällt auf Standard zurück` : eng.description}
              style={{
                flex: 1, padding: "10px 10px", border: "none", cursor: "pointer", minHeight: 44,
                position: "relative",
                background: active ? "#d4b86a18" : "transparent",
                color: active ? "#d4b86a" : isPreview ? "#a8907050" : "#a89070",
                fontSize: 11, fontWeight: active ? 700 : 400,
                letterSpacing: active ? "0.3px" : "0",
                transition: "all 0.2s",
                borderRight: eng.id !== ENGINES[ENGINES.length - 1].id ? "1px solid #c4a26515" : "none",
              }}
            >
              {eng.name}
              {isPreview && (
                <span aria-label="Preview — noch nicht trainiert" style={{
                  position: "absolute", top: 2, right: 4, fontSize: 7,
                  color: "#c4a26590", fontWeight: 600, letterSpacing: "0.5px",
                }}>PREVIEW</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Budget Bar */}
      {br > 0 && (
        <div style={{ ...S.card, padding: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 9, color: "#a89070" }}>
            <span>Einsatz €{totalStake.toFixed(0)}</span>
            <span style={{ color: "#6aad55" }}>Frei €{Math.max(0, br - totalStake).toFixed(0)}</span>
            <span style={{ color: totalStake / br > 0.15 ? "#c47070" : "#c4a265" }}>{pc(totalStake / br)}</span>
          </div>
          <div style={{ height: 3, borderRadius: 2, background: "#c4a26510" }}>
            <div style={{ height: "100%", borderRadius: 2, width: `${Math.min((totalStake / br) / 0.15 * 100, 100)}%`,
              backgroundColor: totalStake / br > 0.15 ? "#c47070" : "transparent",
              backgroundImage: totalStake / br > 0.15 ? "none" : "linear-gradient(90deg, #a68940, #f5e6b8, #a68940)",
              backgroundSize: "200% 100%", animation: "goldShimmer 4s ease-in-out infinite", transition: "width 0.3s" }} />
          </div>
        </div>
      )}

      {/* Top 5 Tipps */}
      {sortedTips.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {/* Outer uses role=button (not <button>) because it wraps inner
              sort-toggle buttons — nested <button> is invalid HTML and was
              triggering React hydration warnings. */}
          <div onClick={() => setShowTips(!showTips)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowTips(!showTips); } }}
            role="button" tabIndex={0}
            aria-expanded={showTips} aria-label={`Top ${sortedTips.length} Tipps ${showTips ? "ausblenden" : "anzeigen"}`}
            style={{ ...S.card, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
              background: "linear-gradient(135deg, #5a8c4a10, #c4a26508)", border: "1px solid #6aad5525" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14 }}>🏆</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#6aad55" }}>TOP {sortedTips.length} TIPPS</span>
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button onClick={e => { e.stopPropagation(); setTipSort("ev"); }}
                style={{ ...S.outlineBtn, fontSize: 9, padding: "2px 6px", background: tipSort === "ev" ? "#6aad5520" : "transparent", color: tipSort === "ev" ? "#6aad55" : "#a89070" }}>EV</button>
              <button onClick={e => { e.stopPropagation(); setTipSort("conf"); }}
                style={{ ...S.outlineBtn, fontSize: 9, padding: "2px 6px", background: tipSort === "conf" ? "#d4b86a20" : "transparent", color: tipSort === "conf" ? "#d4b86a" : "#a89070" }}>Konfidenz</button>
              <span style={{ color: "#c4a26535", fontSize: 14 }} aria-hidden="true">{showTips ? "▾" : "▸"}</span>
            </div>
          </div>
          {showTips && (
            <div style={{ ...S.card, marginTop: -1, borderTop: "none", borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
              {sortedTips.map((tip, ti) => (
                <TipRow
                  key={ti} tip={tip} ti={ti}
                  last={ti === sortedTips.length - 1}
                  br={br}
                  onSelect={() => { setSelectedMatch(tip.matchIdx); setShowTips(false); }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Selektive Vorhersage — high-conviction Subset nach validierter
          Confidence-Tier (≥65% Top-Pick → histor. ~73% Treffer). Zeigt nur
          Spiele die das TOP-Tier erreichen + ehrlichen Erwartungs-Floor. */}
      {convictionPicks.length > 0 && (
        <div style={{ ...S.card, marginBottom: 10, padding: "10px 12px",
          background: "linear-gradient(135deg, #6aad5512, #d4b86a08)", border: "1px solid #6aad5530" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14 }}>🎯</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#6aad55" }}>
                SELEKTIV — {convictionPicks.length} HOCH-KONVIKTION
              </span>
            </div>
            {convictionHitFloor != null && (
              <span style={{ fontSize: 9, color: "#a89070" }}>
                histor. ≥{Math.round(convictionHitFloor * 100)}% Treffer
              </span>
            )}
          </div>
          {convictionPicks.map((cp) => {
            const tier = confidenceTier(cp.topProb);
            const sideLabel = cp.pick === "1" ? cp.home : cp.pick === "2" ? cp.away : "Unentschieden";
            return (
              <div key={cp.matchIdx}
                onClick={() => setSelectedMatch(cp.matchIdx)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedMatch(cp.matchIdx); } }}
                role="button" tabIndex={0}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "6px 4px", cursor: "pointer", borderTop: "1px solid #c4a26512" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontSize: 11, color: "#e8dcc0" }}>{cp.home} — {cp.away}</span>
                  <span style={{ fontSize: 9, color: "#a89070" }}>Tipp: <span style={{ color: "#6aad55", fontWeight: 600 }}>{sideLabel}</span></span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#6aad55" }}>{Math.round(cp.topProb * 100)}%</span>
                  <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, fontWeight: 600,
                    background: "#6aad5518", color: "#6aad55" }}>{tier.label}</span>
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 8, color: "#c4a26530", marginTop: 6 }}>
            Nur Spiele mit Top-1X2-Wahrscheinlichkeit ≥65% (einzig validierte Selektions-Achse).
          </div>
        </div>
      )}

      {/* Match List */}
      {processed.length === 0 && (
        <div style={{ ...S.card, textAlign: "center", padding: "32px 16px" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }} aria-hidden="true">&#9917;</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#d4b86a", marginBottom: 8 }}>Keine Spieltagsdaten</div>
          <div style={{ fontSize: 12, color: "#a89070", lineHeight: 1.5 }}>
            Fuer diese Liga wurde noch kein Spieltag eingetragen.
            <br />Nutze den Admin-Wizard (<code style={{ color: "#d4b86a" }}>npm run spieltag</code>) um Daten zu laden.
          </div>
        </div>
      )}
      <div style={S.card}>
        {processed.map((m: any, i: number) => {
          const isOpen = selectedMatch === i;
          return (
            <div key={i} data-match-idx={i}>
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

      {/* Manual Bet Tracker — bypasses engine isValue filter so any bet
          (auch außerhalb Goldilocks) kann getrackt werden. Closing-odds
          + CLV werden automatisch von snapshot-Cron ergänzt wenn 2h vor
          Kickoff. Bei vergangenen Spielen bleibt CLV null. */}
      <ManualBetForm />

      {/* Bet Tracker */}
      <BetTracker />

      <div style={{ fontSize: 9, color: "#c4a26520", textAlign: "center", marginTop: 14, letterSpacing: 0.5 }}>
        * vig-bereinigt · Sportwetten = Glücksspiel · spielen-mit-verantwortung.de
      </div>
    </AppShell>
  );
}
