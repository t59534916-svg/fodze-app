"""pytest conftest — ensures `from v4.modules.m1_score...` works in tests.

Adds tools/ to sys.path so the `v4` package is importable regardless of where
pytest is invoked from (repo root, tools/, or tools/v4/tests/).
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TOOLS_ROOT = REPO_ROOT / "tools"
V4_ROOT = REPO_ROOT / "tools" / "v4"

# Put tools/ on path first so `import v4...` works
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))
# Also put tools/v4/ on path so `import validate_schema` / `import coverage_audit` works
if str(V4_ROOT) not in sys.path:
    sys.path.insert(0, str(V4_ROOT))
