"""
m3_xg.predictor — XGPredictor: features → (λ_h, λ_a, σ²) → 1X2/O25/BTTS probabilities.

Pipeline:
  1. build_features_for_match() → feature row
  2. BayesianEnsemble(home/away).predict() → (λ_mean, σ²)
  3. m1_score.DixonColesModel → score-grid matrix
  4. m1_score.coarse_graining → market probabilities

The variance output (σ²_h, σ²_a) goes to m7_kelly's variance-shrinkage formula.
The mean output (λ_h, λ_a) goes through m6_market's Benter blend with market.

Predict API:
  predict_one(home, away, league, match_date, history) → dict
  predict_batch(match_pairs_df, history) → pd.DataFrame
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from v4.modules.m1_score.coarse_graining import get_1x2, get_btts, get_ou
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m2_lambda import LAMBDA_MAX, LAMBDA_MIN, LambdaEstimator
from v4.modules.m3_xg.bayesian_ensemble import BayesianEnsemble
from v4.modules.m3_xg.elo import EloCalculator
from v4.modules.m3_xg.team_momentum import TeamMomentumCalculator
from v4.modules.m3_xg.market_disagreement import MarketDisagreementCalculator
from v4.modules.m3_xg.player_lineup import PlayerLineupCalculator
from v4.modules.m3_xg.feature_builder import (
    ALL_FEATURES,
    NUMERIC_FEATURES,
    build_features_for_corpus,
    build_features_for_match,
)
from v4.modules.m3_xg.isotonic_calibrator import IsotonicCalibrator


# Default Dixon-Coles ρ for m3_xg → m1_score handoff.
# v2 production uses ρ ≈ -0.094 (Optuna-tuned). We use the same as initial seed.
DEFAULT_RHO = -0.094


class XGPredictor:
    """Combines BayesianEnsemble (home/away) + Dixon-Coles to produce match-level
    probability vectors.

    The ensembles can be loaded from disk or passed in directly after training.

    Usage:
        predictor = XGPredictor(
            ensemble_home=BayesianEnsemble.load("artifacts/m3_home.pkl"),
            ensemble_away=BayesianEnsemble.load("artifacts/m3_away.pkl"),
        )
        result = predictor.predict_one(
            home_team="Bayern", away_team="Dortmund",
            league="bundesliga", match_date=date(2026, 4, 5),
            history=team_xg_df,
        )
        # result["lambda_h"], result["lambda_h_variance"]
        # result["probabilities_1x2"] = {"H": ..., "D": ..., "A": ...}
    """

    def __init__(
        self,
        *,
        ensemble_home: BayesianEnsemble,
        ensemble_away: BayesianEnsemble,
        rho: float = DEFAULT_RHO,
        lambda_estimator: Optional[LambdaEstimator] = None,
        isotonic_calibrator: Optional[IsotonicCalibrator] = None,
    ):
        if not ensemble_home.is_fitted:
            raise ValueError("ensemble_home not fitted")
        if not ensemble_away.is_fitted:
            raise ValueError("ensemble_away not fitted")
        if isotonic_calibrator is not None and not isotonic_calibrator.is_fitted:
            raise ValueError("isotonic_calibrator must be fitted")
        self.ensemble_home = ensemble_home
        self.ensemble_away = ensemble_away
        self.rho = float(rho)
        self.lambda_estimator = lambda_estimator or LambdaEstimator()
        self.isotonic_calibrator = isotonic_calibrator
        # Elo calculator cache — lazy-fit on first predict call to avoid
        # paying the fit cost (~1.2s on 87k rows) when predictor isn't used.
        # Re-fit on each new history if the caller passes a different one.
        self._elo_calculator: Optional[EloCalculator] = None
        self._elo_history_id: Optional[int] = None
        # Momentum calculator cache (dev-03)
        self._momentum_calculator: Optional[TeamMomentumCalculator] = None
        self._momentum_history_id: Optional[int] = None
        # Disagreement calculator (dev-04). Must be passed externally — has
        # no automatic-fit since it loads odds from parquets.
        self.disagreement_calculator: Optional[MarketDisagreementCalculator] = None
        # Player-lineup calculator (dev-05). Loads from local SQLite mirror.
        self.player_lineup_calculator: Optional[PlayerLineupCalculator] = None

    # ─────────────────────────────────────────────────────────────────
    # Score-grid → market probabilities (shared helper)
    # ─────────────────────────────────────────────────────────────────

    def _get_elo(self, history: pd.DataFrame) -> EloCalculator:
        """Lazy-fit Elo calculator on history. Re-fits if history identity
        changes (by Python object id, conservative — re-fits on each new
        DataFrame instance even if contents are the same)."""
        hid = id(history)
        if self._elo_calculator is None or self._elo_history_id != hid:
            self._elo_calculator = EloCalculator().fit(history)
            self._elo_history_id = hid
        return self._elo_calculator

    def _get_momentum(self, history: pd.DataFrame) -> TeamMomentumCalculator:
        """Lazy-fit TeamMomentumCalculator. Same caching pattern as _get_elo."""
        hid = id(history)
        if self._momentum_calculator is None or self._momentum_history_id != hid:
            self._momentum_calculator = TeamMomentumCalculator().fit(history)
            self._momentum_history_id = hid
        return self._momentum_calculator

    def _get_disagreement(self) -> MarketDisagreementCalculator:
        """Return the disagreement calculator. Auto-fits on standard closing-odds
        parquets if not explicitly set. This avoids train-test distribution shift
        for dev-04+ models (where the feature is non-zero on training data).
        """
        if self.disagreement_calculator is None:
            from pathlib import Path
            repo_root = Path(__file__).resolve().parents[4]
            standard_paths = [
                repo_root / "tools" / "backtest" / "odds-close-oot.parquet",
                repo_root / "tools" / "backtest" / "odds-close-24-25.parquet",
                repo_root / "tools" / "backtest" / "odds-close-25-26.parquet",
            ]
            existing = [p for p in standard_paths if p.exists()]
            calc = MarketDisagreementCalculator()
            if existing:
                calc.fit(odds_paths=existing)
            else:
                calc._fitted = True  # empty lookup, all matches → 0.0
            self.disagreement_calculator = calc
        return self.disagreement_calculator

    def _get_player_lineup(self) -> PlayerLineupCalculator:
        """Return the PlayerLineupCalculator. Auto-fits on local SQLite mirror
        if not explicitly set. For dev-05+ artifacts which expect this feature
        to be populated for Top-5 leagues.
        """
        if self.player_lineup_calculator is None:
            from pathlib import Path
            repo_root = Path(__file__).resolve().parents[4]
            sqlite_path = repo_root / "tools" / "sofascore" / "data" / "local_extras.db"
            calc = PlayerLineupCalculator(sqlite_path)
            if sqlite_path.exists():
                calc.fit()
            else:
                calc._fitted = True  # empty lookup, all matches → 0.0
            self.player_lineup_calculator = calc
        return self.player_lineup_calculator

    def _build_score_grid(
        self, lambda_h: float, lambda_a: float
    ) -> tuple:
        """Build Dixon-Coles score-grid, falling back to Poisson if ρ out-of-bounds.

        DC requires ρ within (rho_min, rho_max) bounded by (λ_h, λ_a). For extreme
        matchups (λ_H × λ_A > 7), our default ρ=-0.094 may exceed rho_max=1/(λ_H×λ_A).
        In that case fall back to independent Poisson (loses low-score correlation
        but is mathematically valid).

        Returns (matrix, used_fallback: bool) — caller can aggregate fallback rate.
        """
        try:
            dc = DixonColesModel(lambda_h, lambda_a, rho=self.rho)
            return dc.matrix(normalize=True), False
        except ValueError:
            poi = PoissonGoalModel(lambda_h, lambda_a)
            return poi.matrix(normalize=True), True

    # ─────────────────────────────────────────────────────────────────
    # Single-match prediction
    # ─────────────────────────────────────────────────────────────────

    def predict_one(
        self,
        *,
        home_team: str,
        away_team: str,
        league: str,
        match_date: datetime,
        history: pd.DataFrame,
    ) -> Dict[str, Any]:
        """Return full prediction dict for ONE match.

        Includes λ pair + variance + 1X2/O25/BTTS probabilities + diagnostics.
        """
        feat = build_features_for_match(
            home_team=home_team,
            away_team=away_team,
            league=league,
            match_date=match_date,
            history=history,
            estimator=self.lambda_estimator,
            elo_calculator=self._get_elo(history),
            momentum_calculator=self._get_momentum(history),
            disagreement_calculator=self._get_disagreement(),
            player_lineup_calculator=self._get_player_lineup(),
        )
        # Build single-row DataFrame for ensemble (drop match_date if present, not a feature)
        X = pd.DataFrame([feat])
        X["league"] = X["league"].astype("category")
        X_aligned = X[self.ensemble_home.feature_names]

        mean_h, var_h = self.ensemble_home.predict(X_aligned)
        mean_a, var_a = self.ensemble_away.predict(X_aligned)

        # Clamp λ to physical range (same as m2_lambda guarantees)
        lambda_h = float(np.clip(mean_h[0], LAMBDA_MIN, LAMBDA_MAX))
        lambda_a = float(np.clip(mean_a[0], LAMBDA_MIN, LAMBDA_MAX))

        # Build market probabilities via Dixon-Coles (with Poisson fallback)
        M, used_poisson_fallback = self._build_score_grid(lambda_h, lambda_a)
        probs_1x2 = get_1x2(M)
        probs_o25 = get_ou(M, threshold=2.5)
        probs_btts = get_btts(M)

        return {
            # λ predictions (from Bayesian ensemble)
            "lambda_h": lambda_h,
            "lambda_a": lambda_a,
            "lambda_h_variance": float(var_h[0]),
            "lambda_a_variance": float(var_a[0]),
            # Pre-clamp raw (was clamping triggered?)
            "lambda_h_raw": float(mean_h[0]),
            "lambda_a_raw": float(mean_a[0]),
            # Market probabilities (from Dixon-Coles)
            "probabilities_1x2": probs_1x2,
            "probabilities_o25": probs_o25,
            "probabilities_btts": probs_btts,
            # Diagnostic: m2_lambda naive (for comparison with m3 refinement)
            "lambda_h_naive": feat["lambda_h_naive"],
            "lambda_a_naive": feat["lambda_a_naive"],
            "rho_used": self.rho,
            "used_poisson_fallback": used_poisson_fallback,
        }

    # ─────────────────────────────────────────────────────────────────
    # Batch prediction (training-time + evaluation)
    # ─────────────────────────────────────────────────────────────────

    def predict_batch(
        self,
        match_pairs: pd.DataFrame,
        history: pd.DataFrame,
        *,
        verbose: bool = False,
    ) -> pd.DataFrame:
        """Predict for many matches; faster than calling predict_one() in a loop
        because feature-building uses shared league-constants cache.

        Returns DataFrame with one row per match:
            league, match_date, home, away, lambda_h, lambda_a,
            lambda_h_variance, lambda_a_variance,
            prob_h, prob_d, prob_a, prob_over25, prob_under25, prob_btts_yes
        """
        # Build feature matrix for the whole corpus at once
        features = build_features_for_corpus(
            match_pairs,
            history,
            estimator=self.lambda_estimator,
            elo_calculator=self._get_elo(history),
            momentum_calculator=self._get_momentum(history),
            disagreement_calculator=self._get_disagreement(),
            player_lineup_calculator=self._get_player_lineup(),
            include_targets=False,
            verbose=verbose,
        )

        # Ensemble predict (vectorized over all rows)
        X_aligned = features[self.ensemble_home.feature_names]
        mean_h, var_h = self.ensemble_home.predict(X_aligned)
        mean_a, var_a = self.ensemble_away.predict(X_aligned)

        # Clamp
        lambda_h = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
        lambda_a = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)

        # Per-match score-grids → probabilities (loop because DC has per-match ρ-bounds)
        prob_h_arr = np.empty(len(features))
        prob_d_arr = np.empty(len(features))
        prob_a_arr = np.empty(len(features))
        prob_o25_arr = np.empty(len(features))
        prob_u25_arr = np.empty(len(features))
        prob_btts_y_arr = np.empty(len(features))
        used_fallback_arr = np.zeros(len(features), dtype=bool)

        for i in range(len(features)):
            M, used_fallback = self._build_score_grid(lambda_h[i], lambda_a[i])
            p1x2 = get_1x2(M)
            pou = get_ou(M, threshold=2.5)
            pbtts = get_btts(M)
            prob_h_arr[i] = p1x2["H"]
            prob_d_arr[i] = p1x2["D"]
            prob_a_arr[i] = p1x2["A"]
            prob_o25_arr[i] = pou["over"]
            prob_u25_arr[i] = pou["under"]
            prob_btts_y_arr[i] = pbtts["yes"]
            used_fallback_arr[i] = used_fallback

        # Surface Poisson-fallback rate as a diagnostic — if > 5%, model is
        # using independent Poisson more than expected, signaling extreme λ
        # predictions OR a misspecified ρ.
        fallback_rate = float(used_fallback_arr.mean())
        if verbose:
            print(f"  predict_batch: Poisson-fallback rate = {fallback_rate:.2%} "
                  f"({int(used_fallback_arr.sum())}/{len(features)} matches)")

        # Apply isotonic post-calibration if attached
        if self.isotonic_calibrator is not None:
            cal = self.isotonic_calibrator.calibrate_probs({
                "H": prob_h_arr, "D": prob_d_arr, "A": prob_a_arr,
                "over25": prob_o25_arr, "btts_yes": prob_btts_y_arr,
            })
            prob_h_arr = cal["H"]
            prob_d_arr = cal["D"]
            prob_a_arr = cal["A"]
            prob_o25_arr = cal["over25"]
            prob_u25_arr = 1.0 - prob_o25_arr  # mirror under from calibrated over
            prob_btts_y_arr = cal["btts_yes"]

        out = pd.DataFrame({
            "league": match_pairs["league"].values,
            "match_date": match_pairs["match_date"].values,
            "home": match_pairs["home"].values,
            "away": match_pairs["away"].values,
            "lambda_h": lambda_h,
            "lambda_a": lambda_a,
            "lambda_h_variance": var_h,
            "lambda_a_variance": var_a,
            "prob_h": prob_h_arr,
            "prob_d": prob_d_arr,
            "prob_a": prob_a_arr,
            "prob_over25": prob_o25_arr,
            "prob_under25": prob_u25_arr,
            "prob_btts_yes": prob_btts_y_arr,
            "used_poisson_fallback": used_fallback_arr,
        })
        # Stash aggregate fallback rate as DataFrame attribute (accessible by caller)
        out.attrs["poisson_fallback_rate"] = fallback_rate
        out.attrs["isotonic_applied"] = self.isotonic_calibrator is not None
        return out

    # ─────────────────────────────────────────────────────────────────
    # Persistence
    # ─────────────────────────────────────────────────────────────────

    @classmethod
    def from_artifacts(
        cls,
        *,
        home_path: Path,
        away_path: Path,
        rho: float = DEFAULT_RHO,
        isotonic_path: Optional[Path] = None,
    ) -> "XGPredictor":
        """Load predictor from on-disk ensemble pickles + optional isotonic."""
        eh = BayesianEnsemble.load(home_path)
        ea = BayesianEnsemble.load(away_path)
        iso = IsotonicCalibrator.load(isotonic_path) if isotonic_path is not None else None
        return cls(
            ensemble_home=eh, ensemble_away=ea, rho=rho,
            isotonic_calibrator=iso,
        )
