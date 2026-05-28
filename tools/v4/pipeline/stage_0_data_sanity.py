"""
Stage 0 — Data sanity gate. Runs BEFORE any training.

Per V4-BACKTESTING-PROTOCOL.md §"Stage 0: Pre-Train Sanity Checks":
  0a. Data leakage test (poison-row method) — TBD, pending tools/feature_lab/test_leakage.py
  0b. Schema validation — all expected tables in local SQLite mirror
  0c. Coverage check per Liga (per-tier floor)

Run: tools/venv/bin/python3 -I tools/v4/pipeline/stage_0_data_sanity.py

Pass criteria: 100% green, all required tables present, per-Liga coverage above tier-floor.
On fail: BLOCK training pipeline. Fix data issue first.

Implementation note: imports check-scripts as modules (NOT subprocess) so output goes
to this process's stdout/stderr directly and connection state is shared. The
imported `main()` functions return 0/1 exit codes; we aggregate and return the max.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
V4_ROOT = REPO_ROOT / "tools" / "v4"

# Make tools/v4 importable so we can `from validate_schema import main as _validate_main`
sys.path.insert(0, str(V4_ROOT))


def _load_check(module_name: str) -> Callable[[], int]:
    """Import a check module's main() function, with clear error if module missing.

    Returns the imported function. Raises if module doesn't exist or has no main().
    """
    try:
        module = __import__(module_name)
    except ImportError as e:
        raise ImportError(
            f"Stage 0 check module '{module_name}' not found. "
            f"Expected at tools/v4/{module_name}.py — see V4-BACKTESTING-PROTOCOL.md "
            f"§'Stage 0' for spec."
        ) from e
    if not hasattr(module, "main") or not callable(module.main):
        raise AttributeError(
            f"Stage 0 check module '{module_name}' has no callable main(). "
            f"Convention: each Stage 0 script defines `def main() -> int`."
        )
    return module.main


def main() -> int:
    print("=" * 70)
    print("V4 Stage 0 — Data Sanity Gate (pre-training)")
    print("=" * 70)

    # Module name → human label. Order matters: schema FIRST (if tables missing,
    # coverage check would crash unhelpfully).
    checks: List[Tuple[str, str]] = [
        ("validate_schema", "0b. Schema validation"),
        ("coverage_audit", "0c. Per-Liga coverage check"),
        # ("test_leakage", "0a. Data leakage test"),  # pending
    ]

    n_pass = 0
    n_fail = 0
    failures: List[str] = []

    for module_name, label in checks:
        print()
        print(f"→ {label} ({module_name}.py)")
        print("-" * 70)
        try:
            check_fn = _load_check(module_name)
            rc = check_fn()
        except (ImportError, AttributeError) as e:
            print(f"  ✗ {label} could not load: {e}")
            n_fail += 1
            failures.append(f"{label}: load error")
            continue
        except Exception as e:  # pragma: no cover — defensive
            print(f"  ✗ {label} CRASH: {type(e).__name__}: {e}")
            n_fail += 1
            failures.append(f"{label}: crash")
            continue

        if rc == 0:
            n_pass += 1
        else:
            n_fail += 1
            failures.append(f"{label}: exit {rc}")

    print()
    print("=" * 70)
    if n_fail == 0:
        print(f"✓ ALL {n_pass}/{len(checks)} STAGE 0 CHECKS PASSED")
        print("  → Data sanity OK. Training pipeline cleared for Stage 1.")
    else:
        print(f"✗ {n_fail}/{len(checks)} STAGE 0 CHECKS FAILED")
        for f in failures:
            print(f"    {f}")
        print("  → BLOCK training. Fix data issues before proceeding.")
    print("=" * 70)
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
