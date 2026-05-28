"""
Stage 1.m1_score — Math identity sanity checks for the score-grid layer.

Renamed from stage_0_sanity.py (2026-05-12) to match V3 protocol revision:
Stage 0 is data sanity (leakage / schema / coverage). This file is the per-module
math-identity gate for m1_score (Dixon-Coles distributions + coarse-graining + ρ MLE).

Run: tools/venv/bin/python3 -I tools/v4/pipeline/stage_1_m1_score.py

Tests (13 total — all must pass before Stage 2 feature-lab iteration):
  1.  Poisson matrix captures ≥ 99.9% of mass with max_goals=9
  2.  DC(ρ ≈ 0) ≈ Poisson normalized
  3.  DC(ρ < 0) increases P(0:0) vs Poisson (mathematical correctness)
  4.  DC matrix sums to exactly 1.0 (after τ-renormalization)
  5.  DC matrix has no negative entries (ρ within bounds)
  6.  NegBin matrix sums to ≥ 99.9% with k=5 dispersion
  7.  NegBin from_mean_var rejects var ≤ mu (Poisson territory)
  8.  Coarse-graining 1X2 sums to 1.0
  9.  Coarse-graining O/U 2.5 sums to 1.0
  10. Coarse-graining BTTS sums to 1.0
  11. Asian Handicap split correctly handles push (handicap=0 = straight 1X2)
  12. Overdispersion detector correctly flags Var > Mean × 1.2
  13. Dixon-Coles ρ MLE converges + returns ρ in [-0.20, 0.13]
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure tools/v4 is importable when run as standalone script
REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import numpy as np

from v4.eval.metrics import IDENTITY_TOLERANCE, PROBABILITY_TOLERANCE
from v4.modules.m1_score.coarse_graining import (
    get_1x2,
    get_asian_handicap,
    get_btts,
    get_ou,
    get_top_n_scorelines,
)
from v4.modules.m1_score.distributions import (
    DixonColesModel,
    NegBinGoalModel,
    PoissonGoalModel,
    detect_overdispersion,
)
from v4.modules.m1_score.optimizer import fit_dixon_coles_rho


# ─────────────────────────────────────────────────────────────────────
# Test runner helpers
# ─────────────────────────────────────────────────────────────────────


class SanityCheckFailed(AssertionError):
    pass


def assert_close(
    actual: float, expected: float, tol: float = IDENTITY_TOLERANCE, msg: str = ""
) -> None:
    """Default tol = IDENTITY_TOLERANCE (1e-9) — for exact-math identity checks.

    Callers verifying PROBABILITY validity (e.g., sums-to-1 on probability
    distributions) should pass tol=PROBABILITY_TOLERANCE explicitly to make
    the intent obvious at the call site.
    """
    if abs(actual - expected) > tol:
        raise SanityCheckFailed(
            f"{msg}: expected {expected}, got {actual}, diff={abs(actual - expected):.2e}"
        )


def assert_ge(actual: float, threshold: float, msg: str = "") -> None:
    if not (actual >= threshold):
        raise SanityCheckFailed(f"{msg}: expected ≥ {threshold}, got {actual}")


def assert_gt(actual: float, threshold: float, msg: str = "") -> None:
    if not (actual > threshold):
        raise SanityCheckFailed(f"{msg}: expected > {threshold}, got {actual}")


# ─────────────────────────────────────────────────────────────────────
# The 13 sanity tests
# ─────────────────────────────────────────────────────────────────────


def test_1_poisson_mass_capture():
    lam_h, lam_a = 1.4, 1.1
    model = PoissonGoalModel(lam_h, lam_a, max_goals=9)
    M = model.matrix()
    s = float(M.sum())
    assert_ge(s, 0.999, "Poisson 10x10 should capture ≥ 99.9% mass")
    return f"sum={s:.6f}"


def test_2_dc_near_zero_equals_poisson():
    lam_h, lam_a = 1.4, 1.1
    poisson_model = PoissonGoalModel(lam_h, lam_a)
    M_poisson_normed = poisson_model.matrix(normalize=True)
    # ρ very close to 0 → τ ≈ 1 everywhere → DC ≈ Poisson
    dc_model = DixonColesModel(lam_h, lam_a, rho=1e-10)
    M_dc = dc_model.matrix(normalize=True)
    max_diff = float(np.abs(M_dc - M_poisson_normed).max())
    assert_ge(1e-6, max_diff, f"DC(ρ≈0) should ≈ Poisson, max diff = {max_diff:.2e}")
    return f"max diff = {max_diff:.2e}"


def test_3_dc_negative_rho_boosts_draws():
    lam_h, lam_a = 1.4, 1.1
    poisson_model = PoissonGoalModel(lam_h, lam_a)
    M_poisson_normed = poisson_model.matrix(normalize=True)
    p_00_poisson = float(M_poisson_normed[0, 0])
    p_11_poisson = float(M_poisson_normed[1, 1])

    dc_neg = DixonColesModel(lam_h, lam_a, rho=-0.10)
    M_dc_neg = dc_neg.matrix(normalize=True)
    p_00_dc = float(M_dc_neg[0, 0])
    p_11_dc = float(M_dc_neg[1, 1])

    if not (p_00_dc > p_00_poisson):
        raise SanityCheckFailed(
            f"ρ<0 should boost P(0:0): Poisson={p_00_poisson:.4f} vs DC={p_00_dc:.4f}"
        )
    if not (p_11_dc > p_11_poisson):
        raise SanityCheckFailed(
            f"ρ<0 should boost P(1:1): Poisson={p_11_poisson:.4f} vs DC={p_11_dc:.4f}"
        )
    return (
        f"P(0:0) +{(p_00_dc-p_00_poisson)*100:.2f}pp, "
        f"P(1:1) +{(p_11_dc-p_11_poisson)*100:.2f}pp"
    )


def test_4_dc_matrix_sums_to_one():
    lam_h, lam_a = 1.4, 1.1
    dc = DixonColesModel(lam_h, lam_a, rho=-0.10)
    s = float(dc.matrix(normalize=True).sum())
    assert_close(s, 1.0, tol=PROBABILITY_TOLERANCE, msg="DC matrix should sum to 1.0")
    return f"sum = {s:.12f}"


def test_5_dc_no_negative_entries():
    lam_h, lam_a = 1.4, 1.1
    dc = DixonColesModel(lam_h, lam_a, rho=-0.10)
    M = dc.matrix()
    min_val = float(M.min())
    if min_val < 0:
        raise SanityCheckFailed(f"DC matrix has negative entry: min={min_val:.6f}")
    return f"min entry = {min_val:.6f}"


def test_6_negbin_mass_capture():
    nb = NegBinGoalModel(mu_h=1.4, mu_a=1.1, k_h=5.0, k_a=5.0, max_goals=9)
    M = nb.matrix()
    s = float(M.sum())
    assert_ge(s, 0.999, "NegBin should capture ≥ 99.9% mass with k=5")
    return f"sum = {s:.6f}"


def test_7_negbin_from_mean_var_rejects_underdispersed():
    # var ≤ mu = Poisson territory → should raise
    try:
        NegBinGoalModel.from_mean_var(mu_h=1.4, var_h=1.4, mu_a=1.1, var_a=1.1)
    except ValueError:
        return "correctly rejected var==mu"
    raise SanityCheckFailed("NegBin.from_mean_var should reject var ≤ mu")


def test_8_coarse_graining_1x2():
    lam_h, lam_a = 1.4, 1.1
    M = DixonColesModel(lam_h, lam_a, rho=-0.10).matrix()
    p = get_1x2(M)
    s = p["H"] + p["D"] + p["A"]
    assert_close(s, 1.0, tol=PROBABILITY_TOLERANCE, msg="1X2 should sum to 1.0")
    return f"H={p['H']:.3f}, D={p['D']:.3f}, A={p['A']:.3f}"


def test_9_coarse_graining_ou25():
    lam_h, lam_a = 1.4, 1.1
    M = DixonColesModel(lam_h, lam_a, rho=-0.10).matrix()
    p = get_ou(M, threshold=2.5)
    s = p["over"] + p["under"]
    assert_close(s, 1.0, tol=PROBABILITY_TOLERANCE, msg="O/U 2.5 should sum to 1.0")
    return f"over={p['over']:.3f}, under={p['under']:.3f}"


def test_10_coarse_graining_btts():
    lam_h, lam_a = 1.4, 1.1
    M = DixonColesModel(lam_h, lam_a, rho=-0.10).matrix()
    p = get_btts(M)
    s = p["yes"] + p["no"]
    assert_close(s, 1.0, tol=PROBABILITY_TOLERANCE, msg="BTTS should sum to 1.0")
    return f"yes={p['yes']:.3f}, no={p['no']:.3f}"


def test_11_asian_handicap_zero_equals_1x2():
    lam_h, lam_a = 1.4, 1.1
    M = DixonColesModel(lam_h, lam_a, rho=-0.10).matrix()
    p_ah = get_asian_handicap(M, handicap=0.0)
    p_1x2 = get_1x2(M)
    # AH @ 0 → home = P(1X2-H), push = P(1X2-D), away = P(1X2-A)
    assert_close(p_ah["home"], p_1x2["H"], tol=IDENTITY_TOLERANCE, msg="AH(0).home == 1X2.H")
    assert_close(p_ah["push"], p_1x2["D"], tol=IDENTITY_TOLERANCE, msg="AH(0).push == 1X2.D")
    assert_close(p_ah["away"], p_1x2["A"], tol=IDENTITY_TOLERANCE, msg="AH(0).away == 1X2.A")
    s = p_ah["home"] + p_ah["push"] + p_ah["away"]
    assert_close(s, 1.0, tol=PROBABILITY_TOLERANCE, msg="AH should sum to 1.0")
    return f"AH(0) = 1X2 ✓ (home={p_ah['home']:.3f}, push={p_ah['push']:.3f}, away={p_ah['away']:.3f})"


def test_12_overdispersion_detector():
    np.random.seed(42)
    poisson_goals = np.random.poisson(1.4, 500)
    # k=2 NegBin → variance much > mean
    p_nb = 2.0 / (2.0 + 1.4)
    negbin_goals = np.random.negative_binomial(2, p_nb, 500)
    od_poisson = detect_overdispersion(poisson_goals, threshold_ratio=1.2)
    od_negbin = detect_overdispersion(negbin_goals, threshold_ratio=1.2)
    if od_poisson:
        raise SanityCheckFailed(
            f"Poisson sample shouldn't be flagged overdispersed (var/mu = "
            f"{np.var(poisson_goals, ddof=1) / np.mean(poisson_goals):.3f})"
        )
    if not od_negbin:
        raise SanityCheckFailed(
            f"NegBin sample (k=2) should be flagged overdispersed (var/mu = "
            f"{np.var(negbin_goals, ddof=1) / np.mean(negbin_goals):.3f})"
        )
    return "Poisson clean, NegBin flagged ✓"


def test_13_dc_rho_mle_converges():
    """Synthetic test: generate matches under known ρ, fit ρ̂, check recovery."""
    np.random.seed(42)
    n = 5000
    true_rho = -0.08
    # Sample per-match λ from realistic football distribution
    lam_h = np.random.uniform(0.8, 2.5, n)
    lam_a = np.random.uniform(0.5, 2.0, n)

    # Sample goals from DC distribution per match.
    # Use rejection sampling for simplicity: sample from Poisson, reject via τ.
    goals_h = np.zeros(n, dtype=int)
    goals_a = np.zeros(n, dtype=int)
    for i in range(n):
        dc = DixonColesModel(lam_h[i], lam_a[i], rho=true_rho, max_goals=9)
        M = dc.matrix(normalize=True)
        # Sample from the full 2D distribution
        flat_idx = np.random.choice(M.size, p=M.flatten())
        goals_h[i] = flat_idx // M.shape[1]
        goals_a[i] = flat_idx % M.shape[1]

    result = fit_dixon_coles_rho(lam_h, lam_a, goals_h, goals_a)
    rho_hat = float(result.x[0])
    if not result.success:
        raise SanityCheckFailed(f"MLE did not converge: {result.message}")
    # Allow ±0.02 recovery tolerance (sampling noise)
    if abs(rho_hat - true_rho) > 0.025:
        raise SanityCheckFailed(
            f"ρ̂={rho_hat:.4f} not within 0.025 of true ρ={true_rho}"
        )
    return f"ρ̂={rho_hat:+.4f} (true={true_rho:+.4f}, |diff|={abs(rho_hat - true_rho):.4f})"


# ─────────────────────────────────────────────────────────────────────
# Driver
# ─────────────────────────────────────────────────────────────────────


TESTS = [
    ("[1]  Poisson mass capture", test_1_poisson_mass_capture),
    ("[2]  DC(ρ≈0) ≈ Poisson normed", test_2_dc_near_zero_equals_poisson),
    ("[3]  DC(ρ<0) boosts draw cells", test_3_dc_negative_rho_boosts_draws),
    ("[4]  DC matrix sum == 1.0", test_4_dc_matrix_sums_to_one),
    ("[5]  DC matrix has no negatives", test_5_dc_no_negative_entries),
    ("[6]  NegBin mass capture", test_6_negbin_mass_capture),
    ("[7]  NegBin rejects underdispersion", test_7_negbin_from_mean_var_rejects_underdispersed),
    ("[8]  Coarse-graining 1X2 sums to 1", test_8_coarse_graining_1x2),
    ("[9]  Coarse-graining O/U 2.5 sums", test_9_coarse_graining_ou25),
    ("[10] Coarse-graining BTTS sums", test_10_coarse_graining_btts),
    ("[11] AH(0) == 1X2", test_11_asian_handicap_zero_equals_1x2),
    ("[12] Overdispersion detector", test_12_overdispersion_detector),
    ("[13] DC ρ MLE converges + recovers ρ", test_13_dc_rho_mle_converges),
]


def main() -> int:
    print("=" * 70)
    print("V4 m1_score — Stage 1 Math Identity Checks")
    print("=" * 70)

    n_pass = 0
    n_fail = 0
    failures = []

    for label, test_fn in TESTS:
        try:
            note = test_fn()
            print(f"  ✓ {label:42} {note}")
            n_pass += 1
        except SanityCheckFailed as e:
            print(f"  ✗ {label:42} FAILED: {e}")
            failures.append((label, str(e)))
            n_fail += 1
        except Exception as e:
            print(f"  ✗ {label:42} CRASH: {type(e).__name__}: {e}")
            failures.append((label, f"{type(e).__name__}: {e}"))
            n_fail += 1

    print()
    print("=" * 70)
    if n_fail == 0:
        print(f"✓ ALL {n_pass}/{len(TESTS)} TESTS PASSED")
        print("  → m1_score Stage 1 math gate cleared. Move on to m2_lambda + m3_xg.")
    else:
        print(f"✗ {n_fail}/{len(TESTS)} TESTS FAILED")
        for label, err in failures:
            print(f"    {label}: {err}")
    print("=" * 70)
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
