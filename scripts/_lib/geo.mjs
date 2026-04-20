// ═══════════════════════════════════════════════════════════════════════
// FODZE Geo Helpers — Haversine distance between lat/lng pairs
//
// Used by matchday-enrich.mjs::deriveTravelCongestion to compute
// travel_km_last_7d per team. Stays pure (no fs, no network) so it's
// unit-testable and side-effect-free.
// ═══════════════════════════════════════════════════════════════════════

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two lat/lng points in km (Haversine).
 * Returns null when any input is missing or non-finite — callers can
 * treat a null as "unknown travel" rather than inventing a zero.
 *
 * Precision: matches typical online calculators to ±0.1%. For match-
 * scheduling analysis (tens-of-km scale), Haversine's sphere assumption
 * (vs. the actual oblate ellipsoid) introduces <0.5% error — dwarfed
 * by the fact that teams don't literally fly stadium-to-stadium.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  // Reject null / undefined first — Number(null) === 0 would otherwise
  // coerce a missing coord into the equator and silently produce a distance.
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const a = Number(lat1), b = Number(lng1), c = Number(lat2), d = Number(lng2);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  const dLat = toRadians(c - a);
  const dLng = toRadians(d - b);
  const la1 = toRadians(a);
  const la2 = toRadians(c);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Total travel distance for a team across a chronologically ordered
 * list of matches. Each match must expose { venue, opponent_coords } or
 * { home_coords, away_coords, team_side }. We return the sum of
 * point-to-point distances between consecutive AWAY matches (home
 * matches add 0 travel) — crude but it's the right signal for Scoppa's
 * fatigue interaction.
 *
 * `matches` shape: [{ home_lat, home_lng, away_lat, away_lng, team_side: "home"|"away" }]
 * ordered by kickoff ascending (oldest first). Missing coords short-
 * circuit to null for THAT leg; the rest of the sum still accumulates,
 * so a single gap doesn't erase the whole signal.
 */
export function totalTravelKm(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  let total = 0;
  let hadAtLeastOne = false;
  let prevLat = null, prevLng = null;

  // Team's home coords anchor the journey — start at home.
  const home = matches.find(m => m && m.home_lat != null && m.home_lng != null);
  if (home) {
    prevLat = Number(home.home_lat);
    prevLng = Number(home.home_lng);
  }

  for (const m of matches) {
    if (!m) continue;
    // For each AWAY match we travel from prev to the opponent's ground,
    // then back home afterwards (round-trip). For HOME matches we return
    // home (potentially from a previous away trip).
    const isAway = m.team_side === "away";
    const targetLat = isAway ? Number(m.away_lat) : Number(m.home_lat);
    const targetLng = isAway ? Number(m.away_lng) : Number(m.home_lng);
    if (prevLat == null || prevLng == null || !Number.isFinite(targetLat) || !Number.isFinite(targetLng)) {
      // Reset anchor if we know the current location; otherwise stay null.
      prevLat = Number.isFinite(targetLat) ? targetLat : prevLat;
      prevLng = Number.isFinite(targetLng) ? targetLng : prevLng;
      continue;
    }
    const leg = haversineKm(prevLat, prevLng, targetLat, targetLng);
    if (leg != null) {
      total += leg;
      hadAtLeastOne = true;
    }
    prevLat = targetLat;
    prevLng = targetLng;
  }
  return hadAtLeastOne ? +total.toFixed(1) : null;
}
