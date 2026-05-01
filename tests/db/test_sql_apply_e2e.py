"""End-to-end: spin up a real Postgres via pgserver, apply 001..007 in order,
then assert the resulting state matches what the BFF + slice-15 multi-project
expects.

This catches problems that the AST-only test can't:
* missing FK targets
* type mismatches in INSERT VALUES
* duplicate primary keys
* JSONB shape errors at parse time
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import asyncpg
import pgserver
import pytest

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "infra" / "postgres"


@pytest.fixture(scope="module")
def pg_dsn():
    tmp = tempfile.mkdtemp(prefix="bytesim-pg-")
    srv = pgserver.get_server(tmp, cleanup_mode="stop")
    uri = srv.get_uri()
    yield uri
    srv.cleanup()


def _run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


@pytest.fixture(scope="module")
def applied_dsn(pg_dsn):
    """Apply 001..007 once for the whole module — tests are read-only."""
    async def apply():
        conn = await asyncpg.connect(pg_dsn)
        try:
            for sql_path in sorted(SQL_DIR.glob("*.sql")):
                sql = sql_path.read_text()
                # pgserver's bundled Postgres ships without pgcrypto; the
                # schema declares it for production but never actually calls
                # any pgcrypto function. Strip the CREATE EXTENSION line so
                # the rest of the schema applies.
                sql = "\n".join(
                    l for l in sql.splitlines()
                    if "CREATE EXTENSION" not in l.upper()
                )
                await conn.execute(sql)
        finally:
            await conn.close()
    _run(apply())
    return pg_dsn


def test_projects_loaded(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            rows = await c.fetch("SELECT id, name, env FROM bs_project ORDER BY id")
            ids = [r["id"] for r in rows]
            assert "p_default" in ids
            assert "p_lab" in ids
            envs = {r["id"]: r["env"] for r in rows}
            assert envs["p_default"] == "prod"
            assert envs["p_lab"] == "staging"
        finally:
            await c.close()
    _run(go())


def test_runs_isolated_by_project(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            n_default = await c.fetchval("SELECT count(*) FROM bs_run WHERE project_id='p_default'")
            n_lab = await c.fetchval("SELECT count(*) FROM bs_run WHERE project_id='p_lab'")
            assert n_default >= 4  # sim-7e90, sim-7f2a, +children
            assert n_lab == 2      # lab-001, lab-002
            # No row carries a phantom project id.
            ghosts = await c.fetchval(
                "SELECT count(*) FROM bs_run WHERE project_id NOT IN (SELECT id FROM bs_project)"
            )
            assert ghosts == 0
        finally:
            await c.close()
    _run(go())


def test_specs_isolated_by_project(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            n_lab = await c.fetchval("SELECT count(*) FROM bs_spec WHERE project_id='p_lab'")
            assert n_lab == 4  # hwspec_lab_a + model + strategy + workload
            # Each lab spec must have a version row pointing at its latest_hash.
            missing = await c.fetchval("""
                SELECT count(*) FROM bs_spec s
                LEFT JOIN bs_spec_version v ON v.hash = s.latest_hash AND v.spec_id = s.id
                WHERE s.project_id = 'p_lab' AND v.hash IS NULL
            """)
            assert missing == 0
        finally:
            await c.close()
    _run(go())


def test_run_uses_spec_does_not_cross_projects(applied_dsn):
    """A bs_run_uses_spec edge must reference a version belonging to a spec
    in the same project as the run. Cross-project would be a leak."""
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            row = await c.fetchval("""
                SELECT count(*)
                FROM bs_run_uses_spec rus
                JOIN bs_run r ON r.id = rus.run_id
                JOIN bs_spec_version v ON v.hash = rus.spec_hash
                JOIN bs_spec s ON s.id = v.spec_id
                WHERE r.project_id <> s.project_id
            """)
            assert row == 0, "found cross-project run_uses_spec edges"
        finally:
            await c.close()
    _run(go())


def test_fk_constraints_block_invalid_inserts(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await c.execute(
                    "INSERT INTO bs_run (id, project_id, kind, title, status, inputs_hash) "
                    "VALUES ('r-bad', 'p_nonexistent', 'train', 't', 'queued', 'h')"
                )
        finally:
            await c.close()
    _run(go())


def test_engine_registry_v2_table_empty_after_021(applied_dsn):
    """RFC-001 v2 (021): SQL-bootstrap rows from 011/019 are deleted; engines
    self-register on boot. The v1 columns (domain/granularity/capabilities)
    are dropped; the v2 columns (fidelity/coverage_envelope) are NOT NULL."""
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            count = await c.fetchval("SELECT count(*) FROM bs_engine")
            assert count == 0, f"bs_engine should be empty after 021; got {count}"

            cols = await c.fetch(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name='bs_engine' ORDER BY column_name"
            )
            names = {r["column_name"] for r in cols}
            # v1 columns gone
            assert "domain" not in names
            assert "granularity" not in names
            assert "capabilities" not in names
            # v2 columns present + NOT NULL
            assert "fidelity" in names
            assert "coverage_envelope" in names
            nullable = {r["column_name"]: r["is_nullable"] for r in cols}
            assert nullable["fidelity"] == "NO"
            assert nullable["coverage_envelope"] == "NO"
        finally:
            await c.close()
    _run(go())
