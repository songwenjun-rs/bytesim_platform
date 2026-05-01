"""Schema + seed sanity for §1 Resource Ontology (migration 008)."""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import asyncpg
import pgserver
import pytest

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "infra" / "postgres"


@pytest.fixture(scope="module")
def applied_dsn():
    tmp = tempfile.mkdtemp(prefix="bs-resource-")
    srv = pgserver.get_server(tmp, cleanup_mode="stop")
    uri = srv.get_uri()

    async def apply():
        c = await asyncpg.connect(uri)
        try:
            for f in sorted(SQL_DIR.glob("*.sql")):
                sql = f.read_text()
                sql = "\n".join(l for l in sql.splitlines() if "CREATE EXTENSION" not in l.upper())
                await c.execute(sql)
        finally:
            await c.close()
    asyncio.new_event_loop().run_until_complete(apply())
    yield uri
    srv.cleanup()


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_resource_tree_loaded(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            sites = await c.fetchval("SELECT count(*) FROM bs_resource WHERE kind='site'")
            assert sites >= 1
            gpus = await c.fetchval("SELECT count(*) FROM bs_resource WHERE kind='gpu'")
            assert gpus == 32  # 4 servers × 8 cards
            # Every GPU has a server parent + valid PDU failure_domain
            orphans = await c.fetchval("""
                SELECT count(*) FROM bs_resource
                WHERE kind='gpu' AND (parent_id IS NULL OR failure_domain IS NULL)
            """)
            assert orphans == 0
        finally:
            await c.close()
    _run(go())


def test_resource_lifecycle_default_active(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            non_active = await c.fetchval(
                "SELECT count(*) FROM bs_resource WHERE lifecycle != 'active'"
            )
            assert non_active == 0
        finally:
            await c.close()
    _run(go())


def test_link_fk_to_resource(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await c.execute(
                    "INSERT INTO bs_link (id, src_id, dst_id, fabric, bw_gbps) "
                    "VALUES ('bad', 'no-such', 'gpu-bj1-srv-bj1-r03-01-g0', 'nvlink', 100)"
                )
        finally:
            await c.close()
    _run(go())


def test_resource_kind_constraint(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            with pytest.raises(asyncpg.CheckViolationError):
                await c.execute(
                    "INSERT INTO bs_resource (id, kind) VALUES ('bad', 'unknown_kind')"
                )
        finally:
            await c.close()
    _run(go())


def test_hwspec_body_has_root_resource_ids(applied_dsn):
    """Migration 008 must augment hwspec_topo_b1's body with root_resource_ids
    pointer (back-compat: old fields preserved)."""
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            row = await c.fetchrow(
                "SELECT body FROM bs_spec_version WHERE spec_id='hwspec_topo_b1' "
                "ORDER BY created_at DESC LIMIT 1"
            )
            import json
            body = json.loads(row["body"]) if isinstance(row["body"], str) else row["body"]
            assert "root_resource_ids" in body
            assert body["root_resource_ids"] == ["site-bj1"]
            # Old fields preserved (back-compat)
            assert "cluster" in body or "datacenter" in body
        finally:
            await c.close()
    _run(go())


def test_failure_domain_groups_gpus(applied_dsn):
    """All GPUs under the same PDU should share failure_domain — needed for §3."""
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            rows = await c.fetch("""
                SELECT failure_domain, count(*) AS n
                FROM bs_resource WHERE kind='gpu' GROUP BY failure_domain
            """)
            # 2 PDUs × 16 GPUs each
            counts = {r["failure_domain"]: r["n"] for r in rows}
            assert all(n == 16 for n in counts.values())
        finally:
            await c.close()
    _run(go())
