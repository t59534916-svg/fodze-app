"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import Auth from "@/components/Auth";
import { AppProvider } from "@/contexts/AppContext";
import { MatchdayProvider } from "@/contexts/MatchdayContext";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // createClient() MUST run in useEffect (client-only). Next 16
  // prerenders /_not-found — if we call createBrowserClient() in the
  // component body, it runs during SSR prerender without the
  // NEXT_PUBLIC_SUPABASE_* env vars available and crashes the build.
  useEffect(() => {
    const supabase = createClient();
    const timeout = setTimeout(() => setLoading(false), 5000);
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setLoading(false);
      clearTimeout(timeout);
    }).catch(() => { setLoading(false); clearTimeout(timeout); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => { subscription.unsubscribe(); clearTimeout(timeout); };
  }, []);

  if (loading) return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "radial-gradient(ellipse at 50% 40%, #2a1810 0%, #1a0f0a 60%, #0d0705 100%)", color: "#c4a26560" }}>
      Laden...
    </div>
  );

  if (!user) return <Auth />;

  return (
    <AppProvider user={user}>
      <MatchdayProvider>
        {children}
      </MatchdayProvider>
    </AppProvider>
  );
}
