"""Test-harness copy of envelope_covers + validate_envelope_intervals.

These functions live in engine_registry_svc as production code
(service/engine_registry_svc/app/selector.py). Vendored here so tests
don't need a sys.path dance to reach the service's app/ package.

If the production logic changes, mirror it here. Tomorrow's contract
harness should pull the function from a published utility package or via
git submodule of the contracts repo. For Phase 1 (in-monorepo refactor)
the duplication is the cost of mode A purity — same trade-off as the two
engine_runtime vendored copies (surrogate_svc, bytesim_svc).
"""
from __future__ import annotations

from generated.engine_contracts import CoverageEnvelope, EnvelopeMissReason


def validate_envelope_intervals(env: CoverageEnvelope) -> None:
    for name in ("TP", "PP", "EP", "CP"):
        lo, hi = getattr(env.parallelism, name)
        if lo < 1 or hi < lo:
            raise ValueError(
                f"parallelism.{name} interval invalid: ({lo}, {hi}); need 1 <= lo <= hi"
            )
    lo, hi = env.hardware.scale_gpus
    if lo < 1 or hi < lo:
        raise ValueError(
            f"hardware.scale_gpus invalid: ({lo}, {hi}); need 1 <= lo <= hi"
        )


def envelope_covers(
    env: CoverageEnvelope,
    *,
    model_family: str,
    mode: str,
    quant: str,
    gpu_model: str,
    gpu_count: int,
    TP: int, PP: int, EP: int, CP: int,
    recompute: str,
    overlap: str,
    fabric_kinds: list[str] | None = None,
) -> tuple[bool, list[EnvelopeMissReason]]:
    misses: list[EnvelopeMissReason] = []
    if model_family not in env.model_families:
        misses.append(EnvelopeMissReason(field="model_family",
                                          requested=model_family,
                                          accepted=env.model_families))
    if mode not in env.modes:
        misses.append(EnvelopeMissReason(field="mode",
                                          requested=mode, accepted=env.modes))
    if quant not in env.quant:
        misses.append(EnvelopeMissReason(field="quant",
                                          requested=quant, accepted=env.quant))
    if gpu_model not in env.hardware.gpu_models:
        misses.append(EnvelopeMissReason(field="hardware.gpu_model",
                                          requested=gpu_model,
                                          accepted=env.hardware.gpu_models))
    lo, hi = env.hardware.scale_gpus
    if not (lo <= gpu_count <= hi):
        misses.append(EnvelopeMissReason(field="hardware.scale_gpus",
                                          requested=gpu_count, accepted=[lo, hi]))
    p = env.parallelism
    for name, val in (("TP", TP), ("PP", PP), ("EP", EP), ("CP", CP)):
        plo, phi = getattr(p, name)
        if not (plo <= val <= phi):
            misses.append(EnvelopeMissReason(
                field=f"parallelism.{name}", requested=val,
                accepted=[plo, phi],
            ))
    if recompute not in p.recompute:
        misses.append(EnvelopeMissReason(field="parallelism.recompute",
                                          requested=recompute,
                                          accepted=p.recompute))
    if overlap not in p.overlap:
        misses.append(EnvelopeMissReason(field="parallelism.overlap",
                                          requested=overlap, accepted=p.overlap))
    if fabric_kinds:
        unknown = [f for f in fabric_kinds if f not in env.hardware.fabric]
        if unknown:
            misses.append(EnvelopeMissReason(field="hardware.fabric",
                                              requested=unknown,
                                              accepted=env.hardware.fabric))
    return (not misses, misses)
