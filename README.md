# FODZE — Quantitative Fußball-Wettanalyse

Quantitative Wettanalyse mit Dixon-Coles Bivariate Poisson Modell, isotonischer Kalibrierung und Kelly-Criterion Staking. **19 Ligen**, **362 Teams** mit Live-Injuries, **186 Tests** grün.

**v7.x** · Next.js 14 · TypeScript · Supabase · Vercel

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

Logs in `~/Library/Logs/fodze-refresh.log`. Stop mit `bash scripts/launchd/install.sh --uninstall`.

## Features

| Feature | Beschreibung |
|---------|-------------|
| **3 Engines** | Standard Ensemble + @annafrick13 v1 (Poisson-ML) + v2 (LightGBM Tweedie) — alle 3 parallel berechnet, aktive Engine im UI gold-getöntem Band hervorgehoben |
| **Goldilocks Bets** | Edge 2.5–7.5% mit dualer Quelle: Markt (Pinnacle vig-removed) + Engine — Konsens = stärkstes Signal. Auf `/goldilocks` als Filter, auf MatchDetail als 🤝-Badge pro Value-Bet |
| **Live-Injuries** | Per Match Verletzungen + Sperren + Yellow-Card-Risiko via Transfermarkt + Groq HTML-Parser. Im UI als 🩹 H:2 / 🩹 A:3 Counter mit Tooltip = volle Liste |
| **Match-Context-Strip** | Form-Dots (●●●○●), Verletzten-Counter, Tag-Badges (Derby/Meisterkampf/Abstiegskampf) direkt über der Probability-Bar — Pipeline-Daten nicht mehr im collapsed Details-Block versteckt |
| **CLV-Tracking** | Closing-Quoten-Snapshot vor Kickoff → echter Edge-Indikator über Variance |
| **Kelly-Criterion** | K/M/A Risiko-Profile mit caps (2.5% / 4% / 6%) |
| **Ask Anna** | KI-Beraterin (Groq Llama 3.3 70B kostenlos / Claude Sonnet) |
| **19 Ligen** | BL, 2.BL, Liga 3, EPL, La Liga, Serie A, Ligue 1, Eredivisie, Championship, Primeira, Jupiler, Süper Lig, La Liga 2, Serie B, Ligue 2, Scottish Prem, Greek SL, League One, League Two |
| **PWA + A11y** | Installierbar, Service Worker, Offline-Cache, WCAG 2.1 AA (kontrast-geprüfte Tokens, `aria-current` auf aktiver Engine, Click-Tooltips für Mobile) |

## Daten-Pipeline

Pro Spieltag wird automatisch enriched:

| Feld | Quelle | Engine-Impact |
|------|--------|---------------|
| `xg_h_history`, `xg_h8` | Understat / Shots-Modell / OpenLigaDB | λ-Berechnung (Hauptinput) |
| `form` ("W D L W W") | team_xg_history letzte 5 | UI anzeige (W/D/L multiplier disabled per Gemini review) |
| `tags` (DERBY, MEISTERKAMPF, ABSTIEGSKAMPF, ROTATION) | Rivalitäten-Map + Standings + Fixtures | applyTagCorrections ±3-6% λ |
| `injuries` ("Player (POS, Reason, bis DATE), …") | **Transfermarkt + Groq** | calcAbsenceImpact ±5-15% λ |
| `yellow_risk` | Transfermarkt "Sperre droht" | UI + future engine input |
| `standings_pos`, `h2h` | team_xg_history | UI display + future features |
| `matchday` Label (z.B. "30. Spieltag") | OpenLigaDB (DE-Ligen) | UI |

## Tech Stack

| Layer | Technologie |
|-------|------------|
| Frontend | Next.js 14 App Router, React 18, TypeScript 5.5 |
| Styling | Inline tokens (Leather + Gold), kein Framework |
| State | AppContext + MatchdayContext + sessionStorage |
| Backend | Supabase PostgreSQL + Auth + Row-Level Security |
| AI | Groq Llama 3.3 70B (kostenlos) / Claude Sonnet 4 / Offline |
| Engine | Dixon-Coles 15×15 + Neg-Binomial + XGBoost + Pinnacle Anchor + SoS + Absences |
| Data | Supabase + The-Odds-API + OpenLigaDB + Transfermarkt + Understat |
| CI | GitHub Actions (Lint, TypeCheck, Test, Build) |
| Hosting | Vercel (auto-deploy on push to main) |

## Scripts

### Daily Operations
```bash
npm run dev              # Lokaler Dev-Server
npm run health           # Datenquellen-Statuscheck (5s)
npm run audit            # Coverage-Report aller 19 Ligen
npm run refresh          # Update odds + matchdays (~3 min)
npm run refresh:full     # + Transfermarkt Injuries (~25 min)
npm run refresh:quick    # Nur odds + audit (~30s)
npm run refresh:odds     # Nur fetch-odds.mjs
```

### Development
```bash
npm run build            # Production Build
npm run test             # 186 Tests (vitest)
npm run test:watch       # Watch-Mode
npm run lint             # ESLint
```

### Maintenance
```bash
npm run suggest-aliases  # TM-Alias-Vorschläge für ungemappte Teams
npm run spieltag         # Admin Spieltag-Wizard (interaktiv)
node scripts/build-tm-team-ids.mjs   # Saison-Wechsel: 362 IDs neu generieren
```

### Background Cron (macOS launchd)
```bash
bash scripts/launchd/install.sh           # both daily + weekly
bash scripts/launchd/install.sh --daily   # nur daily
bash scripts/launchd/install.sh --uninstall
launchctl list | grep com.fodze            # status check
launchctl start com.fodze.refresh          # manueller Trigger
```

## Environment Variables

```bash
# Supabase (required)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...

# Live odds (required für refresh)
ODDS_API_KEY=...                    # https://the-odds-api.com (500 free credits/mo)

# AI (required für Anna + Injury-Parsing)
GROQ_API_KEY=gsk_...                # FREE — https://console.groq.com (500K tokens/day)
# CLAUDE_API_KEY=sk-ant-...        # PAID — alternative zu Groq

# Optional
TELEGRAM_BOT_TOKEN=...              # Value-Bet alerts
TELEGRAM_CHAT_ID=...
FOOTYSTATS_API_KEY=...              # Echte xG für Liga 3 (paid)
```

## Daten-Coverage (Stand 04/2026)

| Liga | xG Coverage | Form Coverage | Injuries Coverage |
|------|-------------|---------------|-------------------|
| Bundesliga / 2.BL / Liga 3 | 100% | 100% | 83-95% |
| EPL / La Liga / Serie A | 95-100% | 100% | 85-95% |
| Ligue 1 / Eredivisie | 100% | 100% | 95-100% |
| Championship | 86% | 100% | 83% |
| Süper Lig | 100% | 100% | 81% |
| Primeira / Jupiler / Greek | 75-100% | 100% | 77-96% |
| La Liga 2 / Serie B / Ligue 2 | 89-100% | 100% | 88-95% |
| League One / League Two | 100% | 100% | 80-85% |

**Gesamt:** 17/19 Ligen mit ≥80% Injuries-Coverage. 352+ live Team-Injury-Einträge.

## Engine Performance (OOS, kein Data Leakage)

| Modell | Brier Score | Gewicht |
|--------|------------|---------|
| Dixon-Coles (Poisson + NegBin) | 0.6275 | 6.0% |
| Elo Rating (655 Teams) | 0.6185 | 22.6% |
| Logistic (6 EWMA Features) | 0.6090 | 51.3% |
| Market-Implied (Pinnacle) | — | 20.0% |
| **Ensemble** | **0.6076** | — |
| @annafrick13 v2 (LightGBM) | **0.5844** | — |

Trainiert auf 139.691 Matches (18 Ligen), evaluiert auf 6.691 OOS Matches. Per-Liga-Kalibrierung via Platt + Isotonic Curves.

## Dokumentation

- **[Engine](docs/ENGINE.md)** — Dixon-Coles, NegBin, XGBoost, Kalibrierung, Kelly (mathematisch detailliert)
- **[Architecture](docs/ARCHITECTURE.md)** — System-Diagramm, Data Flow, DB Schema
- **[Design Handoff](docs/DESIGN-HANDOFF.md)** — Tokens, Komponenten, Responsive, A11y
- **[Workflow](WORKFLOW.md)** — Admin Spieltag-Workflow mit Prompts
- **[CLAUDE.md](CLAUDE.md)** — Entwickler-Guide für Claude Code (Architektur, Pipelines, Konventionen)

## Qualität

| Metrik | Wert |
|--------|------|
| Build | ✅ 0 Fehler in `src/` |
| Tests | ✅ 186/186 (12 files) |
| TypeScript | Strict Types + Zod Runtime Validation |
| Accessibility | WCAG 2.1 AA (ARIA, Focus, Landmarks) |
| Security | RLS + Cookie-Auth + Rate-Limit auf /api/anna |
| Idempotent | Alle Refresh-Scripts safe to re-run |
