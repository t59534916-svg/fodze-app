"""Pytest wrapper for m1_score math identity tests.

This file imports the TESTS list from pipeline/stage_1_m1_score.py and
parametrizes pytest over each test function. If you add a test to
stage_1_m1_score.py's TESTS list, it auto-shows up here — no duplication.

Run: tools/venv/bin/python3 -m pytest tools/v4/tests/test_m1_score.py -v
"""
from __future__ import annotations

import pytest

# Import the canonical test list from the standalone runner. conftest.py has
# already prepended tools/v4/ to sys.path so `pipeline.stage_1_m1_score` resolves.
from v4.pipeline import stage_1_m1_score as _runner


@pytest.mark.parametrize(
    "label,test_fn",
    _runner.TESTS,
    ids=[label.strip().split()[0].strip("[]") for label, _ in _runner.TESTS],
)
def test_m1_score_identity(label: str, test_fn) -> None:
    """Each entry in stage_1_m1_score.TESTS becomes one parametrized pytest case."""
    try:
        test_fn()
    except _runner.SanityCheckFailed as e:
        pytest.fail(f"{label} — {e}")
