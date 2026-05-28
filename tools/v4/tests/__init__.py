"""v4.tests — pytest-discoverable test suite for v4 modules.

Discovery: from repo root, run
  tools/venv/bin/python3 -m pytest tools/v4/tests/ -v

Tests are thin pytest-wrappers around the standalone runner scripts so we
don't duplicate test logic. If a wrapper diverges from its underlying
runner, that's a bug — re-sync the wrapper.
"""
