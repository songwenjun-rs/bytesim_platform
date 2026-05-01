from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()


@router.get("/v1/specs/{kind}")
async def list_specs(kind: str, request: Request) -> list[dict[str, Any]]:
    try:
        return await request.app.state.asset_svc.list_specs(kind)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/v1/specs/{kind}/{spec_id}")
async def get_spec(kind: str, spec_id: str, request: Request) -> dict[str, Any]:
    try:
        return await request.app.state.asset_svc.get_latest(kind, spec_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/v1/specs/{kind}/{spec_id}/versions")
async def list_spec_versions(kind: str, spec_id: str, request: Request) -> list[dict[str, Any]]:
    try:
        return await request.app.state.asset_svc.list_versions(kind, spec_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/v1/specs/{kind}/{spec_id}/snapshot")
async def snapshot_spec(kind: str, spec_id: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
    body = payload.get("body")
    if body is None:
        raise HTTPException(status_code=400, detail="body required")
    try:
        return await request.app.state.asset_svc.snapshot(
            kind, spec_id, body, payload.get("version_tag"),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/v1/specs/{kind}/{spec_id}/diff")
async def diff_spec(kind: str, spec_id: str, request: Request,
                    from_hash: str = "", to_hash: str = "") -> dict[str, Any]:
    # Pydantic doesn't allow `from` as a parameter name in a function signature,
    # so the query keys come through as plain strings via raw URL parsing.
    from_q = request.query_params.get("from", from_hash)
    to_q = request.query_params.get("to", to_hash)
    if not from_q or not to_q:
        raise HTTPException(status_code=400, detail="from and to required")
    try:
        return await request.app.state.asset_svc.diff(kind, spec_id, from_q, to_q)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/v1/specs/{kind}/{spec_id}/fork")
async def fork_spec(kind: str, spec_id: str, payload: dict[str, Any],
                    request: Request) -> dict[str, Any]:
    if not payload.get("new_name"):
        raise HTTPException(status_code=400, detail="new_name required")
    try:
        return await request.app.state.asset_svc.fork(kind, spec_id, payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
