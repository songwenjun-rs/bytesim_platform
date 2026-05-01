from __future__ import annotations

import os
from typing import Any

import httpx

from app._obs import traced_async_client


class TcoSvcClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or os.environ.get("TCO_SVC_URL", "http://localhost:8088")
        self._client = traced_async_client(base_url=self.base_url, timeout=10.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def get_breakdown(self, run_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/tco/runs/{run_id}")
        r.raise_for_status()
        return r.json()

    async def list_rules(self, resource_kind: str | None = None) -> list[dict[str, Any]]:
        params = {"resource_kind": resource_kind} if resource_kind else {}
        r = await self._client.get("/v1/tco/rules", params=params)
        r.raise_for_status()
        return r.json()

    async def compare(self, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post("/v1/tco/compare", json=body)
        r.raise_for_status()
        return r.json()
