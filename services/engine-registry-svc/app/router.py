"""Engine selection (RFC-001 §2.5).

Coverage-aware routing. Given an EnginePredictRequest, find every engine
whose coverage_envelope ⊇ the request, filter by SLA / fidelity floor,
then pick:
    primary: cycle-accurate > hybrid > analytical, calibration_mape ↑, sla ↑
    miss   : list every field the request differs on (engineer-friendly 503)
"""
from __future__ import annotations

from typing import Any, Literal

from engine_contracts import (
    CoverageEnvelope,
    EnginePredictRequest,
    EnvelopeMissReason,
    envelope_covers,
)


_FIDELITY_RANK = {"analytical": 0, "hybrid": 1, "cycle-accurate": 2}


def _fabric_kinds_from(req: EnginePredictRequest) -> list[str]:
    if req.cluster.fabric_topology:
        # de-duplicate while preserving order
        seen: dict[str, None] = {}
        for link in req.cluster.fabric_topology:
            seen.setdefault(link.fabric, None)
        return list(seen.keys())
    return []


def _check_envelope(engine: dict[str, Any], req: EnginePredictRequest
                    ) -> tuple[bool, list[EnvelopeMissReason]]:
    """Lift the engine's stored envelope JSON to a CoverageEnvelope and run
    the contract-package coverage check. Engines with malformed envelope are
    treated as no-coverage (and the registry should never have accepted them
    in the first place)."""
    raw = engine.get("coverage_envelope")
    if not isinstance(raw, dict):
        return False, []
    try:
        env = CoverageEnvelope.model_validate(raw)
    except Exception:
        return False, []
    return envelope_covers(
        env,
        workload_family=req.workload.workload_family,
        mode=req.workload.mode,
        quant=req.workload.quant,
        gpu_model=req.cluster.gpu_model,
        gpu_count=req.cluster.gpu_count,
        TP=req.strategy.TP, PP=req.strategy.PP,
        EP=req.strategy.EP, CP=req.strategy.CP,
        recompute=req.strategy.recompute,
        overlap=req.strategy.overlap,
        fabric_kinds=_fabric_kinds_from(req),  # type: ignore[arg-type]
    )


def select_engine(
    engines: list[dict[str, Any]],
    req: EnginePredictRequest,
    *,
    sla_budget_ms: int | None = None,
    engine_preference: str | None = None,
    fidelity_floor: Literal["analytical", "hybrid", "cycle-accurate"] | None = None,
) -> dict[str, Any] | None:
    if engine_preference:
        for e in engines:
            if e["name"] == engine_preference and e["status"] == "active":
                return e
        return None

    eligible: list[dict[str, Any]] = []
    for e in engines:
        if e["status"] != "active":
            continue
        ok, _ = _check_envelope(e, req)
        if not ok:
            continue
        if sla_budget_ms is not None and int(e["sla_p99_ms"]) > sla_budget_ms:
            continue
        if fidelity_floor and _FIDELITY_RANK[e["fidelity"]] < _FIDELITY_RANK[fidelity_floor]:
            continue
        eligible.append(e)

    if not eligible:
        return None

    def _calibration_mape(e: dict[str, Any]) -> float:
        cal = e.get("calibration") or {}
        return float((cal.get("mape_pct") or {}).get("mfu", 99.0))

    return min(eligible, key=lambda e: (
        -_FIDELITY_RANK[e["fidelity"]],
        _calibration_mape(e),
        int(e["sla_p99_ms"]),
    ))


def explain_misses(engines: list[dict[str, Any]], req: EnginePredictRequest
                   ) -> dict[str, list[dict[str, Any]]]:
    """Why did we return 503? For each active engine, list every miss-field.
    Surfaces directly in the registry's HTTP response so callers can fix
    their request or pick a different engine."""
    out: dict[str, list[dict[str, Any]]] = {}
    for e in engines:
        if e["status"] != "active":
            continue
        _, misses = _check_envelope(e, req)
        if misses:
            out[e["name"]] = [m.model_dump() for m in misses]
    return out
