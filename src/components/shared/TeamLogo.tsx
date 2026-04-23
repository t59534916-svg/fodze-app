"use client";
import { useState } from "react";
import Kit from "@/components/shared/Kit";
import { useTeamMetadata } from "@/hooks/useTeamMetadata";

/**
 * Team-Badge aus TheSportsDB, mit transparent fallback auf das Generic-
 * Kit-SVG wenn (a) kein metadata-row vorhanden ist oder (b) das <img>
 * nicht lädt (404 / CORS / offline).
 *
 * Größenkonvention: quadratisch, inline-aligned, same as <Kit size={N}/>.
 * Die Logos kommen von r2.thesportsdb.com (Cloudflare R2), sind ~2-6 KB
 * PNG — kein visibler Latenz-Hit bei Match-Listen.
 */
export default function TeamLogo({
  team,
  league,
  size = 16,
}: {
  team: string | null | undefined;
  league?: string;
  size?: number;
}) {
  const { lookup, loading } = useTeamMetadata(league);
  const [errored, setErrored] = useState(false);

  if (!team) return <Kit team="" size={size} />;

  const meta = lookup(team);
  const url = meta?.logo_url;

  if (!url || errored || loading) {
    return <Kit team={team} size={size} />;
  }

  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setErrored(true)}
      style={{
        flexShrink: 0,
        objectFit: "contain",
        // Badges oft auf transparentem Hintergrund, damit sie auf leather-
        // theme nicht "fliegen" lassen wir einen dezenten Schatten drauf.
        filter: "drop-shadow(0 0 1px rgba(0,0,0,0.4))",
      }}
    />
  );
}
