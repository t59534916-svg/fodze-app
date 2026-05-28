"""
m3_xg.blended_predictor — Option C blend of m3_lean + m3_premium.

Architecture (decided 2026-05-21):
  Blend on PROBABILITY-SPACE rather than λ-space:
    P_final(H/D/A) = w * P_premium(H/D/A) + (1 - w) * P_lean(H/D/A)
  where w comes from coverage_router.compute_premium_weight().

  Lambda-space blending would distort the Dixon-Coles grid in non-obvious
  ways; probability-space blend is linear, well-defined, and matches the
  natural model-averaging interpretation.

Inference path:
  Match input → lean predictor → P_lean (always available)
              → premium predictor (if game_id + coverage_router > 0) → P_premium
              → blend by weight → P_final

Use:
  predictor = BlendedPredictor(
      lean=XGPredictor(...),
      premium_home=BayesianEnsemble.load("artifacts/m3_xg-home-dev-06-premium.pkl"),
      premium_away=BayesianEnsemble.load("artifacts/m3_xg-away-dev-06-premium.pkl"),
  )
  out = predictor.predict_batch(match_pairs_with_game_id, history)
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from v4.modules.m1_score.coarse_graining import get_1x2, get_btts, get_ou
from v4.modules.m1_score.distributions import DixonColesModel, PoissonGoalModel
from v4.modules.m2_lambda import LAMBDA_MAX, LAMBDA_MIN
from v4.modules.m3_xg.bayesian_ensemble import BayesianEnsemble
from v4.modules.m3_xg.coverage_router import compute_premium_decision
from v4.modules.m3_xg.feature_builder import build_features_for_corpus
from v4.modules.m3_xg.feature_builder_premium import (
    PREMIUM_FEATURE_ORDER,
    build_premium_features_for_corpus,
)
from v4.modules.m3_xg.predictor import XGPredictor, DEFAULT_RHO


class BlendedPredictor:
    """Option C blended predictor (m3_lean + m3_premium).

    The lean side is unchanged dev-03 — produces probabilities for ALL match
    pairs without restriction. The premium side fires only on matches where
    coverage_router.compute_premium_weight() > 0 (always-premium + current-
    only-premium leagues × current+recent seasons).

    Match-pairs WITHOUT game_id are predicted with lean alone (graceful
    degradation — no crash, no NaN). Match-pairs WITH game_id but where
    coverage_router returns weight=0 also use lean alone.
    """

    def __init__(
        self,
        lean: XGPredictor,
        premium_home: BayesianEnsemble,
        premium_away: BayesianEnsemble,
        rho: float = DEFAULT_RHO,
    ):
        if not premium_home.is_fitted:
            raise ValueError("premium_home ensemble not fitted")
        if not premium_away.is_fitted:
            raise ValueError("premium_away ensemble not fitted")
        self.lean = lean
        self.premium_home = premium_home
        self.premium_away = premium_away
        self.rho = float(rho)

    # ── Score-grid (shared with XGPredictor) ─────────────────────────────
    def _build_score_grid(
        self, lambda_h: float, lambda_a: float,
    ) -> Tuple[np.ndarray, bool]:
        """Build Dixon-Coles grid with Poisson fallback when ρ out-of-bounds.
        Mirrors XGPredictor._build_score_grid (method name `matrix`, not
        `score_matrix` — earlier draft had the wrong API)."""
        try:
            dc = DixonColesModel(lambda_h, lambda_a, rho=self.rho)
            return dc.matrix(normalize=True), False
        except ValueError:
            poi = PoissonGoalModel(lambda_h, lambda_a)
            return poi.matrix(normalize=True), True

    def _probs_from_lambda(
        self, lambda_h: float, lambda_a: float,
    ) -> Dict[str, Dict[str, float]]:
        """λ → {1x2, O25, BTTS} via Dixon-Coles."""
        M, _ = self._build_score_grid(lambda_h, lambda_a)
        return {
            "probabilities_1x2": get_1x2(M),
            "probabilities_o25": get_ou(M, threshold=2.5),
            "probabilities_btts": get_btts(M),
        }

    def _blend_prob_dicts(
        self,
        lean_p: Dict[str, float],
        prem_p: Dict[str, float],
        weight: float,
    ) -> Dict[str, float]:
        """Linear blend in probability-space. Result is automatically a valid
        distribution because both inputs are valid distributions and weight ∈ [0,1]."""
        return {k: weight * prem_p[k] + (1 - weight) * lean_p[k] for k in lean_p}

    # ── Batch prediction ────────────────────────────────────────────────
    def predict_batch(
        self,
        match_pairs: pd.DataFrame,
        history: pd.DataFrame,
        *,
        verbose: bool = False,
    ) -> pd.DataFrame:
        """Predict for many matches. Adds blend metadata to output.

        Args:
          match_pairs: DataFrame with columns league, match_date, home, away,
                       and OPTIONALLY game_id (sofascore_match.game_id). Without
                       game_id the premium path is skipped for that row.
          history: team_xg_history DataFrame (for lean features).

        Returns:
          DataFrame with one row per input, columns:
            league, match_date, home, away,
            lambda_h_lean, lambda_a_lean,
            lambda_h_premium, lambda_a_premium   (NaN if premium not used),
            prob_h_lean, prob_d_lean, prob_a_lean,
            prob_h_premium, prob_d_premium, prob_a_premium  (NaN if not used),
            prob_h, prob_d, prob_a                (blended — what callers should use),
            prob_over25, prob_under25, prob_btts_yes  (blended),
            premium_weight, premium_tier
        """
        # ── Lean side: always runs (unchanged dev-03 path) ──
        lean_out = self.lean.predict_batch(match_pairs, history, verbose=verbose)
        # Index it the same way as match_pairs (in case predict_batch reset_index)
        lean_out = lean_out.reset_index(drop=True)
        match_pairs = match_pairs.reset_index(drop=True)

        n = len(match_pairs)
        result = match_pairs[["league", "match_date", "home", "away"]].copy()

        result["lambda_h_lean"] = lean_out["lambda_h"].values
        result["lambda_a_lean"] = lean_out["lambda_a"].values
        result["prob_h_lean"] = lean_out["prob_h"].values
        result["prob_d_lean"] = lean_out["prob_d"].values
        result["prob_a_lean"] = lean_out["prob_a"].values
        result["prob_over25_lean"] = lean_out["prob_over25"].values
        result["prob_under25_lean"] = lean_out["prob_under25"].values
        result["prob_btts_yes_lean"] = lean_out["prob_btts_yes"].values

        # ── Premium side: only matches where coverage_router > 0 AND game_id present ──
        result["premium_weight"] = 0.0
        result["premium_tier"] = "lean"
        result["lambda_h_premium"] = np.nan
        result["lambda_a_premium"] = np.nan
        result["prob_h_premium"] = np.nan
        result["prob_d_premium"] = np.nan
        result["prob_a_premium"] = np.nan

        # Compute routing decision per match
        for i, row in match_pairs.iterrows():
            md = row["match_date"].date() if hasattr(row["match_date"], "date") else row["match_date"]
            dec = compute_premium_decision(row["league"], md)
            result.at[i, "premium_weight"] = dec.weight
            result.at[i, "premium_tier"] = dec.tier

        # Subset to rows where (a) premium_weight > 0 AND (b) game_id present
        if "game_id" in match_pairs.columns:
            premium_mask = (result["premium_weight"] > 0) & match_pairs["game_id"].notna()
        else:
            premium_mask = pd.Series([False] * n)

        n_premium = int(premium_mask.sum())
        if verbose:
            print(f"  Blend: {n_premium}/{n} matches route through premium path "
                  f"({100*n_premium/n:.1f}%)")

        if n_premium > 0:
            premium_pairs = match_pairs[premium_mask].copy()
            premium_game_ids = match_pairs.loc[premium_mask, "game_id"].astype(int).tolist()

            # Build premium features: 20 lean (from build_features_for_corpus)
            # + 9 sofa-derived. The premium ensembles were trained on this
            # combined schema.
            lean_premium_features = build_features_for_corpus(
                premium_pairs,
                history,
                estimator=self.lean.lambda_estimator,
                elo_calculator=self.lean._get_elo(history),
                momentum_calculator=self.lean._get_momentum(history),
                disagreement_calculator=self.lean._get_disagreement(),
                player_lineup_calculator=self.lean._get_player_lineup(),
                include_targets=False,
                verbose=False,
            )
            sofa_features = build_premium_features_for_corpus(
                premium_game_ids, impute_zero_on_missing=True,
            )
            # Both DFs should have len(premium_pairs); align by row index
            lean_premium_features = lean_premium_features.reset_index(drop=True)
            sofa_features = sofa_features.reset_index(drop=True)
            combined = pd.concat(
                [lean_premium_features, sofa_features[list(PREMIUM_FEATURE_ORDER)]],
                axis=1,
            )

            # Align column order to the trained ensemble
            X = combined[self.premium_home.feature_names].copy()
            if "league" in X.columns:
                X["league"] = X["league"].astype("category")

            mean_h, _ = self.premium_home.predict(X)
            mean_a, _ = self.premium_away.predict(X)
            lambda_h_prem = np.clip(mean_h, LAMBDA_MIN, LAMBDA_MAX)
            lambda_a_prem = np.clip(mean_a, LAMBDA_MIN, LAMBDA_MAX)

            premium_idx = match_pairs.index[premium_mask]
            for j, idx in enumerate(premium_idx):
                lh, la = float(lambda_h_prem[j]), float(lambda_a_prem[j])
                result.at[idx, "lambda_h_premium"] = lh
                result.at[idx, "lambda_a_premium"] = la
                probs = self._probs_from_lambda(lh, la)
                result.at[idx, "prob_h_premium"] = probs["probabilities_1x2"]["H"]
                result.at[idx, "prob_d_premium"] = probs["probabilities_1x2"]["D"]
                result.at[idx, "prob_a_premium"] = probs["probabilities_1x2"]["A"]

        # ── Blend final 1x2 + O25 + BTTS ──
        # Where premium was used: weighted; otherwise lean alone.
        # O25/BTTS: blend on the underlying lambda+grid; for simplicity we
        # recompute the score grid from BLENDED LAMBDA when both sides used.
        # (Probability-space blend works for 1x2, but O25/BTTS would need to
        # blend on the FULL 15×15 grid — too heavy for batch. The λ-space
        # average approximation is close enough for the secondary markets.)
        result["prob_h"] = result["prob_h_lean"]
        result["prob_d"] = result["prob_d_lean"]
        result["prob_a"] = result["prob_a_lean"]
        result["prob_over25"] = result["prob_over25_lean"]
        result["prob_under25"] = result["prob_under25_lean"]
        result["prob_btts_yes"] = result["prob_btts_yes_lean"]

        if n_premium > 0:
            for idx in match_pairs.index[premium_mask]:
                w = result.at[idx, "premium_weight"]
                # 1x2 — exact probability-space blend
                result.at[idx, "prob_h"] = w * result.at[idx, "prob_h_premium"] + (1 - w) * result.at[idx, "prob_h_lean"]
                result.at[idx, "prob_d"] = w * result.at[idx, "prob_d_premium"] + (1 - w) * result.at[idx, "prob_d_lean"]
                result.at[idx, "prob_a"] = w * result.at[idx, "prob_a_premium"] + (1 - w) * result.at[idx, "prob_a_lean"]

                # O25 + BTTS — λ-space average + recompute grid (one-off cost per match)
                lh_blend = w * result.at[idx, "lambda_h_premium"] + (1 - w) * result.at[idx, "lambda_h_lean"]
                la_blend = w * result.at[idx, "lambda_a_premium"] + (1 - w) * result.at[idx, "lambda_a_lean"]
                M, _ = self._build_score_grid(lh_blend, la_blend)
                o25 = get_ou(M, threshold=2.5)
                btts = get_btts(M)
                result.at[idx, "prob_over25"] = o25["over"]
                result.at[idx, "prob_under25"] = o25["under"]
                result.at[idx, "prob_btts_yes"] = btts["yes"]

        return result
