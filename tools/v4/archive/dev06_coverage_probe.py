#!/usr/bin/env python3
"""
Coverage probe for the 9 m3_premium features on a random 100-match sample.

Verifies the per-feature non-None rate against the 2026-05-20 reference
probe documented in coverage_router.py. Run after implementing or modifying
calculators to catch coverage regressions.

Usage:
  tools/venv/bin/python3 tools/v4/diagnostics/dev06_coverage_probe.py [--n 100]
"""
import argparse
import random
import sqlite3
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools"))

from v4.modules.m3_xg.feature_builder_premium import (  # noqa: E402
    build_premium_features_for_match,
    PREMIUM_FEATURE_ORDER,
)

DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"

PREMIUM_LEAGUES = ('epl', 'la_liga', 'bundesliga', 'serie_a', 'ligue_1', 'championship', 'liga3')

# 2026-05-20 reference coverage (per-feature %, from initial coverage probe)
REFERENCE_COVERAGE = {
    "mean_shot_xg_for_diff":    96.4,
    "big_chance_rate_diff":     82.1,
    "key_pass_quality_diff":    98.1,
    "xa_creator_concentration": 98.1,
    "attack_position_y_diff":   96.0,
    "defense_line_height_diff": 96.0,
    "tactical_width_diff":      96.0,
    "manager_tenure_match_idx": 98.2,
    "setpiece_xg_share_diff":   96.4,
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=100, help="sample size")
    p.add_argument("--season", default="24/25")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    con = sqlite3.connect(DB)
    placeholders = ",".join("?" * len(PREMIUM_LEAGUES))
    gids = [r[0] for r in con.execute(
        f"""
        SELECT game_id FROM sofascore_match
        WHERE league IN ({placeholders}) AND season = ? AND status = 'Ended'
        """,
        (*PREMIUM_LEAGUES, args.season),
    ).fetchall()]
    con.close()

    if len(gids) < args.n:
        print(f"WARN: only {len(gids)} matches available, sampling all")
        sample = gids
    else:
        random.seed(args.seed)
        sample = random.sample(gids, args.n)

    t0 = time.time()
    non_none = {f: 0 for f in PREMIUM_FEATURE_ORDER}
    errors = 0
    for i, gid in enumerate(sample):
        try:
            out = build_premium_features_for_match(gid, impute_zero_on_missing=False)
            for f, v in out.items():
                if v is not None:
                    non_none[f] += 1
        except Exception as e:
            errors += 1
            print(f"  ERROR on game_id={gid}: {type(e).__name__}: {e}", file=sys.stderr)

    elapsed = time.time() - t0
    n = len(sample)

    print(f"\nCoverage probe on {n} random {args.season} Tier-A matches")
    print(f"  premium leagues: {', '.join(PREMIUM_LEAGUES)}")
    print(f"  elapsed: {elapsed:.1f}s  (~{elapsed * 7400 / n:.0f}s projected for full 7400-match training corpus)")
    print(f"  errors: {errors}")
    print()
    header = f"{'Feature':<32s} {'Observed':>10s} {'Reference':>10s} {'Delta':>8s}"
    print(header)
    print("-" * len(header))
    for f in PREMIUM_FEATURE_ORDER:
        pct = 100.0 * non_none[f] / n
        ref = REFERENCE_COVERAGE[f]
        delta = pct - ref
        marker = "✅" if abs(delta) < 10 else "⚠"
        print(f"{f:<32s} {pct:>9.1f}% {ref:>9.1f}% {delta:>+7.1f}pp {marker}")

    # Pass/fail: all features within 10pp of reference
    failing = [f for f in PREMIUM_FEATURE_ORDER
               if abs(100.0 * non_none[f] / n - REFERENCE_COVERAGE[f]) >= 10]
    if failing:
        print(f"\n⚠ {len(failing)} features drift > 10pp from reference: {failing}")
        return 1
    print("\nAll features within 10pp of 2026-05-20 reference. ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
