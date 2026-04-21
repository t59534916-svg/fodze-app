"use client";
import Kit from "@/components/shared/Kit";
import TeamRadar from "@/components/match/TeamRadar";
import MatchPulse from "@/components/match/MatchPulse";
import EdgeBadge from "@/components/shared/EdgeBadge";
import XGQualityDots from "@/components/shared/XGQualityDots";
import { useMatchdayContext } from "@/contexts/MatchdayContext";
import { conversionFrom, sosFrom } from "@/lib/xg-quality";
import type { RawMatch, MatchCalc, BetCalc } from "@/types/match";

const pc = (v: number) => (v * 100).toFixed(0) + "%";

// Shortened team name: "FC Bayern München" → "Bayern München", "Bayer 04 Leverkusen" → "Leverkusen"
const shortName = (name: string) => {
  if (!name) return "";
  const parts = name.split(" ");
  if (parts.length <= 2) return name;
  // Drop common prefixes
  const skip = ["FC", "SC", "VfL", "VfB", "SV", "1.", "TSG", "RB", "SpVgg", "SSV", "MSV"];
  const filtered = parts.filter(p => !skip.includes(p));
  return filtered.length > 0 ? filtered.join(" ") : parts.slice(-1)[0];
};

export default function MatchCard({ match, calc, isOpen, onClick }: {
  match: RawMatch; calc: MatchCalc | null; isOpen: boolean; onClick: () => void;
}) {
  const bestBet = calc?.bets?.find((b: BetCalc) => b.isValue);
  const { sosRatings } = useMatchdayContext();

  // Pre-compute xG-quality signals per team. Shows only dots for
  // actionable deviations (xG-vs-goals gap > 15%, schedule strength
  // off league-avg by > 7%). No signals = no dots = clean team.
  // Especially valuable in less-coverage leagues (Championship,
  // Liga 3, Eredivisie) where raw xG can mislead if a team either
  // wastes chances or piles up xG against weak defenses.
  const homeConv = conversionFrom(match.home?.xg_h_history);
  const awayConv = conversionFrom(match.away?.xg_a_history);
  const homeSos = sosFrom(match.home?.xg_h_history, sosRatings);
  const awaySos = sosFrom(match.away?.xg_a_history, sosRatings);

  return (
    <button onClick={onClick} className="match-card" aria-expanded={isOpen}
      style={{
        padding: "14px 0", cursor: "pointer",
        borderRadius: 6, width: "100%", textAlign: "left" as const,
        background: "none", border: "none",
        borderBottom: "1px solid #c4a26510",
      }}>
      {/* Row 1: Teams + Kickoff */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          <Kit team={match.home?.name} size={16} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#ede4d4", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {shortName(match.home?.name)}
          </span>
          <XGQualityDots conversion={homeConv} sos={homeSos} />
          <span style={{ color: "#c4a26530", fontSize: 12, flexShrink: 0 }}>–</span>
          <Kit team={match.away?.name} size={16} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#ede4d4", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {shortName(match.away?.name)}
          </span>
          <XGQualityDots conversion={awayConv} sos={awaySos} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginLeft: 8 }}>
          {match.kickoff && <span style={{ color: "#c4a26565", fontSize: 11 }}>{match.kickoff}</span>}
          <span style={{ color: "#c4a26530", fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
        </div>
      </div>

      {/* Row 2: Probability Bar + Signal */}
      {calc && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Probability Bar */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, color: "#6aad55", fontWeight: 600, minWidth: 24 }}>{pc(calc.mk.H)}</span>
            <div style={{ flex: 1, display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 1 }}>
              <div style={{ width: `${calc.mk.H * 100}%`, background: "#6aad55", borderRadius: 3, transition: "width 0.3s" }} />
              <div style={{ width: `${calc.mk.D * 100}%`, background: "#c4a26560", borderRadius: 3, transition: "width 0.3s" }} />
              <div style={{ width: `${calc.mk.A * 100}%`, background: "#c47070", borderRadius: 3, transition: "width 0.3s" }} />
            </div>
            <span style={{ fontSize: 9, color: "#c47070", fontWeight: 600, minWidth: 24, textAlign: "right" }}>{pc(calc.mk.A)}</span>
          </div>

          {/* Signal: zone-colored edge readout with Goldilocks meter
              (green=authorized, amber=thin, warn=trap). Replaces the
              plain all-green badge where +4.2% and +28% looked
              identical — one is a real value signal, the other is a
              value-trap the engine explicitly downgrades. */}
          <div style={{ flexShrink: 0 }}>
            {bestBet ? (
              <EdgeBadge edge={bestBet.edge} />
            ) : (match.tags?.length ?? 0) > 0 ? (
              <span style={{ fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "#c4a26515", color: "#c4a26570" }}>
                {match.tags![0]}
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Row 2b: MatchPulse — Favorit-Pfeil + Spannung-Dots +
          Mismatch-Glow auf einem 180×24 Strip. Ergänzt die Probability-
          Bar um die drei Meta-Signale (wer, wie eng, wo Edge). */}
      {calc && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}>
          <MatchPulse calc={calc} width={180} height={22} />
        </div>
      )}

      {/* Row 3: Team-Radar-Paar — 5-Achsen-Profil pro Team
          (Angriff · Defensive · Form · Kader · Δ xG). Nur wenn
          mindestens eines der Teams xG-Historie hat — sonst bleibt
          die Card kompakt wie vorher. Radar selbst hover-öffnet
          den Tooltip mit Werten; keine extra Labels auf der Card. */}
      {calc && (match.home?.xg_h8 != null || match.away?.xg_a8 != null) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 10, marginTop: 8, paddingTop: 4, borderTop: "1px dashed #c4a26510",
        }}>
          <TeamRadar team={match.home} venue="home" size={52} />
          <span style={{ fontSize: 9, color: "#c4a26540", fontWeight: 500, letterSpacing: "0.08em" }}>vs</span>
          <TeamRadar team={match.away} venue="away" size={52} />
        </div>
      )}
    </button>
  );
}
