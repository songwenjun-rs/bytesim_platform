from __future__ import annotations

import os
from typing import Any

import httpx

from app._obs import traced_async_client


class EngineSvcClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or os.environ.get("ENGINE_SVC_URL", "http://localhost:8087")
        self._client = traced_async_client(base_url=self.base_url, timeout=5.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def kick(self, run_id: str) -> dict[str, Any]:
        r = await self._client.post(f"/v1/engine/kick/{run_id}")
        r.raise_for_status()
        return r.json()
