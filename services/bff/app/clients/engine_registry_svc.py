from __future__ import annotations

import os
from typing import Any

import httpx

from app._obs import traced_async_client


class EngineRegistrySvcClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or os.environ.get("ENGINE_REGISTRY_URL", "http://localhost:8089")
        # astra-sim's analytical run is fast (sub-second on bundled microbench)
        # but we leave headroom for cold caches / larger NPU counts.
        self._client = traced_async_client(base_url=self.base_url, timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def list_engines(self, *, status: str | None = None) -> list[dict[str, Any]]:
        params = {k: v for k, v in (("status", status),) if v}
        r = await self._client.get("/v1/engines", params=params)
        r.raise_for_status()
        return r.json()

    async def get_engine(self, name: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/engines/{name}")
        r.raise_for_status()
        return r.json()

    async def predict(self, body: dict[str, Any]) -> dict[str, Any]:
        """Forward a routing request — body matches registry's
        PredictRequestEnvelope (RFC-001 v2):
        {payload: EnginePredictRequest, sla_budget_ms?, engine_preference?,
        fidelity_floor?}."""
        r = await self._client.post("/v1/predict", json=body)
        r.raise_for_status()
        return r.json()
