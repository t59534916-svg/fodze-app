"""JSON export of per-league isotonic calibrator → public/per_league_calibration.json."""
from __future__ import annotations

import json
from pathlib import Path

from .fit import PerLeagueIsotonicCalibrator


def export_json(cal: PerLeagueIsotonicCalibrator, out_path: Path,
                acceptance_summary: dict | None = None) -> None:
    """Serialize fitted calibrator + walk-forward acceptance summary."""
    payload = cal.export_dict()
    if acceptance_summary is not None:
        payload["acceptance_summary"] = acceptance_summary
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str))
    print(f"[write] {out_path} ({out_path.stat().st_size:,} bytes)")
