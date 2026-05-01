"""Pure-function TCO kernel tests — no PG, no FastAPI."""
from __future__ import annotations

import pytest


def _b200_gpu(count=8, util=0.6):
    from app.compute import GpuConsumption
    return GpuConsumption(
        rule_id="gpu/B200/v2026q1",
        capex_usd=39200, power_w_load=1200, power_w_idle=200,
        pue=1.18, electricity_usd_per_kwh=0.092,
        count=count, utilization=util, amortization_y=3,
    )


def _inputs(**overrides):
    from app.compute import TcoInputs
    base = dict(
        run_id="sim-x", wall_clock_s=3600, workload_mode="training",
        gpus=[_b200_gpu()], storage=[], network_opex_usd_estimate=0.0,
        failure=None, tokens_processed=1_000_000_000.0,  # 1B tokens
    )
    base.update(overrides)
    return TcoInputs(**base)


def test_basic_breakdown_components_sum_to_total():
    from app.compute import compute_tco
    out = compute_tco(_inputs())
    expected_sum = (out.hw_capex_amortized_usd + out.power_opex_usd
                    + out.cooling_opex_usd + out.network_opex_usd
                    + out.storage_opex_usd + out.failure_penalty_usd)
    assert abs(out.total_usd - expected_sum) < 1e-6


def test_capex_scales_with_count_linearly():
    from app.compute import compute_tco
    a = compute_tco(_inputs(gpus=[_b200_gpu(count=8)]))
    b = compute_tco(_inputs(gpus=[_b200_gpu(count=16)]))
    assert b.hw_capex_amortized_usd == pytest.approx(a.hw_capex_amortized_usd * 2, rel=1e-6)


def test_power_scales_with_utilization():
    """Higher util → more energy → more power_opex."""
    from app.compute import compute_tco
    low = compute_tco(_inputs(gpus=[_b200_gpu(util=0.2)]))
    high = compute_tco(_inputs(gpus=[_b200_gpu(util=0.9)]))
    assert high.power_opex_usd > low.power_opex_usd


def test_cooling_is_pue_minus_one_share_of_power():
    """cooling_opex / power_opex == pue - 1."""
    from app.compute import compute_tco
    out = compute_tco(_inputs())
    ratio = out.cooling_opex_usd / out.power_opex_usd
    assert ratio == pytest.approx(1.18 - 1.0, rel=1e-6)


def test_per_m_token_zero_tokens_returns_none():
    from app.compute import compute_tco
    out = compute_tco(_inputs(tokens_processed=0))
    assert out.per_m_token_usd is None


def test_per_m_token_non_zero():
    from app.compute import compute_tco
    out = compute_tco(_inputs(tokens_processed=2_000_000.0))  # 2M tokens
    assert out.per_m_token_usd == pytest.approx(out.total_usd / 2.0, rel=1e-6)


def test_storage_opex_proportional_to_gb_and_time():
    from app.compute import StorageConsumption, compute_tco
    storage = [StorageConsumption(rule_id="storage/nvme/v1", usd_per_gb_month=0.05,
                                   gb=1024, months=1.0)]
    out = compute_tco(_inputs(storage=storage))
    assert out.storage_opex_usd == pytest.approx(1024 * 0.05, rel=1e-6)


def test_failure_penalty_scales_with_restart_fraction():
    from app.compute import FailurePenalty, compute_tco
    a = compute_tco(_inputs(failure=FailurePenalty(0.0, 4.0, 5.0)))
    b = compute_tco(_inputs(failure=FailurePenalty(0.5, 4.0, 5.0)))
    assert b.failure_penalty_usd > a.failure_penalty_usd


def test_per_inference_request_for_inference_workload():
    from app.compute import compute_tco
    out = compute_tco(_inputs(workload_mode="inference",
                                tokens_processed=0,
                                inference_requests=10_000_000.0))
    assert out.per_inference_request_usd is not None
    assert out.per_inference_request_usd == pytest.approx(out.total_usd / 10_000_000.0, rel=1e-6)


def test_rule_versions_collected_for_provenance():
    from app.compute import StorageConsumption, compute_tco
    storage = [StorageConsumption(rule_id="storage/nvme/v1", usd_per_gb_month=0.05,
                                   gb=10, months=1)]
    out = compute_tco(_inputs(storage=storage))
    assert "gpu/gpu/B200/v2026q1" in out.rule_versions
    assert "storage/storage/nvme/v1" in out.rule_versions


def test_sensitivities_include_canonical_knobs():
    from app.compute import compute_sensitivities
    s = compute_sensitivities(_inputs())
    assert "d_total_per_card" in s
    assert "d_total_per_hour" in s
    assert "d_total_per_util_pp" in s
    assert s["d_total_per_card"] > 0  # adding cards adds cost
    assert s["d_total_per_hour"] > 0  # longer wall-clock costs more


def test_no_gpus_returns_zero_components():
    from app.compute import compute_tco, TcoInputs
    out = compute_tco(TcoInputs(run_id="x", wall_clock_s=3600, workload_mode="training"))
    assert out.total_usd == 0
    assert out.per_gpu_hour_usd is None


def test_marginal_design_comparison():
    """Doubling cards should roughly double total at same wall_clock + util."""
    from app.compute import compute_tco
    small = compute_tco(_inputs(gpus=[_b200_gpu(count=8)]))
    big = compute_tco(_inputs(gpus=[_b200_gpu(count=16)]))
    # CapEx + power both scale linearly with count → total should too
    assert big.total_usd == pytest.approx(small.total_usd * 2, rel=1e-3)


def test_amortization_year_lengthens_capex_per_run():
    """Longer amortization → smaller per-run capex share."""
    from app.compute import GpuConsumption, TcoInputs, compute_tco
    short = compute_tco(_inputs(gpus=[_b200_gpu()]))
    long_g = _b200_gpu()
    long_g = GpuConsumption(**{**long_g.__dict__, "amortization_y": 6})
    long_run = compute_tco(_inputs(gpus=[long_g]))
    assert long_run.hw_capex_amortized_usd < short.hw_capex_amortized_usd
    # power_opex must NOT change (independent of amortization)
    assert long_run.power_opex_usd == pytest.approx(short.power_opex_usd, rel=1e-6)


# ── P-Domain-1 KVCache aggregation ────────────────────────────────────────

def test_kvcache_storage_aggregates_only_kvcache_prefixed_rules():
    """rule_id LIKE 'kvcache-%' rows roll up into kvcache_storage_opex_usd;
    other storage rows do NOT contribute to that subset."""
    from app.compute import StorageConsumption, compute_tco
    storage = [
        StorageConsumption(rule_id="kvcache-hbm",   usd_per_gb_month=0.000, gb=180,  months=1.0),
        StorageConsumption(rule_id="kvcache-dram",  usd_per_gb_month=0.003, gb=1024, months=1.0),
        StorageConsumption(rule_id="ckpt-nvme",     usd_per_gb_month=0.050, gb=500,  months=1.0),
    ]
    out = compute_tco(_inputs(storage=storage))
    expected_kv = 180 * 0 + 1024 * 0.003   # only kvcache-* rows
    expected_total_storage = expected_kv + 500 * 0.050
    assert out.kvcache_storage_opex_usd == pytest.approx(expected_kv, rel=1e-6)
    assert out.storage_opex_usd == pytest.approx(expected_total_storage, rel=1e-6)
    # Critically: kvcache portion is a SUBSET of storage, not additive to total
    expected_sum = (out.hw_capex_amortized_usd + out.power_opex_usd
                    + out.cooling_opex_usd + out.network_opex_usd
                    + out.storage_opex_usd + out.failure_penalty_usd)
    assert out.total_usd == pytest.approx(expected_sum, rel=1e-6)


def test_kvcache_storage_zero_when_no_kvcache_rules():
    """No kvcache-* storage rows → kvcache_storage_opex_usd = 0."""
    from app.compute import StorageConsumption, compute_tco
    storage = [
        StorageConsumption(rule_id="ckpt-nvme", usd_per_gb_month=0.050, gb=500, months=1.0),
    ]
    out = compute_tco(_inputs(storage=storage))
    assert out.kvcache_storage_opex_usd == 0.0
    assert out.storage_opex_usd > 0


def test_kvcache_breakdown_in_as_dict():
    """as_dict() must surface the new field for the API response."""
    from app.compute import StorageConsumption, compute_tco
    storage = [StorageConsumption(rule_id="kvcache-hbm", usd_per_gb_month=0.01, gb=100, months=1.0)]
    out = compute_tco(_inputs(storage=storage))
    d = out.as_dict()
    assert "kvcache_storage_opex_usd" in d
    assert d["kvcache_storage_opex_usd"] == pytest.approx(1.0, rel=1e-6)
