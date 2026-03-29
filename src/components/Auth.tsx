"use client";
import { useState, useMemo } from "react";
import { createClient } from "@/lib/supabase";

const goldBtnAnimated = {
  background: "linear-gradient(110deg, #a68940 0%, #d4b86a 25%, #f5e6b8 50%, #d4b86a 75%, #a68940 100%)",
  backgroundSize: "200% 100%",
  border: "none", borderRadius: 8, padding: 14, width: "100%",
  color: "#1a0f0a", fontSize: 14, fontWeight: 700 as const, cursor: "pointer",
  letterSpacing: "1px",
  animation: "goldShimmer 3s ease-in-out infinite",
};

export default function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const supabase = useMemo(() => createClient(), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null); setSuccess(null);

    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setError(error.message);
      } else {
        setSuccess("Bestätigungs-E-Mail gesendet. Bitte prüfe dein Postfach.");
      }
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
      <div style={{ position: "absolute", inset: 8, border: "1px solid #c4a26518", borderRadius: 12, pointerEvents: "none" as const }} />

      <div style={{ width: "100%", maxWidth: 340, position: "relative" }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 88, height: 88, borderRadius: 16,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            marginBottom: 16,
            background: "radial-gradient(circle, #c4a26515 0%, transparent 70%)",
            boxShadow: "0 0 40px #c4a26520, 0 0 80px #c4a26508",
            overflow: "hidden",
          }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon-192.png" alt="FODZE" width={88} height={88} style={{
              borderRadius: 14,
              filter: "drop-shadow(0 0 8px rgba(212,184,106,0.3))",
            }} />
          </div>
          <h1 style={{
            fontSize: 28, fontWeight: 700, letterSpacing: 6, fontFamily: "Georgia, serif", margin: "0 0 4px",
            background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a, #a68940)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          }}>FODZE</h1>
          <p style={{ fontSize: 10, color: "#c4a26550", letterSpacing: 3, margin: "4px 0 0" }}>DIXON-COLES · VALUE BETTING</p>
        </div>

        {/* Login / Sign-Up Toggle */}
        <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid #c4a26520", marginBottom: 16 }}>
          {(["login", "signup"] as const).map(m => (
            <button key={m} onClick={() => { setMode(m); setError(null); setSuccess(null); }}
              style={{
                flex: 1, padding: "10px 4px", fontSize: 12, fontWeight: 600, border: "none",
                cursor: "pointer", letterSpacing: 0.5,
                background: mode === m ? "linear-gradient(110deg, #a68940, #d4b86a, #f5e6b8, #d4b86a, #a68940)" : "#c4a26508",
                backgroundSize: mode === m ? "200% 100%" : undefined,
                animation: mode === m ? "goldShimmer 3s ease-in-out infinite" : undefined,
                color: mode === m ? "#1a0f0a" : "#c4a26560",
              }}>
              {m === "login" ? "EINLOGGEN" : "REGISTRIEREN"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, color: "#c4a26560", marginBottom: 4, letterSpacing: 0.5 }}>E-Mail</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" required />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 11, color: "#c4a26560", marginBottom: 4, letterSpacing: 0.5 }}>Passwort</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === "signup" ? "Mind. 6 Zeichen" : "Passwort"} required minLength={6} />
          </div>

          {error && <div style={{ padding: "8px 12px", borderRadius: 8, background: "#8c4a4a18", border: "1px solid #c4707030", color: "#c47070", fontSize: 12 }}>{error}</div>}
          {success && <div style={{ padding: "8px 12px", borderRadius: 8, background: "#5a8c4a15", border: "1px solid #6aad5530", color: "#6aad55", fontSize: 12 }}>{success}</div>}

          <button type="submit" disabled={loading} style={{ ...goldBtnAnimated, opacity: loading ? 0.6 : 1, marginTop: 4 }}>
            {loading ? "..." : mode === "login" ? "EINLOGGEN" : "KONTO ERSTELLEN"}
          </button>
        </form>

        <p style={{ textAlign: "center", fontSize: 9, color: "#c4a26530", marginTop: 28, letterSpacing: 0.5 }}>
          Sportwetten = Glücksspiel · spielen-mit-verantwortung.de
        </p>
      </div>
    </div>
  );
}
