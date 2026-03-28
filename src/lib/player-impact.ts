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
