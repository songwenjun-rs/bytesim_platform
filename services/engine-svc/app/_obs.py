"""ByteSim observability minimal kit (Phase 0.3).

> Source-of-truth lives at this file in services/bff/app/_obs.py. Each Python
> service ships an in-sync copy at services/<svc>/app/_obs.py. Phase 1 will
> extract to a shared package — until then, edits here must be propagated.

Provides:
  * setup_logging(service)        — JSON structlog + bridges stdlib logging.
  * TraceIdMiddleware             — reads/generates X-Trace-Id, binds to log ctx.
  * PrometheusMiddleware(service) — RED metrics (rate / error / duration).
  * mount_metrics(app)            — /metrics endpoint emitting Prom format.
  * traced_async_client(...)      — httpx.AsyncClient with trace_id auto-forward.

Wire-up in app/main.py:
    from app._obs import setup_logging, TraceIdMiddleware, PrometheusMiddleware, mount_metrics
    setup_logging("bff")
    app.add_middleware(PrometheusMiddleware, service="bff")
    app.add_middleware(TraceIdMiddleware)
    mount_metrics(app)
"""
from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from typing import Any

import httpx
import structlog
from fastapi import FastAPI, Request, Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    Counter,
    Histogram,
    generate_latest,
)
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.routing import Match


TRACE_HEADER = "X-Trace-Id"


# ── logging ──────────────────────────────────────────────────────────

def setup_logging(service: str) -> None:
    """Configure structlog JSON output and route stdlib logging through the
    same JSON formatter so existing log.info() calls also pick up trace_id.
    Idempotent — safe to call multiple times."""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.dev.set_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
    root = logging.getLogger()
    # Replace any existing handlers (uvicorn installs one in --reload mode).
    for h in list(root.handlers):
        root.removeHandler(h)
    # 12-factor: structured logs go to stdout, errors are surfaced via the
    # `level: error` field rather than a separate stderr stream.
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_StdlibJSONFormatter())
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    # Quiet down some chatty libs.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(service=service)


class _StdlibJSONFormatter(logging.Formatter):
    """Render LogRecords as JSON, merging structlog's contextvars (trace_id,
    service) so a `log.warning(...)` call from any third-party module ends
    up with the same shape as `structlog.get_logger().info(...)`."""

    def format(self, record: logging.LogRecord) -> str:
        ctx = structlog.contextvars.get_contextvars()
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "level": record.levelname.lower(),
            "logger": record.name,
            "event": record.getMessage(),
            **ctx,
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


# ── Prometheus ───────────────────────────────────────────────────────

# pytest re-imports modules across tests; redefining a Counter raises. Read
# from the registry first when present.
def _ensure_counter(name: str, doc: str, labels: list[str]) -> Counter:
    existing = REGISTRY._names_to_collectors.get(name)
    if existing is not None:
        return existing  # type: ignore[return-value]
    return Counter(name, doc, labels)


def _ensure_histogram(name: str, doc: str, labels: list[str], **kw: Any) -> Histogram:
    existing = REGISTRY._names_to_collectors.get(name)
    if existing is not None:
        return existing  # type: ignore[return-value]
    return Histogram(name, doc, labels, **kw)


REQ_COUNT = _ensure_counter(
    "bytesim_requests_total",
    "HTTP requests by service / method / route / status.",
    ["service", "method", "route", "status"],
)
REQ_DURATION = _ensure_histogram(
    "bytesim_request_duration_seconds",
    "HTTP request duration histogram.",
    ["service", "method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)


class PrometheusMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, service: str) -> None:
        super().__init__(app)
        self.service = service

    async def dispatch(self, request: Request, call_next):
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            elapsed = time.perf_counter() - start
            route = _resolve_route(request)
            try:
                REQ_COUNT.labels(self.service, request.method, route, str(status)).inc()
                REQ_DURATION.labels(self.service, request.method, route).observe(elapsed)
            except Exception:
                pass  # never let metrics failure break a request


def _resolve_route(request: Request) -> str:
    """Resolve to the route template (e.g. /v1/runs/{id}) instead of the raw
    path so /v1/runs/sim-7f2a and /v1/runs/sim-7e90 collapse onto one label."""
    try:
        for route in request.app.router.routes:
            match, _ = route.matches(request.scope)
            if match == Match.FULL:
                return getattr(route, "path", request.url.path)
    except Exception:
        pass
    return request.url.path


def mount_metrics(app: FastAPI) -> None:
    """Add a /metrics endpoint emitting Prometheus exposition format. The
    endpoint is excluded from auth middleware via the public-paths list."""
    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ── Trace ID ─────────────────────────────────────────────────────────

class TraceIdMiddleware(BaseHTTPMiddleware):
    """Read/generate X-Trace-Id, bind to structlog contextvars, echo in
    response. WebSocket scopes bypass BaseHTTPMiddleware entirely — for WS,
    the handler should call `bind_trace_id_for_ws(ws)` itself."""

    async def dispatch(self, request: Request, call_next):
        tid = request.headers.get(TRACE_HEADER) or _new_trace_id()
        structlog.contextvars.bind_contextvars(trace_id=tid)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("trace_id")
        response.headers[TRACE_HEADER] = tid
        return response


def _new_trace_id() -> str:
    return uuid.uuid4().hex[:16]


def current_trace_id() -> str | None:
    """Return the active trace_id, if any. Useful in WS handlers / background
    tasks that aren't covered by TraceIdMiddleware."""
    return structlog.contextvars.get_contextvars().get("trace_id")


# ── outbound httpx with trace_id propagation ─────────────────────────

async def _trace_id_event_hook(request: httpx.Request) -> None:
    """httpx.AsyncClient awaits its event_hooks, so this must be a coroutine
    even though the body is synchronous."""
    tid = current_trace_id()
    if tid and TRACE_HEADER.lower() not in {h.lower() for h in request.headers}:
        request.headers[TRACE_HEADER] = tid


def traced_async_client(*args: Any, **kw: Any) -> httpx.AsyncClient:
    """Drop-in httpx.AsyncClient that auto-injects X-Trace-Id from the active
    request context. Use everywhere instead of bare `httpx.AsyncClient(...)`
    so cross-service trace correlation is automatic."""
    hooks = kw.pop("event_hooks", None) or {}
    request_hooks = list(hooks.get("request", []))
    request_hooks.append(_trace_id_event_hook)
    hooks["request"] = request_hooks
    return httpx.AsyncClient(*args, event_hooks=hooks, **kw)
