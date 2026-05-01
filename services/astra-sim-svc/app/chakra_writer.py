"""Chakra ET trace generator for ByteSim's astra-sim engine (RFC-003).

Generates one chakra ET file per rank for a single training step of a
dense transformer with TP × PP × DP parallelism. Output files match the
on-disk format astra-sim's ETFeeder expects:

    <prefix>.{rank}.et   (varint-prefixed protobuf stream)
        [GlobalMetadata version="0.0.4"]
        [Node id=0 ...]
        [Node id=1 ...]
        ...

Coverage today (RFC §1):
  * workload_family = transformer-dense (no MoE; EP must be 1)
  * parallelism: TP ∈ [1,16], PP ∈ [1,8], CP=1, DP = world_size / (TP·PP)
  * trace contains one optimization step:
      - PP-stage forward compute → TP all-reduce per layer
      - PP send to next stage
      - PP receive from next stage (backward)
      - PP-stage backward compute → TP all-reduce
      - DP all-reduce of gradients across data-parallel replicas
  * compute durations from a Roofline-ish model; comm sizes from activation /
    gradient bytes. Numbers are not calibrated against real workloads — astra-sim
    consumes them and does the network simulation; the wrapper post-processes.

Out of scope (later iterations):
  * MoE (EP), context parallelism (CP > 1), ZeRO partitioning
  * Multi-step traces (warm-up + N steps)
  * Selective recompute / overlap algorithms — rolled into compute-time scaling
  * Non-transformer families
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from app._chakra import et_def_pb2 as et
from app._chakra.protolib import encode_message


# ── Hardware → peak FP8 PFLOPS ────────────────────────────────────────────
# Same numbers surrogate-svc uses; lifted out so the chakra writer doesn't
# pull surrogate as a dep. When this list grows, update the envelope in
# astra-sim-svc/app/main.py:DESCRIPTOR.coverage_envelope.hardware.gpu_models.
_GPU_PEAK_FP8_PFLOPS: dict[str, float] = {
    "B200": 4.9, "H200": 3.9, "GB300": 6.4, "H100": 2.0,
}

# Per-layer activation bytes per token; rough — assumes residual stream of
# H × elem_bytes(quant) and 4× expansion in MLP for an ephemeral activation.
_QUANT_BYTES: dict[str, int] = {"BF16": 2, "FP8": 1, "INT8": 1, "INT4": 1}


# ── Public spec the wrapper hands us ─────────────────────────────────────


@dataclass
class TraceSpec:
    """What we need to emit a trace. Wrapper translates from the v2
    EnginePredictRequest into this; everything beyond is internal."""
    gpu_model: str
    gpu_count: int
    activated_params_b: float       # billions; for dense same as total
    seq_len: int
    global_batch: int
    quant: str                      # "BF16" | "FP8" | "INT8" | "INT4"
    TP: int
    PP: int
    # CP/EP fixed at 1 in v0 — caller has been gated by envelope already

    @property
    def world_size(self) -> int:
        return self.gpu_count

    @property
    def DP(self) -> int:
        # Whatever's left after TP × PP across the world.
        return max(1, self.world_size // (self.TP * self.PP))

    @property
    def hidden(self) -> int:
        # Rough hidden size from total params (Llama-style scaling — picks
        # a hidden such that L = 32 layers, d_ff = 4H).
        # P ≈ 12 × L × H² for dense decoder transformers. Solve for H:
        L = max(8, int(self.activated_params_b * 1.5))   # heuristic
        H = int(((self.activated_params_b * 1e9) / (12 * L)) ** 0.5)
        return max(512, (H // 64) * 64)

    @property
    def n_layers(self) -> int:
        return max(8, int(self.activated_params_b * 1.5))


# ── Trace cache ───────────────────────────────────────────────────────────


def trace_dir_for(spec: TraceSpec, root: Path) -> Path:
    """Deterministic cache path. Same spec → same dir → reuse the trace
    instead of re-encoding (encoding is cheap but I/O isn't)."""
    key = json.dumps(_spec_dict(spec), sort_keys=True).encode()
    h = hashlib.sha1(key).hexdigest()[:16]
    return root / "chakra-cache" / h


def _spec_dict(spec: TraceSpec) -> dict[str, Any]:
    return {
        "gpu_model": spec.gpu_model, "gpu_count": spec.gpu_count,
        "activated_params_b": spec.activated_params_b,
        "seq_len": spec.seq_len, "global_batch": spec.global_batch,
        "quant": spec.quant, "TP": spec.TP, "PP": spec.PP,
    }


# ── Sizing helpers (rough; astra-sim does the actual network simulation) ─


def _compute_micros(spec: TraceSpec, *, fwd: bool) -> int:
    """Per-stage compute time in microseconds. Roofline-ish.
    Backward ≈ 2× forward (gradient + activation recompute)."""
    peak_pflops = _GPU_PEAK_FP8_PFLOPS.get(spec.gpu_model, 2.0)
    # Total FLOPs per step for the WHOLE model: 6 × P × tokens (fwd+bwd),
    # split per pp_stage.
    tokens_per_step = spec.global_batch * spec.seq_len
    stage_flops = 6.0 * spec.activated_params_b * 1e9 * tokens_per_step / max(1, spec.PP)
    # Per-rank compute = stage / TP (assume perfect TP partition).
    per_rank_flops = stage_flops / max(1, spec.TP)
    # Wall time at 50% MFU.
    seconds = per_rank_flops / (peak_pflops * 1e15 * 0.50)
    micros = max(1, int(seconds * 1e6))
    return micros if fwd else (micros * 2)


def _tp_allreduce_bytes(spec: TraceSpec) -> int:
    """Activation tensor size that's all-reduced after each layer on the TP
    group. Per-token: H × elem_bytes (one residual stream). astra-sim cares
    about magnitude, not exact value."""
    elem = _QUANT_BYTES.get(spec.quant, 2)
    return max(1, spec.hidden * (spec.global_batch // max(1, spec.PP)) * spec.seq_len * elem)


def _dp_grad_bytes(spec: TraceSpec) -> int:
    """Gradients all-reduced across DP at end of step. Approx model_params /
    (TP × PP) × elem_bytes."""
    elem = _QUANT_BYTES.get(spec.quant, 2)
    per_rank_params = spec.activated_params_b * 1e9 / (spec.TP * spec.PP)
    return max(1, int(per_rank_params * elem))


def _pp_activation_bytes(spec: TraceSpec) -> int:
    """Activation passed between adjacent PP stages. One residual stream."""
    elem = _QUANT_BYTES.get(spec.quant, 2)
    return max(1, spec.hidden * (spec.global_batch // max(1, spec.PP)) * spec.seq_len * elem)


# ── ET node helpers ───────────────────────────────────────────────────────


def _comp_node(node_id: int, name: str, micros: int,
               ctrl_deps: Iterable[int] = ()) -> et.Node:
    n = et.Node()
    n.id = node_id
    n.name = name
    n.type = et.COMP_NODE
    n.duration_micros = micros
    n.attr.append(et.AttributeProto(name="is_cpu_op", bool_val=False))
    n.attr.append(et.AttributeProto(name="num_ops", int64_val=micros))  # proxy for FLOPs
    for dep in ctrl_deps:
        n.ctrl_deps.append(dep)
    return n


def _coll_node(node_id: int, name: str, comm_type: int, comm_size_bytes: int,
               ctrl_deps: Iterable[int] = ()) -> et.Node:
    n = et.Node()
    n.id = node_id
    n.name = name
    n.type = et.COMM_COLL_NODE
    n.attr.append(et.AttributeProto(name="is_cpu_op", bool_val=False))
    n.attr.append(et.AttributeProto(name="comm_type", int64_val=comm_type))
    n.attr.append(et.AttributeProto(name="comm_size", int64_val=comm_size_bytes))
    for dep in ctrl_deps:
        n.ctrl_deps.append(dep)
    return n


def _send_node(node_id: int, name: str, peer_rank: int, comm_size_bytes: int,
               comm_tag: int, ctrl_deps: Iterable[int] = ()) -> et.Node:
    """Point-to-point send. astra-sim's chakra ETFeeder (feeder_v3) requires
    `comm_tag` on every SEND/RECV — without it the reader throws
    `Attribute comm_tag not found` and aborts mid-simulation. The tag pairs
    a send with its matching recv across ranks; the pairing scheme is just
    "same tag value at both ends of a single point-to-point link"."""
    n = et.Node()
    n.id = node_id
    n.name = name
    n.type = et.COMM_SEND_NODE
    n.attr.append(et.AttributeProto(name="comm_dst", int32_val=peer_rank))
    n.attr.append(et.AttributeProto(name="comm_size", int64_val=comm_size_bytes))
    n.attr.append(et.AttributeProto(name="comm_tag", int32_val=comm_tag))
    for dep in ctrl_deps:
        n.ctrl_deps.append(dep)
    return n


def _recv_node(node_id: int, name: str, peer_rank: int, comm_size_bytes: int,
               comm_tag: int, ctrl_deps: Iterable[int] = ()) -> et.Node:
    """Point-to-point recv. See _send_node for why comm_tag is required."""
    n = et.Node()
    n.id = node_id
    n.name = name
    n.type = et.COMM_RECV_NODE
    n.attr.append(et.AttributeProto(name="comm_src", int32_val=peer_rank))
    n.attr.append(et.AttributeProto(name="comm_size", int64_val=comm_size_bytes))
    n.attr.append(et.AttributeProto(name="comm_tag", int32_val=comm_tag))
    for dep in ctrl_deps:
        n.ctrl_deps.append(dep)
    return n


def _pp_tag(stage_low: int, direction: str) -> int:
    """Globally-unique tag for a PP send/recv pair across one boundary +
    direction. Same tag must appear at both ends of the link.
      tag = stage_low * 2 + dir_bit
    where stage_low is the lower-numbered PP stage of the boundary, and
    dir_bit = 0 for forward activation, 1 for backward gradient. This
    keeps fwd and bwd messages on the same boundary distinguishable so
    astra-sim doesn't accidentally pair fwd-send with bwd-recv."""
    dir_bit = 0 if direction == "fwd" else 1
    return stage_low * 2 + dir_bit


# ── Per-rank trace builder ────────────────────────────────────────────────


def build_rank_nodes(spec: TraceSpec, rank: int) -> list[et.Node]:
    """Generate the per-rank node sequence for one optimisation step.

    v0.1 (RFC-003 follow-up): the PP send/recv path was generating dependency
    graphs astra-sim's scheduler couldn't resolve — first run, the binary
    exited mid-simulation with `Hardware Resource sys.id=N has unreleased
    nodes`. Looking at upstream (chakra/src/converter/pytorch_converter.py +
    astra-sim's bundled microbench traces), every working flow uses
    COMM_COLL_NODE only — even pytorch traces don't reliably include
    SEND/RECV pairing attrs (no comm_dst/src/tag), suggesting the SEND/RECV
    path in this astra-sim build isn't production-ready.

    Tactical workaround: collapse PP into per-rank "TP+DP only" timing.
    PP still affects the per-rank work distribution (layers/PP, batch/PP),
    but stages no longer exchange messages — each rank's trace is:

        per layer { COMP fwd → TP all-reduce } loop
        per layer { COMP bwd → TP all-reduce } loop (reversed)
        if DP > 1: DP all-reduce of gradients

    This is a fidelity loss (no PP bubble, no inter-stage comm modelled)
    but matches the proven microbench-only pattern + actually completes.
    Real PP modelling is a follow-up (probably needs the converter v3
    flow + additional attrs we don't yet emit).

    Rank layout for sizing only (no inter-rank dependencies):
        rank = (dp_idx * PP + pp_idx) * TP + tp_idx
    """
    fwd_micros = _compute_micros(spec, fwd=True)
    bwd_micros = _compute_micros(spec, fwd=False)
    tp_size = _tp_allreduce_bytes(spec)
    grad_size = _dp_grad_bytes(spec)

    nodes: list[et.Node] = []
    nid = 0
    last = -1

    layers_per_stage = max(1, spec.n_layers // spec.PP)

    # Forward: COMP → TP all-reduce per layer.
    per_layer_fwd = max(1, fwd_micros // layers_per_stage)
    for layer in range(layers_per_stage):
        nodes.append(_comp_node(nid, f"fwd.compute.l{layer}.r{rank}",
                                  per_layer_fwd,
                                  ctrl_deps=([last] if last >= 0 else [])))
        last = nid; nid += 1
        if spec.TP > 1:
            nodes.append(_coll_node(nid, f"fwd.tp.allreduce.l{layer}.r{rank}",
                                      et.ALL_REDUCE, tp_size,
                                      ctrl_deps=[last]))
            last = nid; nid += 1

    # Backward: COMP → TP all-reduce per layer (reversed for backprop order).
    per_layer_bwd = max(1, bwd_micros // layers_per_stage)
    for layer in reversed(range(layers_per_stage)):
        nodes.append(_comp_node(nid, f"bwd.compute.l{layer}.r{rank}",
                                  per_layer_bwd,
                                  ctrl_deps=([last] if last >= 0 else [])))
        last = nid; nid += 1
        if spec.TP > 1:
            nodes.append(_coll_node(nid, f"bwd.tp.allreduce.l{layer}.r{rank}",
                                      et.ALL_REDUCE, tp_size, ctrl_deps=[last]))
            last = nid; nid += 1

    # DP all-reduce of gradients across data-parallel replicas.
    if spec.DP > 1:
        nodes.append(_coll_node(nid, f"dp.grad.allreduce.r{rank}",
                                  et.ALL_REDUCE, grad_size,
                                  ctrl_deps=([last] if last >= 0 else [])))
        last = nid; nid += 1

    return nodes


# ── File-level writer ─────────────────────────────────────────────────────


def write_trace(spec: TraceSpec, output_dir: Path) -> Path:
    """Write one ET file per rank into output_dir. Returns the prefix astra-sim
    expects (it appends `.{rank}.et` itself when reading)."""
    output_dir.mkdir(parents=True, exist_ok=True)
    prefix = output_dir / "trace"
    for rank in range(spec.world_size):
        et_path = output_dir / f"trace.{rank}.et"
        with open(et_path, "wb") as fh:
            encode_message(fh, et.GlobalMetadata(version="0.0.4"))
            for node in build_rank_nodes(spec, rank):
                encode_message(fh, node)
    # Drop a manifest so a human poking the cache can see what's inside.
    (output_dir / "spec.json").write_text(json.dumps(_spec_dict(spec), indent=2))
    return prefix


def write_trace_cached(spec: TraceSpec, root: Path) -> Path:
    """Cache wrapper. Same spec → reuses prior write. Returns prefix path."""
    cache_dir = trace_dir_for(spec, root)
    prefix = cache_dir / "trace"
    rank0 = cache_dir / "trace.0.et"
    if rank0.exists() and (cache_dir / "spec.json").exists():
        return prefix
    return write_trace(spec, cache_dir)


# Re-export for the wrapper to import without touching pb internals.
__all__ = ["TraceSpec", "build_rank_nodes", "trace_dir_for",
           "write_trace", "write_trace_cached"]


def _read_env_cache_root() -> Path:
    """Resolve the on-disk cache root from env var with a /tmp fallback so
    tests don't need to set anything. Production deploy points this at a
    persistent volume mounted into astra-sim-svc."""
    return Path(os.environ.get(
        "ASTRASIM_CHAKRA_CACHE",
        "/var/cache/bytesim/chakra",
    ))
