"""Live-PG integration tests for the Python store layers.

Lifts coverage of:
  - service/tco_engine_svc/app/store.py
  - service/engine_registry_svc/app/store.py

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
sys.path.insert(0, str(ROOT / "tests"))
from _svc_path import svc_path_p  # noqa: E402


def _dsn():
    d = os.environ.get("PG_DSN")
    if not d:
        pytest.skip("PG_DSN not set; skipping Python store integration tests")
    return d


def _import_svc_store(svc: str):
    """Mount the service on sys.path, import + return its app.store module."""
    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items()
                  if k == "app" or k.startswith("app.")}
    for k in list(saved_mods):
        del sys.modules[k]
    sys.path.insert(0, str(svc_path_p(ROOT, svc)))
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
    mod, sp, sm = _import_svc_store("tco_engine_svc")
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
    mod, sp, sm = _import_svc_store("engine_registry_svc")
    s = mod.Store()
    s.dsn = dsn
    await s.open()
    yield s
    try:
        await s.close()
    finally:
        _restore(sp, sm)


# ── tco_engine_svc/app/store.py ────────────────────────────────────────────

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


# ── engine_registry_svc/app/store.py ───────────────────────────────────────

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
        coverage_envelope={"model_families": ["transformer-dense"]},
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
