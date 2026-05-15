"""Fit surrogate drag coefficients from ground-truth runs and PATCH the
result to engine-registry's calibration column.

Phase 4 leaves the (gpu_model, family) cells in `bs_engine.calibration`
empty — surrogate falls back to BASELINE_DRAG and reports a -0.05
"未注入校准数据" confidence haircut. This tool is the operations-side
loop that produces those cells from measured data:

  1. Caller assembles a JSON file of (config → measured step_ms or mfu_pct)
     observations from bytesim_svc runs, real-cluster profiling, etc.
  2. The tool groups by (gpu_model, family), fits `recompute_drag` and
     `overlap_drag` dictionaries via coordinate descent against actual MFU,
     and computes per-cell MAPE.
  3. Writes the resulting `{ "version": "1", "cells": {...} }` blob to
     stdout (--dry-run) or PATCHes it to /v1/engines/{name}/calibration.

Scope limits — by design:
  - Fits only recompute_drag + overlap_drag dicts. pp_bubble_per_step
    and ep_cross_per_step stay at baseline; sparse cells would otherwise
    overfit those two scalars badly.
  - Cells with fewer than --min-samples observations are skipped.
  - All math is plain Python (no numpy / scipy) to keep tools/ deps slim.

Truth file shape (`samples.json`):
  {
    "samples": [
      {
        "cluster": {"gpu_model": "B200", "gpu_count": 256},
        "model":   {"family": "transformer-dense", "activated_params_b": 70.0,
                    "total_params_b": 70.0, "weight_quant": "FP8"},
        "workload":{"mode": "training", "seq_len": 8192, "global_batch": 4096},
        "strategy":{"TP": 4, "PP": 4, "EP": 1, "CP": 1,
                    "recompute": "selective", "overlap": "ZBv2"},
        "measured":{"step_ms": 2080}        # or {"mfu_pct": 45.2}
      },
      ...
    ]
  }

Usage:
  python tools/calibrate_surrogate.py \
      --truth-file calibration_data.json \
      --registry-url http://engine_registry_svc:8089 \
      --engine-name surrogate-analytical
  python tools/calibrate_surrogate.py --truth-file calibration_data.json --dry-run
"""
from __future__ import annotations

import argparse
import copy
import datetime as _dt
import json
import sys
import urllib.error
import urllib.request
from typing import Any


# ── Hardware + drag baselines (kept in sync with services/surrogate_svc) ──

BASELINE_DRAG: dict[str, Any] = {
    "recompute_drag": {"selective": 0.020, "full": 0.055, "none": 0.0},
    "overlap_drag": {
        "1F1B": 0.040, "ZB": 0.020, "ZBv2": 0.000,
        "ring_compress": 0.012, "Chimera": 0.018,
    },
    "pp_bubble_per_step": 0.006,
    "ep_cross_per_step": 0.012,
}

# Subset of GPU profile this tool needs — peak FLOPS for reverse-MFU and
# nvlink_domain for the EP-cross term. Values mirror surrogate's
# BASELINE_PROFILE; production runs should override via --gpu-profile-file.
BASELINE_GPU: dict[str, dict[str, Any]] = {
    "B200":   {"fp8_pflops": 4.9, "nvlink_domain": 72, "fp4_supported": True,  "peak_mfu_fp8": 0.60, "peak_mfu_bf16": 0.48},
    "H200":   {"fp8_pflops": 3.9, "nvlink_domain": 32, "fp4_supported": False, "peak_mfu_fp8": 0.52, "peak_mfu_bf16": 0.46},
    "GB300":  {"fp8_pflops": 6.4, "nvlink_domain": 72, "fp4_supported": True,  "peak_mfu_fp8": 0.58, "peak_mfu_bf16": 0.50},
    "MI355X": {"fp8_pflops": 4.2, "nvlink_domain": 8,  "fp4_supported": True,  "peak_mfu_fp8": 0.42, "peak_mfu_bf16": 0.42},
    "H100":   {"fp8_pflops": 2.0, "nvlink_domain": 32, "fp4_supported": False, "peak_mfu_fp8": 0.50, "peak_mfu_bf16": 0.46},
    "NPU-910":{"fp8_pflops": 2.4, "nvlink_domain": 8,  "fp4_supported": False, "peak_mfu_fp8": 0.45, "peak_mfu_bf16": 0.45},
}


def _peak_pflops(gpu_model: str, quant: str) -> float:
    profile = BASELINE_GPU[gpu_model]
    fp8 = profile["fp8_pflops"]
    if quant == "BF16":
        return fp8 * 0.5
    if quant in ("FP4", "INT4"):
        return fp8 * 2.0 if profile.get("fp4_supported") else fp8
    return fp8


def _mfu_ceiling(gpu_model: str, quant: str) -> float:
    profile = BASELINE_GPU[gpu_model]
    fp8_ceiling = float(profile.get("peak_mfu_fp8", 0.52))
    bf16_ceiling = float(profile.get("peak_mfu_bf16", fp8_ceiling - 0.05))
    if quant == "BF16":
        return bf16_ceiling
    if quant == "FP4" and profile.get("fp4_supported"):
        return min(0.68, fp8_ceiling + 0.03)
    return fp8_ceiling


def _cp_gain(strategy: dict[str, Any], workload: dict[str, Any]) -> float:
    return 0.005 if (strategy.get("CP", 1) >= 2 and workload.get("seq_len", 0) >= 8192) else 0.0


def actual_mfu(sample: dict[str, Any]) -> float:
    """Resolve the sample's actual MFU, either from `measured.mfu_pct` or
    by reverse-applying the FLOPs formula to `measured.step_ms`."""
    measured = sample["measured"]
    if "mfu_pct" in measured:
        return float(measured["mfu_pct"]) / 100.0
    cluster = sample["cluster"]
    model = sample["model"]
    workload = sample["workload"]
    flops = 6.0 * model["activated_params_b"] * 1e9 * workload["seq_len"] * workload["global_batch"]
    cluster_flops = cluster["gpu_count"] * _peak_pflops(cluster["gpu_model"], model["weight_quant"]) * 1e15
    step_s = measured["step_ms"] / 1000.0
    return flops / (cluster_flops * step_s)


# ── Core fit ──────────────────────────────────────────────────────────────


def _drag_total(strategy: dict[str, Any], workload: dict[str, Any],
                drag: dict[str, Any], nvlink_domain: int) -> float:
    """Mirror of surrogate's drag math: bubble + overlap + recompute + ep − cp."""
    PP = strategy["PP"]
    EP = strategy["EP"]
    bubble = max(0.0, (PP - 1) * drag["pp_bubble_per_step"] - 0.005)
    overlap = drag["overlap_drag"].get(strategy["overlap"], 0.03)
    recompute = drag["recompute_drag"].get(strategy["recompute"], 0.03)
    ep_cross = max(0.0, (EP - max(1, nvlink_domain // 8))) * drag["ep_cross_per_step"]
    return bubble + overlap + recompute + ep_cross - _cp_gain(strategy, workload)


def fit_cell(
    samples: list[dict[str, Any]],
    gpu_model: str,
    iterations: int = 20,
) -> dict[str, Any]:
    """Coordinate-descent fit of recompute_drag + overlap_drag for one
    (gpu_model, family) cell. Holds pp_bubble + ep_cross at baseline.

    Each iteration: for every key actually present in samples, set its
    drag value to the mean residual once every other term is held fixed.
    Converges within a handful of rounds since recompute and overlap are
    near-orthogonal axes in the surrogate formula.

    Returns the fitted cell dict in the schema engine-registry expects."""
    nvlink_domain = BASELINE_GPU[gpu_model]["nvlink_domain"]
    drag = copy.deepcopy(BASELINE_DRAG)

    # Pre-compute target_drag = mfu_ceiling - actual_mfu per sample. The
    # fit minimizes the difference between drag_total(sample) and target.
    targets: list[float] = []
    for s in samples:
        ceil = _mfu_ceiling(s["cluster"]["gpu_model"], s["model"]["weight_quant"])
        mfu_act = actual_mfu(s)
        # target_total_drag = ceil - mfu_actual; but our drag_total includes -cp_gain,
        # so equivalently target = ceil - mfu_actual - cp_gain → drag_total = target - cp_gain
        # We store the no-cp-gain-adjusted target directly.
        targets.append(ceil - mfu_act + _cp_gain(s["strategy"], s["workload"]))

    # `recompute_drag` + `overlap_drag` are only ever observed as a sum, so
    # the fit is rank-deficient by 1 unless we anchor a reference value.
    # Use the surrogate's natural zeros (`overlap=ZBv2`, `recompute=none`)
    # which by construction add no drag. Anchored entries are held fixed
    # at 0; everything else becomes identifiable relative to them.
    ANCHORS = {
        "overlap_drag": {"ZBv2"},
        "recompute_drag": {"none"},
    }

    def _fit_dict(field: str, key_field: str) -> None:
        keys = {s["strategy"][key_field] for s in samples}
        for k in keys:
            if k in ANCHORS.get(field, set()):
                drag[field][k] = 0.0  # canonical zero — never moves
                continue
            relevant = [(i, s) for i, s in enumerate(samples) if s["strategy"][key_field] == k]
            if not relevant:
                continue
            # For each relevant sample, the OPTIMAL drag[k] makes
            # drag_total == target. Subtract everything else and average.
            others_sum = 0.0
            for i, s in relevant:
                current_total = _drag_total(s["strategy"], s["workload"], drag, nvlink_domain)
                others = current_total - drag[field][k]
                others_sum += targets[i] - others
            drag[field][k] = others_sum / len(relevant)

    for _ in range(iterations):
        prev = copy.deepcopy(drag)
        _fit_dict("recompute_drag", "recompute")
        _fit_dict("overlap_drag", "overlap")
        # Convergence: all dict values stable to 1e-5
        diffs = []
        for field in ("recompute_drag", "overlap_drag"):
            for k in drag[field]:
                diffs.append(abs(drag[field][k] - prev[field][k]))
        if max(diffs, default=0) < 1e-5:
            break

    # MAPE on the same samples — proxy for cell quality. NB: this is
    # in-sample; cross-validation belongs to a future expansion.
    errors = []
    for i, s in enumerate(samples):
        ceil = _mfu_ceiling(s["cluster"]["gpu_model"], s["model"]["weight_quant"])
        mfu_pred = max(0.10, min(0.68, ceil - _drag_total(s["strategy"], s["workload"], drag, nvlink_domain)))
        mfu_act = actual_mfu(s)
        if mfu_act > 0:
            errors.append(abs(mfu_pred - mfu_act) / mfu_act)
    mape_pct = (sum(errors) / len(errors) * 100.0) if errors else 0.0

    return {
        "recompute_drag": drag["recompute_drag"],
        "overlap_drag": drag["overlap_drag"],
        # Hold the two scalars at baseline — we don't fit them yet.
        "pp_bubble_per_step": BASELINE_DRAG["pp_bubble_per_step"],
        "ep_cross_per_step": BASELINE_DRAG["ep_cross_per_step"],
        "n_samples": len(samples),
        "mape_pct": round(mape_pct, 2),
    }


def fit_all(
    samples: list[dict[str, Any]],
    min_samples: int = 4,
) -> dict[str, dict[str, Any]]:
    """Group samples by (gpu_model, family) and fit each cell that meets
    the minimum-sample threshold. Returns {"<gpu>/<family>": cell_dict}."""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for s in samples:
        key = (s["cluster"]["gpu_model"], s["model"]["family"])
        groups.setdefault(key, []).append(s)

    cells: dict[str, dict[str, Any]] = {}
    for (gpu_model, family), group in groups.items():
        if len(group) < min_samples:
            print(
                f"[skip] {gpu_model}/{family}: {len(group)} samples "
                f"< min_samples={min_samples}",
                file=sys.stderr,
            )
            continue
        cell = fit_cell(group, gpu_model)
        cell["last_calibrated_at"] = _dt.datetime.now(tz=_dt.timezone.utc).isoformat()
        cells[f"{gpu_model}/{family}"] = cell
    return cells


def build_calibration(cells: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": "1",
        "calibrated_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
        "method": "coordinate_descent_lstsq",
        "cells": cells,
    }


def _patch_registry(registry_url: str, engine_name: str, calibration: dict[str, Any]) -> None:
    url = f"{registry_url.rstrip('/')}/v1/engines/{engine_name}/calibration"
    body = json.dumps({"calibration": calibration}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="PATCH",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f"[ok] PATCH {url} → {r.status}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"PATCH failed: {e.code} {e.read().decode('utf-8')[:200]}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--truth-file", required=True, help="JSON with {samples: [...]}")
    p.add_argument("--registry-url", default="http://engine_registry_svc:8089",
                   help="Engine-registry base URL (used unless --dry-run)")
    p.add_argument("--engine-name", default="surrogate-analytical")
    p.add_argument("--min-samples", type=int, default=4,
                   help="Skip cells with fewer samples (default: 4)")
    p.add_argument("--dry-run", action="store_true",
                   help="Print calibration JSON to stdout, don't PATCH")
    args = p.parse_args(argv)

    with open(args.truth_file) as f:
        data = json.load(f)
    samples = data.get("samples") or []
    if not samples:
        raise SystemExit("truth-file has no samples")

    cells = fit_all(samples, min_samples=args.min_samples)
    if not cells:
        raise SystemExit(
            f"no cells passed --min-samples={args.min_samples}; nothing to write"
        )
    calibration = build_calibration(cells)

    if args.dry_run:
        json.dump(calibration, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return 0
    _patch_registry(args.registry_url, args.engine_name, calibration)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
