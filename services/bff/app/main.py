from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app._obs import (
    PrometheusMiddleware,
    TraceIdMiddleware,
    mount_metrics,
    setup_logging,
)
from app.api import artifacts, auth, catalog, engines, runs, specs, streams, tco
from app.auth import AuthMiddleware, assert_secret_configured

setup_logging("bff")
from app.clients.asset_svc import AssetSvcClient
from app.clients.engine_registry_svc import EngineRegistrySvcClient
from app.clients.engine_svc import EngineSvcClient
from app.clients.ingest_svc import IngestSvcClient
from app.clients.run_svc import RunSvcClient
from app.clients.tco_svc import TcoSvcClient
from app.event_bus import EventBus


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuse to boot with the dev JWT secret unless explicit opt-in is set.
    assert_secret_configured()
    app.state.run_svc = RunSvcClient(os.environ.get("RUN_SVC_URL"))
    app.state.asset_svc = AssetSvcClient(os.environ.get("ASSET_SVC_URL"))
    app.state.engine_svc = EngineSvcClient(os.environ.get("ENGINE_SVC_URL"))
    app.state.tco_svc = TcoSvcClient(os.environ.get("TCO_SVC_URL"))
    app.state.engine_registry_svc = EngineRegistrySvcClient(os.environ.get("ENGINE_REGISTRY_URL"))
    app.state.ingest_svc = IngestSvcClient(os.environ.get("INGEST_SVC_URL"))
    app.state.event_bus = EventBus()
    await app.state.event_bus.open()
    try:
        yield
    finally:
        await app.state.event_bus.close()
        await app.state.run_svc.close()
        await app.state.asset_svc.close()
        await app.state.engine_svc.close()
        await app.state.tco_svc.close()
        await app.state.engine_registry_svc.close()
        await app.state.ingest_svc.close()


app = FastAPI(title="ByteSim BFF", version="0.9.0", lifespan=lifespan)
# Slice-15: AuthMiddleware runs *before* routing, so it can short-circuit with
# 401/403. CORSMiddleware is added second but Starlette executes middleware in
# reverse-add order — so CORS wraps Auth, which means preflight OPTIONS hits
# CORS first (no token needed) and the real request gets auth-checked next.
#
# CORS allow_origins is now env-driven. Production must set BFF_CORS_ORIGINS
# explicitly (comma-separated). Dev/CI sets BFF_ALLOW_DEV_CORS=1 to permit
# the localhost vite dev server. Default (neither set) = closed = same-origin only.
_DEV_CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
_raw_origins = os.environ.get("BFF_CORS_ORIGINS")
if _raw_origins:
    _allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]
elif os.environ.get("BFF_ALLOW_DEV_CORS") == "1":
    _allowed_origins = _DEV_CORS_ORIGINS
else:
    _allowed_origins = []  # same-origin only

app.add_middleware(AuthMiddleware)
# Prometheus + TraceId run *outside* Auth so we capture metrics + bind the
# trace_id even for 401 responses. Order: outer → inner is the order we add
# (Starlette executes the most-recently-added middleware first).
app.add_middleware(TraceIdMiddleware)
app.add_middleware(PrometheusMiddleware, service="bff")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
mount_metrics(app)
app.include_router(auth.router)
app.include_router(runs.router)
app.include_router(streams.router)
app.include_router(artifacts.router)
app.include_router(specs.router)
app.include_router(catalog.router)
app.include_router(tco.router)
app.include_router(engines.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
