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


# ─── v2-retraining helper: tactics-data shape ──────────────────────────
# Mirrors load_tactics_data() in tools/retrain_v2.py — returns dict keyed
# by (league, season, team) with {setpiece_xg_share, late_game_xg_share,
# losing_state_xg_diff}. Sofascore covers setpiece_xg_share with measured
# values; the other two stay at the existing CSV defaults (0.20 / 0.0)
# since Sofascore has no direct equivalent.
#
# Team-name resolution: the training corpus uses canonical FODZE names
# (post 2026-04-27 dedupe — see CLAUDE.md "Team-Name Canonicalization").
# Sofascore uses its own canonical local names. We pre-resolve via
# normalize+fuzzy substring matching against the supplied corpus_team_set
# so the resulting dict's keys match training-corpus lookups exactly.

import re
import unicodedata
from collections import defaultdict

_PREFIX_TOKENS = {"fc","afc","rcd","rc","sc","sv","vfl","vfb","vfr","ac","as","us",
                  "1fc","1fsv","fk","ks","ssc","ssd","dsc","tsv","tsg","ud","cd","cf",
                  "asd","scs"}
_SUFFIX_TOKENS = {"fc","cf","ac","ud","cd","1908","1909","1907","98","1900",
                  "04","05","06","07","1899","1923","1900","piraeus","piraus",
                  "thessaloniki","athens","crete","kreta"}


def _normalize(s):
    if not s: return ""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower().replace("ß", "ss")
    words = re.findall(r"[a-z0-9]+", s)
    while words and words[0] in _PREFIX_TOKENS: words.pop(0)
    while words and words[-1] in _SUFFIX_TOKENS: words.pop()
    return "".join(words) or _normalize_simple(s)


def _normalize_simple(s):
    """Fallback if prefix/suffix-strip empties the string."""
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFD", str(s).lower()))


_MANUAL_ALIASES = {
    # training-corpus name → Sofascore name (case where normalize doesn't match)
    "Athletic Bilbao": "Athletic Club",
    "Olympique Marseille": "Marseille",
    "OGC Nizza": "Nice",
    "Stade Rennes": "Rennes",
    "OFI Kreta": "OFI Crete",
    "Olympiakos Piraeus": "Olympiakos",
    "Borussia Mönchengladbach": "Borussia M'gladbach",
    "Borussia Monchengladbach": "Borussia M'gladbach",
    "Vitória Guimarães": "Vitória SC",
    "Vitoria Guimaraes": "Vitória SC",
}


def load_sofascore_tactics_features(
    *,
    corpus_team_names_per_league: dict[str, set[str]],
    season_label_in_csv: str = "2025/26",
    sofascore_season: str = "25/26",
    setpiece_default: float = 0.15,
    late_game_default: float = 0.20,
    losing_state_default: float = 0.0,
):
    """
    Build a tactics_data-shaped dict from Sofascore per-shot xG aggregates.

    Returns: {(league, season_label_in_csv, training_team_name): {
        'setpiece_xg_share': <measured>,
        'late_game_xg_share': <default>,
        'losing_state_xg_diff': <default>,
    }}

    `corpus_team_names_per_league` lets us pre-resolve Sofascore team names
    to whatever spelling the training corpus uses — so retrain_v2.py's
    existing tactics_data.get((lg, season_str, ht)) lookups succeed.
    """
    rows = _supa_get("sofascore_team_chance_quality", {
        "select": "league,team,setpiece_xg_share,sum_xg,data_quality_tier",
        "data_quality_tier": "eq.premium",
    })

    # Aggregate per (league, sofa_team) → season-level setpiece share
    agg = defaultdict(lambda: {"setpiece_xg": 0.0, "total_xg": 0.0, "n": 0})
    for r in rows:
        if r.get("sum_xg") is None or r.get("setpiece_xg_share") is None:
            continue
        sxg = float(r["sum_xg"]) * float(r["setpiece_xg_share"])
        a = agg[(r["league"], r["team"])]
        a["setpiece_xg"] += sxg
        a["total_xg"] += float(r["sum_xg"])
        a["n"] += 1

    # Resolve sofa-team-name → corpus-team-name per league
    out: dict = {}
    matched = unmatched = 0
    for (lg, sofa_team), v in agg.items():
        if v["n"] < 3 or v["total_xg"] < 0.5:
            continue
        share = round(v["setpiece_xg"] / v["total_xg"], 4)
        corpus_teams = corpus_team_names_per_league.get(lg, set())
        if not corpus_teams:
            continue

        # 1) exact
        if sofa_team in corpus_teams:
            target = sofa_team
        else:
            # 2) reverse manual-alias lookup (corpus → sofa)
            target = None
            for ct in corpus_teams:
                if _MANUAL_ALIASES.get(ct) == sofa_team:
                    target = ct
                    break
            if target is None:
                # 3) normalized + substring
                sofa_norm = _normalize(sofa_team)
                # build per-league corpus normalize lookup once
                corpus_norm = {ct: _normalize(ct) for ct in corpus_teams}
                # exact-normalized
                for ct, cn in corpus_norm.items():
                    if cn == sofa_norm:
                        target = ct; break
                if target is None:
                    # substring (length-guarded ≥4)
                    for ct, cn in corpus_norm.items():
                        if len(sofa_norm) >= 4 and (sofa_norm in cn or cn in sofa_norm):
                            target = ct; break

        if target is None:
            unmatched += 1
            continue

        out[(lg, season_label_in_csv, target)] = {
            "setpiece_xg_share": share,
            "late_game_xg_share": late_game_default,
            "losing_state_xg_diff": losing_state_default,
        }
        matched += 1

    print(f"  Sofascore tactics: matched {matched} (sofa→corpus), unmatched {unmatched}")
    return out


def load_sofascore_chance_quality_features(
    *,
    corpus_team_names_per_league: dict[str, set[str]],
    season_label_in_csv: str = "2025/26",
):
    """
    Build a per-team season-level dict of 4 chance-quality features from
    Sofascore. Used by retrain_v2.py to inject as features 21-24 (the new
    block beyond the existing 21-feature setpiece-only integration).

    Returns: {(league, season_label_in_csv, training_team_name): {
        'big_chance_share':     <fraction shots with xg>0.3>,
        'fastbreak_xg_share':   <fastbreak_xg / total_xg>,
        'header_share':         <fraction header shots>,
        'mean_shot_xg':         <total_xg / total_shots>,
    }}

    All values are season-level aggregates from premium-tier Sofascore data
    (computed correctly: sum-of-numerator / sum-of-denominator, NOT mean of
    per-game shares). Teams missing from Sofascore are absent — caller
    should treat as NaN, not zero.
    """
    rows = _supa_get("sofascore_team_chance_quality", {
        "select": "league,team,sum_xg,shots,big_chance_share,fastbreak_xg,header_share,data_quality_tier",
        "data_quality_tier": "eq.premium",
    })

    # Aggregate per (league, sofa_team) — accumulate raw numerators + shot counts
    agg = defaultdict(lambda: {
        "total_xg": 0.0, "total_shots": 0, "total_fastbreak_xg": 0.0,
        # big_chance + header are per-game shares; compute weighted by shots
        "weighted_big_chance": 0.0, "weighted_header": 0.0, "n": 0,
    })
    for r in rows:
        if r.get("sum_xg") is None or r.get("shots") is None:
            continue
        a = agg[(r["league"], r["team"])]
        sxg = float(r["sum_xg"])
        n_shots = int(r["shots"])
        a["total_xg"] += sxg
        a["total_shots"] += n_shots
        a["total_fastbreak_xg"] += float(r.get("fastbreak_xg") or 0.0)
        # weight per-game shares by number of shots (= reconstruct count-weighted average)
        bc = float(r.get("big_chance_share") or 0.0)
        hd = float(r.get("header_share") or 0.0)
        a["weighted_big_chance"] += bc * n_shots
        a["weighted_header"] += hd * n_shots
        a["n"] += 1

    out: dict = {}
    matched = unmatched = 0
    for (lg, sofa_team), v in agg.items():
        if v["n"] < 3 or v["total_shots"] < 10:
            continue
        big_chance = round(v["weighted_big_chance"] / v["total_shots"], 4)
        header = round(v["weighted_header"] / v["total_shots"], 4)
        mean_shot_xg = round(v["total_xg"] / v["total_shots"], 4) if v["total_shots"] else 0.0
        fastbreak_share = round(v["total_fastbreak_xg"] / v["total_xg"], 4) if v["total_xg"] > 0 else 0.0

        # Reuse the same name-resolution logic as load_sofascore_tactics_features
        corpus_teams = corpus_team_names_per_league.get(lg, set())
        if not corpus_teams:
            continue
        target = None
        if sofa_team in corpus_teams:
            target = sofa_team
        else:
            for ct in corpus_teams:
                if _MANUAL_ALIASES.get(ct) == sofa_team:
                    target = ct; break
            if target is None:
                sofa_norm = _normalize(sofa_team)
                corpus_norm = {ct: _normalize(ct) for ct in corpus_teams}
                for ct, cn in corpus_norm.items():
                    if cn == sofa_norm:
                        target = ct; break
                if target is None:
                    for ct, cn in corpus_norm.items():
                        if len(sofa_norm) >= 4 and (sofa_norm in cn or cn in sofa_norm):
                            target = ct; break
        if target is None:
            unmatched += 1
            continue

        out[(lg, season_label_in_csv, target)] = {
            "big_chance_share":     big_chance,
            "fastbreak_xg_share":   fastbreak_share,
            "header_share":         header,
            "mean_shot_xg":         mean_shot_xg,
        }
        matched += 1

    print(f"  Sofascore chance-quality: matched {matched} (sofa→corpus), unmatched {unmatched}")
    return out


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
