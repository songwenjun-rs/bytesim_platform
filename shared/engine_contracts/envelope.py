"""CoverageEnvelope (RFC-001 §2.3).

An engine declares — at registration time — what (workload × hardware ×
strategy) tuples it actually covers. The registry stores this verbatim and
uses `envelope_covers(env, req)` (§2.5) to filter candidates per request.

Strong schema is the whole point: today's `bs_engine.capabilities` is free
JSONB, and astra-sim claims `topologies=[fattree, torus2d, torus3d]` while its
translator only handles `[ring, switch, fully_connected, fc]`. With this
schema the registry rejects the bad declaration on register and the runtime
miss-reason API tells callers exactly what doesn't fit.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


# ── Closed enums (kept narrow on purpose; widen via PR + RFC bump) ────────

WorkloadFamily = Literal[
    "transformer-dense",
    "transformer-moe",
    "dlrm",
    "dit",
    "rnn",
    "ssm",
]

GpuModel = Literal["B200", "H200", "GB300", "MI355X", "H100", "NPU-910"]

FabricKind = Literal["nvlink", "infiniband", "roce", "cxl", "pcie", "ethernet"]

Quant = Literal["BF16", "FP8", "INT8", "INT4"]

Mode = Literal["training", "inference"]


# ── Sub-objects ───────────────────────────────────────────────────────────


class ParallelismRange(BaseModel):
    """Closed [min, max] intervals for each parallel axis. `recompute` and
    `overlap` are discrete sets — engines list every variant they implement."""

    TP: tuple[int, int] = Field(description="[min, max] tensor-parallel degree")
    PP: tuple[int, int] = Field(description="[min, max] pipeline-parallel degree")
    EP: tuple[int, int] = Field(description="[min, max] expert-parallel degree (1 if engine doesn't model MoE)")
    CP: tuple[int, int] = Field(description="[min, max] context-parallel degree")
    recompute: list[Literal["selective", "full", "none"]] = Field(min_length=1)
    overlap: list[str] = Field(min_length=1, description="overlap algorithm names; engine-specific tokens are OK")

    @model_validator(mode="after")
    def _intervals_ordered(self) -> "ParallelismRange":
        for name in ("TP", "PP", "EP", "CP"):
            lo, hi = getattr(self, name)
            if lo < 1 or hi < lo:
                raise ValueError(f"{name} interval invalid: ({lo}, {hi}); need 1 ≤ lo ≤ hi")
        return self


class HardwareScope(BaseModel):
    gpu_models: list[GpuModel] = Field(min_length=1)
    fabric: list[FabricKind] = Field(min_length=1)
    scale_gpus: tuple[int, int] = Field(description="[min, max] cluster GPU count this engine handles")

    @model_validator(mode="after")
    def _scale_ordered(self) -> "HardwareScope":
        lo, hi = self.scale_gpus
        if lo < 1 or hi < lo:
            raise ValueError(f"scale_gpus invalid: ({lo}, {hi}); need 1 ≤ lo ≤ hi")
        return self


# ── Top-level envelope ────────────────────────────────────────────────────


class CoverageEnvelope(BaseModel):
    """The full declaration. Anything not in the envelope → routing rejects
    the request before it reaches the engine."""

    workload_families: list[WorkloadFamily] = Field(min_length=1)
    parallelism: ParallelismRange
    hardware: HardwareScope
    quant: list[Quant] = Field(min_length=1)
    modes: list[Mode] = Field(min_length=1)


# ── Coverage check ────────────────────────────────────────────────────────


class EnvelopeMissReason(BaseModel):
    """One field-level reason that an envelope didn't cover a request.
    Returned in selector 503 to tell the architect *exactly* what's missing
    (§2.5 — empty-set 503 enhancement)."""

    field: str
    requested: object
    accepted: object


def envelope_covers(
    env: CoverageEnvelope,
    *,
    workload_family: WorkloadFamily,
    mode: Mode,
    quant: Quant,
    gpu_model: GpuModel,
    gpu_count: int,
    TP: int,
    PP: int,
    EP: int,
    CP: int,
    recompute: str,
    overlap: str,
    fabric_kinds: list[FabricKind] | None = None,
) -> tuple[bool, list[EnvelopeMissReason]]:
    """Return (ok, miss_reasons). When ok is False, miss_reasons explains every
    field that doesn't fit — *all* of them, not just the first, so the caller
    can show "differs by N capabilities" not "first difference wins"."""
    misses: list[EnvelopeMissReason] = []

    if workload_family not in env.workload_families:
        misses.append(EnvelopeMissReason(
            field="workload_family", requested=workload_family,
            accepted=env.workload_families,
        ))
    if mode not in env.modes:
        misses.append(EnvelopeMissReason(
            field="mode", requested=mode, accepted=env.modes,
        ))
    if quant not in env.quant:
        misses.append(EnvelopeMissReason(
            field="quant", requested=quant, accepted=env.quant,
        ))
    if gpu_model not in env.hardware.gpu_models:
        misses.append(EnvelopeMissReason(
            field="hardware.gpu_model", requested=gpu_model,
            accepted=env.hardware.gpu_models,
        ))
    lo, hi = env.hardware.scale_gpus
    if not (lo <= gpu_count <= hi):
        misses.append(EnvelopeMissReason(
            field="hardware.scale_gpus", requested=gpu_count,
            accepted=[lo, hi],
        ))

    p = env.parallelism
    for name, val in (("TP", TP), ("PP", PP), ("EP", EP), ("CP", CP)):
        plo, phi = getattr(p, name)
        if not (plo <= val <= phi):
            misses.append(EnvelopeMissReason(
                field=f"parallelism.{name}", requested=val, accepted=[plo, phi],
            ))
    if recompute not in p.recompute:
        misses.append(EnvelopeMissReason(
            field="parallelism.recompute", requested=recompute, accepted=p.recompute,
        ))
    if overlap not in p.overlap:
        misses.append(EnvelopeMissReason(
            field="parallelism.overlap", requested=overlap, accepted=p.overlap,
        ))

    if fabric_kinds:
        unknown = [f for f in fabric_kinds if f not in env.hardware.fabric]
        if unknown:
            misses.append(EnvelopeMissReason(
                field="hardware.fabric", requested=unknown, accepted=env.hardware.fabric,
            ))

    return (not misses, misses)
