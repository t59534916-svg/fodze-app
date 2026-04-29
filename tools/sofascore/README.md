# Sofascore shot-event pipeline

Per-shot xG / location / situation data from Sofascore via [`datafc`](https://pypi.org/project/datafc/) (curl_cffi-based, bypasses Cloudflare without a headless browser). Replaces the hard-coded Phase 2.4 setpiece-share defaults with measured per-team values.

## Files

- `tournament_ids.py` — verified league → Sofascore-id map (22 FODZE leagues)
- `fetch_shots.py` — orchestrator. Pulls match metadata + shots per (league, week)
- `fill_matches.py` — one-shot helper to backfill `matches` field in JSONs predating the loader split
- `load_to_supabase.py` — bulk-upserts JSONs into `sofascore_match` + `sofascore_shotmap`
- `engine_features.py` — engine-side helper that loads per-team rolling-8 chance-quality features

## Data-quality matrix (verified 2026-04-30 against 25/26 backfill)

| Tier | Leagues | xG | Annotation | Engine-features available |
|---|---|---|---|---|
| `premium` | bundesliga, bundesliga2, epl, la_liga, serie_a, serie_b, ligue_1, championship | ✓ | ✓ assisted/fast-break/regular split | all |
| `partial` | liga3 | ✓ | ⚠ all open-play tagged as `regular` | all except `fastbreak_xg` |
| `volume` | la_liga2, ligue_2 | ❌ all NULL | ✓ | only volume (shots, shots_in_box, shots_on_target) |

Use `sofascore_data_quality_tier(league)` SQL function or `data_quality_tier` column on the views to gate feature consumption.

## SQL views

```sql
-- Per-game per-team chance quality
SELECT * FROM sofascore_team_chance_quality
WHERE league = 'bundesliga' AND season = '25/26'
ORDER BY game_id, is_home;

-- Per-team rolling last-8-games (engine input shape)
SELECT * FROM sofascore_team_rolling_8
WHERE league = 'bundesliga' AND season = '25/26'
ORDER BY team;
```

## Engine integration (v2 retrain)

The `engine_features.py` helper exposes a single function:

```python
from tools.sofascore.engine_features import load_team_features, feature_with_fallback

# Load once at start of training
features = load_team_features(seasons=("25/26",))

# Per-match in the feature builder
home_row = features.get((row.league, row.season, row.home_team))
away_row = features.get((row.league, row.season, row.away_team))

# Phase 2.4 setpiece feature — replace the 0.15 default with measured value
home_setpiece = feature_with_fallback(home_row, "avg_setpiece_xg_share")
away_setpiece = feature_with_fallback(away_row, "avg_setpiece_xg_share")
setpiece_diff = home_setpiece - away_setpiece     # ← feature #14 in retrain_v2

# Tier-aware: skip xG-derived features when tier=='volume'
if home_row and home_row["data_quality_tier"] == "volume":
    # La Liga 2 / Ligue 2 — fall back to existing tactics-CSV defaults
    pass
```

## Cron integration

```bash
# In refresh-all.mjs, add as a step after fetch-odds:
node scripts/sync-sofascore-shotmap.mjs --tier A
```

Resume-capable: re-runs only fetch the new weeks (idempotent).

## Backfill from scratch

```bash
# 1. Setup (once)
tools/venv/bin/pip install datafc

# 2. Fetch all Tier-A leagues for current season (~10 min)
tools/venv/bin/python3 tools/sofascore/fetch_shots.py --tier A --season 25/26 --all-weeks

# 3. Load to Supabase
tools/venv/bin/python3 tools/sofascore/load_to_supabase.py --all
```

## Coordinate system caveat

Sofascore `shooter_x` is **distance to goal** in [0, 100], not the away-team-side perspective:

- `shooter_x = 0` → on the goal line
- `shooter_x = 50` → halfway
- **In-box ≈ `shooter_x < 17`** (16.5m of pitch length / ~100m)

A naive `> 83` filter returns zero shots. The view already uses `< 17`.

## Verified empirical anchor (25/26 audit)

| Liga | shots | games | xG-null% | calibration (goals/xG) |
|---|---|---|---|---|
| bundesliga | 7387 | 279 | 0.2% | **1.014** |
| bundesliga2 | 7513 | 279 | 0.3% | 0.950 |
| epl | 8436 | 339 | 0.4% | 0.972 |
| la_liga | 8252 | 330 | 0.2% | 0.973 |
| serie_a | 8410 | 340 | 0.2% | 0.954 |
| serie_b | 9417 | 360 | 0.6% | 0.969 |
| ligue_1 | 6840 | 277 | 0.3% | 0.966 |
| championship | 11496 | 459 | 0.4% | **0.998** ← best calibration |
| **liga3** | 8440 | 326 | 0.3% | 0.975 (xG works, annotation degraded) |
| **la_liga2** | 10218 | 407 | **100%** | – (no xG) |
| **ligue_2** | 6489 | 287 | **100%** | – (no xG) |

Sofascore xG ratios all 0.95–1.014 → very consistent quality where xG exists.
