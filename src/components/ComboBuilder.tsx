"use client";
import { useMemo, useState } from "react";
import { createLeg, calcCombo, analyzeLegImpact, calcAllSystems, recommendBankers, calcCorrelationImpact, type ComboLeg, type SystemResult } from "@/lib/system-bets";
import { confidenceTier, type ConfTierKey } from "@/lib/confidence-tier";

const pc = (v: number) => (v * 100).toFixed(1) + "%";
const pe = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

const MAX_LEGS = 12; // Bug 3: 2^12 = 4096 iterations, safe for any device

const S = {
  card: { background: "#c4a26508", border: "1px solid #c4a26520", borderRadius: 10, padding: 12, marginBottom: 10 } as React.CSSProperties,
  metric: { background: "#c4a26510", border: "1px solid #c4a26518", borderRadius: 8, padding: "6px 4px", textAlign: "center" as const } as React.CSSProperties,
  goldBtn: {
    background: "linear-gradient(110deg, #a68940 0%, #d4b86a 25%, #f5e6b8 50%, #d4b86a 75%, #a68940 100%)",
    backgroundSize: "200% 100%", border: "none", borderRadius: 8, padding: "12px 16px",
    color: "#1a0f0a", fontSize: 13, fontWeight: 700 as const, cursor: "pointer",
    animation: "goldShimmer 3s ease-in-out infinite",
  } as React.CSSProperties,
  outlineBtn: { background: "#c4a26510", border: "1px solid #c4a26530", borderRadius: 8, padding: "8px 14px", color: "#c4a265", cursor: "pointer", fontSize: 11 } as React.CSSProperties,
  lbl: { display: "block" as const, fontSize: 10, color: "#c4a26550", marginBottom: 3, letterSpacing: "0.5px" } as React.CSSProperties,
  goldText: { background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" } as React.CSSProperties,
};

const multColor = (m: number) => m >= 1.05 ? "#6aad55" : m >= 0.98 ? "#c4a265" : m >= 0.93 ? "#c4a265" : "#c47070";
const multLabel = (m: number) => m >= 1.05 ? "BOOST" : m >= 0.98 ? "FAIR" : m >= 0.93 ? "SCHADEN" : "ZERSTÖRT";
const multIcon = (m: number) => m >= 1.05 ? "↑" : m >= 0.98 ? "→" : "↓";

// Confidence-Tier-Farbe pro Leg — magnitude-basierter Verlässlichkeits-Flag
// (HOCH=verlässlich grün · MITTEL gold · NIEDRIG/TOSS-UP grau, Münzwurf-nah),
// nutzt die kalibrierten Schwellen aus src/lib/confidence-tier.ts. Wir zeigen
// nur den TIER (nicht die 1X2-spezifische Trefferquote), weil ein Kombi-Bein
// jeder Markt sein kann — der Tier flaggt, wie sicher das Modell bei DIESEM Bein ist.
const tierHex = (key: ConfTierKey) =>
  key === "HOCH" ? "#6aad55" : key === "MITTEL" ? "#c4a265" : "#c4a265a0";

interface CustomLeg { id: string; label: string; match: string; p: string; quote: string }

interface Props {
  availableLegs: ComboLeg[];
  budget: number;
  onBack: () => void;
  // Bug 1 fix: State lifted to parent for persistence
  selectedIds: Set<string>;
  setSelectedIds: (fn: (prev: Set<string>) => Set<string>) => void;
  bankerIds: Set<string>;
  setBankerIds: (fn: (prev: Set<string>) => Set<string>) => void;
  customLegs: CustomLeg[];
  setCustomLegs: (fn: (prev: CustomLeg[]) => CustomLeg[]) => void;
  customCounter: number;
  setCustomCounter: (fn: (prev: number) => number) => void;
  selectedSystem: string | null;
  setSelectedSystem: (v: string | null) => void;
}

export default function ComboBuilder({
  availableLegs, budget, onBack,
  selectedIds, setSelectedIds, bankerIds, setBankerIds,
  customLegs, setCustomLegs, customCounter, setCustomCounter,
  selectedSystem, setSelectedSystem,
}: Props) {
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customForm, setCustomForm] = useState({ label: "", match: "", p: "", quote: "" });

  const totalSelected = selectedIds.size;

  // Build legs
  const legs: ComboLeg[] = useMemo(() => {
    const fromMatches = availableLegs
      .filter(l => selectedIds.has(l.id))
      .map(l => createLeg(l.id, l.label, l.match, l.pModel, l.quote, bankerIds.has(l.id)));
    const fromCustom = customLegs
      .filter(c => selectedIds.has(c.id))
      .map(c => {
        const p = parseFloat(c.p) / 100 || 0;
        const q = parseFloat(c.quote) || 0;
        return createLeg(c.id, c.label, c.match, p, q, bankerIds.has(c.id));
      })
      .filter(l => l.pModel > 0 && l.quote > 0);
    return [...fromMatches, ...fromCustom];
  }, [selectedIds, bankerIds, availableLegs, customLegs]);

  const combo = useMemo(() => legs.length >= 2 ? calcCombo(legs) : null, [legs]);
  const stakePerSlip = budget > 0 ? Math.max(0.5, Math.min(budget * 0.02, 2)) : 1;
  const systems = useMemo(() => legs.length >= 2 ? calcAllSystems(legs, stakePerSlip) : [], [legs, stakePerSlip]);
  const bankerRecs = useMemo(() => legs.length >= 3 ? recommendBankers(legs, 2, stakePerSlip) : [], [legs, stakePerSlip]);
  const corrInfo = useMemo(() => legs.length >= 2 && combo ? calcCorrelationImpact(legs, combo.quote) : null, [legs, combo]);

  const selectedResult = useMemo(() => {
    if (!selectedSystem || legs.length < 2) return null;
    return systems.find(s => s.type === selectedSystem) || null;
  }, [selectedSystem, systems, legs]);

  const toggleLeg = (id: string) => {
    if (!selectedIds.has(id) && totalSelected >= MAX_LEGS) return; // Bug 3: enforce limit
    setSelectedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) { n.delete(id); setBankerIds(p => { const nb = new Set(p); nb.delete(id); return nb; }); }
      else n.add(id);
      return n;
    });
  };

  const toggleBanker = (id: string) => {
    setBankerIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  // Bug 2 fix: Use counter-based stable IDs
  const addCustomLeg = () => {
    if (!customForm.label || !customForm.p || !customForm.quote) return;
    const stableId = `custom-${customCounter}`;
    setCustomCounter(prev => prev + 1);
    const newLeg: CustomLeg = { id: stableId, ...customForm };
    setCustomLegs(prev => [...prev, newLeg]);
    setSelectedIds(prev => new Set([...prev, stableId]));
    setCustomForm({ label: "", match: "", p: "", quote: "" });
    setShowAddCustom(false);
  };

  const removeCustomLeg = (id: string) => {
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setBankerIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setCustomLegs(prev => prev.filter(c => c.id !== id));
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: 1, ...S.goldText }}>KOMBI-BUILDER</div>
          <div style={{ fontSize: 10, color: "#c4a26550" }}>{legs.length} Legs{bankerIds.size > 0 ? ` · ${bankerIds.size} Banker` : ""} · max {MAX_LEGS}</div>
        </div>
        <button onClick={onBack} style={S.outlineBtn}>← Zurück</button>
      </div>

      {/* ═══ LEG PICKER ═══ */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 1 }}>LEGS AUSWÄHLEN</span>
          {totalSelected >= MAX_LEGS && <span style={{ fontSize: 9, color: "#c47070", fontWeight: 600 }}>MAX {MAX_LEGS} ERREICHT</span>}
        </div>

        {availableLegs.map(l => {
          const isSelected = selectedIds.has(l.id);
          const isBanker = bankerIds.has(l.id);
          const mult = l.pModel * l.quote;
          const tier = confidenceTier(l.pModel);
          const atLimit = !isSelected && totalSelected >= MAX_LEGS;

          return (
            <div key={l.id} style={{
              padding: "10px", marginBottom: 5, borderRadius: 8, opacity: atLimit ? 0.4 : 1,
              border: isSelected ? `1px solid ${multColor(mult)}35` : "1px solid #c4a26510",
              background: isSelected ? `${multColor(mult)}06` : "transparent",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div onClick={() => toggleLeg(l.id)} style={{
                  width: 22, height: 22, borderRadius: 6, cursor: atLimit ? "not-allowed" : "pointer", flexShrink: 0,
                  border: isSelected ? `2px solid ${multColor(mult)}` : "2px solid #c4a26525",
                  background: isSelected ? `${multColor(mult)}18` : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, color: multColor(mult), fontWeight: 700,
                }}>{isSelected ? "✓" : ""}</div>

                <div style={{ flex: 1, cursor: atLimit ? "not-allowed" : "pointer" }} onClick={() => toggleLeg(l.id)}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#ede4d4" }}>
                    {l.label} <span style={{ color: "#c4a26530", fontSize: 10 }}>({l.match})</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 2, fontSize: 10, flexWrap: "wrap" as const }}>
                    <span style={{ color: "#c4a26545" }}>P:{pc(l.pModel)}</span>
                    <span style={{ color: tierHex(tier.key), fontWeight: 600 }} title="Kalibrierter Confidence-Tier des Modells für dieses Bein (Magnitude). Nur HOCH ist klar überdurchschnittlich; darunter Münzwurf-nah.">{tier.label}</span>
                    <span style={{ color: "#c4a26545" }}>Q:{l.quote.toFixed(2)}</span>
                    <span style={{ color: multColor(mult), fontWeight: 600 }}>{multIcon(mult)}{mult.toFixed(2)}× {multLabel(mult)}</span>
                    {l.edge > 0 && <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "#5a8c4a12", color: "#6aad55", fontWeight: 600 }}>VALUE</span>}
                  </div>
                </div>

                {isSelected && (
                  <div onClick={() => toggleBanker(l.id)} style={{
                    padding: "4px 8px", borderRadius: 6, cursor: "pointer", fontSize: 9, fontWeight: 600, flexShrink: 0,
                    background: isBanker ? "#d4b86a18" : "#c4a26506",
                    border: isBanker ? "1px solid #d4b86a40" : "1px solid #c4a26518",
                    color: isBanker ? "#d4b86a" : "#c4a26535",
                  }}>{isBanker ? "★ BANKER" : "Banker"}</div>
                )}
              </div>
            </div>
          );
        })}

        {/* Custom Legs */}
        {customLegs.map(c => {
          const isSelected = selectedIds.has(c.id);
          const isBanker = bankerIds.has(c.id);
          const p = parseFloat(c.p) / 100 || 0;
          const q = parseFloat(c.quote) || 0;
          const mult = p * q;

          return (
            <div key={c.id} style={{ padding: "8px 10px", marginBottom: 4, borderRadius: 8,
              border: isSelected ? `1px solid ${multColor(mult)}30` : "1px solid #c4a26515",
              background: isSelected ? `${multColor(mult)}06` : "transparent",
              display: "flex", alignItems: "center", gap: 8 }}>
              <div onClick={() => toggleLeg(c.id)} style={{
                width: 22, height: 22, borderRadius: 6, cursor: "pointer", flexShrink: 0,
                border: isSelected ? `2px solid ${multColor(mult)}` : "2px solid #c4a26525",
                background: isSelected ? `${multColor(mult)}18` : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, color: multColor(mult), fontWeight: 700,
              }}>{isSelected ? "✓" : ""}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "#ede4d4" }}>{c.label} <span style={{ color: "#c4a26530", fontSize: 10 }}>{c.match}</span></div>
                <div style={{ fontSize: 10, color: "#c4a26545" }}>P:{c.p}% · <span style={{ color: tierHex(confidenceTier(p).key), fontWeight: 600 }}>{confidenceTier(p).label}</span> · Q:{c.quote} · <span style={{ color: multColor(mult), fontWeight: 600 }}>{mult.toFixed(2)}×</span></div>
              </div>
              {isSelected && <div onClick={() => toggleBanker(c.id)} style={{
                padding: "3px 6px", borderRadius: 4, cursor: "pointer", fontSize: 9, flexShrink: 0,
                background: isBanker ? "#d4b86a18" : "transparent", color: isBanker ? "#d4b86a" : "#c4a26530",
                border: isBanker ? "1px solid #d4b86a35" : "1px solid #c4a26512",
              }}>{isBanker ? "★" : "B"}</div>}
              <div onClick={() => removeCustomLeg(c.id)} style={{ color: "#c47070", cursor: "pointer", fontSize: 11, padding: "2px 6px", flexShrink: 0 }}>✕</div>
            </div>
          );
        })}

        {/* Add Custom */}
        {showAddCustom ? (
          <div style={{ background: "#c4a26506", borderRadius: 8, padding: 10, marginTop: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
              <div><label style={S.lbl}>Tipp *</label><input value={customForm.label} placeholder="z.B. Arsenal Sieg" onChange={e => setCustomForm({ ...customForm, label: e.target.value })} /></div>
              <div><label style={S.lbl}>Spiel</label><input value={customForm.match} placeholder="Arsenal—Lev." onChange={e => setCustomForm({ ...customForm, match: e.target.value })} /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              <div><label style={S.lbl}>Wahrsch. %</label><input type="number" value={customForm.p} placeholder="57" onChange={e => setCustomForm({ ...customForm, p: e.target.value })} /></div>
              <div><label style={S.lbl}>Quote</label><input type="number" step="0.01" value={customForm.quote} placeholder="2.55" onChange={e => setCustomForm({ ...customForm, quote: e.target.value })} /></div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 4 }}>
                <button onClick={addCustomLeg} style={{ ...S.outlineBtn, flex: 1, textAlign: "center" as const, fontWeight: 600 }}>+</button>
                <button onClick={() => setShowAddCustom(false)} style={{ ...S.outlineBtn, color: "#c4a26535" }}>×</button>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAddCustom(true)}
            disabled={totalSelected >= MAX_LEGS}
            style={{ ...S.outlineBtn, width: "100%", textAlign: "center" as const, marginTop: 6, opacity: totalSelected >= MAX_LEGS ? 0.4 : 1 }}>
            + Eigenen Leg hinzufügen
          </button>
        )}
      </div>

      {/* ═══ LIVE KOMBI-VORSCHAU ═══ */}
      {legs.length >= 2 && combo && (
        <div style={S.card}>
          <div style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 1, marginBottom: 8 }}>{legs.length}-ER AKKU VORSCHAU</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5, marginBottom: 6 }}>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26540" }}>P</div><div style={{ fontSize: 14, fontWeight: 600, color: "#ede4d4" }}>{combo.pModel < 0.01 ? `${(combo.pModel*100).toFixed(2)}%` : pc(combo.pModel)}</div></div>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26540" }}>QUOTE</div><div style={{ fontSize: 14, fontWeight: 600, color: "#d4b86a" }}>{combo.quote.toFixed(1)}</div></div>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26540" }}>EV/€1</div><div style={{ fontSize: 14, fontWeight: 600, color: combo.ev >= 0 ? "#6aad55" : "#c47070" }}>{pe(combo.ev)}</div></div>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26540" }}>EDGE</div><div style={{ fontSize: 14, fontWeight: 600, color: combo.edge >= 0 ? "#6aad55" : "#c47070" }}>{pe(combo.edge)}</div></div>
          </div>
          {combo.ev < 0 && (
            <div style={{ padding: "6px 10px", borderRadius: 6, background: "#8c4a4a12", border: "1px solid #c4707018", fontSize: 10, color: "#c47070" }}>
              Kombi ist -EV. Erwarteter Verlust: {(combo.ev * 100).toFixed(1)} Cent/€1.
            </div>
          )}
        </div>
      )}

      {/* ═══ EHRLICHKEIT — fair vs angeboten · Hausvorteil · schwache Beine ═══ */}
      {/* Kein Edge-Versprechen (gemessen: Modell schlägt Pinnacle weder 1X2 noch Ü/U).
          Dieses Panel ist ein internes Disziplin-Instrument: es zeigt die WAHREN Kosten
          + die unsichere Basis einer Kombi, bevor man sie aus Bauchgefühl spielt. */}
      {legs.length >= 2 && combo && (() => {
        const fairQuote = combo.pModel > 0 ? 1 / combo.pModel : Infinity;
        const houseEdge = Math.max(0, -combo.ev);      // erwarteter Verlust / Marge pro €1
        const weak = legs.filter(l => confidenceTier(l.pModel).key !== "HOCH");
        const vigBar = Math.min(100, (houseEdge / 0.30) * 100);  // Balken: 30% = voll
        return (
          <div style={S.card}>
            <div style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 1, marginBottom: 8 }}>EHRLICHKEIT</div>
            <div style={{ fontSize: 12, color: "#ede4d4", marginBottom: 8 }}>
              Zahlt <b style={{ color: "#d4b86a" }}>{combo.quote.toFixed(1)}×</b> — fair wäre{" "}
              <b style={{ color: "#6aad55" }}>{isFinite(fairQuote) ? fairQuote.toFixed(1) + "×" : "—"}</b>
              {houseEdge > 0.001 && <span style={{ color: "#c47070" }}> ({(houseEdge * 100).toFixed(0)}% Marge)</span>}
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#c4a26545", marginBottom: 3 }}>
                <span>HAUSVORTEIL (was du im Schnitt verlierst)</span>
                <span style={{ color: houseEdge > 0.10 ? "#c47070" : "#c4a265", fontWeight: 600 }}>{(houseEdge * 100).toFixed(1)}%</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "#c4a26510" }}>
                <div style={{ height: "100%", borderRadius: 3, width: `${vigBar}%`, transition: "width 0.3s", background: "linear-gradient(90deg, #c4a265, #c47070)" }} />
              </div>
            </div>
            <div style={{ fontSize: 10, color: "#c4a26560", marginBottom: weak.length ? 8 : 0, lineHeight: 1.5 }}>
              Diese {legs.length}-er Kombi gewinnt laut Modell nur in{" "}
              <b style={{ color: "#ede4d4" }}>{combo.pModel < 0.01 ? (combo.pModel * 100).toFixed(2) : (combo.pModel * 100).toFixed(0)}%</b> der Fälle.
            </div>
            {weak.length > 0 && (
              <div style={{ padding: "6px 10px", borderRadius: 6, background: "#8c4a4a0a", border: "1px solid #c4707015", fontSize: 10, color: "#c47070", lineHeight: 1.5 }}>
                {weak.length} von {legs.length} Beinen unter HOCH-Confidence (Münzwurf-nah) → hohe Varianz, unzuverlässige Kombi-Basis.
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ CORRELATION ═══ */}
      {corrInfo && legs.length >= 2 && (
        <div style={S.card}>
          <div style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 1, marginBottom: 6 }}>KORRELATION (ρ = {corrInfo.rho.toFixed(3)})</div>
          <div style={{ fontSize: 10, color: "#c4a26545", marginBottom: 6, lineHeight: 1.5 }}>{corrInfo.source}</div>
          {Math.abs(corrInfo.rho) > 0.01 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
              <div style={S.metric}>
                <div style={{ fontSize: 8, color: "#c4a26535" }}>P UNABHÄNGIG</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: "#c4a26560" }}>{corrInfo.pCombo_independent < 0.01 ? (corrInfo.pCombo_independent*100).toFixed(3)+"%" : pc(corrInfo.pCombo_independent)}</div>
              </div>
              <div style={S.metric}>
                <div style={{ fontSize: 8, color: "#c4a26535" }}>P KORRIGIERT</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: corrInfo.evShift > 0 ? "#6aad55" : corrInfo.evShift < -0.01 ? "#c47070" : "#ede4d4" }}>{corrInfo.pCombo_correlated < 0.01 ? (corrInfo.pCombo_correlated*100).toFixed(3)+"%" : pc(corrInfo.pCombo_correlated)}</div>
              </div>
            </div>
          )}
          {corrInfo.warning && (
            <div style={{ fontSize: 10, color: corrInfo.evShift > 0 ? "#6aad55" : "#c47070", lineHeight: 1.5 }}>{corrInfo.warning}</div>
          )}
          {Math.abs(corrInfo.rho) < 0.01 && (
            <div style={{ fontSize: 10, color: "#c4a26540" }}>Keine messbare Korrelation. Unabhängigkeitsannahme gilt.</div>
          )}
        </div>
      )}

      {/* ═══ SYSTEM-AUSWAHL ═══ */}
      {systems.length > 0 && (
        <div style={S.card}>
          <div style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 1, marginBottom: 8 }}>SYSTEM WÄHLEN</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const, marginBottom: 10 }}>
            {systems.map(sys => (
              <button key={sys.type} onClick={() => setSelectedSystem(sys.type === selectedSystem ? null : sys.type)}
                style={{
                  padding: "8px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: "pointer",
                  border: selectedSystem === sys.type ? "1px solid #d4b86a45" : "1px solid #c4a26518",
                  background: selectedSystem === sys.type ? "#d4b86a12" : "#c4a26506",
                  color: selectedSystem === sys.type ? "#d4b86a" : "#c4a26555",
                }}>
                <div>{sys.type}</div>
                <div style={{ fontSize: 9, fontWeight: 400, marginTop: 2, color: selectedSystem === sys.type ? "#d4b86a99" : "#c4a26535" }}>
                  {sys.numSlips}× · {sys.roi >= 0 ? "+" : ""}{(sys.roi * 100).toFixed(0)}%
                </div>
              </button>
            ))}
          </div>

          {/* Comparison Table */}
          <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" as const }}>
            <thead><tr style={{ borderBottom: "1px solid #c4a26512" }}>
              {["System", "N", "Eins.", "ROI", "P(+)", "Max"].map(h => (
                <th key={h} style={{ textAlign: h === "System" ? "left" as const : "right" as const, padding: "6px 3px", color: "#c4a26535", fontWeight: 500 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {systems.map(sys => (
                <tr key={sys.type} onClick={() => setSelectedSystem(sys.type)} style={{
                  borderBottom: "1px solid #c4a26508", cursor: "pointer",
                  background: selectedSystem === sys.type ? "#d4b86a06" : "transparent",
                }}>
                  <td style={{ padding: "7px 3px", fontWeight: 500, color: selectedSystem === sys.type ? "#d4b86a" : "#ede4d4" }}>{sys.type}</td>
                  <td style={{ textAlign: "right" as const, padding: "7px 3px", color: "#c4a26555" }}>{sys.numSlips}</td>
                  <td style={{ textAlign: "right" as const, padding: "7px 3px", color: "#c4a26555" }}>€{sys.totalStake.toFixed(0)}</td>
                  <td style={{ textAlign: "right" as const, padding: "7px 3px", fontWeight: 600, color: sys.roi >= 0 ? "#6aad55" : "#c47070" }}>{pe(sys.roi)}</td>
                  <td style={{ textAlign: "right" as const, padding: "7px 3px", color: "#ede4d4" }}>{pc(sys.pProfit)}</td>
                  <td style={{ textAlign: "right" as const, padding: "7px 3px", color: "#d4b86a" }}>€{sys.maxPayout.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══ SCENARIO BREAKDOWN ═══ */}
      {selectedResult && selectedResult.scenarios.length > 0 && (
        <div style={S.card}>
          <div style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 1, marginBottom: 6 }}>SZENARIEN — {selectedResult.label}</div>
          <div style={{ fontSize: 10, color: "#c4a26535", marginBottom: 8 }}>
            {selectedResult.numSlips}× à €{selectedResult.stakePerSlip.toFixed(2)} = €{selectedResult.totalStake.toFixed(2)}
          </div>
          {selectedResult.scenarios.map(sc => {
            const isProfit = sc.avgPayout > selectedResult.totalStake;
            const barW = Math.min(sc.probability * 100 / 45 * 100, 100);
            return (
              <div key={sc.nCorrect} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "#ede4d4" }}>{sc.label} richtig</span>
                  <div style={{ display: "flex", gap: 10 }}>
                    <span style={{ fontSize: 10, color: "#c4a26545" }}>{pc(sc.probability)}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: isProfit ? "#6aad55" : sc.avgPayout > 0 ? "#c4a265" : "#c4707080" }}>
                      €{sc.avgPayout.toFixed(1)} → {sc.avgProfit >= 0 ? "+" : ""}€{sc.avgProfit.toFixed(1)}
                    </span>
                  </div>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: "#c4a26508" }}>
                  <div style={{ height: "100%", borderRadius: 2, width: `${barW}%`, transition: "width 0.3s",
                    background: isProfit ? "linear-gradient(90deg, #5a8c4a, #6aad55)" : "#c4a26520" }} />
                </div>
              </div>
            );
          })}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginTop: 10, paddingTop: 10, borderTop: "1px solid #c4a26512" }}>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26535" }}>EV</div><div style={{ fontSize: 13, fontWeight: 600, color: selectedResult.roi >= 0 ? "#6aad55" : "#c47070" }}>€{selectedResult.expectedProfit.toFixed(2)}</div></div>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26535" }}>ROI</div><div style={{ fontSize: 13, fontWeight: 600, color: selectedResult.roi >= 0 ? "#6aad55" : "#c47070" }}>{pe(selectedResult.roi)}</div></div>
            <div style={S.metric}><div style={{ fontSize: 8, color: "#c4a26535" }}>P(PROFIT)</div><div style={{ fontSize: 13, fontWeight: 600, color: "#ede4d4" }}>{pc(selectedResult.pProfit)}</div></div>
          </div>
        </div>
      )}

      {/* ═══ BANKER-EMPFEHLUNG ═══ */}
      {bankerRecs.length > 0 && (
        <div style={S.card}>
          <div style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 1, marginBottom: 6 }}>BANKER-EMPFEHLUNG</div>
          <div style={{ fontSize: 10, color: "#c4a26535", marginBottom: 8, lineHeight: 1.5 }}>Banker muss gewinnen. P ist wichtiger als EV. Reduziert Scheine.</div>
          {bankerRecs.slice(0, 3).map((rec, i) => (
            <div key={rec.bankerId} style={{
              padding: "8px 10px", marginBottom: 4, borderRadius: 8,
              border: i === 0 ? "1px solid #d4b86a25" : "1px solid #c4a26512",
              background: i === 0 ? "#d4b86a06" : "transparent",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: i === 0 ? "#d4b86a" : "#ede4d4" }}>{i === 0 ? "★ " : ""}{rec.bankerLabel}</span>
                <span style={{ fontSize: 10, color: "#c4a26545" }}>Score {rec.score.toFixed(0)}</span>
              </div>
              <div style={{ fontSize: 10, color: "#c4a26550", lineHeight: 1.5 }}>{rec.reason}</div>
            </div>
          ))}
        </div>
      )}

      {/* ═══ -EV WARNING ═══ */}
      {legs.some(l => l.evMultiplier < 0.98) && (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: "#8c4a4a0a", border: "1px solid #c4707015", marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#c47070", marginBottom: 4 }}>Legs mit negativem Multiplikator:</div>
          {legs.filter(l => l.evMultiplier < 0.98).map(l => (
            <div key={l.id} style={{ fontSize: 10, color: "#c47070aa", marginBottom: 2 }}>
              {l.label}: {l.evMultiplier.toFixed(3)}× — kostet {((1 - l.evMultiplier) * 100).toFixed(1)}% EV.
              {l.isBanker ? " (Banker — ok bei hoher P)" : " → Als Banker nutzen oder entfernen."}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 8, color: "#c4a26518", textAlign: "center" as const, marginTop: 10 }}>
        Exakte Berechnung (alle 2^N Ausgänge) · Max {MAX_LEGS} Legs · Sportwetten = Glücksspiel
      </div>
    </div>
  );
}
