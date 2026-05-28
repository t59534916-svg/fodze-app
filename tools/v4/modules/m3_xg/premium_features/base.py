"""
Shared base + 1 reference implementation + 8 typed stubs for the
m3_premium feature calculators.

Architecture:
  ┌─────────────────────────┐
  │   PremiumFeature ABC    │
  │  .compute(gid, side)    │
  └───────────┬─────────────┘
              │
              ├─ TacticalWidthDiff ✅  (fully implemented + tested)
              ├─ MeanShotXgDiff       ⏳ Sprint 2
              ├─ BigChanceRateDiff    ⏳ Sprint 2
              ├─ KeyPassQualityDiff   ⏳ Sprint 2
              ├─ XaCreatorConcentration ⏳ Sprint 2
              ├─ AttackPositionYDiff  ⏳ Sprint 2
              ├─ DefenseLineHeightDiff ⏳ Sprint 2
              ├─ ManagerTenureMatchIdx ⏳ Sprint 2
              └─ SetpieceXgShareDiff  ⏳ Sprint 2

Each subclass implements `_compute_side(game_id, is_home, prior_games)`. The
ABC handles the boilerplate: rolling-window lookup, EWMA weighting, and the
home-minus-away differential.

Why ABC + composition (vs free functions): the rolling-window logic is the
SAME across 8 of the 9 features (EWMA-5 over prior matches per team). The
ABC factors that out so each subclass is ~15 lines of math instead of
80-line copy-paste.
"""
from __future__ import annotations

import sqlite3
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

# ── Local-SQLite path (single source for all 9 features) ────────────────
REPO_ROOT = Path(__file__).resolve().parents[5]
LOCAL_DB = REPO_ROOT / "tools" / "sofascore" / "data" / "local_extras.db"


# ── EWMA-5 weights ───────────────────────────────────────────────────────
# Most-recent match: weight 1.0; one back: 0.5; two back: 0.25; three back:
# 0.125; four back: 0.0625. Matches the SQL formula in strict_lagging.sql.
EWMA_5_WEIGHTS: Tuple[float, ...] = (1.0, 0.5, 0.25, 0.125, 0.0625)


@dataclass(frozen=True)
class PriorMatch:
    """One historical match for a specific team — sufficient context for any
    feature calculator. Loaded once per (game_id, side) and shared across all
    9 feature subclasses to avoid 9× DB-round-trips."""
    game_id: int
    is_home: int
    start_timestamp: int


class PremiumFeature(ABC):
    """Base class for a Sofa-extras-derived rolling-window feature.

    Subclass contract:
      • implement `_compute_side(game_id, is_home, prior_games)` returning the
        team-side scalar (or None if data missing).
      • OPTIONAL: override `n_prior` if the feature needs ≠5 matches.

    The base class handles:
      • Opening the local SQLite connection
      • Looking up prior games for the focal team
      • Computing the home-minus-away differential
      • Returning None gracefully when any side has insufficient data
    """

    n_prior: int = 5
    weights: Tuple[float, ...] = EWMA_5_WEIGHTS
    feature_name: str = "premium_feature_base"  # override in subclass

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or LOCAL_DB

    # ── Public API ──────────────────────────────────────────────────────
    def compute(self, game_id: int, side: str) -> Optional[float]:
        """Return scalar for one (game, side). `side` ∈ {'home','away','diff'}.

        For 'diff': home − away (the model-input shape — eliminates a degree
        of freedom and centers around 0 for symmetric features).
        """
        if side == "diff":
            h = self.compute(game_id, "home")
            a = self.compute(game_id, "away")
            if h is None or a is None:
                return None
            return h - a
        if side not in ("home", "away"):
            raise ValueError(f"side must be 'home', 'away', or 'diff' (got {side!r})")
        is_home = 1 if side == "home" else 0
        prior = self._load_prior_games(game_id, is_home)
        if len(prior) < self.min_required_prior():
            return None
        return self._compute_side(game_id, is_home, prior)

    def min_required_prior(self) -> int:
        """Default: need 3 of 5 prior matches. Override if subclass needs more."""
        return 3

    # ── Hook for subclasses ─────────────────────────────────────────────
    @abstractmethod
    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        """Subclasses implement this with their feature-specific math."""
        raise NotImplementedError

    # ── Helpers used by subclasses ──────────────────────────────────────
    def _load_prior_games(self, game_id: int, is_home: int) -> List[PriorMatch]:
        """Find the focal team's last `n_prior` matches before this game.

        Looks up the team_id via sofascore_match (using home_team_id or
        away_team_id depending on side), then queries for prior games where
        that team appears (either as home or away — we want their actual prior
        matches regardless of venue).
        """
        with sqlite3.connect(self.db_path) as con:
            cur = con.execute(
                """
                SELECT home_team_id, away_team_id, start_timestamp
                FROM sofascore_match
                WHERE game_id = ?
                """,
                (game_id,),
            )
            row = cur.fetchone()
            if row is None:
                return []
            home_tid, away_tid, focal_ts = row
            focal_team_id = home_tid if is_home == 1 else away_tid
            if focal_team_id is None or focal_ts is None:
                return []

            # Find prior games for this team (regardless of venue) — descending
            # timestamp, limit to n_prior.
            cur = con.execute(
                """
                SELECT game_id, start_timestamp,
                       CASE WHEN home_team_id = ? THEN 1 ELSE 0 END as was_home
                FROM sofascore_match
                WHERE (home_team_id = ? OR away_team_id = ?)
                  AND start_timestamp < ?
                  AND status = 'Ended'
                ORDER BY start_timestamp DESC
                LIMIT ?
                """,
                (focal_team_id, focal_team_id, focal_team_id, focal_ts, self.n_prior),
            )
            return [
                PriorMatch(game_id=g, is_home=h, start_timestamp=t)
                for g, t, h in cur.fetchall()
            ]

    def _ewma(self, values: List[float]) -> Optional[float]:
        """EWMA over an ordered (most-recent-first) list of values. Skips
        Nones; uses weights truncated to len(values)."""
        clean = [(v, w) for v, w in zip(values, self.weights) if v is not None]
        if not clean:
            return None
        num = sum(v * w for v, w in clean)
        den = sum(w for _, w in clean)
        return num / den if den > 0 else None


# ═══════════════════════════════════════════════════════════════════════════
# REFERENCE IMPLEMENTATION — TacticalWidthDiff
# ═══════════════════════════════════════════════════════════════════════════
#
# The cleanest of the 9 features to demonstrate the full pattern:
#   • Reads from sofascore_average_positions
#   • Aggregates per-game (std of x-coordinates across the 11 starters)
#   • EWMA-5 over prior team matches
#   • Returned as a per-team scalar; the ABC computes home-away diff
#
# The other 8 features will follow the same pattern in Sprint 2.

class TacticalWidthDiff(PremiumFeature):
    """Home tactical width − away tactical width.

    Tactical width = std(player_x_position) across the 11 starters. High
    width = wing-play / spread formation; low width = central / narrow.
    Per-game value averaged over the last 5 prior matches for each side, then
    home - away.
    """

    feature_name = "tactical_width_diff"

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        per_game_widths: List[Optional[float]] = []
        with sqlite3.connect(self.db_path) as con:
            for pm in prior_games:
                # In each prior game, find this team's avg_positions
                # (we know was_home from PriorMatch.is_home; the team_id
                # disambiguation already happened in _load_prior_games).
                cur = con.execute(
                    """
                    SELECT avg_x FROM sofascore_average_positions
                    WHERE game_id = ? AND is_home = ?
                      AND avg_x IS NOT NULL
                      AND points_count >= 10   -- only consider players with meaningful presence
                    """,
                    (pm.game_id, pm.is_home),
                )
                xs = [r[0] for r in cur.fetchall()]
                if len(xs) < 7:  # need ≥7 outfield+gk players to compute meaningful std
                    per_game_widths.append(None)
                    continue
                # Standard deviation of x-coordinates
                mean_x = sum(xs) / len(xs)
                var = sum((x - mean_x) ** 2 for x in xs) / len(xs)
                per_game_widths.append(var ** 0.5)
        return self._ewma(per_game_widths)


# ═══════════════════════════════════════════════════════════════════════════
# STUBS — Sprint 2 implementations
# ═══════════════════════════════════════════════════════════════════════════
#
# Each stub locks the interface (feature_name + class signature) so
# feature_builder_premium.py can wire them in NOW; the math gets filled in
# during Sprint 2. Coverage requirements per the 2026-05-20 probe are noted
# on each so the implementer doesn't get caught by Sparsity-Trap on a
# feature that looked fine in isolation.

class MeanShotXgDiff(PremiumFeature):
    """Home avg-xg-per-shot − away avg-xg-per-shot (rolling-5 EWMA).
    Reads from sofascore_shotmap.xg per shot, mean per game per team.
    Coverage on premium-7-leagues × 3-seasons: 96.4%."""
    feature_name = "mean_shot_xg_for_diff"

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        per_game_avg_xg: List[Optional[float]] = []
        with sqlite3.connect(self.db_path) as con:
            for pm in prior_games:
                row = con.execute(
                    """
                    SELECT AVG(xg) FROM sofascore_shotmap
                    WHERE game_id = ? AND is_home = ? AND xg IS NOT NULL AND xg > 0
                    """,
                    (pm.game_id, pm.is_home),
                ).fetchone()
                per_game_avg_xg.append(row[0] if row and row[0] is not None else None)
        return self._ewma(per_game_avg_xg)


class BigChanceRateDiff(PremiumFeature):
    """Home big_chances/game − away big_chances/game (rolling-5 EWMA).
    Reads from sofascore_match_statistics.big_chances WHERE period='ALL'.
    Coverage: 82.1% — impute 0 when missing rather than skip."""
    feature_name = "big_chance_rate_diff"

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        per_game_bc: List[Optional[float]] = []
        with sqlite3.connect(self.db_path) as con:
            for pm in prior_games:
                row = con.execute(
                    """
                    SELECT big_chances FROM sofascore_match_statistics
                    WHERE game_id = ? AND is_home = ? AND period = 'ALL'
                    """,
                    (pm.game_id, pm.is_home),
                ).fetchone()
                # Coverage gap (~18% of premium matches) → impute 0 rather than
                # propagate None all the way to EWMA. Empty-stat games are rare
                # enough that this rarely dominates the rolling-5 mean.
                v = row[0] if row and row[0] is not None else 0.0
                per_game_bc.append(float(v))
        return self._ewma(per_game_bc)


class KeyPassQualityDiff(PremiumFeature):
    """Home key-passes-per-90 weighted by top-11 minutes − away same.
    Reads from sofascore_player_match_stats (is_starter=1, top-11-by-minutes).
    Coverage: 98.1%."""
    feature_name = "key_pass_quality_diff"

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        per_game_kpp90: List[Optional[float]] = []
        with sqlite3.connect(self.db_path) as con:
            for pm in prior_games:
                # Top-11-by-minutes starters; key_passes per minute → per-90
                # weighted by minutes (a player who played 90 min weighs full,
                # subbed-in player weighs proportionally).
                rows = con.execute(
                    """
                    SELECT key_passes, minutes_played
                    FROM sofascore_player_match_stats
                    WHERE game_id = ? AND is_home = ? AND is_starter = 1
                      AND minutes_played > 0
                      AND key_passes IS NOT NULL
                    ORDER BY minutes_played DESC
                    LIMIT 11
                    """,
                    (pm.game_id, pm.is_home),
                ).fetchall()
                if not rows:
                    per_game_kpp90.append(None)
                    continue
                total_kp = sum(r[0] for r in rows)
                total_min = sum(r[1] for r in rows)
                # KP per 90 minutes of total starter-time
                kpp90 = (total_kp * 90.0 / total_min) if total_min > 0 else None
                per_game_kpp90.append(kpp90)
        return self._ewma(per_game_kpp90)


class XaCreatorConcentration(PremiumFeature):
    """Herfindahl index of xa across players (1 player = 1.0, even-spread → 1/n).
    Reads from sofascore_player_match_stats.expected_assists.
    Single-team scalar (no diff) — high concentration = depends on one creator
    (fragile to injuries), low = team-distributed (robust).
    Coverage: 98.1%."""
    feature_name = "xa_creator_concentration"

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        per_game_hhi: List[Optional[float]] = []
        with sqlite3.connect(self.db_path) as con:
            for pm in prior_games:
                xas = [r[0] for r in con.execute(
                    """
                    SELECT expected_assists FROM sofascore_player_match_stats
                    WHERE game_id = ? AND is_home = ?
                      AND expected_assists IS NOT NULL AND expected_assists > 0
                    """,
                    (pm.game_id, pm.is_home),
                ).fetchall()]
                # Herfindahl: sum of squared shares. If only 1 contributor → 1.0,
                # if N evenly-spread → 1/N (close to 0 for 11 players).
                total_xa = sum(xas)
                if total_xa < 0.05 or len(xas) < 2:
                    # Too little creation to characterize concentration → None
                    per_game_hhi.append(None)
                    continue
                shares = [x / total_xa for x in xas]
                hhi = sum(s * s for s in shares)
                per_game_hhi.append(hhi)
        return self._ewma(per_game_hhi)


class AttackPositionYDiff(PremiumFeature):
    """Home mean attacker-y − away mean attacker-y (rolling-5).
    Reads from sofascore_average_positions × sofascore_player_match_stats
    filtered by position startswith 'F' (forwards). High y = high-press
    attack-line; low y = sitting-back pattern.
    Coverage: 96.0%."""
    feature_name = "attack_position_y_diff"

    # Sofa position prefixes for attackers. F=forward, W=winger sometimes coded
    # separately. We include W to be inclusive — single-line teams (e.g. 4-3-3)
    # have wide forwards.
    ATTACKER_PREFIXES = ("F",)

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        return _mean_y_by_position(
            db_path=self.db_path,
            prior_games=prior_games,
            position_prefixes=self.ATTACKER_PREFIXES,
            ewma=self._ewma,
        )


class DefenseLineHeightDiff(PremiumFeature):
    """Home mean defender-y − away mean defender-y. Mirror of AttackPositionY
    but for DEF-position players. Offside-trap indicator.
    Coverage: 96.0%."""
    feature_name = "defense_line_height_diff"

    DEFENDER_PREFIXES = ("D",)

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        return _mean_y_by_position(
            db_path=self.db_path,
            prior_games=prior_games,
            position_prefixes=self.DEFENDER_PREFIXES,
            ewma=self._ewma,
        )


def _mean_y_by_position(
    db_path,
    prior_games: List[PriorMatch],
    position_prefixes: Tuple[str, ...],
    ewma,
) -> Optional[float]:
    """Shared helper: mean of avg_y across players whose position startswith
    one of the given prefixes, joined player_match_stats × average_positions.
    EWMA over prior_games. Returns None if all games miss data."""
    per_game_y: List[Optional[float]] = []
    # Build a LIKE clause for the position prefixes. Sofa positions are like
    # 'F', 'FW', 'D', 'DC', 'DL', 'DR', 'AM', 'DM', etc. Prefix-matching
    # captures all variants of forwards (F, FW, ...) or defenders (D, DC,
    # DL, DR) without listing every code.
    like_or = " OR ".join("pms.position LIKE ?" for _ in position_prefixes)
    like_args = [f"{p}%" for p in position_prefixes]
    with sqlite3.connect(db_path) as con:
        for pm in prior_games:
            row = con.execute(
                f"""
                SELECT AVG(ap.avg_y) FROM sofascore_average_positions ap
                JOIN sofascore_player_match_stats pms
                  ON pms.game_id = ap.game_id AND pms.player_id = ap.player_id
                WHERE ap.game_id = ? AND ap.is_home = ?
                  AND ap.avg_y IS NOT NULL AND ap.points_count >= 10
                  AND pms.is_starter = 1
                  AND ({like_or})
                """,
                (pm.game_id, pm.is_home, *like_args),
            ).fetchone()
            per_game_y.append(row[0] if row and row[0] is not None else None)
    return ewma(per_game_y)


class ManagerTenureMatchIdx(PremiumFeature):
    """Per-team scalar (not diff): #matches since current manager started, ∈ [0, 30].
    Reads from sofascore_match_managers — walks BACKWARD from the focal match,
    counting consecutive games with the SAME manager_id. Stops at the first
    manager_id mismatch (= prior manager) or at 30 (settled-regime cap).

    Does NOT use EWMA (overrides .compute()) — this is a discrete count, not a
    rate. Coverage: 98.2%. This is the FIRST real-data implementation of the
    M4 mandate's `matchSinceManagerChange` signal in goldilocks-engine."""
    feature_name = "manager_tenure_match_idx"

    # Override: we need MORE than n_prior=5 because tenure can be long.
    # 30 matches = ~7 months of weekly games — beyond which manager-bounce
    # regime is considered settled (per the M4 audit).
    n_prior: int = 30

    def min_required_prior(self) -> int:
        # Tenure can be measured even with just 1 prior — we don't need
        # a full 30-game look-back for a freshly-appointed manager.
        return 1

    def _load_manager_for_team_in_game(
        self, con: sqlite3.Connection, game_id: int, is_home: int
    ) -> Optional[int]:
        """Find the manager_id for one team in one game. Returns None if
        we have no manager record for that team in that game.

        Note: `sofascore_match_managers` PK is (game_id, is_home) — no
        team_id column. We rely on is_home being consistent across the
        team's prior-games (PriorMatch.is_home tracks venue per match).
        """
        row = con.execute(
            "SELECT manager_id FROM sofascore_match_managers WHERE game_id = ? AND is_home = ?",
            (game_id, is_home),
        ).fetchone()
        return row[0] if row and row[0] is not None else None

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        with sqlite3.connect(self.db_path) as con:
            if not prior_games:
                return None
            # Walk through prior_games (most-recent-first). Skip leading None
            # records (occasional missing manager_id even in 24/25+ data —
            # ~1-2% per the coverage probe). Anchor on the first non-None as
            # the "current" manager, then count consecutive same-manager
            # matches forward in time (= back through the list).
            mgr_seq: List[Optional[int]] = []
            for pm in prior_games:
                mgr_seq.append(self._load_manager_for_team_in_game(
                    con, pm.game_id, pm.is_home,
                ))
        # Find first non-None as anchor
        try:
            anchor_idx = next(i for i, m in enumerate(mgr_seq) if m is not None)
        except StopIteration:
            return None  # No manager data at all → tenure undefined
        current_mid = mgr_seq[anchor_idx]
        # Count consecutive matches with current_mid (Nones treated as "carry
        # forward" — assume same manager rather than a 1-match gap of None
        # records signaling a regime change).
        tenure = 1
        for prev_mid in mgr_seq[anchor_idx + 1:]:
            if prev_mid is None:
                # Treat None as "missing data, same manager" — continue counting
                tenure += 1
                continue
            if prev_mid != current_mid:
                break
            tenure += 1
        return float(min(tenure, 30))


class SetpieceXgShareDiff(PremiumFeature):
    """Home (xG from set-pieces / total xG) − away same.
    Reads from sofascore_shotmap.situation IN ('corner','set-piece','free-kick').
    Coverage: 96.4%. Routes to m4_set_pieces module — overlap is intentional,
    the m4 model and m3 feature view the same data through different lenses."""
    feature_name = "setpiece_xg_share_diff"

    # Sofa's situation labels for set-piece-originated shots (rest are open-play)
    SETPIECE_SITUATIONS = ("corner", "set-piece", "free-kick")

    def _compute_side(
        self, game_id: int, is_home: int, prior_games: List[PriorMatch],
    ) -> Optional[float]:
        per_game_share: List[Optional[float]] = []
        placeholders = ",".join("?" * len(self.SETPIECE_SITUATIONS))
        with sqlite3.connect(self.db_path) as con:
            for pm in prior_games:
                # Aggregate set-piece xG and total xG in one query
                row = con.execute(
                    f"""
                    SELECT
                      COALESCE(SUM(CASE WHEN situation IN ({placeholders}) THEN xg ELSE 0 END), 0) as sp_xg,
                      COALESCE(SUM(xg), 0) as total_xg
                    FROM sofascore_shotmap
                    WHERE game_id = ? AND is_home = ? AND xg IS NOT NULL
                    """,
                    (*self.SETPIECE_SITUATIONS, pm.game_id, pm.is_home),
                ).fetchone()
                sp_xg, total_xg = (row[0], row[1]) if row else (0.0, 0.0)
                # If the game produced ≈0 xG total (very rare), skip rather than
                # divide-by-zero. The EWMA tolerates Nones.
                share = (sp_xg / total_xg) if total_xg > 0.1 else None
                per_game_share.append(share)
        return self._ewma(per_game_share)
