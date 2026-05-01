"""§1 Catalog passthrough — BFF /v1/catalog/* talks to asset-svc."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _new_app():
    from app.api import catalog  # type: ignore
    app = FastAPI()
    app.include_router(catalog.router)
    app.state.asset_svc = AsyncMock()
    return app


@pytest.fixture
def app():
    return _new_app()


@pytest.fixture
def client(app):
    return TestClient(app)


def test_list_resources_passthrough(client, app):
    app.state.asset_svc.list_resources = AsyncMock(return_value=[
        {"id": "gpu-bj1-srv-01-g0", "kind": "gpu", "lifecycle": "active"},
    ])
    r = client.get("/v1/catalog/resources?kind=gpu")
    assert r.status_code == 200
    assert r.json()[0]["kind"] == "gpu"


def test_list_resources_includes_filters(client, app):
    app.state.asset_svc.list_resources = AsyncMock(return_value=[])
    client.get("/v1/catalog/resources?kind=server&parent_id=rack-bj1-r03&failure_domain=pdu-A")
    kwargs = app.state.asset_svc.list_resources.await_args.kwargs
    assert kwargs["kind"] == "server"
    assert kwargs["parent_id"] == "rack-bj1-r03"
    assert kwargs["failure_domain"] == "pdu-A"


def test_get_resource_404(client, app):
    app.state.asset_svc.get_resource = AsyncMock(side_effect=RuntimeError("404 not found"))
    r = client.get("/v1/catalog/resources/missing")
    assert r.status_code == 404


def test_get_resource_502_on_other_error(client, app):
    app.state.asset_svc.get_resource = AsyncMock(side_effect=RuntimeError("conn refused"))
    r = client.get("/v1/catalog/resources/x")
    assert r.status_code == 502


def test_get_resource_tree_returns_tree(client, app):
    app.state.asset_svc.get_resource_tree = AsyncMock(return_value={
        "id": "site-bj1", "kind": "site", "children": [{"id": "pod-bj1-p1", "kind": "pod", "children": []}],
    })
    r = client.get("/v1/catalog/resources/site-bj1/tree")
    assert r.status_code == 200
    assert r.json()["children"][0]["kind"] == "pod"


def test_list_links(client, app):
    app.state.asset_svc.list_links = AsyncMock(return_value=[{"id": "link-1", "fabric": "nvlink"}])
    r = client.get("/v1/catalog/links?fabric=nvlink")
    assert r.status_code == 200
    assert r.json()[0]["fabric"] == "nvlink"


def test_catalog_stats(client, app):
    app.state.asset_svc.catalog_stats = AsyncMock(return_value={
        "total": 47, "by_kind": {"gpu": 32, "server": 4}, "by_lifecycle": {"active": 47},
    })
    r = client.get("/v1/catalog/stats")
    assert r.status_code == 200
    assert r.json()["total"] == 47


# ── /v1/catalog/items/{kind} (parts + presets) ────────────────────────────

def test_list_catalog_items(client, app):
    app.state.asset_svc.list_catalog_items = AsyncMock(return_value=[
        {"kind": "cpu", "id": "amd-9755", "name": "AMD EPYC 9755", "body": {}},
    ])
    r = client.get("/v1/catalog/items/cpu")
    assert r.status_code == 200
    assert r.json()[0]["id"] == "amd-9755"


def test_list_catalog_items_502(client, app):
    app.state.asset_svc.list_catalog_items = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.get("/v1/catalog/items/cpu")
    assert r.status_code == 502


def test_create_catalog_item_post(client, app):
    captured = {}
    async def _upsert(kind, body=None, item_id=None):
        captured.update({"kind": kind, "body": body, "item_id": item_id})
        return {"kind": kind, "id": "cpu-new", "name": "x", "body": body}
    app.state.asset_svc.upsert_catalog_item = AsyncMock(side_effect=_upsert)
    r = client.post("/v1/catalog/items/cpu",
                    json={"id": "cpu-new", "name": "x", "body": {"cores": 64}})
    assert r.status_code == 200
    assert captured["kind"] == "cpu"
    # POST does NOT pass item_id (only PUT does); body forwards verbatim.
    assert captured["item_id"] is None


def test_create_catalog_item_502(client, app):
    app.state.asset_svc.upsert_catalog_item = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.post("/v1/catalog/items/cpu", json={"id": "x", "name": "y", "body": {}})
    assert r.status_code == 502


def test_update_catalog_item_put_carries_path_id(client, app):
    captured = {}
    async def _upsert(kind, body=None, item_id=None):
        captured["item_id"] = item_id
        return {"kind": kind, "id": item_id, "name": "x", "body": body}
    app.state.asset_svc.upsert_catalog_item = AsyncMock(side_effect=_upsert)
    r = client.put("/v1/catalog/items/cpu/cpu-existing",
                   json={"name": "renamed", "body": {}})
    assert r.status_code == 200
    assert captured["item_id"] == "cpu-existing"


def test_update_catalog_item_502(client, app):
    app.state.asset_svc.upsert_catalog_item = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.put("/v1/catalog/items/cpu/cpu-1", json={"name": "x", "body": {}})
    assert r.status_code == 502


def test_delete_catalog_item_204(client, app):
    app.state.asset_svc.delete_catalog_item = AsyncMock(return_value=None)
    r = client.delete("/v1/catalog/items/cpu/cpu-1")
    assert r.status_code == 204


def test_delete_catalog_item_404(client, app):
    app.state.asset_svc.delete_catalog_item = AsyncMock(
        side_effect=RuntimeError("404 not found"))
    r = client.delete("/v1/catalog/items/cpu/missing")
    assert r.status_code == 404


def test_delete_catalog_item_502(client, app):
    app.state.asset_svc.delete_catalog_item = AsyncMock(
        side_effect=RuntimeError("conn refused"))
    r = client.delete("/v1/catalog/items/cpu/x")
    assert r.status_code == 502
