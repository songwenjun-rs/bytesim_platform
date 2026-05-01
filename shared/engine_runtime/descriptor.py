"""EngineDescriptor — what an engine svc declares about itself at boot.

Pure data; no I/O. The runtime helper turns this into:
  • the body of POST /v1/engines/register
  • the body of GET /v1/capabilities
  • the body of GET /v1/smoke_matrix         (RFC-002)
  • the seed for periodic heartbeats
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from engine_contracts import CoverageEnvelope, EnginePredictRequest
from pydantic import BaseModel, Field


class ExpectedKPIRange(BaseModel):
    """RFC-002 — expected ranges for KPI fields. The smoke harness asserts
    each engine's response keeps each named field within [lo, hi]; missing
    fields fail unless explicitly marked optional."""
    mfu_pct: tuple[float, float] | None = None
    step_ms: tuple[float, float] | None = None
    peak_kw: tuple[float, float] | None = None
    confidence: tuple[float, float] | None = Field(default=(0.0, 1.0))
    ttft_ms: tuple[float, float] | None = None
    tpot_ms: tuple[float, float] | None = None
    coverage_status_in: list[str] = Field(default_factory=lambda: ["in_dist"])


class SmokeCase(BaseModel):
    """One row in an engine's smoke_matrix(). The label is shown in test
    failure messages; req is sent verbatim through /v1/predict."""
    label: str
    req: EnginePredictRequest
    expected: ExpectedKPIRange


@dataclass
class EngineDescriptor:
    name: str
    version: str
    fidelity: str                   # 'analytical' | 'hybrid' | 'cycle-accurate'
    sla_p99_ms: int
    endpoint: str                   # e.g. 'http://surrogate-svc:8083'
    coverage_envelope: CoverageEnvelope
    kpi_outputs: list[str]          # which EnginePredictResponse fields this engine populates
    calibration: dict[str, Any] = field(default_factory=dict)
    notes: str | None = None
    predict_path: str = "/v1/predict"
    capabilities_path: str = "/v1/capabilities"
    # RFC-002 — smoke matrix the contract harness runs against this engine.
    # Empty list means "no contract assertions" (the harness will warn but
    # not fail). Engines declare 3-10 representative cases spanning the
    # corners of their coverage envelope.
    smoke_matrix: list[SmokeCase] = field(default_factory=list)

    def to_register_body(self) -> dict[str, Any]:
        """Body for POST /v1/engines/register."""
        return {
            "name": self.name,
            "version": self.version,
            "fidelity": self.fidelity,
            "sla_p99_ms": self.sla_p99_ms,
            "endpoint": self.endpoint,
            "predict_path": self.predict_path,
            "capabilities_path": self.capabilities_path,
            "coverage_envelope": self.coverage_envelope.model_dump(),
            "kpi_outputs": list(self.kpi_outputs),
            "calibration": dict(self.calibration),
            "notes": self.notes,
        }

    def to_capabilities_body(self) -> dict[str, Any]:
        """Body for GET /v1/capabilities — registry reverse-fetches this on
        register to detect self-attest drift."""
        return {
            "name": self.name,
            "version": self.version,
            "fidelity": self.fidelity,
            "sla_p99_ms": self.sla_p99_ms,
            "coverage_envelope": self.coverage_envelope.model_dump(),
            "kpi_outputs": list(self.kpi_outputs),
        }

    def to_smoke_matrix_body(self) -> dict[str, Any]:
        """Body for GET /v1/smoke_matrix — exposed so the contract harness
        can pull the matrix off a running engine svc instead of importing
        the descriptor module directly. RFC-002 §3."""
        return {
            "name": self.name,
            "cases": [c.model_dump() for c in self.smoke_matrix],
        }
