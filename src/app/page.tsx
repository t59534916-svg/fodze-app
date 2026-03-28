"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/contexts/AppContext";
import { isCalibrationActive } from "@/lib/dixon-coles";
import AppShell from "@/components/layout/AppShell";
import Logo from "@/components/shared/Logo";
import { TagValue } from "@/components/shared/ValueBadge";
import LeagueGrid from "@/components/home/LeagueGrid";
import SettingsCard from "@/components/home/SettingsCard";
import { useMatchday } from "@/hooks/useMatchday";

const S = {
  goldText: {
    background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
  },
};

export default function Home() {
  const router = useRouter();
  const { user, profile, supabase, setLeague } = useApp();
  const { loadCached, error } = useMatchday();
  const [showSettings, setShowSettings] = useState(false);

  const handleLoadLeague = async (key: string) => {
    setLeague(key);
    try {
      const found = await loadCached(key);
      if (found) router.push("/matchday");
    } catch (e) {
      // silently handled — error state shown in UI
    }
  };

  return (
    <AppShell>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo size={40} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, fontFamily: "Georgia,serif", ...S.goldText }}>FODZE</div>
            <div style={{ fontSize: 11, color: "#c4a26570", marginTop: 1 }}>
              {profile.display_name || user.email?.split("@")[0]}
              {isCalibrationActive() && <TagValue>Kalibriert</TagValue>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {/* Ask Anna */}
          <button onClick={() => router.push("/anna")} aria-label="Ask Anna — KI-Wettberaterin" style={{
            width: 44, height: 44, borderRadius: 10,
            border: "1px solid #d4b86a30", background: "#d4b86a0a",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d4b86a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <circle cx="9" cy="10" r="1" fill="#d4b86a" stroke="none" />
              <circle cx="15" cy="10" r="1" fill="#d4b86a" stroke="none" />
            </svg>
          </button>
          {/* Settings */}
          <button onClick={() => setShowSettings(!showSettings)} aria-label="Einstellungen" aria-expanded={showSettings} style={{
            width: 44, height: 44, borderRadius: 10, border: "1px solid #c4a26520",
            background: showSettings ? "#c4a26515" : "transparent",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c4a26570" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Settings Panel with Anna + Logout */}
      {showSettings && (
        <div style={{ marginBottom: 16 }}>
          <SettingsCard />
          <button onClick={() => supabase.auth.signOut()} style={{
            width: "100%", padding: "10px 16px", marginTop: 8,
            background: "transparent", border: "1px solid #c4a26520", borderRadius: 8,
            color: "#c47070", cursor: "pointer", fontSize: 12, fontWeight: 500,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c47070" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Abmelden
          </button>
        </div>
      )}

      {/* League Grid */}
      <LeagueGrid onLoadLeague={handleLoadLeague} />

      {error && <div style={{ padding: 10, borderRadius: 8, background: "#8c4a4a18", color: "#c47070", fontSize: 12 }}>{error}</div>}
      <div style={{ fontSize: 10, color: "#c4a26530", textAlign: "center", marginTop: 24, letterSpacing: 0.5 }}>Sportwetten = Glücksspiel · spielen-mit-verantwortung.de</div>
    </AppShell>
  );
}
