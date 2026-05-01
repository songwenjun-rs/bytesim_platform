"""§6 Ingest service — accepts production snapshots, parses via adapter,
gates approval through data_steward.

Endpoints:
  GET  /healthz
  GET  /v1/adapters                     — list built-in adapters
  POST /v1/snapshots                    — multipart upload + adapter parse
  GET  /v1/snapshots                    — list (filter by status / project / kind)
  GET  /v1/snapshots/{id}
  POST /v1/snapshots/{id}/approve       — data_steward only (gated by caller; this svc trusts X-Actor-Role)
  POST /v1/snapshots/{id}/reject
  GET  /v1/snapshots/{id}/samples       — adapter-extracted rows for calibration consumer
  GET  /v1/snapshots/{id}/consumers     — blame trail
"""
from __future__ import annotations

import hashlib
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta, datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.adapters import ADAPTERS, AdapterResult
from app.store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("ingest-svc")

STORAGE_ROOT = Path(os.environ.get("INGEST_STORAGE_ROOT", "/tmp/bytesim-ingest"))
RETENTION_DAYS = int(os.environ.get("INGEST_RETENTION_DAYS", "90"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    app.state.store = Store()
    await app.state.store.open()
    # Cache extracted samples in memory keyed by snapshot_id (small, bounded by
    # snapshot count). Calibration consumer reads from here on demand.
    app.state.samples_cache: dict[str, AdapterResult] = {}
    try:
        yield
    finally:
        await app.state.store.close()


app = FastAPI(title="ByteSim Ingest", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ── Adapters ─────────────────────────────────────────────────────────

@app.get("/v1/adapters")
def list_adapters() -> list[dict[str, str]]:
    return [{"name": name} for name in ADAPTERS.keys()]


# ── Snapshots ────────────────────────────────────────────────────────

@app.post("/v1/snapshots")
async def upload_snapshot(
    request: Request,
    file: UploadFile = File(...),
    project_id: str = Form("p_default"),
    name: str = Form(...),
    source_kind: str = Form(...),
    source_adapter: str = Form(...),
    redaction_attest: str = Form("{}"),
    notes: str = Form(""),
    x_actor_id: str | None = Header(default=None, alias="X-Actor-Id"),
) -> dict[str, Any]:
    """Receive a file, run the adapter, persist metadata + raw bytes.
    Snapshot enters status=pending_review. Approval goes via /approve endpoint.
    """
    if source_adapter not in ADAPTERS:
        raise HTTPException(400, f"unknown adapter: {source_adapter}; known: {list(ADAPTERS)}")

    raw = await file.read()
    sha = hashlib.sha256(raw).hexdigest()

    # Parse via adapter (synchronously — small files in v1; larger files would
    # write-then-extract async).
    try:
        result: AdapterResult = ADAPTERS[source_adapter](raw)
    except Exception as exc:
        raise HTTPException(400, f"adapter '{source_adapter}' failed: {exc}") from exc

    snapshot_id = "snap-" + uuid.uuid4().hex[:8]

    # Write raw bytes to storage_uri (file:// for v1)
    target = STORAGE_ROOT / f"{snapshot_id}.bin"
    target.write_bytes(raw)
    storage_uri = f"file://{target}"

    try:
        redaction_dict = _safe_json(redaction_attest)
    except ValueError as exc:
        raise HTTPException(400, f"redaction_attest must be JSON: {exc}") from exc

    retention_until = datetime.now(timezone.utc) + timedelta(days=RETENTION_DAYS)

    snap = await app.state.store.insert_snapshot(
        snapshot_id=snapshot_id, project_id=project_id, name=name,
        source_kind=source_kind, source_adapter=source_adapter,
        storage_uri=storage_uri, sha256=sha,
        row_count=result.row_count, bytes_=len(raw),
        period_start=result.covers_period_start,
        period_end=result.covers_period_end,
        hardware_scope=result.hardware_scope,
        workload_scope=result.workload_scope,
        redaction=redaction_dict,
        imported_by=x_actor_id or "anonymous",
        retention_until=retention_until,
        notes=notes or None,
    )
    # Cache extracted samples for the lifetime of this process.
    request.app.state.samples_cache[snapshot_id] = result
    return snap


@app.get("/v1/snapshots")
async def list_snapshots(
    project_id: str | None = None, status: str | None = None,
    source_kind: str | None = None, limit: int = 50,
) -> list[dict[str, Any]]:
    return await app.state.store.list_snapshots(
        project_id=project_id, status=status, source_kind=source_kind, limit=limit,
    )


@app.get("/v1/snapshots/{snapshot_id}")
async def get_snapshot(snapshot_id: str) -> dict[str, Any]:
    snap = await app.state.store.get_snapshot(snapshot_id)
    if not snap:
        raise HTTPException(404, "snapshot not found")
    return snap


class ApproveRequest(BaseModel):
    """Approval body. Caller MUST be data_steward — that's enforced by BFF /
    auth middleware via X-Actor-Role; ingest-svc trusts the header."""
    actor_id: str = Field(min_length=1)


class RejectRequest(ApproveRequest):
    reason: str | None = None


def _require_data_steward(role: str | None) -> None:
    if role != "data_steward" and role != "admin":
        raise HTTPException(403, "data_steward role required to approve/reject snapshots")


@app.post("/v1/snapshots/{snapshot_id}/approve")
async def approve_snapshot(
    snapshot_id: str, body: ApproveRequest,
    x_actor_role: str | None = Header(default=None, alias="X-Actor-Role"),
) -> dict[str, Any]:
    _require_data_steward(x_actor_role)
    ok = await app.state.store.approve(snapshot_id, body.actor_id)
    if not ok:
        raise HTTPException(409, "snapshot not in pending_review state")
    return await app.state.store.get_snapshot(snapshot_id)


@app.post("/v1/snapshots/{snapshot_id}/reject")
async def reject_snapshot(
    snapshot_id: str, body: RejectRequest,
    x_actor_role: str | None = Header(default=None, alias="X-Actor-Role"),
) -> dict[str, Any]:
    _require_data_steward(x_actor_role)
    ok = await app.state.store.reject(snapshot_id, body.actor_id, body.reason)
    if not ok:
        raise HTTPException(409, "snapshot not in pending_review state")
    return await app.state.store.get_snapshot(snapshot_id)


@app.get("/v1/snapshots/{snapshot_id}/samples")
async def get_snapshot_samples(snapshot_id: str, request: Request) -> dict[str, Any]:
    """Read-only access to the adapter-extracted samples for this snapshot.
    Calibration consumer fetches this; only approved snapshots are served."""
    snap = await app.state.store.get_snapshot(snapshot_id)
    if not snap:
        raise HTTPException(404, "snapshot not found")
    if snap["status"] != "approved":
        raise HTTPException(409, f"snapshot not approved (status={snap['status']})")

    cached: AdapterResult | None = request.app.state.samples_cache.get(snapshot_id)
    if cached is None:
        # Cache miss: re-run adapter on the stored bytes.
        path = snap["storage_uri"].removeprefix("file://")
        try:
            raw = Path(path).read_bytes()
        except OSError as exc:
            raise HTTPException(500, f"cannot re-read snapshot bytes: {exc}") from exc
        cached = ADAPTERS[snap["source_adapter"]](raw)
        request.app.state.samples_cache[snapshot_id] = cached

    return {
        "snapshot_id": snapshot_id,
        "row_count": cached.row_count,
        "samples": [
            {"ts": s.ts.isoformat(), "gpu_model": s.gpu_model,
             "model_family": s.model_family, "measured": s.measured,
             "inputs": s.inputs}
            for s in cached.samples
        ],
        "hardware_scope": cached.hardware_scope,
        "workload_scope": cached.workload_scope,
    }


@app.get("/v1/snapshots/{snapshot_id}/consumers")
async def list_consumers(snapshot_id: str) -> list[dict[str, Any]]:
    return await app.state.store.list_consumers(snapshot_id)


@app.post("/v1/snapshots/{snapshot_id}/consumers")
async def record_consumer(snapshot_id: str, body: dict[str, Any]) -> dict[str, str]:
    """Internal: callers (calibration-svc, etc.) record their consumption here
    when they actually use a snapshot's data."""
    if "consumer_kind" not in body or "consumer_id" not in body:
        raise HTTPException(400, "consumer_kind and consumer_id required")
    snap = await app.state.store.get_snapshot(snapshot_id)
    if not snap:
        raise HTTPException(404, "snapshot not found")
    await app.state.store.record_consumer(
        snapshot_id, body["consumer_kind"], body["consumer_id"],
    )
    return {"recorded": "ok"}


def _safe_json(s: str) -> dict[str, Any]:
    import json as _json
    try:
        v = _json.loads(s)
    except _json.JSONDecodeError as exc:
        raise ValueError(str(exc))
    if not isinstance(v, dict):
        raise ValueError("must be a JSON object")
    return v
