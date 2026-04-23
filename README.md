# FODZE — Quantitative Fußball-Wettanalyse

Quantitative Wettanalyse mit Dixon-Coles Bivariate Poisson, isotonischer Kalibrierung und Kelly-Criterion Staking. **22 Ligen** live + 2 European cups, **4 Prediction-Engines** parallel, **~80.000 Trainings-Rows** aus 4 Datenquellen, **498 Tests** grün.

**Next.js 14** · TypeScript · Supabase · Vercel

## Quick Start

```bash
git clone https://github.com/t59534916-svg/fodze-app.git
cd fodze-app
npm install
cp .env.example .env.local      # Keys eintragen (siehe unten)
npm run dev                      # http://localhost:3000
```

## Daten aktuell halten

```bash
npm run health          # 5-Sekunden Statuscheck aller Datenquellen
npm run refresh         # Schnell-Update — odds + matchdays (~3 min)
npm run refresh:full    # Voll inkl. Injuries via Transfermarkt (~25 min)
npm run audit           # Coverage-Report pro Liga
```

**Automatisch (macOS):**
```bash
bash scripts/launchd/install.sh   # täglich 07:30 + Di/Fr 19:00
```

## Features

| Feature | Beschreibung |
|---|---|
| **4 Engines parallel** | Standard Ensemble · @annafrick13 v1 (Poisson-ML) · v2 (LightGBM Tweedie, production) · v3 (29-Feature LightGBM, preview-only bis Training läuft). Engine-Toggle microsecond-fast dank Pre-Compute |
| **Goldilocks-Zone + Trap-Tiering** | 2.5–7.5% Edge = authorized · 7.5–10% silent skip · >10% hard Value-Trap-Banner. Dual-source Edge (Markt vig-removed + Engine-Prob) als Konsens-Indikator |
| **Team-Logos + Colors** | 342 Teams via TheSportsDB mit echten Badges statt Generic-Kit-SVG. Accent-Gradient pro MatchCard (home-color → away-color linke Border) |
| **Live-Injuries** | Pro Team via Transfermarkt + Groq HTML-Parser ODER api-sports structured endpoint (kein Scraping-Risk). Im UI als 🩹 H:2 · 🩹 A:3 Counter |
| **Match-Context-Strip** | Form-Dots (W/D/L), Verletzten-Counter, Tag-Badges (Derby/Meisterkampf/Abstiegskampf) direkt über der Probability-Bar |
| **Post-Match Backtest** | `/backtest` zeigt Brier/LogLoss per Engine + Bootstrap-CIs (95%) + Physical-Markets (xShots/xCorners MAE vs actual) + Hindsight-Free Replay gegen team_xg_history |
| **CLV-Tracking** | Closing-Quoten-Snapshot vor Kickoff → echter Edge-Indikator über Variance |
| **Kelly-Criterion** | K/M/A Risiko-Profile mit caps (2.5% / 4% / 6%) |
| **Ask Anna** | KI-Beraterin (Groq Llama 3.3 70B kostenlos / Claude Sonnet) |
| **PWA + A11y** | Installierbar, Service Worker, WCAG 2.1 AA |

## Liga-Abdeckung

**22 aktive Ligen** + 2 European cups:

| Tier | Ligen |
|---|---|
| Top-5 | 🇩🇪 Bundesliga · 🏴󠁧󠁢󠁥󠁮󠁧󠁿 EPL · 🇪🇸 La Liga · 🇮🇹 Serie A · 🇫🇷 Ligue 1 · 🇳🇱 Eredivisie |
| Tier 1 | 🏴󠁧󠁢󠁥󠁮󠁧󠁿 Championship · 🇩🇪 2.Bundesliga · 🇩🇪 3.Liga · 🇵🇹 Primeira Liga · 🇧🇪 Jupiler Pro · 🇹🇷 Süper Lig · 🇪🇸 La Liga 2 · 🇮🇹 Serie B · 🇫🇷 Ligue 2 |
| Tier 2 | 🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scottish Premiership · 🇬🇷 Greek SL · 🏴󠁧󠁢󠁥󠁮󠁧󠁿 League One · League Two · 🇦🇹 Austria Bundesliga · 🇨🇭 Swiss Super League · 🇳🇱 Eerste Divisie |
| Cups | UEFA Champions League · Europa League |

## Daten-Pipeline

**4 Primary-Quellen** für echte xG-Ground-Truth (team_xg_history):

| Source | Rows | Coverage |
|---|---|---|
| **FootyStats** CSVs (1 Credit/Liga-Saison) | ~43.000 | 14 Ligen × 4 Saisons 2022-2026. Real xG + shots + possession + passes + cards + referee |
| **Understat** (browser-script) | ~28.700 | Top-5 + Eredivisie, 2017-05-2025. Real xG + npxG + PPDA + Deep Completions |
| **api-sports v3** (Free 100 calls/Tag, 2-Key rotation) | variabel | Current-season injuries via `?date=` (3-Tage-Window), historical 2022-2024 via `?season=` |
| **shots-model** (shots→xG regression) | ~8.000 | Fallback wo weder FootyStats noch Understat deckt |

**Metadaten-Quellen:**
| Source | Zweck | Abdeckung |
|---|---|---|
| TheSportsDB v1 | Team-Logos, Colors, Stadium, cross-source IDs | 342 Teams · idAPIfootball bridge |
| Transfermarkt + Groq | Injuries + Sperren + Yellow-Risk | 362 IDs · 146 Aliase |
| The-Odds-API | Live-Odds + Fixtures | 500 free Credits/Monat |
| OpenLigaDB | DE-Liga "30. Spieltag" Labels + Liga 3 goals-proxy | DE-only |
| StatsBomb Open Data | Event-level Training-Rohstoff | WM/EM/CL + La Liga 18 Saisons |

## Prediction Engines

```
v1 (ensemble-v1)    4-Modell Ensemble: Dixon-Coles (6%) + Elo (22%) + Logistic (51%) + Market (20%)
                    Trainiert auf 139k Matches. Brier: 0.6076

@annafrick13 v1     Poisson-GLM → 15×15 Dixon-Coles Matrix. 9 Features. Refuses to predict ohne xG-Historie.

@annafrick13 v2     LightGBM Tweedie, 21 Features (npxG, PPDA, Deep, game-state xG shares).
                    Monotonic Constraints, Optuna-tuned ρ=-0.094. Brier: 0.5844 (OOS, 1752 matches).

@annafrick13 v3     LightGBM Tweedie, 29 Features (v2 + 8 neue match-stats: shots/SoT/corners/
                    possession/passes/shots-inside-box/gk-saves).
                    STATUS: Preview. Skeleton ready, Training braucht retrain_v3.py-Lauf auf
                    ~43k FootyStats rows. Fällt auf ensemble zurück solange public/lgbm-model-v3.json fehlt.
```

## Tech Stack

| Layer | Technologie |
|---|---|
| Frontend | Next.js 14 App Router, React 18, TypeScript 5.5 |
| Styling | Inline tokens (Leather + Gold), Team-Colors via TheSportsDB |
| State | AppContext + MatchdayContext + sessionStorage |
| Backend | Supabase PostgreSQL + Auth + Row-Level Security |
| AI | Groq Llama 3.3 70B / 3.1 8b-instant (free) · Claude Sonnet 4 |
| Engine | Dixon-Coles 15×15 · Neg-Binomial · LightGBM · Elo · Isotonic Cal |
| Data | Supabase · The-Odds-API · FootyStats · Understat · api-sports · TheSportsDB · Transfermarkt · StatsBomb Open |
| CI | GitHub Actions (Lint · TypeCheck · Test · Build) |
| Hosting | Vercel (auto-deploy on push to main) |

## Scripts

### Daily Operations
```bash
npm run dev              # Lokaler Dev-Server
npm run health           # Datenquellen-Statuscheck (5s)
npm run audit            # Coverage-Report aller Ligen
npm run refresh          # Update odds + matchdays (~3 min)
npm run refresh:full     # + Transfermarkt Injuries (~25 min)
npm run refresh:quick    # Nur odds + audit (~30s)
npm run refresh:odds     # Nur fetch-odds.mjs
```

### Data Ingestion
```bash
# FootyStats CSVs (user-downloaded, in tools/footystats/csv/)
node scripts/import-footystats-csv.mjs --dir tools/footystats/csv

# TheSportsDB Team-Metadata
node scripts/sync-thesportsdb-metadata.mjs --all
node scripts/fill-thesportsdb-missing.mjs --all

# api-sports (historical xG + current injuries)
node scripts/fetch-api-sports-stats.mjs --league championship --season 2024
node scripts/fetch-api-sports-injuries.mjs --all --days 3

# StatsBomb Open Data (event-level training)
python3 tools/statsbomb/download.py
python3 tools/statsbomb/parse.py

# Legacy Understat
node scripts/seed-understat-2526.mjs
```

### Development
```bash
npm run build            # Production Build
npm run test             # 498 Tests (vitest)
npm run test:watch       # Watch-Mode
npm run lint             # ESLint
```

### Maintenance
```bash
npm run suggest-aliases  # TM-Alias-Vorschläge für ungemappte Teams
npm run spieltag         # Admin Spieltag-Wizard (interaktiv)
node scripts/build-tm-team-ids.mjs             # Saison-Wechsel: TM IDs neu
node scripts/backfill-missing-opponents.mjs    # opponent-column pairing fix
```

## Environment Variables

```bash
# Supabase (required)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...

# Live odds (required für refresh)
ODDS_API_KEY=...                    # https://the-odds-api.com (500 free/mo)

# AI (required für Anna + Injury-Parsing)
GROQ_API_KEY=gsk_...                # FREE — https://console.groq.com (500K tokens/day)
# CLAUDE_API_KEY=sk-ant-...         # PAID — alternative zu Groq

# Optional data sources
API_SPORTS_KEY=...                  # https://www.api-football.com (100 free/day)
API_SPORTS_KEY_2=...                # Multi-key rotation → 200/day effective
THESPORTSDB_KEY=123                 # default = public test key (no signup)
FOOTYSTATS_API_KEY=...              # optional, CSVs reichen meist

# Notifications
TELEGRAM_BOT_TOKEN=...              # Value-Bet alerts
TELEGRAM_CHAT_ID=...
```

## Daten-Stand

- **team_xg_history**: ~80k Rows, davon ~71k mit echtem xG (43k FootyStats + 28k Understat)
- **team_metadata**: 342 Team-Rows mit Logo + Color + stable cross-source IDs
- **matchdays**: live JSON pro Liga, EN-richted mit Form + Tags + H2H + Standings
- **bets**: user-bets mit CLV-Tracking, auto-settled via results cron

## Engine Performance (OOS)

| Modell | Brier Score | Notes |
|---|---|---|
| Dixon-Coles (Poisson+NegBin) | 0.6275 | Base |
| Elo Rating (655 Teams) | 0.6185 | |
| Logistic (6 EWMA) | 0.6090 | |
| Market (Pinnacle) | — | Anchor |
| **Ensemble v1** | **0.6076** | Production-default |
| **@annafrick13 v2** | **0.5844** | LightGBM Tweedie, 21 features |
| **@annafrick13 v3** | TBD | Awaiting first training run (43k rows ready) |

Trainiert auf 139.691 Matches (18 Ligen), evaluiert auf 6.691 OOS Matches. Per-Liga-Kalibrierung via Platt + Isotonic Curves.

## Dokumentation

- **[CLAUDE.md](CLAUDE.md)** — Entwickler-Guide für Claude Code (Architektur, Pipelines, Konventionen) — **primärer Einstiegspunkt**
- **[Engine](docs/ENGINE.md)** — Dixon-Coles, NegBin, LightGBM, Kalibrierung, Kelly (mathematisch)
- **[Architecture](docs/ARCHITECTURE.md)** — System-Diagramm, Data Flow, DB Schema
- **[Debugging](docs/DEBUGGING.md)** — Operationaler Runbook: Symptom → Diagnose → Fix
- **[Workflow](WORKFLOW.md)** — Admin Spieltag-Workflow

## Qualität

| Metrik | Wert |
|---|---|
| Build | ✅ 0 Fehler in `src/` |
| Tests | ✅ 498/498 (32 files) |
| TypeScript | Strict Types + Zod Runtime Validation |
| Accessibility | WCAG 2.1 AA (ARIA, Focus, Landmarks) |
| Security | RLS · Cookie-Auth · Rate-Limit auf /api/anna · gitignored secrets |
| Idempotent | Alle Refresh-Scripts + Importer safe to re-run |
