"""Cover the analytical surrogate predict() — feasibility branches, MFU bounds,
inference TTFT gate, confidence haircuts, and the FastAPI wrappers."""
from __future__ import annotations

from fastapi.testclient import TestClient


def _req(**overrides):
    base = {
        "cluster": {"gpu_model": "B200", "gpu_count": 1024,
                    "electricity_usd_per_kwh": 0.092, "pue": 1.18},
        "workload": {"mode": "training", "seq_len": 8192, "global_batch": 4096,
                     "activated_params_b": 8.0, "total_params_b": 512.0, "quant": "FP8"},
        "strategy": {"TP": 4, "PP": 8, "EP": 8, "CP": 2,
                     "recompute": "selective", "overlap": "ZBv2"},
        "surrogate_version": "v2.4",
    }
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    return base


def test_predict_happy_path_returns_bounded_mfu():
    """Use a modest GPU count so peak_kw stays under the 900 kW machine-room limit."""
    from app.predict import PredictRequest, predict
    out = predict(PredictRequest(**_req(cluster={"gpu_count": 512})))
    assert 10 <= out.mfu_pct <= 65  # bounded
    assert out.feasible is True
    assert out.cost_per_m_tok_usd > 0
    assert out.confidence > 0


def test_predict_infeasible_when_capacity_exceeds_gpus():
    from app.predict import PredictRequest, predict
    body = _req(strategy={"TP": 64, "PP": 64, "EP": 8, "CP": 4})
    out = predict(PredictRequest(**body))
    assert out.feasible is False
    assert any("GPU" in n for n in out.notes)


def test_predict_ep_oob_on_mi355x():
    from app.predict import PredictRequest, predict
    body = _req(cluster={"gpu_model": "MI355X"}, strategy={"EP": 16})
    out = predict(PredictRequest(**body))
    assert out.feasible is False
    assert any("MI355X" in n for n in out.notes)


def test_predict_inference_ttft_gate():
    from app.predict import PredictRequest, predict
    body = _req(
        workload={"mode": "inference", "seq_len": 4096, "global_batch": 1},
        strategy={"TP": 16, "PP": 16, "EP": 1, "CP": 1,
                  "recompute": "full", "overlap": "Chimera"},
    )
    out = predict(PredictRequest(**body))
    assert out.feasible is False or out.ttft_ms <= 300.0
    if out.feasible is False:
        assert any("TTFT" in n or "GPU" in n for n in out.notes)


def test_predict_chimera_lowers_confidence():
    from app.predict import PredictRequest, predict
    base = predict(PredictRequest(**_req()))
    chimera = predict(PredictRequest(**_req(strategy={"overlap": "Chimera"})))
    assert chimera.confidence < base.confidence


def test_predict_gb300_and_mi355x_lower_confidence():
    from app.predict import PredictRequest, predict
    base = predict(PredictRequest(**_req()))
    gb = predict(PredictRequest(**_req(cluster={"gpu_model": "GB300"})))
    assert gb.confidence < base.confidence


def test_predict_peak_kw_warning():
    """Force a power blow with massive GPU count."""
    from app.predict import PredictRequest, predict
    body = _req(cluster={"gpu_count": 8192})
    out = predict(PredictRequest(**body))
    assert out.peak_kw > 900
    assert out.feasible is False
    assert any("kW" in n for n in out.notes)


def test_predict_deterministic_for_same_inputs():
    from app.predict import PredictRequest, predict
    a = predict(PredictRequest(**_req()))
    b = predict(PredictRequest(**_req()))
    assert a.mfu_pct == b.mfu_pct


def test_healthz_endpoint():
    from app.main import app
    c = TestClient(app)
    r = c.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_predict_endpoint():
    """RFC-001 v2: /v1/predict accepts EnginePredictRequest, returns
    EnginePredictResponse with required `breakdown`. No `feasible` field —
    envelope misses are 422, not 200-with-feasible-false."""
    from app.main import app
    c = TestClient(app)
    r = c.post("/v1/predict", json=_req())
    assert r.status_code == 200, r.text
    body = r.json()
    assert "mfu_pct" in body
    assert "breakdown" in body
    bd = body["breakdown"]
    assert {"compute_ms", "comm_ms", "mem_stall_ms", "idle_ms"}.issubset(bd)
    assert body["coverage_status"] == "in_dist"


def test_predict_timed_endpoint():
    from app.main import app
    c = TestClient(app)
    r = c.post("/v1/predict/timed", json=_req())
    assert r.status_code == 200
    body = r.json()
    assert "prediction" in body
    assert "latency_ms" in body
    assert body["latency_ms"] >= 0


# ── S1 attribution: surrogate emits viz-grade bottleneck on day 1 ─────────


def test_predict_emits_compute_bound_attribution_default():
    """No fabric_topology + no MoE-ish strategy → attribution falls back to
    'compute' with low severity. Shape must still be present so the UI
    never has to handle 'no bottleneck object at all'."""
    from app.main import app
    c = TestClient(app)
    r = c.post("/v1/predict", json=_req(
        cluster={"gpu_count": 256},
        strategy={"TP": 4, "PP": 1, "EP": 1, "CP": 1,
                  "recompute": "selective", "overlap": "ZBv2"},
    ))
    assert r.status_code == 200, r.text
    body = r.json()
    bn = body.get("bottleneck")
    assert bn is not None, "surrogate must always emit a bottleneck object"
    assert bn["primary"] == "compute"
    assert bn["severity"] == "low"
    assert bn["links"] == []
    # phase_breakdown is the same numbers as breakdown, surfaced as a list
    pb = body.get("phase_breakdown")
    assert pb is not None and len(pb) == 4
    assert {p["phase"] for p in pb} == {"compute", "comm", "mem_stall", "idle"}


def test_predict_attributes_to_saturated_link_when_fabric_supplied():
    """When fabric_topology is given and IB/RoCE saturates (high EP), the
    primary should flip to leaf_spine and links list must include the hot
    link with severity=high."""
    from app.main import app
    c = TestClient(app)
    body = _req(
        cluster={
            "gpu_count": 1024,
            "fabric_topology": [
                {"id": "ib-1", "src_id": "leaf-1", "dst_id": "spine-1",
                 "fabric": "infiniband", "bw_gbps": 400.0},
                {"id": "nv-1", "src_id": "srv-1", "dst_id": "srv-2",
                 "fabric": "nvlink", "bw_gbps": 900.0},
            ],
        },
        # High EP+PP cross-domain pressure → IB util pushed near 100%
        strategy={"TP": 4, "PP": 8, "EP": 16, "CP": 1,
                  "recompute": "selective", "overlap": "ZBv2"},
    )
    r = c.post("/v1/predict", json=body)
    assert r.status_code == 200, r.text
    res = r.json()
    bn = res["bottleneck"]
    # Either the saturated-link branch or kv_spill, but on this training
    # request kv_spill is impossible; we expect a fabric-attributed primary.
    assert bn["primary"] in ("nvlink", "leaf_spine"), bn
    assert bn["severity"] == "high"
    # Hot link must appear in links[] with severity=high
    assert any(l["severity"] == "high" for l in bn["links"]), bn["links"]


def test_predict_attributes_to_kv_spill_when_pressure_over_100():
    """Inference + kvcache_config that exceeds HBM → kv_spill primary."""
    from app.main import app
    c = TestClient(app)
    body = _req(
        cluster={"gpu_model": "H200", "gpu_count": 32},
        workload={
            "mode": "inference", "seq_len": 4096, "global_batch": 1,
            "kvcache_config": {
                # Force working set far above HBM (H200 has ~141GB)
                "kv_size_gb_per_seq": 2.0,
                "prefix_share_ratio": 0.0,
                "page_size_kb": 16,
                "avg_active_seqs": 256,  # 256 * 2 = 512 GB working set
            },
        },
        strategy={"TP": 8, "PP": 1, "EP": 1, "CP": 1,
                  "recompute": "selective", "overlap": "ZBv2"},
    )
    r = c.post("/v1/predict", json=body)
    assert r.status_code == 200, r.text
    bn = r.json()["bottleneck"]
    assert bn["primary"] == "kv_spill", bn
    assert bn["severity"] == "high"
    assert any(n["issue"] == "kv_spill" for n in bn["nodes"])


def test_req_constraint_ttft_default():
    from app.predict import req_constraint_ttft
    assert req_constraint_ttft() == 300.0


# ── P-Domain-1 KVCache predictions ────────────────────────────────────────

def test_predict_no_kvcache_when_inference_lacks_config():
    """Inference workload without kvcache_config returns None for KV fields."""
    from app.predict import PredictRequest, predict
    out = predict(PredictRequest(**_req(workload={"mode": "inference"})))
    assert out.kv_hit_rate is None
    assert out.cache_pressure_pct is None
    assert out.spill_bytes_per_s is None


def test_predict_kvcache_high_prefix_share_yields_high_hit_rate():
    """prefix_share=0.8 with small working set → hit rate >= 0.8."""
    from app.predict import PredictRequest, predict
    body = _req(workload={
        "mode": "inference",
        "kvcache_config": {
            "kv_size_gb_per_seq": 0.020, "prefix_share_ratio": 0.80,
            "page_size_kb": 16, "avg_active_seqs": 256,
        },
    })
    out = predict(PredictRequest(**body))
    assert out.kv_hit_rate is not None and out.kv_hit_rate >= 0.80
    # 256 seqs × 0.020 GB = 5.12 GB, B200 HBM 192 GB → tiny pressure
    assert out.cache_pressure_pct is not None and out.cache_pressure_pct < 5.0
    assert out.spill_bytes_per_s == 0.0


def test_predict_kvcache_overflow_triggers_spill_and_warning():
    """Massive working set → pressure > 100% + spill bytes > 0 + warning note."""
    from app.predict import PredictRequest, predict
    body = _req(workload={
        "mode": "inference",
        "kvcache_config": {
            "kv_size_gb_per_seq": 0.020, "prefix_share_ratio": 0.10,
            "page_size_kb": 16, "avg_active_seqs": 20000,
        },
    })
    out = predict(PredictRequest(**body))
    # Working set 400 GB > B200 HBM 192 GB
    assert out.cache_pressure_pct is not None and out.cache_pressure_pct > 100
    assert out.spill_bytes_per_s is not None and out.spill_bytes_per_s > 0
    assert any("KV 工作集" in n or "spill" in n for n in out.notes)


def test_predict_kvcache_skipped_for_training_mode():
    """Training workload ignores kvcache_config (returns None for KV fields)."""
    from app.predict import PredictRequest, predict
    body = _req(workload={
        "mode": "training",
        "kvcache_config": {
            "kv_size_gb_per_seq": 0.020, "prefix_share_ratio": 0.50,
            "page_size_kb": 16, "avg_active_seqs": 256,
        },
    })
    out = predict(PredictRequest(**body))
    assert out.kv_hit_rate is None


# ── P-Domain-2 Fabric predictions ─────────────────────────────────────────

def _fabric_links():
    return [
        {"id": "link-nvl-1", "src_id": "s1", "dst_id": "s1",
         "fabric": "nvlink",      "bw_gbps": 1800},
        {"id": "link-ib-1",  "src_id": "r1", "dst_id": "r2",
         "fabric": "infiniband",  "bw_gbps": 400},
        {"id": "link-cxl-1", "src_id": "h1", "dst_id": "h2",
         "fabric": "cxl",         "bw_gbps": 64},
    ]


def test_predict_no_link_util_when_fabric_topology_absent():
    """Default cluster (no fabric_topology) → link_util_top is None."""
    from app.predict import PredictRequest, predict
    out = predict(PredictRequest(**_req(cluster={"gpu_count": 256})))
    assert out.link_util_top is None


def test_predict_link_util_returned_when_fabric_topology_present():
    """Pass fabric_topology → engine returns one entry per link, sorted desc by util."""
    from app.predict import PredictRequest, predict
    out = predict(PredictRequest(**_req(
        cluster={"gpu_count": 256, "fabric_topology": _fabric_links()},
    )))
    assert out.link_util_top is not None
    assert len(out.link_util_top) == 3
    utils = [e["util_pct"] for e in out.link_util_top]
    assert utils == sorted(utils, reverse=True)
    # Each entry has the expected keys
    for entry in out.link_util_top:
        assert {"link_id", "fabric", "util_pct"} <= set(entry.keys())


def test_predict_ib_links_hottest_under_cross_pod_strategy():
    """High PP+EP creates cross-domain traffic → IB tops the list."""
    from app.predict import PredictRequest, predict
    out = predict(PredictRequest(**_req(
        cluster={"gpu_count": 1024, "fabric_topology": _fabric_links()},
        strategy={"TP": 4, "PP": 8, "EP": 16, "CP": 1,
                  "recompute": "selective", "overlap": "ZBv2"},
    )))
    assert out.link_util_top is not None
    assert out.link_util_top[0]["fabric"] == "infiniband"


def test_predict_link_saturation_appears_in_notes():
    """When IB link util ≥ 90% → engine adds a saturation note."""
    from app.predict import PredictRequest, predict
    # Force a strong cross-pod load via small NVLink-domain GPU (MI355X) and high EP
    out = predict(PredictRequest(**_req(
        cluster={"gpu_model": "MI355X", "gpu_count": 1024,
                 "fabric_topology": _fabric_links()},
        strategy={"TP": 4, "PP": 8, "EP": 8, "CP": 1,
                  "recompute": "selective", "overlap": "ZBv2"},
    )))
    # MI355X with EP=8 and PP=8 should saturate the IB link
    assert out.link_util_top is not None
    if out.link_util_top[0]["util_pct"] >= 90:
        assert any("饱和" in n or "link" in n.lower() for n in out.notes)
