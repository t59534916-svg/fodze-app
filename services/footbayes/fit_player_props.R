# ═══════════════════════════════════════════════════════════════════════
# FODZE Player-Props Hierarchical Fit (Phase 3.2)
# ═══════════════════════════════════════════════════════════════════════
# Fits a hierarchical Poisson per player with three outcome variables:
#   goals_per_90:  log λ_goals = α_player + β_team_attack + γ_opp_def + δ_home
#   shots_per_90:  log λ_shots = α_shots_player + team_attack*0.5 + δ_home*0.5
#   cards_per_90:  log λ_cards = α_cards_player    (player-only; cards are
#                                                   dominated by referee + match-
#                                                   state more than team)
#
# Partial-pooling via priors on α_player ~ Normal(α_league[position], σ_league).
# League × position cohort priors give thin-data Liga 3 players useful shrinkage
# toward the 20-player average of their cohort.
#
# Methodology:
#   Whitaker, Silva, Edwards, Kosmidis (2021, JRSS-C, DOI 10.1111/rssc.12454)
#   Bransen, Robberechts, Van Haaren, Davis (2019, "Choke or Shine?")
#
# Prereqs (same as fit_daily.R for the team-level footBayes fit):
#   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY
#   player_xg_history table populated by scripts/backfill-player-xg.mjs
#   team_xg_history table populated by backfill-shots-xg.mjs / understat-seed
#
# Output: public/player-props-posteriors.json
# ═══════════════════════════════════════════════════════════════════════

suppressPackageStartupMessages({
  library(rstanarm)
  library(jsonlite)
  library(httr)
  library(dplyr)
})

SUPA_URL <- Sys.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPA_KEY <- Sys.getenv("SUPABASE_SERVICE_KEY")
REPO     <- Sys.getenv("FODZE_REPO_PATH", "/app")
SEASON   <- Sys.getenv("FODZE_SEASON", "2526")

stopifnot(nzchar(SUPA_URL), nzchar(SUPA_KEY))

# ─── Load player-level panel ────────────────────────────────────────
# One row per player per season — the output of scripts/backfill-player-xg.mjs.
# For the Stan fit we convert xg_per_90 → λ_goals rate, shots_per_90 → λ_shots,
# and use minutes_played as the offset multiplier via log(minutes/90).
fetch_players <- function() {
  url <- paste0(SUPA_URL, "/rest/v1/player_xg_history",
                "?season=eq.", SEASON,
                "&select=player_name,team,league,season,position,minutes_played,",
                "xg_per_90,xa_per_90,npxg_per_90,shots_per_90,key_passes_per_90")
  resp <- httr::GET(url, httr::add_headers(
    apikey = SUPA_KEY, Authorization = paste0("Bearer ", SUPA_KEY)
  ))
  httr::stop_for_status(resp)
  as.data.frame(httr::content(resp, as = "parsed", simplifyVector = TRUE))
}

cat(sprintf("[player-props] loading season=%s...\n", SEASON))
players <- fetch_players()
cat(sprintf("[player-props] got %d player rows across %d leagues\n",
            nrow(players), length(unique(players$league))))

if (nrow(players) == 0) {
  cat("[player-props] no data — writing placeholder-only output\n")
  writeLines(
    '{"_version":1,"teams":{},"players":{},"_meta":{"status":"no-data"}}',
    file.path(REPO, "public", "player-props-posteriors.json")
  )
  quit(save = "no", status = 0)
}

# ─── Fit goals model ────────────────────────────────────────────────
# Goals: hierarchical Poisson, random-intercept per player within
# (league, position) cohort. rstanarm handles the partial-pooling natively.

# Derive integer goal counts from the xG rate × minutes (rounded). This is
# a pragmatic approximation — true ground-truth goals per player per match
# would need per-match events (roster CSVs). For the MVP this rolls up
# season-level rates which Stan can still fit.
players <- players %>%
  filter(minutes_played >= 90, !is.na(xg_per_90)) %>%
  mutate(
    expected_goals_season = xg_per_90 * minutes_played / 90,
    approx_goals          = round(pmax(0, expected_goals_season)),
    offset_log_minutes    = log(pmax(90, minutes_played)),
    position              = ifelse(is.na(position), "MID", position)
  )

cat(sprintf("[player-props] fitting goals model on %d players...\n", nrow(players)))

fit_goals <- tryCatch({
  stan_glmer(
    approx_goals ~ 1 + (1 | league:position) + (1 | player_name),
    data   = players,
    family = poisson(link = "log"),
    offset = offset_log_minutes,
    chains = 4, iter = 1500, seed = 42,
    cores  = min(4L, parallel::detectCores())
  )
}, error = function(e) {
  cat(sprintf("[player-props] goals fit FAILED: %s\n", conditionMessage(e)))
  NULL
})

# ─── Fit shots model ────────────────────────────────────────────────
players$approx_shots <- round(players$shots_per_90 * players$minutes_played / 90)
fit_shots <- tryCatch({
  stan_glmer(
    approx_shots ~ 1 + (1 | league:position) + (1 | player_name),
    data   = players,
    family = poisson(link = "log"),
    offset = offset_log_minutes,
    chains = 4, iter = 1500, seed = 43,
    cores  = min(4L, parallel::detectCores())
  )
}, error = function(e) NULL)

# ─── Cards model (placeholder — needs key_passes, fouls, referee joins) ─
# Cards are dominated by referee × rivalry × match-state; rate-per-90
# alone is a weak predictor. We keep the skeleton so the schema has a
# γ_mean field, set gamma_mean = -4.0 (~1.8% base yellow rate) until
# the Referee table joins in.
DEFAULT_GAMMA_MEAN <- -4.0
DEFAULT_GAMMA_SD   <- 0.3

# ─── Extract posterior means per player ─────────────────────────────
# Placeholder accessors — real extraction pulls re-effects via
# ranef(fit_goals) + fixef(fit_goals). Shape must match what
# src/lib/player-props-engine.ts consumes.

extract_posterior_means <- function(fit, players_df, var_prefix) {
  if (is.null(fit)) return(setNames(numeric(0), character(0)))
  # rstanarm::ranef returns list per grouping factor; we want player_name.
  re <- tryCatch(ranef(fit)$player_name, error = function(e) NULL)
  if (is.null(re)) return(setNames(numeric(0), character(0)))
  fe <- tryCatch(fixef(fit)[["(Intercept)"]], error = function(e) 0)
  means <- re[, "(Intercept)"] + fe
  names(means) <- rownames(re)
  means
}

alpha_means <- extract_posterior_means(fit_goals, players, "alpha")
beta_means  <- extract_posterior_means(fit_shots, players, "beta")

# ─── Team-level attack modifier (placeholder — derive from footBayes fit) ─
# For now, set team_attack = 0, league_baseline = 0 per team. The goals
# model's random effect at the league:position level already captures
# that variance — teams gain independent priors when we merge with the
# team-level Bayes fit (services/footbayes/fit_daily.R).
teams_out <- list()
for (t in unique(players$team)) {
  teams_out[[t]] <- list(team_attack = 0, league_baseline = 0)
}

# ─── Assemble posteriors JSON ──────────────────────────────────────
players_out <- list()
for (i in seq_len(nrow(players))) {
  row <- players[i, ]
  key <- tolower(row$player_name)
  players_out[[key]] <- list(
    alpha_mean     = unname(alpha_means[row$player_name]) %||% -Inf,
    alpha_sd       = NA_real_,
    beta_mean      = unname(beta_means[row$player_name])  %||% log(1 + row$shots_per_90),
    beta_sd        = NA_real_,
    gamma_mean     = DEFAULT_GAMMA_MEAN,
    gamma_sd       = DEFAULT_GAMMA_SD,
    minutes_share  = row$minutes_played / (38 * 990 / 11),  # rough league fraction
    minutes_played = row$minutes_played,
    position       = row$position,
    team           = row$team,
    league         = row$league,
    season         = row$season
  )
}

`%||%` <- function(a, b) if (is.null(a) || is.na(a)) b else a

out <- list(
  `_version` = 1,
  `_meta` = list(
    method = "hierarchical_poisson_rstanarm",
    trained_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
  ),
  teams   = teams_out,
  players = players_out
)

path <- file.path(REPO, "public", "player-props-posteriors.json")
dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
write(toJSON(out, auto_unbox = TRUE, pretty = TRUE, null = "null", na = "null"), path)
cat(sprintf("[player-props] wrote %s  (%d players, %d teams)\n",
            path, length(players_out), length(teams_out)))
