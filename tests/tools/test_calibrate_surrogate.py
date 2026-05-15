"""Tests for `tools/calibrate_surrogate.py`.

Synthesize ground truth from a known drag table, run the fitter, assert
the recovered drag values are close to truth and MAPE is small."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.calibrate_surrogate import (  # noqa: E402
    BASELINE_DRAG, BASELINE_GPU,
    actual_mfu, build_calibration, fit_all, fit_cell,
)


# ── synthesize ground truth from a known drag table ──────────────────────


def _synth_sample(gpu_model, family, recompute, overlap, *, drag, PP=4, EP=1, CP=1, TP=4,
                  activated_b=8.0, total_b=8.0, quant="FP8", seq_len=8192, batch=4096):
    nvlink_domain = BASELINE_GPU[gpu_model]["nvlink_domain"]
    bubble = max(0.0, (PP - 1) * drag["pp_bubble_per_step"] - 0.005)
    overlap_drag = drag["overlap_drag"][overlap]
    recompute_drag = drag["recompute_drag"][recompute]
    ep_cross = max(0.0, EP - max(1, nvlink_domain // 8)) * drag["ep_cross_per_step"]
    cp_gain = 0.005 if (CP >= 2 and seq_len >= 8192) else 0.0
    # Mirror surrogate's mfu_ceiling logic
    fp8_ceil = BASELINE_GPU[gpu_model]["peak_mfu_fp8"]
    bf16_ceil = BASELINE_GPU[gpu_model]["peak_mfu_bf16"]
    if quant == "BF16":
        ceil = bf16_ceil
    elif quant == "FP4" and BASELINE_GPU[gpu_model].get("fp4_supported"):
        ceil = min(0.68, fp8_ceil + 0.03)
    else:
        ceil = fp8_ceil
    mfu = max(0.10, min(0.68, ceil - bubble - overlap_drag - recompute_drag - ep_cross + cp_gain))

    return {
        "cluster": {"gpu_model": gpu_model, "gpu_count": 256},
        "model": {"family": family, "activated_params_b": activated_b,
                  "total_params_b": total_b, "weight_quant": quant},
        "workload": {"mode": "training", "seq_len": seq_len, "global_batch": batch},
        "strategy": {"TP": TP, "PP": PP, "EP": EP, "CP": CP,
                     "recompute": recompute, "overlap": overlap},
        "measured": {"mfu_pct": round(mfu * 100, 4)},
    }


def _truth_drag():
    """A drag table that's noticeably different from BASELINE so the fit
    must do real work. recompute.selective tightened, overlap.1F1B looser."""
    return {
        "recompute_drag": {"selective": 0.012, "full": 0.040, "none": 0.0},
        "overlap_drag": {"1F1B": 0.055, "ZB": 0.022, "ZBv2": 0.000,
                          "ring_compress": 0.012, "Chimera": 0.020},
        "pp_bubble_per_step": BASELINE_DRAG["pp_bubble_per_step"],
        "ep_cross_per_step": BASELINE_DRAG["ep_cross_per_step"],
    }


# ── unit tests ────────────────────────────────────────────────────────────


def test_actual_mfu_round_trips_from_step_ms():
    """Given a known step_ms produced by a known mfu, actual_mfu must
    recover the original mfu via the surrogate FLOPs formula."""
    s = _synth_sample("B200", "transformer-dense", "selective", "ZBv2", drag=_truth_drag())
    mfu_pct_known = s["measured"]["mfu_pct"]

    # Reverse: produce step_ms from that mfu, then re-derive
    activated = s["model"]["activated_params_b"]
    flops = 6.0 * activated * 1e9 * s["workload"]["seq_len"] * s["workload"]["global_batch"]
    cluster_flops = s["cluster"]["gpu_count"] * BASELINE_GPU["B200"]["fp8_pflops"] * 1e15
    step_s = flops / (cluster_flops * mfu_pct_known / 100.0)
    s2 = {**s, "measured": {"step_ms": step_s * 1000}}
    assert actual_mfu(s2) == pytest.approx(mfu_pct_known / 100.0, rel=1e-6)


def test_fit_recovers_truth_drag_when_data_is_noiseless():
    truth = _truth_drag()
    samples = []
    # Sweep all 9 (recompute, overlap) combinations × 2 PP values
    for r in ("selective", "full"):
        for o in ("1F1B", "ZB", "ZBv2"):
            for PP in (1, 4):
                samples.append(_synth_sample(
                    "B200", "transformer-dense", r, o, drag=truth, PP=PP,
                ))
    cell = fit_cell(samples, "B200")

    # Recovered values within 0.5pp of truth on the sweep grid
    for r in ("selective", "full"):
        assert cell["recompute_drag"][r] == pytest.approx(truth["recompute_drag"][r], abs=0.005)
    for o in ("1F1B", "ZB", "ZBv2"):
        assert cell["overlap_drag"][o] == pytest.approx(truth["overlap_drag"][o], abs=0.005)
    # MAPE on noiseless data should be tiny
    assert cell["mape_pct"] < 1.0


def test_fit_skips_unmeasured_keys_at_baseline():
    """If no sample uses recompute=full, the fitter should leave that key
    at its baseline rather than pulling it toward something arbitrary."""
    truth = _truth_drag()
    samples = [
        _synth_sample("B200", "transformer-dense", "selective", "ZBv2", drag=truth),
        _synth_sample("B200", "transformer-dense", "selective", "1F1B", drag=truth, PP=4),
        _synth_sample("B200", "transformer-dense", "selective", "ZB", drag=truth),
        _synth_sample("B200", "transformer-dense", "selective", "ZBv2", drag=truth, PP=2),
    ]
    cell = fit_cell(samples, "B200")
    # full was never observed → baseline kept
    assert cell["recompute_drag"]["full"] == BASELINE_DRAG["recompute_drag"]["full"]


def test_fit_all_skips_underpopulated_cells():
    truth = _truth_drag()
    # B200/dense gets 6 samples; H100/moe gets 1 (below default min=4)
    samples = [
        _synth_sample("B200", "transformer-dense", "selective", "ZBv2", drag=truth),
        _synth_sample("B200", "transformer-dense", "selective", "1F1B", drag=truth),
        _synth_sample("B200", "transformer-dense", "selective", "ZB", drag=truth),
        _synth_sample("B200", "transformer-dense", "full", "ZBv2", drag=truth),
        _synth_sample("B200", "transformer-dense", "full", "ZB", drag=truth),
        _synth_sample("B200", "transformer-dense", "full", "1F1B", drag=truth),
        _synth_sample("H100", "transformer-moe", "selective", "1F1B", drag=truth),
    ]
    cells = fit_all(samples, min_samples=4)
    assert "B200/transformer-dense" in cells
    assert "H100/transformer-moe" not in cells


def test_fit_records_metadata():
    truth = _truth_drag()
    samples = [
        _synth_sample("B200", "transformer-dense", "selective", "ZBv2", drag=truth)
        for _ in range(5)
    ]
    cell = fit_cell(samples, "B200")
    assert cell["n_samples"] == 5
    assert "mape_pct" in cell
    assert cell["pp_bubble_per_step"] == BASELINE_DRAG["pp_bubble_per_step"]
    assert cell["ep_cross_per_step"] == BASELINE_DRAG["ep_cross_per_step"]


def test_build_calibration_wraps_cells():
    blob = build_calibration({"B200/transformer-dense": {"recompute_drag": {}}})
    assert blob["version"] == "1"
    assert "calibrated_at" in blob
    assert blob["method"] == "coordinate_descent_lstsq"
    assert "B200/transformer-dense" in blob["cells"]


# ── CLI integration ──────────────────────────────────────────────────────


def test_cli_dry_run_prints_calibration_json(tmp_path):
    truth = _truth_drag()
    samples = []
    for r in ("selective", "full"):
        for o in ("1F1B", "ZB", "ZBv2"):
            samples.append(_synth_sample(
                "B200", "transformer-dense", r, o, drag=truth,
            ))
    truth_file = tmp_path / "samples.json"
    truth_file.write_text(json.dumps({"samples": samples}))

    # Run the CLI as a subprocess so we exercise main() + arg parsing
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "calibrate_surrogate.py"),
         "--truth-file", str(truth_file), "--dry-run"],
        capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(ROOT)},
    )
    assert result.returncode == 0, result.stderr
    blob = json.loads(result.stdout)
    assert blob["version"] == "1"
    assert "B200/transformer-dense" in blob["cells"]


def test_cli_errors_when_min_samples_blocks_all_cells(tmp_path):
    samples = [
        _synth_sample("B200", "transformer-dense", "selective", "ZBv2", drag=_truth_drag()),
    ]
    truth_file = tmp_path / "samples.json"
    truth_file.write_text(json.dumps({"samples": samples}))
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "calibrate_surrogate.py"),
         "--truth-file", str(truth_file), "--dry-run", "--min-samples", "10"],
        capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(ROOT)},
    )
    assert result.returncode != 0
    assert "no cells passed" in result.stderr
