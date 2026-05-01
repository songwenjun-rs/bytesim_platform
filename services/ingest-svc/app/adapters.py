"""Built-in import adapters. Each adapter:
  * inputs  : raw bytes (caller has already written to storage_uri + computed sha256)
  * returns : list of "samples" (dicts with measured KPIs) + extracted_period
              + per-sample metadata (gpu_model, model_family, etc.)

Adapters are pure functions for v1 — easy to test, easy to add new ones. Future
versions will move to a registry so external adapters can be plugged in via HTTP.
"""
from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class ExtractedSample:
    """One row of "ground truth" derived from production telemetry. Used by
    calibration-svc to compute MAPE against surrogate predictions."""
    ts: datetime
    gpu_model: str
    model_family: str | None
    measured: dict[str, float]   # {"mfu_pct": 47.3, "step_ms": 540, ...}
    inputs: dict[str, Any] = field(default_factory=dict)


@dataclass
class AdapterResult:
    samples: list[ExtractedSample]
    covers_period_start: datetime
    covers_period_end: datetime
    row_count: int
    hardware_scope: dict[str, list[str]]   # {"gpu_models": ["B200"], "idc": [...]}
    workload_scope: dict[str, list[str]]   # {"model_families": ["MoE"], "modes": [...]}


# ── dcgm-csv@v1 ──────────────────────────────────────────────────────
#
# Expects CSV with columns:
#   timestamp,gpu_model,model_family,sm_util_pct,hbm_used_gb,power_w,step_ms
#
# Real DCGM exports include many more columns; we only consume what's needed
# to compute MAPE for the analytical surrogate (sm_util ≈ MFU proxy, step_ms,
# power_w → kw, hbm_used → memory feasibility).

DCGM_CSV_REQUIRED = ("timestamp", "gpu_model", "sm_util_pct", "step_ms")


def adapt_dcgm_csv(raw: bytes) -> AdapterResult:
    text = raw.decode("utf-8-sig")  # strip BOM if present
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or not all(c in reader.fieldnames for c in DCGM_CSV_REQUIRED):
        missing = [c for c in DCGM_CSV_REQUIRED if c not in (reader.fieldnames or [])]
        raise ValueError(f"dcgm-csv: missing required columns: {missing}")

    samples: list[ExtractedSample] = []
    gpu_models: set[str] = set()
    model_families: set[str] = set()
    period_start: datetime | None = None
    period_end: datetime | None = None
    row_count = 0

    for row in reader:
        row_count += 1
        try:
            ts = _parse_ts(row["timestamp"])
        except Exception as exc:
            raise ValueError(f"dcgm-csv: bad timestamp at row {row_count}: {exc}") from exc
        if period_start is None or ts < period_start:
            period_start = ts
        if period_end is None or ts > period_end:
            period_end = ts

        gpu = row["gpu_model"].strip()
        gpu_models.add(gpu)
        mf = row.get("model_family", "").strip() or None
        if mf:
            model_families.add(mf)

        measured: dict[str, float] = {}
        if row.get("sm_util_pct"):
            measured["mfu_pct"] = float(row["sm_util_pct"])
        if row.get("step_ms"):
            measured["step_ms"] = float(row["step_ms"])
        if row.get("power_w"):
            measured["power_w"] = float(row["power_w"])
        if row.get("hbm_used_gb"):
            measured["hbm_used_gb"] = float(row["hbm_used_gb"])

        samples.append(ExtractedSample(
            ts=ts, gpu_model=gpu, model_family=mf, measured=measured, inputs={},
        ))

    if row_count == 0:
        raise ValueError("dcgm-csv: file has no data rows")

    return AdapterResult(
        samples=samples,
        covers_period_start=period_start,  # type: ignore[arg-type]
        covers_period_end=period_end,      # type: ignore[arg-type]
        row_count=row_count,
        hardware_scope={"gpu_models": sorted(gpu_models)},
        workload_scope={"model_families": sorted(model_families)} if model_families else {},
    )


# ── k8s-event-jsonl@v1 ──────────────────────────────────────────────
#
# Expects newline-delimited JSON; each event has at least:
#   {"ts": iso8601, "kind": "scheduled|started|ended", "workload_class": "...",
#    "duration_ms": 12345, "result": "ok|preempted|failed"}
#
# Used for §4 workload mix arrival fitting; in v1 we just parse + summarize.

def adapt_k8s_event_jsonl(raw: bytes) -> AdapterResult:
    text = raw.decode("utf-8")
    samples: list[ExtractedSample] = []
    classes: set[str] = set()
    period_start: datetime | None = None
    period_end: datetime | None = None
    row_count = 0

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        row_count += 1
        try:
            ev = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"k8s-event-jsonl: invalid JSON at line {row_count}: {exc}") from exc

        if "ts" not in ev:
            raise ValueError(f"k8s-event-jsonl: missing ts at line {row_count}")
        ts = _parse_ts(ev["ts"])
        if period_start is None or ts < period_start:
            period_start = ts
        if period_end is None or ts > period_end:
            period_end = ts

        wc = ev.get("workload_class")
        if wc:
            classes.add(wc)

        # We extract events as samples even though "measured KPI" is more about
        # arrival/duration. calibration treats them as observations of mix shape.
        measured: dict[str, float] = {}
        if "duration_ms" in ev:
            measured["duration_ms"] = float(ev["duration_ms"])

        samples.append(ExtractedSample(
            ts=ts, gpu_model="(n/a)", model_family=None,
            measured=measured, inputs={"event": ev},
        ))

    if row_count == 0:
        raise ValueError("k8s-event-jsonl: file has no events")

    return AdapterResult(
        samples=samples,
        covers_period_start=period_start,  # type: ignore[arg-type]
        covers_period_end=period_end,      # type: ignore[arg-type]
        row_count=row_count,
        hardware_scope={},
        workload_scope={"workload_classes": sorted(classes)} if classes else {},
    )


# ── Registry ─────────────────────────────────────────────────────────

ADAPTERS = {
    "dcgm-csv@v1": adapt_dcgm_csv,
    "k8s-event-jsonl@v1": adapt_k8s_event_jsonl,
}


def _parse_ts(s: str) -> datetime:
    """Accept either ISO 8601 or Unix epoch seconds (string or number-as-string)."""
    s = s.strip()
    if s.replace(".", "", 1).isdigit():
        return datetime.fromtimestamp(float(s), tz=timezone.utc)
    # ISO 8601; allow trailing 'Z'
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)
