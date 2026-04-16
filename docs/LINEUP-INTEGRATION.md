# Lineup-aware Predictions — Integration Guide (Skizze)

Status: **Not implemented.** This document captures the design for a future
session when a reliable lineup source is wired up.

## Why this matters

~60 min before kickoff, clubs publish starting XIs. A top striker not in
the lineup is tens of percentage points of xG swing that the current
prediction pipeline doesn't see. The `parseAbsences` path we wired in
commit `778602c` uses `match.home.injuries` strings which come from the
matchday enrichment — a snapshot from 1-2 days before kickoff, stale by
definition. Real lineup data closes the loop.

## Sources tried

| Source | Status | Notes |
|---|---|---|
| Sofascore | ❌ blocked | `api.sofascore.com` returns HTTP 403 on direct fetch |
| BBC Sport | ⚠️ possible | HTML scrape, works but selectors brittle; EPL only |
| Kicker.de | ⚠️ possible | Requires careful HTML parsing; Bundesliga only |
| Transfermarkt | ⚠️ possible | Has lineups ~60min before; per-match URL |
| RapidAPI services (`api-football`, `sportmonks`) | 💰 paid | ~$20-50/mo, reliable |
| FootyStats (lineups endpoint) | ❓ unknown | Already using their xG API; may have lineups |

**Recommended next step**: subscribe to one paid API (`api-football` via
RapidAPI is the cheapest reliable option, $10/mo free tier available).

## Integration design

### Data model

New Supabase table:
```sql
CREATE TABLE match_lineups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key TEXT NOT NULL,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  commence_time TIMESTAMPTZ,
  home_starting TEXT[],     -- 11 player names
  away_starting TEXT[],
  home_bench TEXT[],
  away_bench TEXT[],
  source TEXT,              -- "api-football", "sofascore", etc
  fetched_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_match_lineup UNIQUE (match_key, source)
);
```

### Scraper contract

A scraper module (`src/lib/scrapers/lineup-*.ts`) exports:
```ts
interface Lineup {
  starting: string[];   // 11 player names
  bench: string[];
}

export async function fetchLineup(
  homeTeam: string,
  awayTeam: string,
  kickoff: string,
): Promise<{ home: Lineup; away: Lineup } | null>;
```

Return `null` when no lineup is published yet (typical >60min before
kickoff) — callers must handle this without crashing.

### Prediction integration

Extend `src/lib/absence-parser.ts` with a complementary path:

```ts
// NEW: derive implicit absences from lineup diff
export function absencesFromLineup(
  team: string,
  expectedStarters: string[],  // baseline from last 5 matches
  todayStarting: string[],
): PlayerProfile[] {
  const missing = expectedStarters.filter(p => !todayStarting.includes(p));
  return missing.map(name => defaultPlayerProfile(name, team, "MID", true));
}
```

The **hard part** is deriving `expectedStarters` — requires tracking
starting XIs match-by-match per team, computing a starts-percentage, and
taking the top 11. This is a separate multi-week data-engineering
project.

### Cron workflow

- Run every 15 min during match windows (Fr 18:00–23:00 UTC, Sa 11:00–22:00 UTC, So 11:00–22:00 UTC)
- For each upcoming match in next 90 min, fetch lineup
- Upsert on `(match_key, source)` — multi-source redundancy OK

### Expected impact

When wired up, absences from the matchday string + implicit absences
from lineup diff combine. Grade-A value bets near kickoff become more
accurate because the 7.5% Goldilocks cap no longer has to defensively
reject edges it can't explain.

Estimated Brier-score impact: **modest** (engines are already reasonably
accurate), **material ROI impact** on pre-match Grade-A bets placed
within 60 min of kickoff.

## Minimum viable slice

A session that wants to ship lineup-aware predictions can do it in
~6-8 hours IF a reliable source is already chosen:

1. Subscribe to api-football ($10/mo trial)
2. Build `src/lib/scrapers/lineup-rapidapi.ts` (~2h)
3. Create the `match_lineups` table in Supabase (~10min)
4. Build `scripts/fetch-lineups.mjs` + cron entry (~1h)
5. Compute baseline expected-starters from recent lineup history
   (requires weeks of accumulated data — chicken/egg, so first month
   predictions won't have this) (~2h)
6. Extend absence-parser to combine string-based and lineup-based
   absences (~1h)

Total: ~6h once a source is chosen. Do not attempt without a subscribed
API — free/scraping sources are too brittle for a bet-staking app.
