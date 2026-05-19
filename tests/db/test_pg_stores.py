"""Store-client contract tests for Python services.

After the data-access consolidation, tco_svc and engine_svc registry stores
are httpx clients to data_svc instead of direct asyncpg stores. These tests
pin the request/response contract at that boundary.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from _svc_path import svc_path_p  # noqa: E402


def _import(svc: str, mod: str):
    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items() if k == "app" or k.startswith("app.")}
    for k in list(saved_mods):
        del sys.modules[k]
    sys.path.insert(0, str(svc_path_p(ROOT, svc)))
    try:
        return importlib.import_module(f"app.{mod}")
    finally:
        sys.path[:] = saved_path
        for k in list(sys.modules):
            if k == "app" or k.startswith("app."):
                del sys.modules[k]
        sys.modules.update(saved_mods)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_tco_rules_lookup_contract():
    mod = _import("tco_svc", "store")
    seen: list[tuple[str, str, dict[str, str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, dict(request.url.params)))
        if request.url.path == "/v1/tco_rules":
            return httpx.Response(200, json=[{"id": "gpu/B200/v2026q1", "vendor_sku": "Nvidia/B200-180GB"}])
        if request.url.path == "/v1/tco_rules/match" and request.url.params.get("resource_kind") == "gpu":
            return httpx.Response(200, json={"id": "gpu/B200/v2026q1", "resource_kind": "gpu"})
        return httpx.Response(404, json={"detail": "not found"})

    async def go():
        s = mod.Store()
        s.client = httpx.AsyncClient(base_url="http://data-svc", transport=httpx.MockTransport(handler))
        try:
            rules = await s.list_rules("gpu")
            assert rules[0]["vendor_sku"] == "Nvidia/B200-180GB"
            assert (await s.find_rule("gpu", "Nvidia/B200-180GB"))["id"] == "gpu/B200/v2026q1"
            assert await s.find_rule("nonexistent", None) is None
        finally:
            await s.close()

    _run(go())
    assert ("GET", "/v1/tco_rules", {"resource_kind": "gpu"}) in seen
    assert ("GET", "/v1/tco_rules/match", {"resource_kind": "gpu", "vendor_sku": "Nvidia/B200-180GB"}) in seen


def test_tco_breakdown_put_get_contract():
    mod = _import("tco_svc", "store")
    bodies: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal current
        if request.url.path == "/v1/runs/missing/tco_breakdown":
            return httpx.Response(404, json={"detail": "not found"})
        if request.url.path == "/v1/runs/sim-tco-test/tco_breakdown" and request.method == "PUT":
            current = json.loads(request.content.decode("utf-8"))
            bodies.append(current)
            return httpx.Response(204)
        if request.url.path == "/v1/runs/sim-tco-test/tco_breakdown" and request.method == "GET":
            return httpx.Response(200, json=current)
        return httpx.Response(404, json={"detail": "not found"})

    async def go():
        s = mod.Store()
        s.client = httpx.AsyncClient(base_url="http://data-svc", transport=httpx.MockTransport(handler))
        try:
            await s.upsert_breakdown("sim-tco-test", {"total_usd": 162})
            assert (await s.get_breakdown("sim-tco-test"))["total_usd"] == 162
            await s.upsert_breakdown("sim-tco-test", {"total_usd": 999})
            assert (await s.get_breakdown("sim-tco-test"))["total_usd"] == 999
            assert await s.get_breakdown("missing") is None
        finally:
            await s.close()

    _run(go())
    assert bodies == [{"total_usd": 162}, {"total_usd": 999}]


def test_engine_registry_client_contract():
    mod = _import("engine_svc", "registry.store")
    engines: dict[str, dict[str, Any]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/engines" and request.method == "GET":
            status = request.url.params.get("status")
            rows = list(engines.values())
            if status:
                rows = [r for r in rows if r["status"] == status]
            return httpx.Response(200, json=rows)
        if path.startswith("/v1/engines/"):
            name = path.split("/")[3]
            if request.method == "PUT":
                body = json.loads(request.content.decode("utf-8"))
                engines[name] = {"name": name, "status": "active", **body}
                return httpx.Response(200, json=engines[name])
            if request.method == "GET":
                row = engines.get(name)
                return httpx.Response(200, json=row) if row else httpx.Response(404, json={})
            if path.endswith("/heartbeat"):
                return httpx.Response(204) if name in engines else httpx.Response(404, json={})
            if path.endswith("/calibration"):
                if name not in engines:
                    return httpx.Response(404, json={})
                engines[name]["calibration"] = json.loads(request.content.decode("utf-8"))["calibration"]
                return httpx.Response(204)
        return httpx.Response(404, json={})

    payload = dict(
        name="test-eng",
        version="v0",
        fidelity="analytical",
        sla_p99_ms=100,
        endpoint="http://x",
        predict_path="/v1/predict",
        coverage_envelope={},
        kpi_outputs=[],
        calibration={},
        notes=None,
    )

    async def go():
        s = mod.RegistryStore()
        s.client = httpx.AsyncClient(base_url="http://data-svc", transport=httpx.MockTransport(handler))
        try:
            assert await s.list_engines(status=None) == []
            await s.upsert_engine(**payload)
            await s.upsert_engine(**payload)
            rows = await s.list_engines(status=None)
            assert sum(1 for r in rows if r["name"] == "test-eng") == 1
            assert await s.get_engine("test-eng") is not None
            assert await s.get_engine("missing") is None
            assert await s.heartbeat("test-eng") is True
            assert await s.heartbeat("missing") is False
            assert await s.set_calibration("test-eng", {"mape_pct": {"mfu": 3.2}}) is True
            assert await s.set_calibration("missing", {}) is False
        finally:
            await s.close()

    _run(go())
    assert engines["test-eng"]["calibration"]["mape_pct"]["mfu"] == 3.2
