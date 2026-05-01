from __future__ import annotations

import os
from typing import Any

import httpx

from app._obs import traced_async_client


class IngestSvcClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or os.environ.get("INGEST_SVC_URL", "http://localhost:8090")
        self._client = traced_async_client(base_url=self.base_url, timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def list_snapshots(self, **filters: Any) -> list[dict[str, Any]]:
        params = {k: v for k, v in filters.items() if v is not None}
        r = await self._client.get("/v1/snapshots", params=params)
        r.raise_for_status()
        return r.json()

    async def get_snapshot(self, snapshot_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/snapshots/{snapshot_id}")
        r.raise_for_status()
        return r.json()

    async def approve(self, snapshot_id: str, *, actor_id: str, actor_role: str) -> dict[str, Any]:
        r = await self._client.post(
            f"/v1/snapshots/{snapshot_id}/approve",
            json={"actor_id": actor_id},
            headers={"X-Actor-Role": actor_role},
        )
        r.raise_for_status()
        return r.json()

    async def reject(self, snapshot_id: str, *, actor_id: str, actor_role: str,
                      reason: str | None = None) -> dict[str, Any]:
        r = await self._client.post(
            f"/v1/snapshots/{snapshot_id}/reject",
            json={"actor_id": actor_id, "reason": reason},
            headers={"X-Actor-Role": actor_role},
        )
        r.raise_for_status()
        return r.json()

    async def list_consumers(self, snapshot_id: str) -> list[dict[str, Any]]:
        r = await self._client.get(f"/v1/snapshots/{snapshot_id}/consumers")
        r.raise_for_status()
        return r.json()

    async def list_adapters(self) -> list[dict[str, str]]:
        r = await self._client.get("/v1/adapters")
        r.raise_for_status()
        return r.json()

    async def upload(self, file_bytes: bytes, file_name: str, *,
                      project_id: str, name: str, source_kind: str,
                      source_adapter: str, actor_id: str,
                      redaction_attest: str = "{}", notes: str = "") -> dict[str, Any]:
        files = {"file": (file_name, file_bytes, "application/octet-stream")}
        data = {
            "project_id": project_id, "name": name,
            "source_kind": source_kind, "source_adapter": source_adapter,
            "redaction_attest": redaction_attest, "notes": notes,
        }
        r = await self._client.post(
            "/v1/snapshots", files=files, data=data,
            headers={"X-Actor-Id": actor_id},
        )
        r.raise_for_status()
        return r.json()
