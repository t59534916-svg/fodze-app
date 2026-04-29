"""
FODZE league key  →  Sofascore unique-tournament ID

Resolved 2026-04-29 via Sofascore search API (`/api/v1/search/all`) plus
manual verification on `/api/v1/unique-tournament/{id}` for the 4 cases
where the auto-search returned the wrong league or 0 results
(serie_b → was matching Serie A; primeira_liga, jupiler_pro → sponsor-
name aliases; serie_b correct id confirmed via direct probe).

Re-run `tools/sofascore/_resolve_tournament_ids.py` to refresh if a
sponsor name changes or Sofascore re-numbers a competition.
"""

# fodze_league_key → sofascore_unique_tournament_id
TOURNAMENT_IDS = {
    "bundesliga":      35,   # Germany / Bundesliga
    "bundesliga2":     44,   # Germany / 2. Bundesliga
    "liga3":           491,  # Germany / 3. Liga
    "epl":             17,   # England / Premier League
    "la_liga":         8,    # Spain / LaLiga
    "la_liga2":        54,   # Spain / LaLiga 2
    "serie_a":         23,   # Italy / Serie A
    "serie_b":         53,   # Italy / Serie B  (NB: search returns 23 incorrectly)
    "ligue_1":         34,   # France / Ligue 1
    "ligue_2":         182,  # France / Ligue 2
    "championship":    18,   # England / Championship
    "league_one":      24,   # England / League One
    "league_two":      25,   # England / League Two
    "eredivisie":      37,   # Netherlands / Eredivisie
    "eerste_divisie":  131,  # Netherlands / Eerste Divisie
    "primeira_liga":   238,  # Portugal / Liga Portugal Betclic
    "greek_sl":        185,  # Greece / Stoiximan Super League
    "jupiler_pro":     38,   # Belgium / Pro League
    "super_lig":       52,   # Turkey / Süper Lig
    "scottish_prem":   36,   # Scotland / Scottish Premiership
    "austria_bl":      45,   # Austria / Bundesliga
    "swiss_sl":        215,  # Switzerland / Super League
}

# Tier classification — used by the cron to decide what to backfill nightly
# (Tier A daily, Tier B weekly).
TIER_A = ["bundesliga", "bundesliga2", "liga3", "epl", "la_liga", "la_liga2",
          "serie_a", "serie_b", "ligue_1", "ligue_2", "championship"]
TIER_B = ["league_one", "league_two", "eredivisie", "eerste_divisie",
          "primeira_liga", "greek_sl", "jupiler_pro", "super_lig",
          "scottish_prem", "austria_bl", "swiss_sl"]
