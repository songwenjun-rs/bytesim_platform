"""TCO computation kernel — pure functions, no PG.

Inputs: a "run shape" describing what hardware the run consumed and how long.
Output: a TcoBreakdown with per-bucket USD and an inputs_hash-style provenance
record so downstream callers can reproduce / diff two runs.

Design notes:
* Marginal, not absolute: the function returns the cost attributable to *this*
  run only. Two callers can run the same kernel on two designs and subtract.
* No staff / depreciation curve / team allocation — out of scope per product
  positioning (tech-team only, not FinOps).
* Sensitivities ∂TCO/∂{TP, PP, ckpt_interval, ...} are computed by perturbing
  the inputs and re-running; the kernel itself is pure so perturbation is cheap.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


# ── Inputs ────────────────────────────────────────────────────────────────

@dataclass
class GpuConsumption:
    """How the run used GPUs. Power values are time-averaged over wall_clock_s."""
    rule_id: str                     # which bs_tco_rule entry
    capex_usd: float                 # per-card capex
    power_w_load: int                # per-card load watts
    power_w_idle: int                # per-card idle watts
    pue: float                       # data-center PUE assumption
    electricity_usd_per_kwh: float
    count: int                       # how many cards
    utilization: float               # 0.0-1.0; weighted load vs idle
    amortization_y: int              # capex amortization period


@dataclass
class StorageConsumption:
    rule_id: str
    usd_per_gb_month: float
    gb: float                        # average GB occupied during the run
    months: float                    # equivalent storage-months (wall_clock / 730h)


@dataclass
class FailurePenalty:
    """Models wall-clock loss from failures. Kept simple: an expected restart
    fraction × an estimated extra wall-clock cost (priced at gpu_hour rate)."""
    expected_restart_fraction: float  # 0.0-1.0
    extra_wall_clock_h: float
    gpu_hour_usd: float


@dataclass
class TcoInputs:
    run_id: str
    wall_clock_s: float
    workload_mode: Literal["training", "inference"]
    gpus: list[GpuConsumption] = field(default_factory=list)
    storage: list[StorageConsumption] = field(default_factory=list)
    network_opex_usd_estimate: float = 0.0   # for now caller estimates; future: bs_link-derived
    failure: FailurePenalty | None = None

    # Throughput-side numbers used to compute per-token / per-request prices
    tokens_processed: float = 0.0
    inference_requests: float = 0.0


# ── Outputs ───────────────────────────────────────────────────────────────

@dataclass
class TcoBreakdown:
    hw_capex_amortized_usd: float
    power_opex_usd: float
    cooling_opex_usd: float
    network_opex_usd: float
    storage_opex_usd: float
    failure_penalty_usd: float
    total_usd: float

    per_m_token_usd: float | None
    per_gpu_hour_usd: float | None
    per_inference_request_usd: float | None

    rule_versions: dict[str, str]
    sensitivities: dict[str, float] = field(default_factory=dict)

    # P-Domain-1: KV cache storage portion (subset of storage_opex_usd,
    # kept separate for breakdown clarity). Computed by summing storage
    # rows whose rule_id starts with "kvcache-". Inclusive in
    # storage_opex_usd; total_usd does NOT double-count.
    kvcache_storage_opex_usd: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "hw_capex_amortized_usd": round(self.hw_capex_amortized_usd, 2),
            "power_opex_usd": round(self.power_opex_usd, 2),
            "cooling_opex_usd": round(self.cooling_opex_usd, 2),
            "network_opex_usd": round(self.network_opex_usd, 2),
            "storage_opex_usd": round(self.storage_opex_usd, 2),
            "kvcache_storage_opex_usd": round(self.kvcache_storage_opex_usd, 2),
            "failure_penalty_usd": round(self.failure_penalty_usd, 2),
            "total_usd": round(self.total_usd, 2),
            "per_m_token_usd": round(self.per_m_token_usd, 4) if self.per_m_token_usd is not None else None,
            "per_gpu_hour_usd": round(self.per_gpu_hour_usd, 4) if self.per_gpu_hour_usd is not None else None,
            "per_inference_request_usd": round(self.per_inference_request_usd, 6) if self.per_inference_request_usd is not None else None,
            "rule_versions": self.rule_versions,
            "sensitivities": {k: round(v, 4) for k, v in self.sensitivities.items()},
        }


# ── Kernel ────────────────────────────────────────────────────────────────

SECONDS_PER_HOUR = 3600.0
HOURS_PER_AMORT_YEAR = 24 * 365  # treats hardware as 100% in-service; conservative


def compute_tco(inputs: TcoInputs) -> TcoBreakdown:
    """Pure computation. Caller is responsible for resolving rule_id → fields."""
    wall_clock_h = inputs.wall_clock_s / SECONDS_PER_HOUR

    rule_versions: dict[str, str] = {}

    # ── HW CapEx amortization: capex × (wall_clock / amortization window) × count ──
    hw_capex = 0.0
    total_gpu_card_hours = 0.0
    for g in inputs.gpus:
        hours_in_window = HOURS_PER_AMORT_YEAR * g.amortization_y
        share = wall_clock_h / hours_in_window
        hw_capex += g.capex_usd * g.count * share
        total_gpu_card_hours += g.count * wall_clock_h
        rule_versions[f"gpu/{g.rule_id}"] = g.rule_id

    # ── Power OpEx: weighted (utilization × load + (1-util) × idle) × hours × kWh price ──
    # Cooling is broken out via PUE: cooling = power × (PUE - 1)
    raw_power_kwh = 0.0
    cooling_kwh = 0.0
    for g in inputs.gpus:
        avg_w = g.utilization * g.power_w_load + (1.0 - g.utilization) * g.power_w_idle
        gpu_kwh = (avg_w / 1000.0) * wall_clock_h * g.count
        raw_power_kwh += gpu_kwh
        cooling_kwh += gpu_kwh * (g.pue - 1.0)
    # use the first GPU rule's electricity price as canonical (homogeneous-cluster assumption)
    elec_price = inputs.gpus[0].electricity_usd_per_kwh if inputs.gpus else 0.092
    power_opex = raw_power_kwh * elec_price
    cooling_opex = cooling_kwh * elec_price

    # ── Storage OpEx: gb-months × $/gb-month ──
    # P-Domain-1: rows whose rule_id starts with "kvcache-" are also accumulated
    # into kvcache_storage_opex (a subset, NOT additive to storage_opex_usd).
    storage_opex = 0.0
    kvcache_storage_opex = 0.0
    for s in inputs.storage:
        cost = s.gb * s.months * s.usd_per_gb_month
        storage_opex += cost
        if s.rule_id.startswith("kvcache-"):
            kvcache_storage_opex += cost
        rule_versions[f"storage/{s.rule_id}"] = s.rule_id

    # ── Network OpEx (placeholder: caller supplies estimate) ──
    network_opex = inputs.network_opex_usd_estimate

    # ── Failure penalty ──
    failure_usd = 0.0
    if inputs.failure is not None:
        f = inputs.failure
        failure_usd = (f.expected_restart_fraction
                       * f.extra_wall_clock_h
                       * f.gpu_hour_usd
                       * sum(g.count for g in inputs.gpus))

    total = hw_capex + power_opex + cooling_opex + storage_opex + network_opex + failure_usd

    # ── Per-unit prices ──
    per_m_token = None
    per_request = None
    per_gpu_hour = total / total_gpu_card_hours if total_gpu_card_hours else None
    if inputs.tokens_processed > 0:
        per_m_token = total / (inputs.tokens_processed / 1_000_000.0)
    if inputs.inference_requests > 0:
        per_request = total / inputs.inference_requests

    return TcoBreakdown(
        hw_capex_amortized_usd=hw_capex,
        power_opex_usd=power_opex,
        cooling_opex_usd=cooling_opex,
        network_opex_usd=network_opex,
        storage_opex_usd=storage_opex,
        kvcache_storage_opex_usd=kvcache_storage_opex,
        failure_penalty_usd=failure_usd,
        total_usd=total,
        per_m_token_usd=per_m_token,
        per_gpu_hour_usd=per_gpu_hour,
        per_inference_request_usd=per_request,
        rule_versions=rule_versions,
    )


def compute_sensitivities(inputs: TcoInputs, perturb: dict[str, float] | None = None) -> dict[str, float]:
    """Numeric ∂total/∂x for a few canonical knobs.

    perturb: {param_name: relative_step}, default 5%. Returns sensitivities in
    USD per unit of the original parameter (e.g. ∂total/∂gpu_count in USD/card).
    """
    perturb = perturb or {"gpu_count": 0.05, "wall_clock_s": 0.05, "utilization": 0.05}
    base = compute_tco(inputs).total_usd
    out: dict[str, float] = {}

    if "gpu_count" in perturb and inputs.gpus:
        delta = perturb["gpu_count"]
        bumped = TcoInputs(**{**inputs.__dict__, "gpus": [
            GpuConsumption(**{**g.__dict__,
                              "count": max(g.count + 1, int(g.count * (1 + delta)))})
            for g in inputs.gpus
        ]})
        new_count = sum(g.count for g in bumped.gpus)
        old_count = sum(g.count for g in inputs.gpus)
        if new_count != old_count:
            out["d_total_per_card"] = (compute_tco(bumped).total_usd - base) / (new_count - old_count)

    if "wall_clock_s" in perturb:
        delta = perturb["wall_clock_s"]
        bumped = TcoInputs(**{**inputs.__dict__, "wall_clock_s": inputs.wall_clock_s * (1 + delta)})
        out["d_total_per_hour"] = (compute_tco(bumped).total_usd - base) / (inputs.wall_clock_s * delta / SECONDS_PER_HOUR)

    if "utilization" in perturb and inputs.gpus:
        delta = perturb["utilization"]
        bumped = TcoInputs(**{**inputs.__dict__, "gpus": [
            GpuConsumption(**{**g.__dict__, "utilization": min(1.0, g.utilization + delta)})
            for g in inputs.gpus
        ]})
        out["d_total_per_util_pp"] = (compute_tco(bumped).total_usd - base) / (delta * 100)

    return out
