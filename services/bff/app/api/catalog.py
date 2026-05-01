"""§1 Catalog passthrough — read-only views of bs_resource / bs_link.

Tech architects use this for: (a) topology browsing on the Run-detail page,
(b) tuner constraints (rack-level power budget, failure-domain isolation),
(c) §5 TCO computation (per-SKU capex/power lookups)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()


def _passthrough_get(coro):
    """Map any downstream error to 502; preserve 404 cleanly."""
    async def _go():
        try:
            return await coro()
        except Exception as exc:  # pragma: no cover - exercised via tests
            msg = str(exc)
            code = 404 if "404" in msg or "not found" in msg.lower() else 502
            raise HTTPException(status_code=code, detail=msg) from exc
    return _go()


@router.get("/v1/catalog/resources")
async def list_resources(
    request: Request,
    kind: str | None = None,
    parent_id: str | None = None,
    failure_domain: str | None = None,
    lifecycle: str | None = None,
    include_retired: bool = False,
) -> list[dict[str, Any]]:
    return await _passthrough_get(lambda: request.app.state.asset_svc.list_resources(
        kind=kind, parent_id=parent_id, failure_domain=failure_domain,
        lifecycle=lifecycle, include_retired=str(include_retired).lower() if include_retired else None,
    ))


@router.get("/v1/catalog/resources/{resource_id}")
async def get_resource(resource_id: str, request: Request) -> dict[str, Any]:
    return await _passthrough_get(lambda: request.app.state.asset_svc.get_resource(resource_id))


@router.get("/v1/catalog/resources/{resource_id}/tree")
async def get_resource_tree(resource_id: str, request: Request) -> dict[str, Any]:
    return await _passthrough_get(lambda: request.app.state.asset_svc.get_resource_tree(resource_id))


@router.get("/v1/catalog/links")
async def list_links(
    request: Request,
    src: str | None = None,
    dst: str | None = None,
    fabric: str | None = None,
) -> list[dict[str, Any]]:
    return await _passthrough_get(lambda: request.app.state.asset_svc.list_links(
        src=src, dst=dst, fabric=fabric,
    ))


@router.get("/v1/catalog/stats")
async def catalog_stats(request: Request) -> dict[str, Any]:
    return await _passthrough_get(lambda: request.app.state.asset_svc.catalog_stats())


# ── 硬件部件 + sim presets — backed by bs_catalog table ────────────────────


@router.get("/v1/catalog/items/{kind}")
async def list_catalog_items(kind: str, request: Request) -> list[dict[str, Any]]:
    return await _passthrough_get(
        lambda: request.app.state.asset_svc.list_catalog_items(kind),
    )


@router.post("/v1/catalog/items/{kind}")
async def create_catalog_item(kind: str, request: Request, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return await request.app.state.asset_svc.upsert_catalog_item(kind, body=body)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.put("/v1/catalog/items/{kind}/{item_id}")
async def update_catalog_item(
    kind: str, item_id: str, request: Request, body: dict[str, Any],
) -> dict[str, Any]:
    try:
        return await request.app.state.asset_svc.upsert_catalog_item(
            kind, item_id=item_id, body=body,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/v1/catalog/items/{kind}/{item_id}", status_code=204)
async def delete_catalog_item(kind: str, item_id: str, request: Request) -> None:
    try:
        await request.app.state.asset_svc.delete_catalog_item(kind, item_id)
    except Exception as exc:
        msg = str(exc)
        code = 404 if "404" in msg or "not found" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=msg) from exc
