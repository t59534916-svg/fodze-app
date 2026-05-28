"""Loads public/filter-shield-config.json and exposes typed accessors.

Public JSON is the single source of truth for both Python and TS (mirror in
src/lib/filter-shield.ts). Magic-numbers MUST NOT be inlined into code —
they live here so Python and TS can't drift.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_CONFIG_PATH = REPO_ROOT / "public" / "filter-shield-config.json"


@dataclass(frozen=True)
class RegimeConfig:
    name: str
    acf_max: float | None        # for persistent_reversal: max value of rho_1
    acf_max_abs: float | None    # for catastrophic: max |rho_1|
    delta_min_abs: float | None  # for catastrophic: min |delta_mu|
    multiplier: float
    active: bool                  # if False → SHADOW_LOG_ONLY, multiplier ignored


@dataclass(frozen=True)
class CsdVetoConfig:
    signal: str                   # "goal_diff" — empirically winning signal
    window: int                   # 10
    min_obs: int                  # 8
    recent_block: int             # 3
    leakage_offset_sec: int       # 14400 (4h M6 strict-lagging)
    sign_flip_min_abs: float      # 0.10
    regimes: dict[str, RegimeConfig]


@dataclass(frozen=True)
class FilterShieldConfig:
    version: str
    csd_veto: CsdVetoConfig


def load_config(path: Path | None = None) -> FilterShieldConfig:
    path = path or DEFAULT_CONFIG_PATH
    raw = json.loads(path.read_text())

    csd = raw["csd_veto"]
    regimes = {}
    for name, r in csd["regimes"].items():
        regimes[name] = RegimeConfig(
            name=name,
            acf_max=r.get("acf_max"),
            acf_max_abs=r.get("acf_max_abs"),
            delta_min_abs=r.get("delta_min_abs"),
            multiplier=float(r["multiplier"]),
            active=bool(r["active"]),
        )

    return FilterShieldConfig(
        version=raw["version"],
        csd_veto=CsdVetoConfig(
            signal=csd["signal"],
            window=int(csd["window"]),
            min_obs=int(csd["min_obs"]),
            recent_block=int(csd["recent_block"]),
            leakage_offset_sec=int(csd["leakage_offset_sec"]),
            sign_flip_min_abs=float(csd["sign_flip_min_abs"]),
            regimes=regimes,
        ),
    )
