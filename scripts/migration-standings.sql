-- ═══════════════════════════════════════════════════════════════════════
-- FODZE: League Standings from team_xg_history
-- Computes W/D/L, GF, GA, GD, Points from existing match data
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_league_standings(
  p_league TEXT,
  p_season_start DATE DEFAULT '2025-07-01'
)
RETURNS TABLE (
  team TEXT,
  played INT,
  won INT,
  drawn INT,
  lost INT,
  gf INT,
  ga INT,
  gd INT,
  points INT,
  pos INT
)
LANGUAGE SQL STABLE
AS $$
  WITH home_results AS (
    -- Home team perspective (venue='home' rows)
    SELECT
      t.team AS team,
      t.goals_for AS gf,
      t.goals_against AS ga,
      CASE
        WHEN t.goals_for > t.goals_against THEN 3
        WHEN t.goals_for = t.goals_against THEN 1
        ELSE 0
      END AS pts
    FROM team_xg_history t
    WHERE t.league = p_league
      AND t.venue = 'home'
      AND t.match_date >= p_season_start
      AND t.goals_for IS NOT NULL
      AND t.goals_against IS NOT NULL
  ),
  away_results AS (
    -- Away team perspective (derived from same home rows via opponent)
    SELECT
      t.opponent AS team,
      t.goals_against AS gf,  -- away team scored = home team conceded
      t.goals_for AS ga,      -- away team conceded = home team scored
      CASE
        WHEN t.goals_against > t.goals_for THEN 3
        WHEN t.goals_against = t.goals_for THEN 1
        ELSE 0
      END AS pts
    FROM team_xg_history t
    WHERE t.league = p_league
      AND t.venue = 'home'
      AND t.match_date >= p_season_start
      AND t.goals_for IS NOT NULL
      AND t.goals_against IS NOT NULL
  ),
  all_results AS (
    SELECT * FROM home_results
    UNION ALL
    SELECT * FROM away_results
  ),
  aggregated AS (
    SELECT
      a.team,
      COUNT(*)::INT AS played,
      SUM(CASE WHEN a.pts = 3 THEN 1 ELSE 0 END)::INT AS won,
      SUM(CASE WHEN a.pts = 1 THEN 1 ELSE 0 END)::INT AS drawn,
      SUM(CASE WHEN a.pts = 0 THEN 1 ELSE 0 END)::INT AS lost,
      SUM(a.gf)::INT AS gf,
      SUM(a.ga)::INT AS ga,
      (SUM(a.gf) - SUM(a.ga))::INT AS gd,
      SUM(a.pts)::INT AS points
    FROM all_results a
    GROUP BY a.team
  )
  SELECT
    ag.team,
    ag.played,
    ag.won,
    ag.drawn,
    ag.lost,
    ag.gf,
    ag.ga,
    ag.gd,
    ag.points,
    ROW_NUMBER() OVER (
      ORDER BY ag.points DESC, ag.gd DESC, ag.gf DESC, ag.team
    )::INT AS pos
  FROM aggregated ag
  ORDER BY ag.points DESC, ag.gd DESC, ag.gf DESC, ag.team;
$$;
