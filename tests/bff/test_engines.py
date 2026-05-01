"""§2 BFF /v1/engines passthrough (RFC-001 v2)."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _new_app():
    from app.api import engines  # type: ignore
    app = FastAPI()
    app.include_router(engines.router)
    app.state.engine_registry_svc = AsyncMock()
    return app


@pytest.fixture
def app():
    return _new_app()


@pytest.fixture
def client(app):
    return TestClient(app)


def _v2_payload() -> dict:
    return {
        "cluster": {"gpu_model": "B200", "gpu_count": 1024},
        "workload": {"workload_family": "transformer-dense", "mode": "training",
                     "quant": "FP8", "seq_len": 8192, "global_batch": 4096,
                     "activated_params_b": 8.0, "total_params_b": 8.0},
        "strategy": {"TP": 8, "PP": 8, "EP": 1, "CP": 2,
                     "recompute": "selective", "overlap": "ZBv2"},
    }


def test_list_engines(client, app):
    app.state.engine_registry_svc.list_engines = AsyncMock(return_value=[
        {"name": "surrogate-analytical", "version": "v0.2.0", "fidelity": "analytical"},
    ])
    r = client.get("/v1/engines")
    assert r.status_code == 200
    assert r.json()[0]["name"] == "surrogate-analytical"


def test_list_engines_with_status_filter(client, app):
    """v2: only `status` filter passes through; `domain` is gone."""
    app.state.engine_registry_svc.list_engines = AsyncMock(return_value=[])
    client.get("/v1/engines?status=active")
    app.state.engine_registry_svc.list_engines.assert_awaited_with(status="active")


def test_list_engines_502_on_error(client, app):
    app.state.engine_registry_svc.list_engines = AsyncMock(side_effect=RuntimeError("down"))
    assert client.get("/v1/engines").status_code == 502


def test_get_engine(client, app):
    app.state.engine_registry_svc.get_engine = AsyncMock(return_value={"name": "x"})
    r = client.get("/v1/engines/x")
    assert r.status_code == 200


def test_get_engine_404(client, app):
    app.state.engine_registry_svc.get_engine = AsyncMock(side_effect=RuntimeError("404 not found"))
    assert client.get("/v1/engines/missing").status_code == 404


def test_get_engine_502(client, app):
    app.state.engine_registry_svc.get_engine = AsyncMock(side_effect=RuntimeError("conn refused"))
    assert client.get("/v1/engines/x").status_code == 502


def test_engine_predict_forwards_v2_payload(client, app):
    app.state.engine_registry_svc.predict = AsyncMock(return_value={
        "mfu_pct": 50, "step_ms": 1000, "confidence": 0.9,
        "_provenance": {"engine": "surrogate-analytical", "version": "v0.2.0",
                        "fidelity": "analytical"},
    })
    r = client.post("/v1/engines/predict", json={
        "payload": _v2_payload(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["_provenance"]["engine"] == "surrogate-analytical"
    awaited = app.state.engine_registry_svc.predict.await_args.args[0]
    # No `domain` field — only payload + optional routing knobs (RFC-001 v2)
    assert "domain" not in awaited
    assert "payload" in awaited


def test_engine_predict_with_engine_preference(client, app):
    app.state.engine_registry_svc.predict = AsyncMock(return_value={
        "mfu_pct": 30, "_provenance": {"engine": "astra-sim", "selected_by": "engine_preference"},
    })
    client.post("/v1/engines/predict", json={
        "payload": _v2_payload(),
        "engine_preference": "astra-sim",
    })
    awaited = app.state.engine_registry_svc.predict.await_args.args[0]
    assert awaited["engine_preference"] == "astra-sim"


def test_engine_predict_502_on_engine_crash(client, app):
    app.state.engine_registry_svc.predict = AsyncMock(side_effect=RuntimeError("engine 'astra-sim' failed"))
    r = client.post("/v1/engines/predict", json={"payload": _v2_payload()})
    assert r.status_code == 502


def test_engine_predict_propagates_upstream_503():
    """When engine-registry returns 503 (no matching engine for the request
    envelope), BFF must surface the same 503 — not collapse it to 502."""
    import httpx
    from unittest.mock import AsyncMock
    app = _new_app()
    response = httpx.Response(503,
                              json={"detail": "no engine covers this request",
                                    "misses": {"surrogate-analytical": []}},
                              request=httpx.Request("POST", "http://x/v1/predict"))
    app.state.engine_registry_svc.predict = AsyncMock(
        side_effect=httpx.HTTPStatusError("503", request=response.request, response=response)
    )
    client = TestClient(app)
    r = client.post("/v1/engines/predict", json={"payload": _v2_payload()})
    assert r.status_code == 503
