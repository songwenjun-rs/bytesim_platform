"""mount_engine_runtime — single drop-in for engine FastAPI apps.

Wires GET /v1/capabilities + POST /v1/predict + boot-time registration +
30s heartbeat + clean-shutdown deprecate. The engine writer only supplies a
predict_fn(EnginePredictRequest) → EnginePredictResponse.

Failure model:
  • registry unreachable at boot → log + retry every 5s in the background;
    /v1/predict still works (engine is functional, just not in registry yet)
  • predict_fn raises → 502 with the exception text (registry + engine-svc
    will wrap it again; the chain shows where it died)
  • predict_fn returns coverage_status='rejected' → reraise as 422 (RFC §2.4
    contract — never return 200 with rejected)
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Awaitable, Callable

import httpx
from fastapi import FastAPI, HTTPException

from engine_contracts import EnginePredictRequest, EnginePredictResponse

from .descriptor import EngineDescriptor

log = logging.getLogger("engine-runtime")

PredictFn = Callable[[EnginePredictRequest], Awaitable[EnginePredictResponse] | EnginePredictResponse]


def mount_engine_runtime(
    app: FastAPI,
    descriptor: EngineDescriptor,
    predict_fn: PredictFn,
    *,
    registry_env_var: str = "ENGINE_REGISTRY_URL",
    heartbeat_interval_s: float = 30.0,
    register_retry_s: float = 5.0,
) -> None:
    @app.get(descriptor.capabilities_path)
    def _capabilities() -> dict[str, Any]:
        return descriptor.to_capabilities_body()

    @app.get("/v1/smoke_matrix")
    def _smoke_matrix() -> dict[str, Any]:
        # RFC-002 — contract harness pulls this and runs every case through
        # /v1/predict, asserting KPI ranges. Lives behind GET so anyone with
        # network reach to the svc can pull it (it's intended for CI).
        return descriptor.to_smoke_matrix_body()

    @app.post(descriptor.predict_path)
    async def _predict(req: EnginePredictRequest) -> dict[str, Any]:
        try:
            result = predict_fn(req)
            if asyncio.iscoroutine(result):
                resp: EnginePredictResponse = await result
            else:
                resp = result  # type: ignore[assignment]
        except HTTPException:
            raise
        except ValueError as exc:
            # Engine signalled "this request is outside what I cover" — must be
            # 422 per RFC §2.4 contract.
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            log.exception("%s.predict raised", descriptor.name)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        if not isinstance(resp, EnginePredictResponse):
            raise HTTPException(status_code=502, detail="predict_fn returned wrong type")

        return resp.model_dump(exclude_none=False)

    registry_url = os.environ.get(registry_env_var, "").rstrip("/")

    async def _register_loop() -> None:
        if not registry_url:
            log.info("%s: %s unset, skipping self-registration", descriptor.name, registry_env_var)
            return
        body = descriptor.to_register_body()
        # Boot phase — keep retrying until first success so registry restarts
        # don't permanently orphan us.
        async with httpx.AsyncClient(timeout=5.0) as client:
            while True:
                try:
                    r = await client.post(f"{registry_url}/v1/engines/register", json=body)
                    if r.status_code < 300:
                        log.info("%s: registered with %s", descriptor.name, registry_url)
                        break
                    log.warning("%s: register HTTP %d: %s",
                                descriptor.name, r.status_code, r.text[:200])
                except Exception as exc:
                    log.warning("%s: register failed (%s); retry in %ss",
                                descriptor.name, exc, register_retry_s)
                await asyncio.sleep(register_retry_s)

            # Steady-state — heartbeat. On failure, fall back to full re-register
            # in case the registry forgot us (restart, redeploy).
            while True:
                await asyncio.sleep(heartbeat_interval_s)
                try:
                    r = await client.patch(
                        f"{registry_url}/v1/engines/{descriptor.name}/heartbeat",
                    )
                    if r.status_code == 404:
                        log.info("%s: heartbeat 404 — re-registering", descriptor.name)
                        await client.post(f"{registry_url}/v1/engines/register", json=body)
                    elif r.status_code >= 300:
                        log.warning("%s: heartbeat HTTP %d: %s",
                                    descriptor.name, r.status_code, r.text[:200])
                except Exception as exc:
                    log.warning("%s: heartbeat exception: %s", descriptor.name, exc)

    @app.on_event("startup")
    async def _start_register() -> None:
        # Fire-and-forget; never block app startup on registry availability.
        app.state._engine_register_task = asyncio.create_task(_register_loop())

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        task: asyncio.Task | None = getattr(app.state, "_engine_register_task", None)
        if task and not task.done():
            task.cancel()
        if registry_url:
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    await client.post(
                        f"{registry_url}/v1/engines/{descriptor.name}/deprecate",
                    )
            except Exception:
                pass
