"""Pure-function adapter tests."""
from __future__ import annotations

import pytest


# ── dcgm-csv ─────────────────────────────────────────────────────────

def test_dcgm_csv_basic():
    from app.adapters import adapt_dcgm_csv
    raw = (
        b"timestamp,gpu_model,model_family,sm_util_pct,hbm_used_gb,power_w,step_ms\n"
        b"2026-01-01T00:00:00Z,B200,MoE,47.3,150.2,1100,540.5\n"
        b"2026-01-01T00:00:01Z,B200,MoE,48.0,152.1,1120,535.0\n"
    )
    out = adapt_dcgm_csv(raw)
    assert out.row_count == 2
    assert out.hardware_scope == {"gpu_models": ["B200"]}
    assert out.workload_scope == {"model_families": ["MoE"]}
    assert out.samples[0].measured["mfu_pct"] == 47.3
    assert out.samples[0].measured["step_ms"] == 540.5


def test_dcgm_csv_handles_unix_epoch_timestamps():
    from app.adapters import adapt_dcgm_csv
    raw = (
        b"timestamp,gpu_model,sm_util_pct,step_ms\n"
        b"1735689600,H200,42.0,600\n"
    )
    out = adapt_dcgm_csv(raw)
    assert out.row_count == 1
    assert out.samples[0].gpu_model == "H200"


def test_dcgm_csv_strips_bom():
    from app.adapters import adapt_dcgm_csv
    raw = b"\xef\xbb\xbftimestamp,gpu_model,sm_util_pct,step_ms\n" \
          b"2026-01-01T00:00:00Z,B200,40,500\n"
    out = adapt_dcgm_csv(raw)
    assert out.row_count == 1


def test_dcgm_csv_missing_columns_raises():
    from app.adapters import adapt_dcgm_csv
    raw = b"timestamp,gpu_model\n2026-01-01,B200\n"
    with pytest.raises(ValueError, match="missing required"):
        adapt_dcgm_csv(raw)


def test_dcgm_csv_empty_file_raises():
    from app.adapters import adapt_dcgm_csv
    raw = b"timestamp,gpu_model,sm_util_pct,step_ms\n"
    with pytest.raises(ValueError, match="no data rows"):
        adapt_dcgm_csv(raw)


def test_dcgm_csv_bad_timestamp_raises():
    from app.adapters import adapt_dcgm_csv
    raw = b"timestamp,gpu_model,sm_util_pct,step_ms\nnot-a-date,B200,40,500\n"
    with pytest.raises(ValueError, match="bad timestamp"):
        adapt_dcgm_csv(raw)


def test_dcgm_csv_aggregates_multiple_gpu_models():
    from app.adapters import adapt_dcgm_csv
    raw = (
        b"timestamp,gpu_model,sm_util_pct,step_ms\n"
        b"2026-01-01T00:00:00Z,B200,40,500\n"
        b"2026-01-01T00:00:01Z,H200,38,600\n"
        b"2026-01-01T00:00:02Z,B200,42,510\n"
    )
    out = adapt_dcgm_csv(raw)
    assert set(out.hardware_scope["gpu_models"]) == {"B200", "H200"}


# ── k8s-event-jsonl ──────────────────────────────────────────────────

def test_k8s_event_jsonl_basic():
    from app.adapters import adapt_k8s_event_jsonl
    raw = (
        b'{"ts":"2026-01-01T00:00:00Z","kind":"started","workload_class":"train-moe","duration_ms":3600000}\n'
        b'{"ts":"2026-01-01T01:00:00Z","kind":"ended","workload_class":"train-moe","duration_ms":3600000,"result":"ok"}\n'
    )
    out = adapt_k8s_event_jsonl(raw)
    assert out.row_count == 2
    assert out.workload_scope == {"workload_classes": ["train-moe"]}


def test_k8s_event_jsonl_skips_blank_lines():
    from app.adapters import adapt_k8s_event_jsonl
    raw = b'{"ts":"2026-01-01T00:00:00Z"}\n\n\n{"ts":"2026-01-01T01:00:00Z"}\n'
    out = adapt_k8s_event_jsonl(raw)
    assert out.row_count == 2


def test_k8s_event_jsonl_invalid_json_raises():
    from app.adapters import adapt_k8s_event_jsonl
    with pytest.raises(ValueError, match="invalid JSON"):
        adapt_k8s_event_jsonl(b"{not json}\n")


def test_k8s_event_jsonl_missing_ts_raises():
    from app.adapters import adapt_k8s_event_jsonl
    with pytest.raises(ValueError, match="missing ts"):
        adapt_k8s_event_jsonl(b'{"kind":"started"}\n')


def test_k8s_event_jsonl_empty_file_raises():
    from app.adapters import adapt_k8s_event_jsonl
    with pytest.raises(ValueError, match="no events"):
        adapt_k8s_event_jsonl(b"\n\n   \n")


# ── Registry ─────────────────────────────────────────────────────────

def test_adapter_registry_has_known_adapters():
    from app.adapters import ADAPTERS
    assert "dcgm-csv@v1" in ADAPTERS
    assert "k8s-event-jsonl@v1" in ADAPTERS
