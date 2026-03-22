"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase";

// Shiny gold gradient for buttons
const goldBtn = {
  background: "linear-gradient(110deg, #a68940 0%, #d4b86a 25%, #f5e6b8 50%, #d4b86a 75%, #a68940 100%)",
  backgroundSize: "200% 100%",
  border: "none", borderRadius: 8, padding: 14, width: "100%",
  color: "#1a0f0a", fontSize: 14, fontWeight: 700 as const, cursor: "pointer",
  letterSpacing: "1px",
};

const goldBtnAnimated = {
  ...goldBtn,
  animation: "goldShimmer 3s ease-in-out infinite",
};

export default function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const isSignup = false; // Invite-only: Registrierung deaktiviert
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null); setSuccess(null);
    if (isSignup) {
      const { error } = await supabase.auth.signUp({
        email, password,
        options: { data: { display_name: displayName || email.split("@")[0] } },
      });
      if (error) setError(error.message);
      else setSuccess("Account erstellt! Du kannst dich jetzt einloggen.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
      background: "radial-gradient(ellipse at 50% 40%, #2a1810 0%, #1a0f0a 60%, #0d0705 100%)",
      position: "relative",
    }}>
      {/* Ornamental corners */}
      <div style={{ position: "absolute", top: 12, left: 12, width: 28, height: 28, borderTop: "2px solid #c4a26540", borderLeft: "2px solid #c4a26540", borderRadius: "4px 0 0 0" }} />
      <div style={{ position: "absolute", top: 12, right: 12, width: 28, height: 28, borderTop: "2px solid #c4a26540", borderRight: "2px solid #c4a26540", borderRadius: "0 4px 0 0" }} />
      <div style={{ position: "absolute", bottom: 12, left: 12, width: 28, height: 28, borderBottom: "2px solid #c4a26540", borderLeft: "2px solid #c4a26540", borderRadius: "0 0 0 4px" }} />
      <div style={{ position: "absolute", bottom: 12, right: 12, width: 28, height: 28, borderBottom: "2px solid #c4a26540", borderRight: "2px solid #c4a26540", borderRadius: "0 0 4px 0" }} />
      {/* Subtle inner border */}
      <div style={{ position: "absolute", inset: 8, border: "1px solid #c4a26518", borderRadius: 12, pointerEvents: "none" as const }} />

      <div style={{ width: "100%", maxWidth: 340, position: "relative" }}>
        {/* Crest Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 72, height: 72, borderRadius: "50%",
            border: "2px solid #c4a26550",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            marginBottom: 16,
            background: "radial-gradient(circle, #c4a26515 0%, transparent 70%)",
            boxShadow: "0 0 30px #c4a26515, inset 0 0 20px #c4a26508",
          }}>
            <svg width="32" height="32" viewBox="0 0 28 28">
              <path d="M14 2L4 8v6c0 7.5 4.3 13.2 10 14 5.7-.8 10-6.5 10-14V8L14 2z" fill="none" stroke="url(#goldGrad)" strokeWidth="1.5"/>
              <defs><linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#a68940"/><stop offset="50%" stopColor="#f5e6b8"/><stop offset="100%" stopColor="#a68940"/>
              </linearGradient></defs>
              <text x="14" y="19" textAnchor="middle" fill="url(#goldGrad)" fontSize="13" fontWeight="700" fontFamily="Georgia, serif">O</text>
            </svg>
          </div>
          <h1 style={{
            fontSize: 26, fontWeight: 700, letterSpacing: 5, fontFamily: "Georgia, serif", margin: "0 0 4px",
            background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          }}>FODZE</h1>
          <p style={{ fontSize: 7, color: "#c4a26530", letterSpacing: 0.5, margin: "2px 0 0" }}>Fußball orientierte Datenbank zur Erwartungswertsteigerung</p>
          <p style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 3, margin: "4px 0 0" }}>DIXON-COLES · VALUE BETTING</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {isSignup && (
            <div>
              <label style={{ display: "block", fontSize: 11, color: "#c4a26560", marginBottom: 4, letterSpacing: 0.5 }}>Anzeigename</label>
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="z.B. Max" />
            </div>
          )}
          <div>
            <label style={{ display: "block", fontSize: 11, color: "#c4a26560", marginBottom: 4, letterSpacing: 0.5 }}>E-Mail</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" required />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 11, color: "#c4a26560", marginBottom: 4, letterSpacing: 0.5 }}>Passwort</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={isSignup ? "Min. 6 Zeichen" : "Passwort"} required minLength={6} />
          </div>

          {error && <div style={{ padding: "8px 12px", borderRadius: 8, background: "#8c4a4a18", border: "1px solid #c4707030", color: "#c47070", fontSize: 12 }}>{error}</div>}
          {success && <div style={{ padding: "8px 12px", borderRadius: 8, background: "#5a8c4a15", border: "1px solid #6aad5530", color: "#6aad55", fontSize: 12 }}>{success}</div>}

          <button type="submit" disabled={loading} style={{
            ...goldBtnAnimated, opacity: loading ? 0.6 : 1, marginTop: 4,
          }}>
            {loading ? "..." : "EINLOGGEN"}
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: "#c4a26540" }}>
          Zugang nur per Einladung
        </div>

        <p style={{ textAlign: "center", fontSize: 9, color: "#c4a26530", marginTop: 28, letterSpacing: 0.5 }}>
          Sportwetten = Glücksspiel · spielen-mit-verantwortung.de
        </p>
      </div>
    </div>
  );
}
