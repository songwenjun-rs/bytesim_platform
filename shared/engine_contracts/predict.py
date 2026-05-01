"""EnginePredictRequest / EnginePredictResponse (RFC-001 §2.4).

The single end-to-end contract every ByteSim engine implements. There are no
per-domain variants — RFC-001 §1.1 restricts the platform to engines that
take a complete spec and return a complete KPI envelope.

These types are nearly the existing surrogate-svc shapes, lifted into a shared
package so registry, engines and tests all reference the same definition. The
old `services/surrogate-svc/app/predict.py` types stay in place during M1-M2;
M3 swaps them for re-imports from this package.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .envelope import FabricKind, GpuModel, Mode, Quant


Fidelity = Literal["analytical", "hybrid", "cycle-accurate"]


# ── Request ───────────────────────────────────────────────────────────────


class StrategyParams(BaseModel):
    TP: int = Field(ge=1, le=64)
    PP: int = Field(ge=1, le=64)
    EP: int = Field(ge=1, le=64)
    CP: int = Field(ge=1, le=8, default=1)
    recompute: Literal["selective", "full", "none"] = "selective"
    overlap: str = "ZBv2"  # engine-specific token; envelope.parallelism.overlap gates it


class KVCacheConfig(BaseModel):
    """Inference KV-cache hints. Engines that don't model KV may ignore this
    field; engines that do declare `kv_hit_rate` etc. in their `kpi_outputs`."""

    kv_size_gb_per_seq: float = 0.020
    prefix_share_ratio: float = 0.0
    page_size_kb: int = 16
    avg_active_seqs: int = 256


class Workload(BaseModel):
    mode: Mode = "training"
    workload_family: Literal[
        "transformer-dense", "transformer-moe", "dlrm", "dit", "rnn", "ssm"
    ] = "transformer-dense"
    seq_len: int = 8192
    global_batch: int = 4096
    activated_params_b: float = 8.0
    total_params_b: float = 512.0
    quant: Quant = "FP8"
    kvcache_config: KVCacheConfig | None = None


class FabricLink(BaseModel):
    """A single edge in the fabric topology snapshot. Engines that opt in to
    fabric-awareness consume this list and report per-link utilisation."""

    id: str
    src_id: str
    dst_id: str
    fabric: FabricKind
    bw_gbps: float


class Cluster(BaseModel):
    gpu_model: GpuModel = "B200"
    gpu_count: int = Field(default=1024, ge=1)
    electricity_usd_per_kwh: float = 0.092
    pue: float = 1.18
    fabric_topology: list[FabricLink] | None = None


class RuntimeKnobs(BaseModel):
    """Optional per-call knobs. Engines may ignore unknown keys."""

    trace_seconds: float | None = None
    warmup_steps: int | None = None
    seed: int | None = None
    extras: dict[str, Any] = Field(default_factory=dict)


class EnginePredictRequest(BaseModel):
    cluster: Cluster
    workload: Workload
    strategy: StrategyParams
    runtime: RuntimeKnobs | None = None


# ── Response ──────────────────────────────────────────────────────────────


class KPIBreakdown(BaseModel):
    """Strong contract: every engine reports time spent in each phase. Sum may
    differ from `step_ms` by a small idle component the engine couldn't
    classify — that's fine, but compute / comm / mem_stall must be present.

    Why required: shadow-engine confidence-band comparison (RFC-001 §2.7) needs
    at least one common KPI surface, and "compute_ms" is the most universal."""

    compute_ms: float = Field(ge=0)
    comm_ms: float = Field(ge=0)
    mem_stall_ms: float = Field(ge=0)
    idle_ms: float = Field(ge=0, default=0.0)


# ── Bottleneck attribution (S1: visualization-grade output) ─────────────────
#
# `KPIBreakdown` answers "where did step_ms go?" at the system level. The
# attribution types below answer "which physical link / GPU caused it?" so
# the UI can reverse-project bottlenecks onto the topology view.
#
# Engines populate these *only when they can*. A pure analytical engine may
# attribute by heuristic (surrogate-svc), a cycle-accurate engine attributes
# from the trace (astra-sim). Consumers must treat absent fields as "engine
# did not attribute", not "no bottleneck".

Severity = Literal["low", "med", "high"]

BottleneckKind = Literal[
    "nvlink",          # intra-server scale-up saturation
    "infiniband",      # cross-rack scale-out saturation
    "roce",
    "leaf_spine",      # fabric-level congestion (any scale-out kind)
    "pcie",
    "compute",         # SM-bound, no comm/mem stall
    "memory_bw",       # HBM bandwidth bound
    "kv_spill",        # inference: KV working set > HBM
    "kv_pressure",     # inference: KV near HBM, no spill yet
    "pp_bubble",       # pipeline-parallel idle bubble dominates
    "ep_alltoall",     # MoE expert-parallel all-to-all dominant
    "unknown",         # engine ran but couldn't classify
]


class LinkAttribution(BaseModel):
    """Per-link contribution to step time. `id` MUST match an `id` in
    `EnginePredictRequest.cluster.fabric_topology` so the UI can resolve it
    against the same hwspec snapshot the engine ran on."""

    id: str = Field(min_length=1, description="link id from cluster.fabric_topology")
    fabric: FabricKind
    util_pct: float = Field(ge=0, le=100)
    severity: Severity
    # Optional: how much of step_ms is attributed to this link. Engines that
    # can't compute this (pure analytical) leave it None and just report util.
    contributes_ms: float | None = Field(default=None, ge=0)


class NodeAttribution(BaseModel):
    """Per-node (server / GPU) contribution. `id` is engine-defined but should
    be stable across calls with the same hwspec — the UI keys overlays by it.

    Recommended convention: `<rack-id>.<server-id>.gpu-<n>` for GPU-level,
    `<rack-id>.<server-id>` for server-level."""

    id: str = Field(min_length=1)
    issue: BottleneckKind
    severity: Severity
    # Free-form context the engine wants to surface — e.g. {"spill_pct": 0.12,
    # "hbm_used_gb": 78.4}. UI renders as tooltip.
    metrics: dict[str, float] = Field(default_factory=dict)


class BottleneckAttribution(BaseModel):
    """The "explain step_ms" payload. `primary` + `headline` is a single
    actionable conclusion the UI shows as a card; `attribution.{links,nodes}`
    is the geometry the UI projects onto the topology overlay.

    Why a single `primary` and not "top-N bottlenecks": architects make one
    decision per iteration. Showing three competing primaries is decision
    paralysis. Engines that detect multiple comparable bottlenecks should
    pick the one with highest expected ROI to fix and put the others in
    `attribution.links` / `attribution.nodes` for context."""

    primary: BottleneckKind
    severity: Severity
    headline: str = Field(
        min_length=1, max_length=200,
        description="one-sentence conclusion, UI-ready (Chinese or English)",
    )
    # Suggested next action — purely advisory, UI may render as a chip below
    # the headline. Keep short ("TP=4 → TP=2", "↑active_seqs to 512").
    suggested_action: str | None = Field(default=None, max_length=100)
    links: list[LinkAttribution] = Field(default_factory=list)
    nodes: list[NodeAttribution] = Field(default_factory=list)


class PhaseBreakdownEntry(BaseModel):
    """Fine-grained per-phase time. Optional companion to `KPIBreakdown` —
    `KPIBreakdown` is the required 4-bucket contract; this list is the
    engine's preferred decomposition (e.g. attn / ffn / comm_tp / comm_ep /
    mem_stall) when it has finer resolution. UI renders as stacked bar."""

    phase: str = Field(min_length=1, max_length=32)
    ms: float = Field(ge=0)


class EnginePredictResponse(BaseModel):
    # ── required (every engine, every request) ───────────────────────────
    mfu_pct: float = Field(ge=0, le=100)
    step_ms: float = Field(gt=0)
    breakdown: KPIBreakdown
    peak_kw: float = Field(ge=0)
    confidence: float = Field(ge=0, le=1)
    coverage_status: Literal["in_dist", "extrapolated"] = "in_dist"
    # `rejected` is *not* a valid response — engines must return HTTP 422
    # for envelope misses, never 200 with this status.

    # ── soft-deprecated; kept for tuner pruning ──────────────────────────
    # The v1 contract had a hard-feasibility flag. v2 prefers `coverage_status`
    # + engine-side 422, but tuner-svc / web tuner UI still want a fast pass/
    # fail bit per trial without parsing notes. Engines that compute this (the
    # surrogate sets it from constraint checks like TP×PP×EP×CP > GPU count)
    # populate it; engines that don't (astra-sim) leave it None and callers
    # treat None as "feasible until proven otherwise".
    feasible: bool | None = None

    # ── inference-mode required ──────────────────────────────────────────
    ttft_ms: float | None = None
    tpot_ms: float | None = None

    # ── optional (engine declares them in `kpi_outputs`) ─────────────────
    kv_hit_rate: float | None = Field(default=None, ge=0, le=1)
    cache_pressure_pct: float | None = Field(default=None, ge=0)
    spill_bytes_per_s: float | None = Field(default=None, ge=0)

    # Soft-deprecated since S1 attribution schema. Engines should populate
    # `bottleneck.links` instead. Kept for back-compat with pre-S1 callers
    # that read it directly (tuner pruning, RunDetail pre-overlay UI).
    link_util_top: list[dict[str, Any]] | None = None

    # ── S1 visualization contract (RFC-vis §1.1): engine-attributed ──────
    # bottleneck geometry. Optional because not every engine can attribute;
    # consumers MUST treat absent as "did not attribute", never as "no
    # bottleneck". UI's reverse-projection onto topology reads from here.
    bottleneck: BottleneckAttribution | None = None
    phase_breakdown: list[PhaseBreakdownEntry] | None = None

    # ── annotation; UI surfaces, not fail ────────────────────────────────
    notes: list[str] = Field(default_factory=list)
