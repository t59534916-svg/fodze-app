# scripts/_archive/

Scripts moved here are **dormant** — kept in-tree for git-history reference, but not callable from active workflows. Restoring one means moving it back to `scripts/` AND auditing whether it still matches the current data model (especially the 2026-04-27 canonicalize-on-write invariant — see CLAUDE.md "Team-Name Canonicalization").

## Inventory

| Script | Archived | Reason | Restore Notes |
|---|---|---|---|
| `scrape-referees.mjs` | 2026-04-29 | `referees` Supabase table is stub-data (354 rows, all `fouls_per_game` NULL, `home_yellow_bias` 1 distinct value). FBref blocked by Cloudflare since 2026-Q1; no plan to revive without an alternative source. | Find new referee data source first; current `referees` table cannot serve as a feature column. |
| `scrape-stadiums.mjs` | 2026-04-29 | `stadiums` table has 28 % join coverage and `altitude_m` 0 % populated; marginal value. Replaced for runtime use by `team_metadata.stadium / stadium_capacity` (TheSportsDB-sourced). | If altitude becomes a feature, restore + canonicalize team names per `_lib/canonical-team.mjs`. |
| `scrape-xg.mjs` | 2026-04-29 | Replaced by browser-script seed flow (`backfill-xg.mjs` interactive + `seed-understat-2526.mjs`). Direct scrape gets blocked by Understat. | Use the browser-script flow for new seasons. |
| `backfill-football-data-co-uk.mjs` | 2026-04-29 | football-data.co.uk stopped publishing PSCH/PSCD/PSCA closing-odds columns after 2026-01-14. Replaced by live-odds-snapshot forward-cache in `snapshot-closing-odds.mjs` (writes to `odds_closing_history` with `source='live-odds-snapshot'`). | Re-enable only if upstream resumes the closing columns; PostgREST upsert fix from 2026-04-26 is preserved (`?on_conflict=match_key`). |

## Other deprecated scripts (kept in-place for package.json compatibility)

- `scripts/import-wfr-csvs.mjs` — `npm run wfr:import` is still wired but the R-service it consumes is dormant. Marked deprecated via header-comment; remove the `wfr:import` package.json entry before deleting.
