"""P0-A.0.3 — observability minimal kit.

Locks the contract that:
  * setup_logging() emits JSON with service tag
  * TraceIdMiddleware reads / generates X-Trace-Id and echoes it back
  * Trace ID is propagated to outbound httpx calls (cross-service correlation)
  * /metrics endpoint exposes Prometheus exposition format with bytesim_* names
  * PrometheusMiddleware tags requests with service / method / route / status
"""
from __future__ import annotations

import io
import json
import logging

import httpx
import pytest
import structlog
from fastapi import FastAPI
from fastapi.testclient import TestClient


# ── setup_logging emits JSON ─────────────────────────────────────────

def test_setup_logging_emits_json_with_service_tag(capsys):
    from app._obs import setup_logging  # type: ignore
    setup_logging("test-svc")
    log = logging.getLogger("regression")
    log.warning("hello world")
    out = capsys.readouterr().out
    # Find the JSON line we just emitted (uvicorn / pytest may print other things).
    line = next(l for l in out.splitlines() if "hello world" in l)
    payload = json.loads(line)
    assert payload["event"] == "hello world"
    assert payload["level"] == "warning"
    assert payload["service"] == "test-svc"


def test_setup_logging_includes_trace_id_when_bound(capsys):
    from app._obs import setup_logging  # type: ignore
    setup_logging("test-svc")
    structlog.contextvars.bind_contextvars(trace_id="abc123")
    try:
        logging.getLogger("regression").info("traced message")
    finally:
        structlog.contextvars.unbind_contextvars("trace_id")
    out = capsys.readouterr().out
    line = next(l for l in out.splitlines() if "traced message" in l)
    payload = json.loads(line)
    assert payload["trace_id"] == "abc123"


# ── TraceIdMiddleware echo ───────────────────────────────────────────

def _build_obs_app() -> FastAPI:
    from app._obs import (  # type: ignore
        PrometheusMiddleware,
        TraceIdMiddleware,
        mount_metrics,
    )
    app = FastAPI()
    app.add_middleware(TraceIdMiddleware)
    app.add_middleware(PrometheusMiddleware, service="test-svc")
    mount_metrics(app)

    @app.get("/ping")
    async def ping():
        return {"pong": True}

    @app.get("/items/{item_id}")
    async def items(item_id: str):
        return {"id": item_id}

    @app.get("/boom")
    async def boom():
        raise RuntimeError("kaboom")

    return app


def test_trace_id_is_generated_when_missing():
    app = _build_obs_app()
    with TestClient(app) as client:
        r = client.get("/ping")
        assert r.status_code == 200
        tid = r.headers.get("X-Trace-Id")
        assert tid and len(tid) >= 16


def test_trace_id_is_echoed_back_when_provided():
    app = _build_obs_app()
    with TestClient(app) as client:
        r = client.get("/ping", headers={"X-Trace-Id": "deadbeef00000001"})
        assert r.headers["X-Trace-Id"] == "deadbeef00000001"


# ── outbound httpx propagation ───────────────────────────────────────

@pytest.mark.asyncio
async def test_traced_async_client_forwards_trace_id():
    """traced_async_client must inject X-Trace-Id from the active contextvar
    onto outbound requests so cross-service trace correlation just works."""
    from app._obs import traced_async_client, _trace_id_event_hook  # type: ignore

    captured: dict[str, str] = {}

    def transport_handler(request: httpx.Request) -> httpx.Response:
        captured["trace_id"] = request.headers.get("X-Trace-Id", "")
        return httpx.Response(200, json={"ok": True})

    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(trace_id="t-abc-123")
    try:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(transport_handler),
            event_hooks={"request": [_trace_id_event_hook]},
        ) as client:
            r = await client.get("https://upstream/x")
            assert r.status_code == 200
        assert captured["trace_id"] == "t-abc-123"
    finally:
        structlog.contextvars.clear_contextvars()


@pytest.mark.asyncio
async def test_traced_async_client_does_not_overwrite_explicit_header():
    """If caller already set X-Trace-Id manually, the hook leaves it alone
    (e.g. SDK bridging from another tracing system)."""
    from app._obs import _trace_id_event_hook  # type: ignore

    captured: dict[str, str] = {}
    def handler(request: httpx.Request) -> httpx.Response:
        captured["trace_id"] = request.headers.get("X-Trace-Id", "")
        return httpx.Response(200)

    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(trace_id="auto-id")
    try:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            event_hooks={"request": [_trace_id_event_hook]},
        ) as client:
            await client.get("https://upstream/", headers={"X-Trace-Id": "explicit-id"})
        assert captured["trace_id"] == "explicit-id"
    finally:
        structlog.contextvars.clear_contextvars()


# ── /metrics endpoint ────────────────────────────────────────────────

def test_metrics_endpoint_exposes_prometheus_format():
    app = _build_obs_app()
    with TestClient(app) as client:
        client.get("/ping")  # generate a sample first
        r = client.get("/metrics")
        assert r.status_code == 200
        assert "text/plain" in r.headers["content-type"]
        body = r.text
        # Prometheus exposition format: comment lines + sample lines.
        assert "# TYPE bytesim_requests_total counter" in body
        assert 'service="test-svc"' in body
        assert 'route="/ping"' in body


def test_metrics_records_route_template_not_raw_path():
    """Two different item ids should collapse onto a single /items/{item_id}
    label so we don't blow out cardinality."""
    app = _build_obs_app()
    with TestClient(app) as client:
        client.get("/items/alpha")
        client.get("/items/beta")
        r = client.get("/metrics")
        body = r.text
        assert 'route="/items/{item_id}"' in body
        # The raw path must NOT appear as its own time series.
        assert 'route="/items/alpha"' not in body
        assert 'route="/items/beta"' not in body


def test_metrics_records_5xx_status():
    app = _build_obs_app()
    with TestClient(app) as client:
        # FastAPI by default re-raises in TestClient; use raise_server_exceptions=False
        # to let the 500 response come back naturally.
        with TestClient(app, raise_server_exceptions=False) as c2:
            r = c2.get("/boom")
            assert r.status_code == 500
        r = client.get("/metrics")
        body = r.text
        assert 'status="500"' in body
