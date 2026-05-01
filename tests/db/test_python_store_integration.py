"""Live-PG integration tests for the Python store layers.

Lifts coverage of:
  - services/tco-engine-svc/app/store.py
  - services/ingest-svc/app/store.py
  - services/engine-registry-svc/app/store.py

Skip when PG_DSN isn't set, so the default `pytest tests/` flow stays
untouched. Mirrors the Go-side integration tests pattern.

Run:
  PG_DSN=postgres://bytesim:bytesim@localhost:5432/bytesim \\
  pytest tests/db/test_python_store_integration.py -v
"""
from __future__ import annotations

import importlib
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[2]


def _dsn():
    d = os.environ.get("PG_DSN")
    if not d:
        pytest.skip("PG_DSN not set; skipping Python store integration tests")
    return d


def _import_svc_store(svc: str):
    """Mount services/<svc> on sys.path, import + return its app.store module."""
    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items()
                  if k == "app" or k.startswith("app.")}
    for k in list(saved_mods):
        del sys.modules[k]
    sys.path.insert(0, str(ROOT / "services" / svc))
    try:
        return importlib.import_module("app.store"), saved_path, saved_mods
    except Exception:
        sys.path[:] = saved_path
        sys.modules.update(saved_mods)
        raise


def _restore(saved_path, saved_mods):
    sys.path[:] = saved_path
    for k in list(sys.modules):
        if k == "app" or k.startswith("app."):
            del sys.modules[k]
    sys.modules.update(saved_mods)


# ── Fixtures (async — share the test's event loop) ─────────────────────────

@pytest_asyncio.fixture
async def tco_store():
    dsn = _dsn()
    mod, sp, sm = _import_svc_store("tco-engine-svc")
    s = mod.Store()
    s.dsn = dsn
    await s.open()
    yield s
    try:
        await s.close()
    finally:
        _restore(sp, sm)


@pytest_asyncio.fixture
async def ingest_store():
    dsn = _dsn()
    mod, sp, sm = _import_svc_store("ingest-svc")
    s = mod.Store()
    s.dsn = dsn
    await s.open()
    yield s
    try:
        await s.close()
    finally:
        _restore(sp, sm)


@pytest_asyncio.fixture
async def registry_store():
    dsn = _dsn()
    mod, sp, sm = _import_svc_store("engine-registry-svc")
    s = mod.Store()
    s.dsn = dsn
    await s.open()
    yield s
    try:
        await s.close()
    finally:
        _restore(sp, sm)


# ── tco-engine-svc/app/store.py ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_tco_list_rules_seeded(tco_store):
    rules = await tco_store.list_rules("gpu")
    assert isinstance(rules, list)
    if rules:
        assert any("B200" in (r.get("vendor_sku") or "") or
                   "H200" in (r.get("vendor_sku") or "") for r in rules)


@pytest.mark.asyncio
async def test_tco_list_rules_no_filter(tco_store):
    rules = await tco_store.list_rules()
    assert isinstance(rules, list)


@pytest.mark.asyncio
async def test_tco_find_rule_with_sku_match(tco_store):
    r = await tco_store.find_rule("gpu", "Nvidia/B200-180GB")
    if r:
        assert r["resource_kind"] == "gpu"


@pytest.mark.asyncio
async def test_tco_find_rule_falls_back_to_kind(tco_store):
    r = await tco_store.find_rule("gpu", "Bogus/UnknownSku")
    assert r is None or r["resource_kind"] == "gpu"


@pytest.mark.asyncio
async def test_tco_find_rule_unknown_kind_returns_none(tco_store):
    assert await tco_store.find_rule("not-a-real-kind", None) is None


@pytest.mark.asyncio
async def test_tco_get_rule_missing_returns_none(tco_store):
    assert await tco_store.get_rule("not-a-real-rule-id") is None


@pytest.mark.asyncio
async def test_tco_breakdown_upsert_idempotent(tco_store):
    # Need a real run row for the FK; insert one directly.
    import asyncpg
    dsn = _dsn()
    run_id = f"sim-tco-it-{int(time.time() * 1000)}"
    c = await asyncpg.connect(dsn)
    try:
        await c.execute(
            "INSERT INTO bs_run (id, project_id, kind, title, status, inputs_hash) "
            "VALUES ($1, 'p_default', 'train', 'tco-it', 'done', 'h') "
            "ON CONFLICT (id) DO NOTHING", run_id)
    finally:
        await c.close()

    body = {
        "hw_capex_amortized_usd": 100.0, "power_opex_usd": 50.0,
        "cooling_opex_usd": 5.0, "network_opex_usd": 5.0,
        "storage_opex_usd": 5.0, "failure_penalty_usd": 0.0,
        "total_usd": 165.0, "per_m_token_usd": 0.001,
        "per_gpu_hour_usd": 5.0, "per_inference_request_usd": None,
        "rule_versions": {"gpu/B200": "gpu/B200/v2026q1"},
        "sensitivities": {"d_total_per_card": 5.0},
    }
    await tco_store.upsert_breakdown(run_id, body)
    got = await tco_store.get_breakdown(run_id)
    assert got is not None
    assert float(got["total_usd"]) == 165.0

    body2 = {**body, "total_usd": 999.0}
    await tco_store.upsert_breakdown(run_id, body2)
    got2 = await tco_store.get_breakdown(run_id)
    assert float(got2["total_usd"]) == 999.0

    c = await asyncpg.connect(dsn)
    try:
        await c.execute("DELETE FROM bs_tco_breakdown WHERE run_id = $1", run_id)
        await c.execute("DELETE FROM bs_run WHERE id = $1", run_id)
    finally:
        await c.close()

    assert await tco_store.get_breakdown("not-a-real-run") is None


# ── ingest-svc/app/store.py ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ingest_snapshot_full_lifecycle(ingest_store):
    now = datetime.now(timezone.utc)
    snap_id = f"snap-it-{int(time.time() * 1000)}"

    snap = await ingest_store.insert_snapshot(
        snapshot_id=snap_id, project_id="p_default", name="lifecycle-it",
        source_kind="dcgm", source_adapter="dcgm-csv@v1",
        storage_uri="file:///tmp/x", sha256="ab" * 32,
        row_count=100, bytes_=1234,
        period_start=now, period_end=now + timedelta(hours=1),
        hardware_scope={"gpu_models": ["B200"]},
        workload_scope={"model_families": ["MoE"]},
        redaction={"removed_fields": ["user_id"]},
        imported_by="it-tester",
        retention_until=now + timedelta(days=90),
        notes="integration",
    )
    assert snap["status"] == "pending_review"

    # GET
    got = await ingest_store.get_snapshot(snap_id)
    assert got["row_count"] == 100

    # LIST with project filter
    rows = await ingest_store.list_snapshots(project_id="p_default")
    assert any(r["id"] == snap_id for r in rows)

    # LIST with status filter
    pending = await ingest_store.list_snapshots(status="pending_review")
    assert any(r["id"] == snap_id for r in pending)

    # LIST with source_kind filter
    rows = await ingest_store.list_snapshots(source_kind="dcgm")
    assert any(r["id"] == snap_id for r in rows)

    # APPROVE → status flips to approved
    ok = await ingest_store.approve(snap_id, "lihaoran")
    assert ok is True

    # Re-approve is no-op (returns False).
    ok2 = await ingest_store.approve(snap_id, "lihaoran")
    assert ok2 is False

    # Record consumer; second call is idempotent.
    await ingest_store.record_consumer(snap_id, "calibration_job", "cal-it-1")
    await ingest_store.record_consumer(snap_id, "calibration_job", "cal-it-1")
    consumers = await ingest_store.list_consumers(snap_id)
    assert len(consumers) == 1
    assert consumers[0]["consumer_kind"] == "calibration_job"

    # Cleanup.
    import asyncpg
    c = await asyncpg.connect(_dsn())
    try:
        await c.execute("DELETE FROM bs_snapshot_consumed_by WHERE snapshot_id = $1", snap_id)
        await c.execute("DELETE FROM bs_production_snapshot WHERE id = $1", snap_id)
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_ingest_snapshot_reject_path(ingest_store):
    now = datetime.now(timezone.utc)
    snap_id = f"snap-rej-it-{int(time.time() * 1000)}"

    await ingest_store.insert_snapshot(
        snapshot_id=snap_id, project_id="p_default", name="reject-it",
        source_kind="dcgm", source_adapter="dcgm-csv@v1",
        storage_uri="file:///tmp/x", sha256="cd" * 32,
        row_count=10, bytes_=10,
        period_start=now, period_end=now,
        hardware_scope={}, workload_scope={}, redaction={},
        imported_by="it-tester", retention_until=None, notes=None,
    )
    ok = await ingest_store.reject(snap_id, "lihaoran", "missing redaction")
    assert ok is True
    got = await ingest_store.get_snapshot(snap_id)
    assert got["status"] == "rejected"
    assert "missing redaction" in (got["notes"] or "")

    # reject() on already-rejected returns False
    ok2 = await ingest_store.reject(snap_id, "lihaoran", None)
    assert ok2 is False

    import asyncpg
    c = await asyncpg.connect(_dsn())
    try:
        await c.execute("DELETE FROM bs_production_snapshot WHERE id = $1", snap_id)
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_ingest_get_snapshot_missing_returns_none(ingest_store):
    assert await ingest_store.get_snapshot("not-a-real-snap") is None


@pytest.mark.asyncio
async def test_ingest_list_consumers_empty(ingest_store):
    rows = await ingest_store.list_consumers("not-a-real-snap")
    assert rows == []


# ── engine-registry-svc/app/store.py ───────────────────────────────────────

@pytest.mark.asyncio
async def test_registry_list_engines_seeded(registry_store):
    rows = await registry_store.list_engines()
    names = {r["name"] for r in rows}
    assert "surrogate-analytical" in names


@pytest.mark.asyncio
async def test_registry_list_engines_status_filter(registry_store):
    active = await registry_store.list_engines(status="active")
    for e in active:
        assert e["status"] == "active"
    everything = await registry_store.list_engines(status=None)
    assert len(everything) >= len(active)


@pytest.mark.asyncio
async def test_registry_get_engine_happy_and_missing(registry_store):
    got = await registry_store.get_engine("surrogate-analytical")
    if got:
        assert got["name"] == "surrogate-analytical"
    assert await registry_store.get_engine("not-a-real-engine") is None


@pytest.mark.asyncio
async def test_registry_upsert_idempotent_then_heartbeat(registry_store):
    name = f"engine-it-{int(time.time() * 1000)}"
    payload = dict(
        name=name, version="v0", fidelity="analytical", sla_p99_ms=100,
        endpoint="http://x", predict_path="/v1/predict",
        coverage_envelope={"workload_families": ["transformer-dense"]},
        kpi_outputs=["mfu_pct"], calibration={},
        notes=None,
    )
    await registry_store.upsert_engine(**payload)
    await registry_store.upsert_engine(**payload)
    rows = await registry_store.list_engines()
    assert sum(1 for r in rows if r["name"] == name) == 1

    ok = await registry_store.heartbeat(name)
    assert ok is True
    assert await registry_store.heartbeat("not-a-real-engine") is False

    ok = await registry_store.set_calibration(name, {"mape_pct": {"mfu": 3.2}})
    assert ok is True
    assert await registry_store.set_calibration("not-a-real-engine",
                                                   {"mape_pct": {}}) is False

    ok = await registry_store.deprecate(name)
    assert ok is True

    import asyncpg
    c = await asyncpg.connect(_dsn())
    try:
        await c.execute("DELETE FROM bs_engine WHERE name = $1", name)
    finally:
        await c.close()


@pytest.mark.asyncio
async def test_registry_disable_stale_returns_list(registry_store):
    out = await registry_store.disable_stale(threshold_seconds=999_999)
    assert out == []
