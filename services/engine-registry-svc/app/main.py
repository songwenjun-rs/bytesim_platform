"""§2 Engine Plugin Registry — RFC-001 v2 (M2 cutover, no v1 compat).

Endpoints:
  GET   /healthz
  GET   /v1/engines                          — list registered engines (filter status)
  GET   /v1/engines/{name}                   — get one engine
  POST  /v1/engines/register                 — engine self-registration; reverse-fetches
                                                GET <endpoint>/v1/capabilities to detect
                                                self-attest drift
  PATCH /v1/engines/{name}/heartbeat         — refresh last_seen_at; 404 if not active
  POST  /v1/engines/{name}/deprecate         — soft-deprecate
  POST  /v1/predict                          — coverage-aware routing; payload is
                                                EnginePredictRequest (RFC §2.4)

Background:
  • every 30s: disable engines whose last_seen_at is older than 90s
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

from engine_contracts import (
    CoverageEnvelope,
    EnginePredictRequest,
    EnginePredictResponse,
)

from app.router import explain_misses, select_engine
from app.store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("engine-registry")

PREDICT_TIMEOUT_S = float(os.environ.get("ENGINE_PREDICT_TIMEOUT_S", "10"))
SWEEP_INTERVAL_S = float(os.environ.get("ENGINE_REGISTRY_SWEEP_S", "30"))
STALE_THRESHOLD_S = int(os.environ.get("ENGINE_REGISTRY_STALE_S", "90"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = Store()
    await app.state.store.open()
    app.state.client = httpx.AsyncClient(timeout=PREDICT_TIMEOUT_S)

    async def _sweep_loop() -> None:
        while True:
            try:
                await asyncio.sleep(SWEEP_INTERVAL_S)
                disabled = await app.state.store.disable_stale(STALE_THRESHOLD_S)
                if disabled:
                    log.warning("disabled stale engines (>%ds): %s", STALE_THRESHOLD_S, disabled)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("sweep_loop iteration failed")

    app.state.sweep_task = asyncio.create_task(_sweep_loop())
    try:
        yield
    finally:
        app.state.sweep_task.cancel()
        try:
            await app.state.sweep_task
        except (asyncio.CancelledError, Exception):
            pass
        await app.state.client.aclose()
        await app.state.store.close()


app = FastAPI(title="ByteSim Engine Registry", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ── Schemas ───────────────────────────────────────────────────────────────


class RegisterRequest(BaseModel):
    name: str
    version: str
    fidelity: str = Field(pattern="^(analytical|hybrid|cycle-accurate)$")
    sla_p99_ms: int = Field(gt=0)
    endpoint: str
    predict_path: str = "/v1/predict"
    capabilities_path: str = "/v1/capabilities"
    coverage_envelope: CoverageEnvelope
    kpi_outputs: list[str] = Field(default_factory=list)
    calibration: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = None


class PredictRequestEnvelope(BaseModel):
    """Wraps the engine-facing payload with routing hints. The `payload`
    field is a fully-typed EnginePredictRequest (RFC §2.4); registry
    forwards it verbatim to the chosen engine."""
    payload: EnginePredictRequest
    sla_budget_ms: int | None = None
    engine_preference: str | None = None
    fidelity_floor: str | None = Field(
        default=None, pattern="^(analytical|hybrid|cycle-accurate)$",
    )


# ── Endpoints ─────────────────────────────────────────────────────────────


@app.get("/v1/engines")
async def list_engines(status: str | None = "active") -> list[dict[str, Any]]:
    return await app.state.store.list_engines(status=status)


@app.get("/v1/engines/{name}")
async def get_engine(name: str) -> dict[str, Any]:
    e = await app.state.store.get_engine(name)
    if not e:
        raise HTTPException(404, f"engine not found: {name}")
    return e


@app.post("/v1/engines/register")
async def register_engine(req: RegisterRequest) -> dict[str, Any]:
    """Self-registration. Reverse-fetches GET <endpoint><capabilities_path>
    and asserts the returned envelope matches the request body — defends
    against engines lying in their register payload."""
    cap_url = f"{req.endpoint.rstrip('/')}{req.capabilities_path}"
    try:
        cap_resp = await app.state.client.get(cap_url)
        cap_resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(
            422,
            f"reverse capabilities fetch failed at {cap_url}: {exc}; "
            f"engine must expose {req.capabilities_path} returning the same "
            f"envelope it registers with",
        ) from exc

    # Compare envelope (the field that drives routing). version + fidelity +
    # sla_p99_ms are also compared so engines can't soft-update through
    # capabilities path drift.
    cap_body = cap_resp.json()
    if not isinstance(cap_body, dict):
        raise HTTPException(422, f"{cap_url} returned non-object")
    try:
        live_env = CoverageEnvelope.model_validate(cap_body.get("coverage_envelope") or {})
    except ValidationError as exc:
        raise HTTPException(422, f"{cap_url} envelope invalid: {exc}") from exc
    if live_env.model_dump() != req.coverage_envelope.model_dump():
        raise HTTPException(
            422,
            "coverage_envelope in register body differs from what the engine "
            f"returns at {cap_url}; reject self-attest drift",
        )
    for f in ("name", "version", "fidelity", "sla_p99_ms"):
        if cap_body.get(f) != getattr(req, f):
            raise HTTPException(
                422, f"engine {cap_url} reports {f}={cap_body.get(f)!r}, "
                     f"register body says {getattr(req, f)!r}",
            )

    return await app.state.store.upsert_engine(
        name=req.name, version=req.version, fidelity=req.fidelity,
        sla_p99_ms=req.sla_p99_ms, endpoint=req.endpoint,
        predict_path=req.predict_path,
        coverage_envelope=req.coverage_envelope.model_dump(),
        kpi_outputs=req.kpi_outputs, calibration=req.calibration,
        notes=req.notes,
    )


@app.patch("/v1/engines/{name}/heartbeat")
async def heartbeat(name: str) -> dict[str, str]:
    ok = await app.state.store.heartbeat(name)
    if not ok:
        raise HTTPException(404, f"engine not active: {name}")
    return {"name": name, "ok": "true"}


class CalibrationPatch(BaseModel):
    """Body for PATCH /v1/engines/{name}/calibration. Free-form JSON: convention
    is `{profile_runs: [snapshot_id...], mape_pct: {mfu: 3.2, step_ms: 4.1}}`,
    but the selector only reads `calibration.mape_pct.mfu` today (RFC-001 §2.5
    sort key #2). Anything else passes through to the UI for inspection."""
    profile_runs: list[str] = Field(default_factory=list)
    mape_pct: dict[str, float] = Field(default_factory=dict)
    extras: dict[str, Any] = Field(default_factory=dict)


@app.patch("/v1/engines/{name}/calibration")
async def patch_calibration(name: str, patch: CalibrationPatch) -> dict[str, Any]:
    """RFC-004 — calibration-svc writes here after a reconcile. Replaces the
    full `calibration` JSONB; callers that want a partial merge should GET
    first then PATCH the merged object."""
    body = {
        "profile_runs": patch.profile_runs,
        "mape_pct": patch.mape_pct,
        **patch.extras,
    }
    ok = await app.state.store.set_calibration(name, body)
    if not ok:
        raise HTTPException(404, f"engine not registered: {name}")
    return {"name": name, "calibration": body}


@app.post("/v1/engines/{name}/deprecate")
async def deprecate_engine(name: str) -> dict[str, Any]:
    ok = await app.state.store.deprecate(name)
    if not ok:
        raise HTTPException(404, f"engine not active or not found: {name}")
    return {"deprecated": name}


@app.post("/v1/predict")
async def predict(req: PredictRequestEnvelope) -> dict[str, Any]:
    engines = await app.state.store.list_engines(status="active")
    if not engines:
        raise HTTPException(503, "no active engines registered")

    chosen = select_engine(
        engines, req.payload,
        sla_budget_ms=req.sla_budget_ms,
        engine_preference=req.engine_preference,
        fidelity_floor=req.fidelity_floor,  # type: ignore[arg-type]
    )
    if chosen is None:
        # Engineer-friendly 503: per-engine miss reasons so the caller knows
        # exactly which envelope didn't fit (RFC §2.5 enhancement).
        raise HTTPException(503, {
            "detail": "no engine covers this request",
            "misses": explain_misses(engines, req.payload),
        })

    url = f"{chosen['endpoint']}{chosen['predict_path']}"
    payload_body = req.payload.model_dump(exclude_none=True)
    t0 = time.perf_counter()
    try:
        r = await app.state.client.post(url, json=payload_body)
        r.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # Engine returned 4xx — most likely 422 from the engine telling us its
        # envelope was wrong. Surface upstream status verbatim.
        try:
            detail = exc.response.json()
        except Exception:
            detail = exc.response.text
        raise HTTPException(exc.response.status_code,
                            {"engine": chosen["name"], "detail": detail}) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"engine '{chosen['name']}' failed: {exc}") from exc

    raw = r.json()
    if not isinstance(raw, dict):
        raise HTTPException(502, f"engine '{chosen['name']}' returned non-object")

    # Validate the engine's response against the contract; any engine that
    # ships a malformed body becomes the registry's problem to surface, not
    # the caller's mystery 200.
    try:
        resp = EnginePredictResponse.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(
            502,
            {"engine": chosen["name"],
             "detail": f"response failed contract: {exc.errors()[:3]}"},
        ) from exc

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    body = resp.model_dump(exclude_none=False)
    body["_provenance"] = {
        "engine": chosen["name"],
        "version": chosen["version"],
        "fidelity": chosen["fidelity"],
        "confidence": resp.confidence,
        "coverage_status": resp.coverage_status,
        "latency_ms": round(elapsed_ms, 3),
        "selected_by": "engine_preference" if req.engine_preference else "auto",
    }
    return body
