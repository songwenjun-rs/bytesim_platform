"""P0 follow-up to run-svc PatchRun: jsonb_deep_merge must preserve nested
sub-objects when a later patch arrives. Regresses the bug where a progress
patch was clobbering _engine_provenance written at attribution time."""
from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import asyncpg
import pgserver
import pytest

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "infra" / "postgres"


@pytest.fixture(scope="module")
def merge_dsn():
    """Apply only 017 (the function definition) — we don't need the rest of
    the schema for these tests, but also tolerate co-applying the full set."""
    tmp = tempfile.mkdtemp(prefix="bytesim-merge-pg-")
    srv = pgserver.get_server(tmp, cleanup_mode="stop")
    uri = srv.get_uri()

    async def apply():
        conn = await asyncpg.connect(uri)
        try:
            sql = (SQL_DIR / "017_jsonb_deep_merge.sql").read_text()
            await conn.execute(sql)
        finally:
            await conn.close()

    asyncio.new_event_loop().run_until_complete(apply())
    yield uri
    srv.cleanup()


def _merge(dsn: str, a: dict, b: dict) -> dict:
    async def go():
        c = await asyncpg.connect(dsn)
        try:
            row = await c.fetchval(
                "SELECT jsonb_deep_merge($1::jsonb, $2::jsonb)",
                json.dumps(a), json.dumps(b),
            )
            return json.loads(row) if isinstance(row, str) else row
        finally:
            await c.close()
    return asyncio.new_event_loop().run_until_complete(go())


def test_disjoint_keys_combine(merge_dsn):
    out = _merge(merge_dsn, {"a": 1}, {"b": 2})
    assert out == {"a": 1, "b": 2}


def test_scalar_collision_right_wins(merge_dsn):
    out = _merge(merge_dsn, {"a": 1}, {"a": 2})
    assert out == {"a": 2}


def test_nested_object_recurses_instead_of_overwriting(merge_dsn):
    """Regression — the actual bug: writing _engine_provenance at attribution
    time and then receiving a progress patch carrying just {mfu_pct: ...}
    must NOT erase the provenance block. Bare `||` would overwrite it."""
    a = {
        "mfu_pct": 48.0,
        "_engine_provenance": {"name": "surrogate-analytical", "version": "v0.1"},
    }
    b = {"mfu_pct": 49.5}
    out = _merge(merge_dsn, a, b)
    assert out["mfu_pct"] == 49.5
    assert out["_engine_provenance"] == {
        "name": "surrogate-analytical", "version": "v0.1",
    }


def test_nested_collision_recurses_deeply(merge_dsn):
    a = {"meta": {"trial_index": 0, "params": {"TP": 4, "PP": 8}}}
    b = {"meta": {"trial_index": 7}}
    out = _merge(merge_dsn, a, b)
    # right's trial_index wins, but params survive (the deep recursion bug).
    assert out["meta"]["trial_index"] == 7
    assert out["meta"]["params"] == {"TP": 4, "PP": 8}


def test_list_value_replaced_not_concatenated(merge_dsn):
    """We don't merge arrays; right wins (matches plain || semantics)."""
    a = {"artifacts": [{"file": "old.json"}]}
    b = {"artifacts": [{"file": "new.json"}]}
    out = _merge(merge_dsn, a, b)
    assert out == {"artifacts": [{"file": "new.json"}]}


def test_nulls_pass_through(merge_dsn):
    assert _merge(merge_dsn, {"a": 1}, {}) == {"a": 1}
    assert _merge(merge_dsn, {}, {"b": 2}) == {"b": 2}


def test_non_object_rhs_replaces_object(merge_dsn):
    """If b is not an object, b wins outright (mirrors `||` for that case)."""
    out = _merge(merge_dsn, {"a": 1}, {})
    assert out == {"a": 1}
