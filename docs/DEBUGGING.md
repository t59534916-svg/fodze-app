# FODZE Debugging Runbook

Operationaler Runbook für die häufigsten Ausfälle. Reihenfolge: **Symptom → Diagnose → Fix → Eskalation.** Keine Theorie, nur was laufen muss wenn etwas kaputt ist.

Bevor du tief gräbst, immer zuerst:

```bash
npm run health        # 5s: Supabase + Odds-API + OpenLigaDB + TM + Groq Ping
```

Wenn `health` alles grün zeigt, ist das Problem im App-Layer. Sonst beim entsprechenden External-Service.

---

## 🔴 Matchday-Ebene

### Symptom: `/matchday` zeigt "Keine Daten" für Liga X

**Diagnose:**
1. `npm run audit` — Coverage-Report pro Liga
2. In Supabase SQL Editor:
   ```sql
   SELECT league, matchday, match_date, created_at
   FROM matchdays
   WHERE league = 'bundesliga'
   ORDER BY created_at DESC LIMIT 5;
   ```
3. Wenn keine Zeile vorhanden → Matchday wurde nie generiert für diese Saison

**Fix:**
```bash
# Single-League Regenerate
node scripts/generate-matchday.mjs --league bundesliga --seed

# Vollständiger Rebuild inkl. Injuries (25min)
npm run refresh:full
```

**Eskalation:** Wenn `generate-matchday.mjs` failed mit "no fixtures" — Odds-API hat keine Events für die Liga. Prüfe `live_odds` table oder `scripts/fetch-odds.mjs` manuell.

---

### Symptom: Match öffnet, aber MatchDetail zeigt "Keine Prognose verfügbar"

Das ist ein Empty-State den ich bewusst eingebaut habe — `calc === null` im `ProcessedMatch`. Mit Engine-Konsolidierung (Commit `bf7f6fb`) kann das auch "v2 Engine hat geworfen" bedeuten.

**Diagnose:**
1. DevTools Console öffnen → suche `[FODZE] poisson-ml-v2 failed` oder `[FODZE] poisson-ml-v1 failed`
2. Wenn kein Engine-Fehler: die Engine-Guard `if (!h?.xg_h8 || !a?.xg_a8) return null` hat gegriffen. `xg_h8` (8-Game-Summe im Matchday-JSON) ist 0, weil im Lade-Pfad keine `team_xg_history`-Rows summiert werden konnten. Prüfe die Source-Tabelle:
   ```sql
   SELECT team, venue, xg, match_date
   FROM team_xg_history
   WHERE team IN ('Home-Team-Name', 'Away-Team-Name')
     AND league = 'bundesliga'
   ORDER BY match_date DESC;
   ```
3. Wenn für ein Team 0 Rows → Namens-Mapping-Problem (Understat-Name im DB != FODZE-Name im Matchday-JSON). Seit Commit `d468cbf` läuft der Fuzzy-Resolver in JS über `loadAllTeamXGHistory` — check auch die Token-Heuristik in `src/contexts/MatchdayContext.tsx` (`resolveBucket`).

**Fix — fehlende xG-Historie:**
```bash
# Top-5 Ligen (Understat)
# Manuell: docs/HANDBUCH.md "xG Seed Workflow" folgen

# Liga 3 + Nebenligen (OpenLigaDB goals-proxy)
node scripts/backfill-liga3-openligadb.mjs

# CSV-Shots Modell (football-data.co.uk)
node scripts/backfill-shots-xg.mjs --league X
```

**Fix — Name-Mismatch:**
Check `src/lib/scrapers/team-map.ts` und `src/lib/team-resolver.ts` — der aufsteigende Verein braucht evtl. ein neues Mapping.

**Eskalation:** Wenn der ganze Matchday betroffen ist (nicht nur ein Match), läuft auto-enrichment nicht — check `generate-matchday.mjs` output.

---

### Symptom: Alle Value-Bets plötzlich als "Value-Trap" markiert

v1/v2 Engines haben einen Value-Cap-Guardrail: Edge > 8% (v1) oder > 7.5% (v2) vs Pinnacle-Sharp → als Trap markiert.

**Diagnose:**
Wenn das für JEDES Match gilt, stimmen die sharp-odds nicht mit den engine-Predictions überein. Möglich:

1. `live_odds` hat alte Werte (`fetched_at` > 4h alt)
2. Liga-Mapping falsch (Odds-API key != FODZE league key)
3. Calibration Curves nicht geladen (`calLoaded === false` im AppContext)

**Check:**
```sql
SELECT league, home_team, away_team, sharp_h, sharp_d, sharp_a, fetched_at
FROM live_odds
WHERE league = 'bundesliga'
ORDER BY fetched_at DESC LIMIT 10;
```

Wenn `fetched_at` alt → fetch-odds cron hängt.

Wenn `sharp_h` null → Pinnacle war nicht in den Books für diesen Match. v1/v2 value-cap short-circuitet dann (keine pinnVigFree-Berechnung).

**Fix:**
```bash
npm run refresh:odds        # 30s — nur fetch-odds.mjs
```

**Eskalation:** Wenn Engine-Predictions selbst suspicious sind (z.B. 90% Heim in einem 50/50 Match), check `modelErrors` im AppContext DevTools. Wenn `ensemble` oder `lgbm` fehlt, lief Model-Load nicht durch (seit Commit `d468cbf` wird das visible geloggt).

---

## 🟡 Data-Pipeline

### Symptom: Console warnt `[FODZE] xG history issue`

Der `validateXGHistory`-Check (Commit `d468cbf` / `a438dff`) loggt bei suspicious Patterns.

**Diagnose:**
- `"3+ identical xG values in a row"` → Copy-Paste-Bug in Supabase (Threshold 0.001, echte Dubletten)
- `"zero xG variance"` → alle Werte gleich
- `"chronology broken"` → `match_date` nicht sortierbar
- `"xG out of [0, 5]"` → korrupter Wert

**Fix:**
```sql
-- Dubletten finden
SELECT team, venue, match_date, xg, count(*)
FROM team_xg_history
WHERE league = 'bundesliga'
GROUP BY team, venue, match_date, xg
HAVING count(*) > 1;

-- Löschen (Vorsicht, erst SELECT!)
DELETE FROM team_xg_history
WHERE id IN (... IDs from above query ...);
```

**Eskalation:** Falls systemisch (mehrere Teams betroffen), ist der Import-Script fehlerhaft. Check welcher Source (`understat` / `shots-model` / `goals-proxy` / `footystats`) die Rows produziert hat.

---

### Symptom: Transfermarkt-Scrape bricht mit Groq-Error ab

Ein `refresh:full` verbraucht ~350K Tokens/Tag (Groq free: 500K/Tag). Zweimal am Tag → mittendrin Abbruch. Seit Commit `d4edc6f` gibt's ein sticky flag `_groqDailyQuotaExhausted` in [`scripts/_lib/transfermarkt-scrape.mjs`](../scripts/_lib/transfermarkt-scrape.mjs) damit nicht endlos retried wird.

**Diagnose:**
```bash
# launchd-Logs (wenn via scripts/launchd/install.sh installiert)
tail -50 ~/Library/Logs/fodze-refresh.log
tail -50 ~/Library/Logs/fodze-refresh-full.log

# missing-aliases könnte auch der Grund sein
cat missing-tm-aliases.log 2>/dev/null
```

**Fix:**
1. **Groq-Quota:** 24h warten oder `.env.local` auf `CLAUDE_API_KEY` Fallback umstellen
2. **Missing Aliases:**
   ```bash
   npm run suggest-aliases
   # Vorschläge pasten in scripts/_lib/transfermarkt-aliases.mjs
   npm run refresh:full
   ```

---

### Symptom: Odds veraltet (live_odds > 4h alt)

**Diagnose:**
```sql
SELECT max(fetched_at), count(*) FROM live_odds;
```

**Fix — GitHub Actions Cron läuft nicht:**
1. GitHub → Actions → `fetch-odds.yml` → "Run workflow" manuell
2. Wenn "workflow disabled (inactive repo)" → 1× pushen reaktiviert

**Fix — LaunchAgents (macOS):**
```bash
launchctl list | grep fodze
# Wenn weg:
bash scripts/launchd/install.sh
```

**Manual:**
```bash
node scripts/fetch-odds.mjs
```

---

## 🟢 Bet-Lifecycle

### Symptom: Bets werden nicht automatisch gesettled

`fetch-results.mjs` läuft täglich 02:17 + 08:17 UTC via GitHub Actions, oder 07:30 via launchd.

**Diagnose:**
```sql
SELECT id, match_key, result, settled_at, placed_at
FROM bets
WHERE settled_at IS NULL
  AND placed_at < NOW() - INTERVAL '3 days'
ORDER BY placed_at DESC;
```

Jede Zeile = Bet die gesettled werden sollte, wurde aber nicht.

**Fix:**
```bash
node scripts/fetch-results.mjs
```

**Eskalation:** Wenn `fetch-results` no-op (returned ohne Matches), ist das Team-Mapping Script→Supabase broken. Check `scripts/fetch-results.mjs` → `TEAM_REGISTRY` fuzzy matching.

---

### Symptom: CLV-Werte alle null für kürzliche Bets

`snapshot-closing-odds.mjs` läuft im fetch-odds-Cron, snapshoted sharp-odds innerhalb 2h vor Kickoff.

**Diagnose:**
```sql
SELECT id, match_key, placed_at, odds_placed, closing_odds, clv
FROM bets
WHERE placed_at > NOW() - INTERVAL '7 days'
ORDER BY placed_at DESC;
```

Wenn `closing_odds` null → Snapshot lief nicht / kein Pinnacle für diesen Match.

**Fix:** Last-write-wins, nicht first-write-wins. Solange Match noch nicht gestartet, neuer fetch reparierbar:
```bash
node scripts/fetch-odds.mjs   # includes snapshot-closing-odds piggyback
```

**Nach Kickoff:** Nicht mehr fixbar. Akzeptieren und `computeClvStats` rechnet null-tolerant.

---

## 🔧 Framework / Build

### Symptom: Vercel-Deploy failed

1. Vercel Dashboard → Deployments → Failed → Build-Log lesen
2. Häufige Ursachen:
   - **Missing env var**: `.env.local` hat Keys die Vercel nicht hat. Settings → Environment Variables prüfen.
   - **Type-Error**: `./node_modules/.bin/tsc --noEmit` lokal laufen lassen, fixen
   - **Cheerio / Dep-Conflict**: `npm install` erneut, check `package-lock.json` committed

**Rollback:**
```bash
git revert HEAD  # oder gezielt den bösen Commit
git push origin main
```

---

### Symptom: User sehen stale UI nach Deploy

Service Worker cached. Bei jedem Deploy CACHE_NAME in `public/sw.js` bumpen (`fodze-v4` → `v5`):

```js
// public/sw.js:3
const CACHE_NAME = "fodze-v5";  // ← increment
```

Seit Commit `d468cbf` gibt's SWR für Model-JSONs — die werden automatisch refreshed bei Cache-Version-Change.

**User-seitig Hard-Reload:** `Cmd+Shift+R` / DevTools → Application → Service Workers → Unregister + Refresh.

---

### Symptom: Auth-Loop / "?error=auth" in URL

Seit Next 16 (Commit `bf8eebd`) ist `cookies()` async. Wenn das Fix-Commit verloren geht, läuft OAuth-Callback mit sync `cookies()` → keine Cookie-Set → Loop.

**Check:**
```bash
grep "cookies()" src/app/auth/callback/route.ts
# Muss sein: const cookieStore = await cookies();
```

**Supabase-Side:**
- Dashboard → Auth → URL Config → Site URL == deine Vercel-Domain
- Redirect URLs: `https://deine-app.vercel.app/auth/callback`

---

## 🟤 Performance / UX-Regressions

### Symptom: OddsInput lagt beim Tippen

Seit Commit `d468cbf` hat OddsInput 300ms Debounce + lokaler State. Wenn das broken ist, laufen Engines pro Keystroke.

**Check:**
```bash
grep "ctxTimer\|setEdits" src/components/match/OddsInput.tsx
# Muss beides da sein
```

**Verify im Browser:**
```js
// DevTools Console während Tippen
performance.mark('start');
// Tippe schnell
performance.mark('end');
performance.measure('odds-input', 'start', 'end');
```

Wenn > 100ms pro Keystroke → Debounce kaputt. Wenn < 20ms → gut.

---

### Symptom: Match-Detail öffnet langsam bei vielen Matches

Seit `d468cbf` ist Per-Match-Cache aktiv (keyed auf home.name|away.name|oddsJSON). Wenn Caching nicht greift:

**Check:**
```js
// DevTools → Memory Snapshot →
// Map "engineCache.current" sollte Einträge enthalten nach erstem Load
```

**Diagnose:** Wenn bei jeder Render-Zyklus Map neu ist, ist der `useRef` kaputt. Sollte nicht passieren weil deps `[cacheVersionKey, oddsData]` sind.

---

## 📋 Escalation-Leitfaden

| Symptom-Gruppe | Erste Anlaufstelle |
|---|---|
| **External Data missing** | `npm run health` + `npm run audit` |
| **Engine-Output fishy** | Browser DevTools Console → `[FODZE]` warns |
| **Supabase-Error** | Supabase Dashboard → Logs → API |
| **Vercel broken** | Vercel Dashboard → Deployments → Build-Log |
| **Cron job nicht gelaufen** | GitHub Actions tab ODER `launchctl list \| grep fodze` |
| **Cache-Stale** | SW bump + hard-reload |

---

## Quick-Reference

```bash
# Status-Check
npm run health               # 5s Ping aller externen Quellen
npm run audit                # Data-Coverage-Report pro Liga

# Refresh-Varianten
npm run refresh              # Odds + Matchdays (3min)
npm run refresh:odds         # Nur Live-Odds (30s)
npm run refresh:full         # Inkl. TM-Injuries (25min)
npm run refresh:quick        # Nur Odds + Audit

# Einzel-Scripts
node scripts/generate-matchday.mjs --league X --seed
node scripts/fetch-odds.mjs
node scripts/fetch-results.mjs
node scripts/snapshot-closing-odds.mjs
node scripts/backfill-liga3-openligadb.mjs

# Debug-Flags
--dry        # Preview-ohne-schreiben (alle scripts)
--league X   # Einschränken auf Liga (wo anwendbar)

# Lokale Dev-Umgebung
npm run dev                  # http://localhost:3000
npm run test                 # 186 Tests
./node_modules/.bin/tsc --noEmit  # TypeScript check
```

---

## Zusätzliche Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — System-Design-Überblick
- [ENGINE.md](ENGINE.md) — Prediction-Engine-Internals
- [HANDBUCH.md](HANDBUCH.md) — End-User-Handbuch
- [LINEUP-INTEGRATION.md](LINEUP-INTEGRATION.md) — Unimplemented Design (reference)
- [../CLAUDE.md](../CLAUDE.md) — Codebase-Instruktionen (source of truth)
