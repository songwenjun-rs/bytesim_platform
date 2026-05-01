"""Pure-function engine selection tests (RFC-001 v2)."""
from __future__ import annotations

from engine_contracts import (
    Cluster, EnginePredictRequest, StrategyParams, Workload,
)


_ENVELOPE_WIDE = {
    "workload_families": ["transformer-dense", "transformer-moe"],
    "parallelism": {"TP": [1, 64], "PP": [1, 64], "EP": [1, 64], "CP": [1, 8],
                    "recompute": ["selective", "full"],
                    "overlap": ["1F1B", "ZB", "ZBv2", "ring_compress", "Chimera"]},
    "hardware": {"gpu_models": ["B200", "H200", "GB300", "MI355X", "H100", "NPU-910"],
                 "fabric": ["nvlink", "infiniband", "roce"],
                 "scale_gpus": [8, 8192]},
    "quant": ["BF16", "FP8"],
    "modes": ["training", "inference"],
}

_ENVELOPE_NARROW = {
    "workload_families": ["transformer-dense"],
    "parallelism": {"TP": [1, 16], "PP": [1, 1], "EP": [1, 1], "CP": [1, 1],
                    "recompute": ["selective"], "overlap": ["1F1B"]},
    "hardware": {"gpu_models": ["B200", "H200", "H100"],
                 "fabric": ["nvlink", "infiniband"],
                 "scale_gpus": [4, 16]},
    "quant": ["BF16", "FP8"],
    "modes": ["training"],
}


def _engine(*, name="surrogate-analytical", fidelity="analytical",
            sla_p99_ms=100, status="active", coverage_envelope=None,
            calibration=None):
    return {
        "name": name, "version": "v0.1",
        "fidelity": fidelity, "sla_p99_ms": sla_p99_ms, "status": status,
        "endpoint": "http://x", "predict_path": "/v1/predict",
        "coverage_envelope": coverage_envelope or _ENVELOPE_WIDE,
        "kpi_outputs": ["mfu_pct", "step_ms"],
        "calibration": calibration or {},
    }


def _req(*, gpu_model="B200", gpu_count=1024, family="transformer-dense",
         mode="training", quant="FP8", TP=8, PP=8, EP=1, CP=2,
         overlap="ZBv2", recompute="selective"):
    return EnginePredictRequest(
        cluster=Cluster(gpu_model=gpu_model, gpu_count=gpu_count),
        workload=Workload(workload_family=family, mode=mode, quant=quant,
                          activated_params_b=8.0, total_params_b=8.0,
                          seq_len=8192, global_batch=4096),
        strategy=StrategyParams(TP=TP, PP=PP, EP=EP, CP=CP,
                                 recompute=recompute, overlap=overlap),
    )


# ── select_engine ─────────────────────────────────────────────────────


def test_select_returns_none_when_no_engines():
    from app.router import select_engine
    assert select_engine([], _req()) is None


def test_select_picks_only_engine_in_envelope():
    """Wide envelope covers; narrow envelope doesn't (PP=8 outside [1,1])."""
    from app.router import select_engine
    engines = [
        _engine(name="wide", coverage_envelope=_ENVELOPE_WIDE),
        _engine(name="narrow", coverage_envelope=_ENVELOPE_NARROW),
    ]
    chosen = select_engine(engines, _req(PP=8, EP=4))
    assert chosen is not None and chosen["name"] == "wide"


def test_select_prefers_higher_fidelity_when_both_cover():
    """With both engines covering the request, cycle-accurate wins over
    analytical (RFC §2.5 sort key #1)."""
    from app.router import select_engine
    # Use a request the narrow envelope CAN handle (small dense, PP=1).
    req = _req(PP=1, EP=1, CP=1, overlap="1F1B", gpu_count=8, gpu_model="H200")
    engines = [
        _engine(name="surr", fidelity="analytical", sla_p99_ms=50,
                coverage_envelope=_ENVELOPE_WIDE),
        _engine(name="astra", fidelity="cycle-accurate", sla_p99_ms=5000,
                coverage_envelope=_ENVELOPE_NARROW),
    ]
    chosen = select_engine(engines, req)
    assert chosen["name"] == "astra"  # cycle-accurate wins despite higher SLA


def test_select_skips_inactive():
    from app.router import select_engine
    engines = [
        _engine(name="dead", status="deprecated"),
        _engine(name="alive"),
    ]
    chosen = select_engine(engines, _req())
    assert chosen["name"] == "alive"


def test_select_respects_sla_budget():
    from app.router import select_engine
    engines = [
        _engine(name="slow", sla_p99_ms=500),
        _engine(name="medium", sla_p99_ms=200),
    ]
    assert select_engine(engines, _req(), sla_budget_ms=100) is None
    chosen = select_engine(engines, _req(), sla_budget_ms=300)
    assert chosen["name"] == "medium"


def test_select_respects_fidelity_floor():
    from app.router import select_engine
    engines = [
        _engine(name="surr", fidelity="analytical"),
        _engine(name="hybrid", fidelity="hybrid", sla_p99_ms=200),
    ]
    chosen = select_engine(engines, _req(), fidelity_floor="hybrid")
    assert chosen["name"] == "hybrid"


def test_select_engine_preference_overrides_envelope_check():
    from app.router import select_engine
    engines = [
        _engine(name="primary"),
        _engine(name="narrow-eng", coverage_envelope=_ENVELOPE_NARROW),
    ]
    chosen = select_engine(engines, _req(PP=8), engine_preference="narrow-eng")
    assert chosen["name"] == "narrow-eng"


def test_select_engine_preference_returns_none_when_inactive():
    from app.router import select_engine
    engines = [_engine(name="x", status="deprecated")]
    assert select_engine(engines, _req(), engine_preference="x") is None


def test_select_calibration_breaks_fidelity_tie():
    from app.router import select_engine
    engines = [
        _engine(name="bad-cal", calibration={"mape_pct": {"mfu": 8.0}}),
        _engine(name="good-cal", calibration={"mape_pct": {"mfu": 2.0}}),
    ]
    chosen = select_engine(engines, _req())
    assert chosen["name"] == "good-cal"


# ── explain_misses ────────────────────────────────────────────────────


def test_explain_misses_lists_field_level_reasons():
    """When no engine covers, the registry surfaces every field that
    differs — RFC §2.5 503 enhancement."""
    from app.router import explain_misses
    engines = [_engine(name="narrow", coverage_envelope=_ENVELOPE_NARROW)]
    misses = explain_misses(engines, _req(family="transformer-moe", PP=8))
    assert "narrow" in misses
    fields = {m["field"] for m in misses["narrow"]}
    assert "workload_family" in fields
    assert "parallelism.PP" in fields
