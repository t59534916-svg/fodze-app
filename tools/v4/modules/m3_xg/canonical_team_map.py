"""
m3_xg.canonical_team_map — Python-side canonical team-name lookup.

Loads the (league, raw_name) → canonical map dumped by
`scripts/dump-canonical-team-map.mjs` (which uses canonical-team.mjs as
the source of truth — same logic the project's JS ingest scripts use).

Why: fuzzy_team_normalize() (lowercase + diacritic-strip + prefix-strip)
doesn't handle cross-language ("Munich" vs "München") or registry-aliases
("Espanol" vs "Espanyol Barcelona"). 25/26 holdout bridge rate was 13.3%
with fuzzy alone — expected ~80%+ with this canonical map.

Re-generate: `node scripts/dump-canonical-team-map.mjs`
"""
from __future__ import annotations

import json
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Dict, Optional

REPO_ROOT = Path(__file__).resolve().parents[4]
MAP_PATH = REPO_ROOT / "tools" / "v4" / "diagnostics" / "canonical-team-map.json"


@lru_cache(maxsize=1)
def _load_map() -> Dict[str, Dict[str, str]]:
    """Lazy-load + cache the JSON map.

    Structure: {league: {lowercase_name: canonical_name}}
    """
    if not MAP_PATH.exists():
        raise FileNotFoundError(
            f"canonical-team-map.json not at {MAP_PATH}. "
            "Run `node scripts/dump-canonical-team-map.mjs` first."
        )
    with open(MAP_PATH) as f:
        return json.load(f)


def canonical_team(name: str, league: str) -> str:
    """Map a raw team name to its canonical form for the given league.

    Returns the input name unchanged if no mapping exists (defensive
    fallback — won't crash on unknown teams).

    Examples:
        canonical_team("Munich", "bundesliga")          → "FC Bayern München"
        canonical_team("Bournemouth", "epl")            → "AFC Bournemouth"
        canonical_team("Espanol", "la_liga")            → "Espanyol Barcelona"
        canonical_team("Unknown FC", "bundesliga")      → "Unknown FC"  (passthrough)
    """
    if not name or not league:
        return name or ""
    m = _load_map()
    league_map = m.get(league, {})
    return league_map.get(name.lower(), name)


def _strip_for_key(s: str) -> str:
    """Common-denominator normalization for the JOIN key — lowercase,
    diacritic-strip, whitespace-collapse. Used AFTER canonical lookup to
    handle remaining alias-misses gracefully."""
    if not s:
        return ""
    s = "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )
    return "".join(s.lower().split())


def join_key(name: str, league: str) -> str:
    """Two-step bridge: canonical lookup + final stripping.

    The strip handles the few cases where:
      a) canonical map doesn't contain the input (returns input)
      b) BUT some other source maps a different input to the SAME canonical
      c) and we want both to hash to the same join key.
    """
    return _strip_for_key(canonical_team(name, league))
