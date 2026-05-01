from __future__ import annotations

import os
from typing import Any

import httpx

from app._obs import traced_async_client


class RunSvcClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or os.environ.get("RUN_SVC_URL", "http://localhost:8081")
        self._client = traced_async_client(base_url=self.base_url, timeout=10.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def get_run(self, run_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/runs/{run_id}")
        r.raise_for_status()
        return r.json()

    async def get_specs(self, run_id: str) -> list[dict[str, Any]]:
        r = await self._client.get(f"/v1/runs/{run_id}/specs")
        r.raise_for_status()
        return r.json()

    async def get_lineage(self, run_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/runs/{run_id}/lineage")
        r.raise_for_status()
        return r.json()

    async def create_run(self, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post("/v1/runs", json=body)
        r.raise_for_status()
        return r.json()

    async def get_plan(self, plan_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/plans/{plan_id}")
        r.raise_for_status()
        return r.json()

    async def create_plan(self, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post("/v1/plans", json=body)
        r.raise_for_status()
        return r.json()

    async def add_plan_slot(self, plan_id: str, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(f"/v1/plans/{plan_id}/slots", json=body)
        r.raise_for_status()
        return r.json()

    async def remove_plan_slot(self, plan_id: str, slot: str) -> dict[str, Any]:
        r = await self._client.delete(f"/v1/plans/{plan_id}/slots/{slot}")
        r.raise_for_status()
        return r.json()

    async def delete_run(self, run_id: str) -> None:
        r = await self._client.delete(f"/v1/runs/{run_id}")
        r.raise_for_status()

    async def list_runs(self, status: str | None = None, kind: str | None = None,
                        limit: int = 20, project: str = "p_default") -> list[dict[str, Any]]:
        params: dict[str, str] = {"project": project, "limit": str(limit)}
        if status:
            params["status"] = status
        if kind:
            params["kind"] = kind
        r = await self._client.get("/v1/runs", params=params)
        r.raise_for_status()
        return r.json()

    async def stale_runs(self, limit: int = 10, project: str = "p_default") -> list[dict[str, Any]]:
        r = await self._client.get("/v1/runs-stale", params={"project": project, "limit": str(limit)})
        r.raise_for_status()
        return r.json()

    async def run_stats(self, project: str = "p_default") -> dict[str, Any]:
        r = await self._client.get("/v1/runs-stats", params={"project": project})
        r.raise_for_status()
        return r.json()

    async def cancel_run(self, run_id: str) -> dict[str, Any]:
        r = await self._client.post(f"/v1/runs/{run_id}/cancel")
        r.raise_for_status()
        return r.json()
