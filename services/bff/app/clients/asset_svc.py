from __future__ import annotations

import os
from typing import Any

import httpx

from app._obs import traced_async_client


class AssetSvcClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or os.environ.get("ASSET_SVC_URL", "http://localhost:8082")
        self._client = traced_async_client(base_url=self.base_url, timeout=10.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def list_specs(self, kind: str) -> list[dict[str, Any]]:
        r = await self._client.get(f"/v1/specs/{kind}")
        r.raise_for_status()
        return r.json()

    async def get_latest(self, kind: str, spec_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/specs/{kind}/{spec_id}")
        r.raise_for_status()
        return r.json()

    async def list_versions(self, kind: str, spec_id: str) -> list[dict[str, Any]]:
        r = await self._client.get(f"/v1/specs/{kind}/{spec_id}/versions")
        r.raise_for_status()
        return r.json()

    async def snapshot(self, kind: str, spec_id: str, body: Any, version_tag: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"body": body}
        if version_tag:
            payload["version_tag"] = version_tag
        r = await self._client.post(f"/v1/specs/{kind}/{spec_id}/snapshot", json=payload)
        r.raise_for_status()
        return r.json()

    async def diff(self, kind: str, spec_id: str, from_hash: str, to_hash: str) -> dict[str, Any]:
        r = await self._client.get(
            f"/v1/specs/{kind}/{spec_id}/diff",
            params={"from": from_hash, "to": to_hash},
        )
        r.raise_for_status()
        return r.json()

    async def fork(self, kind: str, spec_id: str, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(f"/v1/specs/{kind}/{spec_id}/fork", json=body)
        r.raise_for_status()
        return r.json()

    # ── §1 Catalog API passthrough ──

    async def list_resources(self, **filters: Any) -> list[dict[str, Any]]:
        params = {k: v for k, v in filters.items() if v is not None}
        r = await self._client.get("/v1/catalog/resources", params=params)
        r.raise_for_status()
        return r.json()

    async def get_resource(self, resource_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/catalog/resources/{resource_id}")
        r.raise_for_status()
        return r.json()

    async def get_resource_tree(self, resource_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/v1/catalog/resources/{resource_id}/tree")
        r.raise_for_status()
        return r.json()

    async def list_links(self, **filters: Any) -> list[dict[str, Any]]:
        params = {k: v for k, v in filters.items() if v is not None}
        r = await self._client.get("/v1/catalog/links", params=params)
        r.raise_for_status()
        return r.json()

    async def catalog_stats(self) -> dict[str, Any]:
        r = await self._client.get("/v1/catalog/stats")
        r.raise_for_status()
        return r.json()

    # ── 硬件部件 + sim presets ──
    async def list_catalog_items(self, kind: str) -> list[dict[str, Any]]:
        r = await self._client.get(f"/v1/catalog/items/{kind}")
        r.raise_for_status()
        return r.json()

    async def upsert_catalog_item(
        self, kind: str, *, body: dict[str, Any], item_id: str | None = None,
    ) -> dict[str, Any]:
        if item_id is None:
            r = await self._client.post(f"/v1/catalog/items/{kind}", json=body)
        else:
            r = await self._client.put(f"/v1/catalog/items/{kind}/{item_id}", json=body)
        r.raise_for_status()
        return r.json()

    async def delete_catalog_item(self, kind: str, item_id: str) -> None:
        r = await self._client.delete(f"/v1/catalog/items/{kind}/{item_id}")
        r.raise_for_status()
