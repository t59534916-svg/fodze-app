# FODZE footBayes nightly fit — R + Stan + footBayes
# Base: rocker/tidyverse gives us R 4.3 + system deps for rstan/cmdstanr.
FROM rocker/tidyverse:4.3

# System deps for cmdstan compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates curl \
    libv8-dev libnlopt-dev libxml2-dev \
 && rm -rf /var/lib/apt/lists/*

# R packages — footBayes pulls in bayesplot, loo, rstan transitively.
RUN R -e "install.packages(c('footBayes', 'cmdstanr', 'jsonlite', 'httr', 'DBI', 'RPostgres'), \
    repos = c('https://mc-stan.org/r-packages/', getOption('repos')))"

# Pre-install cmdstan so fit_daily.R doesn't do it on first run.
RUN R -e "cmdstanr::install_cmdstan(cores = 2)"

WORKDIR /app
COPY fit_daily.R plumber.R ./

# Default: run the nightly fit. Override with `docker run … Rscript plumber.R`
# to serve an HTTP endpoint instead.
CMD ["Rscript", "fit_daily.R"]
