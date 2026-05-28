"""
Tests for v4.m3_xg.feature_builder_premium.

Locks down the orchestration contract:
  • Singleton calculator-set assembles in PREMIUM_FEATURE_ORDER
  • Single-match builder returns exactly 9 keys
  • Corpus builder returns a DataFrame with the right columns
  • impute_zero_on_missing flag works as documented
  • The _skip column correctly flags all-None rows

Does NOT test individual feature math — that's the per-calculator unit
test's job (TacticalWidthDiff has its own smoke-test; the other 8 are
stubbed and will get tests when implemented in Sprint 2).
"""
import pytest

from v4.modules.m3_xg.feature_builder_premium import (
    PREMIUM_FEATURE_ORDER,
    build_premium_features_for_corpus,
    build_premium_features_for_match,
    expected_columns,
    get_calculators,
)


class TestCalculatorWiring:
    def test_all_9_calculators_in_order(self):
        calcs = get_calculators()
        assert list(calcs.keys()) == PREMIUM_FEATURE_ORDER
        assert len(calcs) == 9

    def test_singleton_pattern(self):
        # Two calls return the SAME dict (instance reuse)
        c1 = get_calculators()
        c2 = get_calculators()
        assert c1 is c2


@pytest.mark.requires_data
class TestSingleMatchBuilder:
    def test_returns_9_keys_in_order(self):
        out = build_premium_features_for_match(game_id=999999999)  # non-existent gid
        assert list(out.keys()) == PREMIUM_FEATURE_ORDER

    def test_impute_zero_default(self):
        # Non-existent gid → all features None → imputed to 0.0
        out = build_premium_features_for_match(game_id=999999999)
        assert all(v == 0.0 for v in out.values())

    def test_no_impute_returns_none(self):
        out = build_premium_features_for_match(
            game_id=999999999, impute_zero_on_missing=False,
        )
        # All None for non-existent gid
        assert all(v is None for v in out.values())


@pytest.mark.requires_data
class TestCorpusBuilder:
    def test_returns_dataframe_with_correct_columns(self):
        df = build_premium_features_for_corpus(game_ids=[999999999, 999999998])
        assert list(df.columns) == ["game_id"] + PREMIUM_FEATURE_ORDER + ["_skip"]
        assert len(df) == 2

    def test_skip_column_flags_empty_matches(self):
        # Non-existent gids → all features missing → _skip=True
        df = build_premium_features_for_corpus(game_ids=[999999999])
        assert df["_skip"].iloc[0] == True

    def test_imputed_values_dont_falsely_mark_skip(self):
        # With impute_zero=True, raw values still come back None for missing
        # data → _skip is computed from RAW values, not the imputed 0.0s.
        # Same gid, both modes → same _skip.
        df_imputed = build_premium_features_for_corpus(
            game_ids=[999999999], impute_zero_on_missing=True,
        )
        df_raw = build_premium_features_for_corpus(
            game_ids=[999999999], impute_zero_on_missing=False,
        )
        assert df_imputed["_skip"].iloc[0] == df_raw["_skip"].iloc[0] == True


class TestSchemaSanity:
    def test_expected_columns_consistent(self):
        cols = expected_columns()
        assert cols[0] == "game_id"
        assert cols[1:] == list(PREMIUM_FEATURE_ORDER)
        cols_with_skip = expected_columns(include_skip=True)
        assert cols_with_skip[-1] == "_skip"


# ── Integration smoke test (touches the real local SQLite) ──────────────
# Marked separately so it can be skipped on CI runners that don't have the
# 770 MB local_extras.db.

@pytest.mark.integration
@pytest.mark.requires_data
class TestRealDataSmoke:
    """Verify the orchestrator runs end-to-end on a real Tier-A 24/25 match.

    Sprint-2 update: all 9 calculators are now implemented. We expect ≥7 of
    them to produce non-None values on a known-good match (allowing 1-2
    misses for matches with sparse player-stat or shotmap coverage edge cases).
    """

    def test_all_features_compute_on_epl_match(self):
        # Pick a Tier-A epl match deep into 24/25 (so it has prior-history)
        import sqlite3
        from pathlib import Path
        db = Path(__file__).resolve().parents[3] / "tools" / "sofascore" / "data" / "local_extras.db"
        if not db.exists():
            pytest.skip(f"local_extras.db not at {db}")
        con = sqlite3.connect(db)
        row = con.execute("""
            SELECT m.game_id FROM sofascore_match m
            WHERE m.league = 'epl' AND m.season = '24/25' AND m.status = 'Ended'
            ORDER BY m.start_timestamp LIMIT 1 OFFSET 100
        """).fetchone()
        con.close()
        if row is None:
            pytest.skip("No epl 24/25 ended match found")

        out = build_premium_features_for_match(
            game_id=row[0], impute_zero_on_missing=False,
        )
        non_none = [name for name, v in out.items() if v is not None]
        assert len(non_none) >= 7, (
            f"Expected ≥7/9 features to compute on EPL 24/25 match, got {len(non_none)}: "
            f"non-None = {non_none}"
        )

    def test_tactical_width_returns_sensible_value(self):
        """Sanity: tactical width is a std-of-x; ~10-25 expected on Sofa's
        0-100 coordinate system."""
        import sqlite3
        from pathlib import Path
        db = Path(__file__).resolve().parents[3] / "tools" / "sofascore" / "data" / "local_extras.db"
        if not db.exists():
            pytest.skip(f"local_extras.db not at {db}")
        con = sqlite3.connect(db)
        row = con.execute("""
            SELECT m.game_id FROM sofascore_match m
            WHERE m.league = 'epl' AND m.season = '24/25' AND m.status = 'Ended'
            ORDER BY m.start_timestamp LIMIT 1 OFFSET 100
        """).fetchone()
        con.close()
        if row is None:
            pytest.skip()
        out = build_premium_features_for_match(row[0], impute_zero_on_missing=False)
        w = out["tactical_width_diff"]
        assert w is not None
        # Differential should be |diff| < 15 typically (two teams playing
        # the same game don't have radically different width)
        assert abs(w) < 15.0, f"tactical_width_diff = {w} looks unrealistic"
