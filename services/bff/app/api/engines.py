"""§2 Engine registry passthrough — surfaces "which engines are registered"
for the platform observability page. Read-only listing + a /predict pass-
through that lets e2e (and architects) hit any registered engine end-to-end
through the BFF without bypassing JWT/RBAC.

RFC-001 v2 (M2 cutover): no `domain` filter on list; predict body is the
v2 PredictRequestEnvelope shape ({payload, sla_budget_ms?, engine_preference?,
fidelity_floor?})."""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()


@router.get("/v1/engines")
async def list_engines(request: Request,
                        status: str | None = None) -> list[dict[str, Any]]:
    try:
        return await request.app.state.engine_registry_svc.list_engines(status=status)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/v1/engines/{name}")
async def get_engine(name: str, request: Request) -> dict[str, Any]:
    try:
        return await request.app.state.engine_registry_svc.get_engine(name)
    except Exception as exc:
        msg = str(exc)
        code = 404 if "404" in msg or "not found" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=msg) from exc


class EnginePredictRequestBody(BaseModel):
    """Mirror of registry's PredictRequestEnvelope. We don't import the
    contract type here because BFF doesn't need to validate the inner
    payload — registry does that strictly and surfaces 422 on bad shape."""
    payload: dict[str, Any]
    sla_budget_ms: int | None = None
    engine_preference: str | None = None
    fidelity_floor: str | None = None


@router.post("/v1/engines/predict")
async def engine_predict(req: EnginePredictRequestBody, request: Request) -> dict[str, Any]:
    """Forward to engine-registry's /v1/predict. Lets e2e validate that any
    registered engine actually round-trips through the registry."""
    try:
        return await request.app.state.engine_registry_svc.predict(
            req.model_dump(exclude_none=True)
        )
    except httpx.HTTPStatusError as exc:
        try:
            detail = exc.response.json()
        except Exception:
            detail = exc.response.text
        raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
