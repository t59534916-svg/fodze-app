// ═══════════════════════════════════════════════════════════════════════
// FODZE — Manual Bet Tracker
// ═══════════════════════════════════════════════════════════════════════
//
// Why this exists: The engine-driven BET button (in MatchDetail) only
// renders for bets the engine classifies as `isValue=true` (= edge in the
// per-Liga Goldilocks zone). Bets that the user actually placed but the
// engine doesn't see as value (e.g. Basel Heim @ 2.34 where the model is
// market-aligned) have no UI path to be tracked.
//
// This form bypasses the engine's value-filter:
//   - User picks any of the 22 leagues
//   - Types home + away teams (free-form, fuzzy-match later via saveBet's
//     match_key prefix)
//   - Picks market (1X2 / O/U 2.5 / BTTS / Custom)
//   - Quote + stake + result status
//   - Click TRACKEN → saveBet to DB (no isValue check)
//
// Once tracked, the snapshot-closing-odds cron picks up CLV and the
// per-Liga CLV-feedback can flow normally. For matches whose closing
// snapshot already passed (e.g. logged hours after kickoff), CLV stays
// null but everything else (P&L, win-rate, ROI) is correct.
// ═══════════════════════════════════════════════════════════════════════

"use client";
import { useState } from "react";
import { useApp } from "@/contexts/AppContext";
import { LEAGUES } from "@/lib/dixon-coles";
import { matchKey } from "@/lib/format";
import { saveBet } from "@/lib/supabase";

const MARKETS = [
  { value: "Heim", label: "Heim (1)" },
  { value: "Unent.", label: "Unentschieden (X)" },
  { value: "Ausw.", label: "Auswärts (2)" },
  { value: "Ü2.5", label: "Über 2.5 Tore" },
  { value: "U2.5", label: "Unter 2.5 Tore" },
  { value: "BTTS Ja", label: "Beide treffen — Ja" },
  { value: "BTTS Nein", label: "Beide treffen — Nein" },
];

export default function ManualBetForm() {
  const { supabase, user, league, refreshBets } = useApp();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state — defaults to current league for one-click ergonomics
  const [betLeague, setBetLeague] = useState(league);
  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  const [market, setMarket] = useState("Heim");
  const [customMarket, setCustomMarket] = useState("");
  const [odds, setOdds] = useState("");
  const [stake, setStake] = useState("");
  const [resultState, setResultState] = useState<"pending" | "won" | "lost">("pending");

  const reset = () => {
    setHomeTeam(""); setAwayTeam(""); setOdds(""); setStake("");
    setMarket("Heim"); setCustomMarket(""); setResultState("pending");
  };

  const handleSubmit = async () => {
    setError(null); setSuccess(null);

    // Validation
    if (!homeTeam.trim() || !awayTeam.trim()) { setError("Heim- und Auswärts-Team sind Pflicht."); return; }
    const o = parseFloat(odds);
    const s = parseFloat(stake);
    if (!Number.isFinite(o) || o <= 1) { setError("Quote muss > 1.00 sein."); return; }
    if (!Number.isFinite(s) || s <= 0) { setError("Stake muss > 0 sein."); return; }
    const finalMarket = market === "Custom" ? customMarket.trim() : market;
    if (!finalMarket) { setError("Markt-Bezeichnung fehlt."); return; }

    setSubmitting(true);
    try {
      const key = matchKey(betLeague, homeTeam.trim(), awayTeam.trim());
      await saveBet(supabase, {
        match_key: key,
        home_team: homeTeam.trim(),
        away_team: awayTeam.trim(),
        market: finalMarket,
        odds_placed: o,
        stake: s,
        result: resultState,
      }, user.id);
      // If user pre-marked it as won/lost, also stamp settled_at via direct update
      if (resultState !== "pending") {
        // Most recent bet for this user matching the key — settle it
        const { data: rows } = await supabase
          .from("bets")
          .select("id")
          .eq("match_key", key)
          .eq("market", finalMarket)
          .eq("created_by", user.id)
          .order("placed_at", { ascending: false })
          .limit(1);
        if (rows && rows.length > 0) {
          await supabase.from("bets")
            .update({ settled_at: new Date().toISOString() })
            .eq("id", rows[0].id);
        }
      }
      await refreshBets();
      setSuccess(`✓ ${finalMarket} ${homeTeam}–${awayTeam} getrackt (€${s.toFixed(0)} @ ${o.toFixed(2)})`);
      reset();
    } catch (e) {
      setError(`Fehler: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Compact styling that matches BetTracker's gold-tinted aesthetic
  const inputStyle: React.CSSProperties = {
    fontSize: 11, padding: "5px 8px", borderRadius: 4,
    border: "1px solid #c4a26530", background: "#1a0f0a",
    color: "#ede4d4", outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 9, color: "#c4a26580", marginBottom: 2, display: "block",
  };

  return (
    <div style={{ background: "#c4a26508", border: "1px solid #c4a26520", borderRadius: 10, padding: 14, marginBottom: 10 }}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Manual Bet Tracker ${open ? "schließen" : "öffnen"}`}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", width: "100%", background: "none", border: "none", padding: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13 }}>➕</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#d4b86a" }}>MANUELLE WETTE TRACKEN</span>
          <span style={{ fontSize: 10, color: "#c4a26570" }}>(auch außerhalb Goldilocks)</span>
        </div>
        <span style={{ color: "#c4a26535", fontSize: 14 }} aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 10, borderTop: "1px solid #c4a26510", paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Liga + Result row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>Liga</label>
              <select value={betLeague} onChange={e => setBetLeague(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                {Object.entries(LEAGUES).map(([k, v]) => (
                  <option key={k} value={k}>{v.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <select value={resultState} onChange={e => setResultState(e.target.value as any)} style={{ ...inputStyle, width: "100%" }}>
                <option value="pending">⏱ Pending</option>
                <option value="won">✅ Gewonnen</option>
                <option value="lost">❌ Verloren</option>
              </select>
            </div>
          </div>

          {/* Teams row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>Heim-Team</label>
              <input type="text" value={homeTeam} onChange={e => setHomeTeam(e.target.value)} placeholder="z.B. FC Basel" style={{ ...inputStyle, width: "100%" }} />
            </div>
            <div>
              <label style={labelStyle}>Auswärts-Team</label>
              <input type="text" value={awayTeam} onChange={e => setAwayTeam(e.target.value)} placeholder="z.B. FC Sion" style={{ ...inputStyle, width: "100%" }} />
            </div>
          </div>

          {/* Markt + Custom row */}
          <div style={{ display: "grid", gridTemplateColumns: market === "Custom" ? "1fr 1fr" : "1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>Markt</label>
              <select value={market} onChange={e => setMarket(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                {MARKETS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                <option value="Custom">Anderer Markt (frei)</option>
              </select>
            </div>
            {market === "Custom" && (
              <div>
                <label style={labelStyle}>Eigener Markt</label>
                <input type="text" value={customMarket} onChange={e => setCustomMarket(e.target.value)} placeholder="z.B. Asian -1.5" style={{ ...inputStyle, width: "100%" }} />
              </div>
            )}
          </div>

          {/* Quote + Stake row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>Quote</label>
              <input type="number" step="0.01" min="1.01" value={odds} onChange={e => setOdds(e.target.value)} placeholder="z.B. 2.34" style={{ ...inputStyle, width: "100%" }} />
            </div>
            <div>
              <label style={labelStyle}>Einsatz €</label>
              <input type="number" step="0.5" min="0" value={stake} onChange={e => setStake(e.target.value)} placeholder="z.B. 5.00" style={{ ...inputStyle, width: "100%" }} />
            </div>
          </div>

          {/* Action row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, fontSize: 10 }}>
              {error && <span style={{ color: "#c47070" }}>⚠ {error}</span>}
              {success && <span style={{ color: "#6aad55" }}>{success}</span>}
            </div>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{
                fontSize: 11, padding: "8px 16px", borderRadius: 6, cursor: submitting ? "wait" : "pointer",
                border: "none", background: "#6aad55", color: "#fff", fontWeight: 700,
                opacity: submitting ? 0.5 : 1,
              }}
            >
              {submitting ? "..." : "TRACKEN"}
            </button>
          </div>

          <div style={{ fontSize: 9, color: "#c4a26560", lineHeight: 1.4 }}>
            Hinweis: Manuelle Wetten werden ohne Engine-Validation gespeichert. Closing-Odds + CLV werden automatisch ergänzt
            wenn der snapshot-Cron 2h vor Kickoff läuft. Bei vergangenen Spielen bleibt CLV leer, aber P&L wird korrekt
            berechnet.
          </div>
        </div>
      )}
    </div>
  );
}
