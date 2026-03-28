"use client";
import { useState } from "react";

export function BudgetReplies({ onSelect }: { onSelect: (amount: number) => void }) {
  const [custom, setCustom] = useState("");

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {[20, 50, 100].map(amount => (
        <button key={amount} onClick={() => onSelect(amount)} style={{
          padding: "8px 16px", borderRadius: 20, border: "1px solid #c4a26530",
          background: "transparent", color: "#d4b86a", fontSize: 13, fontWeight: 600,
          cursor: "pointer", transition: "all 0.15s",
        }}>
          €{amount}
        </button>
      ))}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input type="number" value={custom} onChange={e => setCustom(e.target.value)}
          placeholder="€..." style={{
            width: 70, padding: "8px 10px", borderRadius: 20, border: "1px solid #c4a26530",
            background: "transparent", color: "#d4b86a", fontSize: 13, fontWeight: 600,
            textAlign: "center",
          }} />
        {custom && (
          <button onClick={() => onSelect(parseInt(custom))} style={{
            padding: "8px 12px", borderRadius: 20, border: "none",
            background: "#d4b86a", color: "#1a0f0a", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>OK</button>
        )}
      </div>
    </div>
  );
}

export function RiskReplies({ onSelect }: { onSelect: (level: string) => void }) {
  const options = [
    { key: "K", label: "Konservativ", desc: "¼ Kelly", color: "#6aad55" },
    { key: "M", label: "Moderat", desc: "⅓ Kelly", color: "#d4b86a" },
    { key: "A", label: "Aggressiv", desc: "½ Kelly", color: "#c47070" },
  ];

  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map(o => (
        <button key={o.key} onClick={() => onSelect(o.key)} style={{
          flex: 1, padding: "10px 8px", borderRadius: 10, border: `1px solid ${o.color}30`,
          background: `${o.color}08`, color: o.color, fontSize: 12, fontWeight: 600,
          cursor: "pointer", textAlign: "center", transition: "all 0.15s",
        }}>
          <div>{o.label}</div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{o.desc}</div>
        </button>
      ))}
    </div>
  );
}
