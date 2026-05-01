"""EnginePredictRequest / EnginePredictResponse schema."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from engine_contracts import (
    BottleneckAttribution,
    Cluster,
    EnginePredictRequest,
    EnginePredictResponse,
    FabricLink,
    KPIBreakdown,
    KVCacheConfig,
    LinkAttribution,
    NodeAttribution,
    PhaseBreakdownEntry,
    StrategyParams,
    Workload,
)


def _request() -> EnginePredictRequest:
    return EnginePredictRequest(
        cluster=Cluster(gpu_model="B200", gpu_count=1024),
        workload=Workload(
            mode="training", workload_family="transformer-dense",
            seq_len=8192, global_batch=4096,
            activated_params_b=405, total_params_b=405, quant="FP8",
        ),
        strategy=StrategyParams(TP=8, PP=8, EP=1, CP=2,
                                 recompute="selective", overlap="ZBv2"),
    )


def _response() -> EnginePredictResponse:
    return EnginePredictResponse(
        mfu_pct=48.7, step_ms=1840.0,
        breakdown=KPIBreakdown(compute_ms=1500.0, comm_ms=300.0, mem_stall_ms=40.0),
        peak_kw=820.0, confidence=0.94, coverage_status="in_dist",
    )


# ── request ──────────────────────────────────────────────────────────────


class TestRequest:
    def test_minimal_training_request_validates(self) -> None:
        req = _request()
        assert req.workload.mode == "training"
        assert req.strategy.TP == 8

    def test_inference_with_kvcache(self) -> None:
        req = EnginePredictRequest(
            cluster=Cluster(gpu_model="H200", gpu_count=32),
            workload=Workload(
                mode="inference", workload_family="transformer-moe",
                quant="FP8",
                kvcache_config=KVCacheConfig(
                    kv_size_gb_per_seq=0.020,
                    prefix_share_ratio=0.6,
                    page_size_kb=16,
                    avg_active_seqs=256,
                ),
            ),
            strategy=StrategyParams(TP=8, PP=1, EP=4, CP=1),
        )
        assert req.workload.kvcache_config is not None
        assert req.workload.kvcache_config.prefix_share_ratio == 0.6

    def test_strategy_oversize_rejected(self) -> None:
        with pytest.raises(ValidationError):
            StrategyParams(TP=128, PP=1, EP=1, CP=1)  # TP > 64

    def test_unknown_gpu_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Cluster(gpu_model="H800", gpu_count=8)  # type: ignore[arg-type]

    def test_fabric_link_validates(self) -> None:
        link = FabricLink(id="L1", src_id="A", dst_id="B",
                          fabric="infiniband", bw_gbps=400.0)
        assert link.fabric == "infiniband"

    def test_request_json_round_trip(self) -> None:
        req = _request()
        raw = req.model_dump_json()
        req2 = EnginePredictRequest.model_validate_json(raw)
        assert req2 == req


# ── response ─────────────────────────────────────────────────────────────


class TestResponse:
    def test_required_fields_only(self) -> None:
        r = _response()
        assert r.coverage_status == "in_dist"
        assert r.ttft_ms is None  # not set for training

    def test_breakdown_required(self) -> None:
        with pytest.raises(ValidationError) as ei:
            EnginePredictResponse(  # type: ignore[call-arg]
                mfu_pct=50, step_ms=1000, peak_kw=400, confidence=0.9,
            )
        assert "breakdown" in str(ei.value)

    def test_mfu_out_of_range_rejected(self) -> None:
        with pytest.raises(ValidationError):
            EnginePredictResponse(
                mfu_pct=120, step_ms=1000,
                breakdown=KPIBreakdown(compute_ms=1, comm_ms=1, mem_stall_ms=1),
                peak_kw=1, confidence=0.9,
            )

    def test_step_ms_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            EnginePredictResponse(
                mfu_pct=50, step_ms=0,  # gt=0
                breakdown=KPIBreakdown(compute_ms=0, comm_ms=0, mem_stall_ms=0),
                peak_kw=1, confidence=0.9,
            )

    def test_confidence_clamped_zero_to_one(self) -> None:
        with pytest.raises(ValidationError):
            EnginePredictResponse(
                mfu_pct=50, step_ms=10,
                breakdown=KPIBreakdown(compute_ms=1, comm_ms=1, mem_stall_ms=1),
                peak_kw=1, confidence=1.5,
            )

    def test_kv_hit_rate_clamped(self) -> None:
        # valid edge
        r = EnginePredictResponse(
            mfu_pct=50, step_ms=10,
            breakdown=KPIBreakdown(compute_ms=1, comm_ms=1, mem_stall_ms=1),
            peak_kw=1, confidence=0.9, kv_hit_rate=1.0,
        )
        assert r.kv_hit_rate == 1.0
        with pytest.raises(ValidationError):
            EnginePredictResponse(
                mfu_pct=50, step_ms=10,
                breakdown=KPIBreakdown(compute_ms=1, comm_ms=1, mem_stall_ms=1),
                peak_kw=1, confidence=0.9, kv_hit_rate=1.5,  # > 1
            )

    def test_extrapolated_status_allowed(self) -> None:
        """Per RFC §6 decision #2 — engines may report extrapolation honestly,
        envelope still gates routing."""
        r = EnginePredictResponse(
            mfu_pct=50, step_ms=10,
            breakdown=KPIBreakdown(compute_ms=1, comm_ms=1, mem_stall_ms=1),
            peak_kw=1, confidence=0.6, coverage_status="extrapolated",
        )
        assert r.coverage_status == "extrapolated"

    def test_rejected_status_not_a_valid_response(self) -> None:
        """RFC §2.4: engines must return HTTP 422 for envelope misses, never
        a 200 with coverage_status='rejected'."""
        with pytest.raises(ValidationError):
            EnginePredictResponse(
                mfu_pct=50, step_ms=10,
                breakdown=KPIBreakdown(compute_ms=1, comm_ms=1, mem_stall_ms=1),
                peak_kw=1, confidence=0.6,
                coverage_status="rejected",  # type: ignore[arg-type]
            )

    def test_response_json_round_trip(self) -> None:
        r = _response()
        raw = r.model_dump_json()
        r2 = EnginePredictResponse.model_validate_json(raw)
        assert r2 == r


# ── S1 attribution schema ────────────────────────────────────────────────


class TestBottleneckAttribution:
    """Lock the visualization-grade attribution contract.

    These types feed UI reverse-projection (RackCanvas / Fabric overlays).
    Anything that tightens validation here ripples to every engine — the
    tests document what producers must always emit and what consumers may
    rely on."""

    def test_minimal_attribution(self) -> None:
        b = BottleneckAttribution(
            primary="compute", severity="low",
            headline="以计算为主，MFU 48%",
        )
        assert b.links == [] and b.nodes == []
        assert b.suggested_action is None

    def test_full_attribution_with_geometry(self) -> None:
        b = BottleneckAttribution(
            primary="nvlink", severity="high",
            headline="NVLink 链路 L1 利用率 94%",
            suggested_action="TP=8 → TP=4",
            links=[
                LinkAttribution(id="L1", fabric="nvlink",
                                util_pct=94.0, severity="high",
                                contributes_ms=12.4),
                LinkAttribution(id="L2", fabric="nvlink",
                                util_pct=82.0, severity="med"),
            ],
            nodes=[
                NodeAttribution(id="rack-A.srv-3.gpu-2",
                                issue="kv_spill", severity="med",
                                metrics={"spill_pct": 0.12}),
            ],
        )
        assert b.links[0].contributes_ms == 12.4
        assert b.nodes[0].metrics["spill_pct"] == 0.12

    def test_link_attribution_util_clamped(self) -> None:
        with pytest.raises(ValidationError):
            LinkAttribution(id="L1", fabric="nvlink",
                            util_pct=120.0, severity="high")

    def test_link_attribution_id_nonempty(self) -> None:
        with pytest.raises(ValidationError):
            LinkAttribution(id="", fabric="nvlink",
                            util_pct=50.0, severity="med")

    def test_unknown_bottleneck_kind_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BottleneckAttribution(
                primary="cpu_bound",  # type: ignore[arg-type]
                severity="low", headline="x",
            )

    def test_unknown_severity_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BottleneckAttribution(
                primary="compute",
                severity="critical",  # type: ignore[arg-type]
                headline="x",
            )

    def test_headline_required(self) -> None:
        with pytest.raises(ValidationError):
            BottleneckAttribution(  # type: ignore[call-arg]
                primary="compute", severity="low",
            )

    def test_attribution_attaches_to_response(self) -> None:
        r = EnginePredictResponse(
            mfu_pct=50, step_ms=10,
            breakdown=KPIBreakdown(compute_ms=8, comm_ms=1, mem_stall_ms=1),
            peak_kw=1, confidence=0.9,
            bottleneck=BottleneckAttribution(
                primary="compute", severity="low", headline="计算为主",
            ),
            phase_breakdown=[
                PhaseBreakdownEntry(phase="compute", ms=8.0),
                PhaseBreakdownEntry(phase="comm", ms=1.0),
            ],
        )
        assert r.bottleneck is not None
        assert r.bottleneck.primary == "compute"
        assert r.phase_breakdown is not None
        assert len(r.phase_breakdown) == 2

    def test_attribution_optional(self) -> None:
        """Engines that can't attribute leave both fields None — consumers
        must treat absence as 'engine did not attribute', never as 'no
        bottleneck exists'."""
        r = _response()
        assert r.bottleneck is None
        assert r.phase_breakdown is None

    def test_attribution_round_trip(self) -> None:
        r = EnginePredictResponse(
            mfu_pct=50, step_ms=10,
            breakdown=KPIBreakdown(compute_ms=8, comm_ms=1, mem_stall_ms=1),
            peak_kw=1, confidence=0.9,
            bottleneck=BottleneckAttribution(
                primary="leaf_spine", severity="high",
                headline="IB 链路饱和",
                links=[LinkAttribution(id="ib-1", fabric="infiniband",
                                       util_pct=92.0, severity="high")],
            ),
        )
        raw = r.model_dump_json()
        r2 = EnginePredictResponse.model_validate_json(raw)
        assert r2 == r
        assert r2.bottleneck is not None
        assert r2.bottleneck.links[0].fabric == "infiniband"
