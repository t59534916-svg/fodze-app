"use client";
import { useState, useEffect, useRef } from "react";
import { color, fontFamily } from "@/styles/tokens";

const FIELDS = ["h", "d", "a", "o25", "u25", "btts"] as const;
type Field = typeof FIELDS[number];

export default function OddsInput({ odds, onSetOdds, onSave, saving, idx }: {
  odds: any; onSetOdds: (field: string, value: string) => void; onSave: () => void; saving: boolean; idx: number;
}) {
  const o = odds || {};
  const [showMore, setShowMore] = useState(false);
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const ctxTimer = useRef<NodeJS.Timeout | null>(null);
  const [autoSaved, setAutoSaved] = useState(false);

  // Local edits take precedence over props during in-flight typing. Once the
  // context debounce fires, the edit is cleared and props (from context) become
  // canonical again. Prevents 3-engine recalc on every keystroke (120-450ms per
  // char on 10-match days) — engines only re-run after 300ms of inactivity.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const getValue = (k: string) => edits[k] !== undefined ? edits[k] : (o[k] || "");

  const handleChange = (field: Field, value: string) => {
    setEdits(prev => ({ ...prev, [field]: value }));
    setAutoSaved(false);

    if (ctxTimer.current) clearTimeout(ctxTimer.current);
    ctxTimer.current = setTimeout(() => {
      onSetOdds(field, value);
      setEdits(prev => { const n = { ...prev }; delete n[field]; return n; });
    }, 300);

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave();
      setAutoSaved(true);
      setTimeout(() => setAutoSaved(false), 2000);
    }, 1500);
  };

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (ctxTimer.current) clearTimeout(ctxTimer.current);
  }, []);

  const inputStyle = {
    background: "transparent", border: "none", textAlign: "center" as const,
    fontSize: 18, fontWeight: 600, color: color.text, width: "100%", padding: 0,
    fontFamily: fontFamily.mono,
    minHeight: 24,
  };

  const cellStyle = {
    background: "#0d070540", border: `1px solid ${color.border}`, borderRadius: 8,
    padding: "12px 6px", textAlign: "center" as const, flex: 1,
    minHeight: 44,
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: `${color.goldMid}70`, fontWeight: 600, letterSpacing: 0.5 }}>
          {o._source === "live" ? "LIVE QUOTEN" : "QUOTEN"}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {o._source === "live" && (
            <span style={{ fontSize: 8, color: color.value, background: color.valueBg, padding: "2px 6px", borderRadius: 4 }}>
              ● LIVE · {o._bookmakers} Books
            </span>
          )}
          <span aria-live="polite" style={{ fontSize: 9 }}>
            {saving && <span style={{ color: color.gold }}>Speichert...</span>}
            {autoSaved && <span style={{ color: color.value }}>✓ Gespeichert</span>}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {([["h", "1", "Heim-Quote"], ["d", "X", "Unentschieden-Quote"], ["a", "2", "Auswärts-Quote"]] as [Field, string, string][]).map(([k, l, label]) => (
          <div key={k} style={cellStyle}>
            <label htmlFor={`odds-${k}-${idx}`} style={{ fontSize: 10, color: `${color.goldMid}80`, marginBottom: 4, fontWeight: 600, display: "block" }}>{l}</label>
            <input id={`odds-${k}-${idx}`} type="number" step="0.01" value={getValue(k)} placeholder="—"
              aria-label={label}
              onChange={e => handleChange(k, e.target.value)}
              style={inputStyle} />
          </div>
        ))}
      </div>

      <button onClick={() => setShowMore(!showMore)} style={{
        width: "100%", padding: "6px 0", fontSize: 10, fontWeight: 500, color: `${color.goldMid}70`,
        background: "none", border: "none", cursor: "pointer", letterSpacing: 0.3,
      }}>
        {showMore ? "▾ Weniger Märkte" : "▸ Ü2.5 · U2.5 · BTTS"}
      </button>

      {showMore && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          {([["o25", "Ü2.5", "Über 2.5 Tore"], ["u25", "U2.5", "Unter 2.5 Tore"], ["btts", "BTTS", "Beide Teams treffen"]] as [Field, string, string][]).map(([k, l, label]) => (
            <div key={k} style={cellStyle}>
              <label htmlFor={`odds-${k}-${idx}`} style={{ fontSize: 10, color: `${color.goldMid}80`, marginBottom: 4, fontWeight: 600, display: "block" }}>{l}</label>
              <input id={`odds-${k}-${idx}`} type="number" step="0.01" value={getValue(k)} placeholder="—"
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
