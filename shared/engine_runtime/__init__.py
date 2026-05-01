"""ByteSim engine runtime helpers (RFC-001 v2 · M2 — pre-SDK).

The proper SDK lands in RFC-002. For M2 cutover this package gives every
engine svc a 30-line drop-in: declare an EngineDescriptor, call
`mount_engine_runtime(app, descriptor, predict_fn)` in your FastAPI app,
done. The helper:

  • mounts GET /v1/capabilities    → returns the descriptor envelope
  • mounts POST /v1/predict        → validates EnginePredictRequest, calls
                                     your predict_fn, validates response
  • starts a background asyncio task that POST /v1/engines/register at boot
    + PATCH /v1/engines/{name}/heartbeat every 30s
  • on shutdown, attempts a clean POST /v1/engines/{name}/deprecate so the
    registry frees the slot quickly

Lives separately from `engine_contracts` because this depends on httpx +
fastapi + asyncio; `engine_contracts` stays pydantic-only.
"""
from .descriptor import (  # noqa: F401
    EngineDescriptor,
    ExpectedKPIRange,
    SmokeCase,
)
from .runtime import mount_engine_runtime  # noqa: F401

__all__ = [
    "EngineDescriptor",
    "ExpectedKPIRange",
    "SmokeCase",
    "mount_engine_runtime",
]
__version__ = "0.2.0"
