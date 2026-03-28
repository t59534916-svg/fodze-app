"use client";
import { useState, useEffect, useRef } from "react";

export default function OddsInput({ odds, onSetOdds, onSave, saving, idx }: {
  odds: any; onSetOdds: (field: string, value: string) => void; onSave: () => void; saving: boolean; idx: number;
}) {
  const o = odds || {};
  const [showMore, setShowMore] = useState(false);
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const [autoSaved, setAutoSaved] = useState(false);

  // Auto-save after 1.5s of inactivity
  const handleChange = (field: string, value: string) => {
    onSetOdds(field, value);
    setAutoSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave();
      setAutoSaved(true);
      setTimeout(() => setAutoSaved(false), 2000);
    }, 1500);
  };

  useEffect(() => { return () => { if (saveTimer.current) clearTimeout(saveTimer.current); }; }, []);

  const inputStyle = {
    background: "transparent", border: "none", textAlign: "center" as const,
    fontSize: 18, fontWeight: 600, color: "#ede4d4", width: "100%", padding: 0,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
  };

  const cellStyle = {
    background: "#0d070540", border: "1px solid #c4a26520", borderRadius: 8,
    padding: "10px 6px", textAlign: "center" as const, flex: 1,
  };

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Source indicator */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: "#c4a26570", fontWeight: 600, letterSpacing: 0.5 }}>
          {o._source === "live" ? "LIVE QUOTEN" : "QUOTEN"}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {o._source === "live" && (
            <span style={{ fontSize: 8, color: "#6aad55", background: "#6aad5515", padding: "2px 6px", borderRadius: 4 }}>
              ● LIVE · {o._bookmakers} Books
            </span>
          )}
          <span aria-live="polite" style={{ fontSize: 9 }}>
            {saving && <span style={{ color: "#d4b86a" }}>Speichert...</span>}
            {autoSaved && <span style={{ color: "#6aad55" }}>✓ Gespeichert</span>}
          </span>
        </div>
      </div>

      {/* Main odds: 1 / X / 2 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {[["h", "1", "Heim-Quote"], ["d", "X", "Unentschieden-Quote"], ["a", "2", "Auswärts-Quote"]].map(([k, l, label]) => (
          <div key={k} style={cellStyle}>
            <label htmlFor={`odds-${k}-${idx}`} style={{ fontSize: 10, color: "#c4a26565", marginBottom: 4, fontWeight: 600, display: "block" }}>{l}</label>
            <input id={`odds-${k}-${idx}`} type="number" step="0.01" value={o[k] || ""} placeholder="—"
              aria-label={label}
              onChange={e => handleChange(k, e.target.value)}
              style={inputStyle} />
          </div>
        ))}
      </div>

      {/* More markets toggle */}
      <button onClick={() => setShowMore(!showMore)} style={{
        width: "100%", padding: "6px 0", fontSize: 10, fontWeight: 500, color: "#c4a26570",
        background: "none", border: "none", cursor: "pointer", letterSpacing: 0.3,
      }}>
        {showMore ? "▾ Weniger Märkte" : "▸ Ü2.5 · U2.5 · BTTS"}
      </button>

      {showMore && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          {[["o25", "Ü2.5", "Über 2.5 Tore"], ["u25", "U2.5", "Unter 2.5 Tore"], ["btts", "BTTS", "Beide Teams treffen"]].map(([k, l, label]) => (
            <div key={k} style={cellStyle}>
              <label htmlFor={`odds-${k}-${idx}`} style={{ fontSize: 10, color: "#c4a26565", marginBottom: 4, fontWeight: 600, display: "block" }}>{l}</label>
              <input id={`odds-${k}-${idx}`} type="number" step="0.01" value={o[k] || ""} placeholder="—"
                aria-label={label}
                onChange={e => handleChange(k, e.target.value)}
                style={{ ...inputStyle, fontSize: 15 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
