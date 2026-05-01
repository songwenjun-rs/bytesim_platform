"""ByteSim astra-sim wrapper service — RFC-001 v2 adapter (M2 cutover).

Receives `EnginePredictRequest` from engine_contracts, drives the existing
subprocess wrapper (translator.py + wrapper.py — untouched), and self-
registers with engine-registry on boot via shared.engine_runtime with the
*honest narrow envelope* from RFC §4.2.

The honest envelope intentionally rejects most platform requests today:
the bundled chakra microbench traces only cover 4-16 NPUs / dense /
TP-only / single-PP / 1MB AllReduce. RFC-003 (chakra writer) is the
follow-up that actually generates ET traces from arbitrary
(model × strategy) tuples; until then astra-sim is a contract-test
counterpart, not a daily-driver engine.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from engine_contracts import (
    Cluster as _CCluster,
    CoverageEnvelope,
    EnginePredictRequest,
    EnginePredictResponse,
    HardwareScope,
    KPIBreakdown,
    ParallelismRange,
    StrategyParams as _CStrategyParams,
    Workload as _CWorkload,
)
from engine_runtime import (
    EngineDescriptor,
    ExpectedKPIRange,
    SmokeCase,
    mount_engine_runtime,
)

from app.chakra_writer import TraceSpec
from app.translator import TranslationError
from app.wrapper import predict_chakra

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("astra-sim-svc")


app = FastAPI(title="ByteSim astra-sim wrapper", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ── Adapter: contract → astra-sim subprocess input ──────────────────────


def _to_trace_spec(req: EnginePredictRequest) -> TraceSpec:
    """Translate a v2 EnginePredictRequest into the chakra writer's TraceSpec.
    Coverage gating already happened in the registry — assume the envelope
    accepted these values."""
    return TraceSpec(
        gpu_model=req.cluster.gpu_model,
        gpu_count=req.cluster.gpu_count,
        activated_params_b=req.workload.activated_params_b,
        seq_len=req.workload.seq_len,
        global_batch=req.workload.global_batch,
        quant=req.workload.quant,
        TP=req.strategy.TP,
        PP=req.strategy.PP,
    )


def _to_fabric_cfg(req: EnginePredictRequest) -> dict:
    """Pick a single network dimension for astra-sim. Multi-dim mapping is a
    follow-up; today nvlink → Ring, infiniband → Switch."""
    fabric_kind = "infiniband"
    bw_gbps = 50.0
    if req.cluster.fabric_topology:
        for link in req.cluster.fabric_topology:
            if link.fabric == "nvlink":
                fabric_kind = "nvlink"
                bw_gbps = link.bw_gbps
                break
        else:
            link0 = req.cluster.fabric_topology[0]
            fabric_kind = link0.fabric
            bw_gbps = link0.bw_gbps
    topology = "Ring" if fabric_kind == "nvlink" else "Switch"
    return {"topology": topology, "bandwidth_gbps": bw_gbps, "latency_ns": 500.0}


def _from_chakra_metrics(req: EnginePredictRequest, metrics: dict) -> EnginePredictResponse:
    """astra-sim's parsed output gives total wall_time + comm_time. Wall
    minus comm is approximate compute (event-driven sim assigns the rest to
    compute nodes). step_ms = wall_time ÷ trace_steps (one step today)."""
    wall_ms = max(0.001, float(metrics.get("collective_time_ms", 0.0)))
    comm_ms = max(0.0, float(metrics.get("comm_time_ms", 0.0)))
    compute_ms = max(0.001, wall_ms - comm_ms)
    mfu_pct = round(min(70.0, 100.0 * compute_ms / wall_ms * 0.6), 2)

    return EnginePredictResponse(
        mfu_pct=mfu_pct,
        step_ms=round(wall_ms, 3),
        breakdown=KPIBreakdown(
            compute_ms=round(compute_ms, 3),
            comm_ms=round(comm_ms, 3),
            mem_stall_ms=0.0,
            idle_ms=0.0,
        ),
        peak_kw=req.cluster.gpu_count * 1.0,
        confidence=float(metrics.get("confidence", 0.85)),
        coverage_status="in_dist",
        notes=[
            f"astra-sim chakra trace · world_size={metrics.get('world_size')}",
            f"trace_prefix={metrics.get('trace_prefix')}",
        ],
    )


async def _engine_predict(req: EnginePredictRequest) -> EnginePredictResponse:
    """Async predict — calls into the now-async predict_chakra which uses
    `asyncio.create_subprocess_exec` for the astra-sim binary. The event loop
    stays responsive while the subprocess runs (heartbeat task keeps firing).
    No internal timeout: cancellation propagates from the upstream HTTP client
    (engine-svc httpx 180s) through CancelledError, and predict_chakra
    SIGTERM/SIGKILLs the subprocess before re-raising."""
    try:
        spec = _to_trace_spec(req)
        metrics = await predict_chakra(spec, _to_fabric_cfg(req))
    except TranslationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return _from_chakra_metrics(req, metrics)


# ── Self-registration via engine_runtime ─────────────────────────────────

DESCRIPTOR = EngineDescriptor(
    name="astra-sim",
    version="2.1.0-analytical",
    fidelity="cycle-accurate",
    sla_p99_ms=5000,
    endpoint="http://astra-sim-svc:8092",
    coverage_envelope=CoverageEnvelope(
        # RFC-003 — chakra writer expanded the envelope from "bundled microbench"
        # to "any transformer-dense step that fits TP × PP × DP layout the
        # writer emits". Keeps EP/CP at 1 (writer doesn't model them yet);
        # MoE waits on a follow-up RFC for chakra MoE comm patterns.
        workload_families=["transformer-dense"],
        parallelism=ParallelismRange(
            TP=(1, 16), PP=(1, 8), EP=(1, 1), CP=(1, 1),
            recompute=["selective"],
            overlap=["1F1B"],
        ),
        hardware=HardwareScope(
            gpu_models=["B200", "H200", "GB300", "H100"],
            fabric=["nvlink", "infiniband", "roce"],
            scale_gpus=(8, 1024),
        ),
        quant=["BF16", "FP8"],
        modes=["training"],
    ),
    kpi_outputs=["mfu_pct", "step_ms", "breakdown", "peak_kw", "confidence"],
    notes="astra-sim analytical (submodule at engine/astra-sim) + RFC-003 chakra "
          "writer. Generates one optimisation step of TP/PP/DP comm graph; MoE/CP "
          "deferred. Trace cache at $ASTRASIM_CHAKRA_CACHE.",
    # RFC-002 smoke matrix — small dense traces with widely-spaced parallel
    # configs. Bounds are loose (analytical roofline floor + a generous
    # ceiling) since real astra-sim numbers depend on the full network sim.
    smoke_matrix=[
        SmokeCase(
            label="dense.H200.8.TP8.training",
            req=EnginePredictRequest(
                cluster=_CCluster(gpu_model="H200", gpu_count=8),
                workload=_CWorkload(
                    workload_family="transformer-dense", mode="training",
                    quant="FP8", seq_len=2048, global_batch=64,
                    activated_params_b=8, total_params_b=8,
                ),
                strategy=_CStrategyParams(TP=8, PP=1, EP=1, CP=1,
                                            recompute="selective", overlap="1F1B"),
            ),
            expected=ExpectedKPIRange(mfu_pct=(5.0, 70.0), step_ms=(0.1, 60_000.0)),
        ),
        SmokeCase(
            label="dense.B200.32.TP4PP4.training",
            req=EnginePredictRequest(
                cluster=_CCluster(gpu_model="B200", gpu_count=32),
                workload=_CWorkload(
                    workload_family="transformer-dense", mode="training",
                    quant="FP8", seq_len=4096, global_batch=128,
                    activated_params_b=8, total_params_b=8,
                ),
                strategy=_CStrategyParams(TP=4, PP=4, EP=1, CP=1,
                                            recompute="selective", overlap="1F1B"),
            ),
            expected=ExpectedKPIRange(mfu_pct=(5.0, 70.0), step_ms=(0.1, 60_000.0)),
        ),
    ],
)

mount_engine_runtime(app, DESCRIPTOR, _engine_predict)
