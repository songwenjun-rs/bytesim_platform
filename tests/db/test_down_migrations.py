"""P0-A.0.1.7 — down migration framework.

Verifies that every up-migration shipping a down/ counterpart can roll back
cleanly. Runs against pgserver: apply up → exercise function → run down →
confirm function/trigger is gone."""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import asyncpg
import pgserver
import pytest

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "infra" / "postgres"
DOWN_DIR = SQL_DIR / "down"


@pytest.fixture(scope="module")
def fresh_pg():
    tmp = tempfile.mkdtemp(prefix="bytesim-down-pg-")
    srv = pgserver.get_server(tmp, cleanup_mode="stop")
    yield srv.get_uri()
    srv.cleanup()


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _strip_extension(sql: str) -> str:
    return "\n".join(l for l in sql.splitlines() if "CREATE EXTENSION" not in l.upper())


def _apply_files(dsn: str, files: list[Path]) -> None:
    async def go():
        c = await asyncpg.connect(dsn)
        try:
            for f in files:
                await c.execute(_strip_extension(f.read_text()))
        finally:
            await c.close()
    _run(go())


def _query(dsn: str, sql: str, *args):
    async def go():
        c = await asyncpg.connect(dsn)
        try:
            return await c.fetchval(sql, *args)
        finally:
            await c.close()
    return _run(go())


# ── 017: jsonb_deep_merge function ────────────────────────────────────

def test_017_down_drops_function(fresh_pg):
    # Apply up (just the function — no schema needed for this one).
    _apply_files(fresh_pg, [SQL_DIR / "017_jsonb_deep_merge.sql"])
    # Confirm function exists.
    n = _query(fresh_pg, "SELECT count(*) FROM pg_proc WHERE proname = 'jsonb_deep_merge'")
    assert n == 1
    # Apply down.
    _apply_files(fresh_pg, [DOWN_DIR / "017_jsonb_deep_merge.sql"])
    # Function gone.
    n = _query(fresh_pg, "SELECT count(*) FROM pg_proc WHERE proname = 'jsonb_deep_merge'")
    assert n == 0


# ── 020: engine registry v2 additive columns ─────────────────────────
# RFC-001 §2.2 (M1). The forward script ADDs `fidelity / coverage_envelope /
# kpi_outputs / calibration` + an index, leaving every v1 column intact. The
# down script drops the v2 columns + index. We assert: (a) the index appears
# after up; (b) v1 INSERT (mirroring 011 bootstrap) keeps working between up
# and down; (c) down truly removes the v2 columns and index.

def test_020_engine_registry_v2_round_trip(fresh_pg):
    # `fresh_pg` is module-scoped — earlier tests have already applied 001 +
    # other migrations. Wipe to a clean schema so this test is self-contained.
    async def _reset():
        c = await asyncpg.connect(fresh_pg)
        try:
            await c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        finally:
            await c.close()
    _run(_reset())

    files = [SQL_DIR / n for n in (
        "001_init.sql", "011_engine_registry.sql", "020_engine_registry_v2.sql",
    )]
    _apply_files(fresh_pg, files)

    # v2 columns present.
    cols = _query(
        fresh_pg,
        """SELECT array_agg(column_name::text ORDER BY column_name)
             FROM information_schema.columns
            WHERE table_name='bs_engine'
              AND column_name = ANY($1::text[])""",
        ["fidelity", "coverage_envelope", "kpi_outputs", "calibration"],
    )
    assert set(cols or []) == {
        "fidelity", "coverage_envelope", "kpi_outputs", "calibration"
    }, f"missing v2 columns: got {cols}"

    # v2 index present.
    idx = _query(
        fresh_pg,
        "SELECT count(*) FROM pg_indexes WHERE indexname='bs_engine_status_fidelity'",
    )
    assert idx == 1

    # v1 INSERT still works — this proves the migration didn't break the
    # existing 011 bootstrap path. (We hand-craft the INSERT here rather than
    # re-running 011 because 011's bootstrap row was already inserted at apply
    # time and an idempotent re-run isn't part of the test surface.)
    async def v1_insert():
        c = await asyncpg.connect(fresh_pg)
        try:
            await c.execute(
                """INSERT INTO bs_engine
                   (name, version, domain, granularity, sla_p99_ms,
                    endpoint, predict_path, capabilities)
                   VALUES ('test-engine', 'v0', 'compute', 'analytical', 100,
                           'http://x', '/v1/predict', '{}'::jsonb)
                   ON CONFLICT DO NOTHING"""
            )
            n = await c.fetchval(
                "SELECT count(*) FROM bs_engine WHERE name='test-engine'"
            )
            assert n == 1
        finally:
            await c.close()
    _run(v1_insert())

    # Apply down.
    _apply_files(fresh_pg, [DOWN_DIR / "020_engine_registry_v2.sql"])

    # v2 columns gone.
    cols = _query(
        fresh_pg,
        """SELECT array_agg(column_name::text)
             FROM information_schema.columns
            WHERE table_name='bs_engine'
              AND column_name = ANY($1::text[])""",
        ["fidelity", "coverage_envelope", "kpi_outputs", "calibration"],
    )
    assert not cols, f"v2 columns still present after down: {cols}"

    # v2 index gone.
    idx = _query(
        fresh_pg,
        "SELECT count(*) FROM pg_indexes WHERE indexname='bs_engine_status_fidelity'",
    )
    assert idx == 0

    # v1 row + v1 columns survived (no data loss for the v1 path).
    async def v1_intact():
        c = await asyncpg.connect(fresh_pg)
        try:
            row = await c.fetchrow(
                "SELECT name, domain, granularity, capabilities "
                "FROM bs_engine WHERE name='test-engine'"
            )
            assert row is not None
            assert row["domain"] == "compute"
            assert row["granularity"] == "analytical"
        finally:
            await c.close()
    _run(v1_intact())

    # Up again to prove idempotence — IF NOT EXISTS / DEFAULT shouldn't choke
    # on a partially-rolled-back schema.
    _apply_files(fresh_pg, [SQL_DIR / "020_engine_registry_v2.sql"])
    cols = _query(
        fresh_pg,
        """SELECT count(*) FROM information_schema.columns
            WHERE table_name='bs_engine' AND column_name='fidelity'""",
    )
    assert cols == 1


# ── Convention check: no orphan down scripts ──────────────────────────

def test_every_down_script_has_matching_up():
    """Catches stray files in down/ that don't correspond to a real up
    migration — typically a typo'd filename."""
    up_names = {p.name for p in SQL_DIR.glob("*.sql")}
    for down_path in DOWN_DIR.glob("*.sql"):
        assert down_path.name in up_names, (
            f"{down_path.name} has no matching infra/postgres/{down_path.name}"
        )
