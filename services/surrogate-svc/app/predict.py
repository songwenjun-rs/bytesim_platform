"""Analytical surrogate. Replaces a real neural surrogate for slice-3.

Inputs are a hardware profile + a training/inference workload + a strategy
combo. The output mirrors what the prototype's Pareto / Top-K table consumes.

The formulas here are illustrative — they reflect the *shape* of the constraints
in the prototype (PP bubble, EP-cross-domain penalty, recompute drag, overlap
gain) but the constants are not calibrated. Real ByteSim swaps this whole module
with a trained neural net.
"""
from __future__ import annotations

import math
import random
from typing import Any, Literal

from pydantic import BaseModel, Field


GpuModel = Literal["B200", "H200", "GB300", "MI355X", "H100", "NPU-910"]
Recompute = Literal["selective", "full"]
Overlap = Literal["1F1B", "ZB", "ZBv2", "ring_compress", "Chimera"]


# Per-GPU profile. In production this comes from the Profile data lake.
GPU_PROFILE: dict[GpuModel, dict[str, float]] = {
    "B200":   {"hbm_gb": 192, "fp8_pflops": 4.9, "tdp_kw": 1.2,  "nvlink_domain": 72, "ref_price_usd": 39200},
    "H200":   {"hbm_gb": 141, "fp8_pflops": 3.9, "tdp_kw": 0.7,  "nvlink_domain": 32, "ref_price_usd": 28400},
    "GB300":  {"hbm_gb": 288, "fp8_pflops": 6.4, "tdp_kw": 1.4,  "nvlink_domain": 72, "ref_price_usd": 52800},
    "MI355X": {"hbm_gb": 288, "fp8_pflops": 4.2, "tdp_kw": 0.75, "nvlink_domain": 8,  "ref_price_usd": 24100},
    "H100":   {"hbm_gb": 80,  "fp8_pflops": 2.0, "tdp_kw": 0.7,  "nvlink_domain": 32, "ref_price_usd": 24800},
    "NPU-910":{"hbm_gb": 96,  "fp8_pflops": 2.4, "tdp_kw": 0.55, "nvlink_domain": 8,  "ref_price_usd": 18000},
}

# Recompute drag (loss in achievable utilization).
RECOMPUTE_DRAG = {"selective": 0.020, "full": 0.055}
# Overlap gain (negative = gain).
OVERLAP_DRAG = {"1F1B": 0.040, "ZB": 0.020, "ZBv2": 0.000, "ring_compress": 0.012, "Chimera": 0.018}


class StrategyParams(BaseModel):
    TP: int = Field(ge=1, le=64)
    PP: int = Field(ge=1, le=64)
    EP: int = Field(ge=1, le=64)
    CP: int = Field(ge=1, le=8, default=1)
    recompute: Recompute = "selective"
    overlap: Overlap = "ZBv2"


class KVCacheConfig(BaseModel):
    """P-Domain-1: KV cache hints. Inference engines use these to predict
    hit rate and storage tier pressure. Optional — absent means engine
    falls back to the legacy aggregate model."""
    kv_size_gb_per_seq: float = 0.020      # bytes per seq, depends on quant + heads
    prefix_share_ratio: float = 0.0        # 0..1; chat templates ≈ 0.6+, batch ≈ 0
    page_size_kb: int = 16                 # paged attention block size
    avg_active_seqs: int = 256             # in-flight sequences per replica


class Workload(BaseModel):
    mode: Literal["training", "inference"] = "training"
    seq_len: int = 8192
    global_batch: int = 4096
    activated_params_b: float = 8.0
    total_params_b: float = 512.0
    quant: Literal["BF16", "FP8"] = "FP8"
    kvcache_config: KVCacheConfig | None = None


class FabricLink(BaseModel):
    """P-Domain-2: a single edge in the network topology snapshot.
    Engines that opt in to fabric awareness consume the fabric_topology
    list and report per-link utilization."""
    id: str
    src_id: str
    dst_id: str
    fabric: str          # nvlink | infiniband | roce | cxl | pcie | ethernet
    bw_gbps: float


class Cluster(BaseModel):
    gpu_model: GpuModel = "B200"
    gpu_count: int = Field(default=1024, ge=8, le=8192)
    electricity_usd_per_kwh: float = 0.092
    pue: float = 1.18
    fabric_topology: list[FabricLink] | None = None


class PredictRequest(BaseModel):
    cluster: Cluster
    workload: Workload
    strategy: StrategyParams
    surrogate_version: str = "v2.4"


class PredictResponse(BaseModel):
    mfu_pct: float
    step_ms: float
    # Slice §5: cost is no longer a surrogate output. tco-engine-svc owns it.
    # Field kept for back-compat (callers may still read it during migration);
    # value is "best-effort electricity-only proxy" not real TCO.
    cost_per_m_tok_usd: float
    peak_kw: float
    ttft_ms: float
    tpot_ms: float
    confidence: float
    feasible: bool
    notes: list[str] = []
    # P-Domain-1: KV cache outputs (only set when mode=inference and
    # workload.kvcache_config provided). Reading order: hit_rate first
    # (drives QPS gain), then pressure_pct (>100 means spill), then
    # spill_bytes_per_s (driver of storage TCO).
    kv_hit_rate: float | None = None       # 0..1
    cache_pressure_pct: float | None = None  # 0..200+ (>100 → spilling)
    spill_bytes_per_s: float | None = None   # bytes/sec leaving HBM
    # P-Domain-2: per-link utilization (only when cluster.fabric_topology
    # is supplied). Each entry is {link_id, util_pct}. Sorted desc by
    # util — the "top hot links" the architect should worry about.
    link_util_top: list[dict[str, Any]] | None = None


# Workload constants (BF16 vs FP8 affect arithmetic intensity)
def _flops_per_token(w: Workload) -> float:
    # 6 * params per token is the back-of-envelope for fwd+bwd in dense.
    # MoE: only activated params count.
    return 6.0 * w.activated_params_b * 1e9


def _fabric_link_util(
    fabric: list[FabricLink],
    s: StrategyParams,
    nvlink_domain: int,
    mfu: float,
) -> list[dict[str, Any]]:
    """Analytical link utilization model.

    Heuristic — not a real network simulator, just enough to make the UI
    surface "this design saturates IB" decisions:

      - NVLink intra-server: utilization tracks TP communication intensity.
        If TP fits inside nvlink_domain, util ~ 0.5 × mfu × (TP/nvlink_domain).
      - InfiniBand/RoCE cross-rack: dominated by PP + EP cross-domain
        traffic. EP > nvlink_domain or PP > 1 push util sharply up.
      - CXL: low util in this surrogate (memory-only) — treated as 5-15%.

    Returns sorted desc by util_pct, capped at 100 (saturated).
    """
    out: list[dict[str, Any]] = []
    ep_cross = max(0, s.EP - max(1, nvlink_domain // 8))
    cross_pod_pressure = (s.PP - 1) * 0.15 + ep_cross * 0.20

    for link in fabric:
        if link.fabric == "nvlink":
            # Intra-server TP collectives — saturates if TP near domain limit
            tp_load = min(1.0, s.TP / max(1, nvlink_domain))
            util = mfu * tp_load * 50.0  # 0..50% range
        elif link.fabric in ("infiniband", "roce"):
            # Cross-rack scale-out — PP/EP traffic
            util = mfu * 30.0 + cross_pod_pressure * 100.0
        elif link.fabric == "cxl":
            util = 5.0 + mfu * 10.0
        elif link.fabric == "pcie":
            util = mfu * 15.0
        else:  # ethernet (control plane)
            util = mfu * 5.0
        # Bandwidth bonus penalty: low-bw links saturate first
        if link.bw_gbps < 100:
            util *= 1.4
        util = max(0.0, min(100.0, util))
        out.append({"link_id": link.id, "fabric": link.fabric, "util_pct": round(util, 2)})

    out.sort(key=lambda r: r["util_pct"], reverse=True)
    return out


def _kvcache_predict(
    kv: KVCacheConfig, hbm_gb: float, step_seconds: float,
) -> tuple[float, float, float]:
    """Analytical KV cache model.

    Returns (hit_rate, pressure_pct, spill_bytes_per_s).

    Hit rate is bounded by prefix sharing (the "hot" portion always hits)
    plus a working-set-vs-capacity fit term for the non-shared portion.
    Pressure is working set / HBM (>100% triggers spill).
    """
    working_set_gb = kv.avg_active_seqs * kv.kv_size_gb_per_seq
    pressure_pct = working_set_gb / max(hbm_gb, 1e-6) * 100.0

    # Non-shared portion's capacity fit: capped at 1.0 when working set fits.
    fit = min(1.0, hbm_gb / max(working_set_gb, 1e-6))
    hit_rate = kv.prefix_share_ratio + (1.0 - kv.prefix_share_ratio) * fit
    hit_rate = max(0.0, min(1.0, hit_rate))

    # Spill: only when working set exceeds HBM. ~1 round-trip per step.
    spill_gb = max(0.0, working_set_gb - hbm_gb) * (1.0 - kv.prefix_share_ratio)
    spill_bytes_per_s = spill_gb * 1e9 / max(step_seconds, 1e-3)

    return hit_rate, pressure_pct, spill_bytes_per_s


def predict(req: PredictRequest) -> PredictResponse:
    gpu = GPU_PROFILE[req.cluster.gpu_model]
    s = req.strategy
    cluster = req.cluster
    w = req.workload

    parallel_capacity = s.TP * s.PP * s.EP * s.CP
    notes: list[str] = []
    feasible = True

    if parallel_capacity > cluster.gpu_count:
        feasible = False
        notes.append(f"TP×PP×EP×CP={parallel_capacity} > GPU 数 {cluster.gpu_count}")

    # MFU ceiling depends on FP8 enable & overall scale. 60% on B200 FP8, 50% otherwise.
    mfu_ceiling = 0.60 if (cluster.gpu_model == "B200" and w.quant == "FP8") else 0.52

    # Bubble grows with PP - 1 (1F1B baseline) but Overlap can shrink it.
    bubble = max(0.0, (s.PP - 1) * 0.006 - 0.005)
    overlap_drag = OVERLAP_DRAG.get(s.overlap, 0.03)
    recompute_drag = RECOMPUTE_DRAG.get(s.recompute, 0.03)

    # EP penalty if EP exceeds NVLink domain (cross-domain all-to-all hits Scale-Out).
    ep_cross = max(0.0, (s.EP - max(1, gpu["nvlink_domain"] // 8))) * 0.012
    if s.EP >= 16 and cluster.gpu_model == "MI355X":
        notes.append("EP=16 在 MI355X 上 OOD（覆盖 0 条）")
        feasible = False

    # CP only helps when seq_len > 8k.
    cp_gain = 0.005 if (s.CP >= 2 and w.seq_len >= 8192) else 0.0

    mfu = mfu_ceiling - bubble - overlap_drag - recompute_drag - ep_cross + cp_gain
    # Deterministic small jitter so equivalent params yield equivalent objectives.
    rng = random.Random(hash((cluster.gpu_model, s.TP, s.PP, s.EP, s.CP, s.recompute, s.overlap)))
    mfu += rng.uniform(-0.004, 0.004)
    mfu = max(0.10, min(0.65, mfu))

    flops_per_token = _flops_per_token(w)
    flops_per_step = flops_per_token * w.global_batch * w.seq_len
    cluster_flops = cluster.gpu_count * gpu["fp8_pflops"] * 1e15
    step_seconds = flops_per_step / (cluster_flops * mfu)
    step_ms = step_seconds * 1000.0

    # Power: TDP fully loaded × PUE; small premium for cooling on hot kernels.
    peak_kw = cluster.gpu_count * gpu["tdp_kw"] * cluster.pue + (s.PP - 1) * 0.4
    if peak_kw > 900:
        notes.append(f"峰值功率 {peak_kw:.0f} kW 超过机房限 900 kW")
        feasible = False

    # Token throughput → cost per million tokens (electricity + cooling only).
    tokens_per_step = w.global_batch * w.seq_len
    tokens_per_sec = tokens_per_step / step_seconds
    energy_per_m_tok_kwh = (peak_kw * 1.0e6 / tokens_per_sec) / 3600.0
    cost_per_m_tok_usd = energy_per_m_tok_kwh * cluster.electricity_usd_per_kwh

    # Inference KPIs (approximate, only for inference workloads).
    ttft_ms = 80 + s.PP * 20 + (s.TP / 4) * 30 + (1 - mfu) * 200
    tpot_ms = 12 + (s.TP - 1) * 1.2 + (1 - mfu) * 60
    if w.mode == "inference" and ttft_ms > req_constraint_ttft():
        notes.append(f"TTFT {ttft_ms:.0f} ms 超过 SLO 300 ms")
        feasible = False

    confidence = 0.94
    if cluster.gpu_model in {"GB300", "MI355X"}:
        confidence -= 0.10
        notes.append(f"{cluster.gpu_model} Profile 覆盖度低（C/OOD），置信度下降")
    if s.overlap == "Chimera":
        confidence -= 0.05
        notes.append("Chimera overlap 实验性，置信度下降")

    # P-Domain-1: KV cache outputs (inference + kvcache_config supplied)
    kv_hit_rate: float | None = None
    cache_pressure_pct: float | None = None
    spill_bytes_per_s: float | None = None
    if w.mode == "inference" and w.kvcache_config is not None:
        kv_hit_rate, cache_pressure_pct, spill_bytes_per_s = _kvcache_predict(
            w.kvcache_config, gpu["hbm_gb"], step_seconds,
        )
        if cache_pressure_pct > 100:
            notes.append(f"KV 工作集 {cache_pressure_pct:.0f}% 超出 HBM，需 spill 到下层")

    # P-Domain-2: link utilization (only if fabric_topology supplied)
    link_util_top: list[dict[str, Any]] | None = None
    if cluster.fabric_topology:
        link_util_top = _fabric_link_util(
            cluster.fabric_topology, s, gpu["nvlink_domain"], mfu,
        )
        # If any link is saturated, surface in notes
        if link_util_top and link_util_top[0]["util_pct"] >= 90:
            hot = link_util_top[0]
            notes.append(f"链路 {hot['link_id']} ({hot['fabric']}) 利用率 {hot['util_pct']}% — 接近饱和")

    return PredictResponse(
        mfu_pct=round(mfu * 100, 2),
        step_ms=round(step_ms, 1),
        cost_per_m_tok_usd=round(cost_per_m_tok_usd, 4),
        peak_kw=round(peak_kw, 1),
        ttft_ms=round(ttft_ms, 1),
        tpot_ms=round(tpot_ms, 2),
        confidence=round(max(0.50, confidence), 3),
        feasible=feasible,
        notes=notes,
        kv_hit_rate=round(kv_hit_rate, 3) if kv_hit_rate is not None else None,
        cache_pressure_pct=round(cache_pressure_pct, 1) if cache_pressure_pct is not None else None,
        spill_bytes_per_s=round(spill_bytes_per_s, 0) if spill_bytes_per_s is not None else None,
        link_util_top=link_util_top,
    )


def req_constraint_ttft() -> float:
    return 300.0
