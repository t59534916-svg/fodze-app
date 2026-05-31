"""Lock test: tolerance constants are SINGLE SOURCE OF TRUTH across the codebase.

Two constants in v4.eval.metrics with distinct semantics:

  PROBABILITY_TOLERANCE = 1e-6
    "Is this thing a valid probability?" — range + sum-to-1 checks.
    Calibrated for float32 IEEE drift (XGBoost binary outputs).

  IDENTITY_TOLERANCE = 1e-9
    "Should these two computations produce the same float?" — leakage tests,
    swap-symmetry, math identities. Float64-tight.

This test ensures no module introduces a divergent default that could cause
confusing behavior shifts across the pipeline.

If you ADD a new module that needs tolerance:
  1. Decide which CATEGORY (probability validity vs math identity)
  2. Import the constant from v4.eval.metrics
  3. NEVER introduce a hardcoded 0.01 or 1e-6 or 1e-9 default

Module-local algorithm constants (e.g., AH_PUSH_EPSILON in coarse_graining)
are DIFFERENT — they're domain thresholds, not tolerances. Those stay local
+ named, but the lock test verifies they exist (no inline magic numbers in
classification paths).
"""
from __future__ import annotations

import inspect
from pathlib import Path

import numpy as np
import pytest

from v4.eval.metrics import (
    IDENTITY_TOLERANCE,
    PROBABILITY_TOLERANCE,
    _check_proba_in_range,
    _check_proba_rows_sum_to_one,
)

# Repo root derived from this file's location (tools/v4/tests/ → up 3 levels),
# NOT a hardcoded developer-machine path. The source-text lock-tests below read
# pipeline/module files relative to this so they run portably (CI + any dev box).
REPO_ROOT = Path(__file__).resolve().parents[3]


def test_constant_value_is_locked():
    """PROBABILITY_TOLERANCE must be 1e-6 (calibrated for float32 epsilon).

    Why 1e-6 specifically:
      - float32 epsilon ≈ 1.19e-7 — XGBoost's binary:logistic returns float32,
        and (1-p, p) construction drifts to ~1e-7 per row
      - 1e-6 gives ~10× margin over float32 worst-case
      - Still catches real bugs: a -0.01 negative is 10^4× this tolerance

    If you change this:
      1. Update the rationale block in eval/metrics.py
      2. Update this test
      3. Verify all callers still pass with the new value
    """
    assert PROBABILITY_TOLERANCE == 1e-6, (
        f"PROBABILITY_TOLERANCE changed to {PROBABILITY_TOLERANCE} without "
        "updating the lock-test. Re-read the rationale block in eval/metrics.py "
        "before touching."
    )


def test_check_in_range_default_uses_constant():
    sig = inspect.signature(_check_proba_in_range)
    tol_param = sig.parameters.get("tol")
    assert tol_param is not None
    assert tol_param.default == PROBABILITY_TOLERANCE, (
        f"_check_proba_in_range tol default {tol_param.default} != "
        f"PROBABILITY_TOLERANCE {PROBABILITY_TOLERANCE}"
    )


def test_check_rowsum_default_uses_constant():
    sig = inspect.signature(_check_proba_rows_sum_to_one)
    tol_param = sig.parameters.get("tol")
    assert tol_param is not None
    assert tol_param.default == PROBABILITY_TOLERANCE, (
        f"_check_proba_rows_sum_to_one tol default {tol_param.default} != "
        f"PROBABILITY_TOLERANCE {PROBABILITY_TOLERANCE}"
    )


def test_benter_imports_and_uses_constant():
    """BenterBlender must use the SAME tolerance via import (not redefine)."""
    from v4.modules.m6_market import benter
    # Verify the import is wired (not a redefined local)
    assert hasattr(benter, "PROBABILITY_TOLERANCE")
    assert benter.PROBABILITY_TOLERANCE == PROBABILITY_TOLERANCE, (
        "benter.PROBABILITY_TOLERANCE diverged from eval.metrics. "
        "This is the exact landmine the lock-test was designed to prevent."
    )


def test_benter_rejects_at_exactly_the_constant():
    """End-to-end: a row with sum-deviation just BARELY above PROBABILITY_TOLERANCE
    should be rejected. Just BELOW should be accepted."""
    from v4.modules.m6_market import BenterBlender

    n = 200
    # Build a row that sums to (1.0 + 10 × PROBABILITY_TOLERANCE) — clearly over
    row = np.array([0.5 + 10 * PROBABILITY_TOLERANCE, 0.3, 0.2])
    # Sanity-check our constructed input
    assert row.sum() - 1.0 > PROBABILITY_TOLERANCE
    bad_data = {
        "lg": (
            np.tile(row, (n, 1)),
            np.tile(np.array([0.5, 0.3, 0.2]), (n, 1)),
            np.zeros(n, dtype=int),
        )
    }
    with pytest.raises(ValueError, match="sum to ~1"):
        BenterBlender(min_liga_samples=50).fit(bad_data)


def test_benter_accepts_at_exactly_the_constant():
    """A row with sum-deviation just BELOW PROBABILITY_TOLERANCE should pass."""
    from v4.modules.m6_market import BenterBlender

    n = 200
    # Construct a row whose sum deviates by less than tolerance (1e-10 < 1e-9)
    drift = PROBABILITY_TOLERANCE / 10  # well within tolerance
    row = np.array([0.5 + drift, 0.3, 0.2])
    assert abs(row.sum() - 1.0) < PROBABILITY_TOLERANCE  # sanity
    ok_data = {
        "lg": (
            np.tile(row, (n, 1)),
            np.tile(np.array([0.5, 0.3, 0.2]), (n, 1)),
            np.zeros(n, dtype=int),
        )
    }
    # Should NOT raise
    BenterBlender(min_liga_samples=50).fit(ok_data)


def test_stage_1_m3_imports_constant():
    """Stage 1.m3 must import the constants (not hard-code another default).

    This is a source-text check: we read the file and verify it imports
    PROBABILITY_TOLERANCE and uses it in the prob-sum check, rather than
    re-defining a local 0.01 tolerance.
    """
    src = (REPO_ROOT / "tools/v4/pipeline/stage_1_m3_xg.py").read_text()
    # Must import the constant
    assert "PROBABILITY_TOLERANCE" in src, (
        "stage_1_m3_xg.py must reference PROBABILITY_TOLERANCE instead of a "
        "hard-coded local tolerance."
    )
    # Must use the constant in the rowsum check (no literal 0.01 there)
    assert "max_dev > PROBABILITY_TOLERANCE" in src, (
        "stage_1_m3 sum-check must use PROBABILITY_TOLERANCE, not a literal."
    )
    # The OLD bug had `if max_dev > 0.01`. Verify that specific pattern is gone.
    assert "if max_dev > 0.01" not in src, (
        "Found leftover `if max_dev > 0.01` — the legacy hardcoded tolerance "
        "in stage_1_m3 was not fully replaced."
    )


# ─────────────────────────────────────────────────────────────────────
# IDENTITY_TOLERANCE locks
# ─────────────────────────────────────────────────────────────────────


def test_identity_constant_value_is_locked():
    """IDENTITY_TOLERANCE must be 1e-9 (float64-tight for math identities).

    If you change this:
      1. Update the rationale block in eval/metrics.py
      2. Update this test
      3. Verify identity tests still pass — too LOOSE risks masking real
         leakage bugs; too TIGHT risks false positives from IEEE drift
    """
    assert IDENTITY_TOLERANCE == 1e-9, (
        f"IDENTITY_TOLERANCE changed to {IDENTITY_TOLERANCE} without updating "
        "the lock-test. Re-read the rationale block in eval/metrics.py."
    )


def test_identity_constant_is_tighter_than_probability_tolerance():
    """By design, IDENTITY < PROBABILITY: identity checks are stricter (float64
    same-computation), probability checks must absorb float32 drift."""
    assert IDENTITY_TOLERANCE < PROBABILITY_TOLERANCE, (
        f"IDENTITY_TOLERANCE ({IDENTITY_TOLERANCE}) must be stricter than "
        f"PROBABILITY_TOLERANCE ({PROBABILITY_TOLERANCE}) — otherwise the "
        "semantic distinction collapses."
    )


def test_stage_1_m1_score_imports_both_constants():
    """Stage 1.m1_score uses both: PROBABILITY_TOLERANCE for sum-to-1 checks,
    IDENTITY_TOLERANCE for AH(0)=1X2 math identity checks."""
    src = (REPO_ROOT / "tools/v4/pipeline/stage_1_m1_score.py").read_text()
    assert "PROBABILITY_TOLERANCE" in src, "stage_1_m1_score must import PROBABILITY_TOLERANCE"
    assert "IDENTITY_TOLERANCE" in src, "stage_1_m1_score must import IDENTITY_TOLERANCE"
    # The OLD inline tol=1e-9 / tol=1e-6 should be gone from assert_close calls
    assert "tol=1e-9" not in src, (
        "Found inline `tol=1e-9` in stage_1_m1_score — replace with IDENTITY_TOLERANCE"
    )
    assert "tol=1e-6" not in src, (
        "Found inline `tol=1e-6` in stage_1_m1_score — replace with PROBABILITY_TOLERANCE"
    )


def test_stage_1_m2_lambda_imports_identity_constant():
    """Leakage delta + swap-identity tests in stage_1_m2_lambda must use the constant."""
    src = (REPO_ROOT / "tools/v4/pipeline/stage_1_m2_lambda.py").read_text()
    assert "IDENTITY_TOLERANCE" in src, "stage_1_m2_lambda must import IDENTITY_TOLERANCE"
    # Verify the legacy pattern `> 1e-9` is gone (specific patterns we fixed)
    assert "delta > 1e-9" not in src, "Found leftover `delta > 1e-9` in stage_1_m2_lambda"


def test_stage_1_m3_xg_imports_identity_constant():
    """Leakage delta in stage_1_m3_xg must use the constant."""
    src = (REPO_ROOT / "tools/v4/pipeline/stage_1_m3_xg.py").read_text()
    assert "IDENTITY_TOLERANCE" in src, "stage_1_m3_xg must import IDENTITY_TOLERANCE"
    assert "delta_h > 1e-9" not in src, "Found leftover `delta_h > 1e-9` in stage_1_m3_xg"
    assert "delta_a > 1e-9" not in src, "Found leftover `delta_a > 1e-9` in stage_1_m3_xg"


# ─────────────────────────────────────────────────────────────────────
# Algorithm-local named constants (NOT tolerances — must NOT be in eval.metrics)
# ─────────────────────────────────────────────────────────────────────


def test_coarse_graining_named_constants_exist():
    """coarse_graining.py exports named domain constants for algorithm-internal
    classification thresholds. These are NOT general-purpose tolerances —
    they're algorithm-specific. The lock-test catches anyone re-introducing
    bare `1e-9` literals into the classification code paths.
    """
    from v4.modules.m1_score import coarse_graining

    assert hasattr(coarse_graining, "MIN_PUSH_MASS"), (
        "coarse_graining must define MIN_PUSH_MASS (algorithm-internal "
        "classification threshold, not a tolerance)"
    )
    assert hasattr(coarse_graining, "HANDICAP_QUARTER_EPSILON")
    assert hasattr(coarse_graining, "AH_MARGIN_EPSILON")
    # These should NOT be the same name as PROBABILITY_TOLERANCE — distinct concepts
    assert coarse_graining.MIN_PUSH_MASS != PROBABILITY_TOLERANCE or (
        coarse_graining.MIN_PUSH_MASS == 1e-9
    ), "named constants exist but semantic separation should be intentional"


def test_coarse_graining_no_inline_classification_literals():
    """The classification paths in coarse_graining must reference the named
    constants, not inline `1e-9` literals. This catches future regressions
    where someone reintroduces a bare number."""
    src = (REPO_ROOT / "tools/v4/modules/m1_score/coarse_graining.py").read_text()
    # The specific patterns we replaced — must remain gone
    assert "push > 1e-9" not in src, "Found inline `push > 1e-9` — use MIN_PUSH_MASS"
    assert "margin > 1e-9" not in src, "Found inline `margin > 1e-9` — use AH_MARGIN_EPSILON"
    assert "margin < -1e-9" not in src, "Found inline `margin < -1e-9` — use AH_MARGIN_EPSILON"
    assert "round(handicap * 4)) > 1e-9" not in src, (
        "Found inline handicap-class literal — use HANDICAP_QUARTER_EPSILON"
    )
    # And the DC negative guard must use PROBABILITY_TOLERANCE (not inline -1e-9)
    assert "matrix < -PROBABILITY_TOLERANCE" in src, (
        "DC negative guard must use PROBABILITY_TOLERANCE, not inline literal"
    )


# ─────────────────────────────────────────────────────────────────────
# End-to-end trip points for IDENTITY_TOLERANCE
# ─────────────────────────────────────────────────────────────────────


def test_assert_close_default_uses_identity_tolerance():
    """stage_1_m1_score::assert_close default tol must be IDENTITY_TOLERANCE."""
    import sys as _sys
    _sys.path.insert(0, str(REPO_ROOT / "tools"))
    from v4.pipeline.stage_1_m1_score import assert_close
    sig = inspect.signature(assert_close)
    assert sig.parameters["tol"].default == IDENTITY_TOLERANCE, (
        f"assert_close default tol = {sig.parameters['tol'].default} != "
        f"IDENTITY_TOLERANCE {IDENTITY_TOLERANCE}"
    )


def test_assert_close_fires_just_over_identity_tolerance():
    """assert_close should reject a delta just above IDENTITY_TOLERANCE."""
    import sys as _sys
    _sys.path.insert(0, str(REPO_ROOT / "tools"))
    from v4.pipeline.stage_1_m1_score import SanityCheckFailed, assert_close

    just_over = IDENTITY_TOLERANCE * 10  # 10× over tolerance
    with pytest.raises(SanityCheckFailed):
        assert_close(1.0 + just_over, 1.0, msg="test")


def test_assert_close_passes_just_under_identity_tolerance():
    """assert_close should accept a delta just below IDENTITY_TOLERANCE."""
    import sys as _sys
    _sys.path.insert(0, str(REPO_ROOT / "tools"))
    from v4.pipeline.stage_1_m1_score import assert_close

    just_under = IDENTITY_TOLERANCE / 10  # well within tolerance
    # Should NOT raise
    assert_close(1.0 + just_under, 1.0, msg="should accept")
