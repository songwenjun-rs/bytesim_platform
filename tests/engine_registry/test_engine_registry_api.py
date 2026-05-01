"""HTTP-level tests for engine-registry-svc (RFC-001 v2)."""
from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient


_ENVELOPE = {
    "workload_families": ["transformer-dense"],
    "parallelism": {"TP": [1, 64], "PP": [1, 64], "EP": [1, 64], "CP": [1, 8],
                    "recompute": ["selective"], "overlap": ["1F1B", "ZBv2"]},
    "hardware": {"gpu_models": ["B200", "H200"], "fabric": ["nvlink", "infiniband"],
                 "scale_gpus": [4, 8192]},
    "quant": ["BF16", "FP8"], "modes": ["training", "inference"],
}

_PAYLOAD = {
    "cluster": {"gpu_model": "B200", "gpu_count": 1024},
    "workload": {"workload_family": "transformer-dense", "mode": "training",
                 "quant": "FP8", "seq_len": 8192, "global_batch": 4096,
                 "activated_params_b": 8.0, "total_params_b": 8.0},
    "strategy": {"TP": 8, "PP": 8, "EP": 1, "CP": 2,
                 "recompute": "selective", "overlap": "ZBv2"},
}


@pytest.fixture
def app(monkeypatch):
    from app.main import app as fastapi_app  # type: ignore
    fastapi_app.router.lifespan_context = None
    fastapi_app.state.store = AsyncMock()
    fastapi_app.state.client = None  # tests inject per-test
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


def _engine(**overrides):
    base = {
        "name": "surrogate-analytical", "version": "v0.2.0",
        "fidelity": "analytical", "sla_p99_ms": 100,
        "endpoint": "http://surrogate-svc:8083",
        "predict_path": "/v1/predict",
        "coverage_envelope": _ENVELOPE,
        "kpi_outputs": ["mfu_pct", "step_ms"],
        "calibration": {},
        "status": "active",
    }
    base.update(overrides)
    return base


# ── Read endpoints ───────────────────────────────────────────────────


def test_healthz(client):
    assert client.get("/healthz").status_code == 200


def test_list_engines(client, app):
    app.state.store.list_engines = AsyncMock(return_value=[_engine()])
    r = client.get("/v1/engines")
    assert r.status_code == 200
    assert r.json()[0]["name"] == "surrogate-analytical"


def test_list_engines_with_status_filter(client, app):
    app.state.store.list_engines = AsyncMock(return_value=[])
    client.get("/v1/engines?status=deprecated")
    app.state.store.list_engines.assert_awaited_with(status="deprecated")


def test_get_engine_404(client, app):
    app.state.store.get_engine = AsyncMock(return_value=None)
    assert client.get("/v1/engines/missing").status_code == 404


def test_get_engine_ok(client, app):
    app.state.store.get_engine = AsyncMock(return_value=_engine())
    r = client.get("/v1/engines/surrogate-analytical")
    assert r.status_code == 200


# ── Self-registration ────────────────────────────────────────────────


def test_register_envelope_matches_capabilities_endpoint(client, app):
    """Reverse-fetch GET /v1/capabilities; envelope must match register
    body. This is the anti-self-attest defence (RFC §2.6)."""
    app.state.store.upsert_engine = AsyncMock(return_value=_engine(name="my-engine"))

    cap_body = {
        "name": "my-engine", "version": "v1", "fidelity": "analytical",
        "sla_p99_ms": 50, "coverage_envelope": _ENVELOPE,
        "kpi_outputs": ["mfu_pct"],
    }

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/v1/capabilities"
        return httpx.Response(200, json=cap_body)

    app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    r = client.post("/v1/engines/register", json={
        "name": "my-engine", "version": "v1", "fidelity": "analytical",
        "sla_p99_ms": 50, "endpoint": "http://my-engine:8000",
        "coverage_envelope": _ENVELOPE,
        "kpi_outputs": ["mfu_pct"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "my-engine"


def test_register_rejects_envelope_drift(client, app):
    """If GET /v1/capabilities returns a different envelope than the
    register body, registry rejects with 422 (RFC §2.6)."""
    app.state.store.upsert_engine = AsyncMock()

    drifted_envelope = {**_ENVELOPE, "modes": ["training"]}  # drop inference
    cap_body = {
        "name": "my-engine", "version": "v1", "fidelity": "analytical",
        "sla_p99_ms": 50, "coverage_envelope": drifted_envelope,
        "kpi_outputs": ["mfu_pct"],
    }

    def handler(req): return httpx.Response(200, json=cap_body)
    app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    r = client.post("/v1/engines/register", json={
        "name": "my-engine", "version": "v1", "fidelity": "analytical",
        "sla_p99_ms": 50, "endpoint": "http://my-engine:8000",
        "coverage_envelope": _ENVELOPE,
        "kpi_outputs": ["mfu_pct"],
    })
    assert r.status_code == 422
    assert "envelope" in r.text.lower()
    app.state.store.upsert_engine.assert_not_awaited()


def test_register_rejects_when_capabilities_unreachable(client, app):
    def handler(req): return httpx.Response(503, text="down")
    app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    r = client.post("/v1/engines/register", json={
        "name": "x", "version": "v1", "fidelity": "analytical",
        "sla_p99_ms": 50, "endpoint": "http://broken:8000",
        "coverage_envelope": _ENVELOPE, "kpi_outputs": [],
    })
    assert r.status_code == 422


def test_register_rejects_invalid_envelope_at_validation(client, app):
    """CoverageEnvelope strong schema is enforced at FastAPI request parsing
    — a bad envelope never reaches the reverse-fetch logic."""
    r = client.post("/v1/engines/register", json={
        "name": "x", "version": "v1", "fidelity": "analytical",
        "sla_p99_ms": 50, "endpoint": "http://x:8000",
        "coverage_envelope": {"workload_families": []},  # min_length=1 violation
        "kpi_outputs": [],
    })
    assert r.status_code == 422


# ── Heartbeat + deprecate ────────────────────────────────────────────


def test_heartbeat_ok(client, app):
    app.state.store.heartbeat = AsyncMock(return_value=True)
    r = client.patch("/v1/engines/x/heartbeat")
    assert r.status_code == 200


def test_heartbeat_404_when_not_active(client, app):
    app.state.store.heartbeat = AsyncMock(return_value=False)
    r = client.patch("/v1/engines/x/heartbeat")
    assert r.status_code == 404


def test_deprecate_engine(client, app):
    app.state.store.deprecate = AsyncMock(return_value=True)
    assert client.post("/v1/engines/x/deprecate").status_code == 200


def test_deprecate_404_when_not_active(client, app):
    app.state.store.deprecate = AsyncMock(return_value=False)
    assert client.post("/v1/engines/x/deprecate").status_code == 404


# ── RFC-004 calibration PATCH ────────────────────────────────────────


def test_patch_calibration_writes_mape(client, app):
    app.state.store.set_calibration = AsyncMock(return_value=True)
    r = client.patch("/v1/engines/surrogate/calibration", json={
        "profile_runs": ["snap-Q1-A"],
        "mape_pct": {"mfu": 3.2, "step_ms": 4.1},
    })
    assert r.status_code == 200
    body = r.json()
    assert body["calibration"]["mape_pct"]["mfu"] == 3.2
    awaited = app.state.store.set_calibration.await_args.args
    assert awaited[0] == "surrogate"
    assert awaited[1]["mape_pct"]["mfu"] == 3.2


def test_patch_calibration_404_when_engine_unknown(client, app):
    app.state.store.set_calibration = AsyncMock(return_value=False)
    r = client.patch("/v1/engines/missing/calibration", json={
        "mape_pct": {"mfu": 3.0},
    })
    assert r.status_code == 404


def test_patch_calibration_extras_passed_through(client, app):
    app.state.store.set_calibration = AsyncMock(return_value=True)
    client.patch("/v1/engines/x/calibration", json={
        "mape_pct": {"mfu": 2.0},
        "extras": {"engine_version": "v0.2.0"},
    })
    awaited = app.state.store.set_calibration.await_args.args[1]
    assert awaited["engine_version"] == "v0.2.0"


# ── /v1/predict ──────────────────────────────────────────────────────


def _engine_response_body() -> dict:
    """A valid EnginePredictResponse the contract validator will accept."""
    return {
        "mfu_pct": 55, "step_ms": 500,
        "breakdown": {"compute_ms": 350, "comm_ms": 100,
                       "mem_stall_ms": 30, "idle_ms": 20},
        "peak_kw": 800, "confidence": 0.92,
        "coverage_status": "in_dist",
    }


def test_predict_routes_and_stamps_provenance(client, app):
    app.state.store.list_engines = AsyncMock(return_value=[_engine()])

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/v1/predict"
        return httpx.Response(200, json=_engine_response_body())

    app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    r = client.post("/v1/predict", json={"payload": _PAYLOAD})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mfu_pct"] == 55
    assert "_provenance" in body
    p = body["_provenance"]
    assert p["engine"] == "surrogate-analytical"
    assert p["fidelity"] == "analytical"
    assert p["confidence"] == 0.92
    assert p["coverage_status"] == "in_dist"
    assert p["selected_by"] == "auto"
    assert p["latency_ms"] >= 0


def test_predict_503_when_no_engines_at_all(client, app):
    app.state.store.list_engines = AsyncMock(return_value=[])
    r = client.post("/v1/predict", json={"payload": _PAYLOAD})
    assert r.status_code == 503


def test_predict_503_explains_misses(client, app):
    """503 body lists exact field-level misses for each candidate engine
    (RFC §2.5 enhancement)."""
    narrow_envelope = {**_ENVELOPE, "modes": ["inference"]}  # rejects training
    app.state.store.list_engines = AsyncMock(
        return_value=[_engine(coverage_envelope=narrow_envelope)],
    )
    r = client.post("/v1/predict", json={"payload": _PAYLOAD})
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "misses" in detail
    misses = detail["misses"]["surrogate-analytical"]
    fields = {m["field"] for m in misses}
    assert "mode" in fields


def test_predict_502_on_malformed_engine_response(client, app):
    """Engine returns a body that fails the contract — registry surfaces
    502 with field-level details rather than 200ing garbage."""
    app.state.store.list_engines = AsyncMock(return_value=[_engine()])

    def handler(req): return httpx.Response(200, json={"mfu_pct": 55})  # missing breakdown
    app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    r = client.post("/v1/predict", json={"payload": _PAYLOAD})
    assert r.status_code == 502
    assert "contract" in r.text.lower() or "breakdown" in r.text.lower()


def test_predict_engine_preference_marked_in_provenance(client, app):
    app.state.store.list_engines = AsyncMock(return_value=[
        _engine(name="surrogate-analytical"),
        _engine(name="other-engine", endpoint="http://other:9000"),
    ])

    def handler(req): return httpx.Response(200, json=_engine_response_body())
    app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    r = client.post("/v1/predict", json={
        "payload": _PAYLOAD, "engine_preference": "other-engine",
    })
    assert r.status_code == 200
    assert r.json()["_provenance"]["selected_by"] == "engine_preference"
    assert r.json()["_provenance"]["engine"] == "other-engine"


def test_predict_engine_422_passthrough(client, app):
    """If chosen engine returns 422 (envelope miss it discovered at runtime),
    registry surfaces it as 422 with the engine name attached."""
    app.state.store.list_engines = AsyncMock(return_value=[_engine()])

    def handler(req):
        return httpx.Response(422, json={"detail": "outside coverage"})
    app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    r = client.post("/v1/predict", json={"payload": _PAYLOAD})
    assert r.status_code == 422
    assert "surrogate-analytical" in r.text
