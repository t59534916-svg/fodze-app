"use client";
import { useApp } from "@/contexts/AppContext";
import MetricBox from "@/components/shared/MetricBox";
import { ENGINES } from "@/lib/engine-registry";

const S = {
  card: { background: "#c4a26508", border: "1px solid #c4a26520", borderRadius: 10, padding: 14, marginBottom: 10, backdropFilter: "blur(4px)" },
  lbl: { display: "block" as const, fontSize: 11, color: "#c4a26575", marginBottom: 3, letterSpacing: "0.5px" },
};

export default function SettingsCard() {
  const { profile, saveProf, bankroll, dayBudget, setDayBudget, engine, setEngine } = useApp();

  return (
    <div style={S.card}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
        <MetricBox label="BANKROLL" value={`€${bankroll || "—"}`} />
        <div style={{ background: "#c4a26510", border: "1px solid #c4a26530", borderRadius: 8, padding: "8px 4px", textAlign: "center" }}>
          <div style={{ fontSize: 8, color: "#c4a26570", letterSpacing: 1 }}>BUDGET</div>
          <input type="number" value={dayBudget} onChange={e => setDayBudget(e.target.value)} placeholder="—"
            style={{ background: "transparent", border: "none", textAlign: "center", fontSize: 16, fontWeight: 600, color: "#d4b86a", width: "100%", padding: 0 }} />
        </div>
        <MetricBox label="RISIKO" value={({ K: "¼ K", M: "⅓ K", A: "½ K" } as any)[profile.risk_profile]} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <div>
          <label style={S.lbl}>Bankroll €</label>
          <input type="number" value={profile.bankroll || ""} placeholder="500" onChange={e => saveProf("bankroll", parseFloat(e.target.value) || 0)} />
        </div>
        <div>
          <label style={S.lbl}>Risikoprofil</label>
          <select value={profile.risk_profile} onChange={e => saveProf("risk_profile", e.target.value)}>
            <option value="K">Konservativ</option>
            <option value="M">Moderat</option>
            <option value="A">Aggressiv</option>
          </select>
        </div>
      </div>
      {/* Engine Selector */}
      <div>
        <label style={S.lbl}>Prediction Engine</label>
        <div style={{ display: "flex", gap: 6 }}>
          {ENGINES.map(eng => (
            <button
              key={eng.id}
              onClick={() => setEngine(eng.id)}
              style={{
                flex: 1,
                padding: "6px 8px",
                borderRadius: 6,
                border: engine === eng.id ? "1px solid #d4b86a" : "1px solid #c4a26525",
                background: engine === eng.id ? "#d4b86a18" : "transparent",
                color: engine === eng.id ? "#d4b86a" : "#c4a26570",
                fontSize: 11,
                fontWeight: engine === eng.id ? 600 : 400,
                cursor: "pointer",
                transition: "all 0.2s",
                textAlign: "center" as const,
              }}
            >
              <div style={{ fontWeight: 600 }}>{eng.name}</div>
              <div style={{ fontSize: 9, opacity: 0.7, marginTop: 2 }}>{eng.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
