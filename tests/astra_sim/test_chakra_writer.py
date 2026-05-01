"""Unit tests for app.chakra_writer (RFC-003).

These exercise the protobuf serialisation + per-rank node-graph shape
without invoking the astra-sim binary. Integration with the binary
(traces are *valid* astra-sim input) is verified by `make e2e` against
the deployed image — there's no offline way to assert that here.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app._chakra import et_def_pb2 as et
from app._chakra.protolib import decode_message
from app.chakra_writer import (
    TraceSpec,
    build_rank_nodes,
    trace_dir_for,
    write_trace,
    write_trace_cached,
)


def _spec(**overrides) -> TraceSpec:
    base = dict(
        gpu_model="B200", gpu_count=8,
        activated_params_b=8.0, seq_len=2048, global_batch=512,
        quant="FP8", TP=4, PP=2,
    )
    base.update(overrides)
    return TraceSpec(**base)


def _read_nodes(path: Path) -> list[et.Node]:
    out: list[et.Node] = []
    with open(path, "rb") as fh:
        meta = et.GlobalMetadata()
        ok = decode_message(fh, meta)
        assert ok and meta.version == "0.0.4"
        while True:
            n = et.Node()
            if not decode_message(fh, n):
                break
            out.append(n)
    return out


# ── Spec arithmetic ───────────────────────────────────────────────────


def test_dp_inferred_from_world_size():
    s = _spec(gpu_count=32, TP=4, PP=2)
    assert s.DP == 4
    assert s.world_size == 32


def test_hidden_and_layers_scale_with_params():
    small = _spec(activated_params_b=1.0)
    big = _spec(activated_params_b=70.0)
    assert big.hidden > small.hidden
    assert big.n_layers > small.n_layers


# ── Per-rank node graph ───────────────────────────────────────────────


def test_rank0_first_pp_stage_has_no_recv_at_start():
    s = _spec(TP=4, PP=2, gpu_count=8)
    nodes = build_rank_nodes(s, rank=0)
    # rank 0 is (tp_idx=0, pp_idx=0, dp_idx=0) → first PP stage, no recv
    assert nodes[0].type != et.COMM_RECV_NODE
    # First node should be a forward COMP
    assert nodes[0].type == et.COMP_NODE
    assert "fwd.compute" in nodes[0].name


def test_no_pp_send_recv_in_v0_1_writer():
    """v0.1 (RFC-003 follow-up): the writer collapsed PP messaging because
    astra-sim's scheduler couldn't resolve the dependency graph (CI run
    529351c5 — `Hardware Resource sys.id=N has unreleased nodes`). Until
    a proper PP modelling RFC, the writer emits *only* COMP + COMM_COLL
    nodes — same shape as the proven microbench traces. Lock that contract
    here so a future "let's re-add PP send/recv" attempt has to consciously
    update this test."""
    s = _spec(TP=4, PP=4, gpu_count=16)
    middle_rank = 4
    nodes = build_rank_nodes(s, rank=middle_rank)
    types = {n.type for n in nodes}
    assert et.COMM_SEND_NODE not in types, \
        "v0.1 writer must not emit SEND nodes (astra-sim scheduler can't pair them)"
    assert et.COMM_RECV_NODE not in types, \
        "v0.1 writer must not emit RECV nodes"
    # Should still have compute + tp_allreduce + (DP=1 here so no DP allreduce)
    assert any(n.type == et.COMP_NODE for n in nodes)
    assert any(n.type == et.COMM_COLL_NODE for n in nodes)


def test_tp_allreduce_present_when_tp_gt_1():
    s = _spec(TP=4)
    nodes = build_rank_nodes(s, rank=0)
    coll_nodes = [n for n in nodes if n.type == et.COMM_COLL_NODE]
    # At least one fwd + one bwd TP all-reduce per layer
    fwd_tp = [n for n in coll_nodes if "fwd.tp.allreduce" in n.name]
    bwd_tp = [n for n in coll_nodes if "bwd.tp.allreduce" in n.name]
    assert fwd_tp, "expected fwd TP all-reduce nodes"
    assert bwd_tp, "expected bwd TP all-reduce nodes"
    # comm_type must be ALL_REDUCE
    for n in fwd_tp:
        ct = next(a for a in n.attr if a.name == "comm_type")
        assert ct.int64_val == et.ALL_REDUCE


def test_no_tp_allreduce_when_tp_is_one():
    s = _spec(TP=1, PP=2, gpu_count=4)
    nodes = build_rank_nodes(s, rank=0)
    assert not any("tp.allreduce" in n.name for n in nodes)


def test_dp_grad_allreduce_only_when_dp_gt_1():
    s = _spec(TP=4, PP=2, gpu_count=8)  # DP = 1
    nodes = build_rank_nodes(s, rank=0)
    assert not any("dp.grad" in n.name for n in nodes)
    s2 = _spec(TP=4, PP=2, gpu_count=32)  # DP = 4
    nodes2 = build_rank_nodes(s2, rank=0)
    assert any("dp.grad.allreduce" in n.name for n in nodes2)


def test_node_ids_strictly_increasing():
    s = _spec(TP=4, PP=2, gpu_count=8)
    nodes = build_rank_nodes(s, rank=0)
    ids = [n.id for n in nodes]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)


def test_ctrl_deps_chain_back_to_prior_node():
    """Each node (after the first) should have a ctrl_dep on the most recent
    prior node — that's how astra-sim infers the linear order within a rank."""
    s = _spec(TP=2, PP=1, gpu_count=2)  # DP=1, single stage, just TP
    nodes = build_rank_nodes(s, rank=0)
    seen_ids: set[int] = set()
    for n in nodes:
        for dep in n.ctrl_deps:
            assert dep in seen_ids, f"node {n.id} depends on unseen {dep}"
        seen_ids.add(n.id)


# ── File-level write ──────────────────────────────────────────────────


def test_write_trace_emits_one_file_per_rank(tmp_path: Path):
    s = _spec(gpu_count=8, TP=4, PP=2)
    write_trace(s, tmp_path)
    et_files = sorted(tmp_path.glob("trace.*.et"))
    assert len(et_files) == 8


def test_written_file_decodes_back_to_original_nodes(tmp_path: Path):
    """Round-trip: write then re-read. Counts and node types must match."""
    s = _spec(gpu_count=4, TP=2, PP=2)
    write_trace(s, tmp_path)
    expected = build_rank_nodes(s, rank=0)
    actual = _read_nodes(tmp_path / "trace.0.et")
    assert len(actual) == len(expected)
    assert [n.type for n in actual] == [n.type for n in expected]
    assert [n.name for n in actual] == [n.name for n in expected]


def test_spec_manifest_written_for_human_diagnosis(tmp_path: Path):
    s = _spec()
    write_trace(s, tmp_path)
    spec_json = (tmp_path / "spec.json").read_text()
    assert '"gpu_model": "B200"' in spec_json
    assert '"TP": 4' in spec_json


# ── Cache ──────────────────────────────────────────────────────────────


def test_cache_dir_is_deterministic():
    s1 = _spec(activated_params_b=8.0, TP=4)
    s2 = _spec(activated_params_b=8.0, TP=4)
    s3 = _spec(activated_params_b=8.0, TP=8)  # different
    root = Path("/tmp/x")
    assert trace_dir_for(s1, root) == trace_dir_for(s2, root)
    assert trace_dir_for(s1, root) != trace_dir_for(s3, root)


def test_write_trace_cached_short_circuits_on_second_call(tmp_path: Path, monkeypatch):
    s = _spec(gpu_count=4, TP=2, PP=2)
    calls = {"n": 0}
    from app import chakra_writer as cw
    real_write = cw.write_trace

    def counting(spec, dir_):
        calls["n"] += 1
        return real_write(spec, dir_)

    monkeypatch.setattr(cw, "write_trace", counting)

    cw.write_trace_cached(s, tmp_path)
    assert calls["n"] == 1
    cw.write_trace_cached(s, tmp_path)  # cached
    assert calls["n"] == 1


# ── Comm-size bytes are non-zero (astra-sim won't simulate 0-byte ops) ──


def test_tp_allreduce_size_attr_positive():
    s = _spec(TP=4, PP=1, gpu_count=4)
    nodes = build_rank_nodes(s, rank=0)
    tp_nodes = [n for n in nodes if "tp.allreduce" in n.name]
    assert tp_nodes
    for n in tp_nodes:
        size_attr = next(a for a in n.attr if a.name == "comm_size")
        assert size_attr.int64_val > 0


def test_tp_allreduce_size_positive_at_pp_2():
    """v0.1 PP=2 trace shape: PP no longer emits SEND/RECV; per-rank trace
    is just COMP + TP allreduce. Verify the all-reduce size is non-zero."""
    s = _spec(TP=2, PP=2, gpu_count=4)
    nodes = build_rank_nodes(s, rank=0)
    colls = [n for n in nodes if n.type == et.COMM_COLL_NODE]
    assert colls, "expected TP all-reduce nodes for PP=2 TP=2 trace"
    for n in colls:
        size = next(a for a in n.attr if a.name == "comm_size")
        assert size.int64_val > 0


# ── Coverage envelope cross-check ─────────────────────────────────────


@pytest.mark.parametrize("gpu_count,TP,PP", [
    (8, 1, 1),    # single rank
    (8, 8, 1),    # TP-only
    (8, 1, 8),    # PP-only
    (16, 4, 2),   # DP=2 implicit
    (1024, 16, 8),  # full envelope upper bound
])
def test_envelope_corners_produce_valid_trace(tmp_path: Path, gpu_count, TP, PP):
    """Every corner of the new wider envelope should produce a non-empty
    trace per rank without crashing."""
    s = _spec(gpu_count=gpu_count, TP=TP, PP=PP)
    write_trace(s, tmp_path)
    files = sorted(tmp_path.glob("trace.*.et"))
    assert len(files) == gpu_count
    # Spot-check rank 0 has at least one COMP node
    nodes = _read_nodes(files[0])
    assert any(n.type == et.COMP_NODE for n in nodes)
