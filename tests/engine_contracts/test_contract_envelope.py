"""CoverageEnvelope schema + envelope_covers() coverage check."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from engine_contracts import (
    CoverageEnvelope,
    HardwareScope,
    ParallelismRange,
    envelope_covers,
)


def _surrogate_envelope() -> CoverageEnvelope:
    """Mirrors the planned RFC §4.2 surrogate-analytical envelope."""
    return CoverageEnvelope(
        workload_families=["transformer-dense", "transformer-moe"],
        parallelism=ParallelismRange(
            TP=(1, 64), PP=(1, 64), EP=(1, 64), CP=(1, 8),
            recompute=["selective", "full"],
            overlap=["1F1B", "ZB", "ZBv2", "ring_compress", "Chimera"],
        ),
        hardware=HardwareScope(
            gpu_models=["B200", "H200", "GB300", "MI355X", "H100", "NPU-910"],
            fabric=["nvlink", "infiniband", "roce"],
            scale_gpus=(8, 8192),
        ),
        quant=["BF16", "FP8"],
        modes=["training", "inference"],
    )


def _astra_envelope() -> CoverageEnvelope:
    """Mirrors the planned RFC §4.2 astra-sim envelope (narrow on purpose
    until chakra writer lands; this is the *honest* declaration)."""
    return CoverageEnvelope(
        workload_families=["transformer-dense"],
        parallelism=ParallelismRange(
            TP=(1, 16), PP=(1, 1), EP=(1, 1), CP=(1, 1),
            recompute=["selective"],
            overlap=["1F1B"],
        ),
        hardware=HardwareScope(
            gpu_models=["B200", "H200", "H100"],
            fabric=["nvlink", "infiniband"],
            scale_gpus=(4, 16),
        ),
        quant=["BF16", "FP8"],
        modes=["training"],
    )


# ── schema validation ────────────────────────────────────────────────────


class TestEnvelopeSchema:
    def test_realistic_surrogate_envelope_validates(self) -> None:
        env = _surrogate_envelope()
        assert env.workload_families[0] == "transformer-dense"

    def test_realistic_astra_envelope_validates(self) -> None:
        env = _astra_envelope()
        assert env.parallelism.PP == (1, 1)

    def test_inverted_parallelism_interval_rejected(self) -> None:
        with pytest.raises(ValidationError) as ei:
            ParallelismRange(
                TP=(8, 4),  # inverted
                PP=(1, 1), EP=(1, 1), CP=(1, 1),
                recompute=["selective"], overlap=["1F1B"],
            )
        assert "TP interval invalid" in str(ei.value)

    def test_zero_lower_bound_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ParallelismRange(
                TP=(0, 8),  # min must be ≥ 1
                PP=(1, 1), EP=(1, 1), CP=(1, 1),
                recompute=["selective"], overlap=["1F1B"],
            )

    def test_inverted_scale_rejected(self) -> None:
        with pytest.raises(ValidationError):
            HardwareScope(
                gpu_models=["B200"], fabric=["nvlink"],
                scale_gpus=(8192, 8),  # inverted
            )

    def test_unknown_gpu_model_rejected(self) -> None:
        with pytest.raises(ValidationError):
            HardwareScope(
                gpu_models=["H800"],  # not in GpuModel literal
                fabric=["nvlink"], scale_gpus=(8, 8),
            )

    def test_unknown_fabric_rejected(self) -> None:
        with pytest.raises(ValidationError):
            HardwareScope(
                gpu_models=["B200"],
                fabric=["myrinet"],  # not in FabricKind literal
                scale_gpus=(8, 8),
            )

    def test_empty_workload_families_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CoverageEnvelope(
                workload_families=[],  # min_length=1
                parallelism=_surrogate_envelope().parallelism,
                hardware=_surrogate_envelope().hardware,
                quant=["FP8"], modes=["training"],
            )

    def test_unknown_quant_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CoverageEnvelope(
                workload_families=["transformer-dense"],
                parallelism=_surrogate_envelope().parallelism,
                hardware=_surrogate_envelope().hardware,
                quant=["FP4"],  # not in Quant literal
                modes=["training"],
            )


# ── envelope_covers ──────────────────────────────────────────────────────


class TestEnvelopeCovers:
    """Concrete cover/miss cases for the two reference engines. Each test pins
    a behaviour we'll rely on in §2.5 selector."""

    # --- surrogate (wide envelope) --------------------------------------

    def test_surrogate_covers_typical_llama_training(self) -> None:
        ok, misses = envelope_covers(
            _surrogate_envelope(),
            workload_family="transformer-dense", mode="training", quant="FP8",
            gpu_model="B200", gpu_count=1024,
            TP=8, PP=8, EP=1, CP=2,
            recompute="selective", overlap="ZBv2",
        )
        assert ok, f"unexpected misses: {misses}"

    def test_surrogate_covers_moe_inference(self) -> None:
        ok, _ = envelope_covers(
            _surrogate_envelope(),
            workload_family="transformer-moe", mode="inference", quant="FP8",
            gpu_model="H200", gpu_count=32,
            TP=8, PP=1, EP=4, CP=1,
            recompute="selective", overlap="ZBv2",
        )
        assert ok

    # --- astra-sim (narrow envelope, exposes the M3 reality) ------------

    def test_astra_covers_small_dense_training(self) -> None:
        ok, _ = envelope_covers(
            _astra_envelope(),
            workload_family="transformer-dense", mode="training", quant="FP8",
            gpu_model="H200", gpu_count=8,
            TP=8, PP=1, EP=1, CP=1,
            recompute="selective", overlap="1F1B",
        )
        assert ok

    def test_astra_rejects_moe_workload(self) -> None:
        ok, misses = envelope_covers(
            _astra_envelope(),
            workload_family="transformer-moe",  # not declared
            mode="training", quant="FP8",
            gpu_model="H200", gpu_count=8,
            TP=8, PP=1, EP=1, CP=1,
            recompute="selective", overlap="1F1B",
        )
        assert not ok
        assert any(m.field == "workload_family" for m in misses)

    def test_astra_rejects_oversize_cluster(self) -> None:
        ok, misses = envelope_covers(
            _astra_envelope(),
            workload_family="transformer-dense", mode="training", quant="FP8",
            gpu_model="H200", gpu_count=1024,  # > scale_gpus[1]=16
            TP=8, PP=1, EP=1, CP=1,
            recompute="selective", overlap="1F1B",
        )
        assert not ok
        assert any(m.field == "hardware.scale_gpus" for m in misses)

    def test_astra_rejects_pp_above_one(self) -> None:
        ok, misses = envelope_covers(
            _astra_envelope(),
            workload_family="transformer-dense", mode="training", quant="FP8",
            gpu_model="H200", gpu_count=8,
            TP=4, PP=2, EP=1, CP=1,  # PP=2 > [1,1]
            recompute="selective", overlap="1F1B",
        )
        assert not ok
        assert any(m.field == "parallelism.PP" for m in misses)

    def test_astra_rejects_unknown_overlap(self) -> None:
        ok, misses = envelope_covers(
            _astra_envelope(),
            workload_family="transformer-dense", mode="training", quant="FP8",
            gpu_model="H200", gpu_count=8,
            TP=8, PP=1, EP=1, CP=1,
            recompute="selective", overlap="Chimera",  # not declared
        )
        assert not ok
        assert any(m.field == "parallelism.overlap" for m in misses)

    def test_misses_collected_not_short_circuited(self) -> None:
        """When 3 fields fail, all 3 must come back so the 503 message can
        list them — this is the 'show what's missing' UX promise of §2.5."""
        ok, misses = envelope_covers(
            _astra_envelope(),
            workload_family="dlrm",        # miss 1
            mode="inference",              # miss 2
            quant="INT4",                  # miss 3
            gpu_model="H200", gpu_count=8,
            TP=8, PP=1, EP=1, CP=1,
            recompute="selective", overlap="1F1B",
        )
        assert not ok
        fields = {m.field for m in misses}
        assert {"workload_family", "mode", "quant"}.issubset(fields)

    def test_fabric_kinds_optional(self) -> None:
        ok, _ = envelope_covers(
            _surrogate_envelope(),
            workload_family="transformer-dense", mode="training", quant="FP8",
            gpu_model="B200", gpu_count=1024,
            TP=8, PP=8, EP=1, CP=2,
            recompute="selective", overlap="ZBv2",
            fabric_kinds=None,  # caller didn't supply fabric topology
        )
        assert ok

    def test_fabric_unknown_reported(self) -> None:
        ok, misses = envelope_covers(
            _astra_envelope(),
            workload_family="transformer-dense", mode="training", quant="FP8",
            gpu_model="H200", gpu_count=8,
            TP=8, PP=1, EP=1, CP=1,
            recompute="selective", overlap="1F1B",
            fabric_kinds=["roce"],  # astra envelope only declares nvlink + infiniband
        )
        assert not ok
        assert any(m.field == "hardware.fabric" for m in misses)


# ── round-trip via JSON (registry stores envelope as JSONB) ───────────────


class TestEnvelopeJSONRoundTrip:
    def test_envelope_survives_dump_validate(self) -> None:
        env = _surrogate_envelope()
        raw = env.model_dump_json()
        env2 = CoverageEnvelope.model_validate_json(raw)
        assert env2 == env
