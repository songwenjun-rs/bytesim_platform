"""Pure-function tests for the ByteSim → astra-sim translator.

Covers:
  - normalize() defaults + alias handling for collective/topology names
  - preset snapping when requested NPUs/size don't match any bundled trace
  - rejection of unsupported collectives / topologies
  - parse_output() correctly extracts wall_time/comm_time
  - workload_path() points at a real file in our vendored examples tree
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "engine" / "astra-sim" / "examples"


# ── normalize() ─────────────────────────────────────────────────────

def test_normalize_defaults_to_8npu_ring_allreduce():
    from app.translator import normalize
    out = normalize({})
    assert out["collective"] == "all_reduce"
    assert out["topology"] == "Ring"
    assert out["npus"] == 8
    assert out["size_mb"] == 1
    assert out["bandwidth_gbps"] == 50.0
    assert out["latency_ns"] == 500.0


def test_normalize_accepts_alias_forms():
    from app.translator import normalize
    out = normalize({
        "cluster": {"gpu_count": 4, "fabric_topology": {"topology": "fc"}},
        "workload": {"collective": "AllReduce"},
    })
    assert out["topology"] == "FullyConnected"
    assert out["collective"] == "all_reduce"
    assert out["npus"] == 4


def test_normalize_rejects_unknown_collective():
    from app.translator import normalize, TranslationError
    with pytest.raises(TranslationError, match="unsupported collective"):
        normalize({"workload": {"collective": "broadcast"}})


def test_normalize_rejects_unknown_topology():
    from app.translator import normalize, TranslationError
    with pytest.raises(TranslationError, match="unsupported topology"):
        normalize({
            "cluster": {"gpu_count": 4, "fabric_topology": {"topology": "dragonfly"}},
        })


# ── preset snapping ────────────────────────────────────────────────

def test_snap_picks_largest_preset_le_request():
    from app.translator import normalize
    # 12 NPUs requested; presets are 4/8/16 → 8 (largest ≤ 12).
    out = normalize({
        "cluster": {"gpu_count": 12},
        "workload": {"collective": "all_reduce"},
    })
    assert out["npus"] == 8
    assert out["snapped"] is True
    assert out["requested_npus"] == 12


def test_snap_falls_back_to_smallest_if_request_too_low():
    from app.translator import normalize
    # 2 NPUs requested but smallest preset is 4 → snap up to 4 (smallest available).
    out = normalize({
        "cluster": {"gpu_count": 2},
        "workload": {"collective": "all_reduce"},
    })
    assert out["npus"] == 4
    assert out["snapped"] is True


def test_snap_skipped_when_request_matches_preset():
    from app.translator import normalize
    out = normalize({
        "cluster": {"gpu_count": 8},
        "workload": {"collective": "all_reduce", "message_size_mb": 1},
    })
    assert out["snapped"] is False


def test_all_gather_only_has_8npu_preset():
    from app.translator import normalize
    out = normalize({
        "cluster": {"gpu_count": 16},
        "workload": {"collective": "all_gather"},
    })
    # Only (8, 1) is bundled; 16 snaps down to 8.
    assert out["npus"] == 8
    assert out["snapped"] is True


# ── config emitters ────────────────────────────────────────────────

def test_build_network_yml_shape():
    from app.translator import build_network_yml
    yml = build_network_yml(8, "Ring", 50.0, 500.0)
    assert "topology: [ Ring ]" in yml
    assert "npus_count: [ 8 ]" in yml
    assert "bandwidth: [ 50 ]" in yml
    assert "latency: [ 500 ]" in yml


def test_build_system_json_is_valid_json_with_ring_collectives():
    from app.translator import build_system_json
    data = json.loads(build_system_json())
    assert data["all-reduce-implementation"] == ["ring"]
    assert data["all-gather-implementation"] == ["ring"]
    assert data["scheduling-policy"] == "LIFO"
    # local-mem-bw must be a positive number — astra-sim crashes on 0.
    assert data["local-mem-bw"] > 0


# ── workload path resolution ───────────────────────────────────────

def test_workload_path_points_at_bundled_trace():
    from app.translator import workload_path
    p = workload_path(EXAMPLES, "all_reduce", 8, 1)
    rank0 = p.with_name(p.name + ".0.et")
    assert rank0.exists(), f"vendored examples are missing {rank0}"


def test_all_supported_presets_have_rank_0_files():
    """Every (collective, npus, 1MB) advertised by the snapper must resolve to
    an existing .0.et file in the vendored examples."""
    from app.translator import _PRESETS, workload_path
    missing = []
    for collective, presets in _PRESETS.items():
        for npus, size in presets:
            p = workload_path(EXAMPLES, collective, npus, size)
            if not p.with_name(p.name + ".0.et").exists():
                missing.append(f"{collective}/{npus}npus_{size}MB")
    assert not missing, f"missing bundled traces: {missing}"


# ── output parser ──────────────────────────────────────────────────

SAMPLE_OUTPUT = """
[2026-04-27 10:00:00] [astra-sim] [info] sys[0], Wall time: 12345
[2026-04-27 10:00:00] [astra-sim] [info] sys[0], CPU time: 10
[2026-04-27 10:00:00] [astra-sim] [info] sys[0], GPU time: 50
[2026-04-27 10:00:00] [astra-sim] [info] sys[0], Comm time: 12200
[2026-04-27 10:00:00] [astra-sim] [info] sys[1], Wall time: 12350
[2026-04-27 10:00:00] [astra-sim] [info] sys[1], Comm time: 12210
""".strip()


def test_parse_output_aggregates_max_wall_time():
    from app.translator import parse_output
    m = parse_output(SAMPLE_OUTPUT)
    assert m["wall_time_ns"] == 12350
    assert m["sys_count"] == 2
    # 12350 ns → 0.01235 ms.
    assert m["collective_time_ms"] == pytest.approx(0.01235)
    assert m["comm_time_ms"] == pytest.approx(0.01221)


def test_parse_output_no_wall_time_raises():
    from app.translator import parse_output, TranslationError
    with pytest.raises(TranslationError, match="no `Wall time:`"):
        parse_output("[info] sys[0], CPU time: 10")


def test_parse_output_handles_missing_comm_time():
    """Comm time line is not always emitted (e.g. compute-only workloads).
    Wrapper should fall back to wall_time as comm_time so callers see a
    self-consistent number."""
    from app.translator import parse_output
    m = parse_output("[info] sys[0], Wall time: 999")
    assert m["wall_time_ns"] == 999
    assert m["comm_time_ms"] == m["collective_time_ms"]
