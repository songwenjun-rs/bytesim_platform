from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()
log = logging.getLogger("bff.runs")


@router.get("/v1/runs")
async def list_runs(
    request: Request,
    status: str | None = None,
    kind: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List runs for the仿真报告 page. `status`/`kind` accept comma-separated
    values; run-svc handles the splitting."""
    try:
        return await request.app.state.run_svc.list_runs(
            status=status, kind=kind, limit=limit,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/v1/runs/{run_id}/full")
async def get_run_full(run_id: str, request: Request) -> dict[str, Any]:
    """Aggregate everything the Run-detail page needs in a single round-trip:
    base run + specs (with stale flags) + lineage (parents/children/edges)."""
    client = request.app.state.run_svc
    try:
        run, specs, lineage = await asyncio.gather(
            client.get_run(run_id),
            client.get_specs(run_id),
            client.get_lineage(run_id),
        )
    except Exception as exc:
        # propagate 404 cleanly; everything else is 502 (downstream issue).
        msg = str(exc)
        code = 404 if "404" in msg or "not found" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=msg) from exc

    any_stale_spec = any(s.get("stale") for s in specs)
    # run-svc returns null arrays when a run has no parents/children/edges
    # (fresh runs created via /v1/runs). Normalise to [] so the frontend's
    # .length / .map calls don't crash.
    if isinstance(lineage, dict):
        for k in ("parents", "children", "edges"):
            if lineage.get(k) is None:
                lineage[k] = []
    return {
        "run": run,
        "specs": specs,
        "lineage": lineage,
        "derived": {
            "self_stale": any_stale_spec,
        },
    }


@router.get("/v1/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> dict[str, Any]:
    try:
        return await request.app.state.run_svc.get_run(run_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/v1/runs")
async def create_run(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    try:
        run = await request.app.state.run_svc.create_run(body)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    # Best-effort kick — engine-svc would pick it up within ~2s anyway via its
    # poll loop, but the kick removes that latency for interactive flows.
    try:
        await request.app.state.engine_svc.kick(run["id"])
    except Exception as exc:
        log.warning(
            "engine-svc kick failed for %s: %s (will rely on engine poll loop)",
            run.get("id"), exc,
        )
    return run


@router.delete("/v1/runs/{run_id}", status_code=204)
async def delete_run(request: Request, run_id: str) -> None:
    """Delete a single run + its artifacts. Idempotent: 404 if already gone."""
    try:
        await request.app.state.run_svc.delete_run(run_id)
    except Exception as exc:
        msg = str(exc)
        code = 404 if "404" in msg or "not found" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=msg) from exc


@router.post("/v1/runs/{run_id}/kick")
async def kick_run(request: Request, run_id: str) -> dict[str, Any]:
    try:
        return await request.app.state.engine_svc.kick(run_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/v1/runs/{run_id}/cancel")
async def cancel_run(request: Request, run_id: str) -> dict[str, Any]:
    """Cancel a queued or running Run. Run-svc flips status to 'cancelled'
    immediately; if it was running, BFF emits run.cancelled on bs.events so
    engine-svc workers signal their pipelines to bail at the next stage."""
    try:
        result = await request.app.state.run_svc.cancel_run(run_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if result.get("was_running"):
        await request.app.state.event_bus.publish({
            "kind": "run.cancelled", "run_id": run_id, "where": "user-cancel",
        })
    return result


@router.get("/v1/plans/{plan_id}")
async def get_plan(plan_id: str, request: Request) -> dict[str, Any]:
    try:
        return await request.app.state.run_svc.get_plan(plan_id)
    except Exception as exc:
        msg = str(exc)
        code = 404 if "404" in msg or "not found" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=msg) from exc


@router.post("/v1/plans")
async def create_plan(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return await request.app.state.run_svc.create_plan(body)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/v1/plans/{plan_id}/slots")
async def add_plan_slot(plan_id: str, request: Request, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return await request.app.state.run_svc.add_plan_slot(plan_id, body)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/v1/plans/{plan_id}/slots/{slot}")
async def remove_plan_slot(plan_id: str, slot: str, request: Request) -> dict[str, Any]:
    try:
        return await request.app.state.run_svc.remove_plan_slot(plan_id, slot)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
