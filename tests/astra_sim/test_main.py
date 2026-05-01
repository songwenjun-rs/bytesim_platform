"""HTTP-level tests for astra-sim-svc (RFC-001 v2) — patches wrapper.predict
so we don't require the real binary at test time. The integration story
(binary present + output parsed) is covered by e2e.

Under v2, the request body is `EnginePredictRequest` (cluster + workload +
strategy), not the legacy {workload.collective, ...} shape. astra-sim-svc's
adapter (_to_astra_payload) translates internally before calling wrapper.predict;
the fake_predict here receives the translated dict, same as before."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def _v2_request(*, gpu_count=8, gpu_model="H200", TP=8, mode="training") -> dict:
    return {
        "cluster": {
            "gpu_model": gpu_model, "gpu_count": gpu_count,
            "fabric_topology": [
                {"id": "L1", "src_id": "A", "dst_id": "B",
                 "fabric": "infiniband", "bw_gbps": 400.0},
            ],
        },
        "workload": {
            "mode": mode, "workload_family": "transformer-dense",
            "seq_len": 8192, "global_batch": 4096,
            "activated_params_b": 8.0, "total_params_b": 8.0, "quant": "FP8",
        },
        "strategy": {"TP": TP, "PP": 1, "EP": 1, "CP": 1,
                     "recompute": "selective", "overlap": "1F1B"},
    }


@pytest.fixture
def client(monkeypatch):
    """RFC-003 — main.py now drives the chakra path via wrapper.predict_chakra.
    Patch that instead of the legacy wrapper.predict (still in wrapper.py for
    backward-compat with the bundled microbench but no longer reached from
    the v2 HTTP entry-point)."""
    import app.wrapper as wrapper

    async def fake_predict_chakra(spec, fabric_cfg):
        # marker injection via the fabric topology — the adapter copies the
        # request fabric kind into fabric_cfg, so we re-purpose it as a switch.
        if fabric_cfg.get("topology") == "BROKEN":
            from app.translator import TranslationError
            raise TranslationError("synthetic translator error")
        if fabric_cfg.get("topology") == "CRASH":
            raise RuntimeError("simulated astra-sim crash")
        return {
            "wall_time_ns":         5_000_000,
            "collective_time_ms":   5.0,        # treated as wall_time by adapter
            "comm_time_ms":         1.5,
            "sys_count":            spec.world_size,
            "trace_prefix":         "/tmp/fake/trace",
            "world_size":           spec.world_size,
            "wrapper_overhead_ms":  0.5,
            "confidence":           0.85,
        }

    monkeypatch.setattr(wrapper, "predict_chakra", fake_predict_chakra)
    from app.main import app
    # Re-bind the adapter's reference: main.py imports `predict_chakra` by
    # name into its own namespace; monkeypatching the wrapper module only
    # is not enough — patch the import-site too.
    import app.main as main_mod
    monkeypatch.setattr(main_mod, "predict_chakra", fake_predict_chakra)
    return TestClient(app)


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_capabilities_endpoint_exposes_envelope(client):
    """RFC-001 §2.6 — registry reverse-fetches GET /v1/capabilities; envelope
    must be exposed and match descriptor.

    RFC-003 widened the envelope from "bundled microbench only" to
    "any transformer-dense step the chakra writer can emit" — TP up to 16,
    PP up to 8, scale 8-1024. EP/CP still 1 until the writer models them."""
    r = client.get("/v1/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "astra-sim"
    assert body["fidelity"] == "cycle-accurate"
    env = body["coverage_envelope"]
    assert env["workload_families"] == ["transformer-dense"]
    assert env["parallelism"]["TP"] == [1, 16]
    assert env["parallelism"]["PP"] == [1, 8]
    assert env["parallelism"]["EP"] == [1, 1]   # MoE still deferred
    assert env["hardware"]["scale_gpus"] == [8, 1024]


def test_predict_happy_path_returns_v2_response(client):
    r = client.post("/v1/predict", json=_v2_request())
    assert r.status_code == 200, r.text
    body = r.json()
    # v2 contract — required fields
    assert {"mfu_pct", "step_ms", "breakdown", "peak_kw", "confidence",
            "coverage_status"}.issubset(body)
    # Breakdown carries the comm slice astra-sim measures
    assert body["breakdown"]["comm_ms"] >= 0
    # confidence comes through from the wrapper response
    assert body["confidence"] == 0.85


def test_predict_translator_error_returns_422(client):
    """RFC §2.4: envelope-miss-at-runtime maps to 422, not 400.
    fake_predict_chakra inspects fabric_cfg.topology — we inject the marker
    via a fabric kind that the adapter maps onto a 'BROKEN' topology."""
    req = _v2_request()
    # Force fabric_cfg.topology = BROKEN by manually planting it via fabric link
    # whose kind triggers the path. Simplest: clear fabric_topology and patch
    # the adapter at call site by sending an extra trigger via cluster pue
    # (overloaded for tests). Cleanest is patching _to_fabric_cfg directly.
    import app.main as main_mod
    orig = main_mod._to_fabric_cfg
    main_mod._to_fabric_cfg = lambda r: {"topology": "BROKEN", "bandwidth_gbps": 50, "latency_ns": 500}
    try:
        r = client.post("/v1/predict", json=req)
    finally:
        main_mod._to_fabric_cfg = orig
    assert r.status_code == 422
    assert "synthetic" in str(r.json()).lower()


def test_predict_engine_crash_returns_502(client):
    req = _v2_request()
    import app.main as main_mod
    orig = main_mod._to_fabric_cfg
    main_mod._to_fabric_cfg = lambda r: {"topology": "CRASH", "bandwidth_gbps": 50, "latency_ns": 500}
    try:
        r = client.post("/v1/predict", json=req)
    finally:
        main_mod._to_fabric_cfg = orig
    assert r.status_code == 502


def test_predict_rejects_v1_legacy_shape(client):
    """Legacy {workload.collective, ...} request shape must fail validation
    under v2 — Pydantic rejects unknown structure before reaching the engine."""
    r = client.post("/v1/predict", json={
        "workload": {"collective": "all_reduce"},
    })
    assert r.status_code == 422  # FastAPI request validation
