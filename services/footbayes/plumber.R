# FODZE footBayes HTTP wrapper
# Optional — only needed if you want ad-hoc fits triggered by the app
# instead of the default nightly cron (fit_daily.R).
#
# Deploy: `Rscript plumber.R` starts a server on $PORT (default 8000).
# Example: `curl -X POST http://service:8000/fit?league=bundesliga`

library(plumber)
library(callr)

# Run the nightly script as a background process so the HTTP call doesn't
# timeout. A production wrapper would dedupe concurrent requests; this
# scaffold just shows the shape.
#* Trigger a fit for one league.
#* @post /fit
#* @param league Target league code (matches src/lib/dixon-coles.ts LEAGUES)
function(league = NULL) {
  if (is.null(league) || !nzchar(league)) {
    return(list(error = "league is required"))
  }
  Sys.setenv(FODZE_ONLY_LEAGUE = league)  # fit_daily.R reads this if set
  pid <- callr::r_bg(function() system("Rscript fit_daily.R"))
  list(accepted = TRUE, league = league, pid = pid$get_pid())
}

#* Health probe.
#* @get /health
function() {
  list(ok = TRUE, service = "fodze-footbayes", ts = format(Sys.time()))
}
