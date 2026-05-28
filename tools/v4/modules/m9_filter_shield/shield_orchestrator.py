"""FilterShield — min-pool veto stacker.

Mirrors v1.1 Asymmetric Negation Protocol M7 (src/lib/goldilocks-engine.ts):
  - multiplier ∈ [0, 1.0] HARD clamped
  - Stacking: MIN-pool, NOT product, NOT sum, NOT mean
  - Rationale: two vetoes saying "danger" don't multiply danger;
    they confirm a single state of caution.

Shadow vs active vetoes:
  - Shadow vetoes are LOGGED to epistemic_trails but do NOT alter
    effective_multiplier.
  - This implements the M2 SHADOW_LOG_ONLY quarantine pattern: new
    regimes start in shadow until they accumulate 200 firings, then
    burn-in cron (scripts/burn-in-shadow-signals.mjs) graduates them.
"""
from __future__ import annotations

from .schemas import BetSide, ShieldResult, ShieldVeto


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


class FilterShield:
    """
    Veto accumulator + applicator.

    Usage:
        shield = FilterShield()
        shield.add(some_veto)
        result = shield.apply(bet_side="home")
        final_kelly = base_kelly * result.effective_multiplier
    """
    def __init__(self):
        self._vetoes: list[ShieldVeto] = []

    @property
    def vetoes(self) -> list[ShieldVeto]:
        """All accumulated vetoes (active + shadow), read-only view."""
        return list(self._vetoes)

    def add(self, veto: ShieldVeto | None) -> None:
        if veto is None:
            return
        # Defensive clamp on multiplier (M7 invariant)
        clamped = ShieldVeto(
            name=veto.name,
            multiplier=_clamp01(veto.multiplier),
            reason=veto.reason,
            applies_to=veto.applies_to,
            raw_diagnostic=veto.raw_diagnostic,
            shadow=veto.shadow,
        )
        self._vetoes.append(clamped)

    def extend(self, vetoes: list[ShieldVeto | None]) -> None:
        for v in vetoes:
            self.add(v)

    def apply(self, bet_side: BetSide) -> ShieldResult:
        """
        Compute effective multiplier for a specific bet-side.

        Only vetoes whose applies_to contains bet_side are considered. Shadow
        vetoes are returned in `shadow_vetoes` but excluded from the multiplier.
        """
        relevant_active = [
            v for v in self._vetoes
            if bet_side in v.applies_to and not v.shadow
        ]
        relevant_shadow = [
            v for v in self._vetoes
            if bet_side in v.applies_to and v.shadow
        ]

        if not relevant_active:
            return ShieldResult(
                effective_multiplier=1.0,
                haircut_pct=0.0,
                applied_vetoes=[],
                shadow_vetoes=relevant_shadow,
                bet_side=bet_side,
            )

        # MIN-pool: worst-veto wins (NOT product, NOT mean)
        min_mult = min(v.multiplier for v in relevant_active)
        return ShieldResult(
            effective_multiplier=min_mult,
            haircut_pct=(1.0 - min_mult) * 100.0,
            applied_vetoes=relevant_active,
            shadow_vetoes=relevant_shadow,
            bet_side=bet_side,
        )
