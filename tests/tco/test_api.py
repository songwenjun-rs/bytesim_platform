"""HTTP-level tests for tco-engine-svc with mocked Store."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient


def _stub_rule(**overrides):
    base = {
        "id": "gpu/B200/v2026q1",
        "resource_kind": "gpu",
        "vendor_sku": "Nvidia/B200-180GB",
        "amortization_y": 3,
        "capex_usd": 39200,
        "power_w_idle": 200,
        "power_w_load": 1200,
        "pue_assumed": 1.18,
        "electricity_usd_per_kwh": 0.092,
        "storage_usd_per_gb_month": None,
    }
    base.update(overrides)
    return base


@pytest.fixture
def app(monkeypatch):
    from app.main import app as fastapi_app  # type: ignore
    fastapi_app.router.lifespan_context = None
    fastapi_app.state.store = AsyncMock()
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_compute_basic(client, app):
    app.state.store.find_rule = AsyncMock(return_value=_stub_rule())
    app.state.store.upsert_breakdown = AsyncMock()
    r = client.post("/v1/tco/compute", json={
        "run_id": "sim-x", "wall_clock_s": 3600, "workload_mode": "training",
        "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 8, "utilization": 0.6}],
        "tokens_processed": 1_000_000_000.0,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_usd"] > 0
    assert body["per_m_token_usd"] is not None
    assert "rule_versions" in body
    app.state.store.upsert_breakdown.assert_awaited_once()


def test_compute_400_when_no_rule(client, app):
    app.state.store.find_rule = AsyncMock(return_value=None)
    r = client.post("/v1/tco/compute", json={
        "run_id": "x", "wall_clock_s": 100, "workload_mode": "training",
        "gpus": [{"vendor_sku": "Bogus/X", "count": 1, "utilization": 0.5}],
    })
    assert r.status_code == 400
    assert "no TCO rule" in r.json()["detail"]


def test_compute_no_persist_skips_upsert(client, app):
    app.state.store.find_rule = AsyncMock(return_value=_stub_rule())
    app.state.store.upsert_breakdown = AsyncMock()
    client.post("/v1/tco/compute", json={
        "run_id": "x", "wall_clock_s": 100, "workload_mode": "training",
        "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 1, "utilization": 0.5}],
        "persist": False,
    })
    app.state.store.upsert_breakdown.assert_not_awaited()


def test_compute_storage_tier(client, app):
    storage_rule = _stub_rule(
        id="storage/nvme-tlc/v2026q1", resource_kind="storage",
        vendor_sku="Generic/NVMe-TLC", storage_usd_per_gb_month=0.05,
        capex_usd=None, power_w_idle=None, power_w_load=None, pue_assumed=None,
    )

    async def find_rule(kind, sku):
        if kind == "storage":
            return storage_rule
        return _stub_rule()

    app.state.store.find_rule = find_rule
    app.state.store.upsert_breakdown = AsyncMock()
    r = client.post("/v1/tco/compute", json={
        "run_id": "x", "wall_clock_s": 7200, "workload_mode": "training",
        "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 8, "utilization": 0.6}],
        "storage": [{"tier": "hot", "gb": 1000}],
    })
    assert r.status_code == 200
    assert r.json()["storage_opex_usd"] >= 0


def test_compute_failure_model(client, app):
    app.state.store.find_rule = AsyncMock(return_value=_stub_rule())
    app.state.store.upsert_breakdown = AsyncMock()
    r = client.post("/v1/tco/compute", json={
        "run_id": "x", "wall_clock_s": 86400, "workload_mode": "training",
        "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 8, "utilization": 0.6}],
        "failure": {"expected_restart_fraction": 0.1, "extra_wall_clock_h": 6.0},
    })
    assert r.status_code == 200
    assert r.json()["failure_penalty_usd"] > 0


def test_get_breakdown_404(client, app):
    app.state.store.get_breakdown = AsyncMock(return_value=None)
    assert client.get("/v1/tco/runs/missing").status_code == 404


def test_get_breakdown_returns(client, app):
    app.state.store.get_breakdown = AsyncMock(return_value={"run_id": "x", "total_usd": 100.0})
    r = client.get("/v1/tco/runs/x")
    assert r.status_code == 200
    assert r.json()["total_usd"] == 100.0


def test_list_rules(client, app):
    app.state.store.list_rules = AsyncMock(return_value=[_stub_rule()])
    r = client.get("/v1/tco/rules?resource_kind=gpu")
    assert r.status_code == 200
    assert r.json()[0]["resource_kind"] == "gpu"


def test_compare_two_designs(client, app):
    app.state.store.find_rule = AsyncMock(return_value=_stub_rule())
    app.state.store.upsert_breakdown = AsyncMock()
    body = {
        "a": {
            "run_id": "a", "wall_clock_s": 3600, "workload_mode": "training",
            "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 8, "utilization": 0.5}],
            "persist": False, "include_sensitivities": False,
        },
        "b": {
            "run_id": "b", "wall_clock_s": 3600, "workload_mode": "training",
            "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 16, "utilization": 0.5}],
            "persist": False, "include_sensitivities": False,
        },
    }
    r = client.post("/v1/tco/compare", json=body)
    assert r.status_code == 200
    delta = r.json()["delta_b_minus_a"]
    assert delta["total_usd"] > 0  # B (16 gpus) costs more than A (8 gpus)


def test_compare_refuses_different_rule_versions(client, app):
    """If two computes resolve to different rule_versions, comparing is invalid."""
    rule_v1 = _stub_rule(id="gpu/B200/v2026q1")
    rule_v2 = _stub_rule(id="gpu/B200/v2026q2")  # different version

    calls = {"n": 0}

    async def find_rule(kind, sku):
        calls["n"] += 1
        # First two calls (resolving design A): v1; next two: v2
        return rule_v1 if calls["n"] <= 1 else rule_v2

    app.state.store.find_rule = find_rule
    body = {
        "a": {"run_id": "a", "wall_clock_s": 3600, "workload_mode": "training",
              "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 1, "utilization": 0.5}],
              "persist": False},
        "b": {"run_id": "b", "wall_clock_s": 3600, "workload_mode": "training",
              "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 1, "utilization": 0.5}],
              "persist": False},
    }
    r = client.post("/v1/tco/compare", json=body)
    assert r.status_code == 400
    assert "rule_versions differ" in r.json()["detail"]


def test_compute_inference_workload(client, app):
    app.state.store.find_rule = AsyncMock(return_value=_stub_rule())
    app.state.store.upsert_breakdown = AsyncMock()
    r = client.post("/v1/tco/compute", json={
        "run_id": "inf-1", "wall_clock_s": 3600, "workload_mode": "inference",
        "gpus": [{"vendor_sku": "Nvidia/B200-180GB", "count": 4, "utilization": 0.7}],
        "inference_requests": 1_000_000.0,
    })
    assert r.status_code == 200
    assert r.json()["per_inference_request_usd"] is not None
