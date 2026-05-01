"""§5 TCO read passthrough — Run-detail page reads TCO breakdown via this."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()


@router.get("/v1/runs/{run_id}/tco")
async def get_run_tco(run_id: str, request: Request) -> dict[str, Any]:
    try:
        return await request.app.state.tco_svc.get_breakdown(run_id)
    except Exception as exc:
        msg = str(exc)
        code = 404 if "404" in msg or "not found" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=msg) from exc


@router.get("/v1/tco/rules")
async def list_tco_rules(request: Request, resource_kind: str | None = None) -> list[dict[str, Any]]:
    try:
        return await request.app.state.tco_svc.list_rules(resource_kind)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/v1/tco/compare")
async def compare_designs(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """Two designs A vs B → ΔTCO. Used by the design-explorer UI."""
    try:
        return await request.app.state.tco_svc.compare(body)
    except Exception as exc:
        msg = str(exc)
        code = 400 if "rule_versions differ" in msg else 502
        raise HTTPException(status_code=code, detail=msg) from exc
