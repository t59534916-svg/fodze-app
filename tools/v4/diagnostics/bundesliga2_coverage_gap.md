# Bundesliga2 Pinnacle Coverage Gap — Root Cause

## Findings

- `odds_closing_history`: 1,530 bundesliga2 rows with PSCH + PSC>2.5 (full coverage)
- `match_prematch_signals`: 1,494 bundesliga2 rows
- Backfill linked only **300 of 1494 (20.1%)** — should have been ~1,200

## Root Cause: canonical-team.mjs alias gaps for bundesliga2

The mps importer canonicalizes FS CSV team names at write time. The
odds_closing_history retains raw fd.co.uk names. The backfill script
re-canonicalizes och names on-the-fly to match mps. **canonical_team()
has incomplete bundesliga2 EXTRA_ALIASES**, so the two canonical forms
don't unify:

| mps form (FS canonical) | och raw → canon | Should be |
|---|---|---|
| Darmstadt 98 | Darmstadt | one form |
| Fortuna Düsseldorf | Fortuna Dusseldorf | one form (umlaut diff) |
| Hamburger SV | Hamburg | one form |
| Hannover 96 | Hannover | one form |
| Hansa Rostock | (not in fd.co.uk sample? or "Hansa") | unify |
| Ingolstadt | Ingolstadt | OK |
| Jahn Regensburg | Regensburg | one form |
| Karlsruher SC | Karlsruhe | one form |
| Nürnberg | Nurnberg | umlaut diff |
| Schalke 04 | Schalke 04 | OK |
| St. Pauli | St Pauli | period diff |
| Werder Bremen | Werder Bremen | OK |

13 of 18 bundesliga2 teams have mismatch patterns.

## Decision: WONT FIX

**Bundesliga2 mps data is BACKTEST-CORPUS only** — all FS feature classes
(1X2, Goals/BTTS, player-season-aggregate) were rejected via 5-Gate
Falsification this week. Fixing this 20% → 100% coverage gap has zero
production impact because the data isn't consumed by any production engine.

## If reviving in the future

Two fix paths:

**Option A — Single source of truth:** Extend `scripts/_lib/canonical-team.mjs`
EXTRA_ALIASES with bundesliga2 entries. Requires re-running the mps
importer to re-canonicalize names. Ripple effect across all consumers.

**Option B — Bridge-only fuzzy match:** Extend
`scripts/backfill-pinnacle-close-to-mps.mjs` with a fuzzy team-name
fallback (e.g. `fuzzyTeamMatch` from `src/lib/team-resolver.ts`) for
unmatched (league, date) pairs. Surgical fix, doesn't touch other
pipelines.

Same issue may exist for other lower-tier ligas (greek_sl, super_lig,
serie_b at 70-76% may also have minor canonicalization gaps).

## Verification queries

```sql
-- Per-season coverage
SELECT season, COUNT(*) AS mps_total,
       COUNT(pinnacle_close_over25) AS populated
FROM match_prematch_signals
WHERE league = 'bundesliga2'
GROUP BY season;

-- Compare team names
SELECT DISTINCT home_team FROM odds_closing_history
WHERE league = 'bundesliga2' ORDER BY home_team;
SELECT DISTINCT home_team FROM match_prematch_signals
WHERE league = 'bundesliga2' ORDER BY home_team;
```
