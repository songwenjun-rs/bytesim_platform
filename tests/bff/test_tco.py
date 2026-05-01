"""§5 BFF TCO passthrough."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _new_app():
    from app.api import tco  # type: ignore
    app = FastAPI()
    app.include_router(tco.router)
    app.state.tco_svc = AsyncMock()
    return app


@pytest.fixture
def app():
    return _new_app()


@pytest.fixture
def client(app):
    return TestClient(app)


def test_get_run_tco(client, app):
    app.state.tco_svc.get_breakdown = AsyncMock(return_value={
        "run_id": "sim-x", "total_usd": 1234.5, "per_m_token_usd": 0.012,
    })
    r = client.get("/v1/runs/sim-x/tco")
    assert r.status_code == 200
    assert r.json()["total_usd"] == 1234.5


def test_get_run_tco_404(client, app):
    app.state.tco_svc.get_breakdown = AsyncMock(side_effect=RuntimeError("404 not found"))
    r = client.get("/v1/runs/missing/tco")
    assert r.status_code == 404


def test_get_run_tco_502_on_other_error(client, app):
    app.state.tco_svc.get_breakdown = AsyncMock(side_effect=RuntimeError("upstream broken"))
    r = client.get("/v1/runs/x/tco")
    assert r.status_code == 502


def test_list_tco_rules(client, app):
    app.state.tco_svc.list_rules = AsyncMock(return_value=[{"id": "gpu/B200/v2026q1"}])
    r = client.get("/v1/tco/rules?resource_kind=gpu")
    assert r.status_code == 200
    assert r.json()[0]["id"] == "gpu/B200/v2026q1"


def test_list_tco_rules_502(client, app):
    app.state.tco_svc.list_rules = AsyncMock(side_effect=RuntimeError("down"))
    assert client.get("/v1/tco/rules").status_code == 502


def test_compare_designs(client, app):
    app.state.tco_svc.compare = AsyncMock(return_value={
        "a": {"total_usd": 100}, "b": {"total_usd": 150}, "delta_b_minus_a": {"total_usd": 50},
    })
    r = client.post("/v1/tco/compare", json={"a": {}, "b": {}})
    assert r.status_code == 200
    assert r.json()["delta_b_minus_a"]["total_usd"] == 50


def test_compare_designs_400_on_rule_mismatch(client, app):
    app.state.tco_svc.compare = AsyncMock(side_effect=RuntimeError("rule_versions differ between A and B"))
    r = client.post("/v1/tco/compare", json={"a": {}, "b": {}})
    assert r.status_code == 400
