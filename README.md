# FODZE — Quantitative Fußball-Wettanalyse

Quantitative Wettanalyse mit Dixon-Coles Bivariate Poisson, **isotonic + Benter calibration**, **Conformal Prediction Gates** und Kelly-Criterion Staking. **22 Ligen** live + 2 European cups, **4 Prediction-Engines** parallel, **~87.000 xG-history-rows** aus 7 Datenquellen, **6.856 Sofa-extras games** (100% v1+v2 coverage seit 2026-05-10), **965 Tests** grün.

**Next.js 16** · React 19 · TypeScript · Supabase · Vercel

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
npm run health          # 5-Sekunden Statuscheck aller Datenquellen (CLI)
npm run refresh         # Schnell-Update — odds + matchdays (~3 min)
npm run refresh:full    # Voll inkl. Injuries via Transfermarkt (~25 min)
npm run audit           # Coverage-Report pro Liga
```

**Live System-State im Browser:** [`/health`](https://fodze-app-master.vercel.app/health) — Welche Calibration-Layer geladen, welche Supabase-Tabellen frisch/stub/empty, welche Datenquellen seit wann stale. 4 Sections, ~20 parallele Supabase-Calls, REFRESH-Button.

**Automatisch (macOS):**
```bash
bash scripts/launchd/install.sh   # täglich 07:30 + Di/Fr 19:00
```

## Features

| Feature | Beschreibung |
|---|---|
| **4 Engines parallel** | Standard Ensemble · @annafrick13 v1 (Poisson-ML) · v2 (LightGBM Tweedie, production) · v3 (Lean 20-Feature LightGBM, Brier 0.6318, preview-only). Engine-Toggle microsecond-fast dank Pre-Compute |
| **Phase 2.x Calibration Layer** ✨ | **isotonic** Kalibrierung (Dirichlet wurde 2026-04-26 nach current-season-Backtest wieder REVERTED — drift +0.0075 Brier; siehe CLAUDE.md), per-Liga Benter Market×Modell-Blend (super_lig β₂=1.31, EPL β₂=1.17), Conformal Staking-Gate in `warn`-Mode (flip-to-enforce seit 2026-05-28-Refit freigeschaltet), fitted Per-Liga Negative-Binomial-Overdispersion (-30% bis -52% vs. Defaults). Aktiv: isotonic + Benter + Conformal(warn) + Overdispersion |
| **Goldilocks-Zone Per-Liga 3-Tier** | Sharp (1.5-5%) / Moderate (2.5-7.5%) / Soft (3.5-8.5%) — automatische Tier-Erkennung pro Liga. Soft-Skip + Hard-Trap-Banner getrennt. Dual-source Edge (Markt vig-removed + Engine-Prob) als Konsens-Indikator |
| **Team-Logos + Colors** | 398 Teams via TheSportsDB mit echten Badges statt Generic-Kit-SVG. Accent-Gradient pro MatchCard (home-color → away-color linke Border) |
| **Live-Injuries** | Pro Team via Transfermarkt + Groq HTML-Parser ODER api-sports structured endpoint (kein Scraping-Risk). Im UI als 🩹 H:2 · 🩹 A:3 Counter |
| **Match-Context-Strip** | Form-Dots (W/D/L), Verletzten-Counter, Tag-Badges (Derby/Meisterkampf/Abstiegskampf) direkt über der Probability-Bar |
| **Post-Match Backtest** | `/backtest` zeigt Brier/LogLoss per Engine + Bootstrap-CIs (95%) + Physical-Markets (xShots/xCorners MAE vs actual) + Hindsight-Free Replay gegen team_xg_history |
| **CLV-Forward-Cache** | Snapshot-Cron persistiert ALLE in-window Sharp-Closes nach `odds_closing_history` (auch ohne aktive User-Bet) → retroaktiv platzierte Bets können CLV-recovered werden |
| **Manual Bet Tracker** | Bypass für Engine-Value-Filter — alle Wetten trackbar, auch außerhalb Goldilocks (z.B. Liebhaber-Bets) |
| **CLV-Feedback Kelly-Dampening** | Per-Liga last-40-bets z-score < -1 → halbiert Kelly-Stake automatisch |
| **Engine Health Dashboard** | `/health` zeigt Live-State aller Calibration-Layer + Supabase-Tabellen + Datenquellen-Freshness + Bet-Coverage in einer Ansicht |
| **Kelly-Criterion** | K/M/A Risiko-Profile mit caps (2.5% / 4% / 6%) + Variance-Haircut via Bootstrap-CI |
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

> 📋 **Vollständige Datenpunkt × Engine Matrix:** [`docs/DATAPOINTS-OVERVIEW.md`](docs/DATAPOINTS-OVERVIEW.md) (color-coded: 🟢 Standard / 🟣 v1 / 🔵 v2 / 🟦 v3 / 🟧 Calibration / 🟥 Backtest / 🟨 UI)

**7 Primary-Quellen** für echte xG-Ground-Truth (team_xg_history, ~87k Rows):

| Source | Rows | Coverage |
|---|---|---|
| **FootyStats** CSVs (1 Credit/Liga-Saison) | ~76.600 | 22 Ligen × 5 Saisons 2021-2026. Real xG + shots + possession + cards + referee. Fresh täglich |
| **Understat** (browser-script) | ~28.700 | Top-5 + Eredivisie, 2017-05-2025. Real xG + npxG + PPDA + Deep Completions. Stale (season-end 2025-05) |
| **api-sports v3** (Free 100 calls/Tag, 2-Key rotation) | ~23 (current) | Key 1 active für current-season injuries via `?date=`, Key 2 suspended. Free-Tier kein current-season Match-data |
| **shots-model** (shots→xG regression) | ~5.500 | Fallback wo FootyStats Lücken hat (Bundesliga2 etc) |
| **goals-proxy** | ~1.440 | Liga 3 goals via OpenLigaDB (xG geschätzt) |

**Closing-Odds (`odds_closing_history`, ~25k Rows):**
| Source | Rows | Status |
|---|---|---|
| football-data.co.uk Pinnacle Closing | ~24.700 | ⚠ STALE — Source publiziert PSCH-Spalten seit 2026-01-14 nicht mehr für aktuelle Saisons |
| live-odds-snapshot (forward-cache) | wachsend | ✅ Seit 2026-04-26: jeder 4h-Cron persistiert in-window Sharp-Closes — retroaktive Bet-CLV-Recovery möglich |

**Metadaten-Quellen:**
| Source | Zweck | Abdeckung |
|---|---|---|
| TheSportsDB v1 | Team-Logos, Colors, Stadium, cross-source IDs | 398 Teams · idAPIfootball bridge |
| Transfermarkt + Groq | Injuries + Sperren + Yellow-Risk | 406 IDs (22 Ligen) · 153 Aliase |
| The-Odds-API | Live-Odds + Fixtures | 500 free Credits/Monat — **Multi-Key Rotation** (`ODDS_API_KEY` + `ODDS_API_KEY_2..._10`), effektives Budget = N × 500 |
| OpenLigaDB | DE-Liga "30. Spieltag" Labels + Liga 3 goals-proxy | DE-only |
| **Sofascore (datafc lib)** | **Per-Shot xG / Coords / Body-part / Situation** | **92.898 shots × 3.736 matches Saison 25/26 (Tier-A 11 Ligen)** |
| StatsBomb Open Data | Event-level Training-Rohstoff (1431 Events, 2862 aggregates) | WM/EM/CL + La Liga 18 Saisons |
| player_xg_history | Per-Player xG-per-90 für xGChain-Hydration | 2500 rows, Top-5 Ligen only |
| referees | Per-Referee Foul/Yellow-Bias-Profile | 354 rows ⚠ STUB-Daten (fouls NULL, 1 distinct bias-value) |
| stadiums | Lat/Lng/Capacity per Heim-Stadion | 278 rows, altitude 0%, capacity 30% Join-Coverage |

**Sofascore Pipeline (vollständig seit 2026-05-10):**
- **Library:** [`datafc`](https://pypi.org/project/datafc/) für shotmap, [`tls_requests`](https://pypi.org/project/wrapper-tls-requests/) (bogdanfinn TLS-fingerprint) für extras
- **Match-Universe:** 6.856 ended games × 22 Ligen × Saison 25/26
- **Shotmap:** `sofascore_match` (7.099 rows) + `sofascore_shotmap` (174.902 shot events)
- **V1 Extras (4 endpoints):** `sofascore_match_statistics` (39.666 rows) + `sofascore_player_match_stats` (lokal-only 279.832 rows in SQLite) + `sofascore_incidents` (139.793) + `sofascore_average_positions` (211.240)
- **V2 Extras (3 HIGH-SIGNAL endpoints):** `sofascore_match_managers` (13.703) + `sofascore_pregame_form` (13.228) + `sofascore_team_streaks` (75.252)
- **Bridge → team_xg_history:** 18 feature-cols (big_chances/possession/tackles/cards/goals_prevented) via `bridge-sofascore-extras-to-team-xg.mjs`
- **Tier-Klassifikation:** 16 premium / 1 partial / 5 volume (alle 22 Ligen)
- **Cloudflare-Bypass:** `--use-tls-requests` flag (bogdanfinn fingerprint, kein Proxy nötig). curl_cffi chrome124 wurde am 2026-05-10 von CF blockiert; tls_requests passiert.
- **Local SQLite Mirror:** `tools/sofascore/data/local_extras.db` (253 MB) spiegelt alle 7 Tabellen + `sofascore_match` lokal. Speichert auch player_match_stats die Supabase wegen Free-tier 500MB cap skipped.
- **Cron:** Phase 4 (shotmap) + Phase 6 (extras) in `refresh-all.mjs`

## Prediction Engines

```
v1 (ensemble-v1)    4-Modell Ensemble: Dixon-Coles (6%) + Elo (22%) + Logistic (51%) + Market (20%)
                    Trainiert auf 139k Matches. Brier: 0.6518 (raw), 0.6500 mit Dirichlet.

@annafrick13 v1     Poisson-GLM → 15×15 Dixon-Coles Matrix. 9 Features. Refuses to predict ohne xG-Historie.

@annafrick13 v2     LightGBM Tweedie, 21 Features (npxG, PPDA, Deep, game-state xG shares).
                    Monotonic Constraints, Optuna-tuned ρ=-0.094.
                    Brier: 0.6102 (raw), 0.6083 mit Dirichlet+Benter — PRODUCTION default.

@annafrick13 v3     LightGBM Tweedie, Lean 20 Features (xG core + Elo + h2h + physis + discipline).
                    Optuna 50-trial tuning + 90-day recency-decay. Trainiert auf 76.611 FootyStats rows.
                    Brier: 0.6318 (Holdout n=6498), drift home +1.2% / away -1.8%.
                    STATUS: Preview-only — bleibt im shadow bis schema-equivalent zu v2 erreicht
                    (gap 0.024 ist strukturell, nicht hyperparameter-fixable).
```

**Phase 2.x Calibration Layer** (alle 4 LIVE in Production seit 2026-04-26):

| Layer | Wirkung | Effekt auf v2 Brier |
|---|---|---|
| Dirichlet 1X2 (3-Cluster ODIR) | 3-Klassen joint Calibration statt per-Markt Platt | -0.0019 (gemessen), ECE 0.0146 → 0.0049 |
| Benter Market×Modell-Blend | per-Liga β₁/β₂ aus n=5586 OOT — Modell schlägt Markt in 6/16 Ligen | super_lig β₂=1.31, EPL β₂=1.17 |
| Conformal Staking-Gate | Prediction-Set Coverage 96.7% @ α=0.05 | mode=warn — set-size logging, kein Kelly-Skaling |
| Per-Liga Overdispersion α | Fitted alphas statt konservative Defaults | tighter O25/U25 PMFs (serie_a -52%, la_liga -31%) |

**Live Engine Hit-Rate** (n=104 settled matches, Stand 2026-05-03 — first 2 weeks of cross-engine tracking):

| Engine | 1X2 Hit-Rate | Brier | High-Conf (>60%) Hit | Bundesliga only (n=62) |
|---|---|---|---|---|
| **@annafrick13 v1** | **49.0%** 🥇 | 0.6745 | 58.3% | **50%** 🥇 |
| Standard (ensemble-v1) | 42.3% | **0.6293** 🥇 | **61.1%** | 42% |
| @annafrick13 v2 | 42.3% | 0.7012 | 44.4% ⚠ over-confident | 42% |
| @annafrick13 v3 | 38.5% (n=13) | 0.6826 | — | 33% |

**Confidence-Band findings**:
- 🟢 **Gold-Zone**: @annafrick13 v1 in 60-70% Confidence-Band → **68% Hit-Rate** (perfekt kalibriert)
- 🔴 **Trap-Zone**: @annafrick13 v1 mit >70% Claim → nur 47% Hit (Over-Confidence)
- 🔴 **Trap-Zone**: @annafrick13 v2 in 60-70% Band → 42% Hit vs 65% Claim
- Standard ist überraschend solide bei 50-70% Conf-Band (61-65% Hit)

→ Best practical filter: **Multi-Engine-Konsens** (alle 4 zeigen gleiche Richtung) — operationalisiert in `/goldilocks` Konsens-Filter.

## Tech Stack

| Layer | Technologie |
|---|---|
| Frontend | Next.js 16 App Router, React 19, TypeScript 5.5 |
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
npm run test             # 965 Tests (vitest)
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

# Live odds (required für refresh) — Multi-Key Rotation seit 2026-04-29
ODDS_API_KEY=...                    # https://the-odds-api.com (500 free/mo)
ODDS_API_KEY_2=...                  # Optional 2nd account → 1000/mo effective. Rotiert auto bei 401/429
# ODDS_API_KEY_3, _4, ..._10        # Bis zu 10 Keys via _lib/odds-api.mjs

# AI (required für Anna + Injury-Parsing)
GROQ_API_KEY=gsk_...                # FREE — https://console.groq.com (500K tokens/day)
# CLAUDE_API_KEY=sk-ant-...         # PAID — alternative zu Groq

# Calibration Layer (Phase 2.x — defaults below match production setup)
NEXT_PUBLIC_CALIBRATION_METHOD=isotonic     # isotonic (default seit 2026-04-26 revert) | dirichlet | platt
NEXT_PUBLIC_BENTER_BLEND=on                 # on | shadow | off — per-Liga β-Blend
NEXT_PUBLIC_CONFORMAL_GATE=warn             # off | warn | dampen | enforce

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

- **team_xg_history**: 103.037 Rows, davon ~95k mit echtem xG (76.6k FootyStats + 28k Understat). 22 Ligen, 2017-2026
- **odds_closing_history**: 24.681+ Rows (football-data.co.uk + live-odds-snapshot)
- **team_metadata**: 398 Team-Rows mit Logo + Color + stable cross-source IDs
- **matchdays**: live JSON pro Liga, enriched mit Form + Tags + H2H + Standings + Injuries + Yellow-Risk
- **bets**: user-bets mit CLV-Tracking, auto-settled via results cron

## Engine Performance (OOS, n=6691)

| Modell | Brier 1X2 | BSS | LogLoss | ECE | Notes |
|---|---|---|---|---|---|
| Uniform Baseline | 0.6505 | 0.000 | — | — | Reference |
| Dixon-Coles (Poisson+NegBin) | 0.6275 | +0.035 | — | — | Base |
| Elo Rating (655 Teams) | 0.6185 | +0.049 | — | — | |
| Logistic (6 EWMA) | 0.6090 | +0.064 | — | — | |
| **v1 Ensemble** | **0.6518** | -0.002 | 1.083 | 0.084 | Standard fallback |
| **v2 raw** | **0.6102** | +0.062 | 1.018 | 0.0146 | LightGBM Tweedie, 21 features |
| **v2 + Dirichlet (PROD)** | **0.6083** | +0.065 | 1.015 | **0.0049** | Live default seit 2026-04-26 |
| **v3 Lean** (preview) | 0.6318 | — | 1.049 | — | 20 features, Optuna+90d-recency |

Trainiert auf 139.691 Matches (18 Ligen) für v1/v2, 76.611 FootyStats rows (22 Ligen) für v3. Per-Liga-Kalibrierung via Dirichlet 3-Cluster (top5/mid_european/lower) + per-Liga Benter Blend.

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
| Tests | ✅ 550/550 (36 files) |
| TypeScript | Strict Types + Zod Runtime Validation |
| Accessibility | WCAG 2.1 AA (ARIA, Focus, Landmarks) |
| Security | RLS · Cookie-Auth · Rate-Limit auf /api/anna · gitignored secrets |
| Idempotent | Alle Refresh-Scripts + Importer safe to re-run |
| Calibration ECE | 0.0049 (3× besser als legacy 0.0146) |
