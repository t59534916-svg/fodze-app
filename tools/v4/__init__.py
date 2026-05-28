"""FODZE v4 — modular hybrid pre-match prediction engine.

Module layout (hard-modular per FODZE v4.0 design, post-V3-revision 2026-05-12):
  data/      — local SQLite loaders, walk-forward generators
  eval/      — metrics (Brier, log-loss, ECE, bootstrap CIs)
  modules/
    m1_score/      — score-generative core (Dixon-Coles, NegBin, coarse-graining)
                     STATUS: ✅ implemented + Stage 1 sanity green (13/13)
    m2_lambda/     — λ estimator (xG-EWMA, covariates, fatigue/form proxy)
                     STATUS: ⏳ planned (sprint β1)
    m3_xg/         — LightGBM Tweedie head + isotonic + 5-seed Bayesian Ensemble
                     producing (p_hat, σ²_hat) for m7's variance-shrinkage
                     STATUS: ⏳ planned (sprint β2)
    m4_set_pieces/ — XGBoost set-piece outcome model
                     STATUS: ⏳ planned (sprint β3)
    m5_filters/    — STUB pre-match (regime + intensity), live-mode deferred
                     STATUS: ✅ stub interfaces in place
    m6_market/     — vig-removal (Shin) + Benter blend (β₁/β₂ per Liga)
                     STATUS: ⏳ planned (sprint β5)
    m7_kelly/      — Robust Bayesian Kelly + per-Liga CLV-feedback dampening
                     STATUS: ⏳ planned (sprint β6)
  pipeline/  — Stage 0/1/etc orchestrators
                     stage_0_data_sanity: schema + coverage gate
                     stage_1_m1_score:    math identity gate for m1_score

See docs/V4-BACKTESTING-PROTOCOL.md for ship-gates + test plan.
"""
__version__ = "0.1.0-dev"
