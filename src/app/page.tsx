"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import Auth from "@/components/Auth";
import FodzeApp from "@/components/FodzeApp";

export default function Home() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
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
  return <FodzeApp user={user} />;
}
