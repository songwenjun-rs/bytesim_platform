"""Cover engine-svc pipeline + artifacts + clients + helpers."""
from __future__ import annotations

import asyncio
import os
import tempfile
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest


def _surrogate_pred(*, feasible=True, mfu=55.0):
    return {
        "mfu_pct": mfu, "step_ms": 500.0, "cost_per_m_tok_usd": 0.4,
        "peak_kw": 700.0, "ttft_ms": 80.0, "tpot_ms": 25.0,
        "confidence": 0.9, "feasible": feasible, "notes": [] if feasible else ["x"],
    }


# ── Pure helpers + Pipeline ──────────────────────────────────────────

def test_strat_label_format():
    from app.pipeline import _strat_label
    s = {"TP": 4, "PP": 8, "EP": 8, "overlap": "ZBv2"}
    assert _strat_label(s) == "TP4·PP8·EP8·ZBv2"


def test_now_iso_format():
    from app.pipeline import _now_iso
    out = _now_iso()
    assert out.endswith("Z") and "T" in out


@pytest.mark.asyncio
async def test_pipeline_executes_full_run(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-1", "kind": "train", "kpis": {},
                                                "surrogate_ver": "v2.4", "inputs_hash": "h"})
    backends.predict = AsyncMock(side_effect=lambda payload, **_: _surrogate_pred(mfu=50 + payload["strategy"]["TP"]))
    backends.patch_run = AsyncMock()
    backends.compute_tco = AsyncMock(return_value={"total_usd": 123.45})
    bus = AsyncMock()

    p = Pipeline(backends, bus)
    await p.execute("sim-1")

    # Verify final patch carried status=done
    final_calls = [c.kwargs for c in backends.patch_run.call_args_list]
    payload_chain = [c["body"] if "body" in c else c for c in final_calls]
    # Inspect raw positional/kwargs:
    statuses = []
    for call in backends.patch_run.call_args_list:
        args, kwargs = call.args, call.kwargs
        body = args[1] if len(args) > 1 else kwargs.get("body")
        if isinstance(body, dict) and body.get("status"):
            statuses.append(body["status"])
    assert "done" in statuses
    # Bus published lifecycle events
    kinds = {c.args[0]["kind"] for c in bus.publish.call_args_list}
    assert "run.started" in kinds and "run.completed" in kinds


@pytest.mark.asyncio
async def test_pipeline_cancellation_after_validate(tmp_path, monkeypatch):
    """Cancel mid-flight: monkeypatch the validate stage to trigger the cancel
    so the post-validate guard catches it on the next stage boundary."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-2", "kind": "train", "kpis": {}})
    backends.predict = AsyncMock(return_value=_surrogate_pred())
    backends.patch_run = AsyncMock()
    bus = AsyncMock()

    p = Pipeline(backends, bus)

    original_validate = p._validate

    async def cancel_inside_validate(run):
        await original_validate(run)
        p.cancel(run["id"])

    p._validate = cancel_inside_validate  # type: ignore[assignment]
    await p.execute("sim-2")

    kinds = {c.args[0]["kind"] for c in bus.publish.call_args_list}
    assert "run.cancelled" in kinds


@pytest.mark.asyncio
async def test_pipeline_stamps_engine_provenance_in_kpis(tmp_path, monkeypatch):
    """§2: when engine-registry returns a _provenance block on the predict
    response, the pipeline should propagate it into bs_run.kpis so audit /
    comparison can answer 'which engine produced this result'."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-prov", "kind": "train", "kpis": {}})
    pred_with_prov = {
        **_surrogate_pred(),
        "_provenance": {"engine": "surrogate-analytical", "version": "v0.1.0",
                         "domain": "compute", "granularity": "analytical",
                         "confidence": 0.92, "latency_ms": 8.5, "selected_by": "auto"},
    }
    backends.predict = AsyncMock(return_value=pred_with_prov)
    backends.patch_run = AsyncMock()
    backends.compute_tco = AsyncMock(return_value={})
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-prov")

    # Find the patch call that wrote the final kpis (status=done)
    final_kpis = None
    for call in backends.patch_run.call_args_list:
        body = call.args[1] if len(call.args) > 1 else call.kwargs.get("body", {})
        if isinstance(body, dict) and body.get("status") == "done":
            final_kpis = body.get("kpis")
            break
    assert final_kpis is not None, "no done patch with kpis found"
    assert "_engine_provenance" in final_kpis
    assert final_kpis["_engine_provenance"]["engine"] == "surrogate-analytical"


@pytest.mark.asyncio
async def test_pipeline_forwards_attribution_into_kpis(tmp_path, monkeypatch):
    """S1.1 attribution forward: engine-svc historically cherry-picked 6
    numeric KPIs and dropped the structured `bottleneck` /
    `phase_breakdown` / KV fields. Without forwarding them, the UI's
    visualization stack (BottleneckCard, FabricView overlay, phase chart)
    has nothing to render. Lock the contract here so a future cherry-pick
    refactor can't silently regress visualization."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-attrib", "kind": "infer", "kpis": {}})
    pred_with_attrib = {
        **_surrogate_pred(),
        "bottleneck": {
            "primary": "nvlink", "severity": "high",
            "headline": "NVLink 链路 nv-1 利用率 94%",
            "suggested_action": "TP=8 → TP=4",
            "links": [{"id": "nv-1", "fabric": "nvlink",
                       "util_pct": 94.0, "severity": "high"}],
            "nodes": [],
        },
        "phase_breakdown": [
            {"phase": "compute", "ms": 320.0},
            {"phase": "comm",    "ms":  90.0},
            {"phase": "mem_stall", "ms": 45.0},
            {"phase": "idle",    "ms":  45.0},
        ],
        "kv_hit_rate": 0.78,
        "cache_pressure_pct": 65.0,
        "spill_bytes_per_s": 0.0,
    }
    backends.predict = AsyncMock(return_value=pred_with_attrib)
    backends.patch_run = AsyncMock()
    backends.compute_tco = AsyncMock(return_value={})
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-attrib")

    final_kpis = None
    for call in backends.patch_run.call_args_list:
        body = call.args[1] if len(call.args) > 1 else call.kwargs.get("body", {})
        if isinstance(body, dict) and body.get("status") == "done":
            final_kpis = body.get("kpis")
            break
    assert final_kpis is not None
    # Structured attribution is forwarded verbatim
    assert final_kpis["bottleneck"]["primary"] == "nvlink"
    assert final_kpis["bottleneck"]["headline"].startswith("NVLink")
    assert len(final_kpis["phase_breakdown"]) == 4
    assert final_kpis["phase_breakdown"][0]["phase"] == "compute"
    # KV fields forwarded as scalars
    assert final_kpis["kv_hit_rate"] == 0.78
    assert final_kpis["cache_pressure_pct"] == 65.0
    assert final_kpis["spill_bytes_per_s"] == 0.0


@pytest.mark.asyncio
async def test_pipeline_omits_attribution_when_engine_did_not_emit(tmp_path, monkeypatch):
    """When the engine doesn't attribute, no empty/null fields show up in
    kpis — UI's `getRunMetrics` distinguishes "absent" from "no
    bottleneck", and a stray `bottleneck: null` would confuse that
    distinction."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-no-attrib", "kind": "train", "kpis": {}})
    backends.predict = AsyncMock(return_value=_surrogate_pred())  # no attribution
    backends.patch_run = AsyncMock()
    backends.compute_tco = AsyncMock(return_value={})
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-no-attrib")

    final_kpis = None
    for call in backends.patch_run.call_args_list:
        body = call.args[1] if len(call.args) > 1 else call.kwargs.get("body", {})
        if isinstance(body, dict) and body.get("status") == "done":
            final_kpis = body.get("kpis")
            break
    assert final_kpis is not None
    assert "bottleneck" not in final_kpis
    assert "phase_breakdown" not in final_kpis
    assert "kv_hit_rate" not in final_kpis


@pytest.mark.asyncio
async def test_pipeline_calls_tco_engine_at_attribution(tmp_path, monkeypatch):
    """§5: pipeline must invoke tco-engine-svc.compute on a successful run."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-tco", "kind": "train", "kpis": {}})
    backends.predict = AsyncMock(return_value=_surrogate_pred())
    backends.patch_run = AsyncMock()
    backends.compute_tco = AsyncMock(return_value={"total_usd": 100.0})
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-tco")

    backends.compute_tco.assert_awaited_once()
    payload = backends.compute_tco.call_args.args[0]
    assert payload["run_id"] == "sim-tco"
    assert payload["workload_mode"] == "training"
    assert payload["gpus"][0]["vendor_sku"] == "Nvidia/B200-180GB"


@pytest.mark.asyncio
async def test_pipeline_continues_when_tco_engine_fails(tmp_path, monkeypatch):
    """TCO failure must NOT fail the run pipeline (§5: best-effort)."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-tco-fail", "kind": "train", "kpis": {}})
    backends.predict = AsyncMock(return_value=_surrogate_pred())
    backends.patch_run = AsyncMock()
    backends.compute_tco = AsyncMock(side_effect=RuntimeError("tco svc down"))
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-tco-fail")

    # Run still completed
    kinds = {c.args[0]["kind"] for c in bus.publish.call_args_list}
    assert "run.completed" in kinds


@pytest.mark.asyncio
async def test_pipeline_handles_predict_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-3", "kind": "train", "kpis": {}})
    backends.predict = AsyncMock(side_effect=RuntimeError("surrogate down"))
    backends.patch_run = AsyncMock()
    bus = AsyncMock()

    p = Pipeline(backends, bus)
    await p.execute("sim-3")

    kinds = {c.args[0]["kind"] for c in bus.publish.call_args_list}
    assert "run.failed" in kinds


@pytest.mark.asyncio
async def test_pipeline_uses_strategy_override(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    override = {"TP": 1, "PP": 2, "EP": 4, "CP": 1, "recompute": "selective", "overlap": "ZBv2"}
    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={"id": "sim-4", "kind": "train",
                                                "kpis": {"_strategy_override": override}})
    backends.predict = AsyncMock(return_value=_surrogate_pred())
    backends.patch_run = AsyncMock()
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-4")
    seen_strats = [c.args[0]["strategy"] for c in backends.predict.call_args_list]
    assert override in seen_strats


@pytest.mark.asyncio
async def test_pipeline_honors_cluster_and_workload_overrides(tmp_path, monkeypatch):
    """The new /sim/training and /sim/inference pages ship cluster_override +
    workload_override; engine-svc must merge them over its DEFAULT_CLUSTER /
    DEFAULT_WORKLOAD so the prediction reflects what the user asked for."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={
        "id": "sim-6", "kind": "infer",
        "kpis": {
            "_cluster_override": {"gpu_model": "H200", "gpu_count": 32, "pue": 1.22},
            "_workload_override": {"mode": "inference", "activated_params_b": 37},
        },
    })
    backends.predict = AsyncMock(return_value=_surrogate_pred())
    backends.patch_run = AsyncMock()
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-6")

    # Every predict call should carry the merged cluster + workload.
    for c in backends.predict.call_args_list:
        req = c.args[0]
        assert req["cluster"]["gpu_model"] == "H200"
        assert req["cluster"]["gpu_count"] == 32
        assert req["cluster"]["pue"] == 1.22
        assert req["workload"]["mode"] == "inference"
        assert req["workload"]["activated_params_b"] == 37


@pytest.mark.asyncio
async def test_pipeline_uses_strategy_override(tmp_path, monkeypatch):
    """When a Run carries _strategy_override, the pipeline should run that
    exact strategy first, then 4 neighbours."""
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    from app.pipeline import Pipeline

    pinned = {"TP": 2, "PP": 4, "EP": 8, "CP": 1, "recompute": "full", "overlap": "Chimera"}
    backends = AsyncMock()
    backends.get_run = AsyncMock(return_value={
        "id": "sim-5", "kind": "train",
        "kpis": {"_strategy_override": pinned},
    })
    backends.predict = AsyncMock(return_value=_surrogate_pred())
    backends.patch_run = AsyncMock()
    bus = AsyncMock()
    p = Pipeline(backends, bus)
    await p.execute("sim-5")
    seen_strats = [c.args[0]["strategy"] for c in backends.predict.call_args_list]
    assert pinned in seen_strats


# ── Artifacts ────────────────────────────────────────────────────────

def test_artifacts_writes_all_four_files(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    # Reload artifacts so ARTIFACTS_ROOT picks up the env var.
    import importlib
    import app.artifacts as artifacts
    importlib.reload(artifacts)

    art = artifacts.Artifacts("sim-test")
    best = {"strategy": {"TP": 4, "PP": 8, "EP": 8, "CP": 2, "recompute": "selective", "overlap": "ZBv2"},
            "mfu_pct": 55, "step_ms": 500, "cost_per_m_tok_usd": 0.4, "peak_kw": 700,
            "feasible": True, "notes": []}
    scan = [best, {**best, "mfu_pct": 50}]
    art.write_result(best, scan)
    art.write_timeline(best)
    art.write_roofline(best)
    art.write_snapshot({"inputs_hash": "h", "surrogate_ver": "v2.4"}, best["strategy"])

    out = tmp_path / "sim-test"
    assert (out / "result.json").exists()
    assert (out / "timeline.json").exists()
    assert (out / "roofline.json").exists()
    assert (out / "snapshot.json").exists()
    summary = art.summary()
    assert {f["file"] for f in summary} == {"result.json", "timeline.json", "roofline.json", "snapshot.json"}


# ── Backends client wrappers ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_backends_claim_next_returns_none_on_204():
    from app.clients import Backends

    def handler(req):
        return httpx.Response(204)

    b = Backends()
    b.run = httpx.AsyncClient(base_url="http://run", transport=httpx.MockTransport(handler))
    out = await b.claim_next()
    assert out is None
    await b.close()


@pytest.mark.asyncio
async def test_backends_claim_next_returns_run():
    from app.clients import Backends

    def handler(req): return httpx.Response(200, json={"id": "sim-x"})

    b = Backends()
    b.run = httpx.AsyncClient(base_url="http://run", transport=httpx.MockTransport(handler))
    out = await b.claim_next()
    assert out == {"id": "sim-x"}
    await b.close()


@pytest.mark.asyncio
async def test_backends_predict_via_registry_when_env_set(monkeypatch):
    """§2: when ENGINE_REGISTRY_URL is set, predict() wraps payload as
    {domain, payload} for the registry's /v1/predict endpoint."""
    monkeypatch.setenv("ENGINE_REGISTRY_URL", "http://reg:8089")
    from app.clients import Backends
    import httpx as _httpx

    captured = {}

    def handler(req):
        captured["body"] = req.read()
        return _httpx.Response(200, json={"mfu_pct": 50, "_provenance": {"engine": "x"}})

    b = Backends()
    b.engine_registry = _httpx.AsyncClient(base_url="http://reg:8089",
                                             transport=_httpx.MockTransport(handler))
    out = await b.predict({"cluster": {}, "workload": {}, "strategy": {"TP": 4}})
    assert out["mfu_pct"] == 50
    assert out["_provenance"]["engine"] == "x"
    # RFC-001 v2: body is {payload: ...} only — no `domain` hint.
    import json
    body = json.loads(captured["body"])
    assert "domain" not in body
    assert "payload" in body
    assert body["payload"]["strategy"]["TP"] == 4
    await b.close()


@pytest.mark.asyncio
async def test_backends_get_patch_predict():
    from app.clients import Backends

    def handler(req):
        if req.url.path.startswith("/v1/predict"):
            return httpx.Response(200, json={"mfu_pct": 50})
        if req.method == "PATCH":
            return httpx.Response(200, json={"patched": True})
        return httpx.Response(200, json={"id": req.url.path.split("/")[-1]})

    b = Backends()
    b.run = httpx.AsyncClient(base_url="http://run", transport=httpx.MockTransport(handler))
    b.engine_registry = httpx.AsyncClient(base_url="http://reg", transport=httpx.MockTransport(handler))

    assert (await b.get_run("r1"))["id"] == "r1"
    assert (await b.patch_run("r1", {"status": "done"}))["patched"] is True
    # In test env (no ENGINE_REGISTRY_URL set) predict() falls back to direct
    # /v1/predict shape, so the legacy single-engine path is also exercised.
    assert (await b.predict({"strategy": {}}))["mfu_pct"] == 50
    assert (await b.list_queued())["id"] == "runs"
    await b.close()


# ── Event bus ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_event_bus_publish_noop_when_not_started():
    from app.event_bus import EventBus
    bus = EventBus()
    # Should not raise even though _producer is None.
    await bus.publish({"kind": "x"})


# ── main app importable ──────────────────────────────────────────────

def test_main_routes_present():
    from app.main import app
    paths = {r.path for r in app.routes if hasattr(r, "path")}
    assert "/healthz" in paths
    assert "/v1/engine/kick/{run_id}" in paths
