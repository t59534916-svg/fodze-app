// ═══════════════════════════════════════════════════════════════════════
// FODZE Player Impact Engine — Data-driven absence adjustments
//
// Replaces TAG_MAP heuristics (KEY_PLAYER_OUT = flat -15%) with precise
// player-level xG share calculations.
//
// Example: Kane out for Bayern
//   xgShare = 0.42, replacementLevel = 0.15
//   lambdaAttackMult = 1 - (0.42 - 0.15) = 0.73 (−27% attack)
//   vs. TAG_MAP's crude -15% for any key player
// ═══════════════════════════════════════════════════════════════════════

export interface PlayerProfile {
  name: string;
  team: string;
  position: string;       // GK, DEF, MID, FWD
  xgShare: number;        // fraction of team's total xG (0-1)
  xgaShare: number;       // defensive contribution (higher = more defensive burden)
  replacementLevel: number; // expected xG contribution of replacement (0-1)
  gamesPlayed: number;
}

export interface AbsenceAdjustment {
  lambdaAttackMult: number;   // multiplier for team's attacking lambda
  lambdaDefenseMult: number;  // multiplier for opponent's attacking lambda (defensive absence)
  reason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  details: Array<{
    player: string;
    attackImpact: number;     // percentage change
    defenseImpact: number;
  }>;
}

/**
 * Calculate the impact of player absences on team lambda values.
 *
 * Attack logic:
 *   For each absent player: net_loss = max(0, xgShare - replacementLevel)
 *   lambdaAttackMult = 1 - sum(net_losses) (with floor at 0.50)
 *
 * Defense logic:
 *   GK/DEF absences increase opponent's expected goals.
 *   lambdaDefenseMult = 1 + sum(xgaShare impacts) (with ceiling at 1.80)
 *
 * Multiple absences compound multiplicatively for synergy penalty.
 */
export function calcAbsenceImpact(
  absentPlayers: PlayerProfile[],
  teamTotalXGpg: number
): AbsenceAdjustment {
  if (absentPlayers.length === 0) {
    return {
      lambdaAttackMult: 1.0,
      lambdaDefenseMult: 1.0,
      reason: "Keine Ausfaelle",
      confidence: "HIGH",
      details: [],
    };
  }

  let totalAttackLoss = 0;
  let totalDefenseLoss = 0;
  const details: AbsenceAdjustment["details"] = [];

  for (const p of absentPlayers) {
    // Attack: how much xG share is lost minus what the replacement provides
    const attackLoss = Math.max(0, p.xgShare - p.replacementLevel);
    totalAttackLoss += attackLoss;

    // Defense: GK/DEF absences weaken the team's defensive structure
    // MID/FWD absences have minor defensive impact
    const defenseImpactFactor = p.position === "GK" ? 2.0
      : p.position === "DEF" ? 1.5
      : p.position === "MID" ? 0.5
      : 0.2; // FWD
    const defenseLoss = p.xgaShare * defenseImpactFactor;
    totalDefenseLoss += defenseLoss;

    details.push({
      player: p.name,
      attackImpact: +(attackLoss * -100).toFixed(1),
      defenseImpact: +(defenseLoss * 100).toFixed(1),
    });
  }

  // Compute multipliers with safety bounds
  let lambdaAttackMult = Math.max(0.50, 1 - totalAttackLoss);
  let lambdaDefenseMult = Math.min(1.80, 1 + totalDefenseLoss);

  // Synergy penalty: multiple absences compound the damage
  if (absentPlayers.length >= 3) {
    lambdaAttackMult *= 0.92;   // Extra -8% compounding
    lambdaDefenseMult *= 1.08;
  } else if (absentPlayers.length === 2) {
    lambdaAttackMult *= 0.96;   // Extra -4% compounding
    lambdaDefenseMult *= 1.04;
  }

  // Re-clamp after synergy
  lambdaAttackMult = Math.max(0.50, lambdaAttackMult);
  lambdaDefenseMult = Math.min(1.80, lambdaDefenseMult);

  // Determine confidence based on data quality
  const avgGames = absentPlayers.reduce((s, p) => s + p.gamesPlayed, 0) / absentPlayers.length;
  const confidence: AbsenceAdjustment["confidence"] =
    avgGames >= 15 ? "HIGH" : avgGames >= 8 ? "MEDIUM" : "LOW";

  // Build human-readable reason
  const names = details.map(
    (d) => `${d.player} (Att: ${d.attackImpact}%, Def: +${d.defenseImpact}%)`
  );

  return {
    lambdaAttackMult: +lambdaAttackMult.toFixed(3),
    lambdaDefenseMult: +lambdaDefenseMult.toFixed(3),
    reason: `Ausfaelle: ${names.join(", ")}`,
    confidence,
    details,
  };
}

/**
 * Load player profiles from the generated JSON file.
 * Falls back to position-based defaults for unknown players.
 */
export function lookupPlayerProfile(
  profiles: Record<string, Record<string, Omit<PlayerProfile, "name" | "team">>>,
  team: string,
  playerName: string
): PlayerProfile | null {
  const teamProfiles = profiles[team];
  if (!teamProfiles) return null;

  // Exact match
  if (teamProfiles[playerName]) {
    return { name: playerName, team, ...teamProfiles[playerName] };
  }

  // Fuzzy match (last name)
  const lastName = playerName.split(" ").pop()?.toLowerCase();
  if (lastName) {
    for (const [name, profile] of Object.entries(teamProfiles)) {
      if (name.toLowerCase().includes(lastName)) {
        return { name, team, ...profile };
      }
    }
  }

  return null;
}

// ─── Phase 2.3: Player-xG-weighted enrichment ────────────────────────
//
// `player_xg_history` gives us per-player xG-per-90 + minutes-played for
// the season. That's exactly what McHale & Szczepański (2019, arXiv
// 1902.00112) use to build the weighted absence impact:
//
//   xgShare_player = (xg_per_90_player × minutes_share_of_team) / team_total_xg_per_match
//
// `enrichPlayerFromXG` converts a position-default PlayerProfile into a
// per-player actual-xG-share profile when `player_xg_history` data is
// available. Falls back to the position-default unchanged when missing.

export interface PlayerXgRow {
  player_name: string;
  team: string;
  league: string;
  season: string;
  position: string | null;
  minutes_played: number | null;
  xg_per_90: number | null;
  xa_per_90: number | null;
  npxg_per_90: number | null;
}

/**
 * Compute an xG-weighted PlayerProfile from per-player season data.
 *
 * Args:
 *   profile           — PlayerProfile from defaultPlayerProfile (the fallback)
 *   xg                — player_xg_history row (or null when unknown)
 *   teamTotalXGpg     — team's average xG per match (e.g. 1.8 for a Top-5 attacker)
 *   teamMinutesPerMatch — defaults to 90 × 11 = 990 player-minutes per match
 *                        (use 990 unless you track subs; the error is small)
 *
 * Returns a PlayerProfile with real `xgShare` + calibrated `replacementLevel`
 * (median of positional replacement ~0.4× the player's own contribution, a
 * conservative anchor matching the Szczepański replacement-level estimates).
 *
 * Pure — no state, no fetches. Called per-player at engine time.
 */
export function enrichPlayerFromXG(
  profile: PlayerProfile,
  xg: PlayerXgRow | null,
  teamTotalXGpg: number,
  teamMinutesPerMatch: number = 990,
): PlayerProfile {
  if (!xg || xg.xg_per_90 == null || xg.minutes_played == null || xg.minutes_played < 90) {
    return profile;
  }
  const xg90 = Number(xg.xg_per_90);
  const minutes = Number(xg.minutes_played);
  if (!Number.isFinite(xg90) || !Number.isFinite(minutes) || xg90 < 0) return profile;

  // How many matches worth of minutes? ~38 in a full season at 90min each.
  // The per-match xG contribution is xg90 × minutes_share.
  // minutes_share = this-player-minutes / team-player-minutes-per-season
  //               ≈ minutes / (teamMinutesPerMatch × games_played_in_season)
  //
  // We have `minutes` for the player but not team-games. Approximation: the
  // scaled xgShare = xg90 × minutes / (38 × teamMinutesPerMatch × teamXGpg).
  // Simpler: normalize xg90 to per-match by multiplying by minutes_share_per_90.
  //
  // The cleanest form the engine actually needs:
  //   xgShare_per_match = xg90 × (minutes_share_of_available_minutes)
  // When the player plays every minute of every match, minutes_share → 1.0
  // and xgShare_per_match = xg90. So:
  const gamesPlayed = minutes / 90;
  const teamGamesAssumed = Math.max(gamesPlayed, 1); // can't exceed team's total
  const minutesShare = Math.min(1.0, minutes / (teamMinutesPerMatch / 11 * teamGamesAssumed));
  const xgShare = teamTotalXGpg > 0
    ? Math.min(0.50, (xg90 * minutesShare) / teamTotalXGpg)
    : profile.xgShare;

  // Positional replacement: bench/youth player typically contributes
  // ~40% of the starter's rate. For GK/DEF we use 50% (defensive roles
  // are more replaceable due to system-effect).
  const replacementFactor = (profile.position === "GK" || profile.position === "DEF") ? 0.50 : 0.40;
  const replacementLevel = Math.min(xgShare * replacementFactor, xgShare);

  return {
    ...profile,
    xgShare: +xgShare.toFixed(4),
    replacementLevel: +replacementLevel.toFixed(4),
    gamesPlayed: Math.round(gamesPlayed),
  };
}

/**
 * Batch-hydrate a list of absent PlayerProfiles against a player-xg map.
 * Keyed by lower-case lastname OR full name for fuzzy matching (TM + FBref
 * disagree on umlauts and initials; we accept either).
 */
export function hydrateAbsencesWithXG(
  absences: PlayerProfile[],
  xgByKey: Map<string, PlayerXgRow>,
  teamTotalXGpg: number,
): PlayerProfile[] {
  if (absences.length === 0 || xgByKey.size === 0) return absences;
  return absences.map(p => {
    // Try full-name then last-name fallback.
    const lower = p.name.toLowerCase();
    const last = lower.split(" ").pop() || "";
    const hit = xgByKey.get(lower) || xgByKey.get(last) || null;
    return enrichPlayerFromXG(p, hit, teamTotalXGpg);
  });
}

/**
 * Build the lookup Map expected by hydrateAbsencesWithXG.
 * Keys: lower-case full name + lower-case last name, both pointing at
 * the same row. Duplicates (two "Silva" players) collapse to whichever
 * row came last — acceptable collision since the absence-parser only
 * hits ~2-3 players per match.
 */
export function buildPlayerXgIndex(rows: PlayerXgRow[]): Map<string, PlayerXgRow> {
  const out = new Map<string, PlayerXgRow>();
  for (const r of rows) {
    if (!r.player_name) continue;
    const lower = r.player_name.toLowerCase();
    out.set(lower, r);
    const last = lower.split(" ").pop();
    if (last) out.set(last, r);
  }
  return out;
}

/**
 * Create a default player profile when no data is available.
 * Uses position-based heuristics as last resort.
 */
export function defaultPlayerProfile(
  name: string,
  team: string,
  position: string,
  isKeyPlayer: boolean = false
): PlayerProfile {
  const posDefaults: Record<string, { xgShare: number; xgaShare: number; replacement: number }> = {
    GK:  { xgShare: 0.00, xgaShare: 0.15, replacement: 0.00 },
    DEF: { xgShare: 0.05, xgaShare: 0.10, replacement: 0.03 },
    MID: { xgShare: 0.12, xgaShare: 0.05, replacement: 0.06 },
    FWD: { xgShare: 0.25, xgaShare: 0.02, replacement: 0.10 },
  };

  const defaults = posDefaults[position] || posDefaults.MID;

  // Key players get elevated shares
  const keyMult = isKeyPlayer ? 1.5 : 1.0;

  return {
    name,
    team,
    position,
    xgShare: Math.min(0.50, defaults.xgShare * keyMult),
    xgaShare: defaults.xgaShare * keyMult,
    replacementLevel: defaults.replacement,
    gamesPlayed: 0, // Unknown
  };
}
