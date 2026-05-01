"""§5 Technical TCO Engine — FastAPI service.

Two endpoints:
* POST /v1/tco/compute  — compute breakdown given a "run shape" + persist
* GET  /v1/tco/runs/{run_id} — fetch persisted breakdown
* GET  /v1/tco/rules — list active TCO rules (for transparency)

Integration: engine-svc calls /v1/tco/compute at the end of its 5-stage
pipeline; BFF exposes a passthrough at /v1/runs/{id}/tco for the UI.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.compute import (
    FailurePenalty,
    GpuConsumption,
    StorageConsumption,
    TcoInputs,
    compute_sensitivities,
    compute_tco,
)
from app.store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("tco-engine")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = Store()
    await app.state.store.open()
    try:
        yield
    finally:
        await app.state.store.close()


app = FastAPI(title="ByteSim TCO Engine", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ── Request schema (kept close to compute.TcoInputs but JSON-friendly) ──

class GpuLine(BaseModel):
    vendor_sku: str                     # used to look up bs_tco_rule
    count: int = Field(ge=1)
    utilization: float = Field(ge=0.0, le=1.0)


class StorageLine(BaseModel):
    tier: Literal["hot", "warm", "cold"]
    gb: float = Field(ge=0)


class FailureModel(BaseModel):
    expected_restart_fraction: float = Field(ge=0, le=1)
    extra_wall_clock_h: float = Field(ge=0)


class ComputeRequest(BaseModel):
    run_id: str
    wall_clock_s: float = Field(gt=0)
    workload_mode: Literal["training", "inference"]
    gpus: list[GpuLine]
    storage: list[StorageLine] = []
    network_opex_usd_estimate: float = 0.0
    failure: FailureModel | None = None
    tokens_processed: float = 0.0
    inference_requests: float = 0.0
    persist: bool = True
    include_sensitivities: bool = True


class CompareRequest(BaseModel):
    """Two designs, same TCO ruleset → ΔTCO breakdown."""
    a: ComputeRequest
    b: ComputeRequest


# Resource_kind hint per storage tier
_STORAGE_TIER_TO_KIND = {
    "hot": ("storage", "Generic/NVMe-TLC"),
    "warm": ("storage", "Generic/S3-Compatible"),
    "cold": ("storage", "Generic/S3-Compatible"),
}


async def _resolve_inputs(req: ComputeRequest, store: Store) -> TcoInputs:
    gpus: list[GpuConsumption] = []
    for line in req.gpus:
        rule = await store.find_rule("gpu", line.vendor_sku)
        if rule is None:
            raise HTTPException(status_code=400, detail=f"no TCO rule for gpu/{line.vendor_sku}")
        gpus.append(GpuConsumption(
            rule_id=rule["id"],
            capex_usd=float(rule["capex_usd"] or 0),
            power_w_load=int(rule["power_w_load"] or 0),
            power_w_idle=int(rule["power_w_idle"] or 0),
            pue=float(rule["pue_assumed"] or 1.20),
            electricity_usd_per_kwh=float(rule["electricity_usd_per_kwh"]),
            count=line.count,
            utilization=line.utilization,
            amortization_y=int(rule["amortization_y"]),
        ))

    storage: list[StorageConsumption] = []
    months = req.wall_clock_s / (3600 * 730)  # 730h ≈ 1 month
    for s in req.storage:
        kind, sku = _STORAGE_TIER_TO_KIND[s.tier]
        rule = await store.find_rule(kind, sku)
        if rule is None or rule["storage_usd_per_gb_month"] is None:
            raise HTTPException(status_code=400, detail=f"no storage rule for tier={s.tier}")
        storage.append(StorageConsumption(
            rule_id=rule["id"],
            usd_per_gb_month=float(rule["storage_usd_per_gb_month"]),
            gb=s.gb,
            months=months,
        ))

    failure = None
    if req.failure is not None:
        # estimate gpu_hour_usd from the first gpu rule for failure-penalty pricing
        if gpus:
            g = gpus[0]
            est_total = (g.capex_usd / (g.amortization_y * 24 * 365)
                         + (g.power_w_load / 1000) * g.pue * g.electricity_usd_per_kwh)
            failure = FailurePenalty(
                expected_restart_fraction=req.failure.expected_restart_fraction,
                extra_wall_clock_h=req.failure.extra_wall_clock_h,
                gpu_hour_usd=est_total,
            )

    return TcoInputs(
        run_id=req.run_id,
        wall_clock_s=req.wall_clock_s,
        workload_mode=req.workload_mode,
        gpus=gpus,
        storage=storage,
        network_opex_usd_estimate=req.network_opex_usd_estimate,
        failure=failure,
        tokens_processed=req.tokens_processed,
        inference_requests=req.inference_requests,
    )


@app.post("/v1/tco/compute")
async def post_compute(req: ComputeRequest) -> dict[str, Any]:
    store: Store = app.state.store
    inputs = await _resolve_inputs(req, store)
    breakdown = compute_tco(inputs)
    if req.include_sensitivities:
        breakdown.sensitivities = compute_sensitivities(inputs)
    body = breakdown.as_dict()
    if req.persist:
        await store.upsert_breakdown(req.run_id, body)
    return body


@app.get("/v1/tco/runs/{run_id}")
async def get_breakdown(run_id: str) -> dict[str, Any]:
    out = await app.state.store.get_breakdown(run_id)
    if out is None:
        raise HTTPException(status_code=404, detail="no TCO breakdown for run")
    return out


@app.get("/v1/tco/rules")
async def list_rules(resource_kind: str | None = None) -> list[dict[str, Any]]:
    rules = await app.state.store.list_rules(resource_kind)
    # Normalize Decimal → float for JSON, drop noise columns
    out = []
    for r in rules:
        rec = {}
        for k, v in r.items():
            if hasattr(v, "isoformat"):
                rec[k] = v.isoformat()
            elif hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                rec[k] = float(v)
            else:
                rec[k] = v
        out.append(rec)
    return out


@app.post("/v1/tco/compare")
async def post_compare(req: CompareRequest) -> dict[str, Any]:
    """Two designs, same ruleset → ΔTCO breakdown for design exploration."""
    store: Store = app.state.store
    a_in = await _resolve_inputs(req.a, store)
    b_in = await _resolve_inputs(req.b, store)
    a = compute_tco(a_in).as_dict()
    b = compute_tco(b_in).as_dict()

    # Refuse to compare if rule_versions differ — would be apples-to-oranges
    if a["rule_versions"] != b["rule_versions"]:
        raise HTTPException(
            status_code=400,
            detail=f"rule_versions differ between A and B; switch to same ruleset to compare.",
        )

    delta = {}
    for k in ("hw_capex_amortized_usd", "power_opex_usd", "cooling_opex_usd",
              "network_opex_usd", "storage_opex_usd", "failure_penalty_usd",
              "total_usd", "per_m_token_usd", "per_gpu_hour_usd",
              "per_inference_request_usd"):
        av, bv = a.get(k), b.get(k)
        if av is None or bv is None:
            delta[k] = None
        else:
            delta[k] = round(bv - av, 4)
    return {"a": a, "b": b, "delta_b_minus_a": delta}
