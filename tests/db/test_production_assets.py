"""Schema sanity for §6 migration 009."""
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
    tmp = tempfile.mkdtemp(prefix="bs-prod-assets-")
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


def test_snapshot_status_constraint(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            with pytest.raises(asyncpg.CheckViolationError):
                await c.execute(
                    "INSERT INTO bs_production_snapshot "
                    "(id, project_id, name, source_kind, source_adapter, storage_uri, sha256, "
                    " covers_period, imported_by, status) "
                    "VALUES ('s1','p_default','x','dcgm','dcgm-csv@v1','file:///x','h',"
                    "tstzrange(now(), null), 'tester', 'banana')"
                )
        finally:
            await c.close()
    _run(go())


def test_snapshot_pending_review_default(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            await c.execute(
                "INSERT INTO bs_production_snapshot "
                "(id, project_id, name, source_kind, source_adapter, storage_uri, sha256, "
                " covers_period, imported_by) "
                "VALUES ('s2','p_default','x','dcgm','dcgm-csv@v1','file:///x','h',"
                "tstzrange(now(), null), 'tester')"
            )
            row = await c.fetchrow("SELECT status FROM bs_production_snapshot WHERE id='s2'")
            assert row["status"] == "pending_review"
        finally:
            await c.close()
    _run(go())


def test_snapshot_consumed_by_fk(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await c.execute(
                    "INSERT INTO bs_snapshot_consumed_by (snapshot_id, consumer_kind, consumer_id) "
                    "VALUES ('no-such-snap','calibration_job','cal-1')"
                )
        finally:
            await c.close()
    _run(go())


def test_snapshot_consumed_by_consumer_kind_constraint(applied_dsn):
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            await c.execute(
                "INSERT INTO bs_production_snapshot "
                "(id, project_id, name, source_kind, source_adapter, storage_uri, sha256, "
                " covers_period, imported_by) "
                "VALUES ('s3','p_default','x','dcgm','dcgm-csv@v1','file:///x','h',"
                "tstzrange(now(), null), 'tester')"
            )
            with pytest.raises(asyncpg.CheckViolationError):
                await c.execute(
                    "INSERT INTO bs_snapshot_consumed_by VALUES "
                    "('s3','garbage_kind','x', now())"
                )
        finally:
            await c.close()
    _run(go())


# Removed: test_calibration_job_has_snapshot_columns. The bs_calibration_job
# table came from migration 004 (calibration-svc), which was deactivated in
# the Tier B teardown. The ALTER TABLE that populated those columns was
# removed from migration 009 as well.
