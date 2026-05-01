"""Cover all six bff/app/clients/*.py wrappers using httpx.MockTransport."""
from __future__ import annotations

import httpx
import pytest


def _patch(client_obj, base, handler):
    """Replace an internal httpx client with one routed at a MockTransport."""
    client_obj._client = httpx.AsyncClient(
        base_url=base,
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_run_svc_client_full_surface():
    from app.clients.run_svc import RunSvcClient

    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["last"] = (req.method, req.url.path, dict(req.url.params))
        if req.url.path == "/v1/runs/sim-1" and req.method == "GET":
            return httpx.Response(200, json={"id": "sim-1"})
        if req.url.path == "/v1/runs/sim-1/specs":
            return httpx.Response(200, json=[{"hash": "h"}])
        if req.url.path == "/v1/runs/sim-1/lineage":
            return httpx.Response(200, json={"self": {}, "edges": []})
        if req.method == "POST" and req.url.path == "/v1/runs":
            return httpx.Response(200, json={"id": "new"})
        if req.url.path == "/v1/plans/p-1":
            return httpx.Response(200, json={"id": "p-1"})
        if req.method == "POST" and req.url.path == "/v1/plans":
            return httpx.Response(200, json={"id": "p-new"})
        if req.method == "POST" and req.url.path == "/v1/plans/p-1/slots":
            return httpx.Response(200, json={"slot": "A"})
        if req.method == "DELETE" and req.url.path == "/v1/plans/p-1/slots/A":
            return httpx.Response(200, json={"removed": "A"})
        if req.url.path == "/v1/runs":
            return httpx.Response(200, json=[{"id": "x"}])
        if req.url.path == "/v1/runs-stale":
            return httpx.Response(200, json=[{"id": "stale"}])
        if req.url.path == "/v1/runs-stats":
            return httpx.Response(200, json={"runs_last_30d": 12})
        if req.method == "POST" and req.url.path == "/v1/runs/sim-1/cancel":
            return httpx.Response(200, json={"was_running": True})
        return httpx.Response(404)

    c = RunSvcClient("http://run")
    _patch(c, "http://run", handler)

    assert (await c.get_run("sim-1"))["id"] == "sim-1"
    assert (await c.get_specs("sim-1"))[0]["hash"] == "h"
    assert (await c.get_lineage("sim-1"))["self"] == {}
    assert (await c.create_run({}))["id"] == "new"
    assert (await c.get_plan("p-1"))["id"] == "p-1"
    assert (await c.create_plan({}))["id"] == "p-new"
    assert (await c.add_plan_slot("p-1", {}))["slot"] == "A"
    assert (await c.remove_plan_slot("p-1", "A"))["removed"] == "A"
    assert (await c.list_runs(status="running", kind="train"))[0]["id"] == "x"
    assert captured["last"][2]["status"] == "running"
    assert (await c.stale_runs())[0]["id"] == "stale"
    assert (await c.run_stats())["runs_last_30d"] == 12
    assert (await c.cancel_run("sim-1"))["was_running"] is True
    await c.close()


@pytest.mark.asyncio
async def test_asset_svc_client_catalog_endpoints():
    from app.clients.asset_svc import AssetSvcClient

    captured = []

    def handler(req):
        captured.append((req.method, req.url.path, dict(req.url.params)))
        if req.url.path.endswith("/tree"):
            return httpx.Response(200, json={"id": "site-bj1", "children": []})
        if req.url.path == "/v1/catalog/stats":
            return httpx.Response(200, json={"total": 1})
        if req.url.path.startswith("/v1/catalog/resources/"):
            return httpx.Response(200, json={"id": req.url.path.rsplit("/", 1)[-1]})
        return httpx.Response(200, json=[{"id": "x"}])

    c = AssetSvcClient("http://asset")
    _patch(c, "http://asset", handler)
    assert (await c.list_resources(kind="gpu"))[0]["id"] == "x"
    assert (await c.get_resource("site-bj1"))["id"] == "site-bj1"
    assert (await c.get_resource_tree("site-bj1"))["id"] == "site-bj1"
    assert (await c.list_links(fabric="nvlink"))[0]["id"] == "x"
    assert (await c.catalog_stats())["total"] == 1
    # Filters propagated as query params
    list_resources_call = next(c for c in captured if c[1] == "/v1/catalog/resources")
    assert list_resources_call[2]["kind"] == "gpu"
    await c.close()


@pytest.mark.asyncio
async def test_asset_svc_client_full_surface():
    from app.clients.asset_svc import AssetSvcClient

    def handler(req):
        if req.url.path.endswith("/snapshot"):
            return httpx.Response(200, json={"hash": "new"})
        if req.url.path.endswith("/fork"):
            return httpx.Response(200, json={"forked": True})
        if req.url.path.endswith("/diff"):
            return httpx.Response(200, json={"entries": []})
        if req.url.path.endswith("/versions"):
            return httpx.Response(200, json=[{"hash": "v1"}])
        return httpx.Response(200, json={"version": {"hash": "latest"}})

    c = AssetSvcClient("http://asset")
    _patch(c, "http://asset", handler)
    assert (await c.get_latest("hwspec", "h1"))["version"]["hash"] == "latest"
    assert (await c.list_versions("hwspec", "h1"))[0]["hash"] == "v1"
    assert (await c.snapshot("hwspec", "h1", {"k": "v"}, "tag1"))["hash"] == "new"
    assert (await c.diff("hwspec", "h1", "a", "b"))["entries"] == []
    assert (await c.fork("hwspec", "h1", {"new_name": "y"}))["forked"] is True
    await c.close()


@pytest.mark.asyncio
async def test_engine_svc_client_kick():
    from app.clients.engine_svc import EngineSvcClient

    def handler(req):
        assert req.url.path == "/v1/engine/kick/sim-1"
        return httpx.Response(200, json={"started": "sim-1"})

    c = EngineSvcClient("http://engine")
    _patch(c, "http://engine", handler)
    assert (await c.kick("sim-1"))["started"] == "sim-1"
    await c.close()


@pytest.mark.asyncio
async def test_tco_svc_client_full_surface():
    from app.clients.tco_svc import TcoSvcClient

    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["last"] = (req.method, req.url.path, dict(req.url.params))
        if req.method == "GET" and req.url.path == "/v1/tco/runs/sim-1":
            return httpx.Response(200, json={"total_usd": 100.0})
        if req.method == "GET" and req.url.path == "/v1/tco/rules":
            return httpx.Response(200, json=[{"id": "gpu/B200/v1", "kind": "gpu"}])
        if req.method == "POST" and req.url.path == "/v1/tco/compare":
            return httpx.Response(200, json={"diff": [{"k": "v"}]})
        return httpx.Response(404)

    c = TcoSvcClient("http://tco")
    _patch(c, "http://tco", handler)
    assert (await c.get_breakdown("sim-1"))["total_usd"] == 100.0
    rules = await c.list_rules()
    assert rules[0]["id"] == "gpu/B200/v1"
    assert captured["last"][2] == {}  # no resource_kind filter
    await c.list_rules(resource_kind="gpu")
    assert captured["last"][2] == {"resource_kind": "gpu"}
    assert (await c.compare({"runs": ["a", "b"]}))["diff"][0] == {"k": "v"}
    await c.close()


@pytest.mark.asyncio
async def test_engine_registry_svc_client_full_surface():
    from app.clients.engine_registry_svc import EngineRegistrySvcClient

    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["last"] = (req.method, req.url.path, dict(req.url.params))
        if req.method == "GET" and req.url.path == "/v1/engines":
            return httpx.Response(200, json=[
                {"name": "surrogate-analytical"}, {"name": "astra-sim"},
            ])
        if req.method == "GET" and req.url.path == "/v1/engines/astra-sim":
            return httpx.Response(200, json={"name": "astra-sim", "status": "active"})
        if req.method == "POST" and req.url.path == "/v1/predict":
            return httpx.Response(200, json={
                "mfu_pct": 50, "_provenance": {"engine": "astra-sim"},
            })
        return httpx.Response(404)

    c = EngineRegistrySvcClient("http://reg")
    _patch(c, "http://reg", handler)
    rows = await c.list_engines()
    assert {r["name"] for r in rows} == {"surrogate-analytical", "astra-sim"}
    assert captured["last"][2] == {}  # no status filter
    await c.list_engines(status="active")
    assert captured["last"][2] == {"status": "active"}
    e = await c.get_engine("astra-sim")
    assert e["status"] == "active"
    p = await c.predict({"payload": {}, "engine_preference": "astra-sim"})
    assert p["_provenance"]["engine"] == "astra-sim"
    await c.close()


@pytest.mark.asyncio
async def test_ingest_svc_client_full_surface():
    from app.clients.ingest_svc import IngestSvcClient

    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["last"] = (req.method, req.url.path, dict(req.url.params),
                            dict(req.headers))
        if req.method == "GET" and req.url.path == "/v1/snapshots":
            return httpx.Response(200, json=[
                {"id": "snap-1", "status": "pending_review"},
            ])
        if req.method == "GET" and req.url.path == "/v1/snapshots/snap-1":
            return httpx.Response(200, json={"id": "snap-1", "status": "approved"})
        if req.method == "POST" and req.url.path == "/v1/snapshots/snap-1/approve":
            return httpx.Response(200, json={"approved": True})
        if req.method == "POST" and req.url.path == "/v1/snapshots/snap-1/reject":
            return httpx.Response(200, json={"rejected": True})
        if req.method == "GET" and req.url.path == "/v1/snapshots/snap-1/consumers":
            return httpx.Response(200, json=[
                {"consumer_kind": "calibration_job", "consumer_id": "cal-1"},
            ])
        if req.method == "GET" and req.url.path == "/v1/adapters":
            return httpx.Response(200, json=[{"id": "dcgm-csv@v1"}])
        if req.method == "POST" and req.url.path == "/v1/snapshots":
            return httpx.Response(200, json={"id": "snap-new", "row_count": 100})
        return httpx.Response(404)

    c = IngestSvcClient("http://ingest")
    _patch(c, "http://ingest", handler)

    rows = await c.list_snapshots(status="pending_review", source_kind="dcgm")
    assert rows[0]["id"] == "snap-1"
    assert captured["last"][2] == {"status": "pending_review", "source_kind": "dcgm"}

    # Filter pruning: None values dropped
    await c.list_snapshots(status=None, source_kind="dcgm")
    assert captured["last"][2] == {"source_kind": "dcgm"}

    snap = await c.get_snapshot("snap-1")
    assert snap["status"] == "approved"

    out = await c.approve("snap-1", actor_id="alice", actor_role="data_steward")
    assert out["approved"] is True
    # Approve sends the actor role as a header for downstream RBAC.
    assert captured["last"][3].get("x-actor-role") == "data_steward"

    out = await c.reject("snap-1", actor_id="alice", actor_role="data_steward",
                          reason="missing redaction")
    assert out["rejected"] is True

    consumers = await c.list_consumers("snap-1")
    assert consumers[0]["consumer_kind"] == "calibration_job"

    adapters = await c.list_adapters()
    assert adapters[0]["id"] == "dcgm-csv@v1"

    out = await c.upload(
        b"col1,col2\n1,2\n", "data.csv",
        project_id="p_default", name="test", source_kind="dcgm",
        source_adapter="dcgm-csv@v1", actor_id="alice",
    )
    assert out["id"] == "snap-new"
    await c.close()


@pytest.mark.asyncio
async def test_clients_default_base_url_from_env(monkeypatch):
    """Each client picks its base URL from a service-specific env var."""
    monkeypatch.setenv("RUN_SVC_URL", "http://run-from-env:9000")
    from app.clients.run_svc import RunSvcClient
    c = RunSvcClient()
    assert c.base_url == "http://run-from-env:9000"
    await c.close()


@pytest.mark.asyncio
async def test_clients_raise_on_4xx_5xx():
    """Verify each client surfaces a HTTPStatusError when downstream returns 5xx
    (callers depend on the exception to translate into BFF 502 / 404 / 502)."""
    from app.clients.tco_svc import TcoSvcClient
    from app.clients.engine_registry_svc import EngineRegistrySvcClient
    from app.clients.ingest_svc import IngestSvcClient

    def explode(req):
        return httpx.Response(500, json={"detail": "down"})

    for cls, base in [
        (TcoSvcClient, "http://tco"),
        (EngineRegistrySvcClient, "http://reg"),
        (IngestSvcClient, "http://ingest"),
    ]:
        c = cls(base)
        _patch(c, base, explode)
        with pytest.raises(httpx.HTTPStatusError):
            if isinstance(c, TcoSvcClient):
                await c.get_breakdown("x")
            elif isinstance(c, EngineRegistrySvcClient):
                await c.list_engines()
            else:
                await c.list_adapters()
        await c.close()
