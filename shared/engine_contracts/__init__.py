"""ByteSim engine contracts (RFC-001 v2 · M1).

Pure Pydantic schema package shared by `engine-registry-svc` and every engine
plugin (`surrogate-svc`, `astra-sim-svc`, future). Defines:

  • CoverageEnvelope  — what (workload × hw × strategy) tuples an engine claims
                        to cover. Strong schema; registry validates on register
                        and rejects payloads outside an engine's envelope.
  • EnginePredictRequest / Response — the *single* end-to-end predict contract.
                        Per RFC-001 §1.1 we only accept end-to-end engines, so
                        no per-domain variants.
  • KPIBreakdown      — required compute / comm / mem_stall / idle split, the
                        substrate for shadow-engine confidence-band comparisons
                        (RFC-001 §2.7).

This package has zero runtime dependencies beyond pydantic ≥ 2.9. It does not
import FastAPI / httpx / asyncpg — the SDK that wires registration on top of
this lives in a separate package (RFC-002).
"""
from .envelope import (  # noqa: F401 re-exports
    CoverageEnvelope,
    HardwareScope,
    ParallelismRange,
    FabricKind,
    GpuModel,
    Mode,
    Quant,
    WorkloadFamily,
    envelope_covers,
    EnvelopeMissReason,
)
from .predict import (  # noqa: F401 re-exports
    BottleneckAttribution,
    BottleneckKind,
    Cluster,
    EnginePredictRequest,
    EnginePredictResponse,
    FabricLink,
    Fidelity,
    KPIBreakdown,
    KVCacheConfig,
    LinkAttribution,
    NodeAttribution,
    PhaseBreakdownEntry,
    RuntimeKnobs,
    Severity,
    StrategyParams,
    Workload,
)

__all__ = [
    "CoverageEnvelope",
    "HardwareScope",
    "ParallelismRange",
    "FabricKind",
    "GpuModel",
    "Mode",
    "Quant",
    "WorkloadFamily",
    "envelope_covers",
    "EnvelopeMissReason",
    "BottleneckAttribution",
    "BottleneckKind",
    "Cluster",
    "EnginePredictRequest",
    "EnginePredictResponse",
    "FabricLink",
    "Fidelity",
    "KPIBreakdown",
    "KVCacheConfig",
    "LinkAttribution",
    "NodeAttribution",
    "PhaseBreakdownEntry",
    "RuntimeKnobs",
    "Severity",
    "StrategyParams",
    "Workload",
]

__version__ = "0.1.0"
