"""Real-Postgres tests for the per-service store layers (tco /
engine-registry / ingest). Uses pgserver to spin up a temp PG, applies
the migrations, then exercises each Store class against it.

These tests intentionally cover the SQL surface — they are slower than the
mocked ones but catch query-shape regressions."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import asyncpg
import pgserver
import pytest

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "infra" / "postgres"


@pytest.fixture(scope="module")
def pg_dsn():
    tmp = tempfile.mkdtemp(prefix="bs-stores-")
    srv = pgserver.get_server(tmp, cleanup_mode="stop")
    uri = srv.get_uri()
    yield uri
    srv.cleanup()


@pytest.fixture(scope="module")
def applied_dsn(pg_dsn):
    async def apply():
        c = await asyncpg.connect(pg_dsn)
        try:
            for f in sorted(SQL_DIR.glob("*.sql")):
                sql = f.read_text()
                sql = "\n".join(l for l in sql.splitlines() if "CREATE EXTENSION" not in l.upper())
                await c.execute(sql)
        finally:
            await c.close()
    asyncio.new_event_loop().run_until_complete(apply())
    return pg_dsn


def _import(svc: str, mod: str):
    """Mount a service on sys.path, import app.<mod>, return it. Caller is
    responsible for restoring sys.path / sys.modules."""
    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items() if k == "app" or k.startswith("app.")}
    for k in list(saved_mods):
        del sys.modules[k]
    sys.path.insert(0, str(ROOT / "services" / svc))
    try:
        return __import__(f"app.{mod}", fromlist=["*"])
    finally:
        sys.path[:] = saved_path
        for k in list(sys.modules):
            if k == "app" or k.startswith("app."):
                del sys.modules[k]
        sys.modules.update(saved_mods)


@pytest.fixture
def tco_store_factory(applied_dsn):
    mod = _import("tco-engine-svc", "store")

    async def make():
        s = mod.Store()
        s.dsn = applied_dsn
        await s.open()
        return s

    return make


# ── §5 TCO store ─────────────────────────────────────────────────────

def test_tco_rules_seeded_and_lookup(tco_store_factory):
    async def go():
        s = await tco_store_factory()
        try:
            rules = await s.list_rules("gpu")
            assert any(r["vendor_sku"] == "Nvidia/B200-180GB" for r in rules)
            r = await s.find_rule("gpu", "Nvidia/B200-180GB")
            assert r and r["id"] == "gpu/B200/v2026q1"
            r = await s.find_rule("gpu", "Bogus/X")
            assert r is not None
            assert await s.find_rule("nonexistent", None) is None
            assert (await s.get_rule("gpu/B200/v2026q1"))["id"] == "gpu/B200/v2026q1"
            assert await s.get_rule("missing") is None
        finally:
            await s.close()
    asyncio.new_event_loop().run_until_complete(go())


def test_tco_breakdown_upsert_idempotent(tco_store_factory, applied_dsn):
    """Upserting the same run_id twice replaces the row (re-running TCO must
    not create duplicate breakdowns)."""
    async def go():
        c = await asyncpg.connect(applied_dsn)
        try:
            await c.execute(
                "INSERT INTO bs_run (id, project_id, kind, title, status, inputs_hash) "
                "VALUES ('sim-tco-test', 'p_default', 'train', 't', 'done', 'h') "
                "ON CONFLICT (id) DO NOTHING"
            )
        finally:
            await c.close()

        s = await tco_store_factory()
        try:
            body_v1 = {
                "hw_capex_amortized_usd": 100, "power_opex_usd": 50,
                "cooling_opex_usd": 9, "network_opex_usd": 1,
                "storage_opex_usd": 2, "failure_penalty_usd": 0,
                "total_usd": 162, "per_m_token_usd": 0.001,
                "per_gpu_hour_usd": 5, "per_inference_request_usd": None,
                "rule_versions": {"gpu/B200": "gpu/B200/v2026q1"},
                "sensitivities": {},
            }
            await s.upsert_breakdown("sim-tco-test", body_v1)
            got = await s.get_breakdown("sim-tco-test")
            assert got["total_usd"] == 162

            body_v2 = {**body_v1, "total_usd": 999, "power_opex_usd": 999}
            await s.upsert_breakdown("sim-tco-test", body_v2)
            got2 = await s.get_breakdown("sim-tco-test")
            assert got2["total_usd"] == 999

            assert await s.get_breakdown("missing") is None
        finally:
            await s.close()
    asyncio.new_event_loop().run_until_complete(go())


# ── §2 Engine Registry store ─────────────────────────────────────────

@pytest.fixture
def engine_registry_store_factory(applied_dsn):
    mod = _import("engine-registry-svc", "store")

    async def make():
        s = mod.Store()
        s.dsn = applied_dsn
        await s.open()
        return s

    return make


def _registry_payload(name: str) -> dict:
    """Test payload matching upsert_engine's kwargs surface (no `status` —
    upsert_engine always writes status='active' itself)."""
    return dict(
        name=name, version="v0", fidelity="analytical", sla_p99_ms=100,
        endpoint="http://x", predict_path="/v1/predict",
        coverage_envelope={}, kpi_outputs=[], calibration={},
        notes=None,
    )


async def _delete_engine(applied_dsn: str, name: str) -> None:
    """Cleanup helper — Store has no delete(); reach into raw SQL."""
    c = await asyncpg.connect(applied_dsn)
    try:
        await c.execute("DELETE FROM bs_engine WHERE name = $1", name)
    finally:
        await c.close()


def test_engine_registry_starts_empty_after_v2_cutover(engine_registry_store_factory):
    """Migration 021 explicitly DELETEs the seeded surrogate-analytical +
    astra-sim rows on cutover — engines self-register at runtime via the
    SDK's register-on-boot path. The test verifies that contract: a fresh
    DB after migrations applied has zero engines."""
    async def go():
        s = await engine_registry_store_factory()
        try:
            rows = await s.list_engines(status=None)
            assert rows == [], f"expected empty registry, got {rows}"
        finally:
            await s.close()
    asyncio.new_event_loop().run_until_complete(go())


def test_engine_registry_upsert_idempotent(engine_registry_store_factory, applied_dsn):
    async def go():
        s = await engine_registry_store_factory()
        try:
            payload = _registry_payload("test-eng")
            await s.upsert_engine(**payload)
            await s.upsert_engine(**payload)
            rows = await s.list_engines(status=None)
            assert sum(1 for r in rows if r["name"] == "test-eng") == 1
        finally:
            await s.close()
            await _delete_engine(applied_dsn, "test-eng")
    asyncio.new_event_loop().run_until_complete(go())


def test_engine_registry_heartbeat(engine_registry_store_factory, applied_dsn):
    async def go():
        s = await engine_registry_store_factory()
        try:
            await s.upsert_engine(**_registry_payload("hb-eng"))
            ok = await s.heartbeat("hb-eng")
            assert ok is True
            ok2 = await s.heartbeat("not-registered")
            assert ok2 is False
        finally:
            await s.close()
            await _delete_engine(applied_dsn, "hb-eng")
    asyncio.new_event_loop().run_until_complete(go())


def test_engine_registry_set_calibration(engine_registry_store_factory, applied_dsn):
    """RFC-004 — calibration data writeback path."""
    async def go():
        s = await engine_registry_store_factory()
        try:
            await s.upsert_engine(**_registry_payload("cal-test"))
            ok = await s.set_calibration("cal-test", {
                "mape_pct": {"mfu": 3.2},
                "profile_runs": ["snap-Q1-A"],
            })
            assert ok is True
            row = next(r for r in await s.list_engines(status=None) if r["name"] == "cal-test")
            assert row["calibration"]["mape_pct"]["mfu"] == 3.2
            assert "snap-Q1-A" in row["calibration"]["profile_runs"]
            ok2 = await s.set_calibration("not-registered", {"mape_pct": {}})
            assert ok2 is False
        finally:
            await s.close()
            await _delete_engine(applied_dsn, "cal-test")
    asyncio.new_event_loop().run_until_complete(go())


# ── §6 Ingest store ──────────────────────────────────────────────────

@pytest.fixture
def ingest_store_factory(applied_dsn):
    mod = _import("ingest-svc", "store")

    async def make():
        s = mod.Store()
        s.dsn = applied_dsn
        await s.open()
        return s

    return make


def test_ingest_snapshot_lifecycle(ingest_store_factory):
    from datetime import datetime, timezone, timedelta

    async def go():
        s = await ingest_store_factory()
        try:
            now = datetime.now(timezone.utc)
            snap = await s.insert_snapshot(
                snapshot_id="snap-test-1", project_id="p_default", name="t",
                source_kind="dcgm", source_adapter="dcgm-csv@v1",
                storage_uri="file:///tmp/x", sha256="ab"*32,
                row_count=100, bytes_=1234,
                period_start=now, period_end=now + timedelta(hours=1),
                hardware_scope={"gpu_models": ["B200"]},
                workload_scope={"model_families": ["MoE"]},
                redaction={"removed_fields": ["user_id"]},
                imported_by="tester",
                retention_until=now + timedelta(days=90),
                notes=None,
            )
            assert snap["status"] == "pending_review"
            assert snap["row_count"] == 100

            rows = await s.list_snapshots(project_id="p_default")
            assert any(r["id"] == "snap-test-1" for r in rows)

            ok = await s.approve("snap-test-1", "lihaoran")
            assert ok is True
            ok2 = await s.approve("snap-test-1", "lihaoran")
            assert ok2 is False

            after = await s.get_snapshot("snap-test-1")
            assert after["status"] == "approved"
            assert after["approved_by"] == "lihaoran"

            await s.record_consumer("snap-test-1", "calibration_job", "cal-x")
            await s.record_consumer("snap-test-1", "calibration_job", "cal-x")  # idempotent
            consumers = await s.list_consumers("snap-test-1")
            assert len(consumers) == 1
        finally:
            await s.close()
    asyncio.new_event_loop().run_until_complete(go())


def test_ingest_snapshot_reject(ingest_store_factory):
    from datetime import datetime, timezone

    async def go():
        s = await ingest_store_factory()
        try:
            now = datetime.now(timezone.utc)
            await s.insert_snapshot(
                snapshot_id="snap-test-2", project_id="p_default", name="t",
                source_kind="dcgm", source_adapter="dcgm-csv@v1",
                storage_uri="file:///tmp/x", sha256="cd"*32,
                row_count=10, bytes_=10,
                period_start=now, period_end=now,
                hardware_scope={}, workload_scope={}, redaction={},
                imported_by="tester", retention_until=None, notes=None,
            )
            ok = await s.reject("snap-test-2", "lihaoran", "missing redaction")
            assert ok is True
            after = await s.get_snapshot("snap-test-2")
            assert after["status"] == "rejected"
            assert "missing redaction" in (after["notes"] or "")
        finally:
            await s.close()
    asyncio.new_event_loop().run_until_complete(go())
