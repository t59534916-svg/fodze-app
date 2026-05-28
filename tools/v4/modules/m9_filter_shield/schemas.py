"""Shared dataclasses + type aliases for the Filter-Shield module."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

BetSide = Literal[
    "home", "away", "draw",
    "over", "under",
    "btts_yes", "btts_no",
]


@dataclass
class ShieldVeto:
    """A single veto firing — identifies the source, multiplier, and which
    markets it applies to. Stored in epistemic_trails for forensic audit.
    """
    name: str                       # e.g. "CSD_REGIME_SHIFT:persistent_reversal:home"
    multiplier: float               # [0.0, 1.0]
    reason: str                     # human-readable diagnostic
    applies_to: list[BetSide]       # which markets this veto affects
    raw_diagnostic: dict = field(default_factory=dict)  # for trail logging
    shadow: bool = False            # if True: log only, do NOT alter stake


@dataclass
class ShieldResult:
    """Final output: which vetoes fired, what's the effective multiplier."""
    effective_multiplier: float
    haircut_pct: float
    applied_vetoes: list[ShieldVeto]
    shadow_vetoes: list[ShieldVeto]
    bet_side: BetSide
