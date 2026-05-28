"use client";
import TeamLogo from "@/components/shared/TeamLogo";
import EdgeBadge from "@/components/shared/EdgeBadge";
import XGQualityChips from "@/components/shared/XGQualityChips";
import { useMatchdayContext } from "@/contexts/MatchdayContext";
import { useApp } from "@/contexts/AppContext";
import { useTeamMetadata } from "@/hooks/useTeamMetadata";
import { conversionFrom, sosFrom } from "@/lib/xg-quality";
import type { RawMatch, MatchCalc, BetCalc } from "@/types/match";

// Soft fallback wenn weder home noch away eine Farbe haben — leather-
// theme's goldMid mit niedriger Opacity, damit der Accent-Balken sich
// dezent ins Card-Layout einfügt statt sichtbarer "missing data" Strich.
const ACCENT_FALLBACK = "#c4a26540";

// Validate a TheSportsDB color field. TheSportsDB liefert manchmal
// leere Strings oder "#" ohne Hex. Hex validator bleibt absichtlich
// locker — Alpha-Kanäle (8-digit Hex) passieren durch.
function isValidHex(c: string | null | undefined): c is string {
  if (!c) return false;
  return /^#[0-9a-fA-F]{3,8}$/.test(c);
}

const pc = (v: number) => (v * 100).toFixed(0) + "%";

// Compact confidence-pill colour for the list view — calibrated tier from the
// top 1X2 probability (≥65% HOCH/green ~73% hit · 55-65% MITTEL/gold · else grey).
// Mirrors MatchDetail.confidenceTier; validated 2026-05-28 cross-season, see
// docs/FORECAST-QUALITY-ANALYSIS.md. Lets you scan the list for green = sicher.
function confColor(p: number): { fg: string; bg: string; border: string; title: string } {
  if (p >= 0.65) return { fg: "#6aad55", bg: "#6aad5518", border: "#6aad5540", title: "HOCH · histor. ~73% Treffer" };
  if (p >= 0.55) return { fg: "#c4a265", bg: "#c4a26518", border: "#c4a26540", title: "MITTEL · histor. ~56%" };
  return { fg: "#c4a26585", bg: "transparent", border: "#c4a26522", title: p >= 0.45 ? "NIEDRIG · ~50%" : "TOSS-UP · offen" };
}

// Shortened team name: "FC Bayern München" → "Bayern München", "Bayer 04 Leverkusen" → "Leverkusen"
const shortName = (name: string) => {
  if (!name) return "";
  const parts = name.split(" ");
  if (parts.length <= 2) return name;
  const skip = ["FC", "SC", "VfL", "VfB", "SV", "1.", "TSG", "RB", "SpVgg", "SSV", "MSV"];
  const filtered = parts.filter(p => !skip.includes(p));
  return filtered.length > 0 ? filtered.join(" ") : parts.slice(-1)[0];
};

export default function MatchCard({ match, calc, isOpen, onClick }: {
  match: RawMatch; calc: MatchCalc | null; isOpen: boolean; onClick: () => void;
}) {
  const bestBet = calc?.bets?.find((b: BetCalc) => b.isValue);
  const { sosRatings } = useMatchdayContext();
  const { league } = useApp();
  const { lookup } = useTeamMetadata(league);

  // Team-Farben aus TheSportsDB für den linken Accent-Balken. Gradient
  // home → away; fehlt eine Seite, verblasst der Balken auf den gemeinsamen
  // Fallback. Hex-Validation schützt vor leeren TheSportsDB-Einträgen.
  const hColorRaw = lookup(match.home?.name)?.color_primary;
  const aColorRaw = lookup(match.away?.name)?.color_primary;
  const hColor = isValidHex(hColorRaw) ? hColorRaw : ACCENT_FALLBACK;
  const aColor = isValidHex(aColorRaw) ? aColorRaw : ACCENT_FALLBACK;
  const accentGradient = `linear-gradient(to bottom, ${hColor} 0%, ${hColor} 45%, ${aColor} 55%, ${aColor} 100%)`;

  // xG-Quality signals per team — chips appear only for actionable
  // deviations (conversion gap >15%, schedule strength off league-avg
  // by >7%). Clean teams render no chips so the eye learns to skip
  // past them. Critical in less-coverage leagues (Championship,
  // Liga 3, Eredivisie, League One/Two) where raw xG alone can
  // mislead.
  const homeConv = conversionFrom(match.home?.xg_h_history);
  const awayConv = conversionFrom(match.away?.xg_a_history);
  const homeSos = sosFrom(match.home?.xg_h_history, sosRatings);
  const awaySos = sosFrom(match.away?.xg_a_history, sosRatings);

  return (
    <button onClick={onClick} className="match-card" aria-expanded={isOpen}
      style={{
        position: "relative",
        padding: "14px 0 14px 10px", cursor: "pointer",
        borderRadius: 6, width: "100%", textAlign: "left" as const,
        background: "none", border: "none",
        borderBottom: "1px solid #c4a26510",
      }}>
      {/* Left accent-bar with team-color gradient (home top → away bottom).
          Rendered as pseudo-element via absolutely-positioned div so we
          keep a clean border-image-free implementation that works everywhere. */}
      <span aria-hidden="true" style={{
        position: "absolute",
        left: 0, top: 10, bottom: 10,
        width: 3, borderRadius: 2,
        background: accentGradient,
        opacity: 0.75,
      }} />
      {/* Row 1: Teams + kickoff + xG-quality chips next to each name */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, flexWrap: "wrap" }}>
          <TeamLogo team={match.home?.name} league={league} size={16} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#ede4d4", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {shortName(match.home?.name)}
          </span>
          <XGQualityChips conversion={homeConv} sos={homeSos} />
          <span style={{ color: "#c4a26530", fontSize: 12, flexShrink: 0 }}>–</span>
          <TeamLogo team={match.away?.name} league={league} size={16} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#ede4d4", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {shortName(match.away?.name)}
          </span>
          <XGQualityChips conversion={awayConv} sos={awaySos} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginLeft: 8 }}>
          {calc && (() => {
            const top = Math.max(calc.mk.H, calc.mk.D, calc.mk.A);
            const c = confColor(top);
            return (
              <span title={`Confidence ${pc(top)} · ${c.title}`}
                style={{ fontSize: 9, fontWeight: 700, color: c.fg, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 4, padding: "1px 5px" }}>
                {pc(top)}
              </span>
            );
          })()}
          {match.kickoff && <span style={{ color: "#c4a26565", fontSize: 11 }}>{match.kickoff}</span>}
          <span style={{ color: "#c4a26530", fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
        </div>
      </div>

      {/* Row 2: Probability Bar + EdgeBadge with Goldilocks-zone meter */}
      {calc && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, color: "#6aad55", fontWeight: 600, minWidth: 24 }}>{pc(calc.mk.H)}</span>
            <div style={{ flex: 1, display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 1 }}>
              <div style={{ width: `${calc.mk.H * 100}%`, background: "#6aad55", borderRadius: 3, transition: "width 0.3s" }} />
              <div style={{ width: `${calc.mk.D * 100}%`, background: "#c4a26560", borderRadius: 3, transition: "width 0.3s" }} />
              <div style={{ width: `${calc.mk.A * 100}%`, background: "#c47070", borderRadius: 3, transition: "width 0.3s" }} />
            </div>
            <span style={{ fontSize: 9, color: "#c47070", fontWeight: 600, minWidth: 24, textAlign: "right" }}>{pc(calc.mk.A)}</span>
          </div>

          {/* Zone-colored edge readout with per-Liga Goldilocks meter:
              Tier-1 (sharp) 1.5-5%, Tier-2 (default) 2.5-7.5%, Tier-3
              (soft) 3.5-8.5%. SOFT pill for between max and trapHard
              (no Kelly, no alarm). TRAP? pill only above trapHard. */}
          <div style={{ flexShrink: 0 }}>
            {bestBet ? (
              <EdgeBadge edge={bestBet.edge} league={league} />
            ) : (match.tags?.length ?? 0) > 0 ? (
              <span style={{ fontSize: 9, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "#c4a26515", color: "#c4a26570" }}>
                {match.tags![0]}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </button>
  );
}
