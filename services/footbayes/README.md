# FODZE footBayes R-Service

Hierarchical Bayesian Poisson goal-scoring model (Stan via [footBayes](https://github.com/LeoEgidi/footBayes) v2.1+) with partial-pooling over FODZE's 19 leagues. Nightly fit produces `public/footbayes-posteriors.json` — consumed by `src/lib/footbayes-engine.ts`.

**Status: scaffolding only.** The R files in this directory are documented skeletons. Running the full pipeline requires an external Docker host (Fly.io / Railway / nightly GitHub Action with R + rstan + cmdstanr). The browser runtime already handles an empty/missing posterior file cleanly — see `calcMatchFootBayesLambdas` which returns `null` until teams populate.

## Files

- `Dockerfile` — R 4.3 + cmdstanr + footBayes + rstanarm. Base image: `rocker/tidyverse:4.3`.
- `plumber.R` — tiny HTTP wrapper so a long-running Stan model can be kicked off on demand. Not required for a nightly cron; useful if you want an ad-hoc `/fit?league=bundesliga` endpoint.
- `fit_daily.R` — the actual job. Reads historical match data from Supabase, fits `stan_foot(model="biv_pois_dynamic", hierarchical=TRUE)`, extracts posterior means per team, writes `public/footbayes-posteriors.json`.

## Data contract

### Input (pulled by `fit_daily.R` from Supabase)
```sql
SELECT team, opponent, league, venue, match_date, goals_for, goals_against
FROM team_xg_history
WHERE venue = 'home'              -- keep one perspective per match
  AND match_date >= '2022-07-01'  -- 3 seasons is the footBayes sweet spot
```

### Output (`public/footbayes-posteriors.json`)
```json
{
  "_version": 1,
  "_meta": {
    "method": "biv_pois_dynamic",
    "model_package": "footBayes 2.1",
    "trained_at": "2026-04-20T03:00:00Z"
  },
  "leagues": {
    "bundesliga": { "intercept": 0.25, "home_advantage": 0.19, "n_matches": 612 }
  },
  "teams": {
    "FC Bayern München": {
      "league": "bundesliga",
      "attack_mean":   0.45,  "attack_sd":   0.08,
      "defense_mean": -0.32,  "defense_sd":  0.09
    }
  }
}
```

## Math (for reference — `fit_daily.R` wraps this)

```r
fit <- stan_foot(
  data          = matches,
  model         = "biv_pois_dynamic",
  hierarchical  = TRUE,      # ← partial-pooling via league hyperprior
  dynamic_type  = "weekly",
  predict       = 0,
  iter          = 2000,
  chains        = 4,
  seed          = 42
)
```

The runtime uses only posterior MEANS — posterior SDs are persisted for future uncertainty display but aren't consumed by the current TS engine.

## Deployment options (pick one)

1. **GitHub Actions nightly** (simplest) — runs `fit_daily.R` on `ubuntu-latest`, commits the JSON back to `main`. ~15 min wall-time per fit, free on public repos.
2. **Fly.io Machine with cron** (medium) — $5/mo persistent 256 MB VM, wakes nightly. Scales to ad-hoc refits via `plumber.R`.
3. **Railway / Supabase Edge Function with pg_cron** (advanced) — only worth it if you also want live refits mid-season.

## Nightly contract with the app

- **Cron time**: 03:00 UTC (after day's matches settle).
- **Failure behaviour**: The job `exit 1`s on fit divergence; the last known-good JSON stays in `public/`. Browser runtime continues to serve the previous posterior until the next successful fit.
- **Invalidation**: Rebuild the app OR wire a SWR refetch on Context mount (not done today — the JSON is pinned to build-time in the current AppContext loader).

## KPI gate before promoting Bayes engine

- **Shadow for 300+ matches** comparing against v2:
  - Bundesliga / EPL / La Liga / Serie A / Ligue 1: Brier ≤ v2 ± 0.002
  - Liga 3 / League Two / Greek SL: **Brier gain > 0.003** (this is where hierarchical pooling earns its keep)
- If the Lower-Tier gain is < 0.003, the engine can still ship as a secondary selector option but should not become a default suggestion for any league tier.
