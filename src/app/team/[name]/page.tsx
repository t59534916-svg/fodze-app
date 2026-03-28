"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import XGChart from "@/components/XGChart";

interface HistoryEntry {
  xg: number;
  xga: number;
  result?: string;
  opponent?: string;
  date?: string;
  proxy?: string;
}

export default function TeamPage() {
  const params = useParams();
  const router = useRouter();
  const teamName = decodeURIComponent((params.name as string) || "");

  const [homeHistory, setHomeHistory] = useState<HistoryEntry[]>([]);
  const [awayHistory, setAwayHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [noData, setNoData] = useState(false);

  useEffect(() => {
    if (!teamName) return;

    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    (async () => {
      try {
        const { data: matchdays } = await sb
          .from("matchdays")
          .select("data")
          .order("created_at", { ascending: false });

        if (!matchdays || matchdays.length === 0) {
          setNoData(true);
          setLoading(false);
          return;
        }

        let foundHome: HistoryEntry[] = [];
        let foundAway: HistoryEntry[] = [];

        for (const md of matchdays) {
          const matches = md.data?.matches || md.data || [];
          if (!Array.isArray(matches)) continue;

          for (const m of matches) {
            // Check home team
            if (m.home?.name === teamName) {
              const hist = m.home.xg_h_history || m.home.xg_home_history;
              if (hist && hist.length > 0 && foundHome.length === 0) {
                foundHome = hist;
              }
            }
            // Check away team
            if (m.away?.name === teamName) {
              const hist = m.away.xg_a_history || m.away.xg_away_history;
              if (hist && hist.length > 0 && foundAway.length === 0) {
                foundAway = hist;
              }
            }
            if (foundHome.length > 0 && foundAway.length > 0) break;
          }
          if (foundHome.length > 0 && foundAway.length > 0) break;
        }

        setHomeHistory(foundHome);
        setAwayHistory(foundAway);
        setNoData(foundHome.length === 0 && foundAway.length === 0);
      } catch (err) {
        // error handled — noData state shown
        setNoData(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [teamName]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "radial-gradient(ellipse at center, #2a1810 0%, #0d0705 100%)",
      color: "#ede4d4",
      fontFamily: "Georgia, serif",
      padding: "24px 16px",
    }}>
      <div style={{ maxWidth: 700, margin: "0 auto" }}>
        {/* Back button */}
        <button
          onClick={() => router.back()}
          style={{
            background: "none",
            border: "1px solid #c4a26530",
            color: "#d4b86a",
            cursor: "pointer",
            fontSize: 13,
            padding: "4px 12px",
            borderRadius: 6,
            fontFamily: "Georgia, serif",
            marginBottom: 16,
          }}
        >
          &larr; Zur&uuml;ck
        </button>

        {/* Title */}
        <h1 style={{
          color: "#d4b86a",
          fontFamily: "Georgia, serif",
          fontSize: 26,
          fontWeight: 700,
          marginBottom: 24,
          letterSpacing: 0.5,
        }}>
          {teamName}
        </h1>

        {loading && (
          <div style={{ color: "#c4a26560", fontSize: 14, textAlign: "center", padding: 40 }}>
            Lade Daten...
          </div>
        )}

        {!loading && noData && (
          <div style={{
            background: "#1a0f08",
            borderRadius: 8,
            padding: 32,
            textAlign: "center",
            color: "#c4a26560",
            fontSize: 14,
            lineHeight: 1.8,
          }}>
            Keine xG-History-Daten f&uuml;r <strong style={{ color: "#d4b86a" }}>{teamName}</strong> gefunden.<br />
            History-Daten werden beim Seeding der Spieltage mitgeliefert (xg_h_history / xg_a_history).
          </div>
        )}

        {!loading && !noData && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Home chart */}
            <XGChart
              history={homeHistory}
              teamName={teamName}
              venue="home"
              height={200}
            />

            {/* Away chart */}
            <XGChart
              history={awayHistory}
              teamName={teamName}
              venue="away"
              height={200}
            />
          </div>
        )}
      </div>
    </div>
  );
}
