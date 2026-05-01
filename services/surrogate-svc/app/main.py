"""ByteSim surrogate-analytical engine — RFC-001 v2 adapter (M2 cutover).

Receives `EnginePredictRequest` from engine_contracts, drives the existing
analytical math in app.predict (untouched), translates the result into an
`EnginePredictResponse` with the required `breakdown`, and self-registers
with engine-registry on boot via shared.engine_runtime.

The analytical surrogate doesn't measure compute/comm/mem_stall directly,
so the breakdown is an educated synthesis from the same drag terms that
drive `mfu_pct` (overlap_drag → comm_ms; recompute_drag → mem_stall_ms;
PP bubble → idle_ms). It's contract-compliant; engines like astra-sim
(once chakra writer lands) will report measured values.
"""
from __future__ import annotations

import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from engine_contracts import (
    BottleneckAttribution,
    Cluster as _CCluster,
    CoverageEnvelope,
    EnginePredictRequest,
    EnginePredictResponse,
    HardwareScope,
    KPIBreakdown,
    LinkAttribution,
    NodeAttribution,
    ParallelismRange,
    PhaseBreakdownEntry,
    StrategyParams as _CStrategyParams,
    Workload as _CWorkload,
)
from engine_runtime import (
    EngineDescriptor,
    ExpectedKPIRange,
    SmokeCase,
    mount_engine_runtime,
)

from app.predict import (
    Cluster as _Cluster,
    PredictRequest as _PredictRequest,
    StrategyParams as _StrategyParams,
    Workload as _Workload,
    predict as _predict,
)


app = FastAPI(title="ByteSim Surrogate", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ── Adapter: contract → internal types → contract ────────────────────────


def _to_internal(req: EnginePredictRequest) -> _PredictRequest:
    """Translate the v2 contract into the surrogate's existing internal shape.
    The surrogate doesn't model `workload_family` (it's analytically the same
    for dense vs MoE — only `activated_params_b` matters), so we drop it here
    after the registry has gated coverage."""
    return _PredictRequest(
        cluster=_Cluster(
            gpu_model=req.cluster.gpu_model,
            gpu_count=req.cluster.gpu_count,
            electricity_usd_per_kwh=req.cluster.electricity_usd_per_kwh,
            pue=req.cluster.pue,
            fabric_topology=(
                [link.model_dump() for link in req.cluster.fabric_topology]  # type: ignore[misc]
                if req.cluster.fabric_topology else None
            ),
        ),
        workload=_Workload(
            mode=req.workload.mode,
            seq_len=req.workload.seq_len,
            global_batch=req.workload.global_batch,
            activated_params_b=req.workload.activated_params_b,
            total_params_b=req.workload.total_params_b,
            quant=req.workload.quant,
            kvcache_config=req.workload.kvcache_config.model_dump()  # type: ignore[arg-type]
                if req.workload.kvcache_config else None,
        ),
        strategy=_StrategyParams(
            TP=req.strategy.TP, PP=req.strategy.PP,
            EP=req.strategy.EP, CP=req.strategy.CP,
            recompute=req.strategy.recompute if req.strategy.recompute != "none" else "selective",
            overlap=req.strategy.overlap,
        ),
    )


def _synthesize_breakdown(step_ms: float, mfu_pct: float, PP: int) -> KPIBreakdown:
    """Educated breakdown for an analytical engine. Fractions roughly mirror
    the drag terms in app.predict.predict (§overlap, §recompute, §bubble),
    so calling the same engine twice with different PP gives a different idle
    component — useful for shadow-engine Δ comparisons even before astra-sim
    reports measured numbers."""
    # PP bubble grows with PP, capped at 12% so a degenerate PP=64 doesn't
    # eat the entire budget here.
    idle_frac = min(0.12, max(0.0, (PP - 1) * 0.006))
    # Useful work scales with achieved MFU vs ceiling (~60% for B200 FP8).
    compute_frac = max(0.0, mfu_pct / 100.0)
    # Communication: whatever's left after compute + idle, capped to a
    # plausible share so mem_stall isn't zero.
    remaining = max(0.0, 1.0 - compute_frac - idle_frac)
    comm_frac = remaining * 0.7
    mem_stall_frac = remaining * 0.3
    return KPIBreakdown(
        compute_ms=round(step_ms * compute_frac, 3),
        comm_ms=round(step_ms * comm_frac, 3),
        mem_stall_ms=round(step_ms * mem_stall_frac, 3),
        idle_ms=round(step_ms * idle_frac, 3),
    )


def _severity_from_util(util_pct: float) -> str:
    # UI-visible thresholds. 75/90 mirror the operator rule-of-thumb the
    # `notes` text uses ("接近饱和 ≥ 90%"). Keep in sync.
    if util_pct >= 90:
        return "high"
    if util_pct >= 75:
        return "med"
    return "low"


def _synthesize_attribution(
    raw: object, req: EnginePredictRequest,
) -> tuple[BottleneckAttribution | None, list[PhaseBreakdownEntry] | None]:
    """Wrap the surrogate's existing P-Domain-2 link-util heuristic and the
    KV pressure signals into the visualization-grade attribution schema.

    Heuristic priority for `primary` — first match wins:
      1. KV spill (pressure > 100 ⇒ working set exceeds HBM)
      2. Saturated link (top util ≥ 90)
      3. PP bubble (PP > 1 and idle dominates)
      4. Compute-bound (default when none of the above)

    The surrogate doesn't compute per-link `contributes_ms`, so we leave it
    None — UI renders "util only" without a time-share label."""
    links_raw = getattr(raw, "link_util_top", None) or []
    pressure = getattr(raw, "cache_pressure_pct", None)
    spill = getattr(raw, "spill_bytes_per_s", None)

    link_attrs = [
        LinkAttribution(
            id=row["link_id"],
            fabric=row["fabric"],
            util_pct=float(row["util_pct"]),
            severity=_severity_from_util(float(row["util_pct"])),  # type: ignore[arg-type]
        )
        for row in links_raw
    ]

    primary: str
    severity: str
    headline: str
    suggested: str | None
    nodes: list[NodeAttribution] = []

    if pressure is not None and pressure > 100:
        primary = "kv_spill"
        severity = "high"
        spill_gb_s = (spill or 0) / 1e9
        headline = f"KV 工作集 {pressure:.0f}% 超出 HBM，溢出 {spill_gb_s:.1f} GB/s"
        suggested = "↓avg_active_seqs 或 ↑prefix_share_ratio"
        # Attribute to a synthetic "all GPUs" node — the surrogate is not
        # per-GPU, so we report cluster-wide. Engines with per-GPU
        # resolution (astra-sim) will fill real ids.
        nodes.append(NodeAttribution(
            id="cluster",
            issue="kv_spill",
            severity="high",
            metrics={"pressure_pct": round(pressure, 1)},
        ))
    elif link_attrs and link_attrs[0].util_pct >= 90:
        hot = link_attrs[0]
        primary = (
            "nvlink" if hot.fabric == "nvlink"
            else "leaf_spine" if hot.fabric in ("infiniband", "roce")
            else hot.fabric  # pcie / cxl / ethernet
        )
        severity = "high"
        headline = f"{hot.fabric} 链路 {hot.id} 利用率 {hot.util_pct:.0f}% — 接近饱和"
        suggested = (
            "TP↓ 或换 NVLink 域更大的 GPU" if hot.fabric == "nvlink"
            else "EP↓ 或拓扑下沉到单 pod"
        )
    elif req.strategy.PP > 1:
        # Bubble vs compute heuristic: idle_ms / step_ms ≥ 5% ⇒ pp_bubble
        idle_ms = getattr(raw, "step_ms", 1.0) * min(0.12, max(0.0, (req.strategy.PP - 1) * 0.006))  # type: ignore[attr-defined]
        if idle_ms / max(getattr(raw, "step_ms", 1.0), 1e-3) >= 0.05:  # type: ignore[attr-defined]
            primary = "pp_bubble"
            severity = "med"
            headline = f"PP={req.strategy.PP} 流水气泡占 step time {idle_ms / getattr(raw, 'step_ms', 1.0) * 100:.0f}%"  # type: ignore[attr-defined]
            suggested = "PP↓ 或换 ZB 类 overlap"
        else:
            primary = "compute"
            severity = "low"
            headline = f"以计算为主，MFU {getattr(raw, 'mfu_pct', 0):.0f}%"  # type: ignore[attr-defined]
            suggested = None
    else:
        primary = "compute"
        severity = "low"
        headline = f"以计算为主，MFU {getattr(raw, 'mfu_pct', 0):.0f}%"  # type: ignore[attr-defined]
        suggested = None

    bottleneck = BottleneckAttribution(
        primary=primary,                                            # type: ignore[arg-type]
        severity=severity,                                          # type: ignore[arg-type]
        headline=headline,
        suggested_action=suggested,
        links=link_attrs,
        nodes=nodes,
    )

    # Phase breakdown: the surrogate's KPIBreakdown already gives us 4 buckets;
    # we surface the same numbers in the finer-grained list shape so the UI
    # stacked-bar component has a single source. Engines with real per-phase
    # traces will populate this with attn / ffn / comm_tp etc.
    bd = _synthesize_breakdown(
        getattr(raw, "step_ms"), getattr(raw, "mfu_pct"), req.strategy.PP,
    )
    phase_breakdown = [
        PhaseBreakdownEntry(phase="compute", ms=bd.compute_ms),
        PhaseBreakdownEntry(phase="comm", ms=bd.comm_ms),
        PhaseBreakdownEntry(phase="mem_stall", ms=bd.mem_stall_ms),
        PhaseBreakdownEntry(phase="idle", ms=bd.idle_ms),
    ]

    return bottleneck, phase_breakdown


def _from_internal(req: EnginePredictRequest, raw: object) -> EnginePredictResponse:
    # raw is a PredictResponse pydantic model; access by attribute.
    bottleneck, phase_breakdown = _synthesize_attribution(raw, req)
    return EnginePredictResponse(
        mfu_pct=raw.mfu_pct,                                      # type: ignore[attr-defined]
        step_ms=raw.step_ms,                                      # type: ignore[attr-defined]
        breakdown=_synthesize_breakdown(
            raw.step_ms, raw.mfu_pct, req.strategy.PP,            # type: ignore[attr-defined]
        ),
        peak_kw=raw.peak_kw,                                      # type: ignore[attr-defined]
        confidence=raw.confidence,                                # type: ignore[attr-defined]
        # `feasible` (physical-constraint violation, e.g. peak_kw > rack limit)
        # is orthogonal to `coverage_status` (engine ran outside its training
        # distribution). The surrogate is in-distribution for everything in
        # its envelope; physical infeasibility is a result, not a coverage
        # condition. Keep them independent so the tuner can distinguish
        # "engine extrapolated" from "design failed power budget".
        feasible=raw.feasible,                                    # type: ignore[attr-defined]
        coverage_status="in_dist",
        ttft_ms=raw.ttft_ms if req.workload.mode == "inference" else None,           # type: ignore[attr-defined]
        tpot_ms=raw.tpot_ms if req.workload.mode == "inference" else None,           # type: ignore[attr-defined]
        kv_hit_rate=raw.kv_hit_rate,                              # type: ignore[attr-defined]
        cache_pressure_pct=raw.cache_pressure_pct,                # type: ignore[attr-defined]
        spill_bytes_per_s=raw.spill_bytes_per_s,                  # type: ignore[attr-defined]
        link_util_top=raw.link_util_top,                          # type: ignore[attr-defined]
        bottleneck=bottleneck,
        phase_breakdown=phase_breakdown,
        notes=list(raw.notes or []),                              # type: ignore[attr-defined]
    )


def _engine_predict(req: EnginePredictRequest) -> EnginePredictResponse:
    return _from_internal(req, _predict(_to_internal(req)))


# ── Self-registration via engine_runtime ─────────────────────────────────

DESCRIPTOR = EngineDescriptor(
    name="surrogate-analytical",
    version="0.2.0",
    fidelity="analytical",
    sla_p99_ms=100,
    endpoint="http://surrogate-svc:8083",
    coverage_envelope=CoverageEnvelope(
        # RFC §4.2 — wide envelope; surrogate is the platform's general-purpose
        # analytical engine and intentionally has very few coverage gaps.
        workload_families=["transformer-dense", "transformer-moe"],
        parallelism=ParallelismRange(
            TP=(1, 64), PP=(1, 64), EP=(1, 64), CP=(1, 8),
            recompute=["selective", "full"],
            overlap=["1F1B", "ZB", "ZBv2", "ring_compress", "Chimera"],
        ),
        hardware=HardwareScope(
            gpu_models=["B200", "H200", "GB300", "MI355X", "H100", "NPU-910"],
            fabric=["nvlink", "infiniband", "roce"],
            scale_gpus=(8, 8192),
        ),
        quant=["BF16", "FP8"],
        modes=["training", "inference"],
    ),
    kpi_outputs=[
        "mfu_pct", "step_ms", "breakdown", "peak_kw", "confidence",
        "ttft_ms", "tpot_ms", "kv_hit_rate", "cache_pressure_pct",
        "spill_bytes_per_s", "link_util_top",
    ],
    notes="Analytical surrogate; bootstrap reference engine.",
    # RFC-002 smoke matrix — corner cases that should always produce sane KPIs.
    # Bounds are deliberately loose to catch only flagrant regressions
    # (e.g. MFU jumping >70% or step_ms going negative); calibration RFC-004
    # tightens them with measured MAPE.
    smoke_matrix=[
        SmokeCase(
            label="dense.B200.1024.TP8PP8.training.FP8",
            req=EnginePredictRequest(
                cluster=_CCluster(gpu_model="B200", gpu_count=1024),
                workload=_CWorkload(
                    workload_family="transformer-dense", mode="training",
                    quant="FP8", seq_len=8192, global_batch=4096,
                    activated_params_b=70, total_params_b=70,
                ),
                strategy=_CStrategyParams(TP=8, PP=8, EP=1, CP=2,
                                            recompute="selective", overlap="ZBv2"),
            ),
            expected=ExpectedKPIRange(
                mfu_pct=(20.0, 65.0), step_ms=(50.0, 60_000.0),
            ),
        ),
        SmokeCase(
            label="moe.H200.32.TP8EP4.inference.FP8",
            req=EnginePredictRequest(
                cluster=_CCluster(gpu_model="H200", gpu_count=32),
                workload=_CWorkload(
                    workload_family="transformer-moe", mode="inference",
                    quant="FP8", seq_len=8192, global_batch=256,
                    activated_params_b=37, total_params_b=671,
                ),
                strategy=_CStrategyParams(TP=8, PP=1, EP=4, CP=1,
                                            recompute="selective", overlap="ZBv2"),
            ),
            expected=ExpectedKPIRange(
                mfu_pct=(10.0, 65.0), step_ms=(1.0, 10_000.0),
                ttft_ms=(50.0, 1_000.0), tpot_ms=(1.0, 200.0),
            ),
        ),
        SmokeCase(
            label="dense.H100.64.TP4PP2.training.BF16",
            req=EnginePredictRequest(
                cluster=_CCluster(gpu_model="H100", gpu_count=64),
                workload=_CWorkload(
                    workload_family="transformer-dense", mode="training",
                    quant="BF16", seq_len=4096, global_batch=512,
                    activated_params_b=8, total_params_b=8,
                ),
                strategy=_CStrategyParams(TP=4, PP=2, EP=1, CP=1,
                                            recompute="full", overlap="1F1B"),
            ),
            expected=ExpectedKPIRange(mfu_pct=(15.0, 60.0), step_ms=(10.0, 60_000.0)),
        ),
    ],
)

mount_engine_runtime(app, DESCRIPTOR, _engine_predict)


# ── Legacy /v1/predict/timed kept (used by /v1/engines/predict tests) ────


@app.post("/v1/predict/timed")
def post_predict_timed(req: EnginePredictRequest) -> dict:
    """Same as /v1/predict but reports the wall-clock so callers can verify
    the < 100ms SLO without their own timing harness."""
    t0 = time.perf_counter()
    out = _engine_predict(req)
    return {"prediction": out.model_dump(), "latency_ms": round((time.perf_counter() - t0) * 1000, 3)}
