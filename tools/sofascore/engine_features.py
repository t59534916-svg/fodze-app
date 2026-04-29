"""
Engine-feature loader for v2/v3 retraining and live prediction.

Pulls per-team chance-quality features from `sofascore_team_rolling_8`
(SQL view defined in scripts/migration-sofascore-views.sql) and returns
them as a tier-aware Python dict keyed by (league, season, team).

Tier-handling:
  premium  → all features available
  partial  → fastbreak_xg unavailable (Liga 3 tagging limitation)
  volume   → all xG-derived features unavailable (La Liga 2, Ligue 2)
             but volume features (avg_shots, avg_shots_in_box) are present

The caller (e.g. tools/retrain_v2.py feature-builder) should:
  1. Fetch features once at the start of training
  2. Look up per-team features via team_features.get((league, season, team))
  3. For features that are None, fall back to the league-median or
     existing tactics-CSV defaults (don't write zero — that biases the
     coefficient).

Usage in retrain_v2.py:

    from tools.sofascore.engine_features import load_team_features

    features_by_team = load_team_features(seasons=["25/26"])
    # ... in the per-match feature builder:
    home_feat = features_by_team.get((row.league, row.season, row.home_team), {})
    setpiece_diff = (home_feat.get("avg_setpiece_xg_share")
                     or DEFAULT_SETPIECE) - ...
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Iterable

# Lazy env load — same pattern as load_to_supabase.py
_REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_env_once() -> None:
    if os.environ.get("_FODZE_ENV_LOADED"):
        return
    p = _REPO_ROOT / ".env.local"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())
    os.environ["_FODZE_ENV_LOADED"] = "1"


def _supa_get(path: str, params: dict) -> list[dict]:
    _load_env_once()
    base = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not base or not key:
        raise RuntimeError("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY")
    qs = urllib.parse.urlencode(params)
    url = f"{base}/rest/v1/{path}?{qs}"
    req = urllib.request.Request(url, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
    })
    out = []
    # PostgREST default page is 1000; paginate via Range
    offset = 0
    PAGE = 1000
    while True:
        page_req = urllib.request.Request(
            f"{url}&limit={PAGE}&offset={offset}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(page_req, timeout=30) as resp:
            page = json.loads(resp.read().decode())
        if not page:
            break
        out.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
    return out


def load_team_features(
    *,
    leagues: Iterable[str] | None = None,
    seasons: Iterable[str] = ("25/26",),
) -> dict[tuple[str, str, str], dict]:
    """Returns {(league, season, team): row_dict_with_chance_quality_features}.

    Each row has all columns of sofascore_team_rolling_8:
      games_in_window, avg_shots, avg_shots_in_box, avg_shots_on_target,
      avg_goals, avg_sum_xg, avg_sum_xgot, avg_mean_shot_xg,
      avg_setpiece_xg_share, avg_big_chance_share, avg_header_share,
      avg_openplay_xg, avg_fastbreak_xg, data_quality_tier,
      most_recent_match_ts.

    NULL values stay as Python None — the caller decides on fallbacks.
    """
    params = {
        "select": "*",
        "season": "in.(" + ",".join(f'"{s}"' for s in seasons) + ")",
    }
    if leagues:
        params["league"] = "in.(" + ",".join(leagues) + ")"

    rows = _supa_get("sofascore_team_rolling_8", params)
    return {(r["league"], r["season"], r["team"]): r for r in rows}


# Defaults to use when a team's chance-quality data is missing or NULL.
# Calibrated to the cross-Tier-A medians from the 25/26 audit.
DEFAULTS = {
    "avg_setpiece_xg_share":  0.27,    # premium leagues mean
    "avg_big_chance_share":   0.10,
    "avg_header_share":       0.18,
    "avg_mean_shot_xg":       0.115,
    "avg_fastbreak_xg":       0.18,    # Liga 3 should NOT use this default
                                       # — flag missing tier appropriately
}


def feature_with_fallback(
    team_row: dict | None,
    feature: str,
    *,
    require_xg: bool = True,
) -> float:
    """Pick a feature value with sensible fallback.

    If `require_xg` is True and the team's tier is 'volume' (no xG model
    coverage), returns the cross-league default — caller should likely
    weight this match lower in training (or filter out la_liga2/ligue_2
    from xG-feature training entirely).
    """
    if team_row is None:
        return DEFAULTS.get(feature, 0.0)
    val = team_row.get(feature)
    if val is None:
        return DEFAULTS.get(feature, 0.0)
    return float(val)


if __name__ == "__main__":
    # CLI smoke-test
    feats = load_team_features(seasons=("25/26",))
    print(f"Loaded {len(feats)} team-rows across all leagues")
    by_tier = {}
    for k, v in feats.items():
        tier = v.get("data_quality_tier", "?")
        by_tier[tier] = by_tier.get(tier, 0) + 1
    for tier, n in sorted(by_tier.items()):
        print(f"  {tier}: {n} teams")
    # Sample one premium team
    sample_keys = sorted(k for k, v in feats.items() if v.get("data_quality_tier") == "premium")[:3]
    for k in sample_keys:
        r = feats[k]
        print(f"\n  {k} → games={r['games_in_window']} "
              f"shots={r['avg_shots']} xg={r['avg_sum_xg']} "
              f"setpiece={r['avg_setpiece_xg_share']} "
              f"bigchance={r['avg_big_chance_share']}")
