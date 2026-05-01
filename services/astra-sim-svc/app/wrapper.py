"""Run the astra-sim analytical binary as a subprocess.

The binary path defaults to /opt/astra-sim/AstraSim_Analytical_Congestion_Unaware
(set by the Dockerfile); examples_root defaults to /opt/astra-sim/examples
(read-only bundled traces). Both can be overridden via env vars to support
running this svc against a developer's local astra-sim checkout.

`predict` is the only public entry point. It owns its own tmp dir, writes
network.yml + system.json there, invokes the binary, and parses stdout.
Failure paths surface as RuntimeError so the FastAPI layer can convert to
a 4xx/5xx with a clear message. Errors are also logged via the module
logger so `docker compose logs astra-sim-svc` shows the full context — the
HTTP body alone gets eaten by curl --fail-with-body in some callers."""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from app.translator import (
    TranslationError,
    build_network_yml,
    build_system_json,
    normalize,
    parse_output,
    workload_path,
)


log = logging.getLogger("astra-sim-svc.wrapper")


DEFAULT_BINARY = "/opt/astra-sim/AstraSim_Analytical_Congestion_Unaware"
DEFAULT_EXAMPLES = "/opt/astra-sim/examples"


# RFC-003 — predict_chakra(): generate a real ET trace for the requested
# (model × strategy), run astra-sim against it, parse out timing.
#
# Cancellation model: this is async + uses asyncio subprocess, so when the
# upstream HTTP client times out / disconnects FastAPI cancels this task and
# CancelledError propagates here — we trap it, SIGTERM the subprocess (5s
# grace), then SIGKILL, then re-raise so the framework still emits a 4xx/5xx.
# No internal timeout: the engine-svc httpx client (180s) and the registry
# forward (ENGINE_PREDICT_TIMEOUT_S) are the single source of truth for
# "max simulation time".
#
# Legacy `predict()` below (microbench) keeps the old sync subprocess.run; it
# is not on the request path and carries its own bounded test workloads.

async def predict_chakra(spec, fabric_cfg: dict[str, Any]) -> dict[str, Any]:
    """Generate a chakra trace for `spec` (a TraceSpec from chakra_writer),
    run astra-sim against it, return parsed metrics + provenance hooks for
    main.py to translate into EnginePredictResponse."""
    from app.chakra_writer import _read_env_cache_root, write_trace_cached

    binary = Path(os.environ.get("ASTRASIM_BIN", DEFAULT_BINARY))
    examples = Path(os.environ.get("ASTRASIM_EXAMPLES", DEFAULT_EXAMPLES))

    if not binary.exists():
        log.error("binary missing at %s", binary)
        raise RuntimeError(
            f"astra-sim binary not found at {binary}; "
            f"override with ASTRASIM_BIN or rebuild the image."
        )

    cache_root = _read_env_cache_root()
    workload_prefix = write_trace_cached(spec, cache_root)
    rank0 = workload_prefix.with_name(workload_prefix.name + ".0.et")
    if not rank0.exists():
        # write_trace_cached should have produced this; if not, the spec has
        # zero ranks or write failed silently. Either way, surface clearly.
        raise RuntimeError(f"chakra writer produced no rank-0 trace at {rank0}")

    remote_mem = examples / "remote_memory" / "analytical" / "no_memory_expansion.json"

    with tempfile.TemporaryDirectory(prefix="astrasim-chakra-") as tmp:
        tmp_path = Path(tmp)
        net_yml = tmp_path / "network.yml"
        sys_json = tmp_path / "system.json"
        # Map the fabric_cfg to one astra-sim dimension; multi-dim mapping is
        # a follow-up once chakra writer emits hierarchical comm groups.
        net_yml.write_text(build_network_yml(
            spec.world_size,
            fabric_cfg.get("topology", "Switch"),
            fabric_cfg.get("bandwidth_gbps", 50.0),
            fabric_cfg.get("latency_ns", 500.0),
        ))
        sys_json.write_text(build_system_json())

        cmd = [
            str(binary),
            f"--workload-configuration={workload_prefix}",
            f"--system-configuration={sys_json}",
            f"--network-configuration={net_yml}",
            f"--remote-memory-configuration={remote_mem}",
        ]

        t0 = time.perf_counter()
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(tmp_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await proc.communicate()
        except asyncio.CancelledError:
            log.warning("astra-sim cancelled after %.1fs; SIGTERM → wait 5s → SIGKILL",
                        time.perf_counter() - t0)
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
            raise

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        stdout = stdout_b.decode(errors="replace")
        stderr = stderr_b.decode(errors="replace")

        if proc.returncode != 0:
            log.error(
                "astra-sim (chakra) exit=%d\nSTDOUT[-2000]:\n%s\nSTDERR[-2000]:\n%s",
                proc.returncode, stdout[-2000:], stderr[-2000:],
            )
            raise RuntimeError(
                f"astra-sim exit {proc.returncode}\nstderr tail: {stderr[-2000:]}"
            )

        # Always log a snippet of the first/last lines on success too — when
        # parse_output fails the only signal we have outside the 502 body is
        # this log line, and CI's per-svc artifact upload captures it.
        log.info(
            "astra-sim (chakra) exit=0 elapsed=%.1fms\nSTDOUT[-2000]:\n%s\nSTDERR[-2000]:\n%s",
            elapsed_ms, stdout[-2000:], stderr[-2000:],
        )

        try:
            metrics = parse_output(stdout + "\n" + stderr)
        except TranslationError as e:
            log.error(
                "astra-sim (chakra) parse_output failed: %s\nSTDOUT[-3000]:\n%s\nSTDERR[-1500]:\n%s",
                e, stdout[-3000:], stderr[-1500:],
            )
            raise RuntimeError(
                f"failed to parse astra-sim output ({e}); stdout tail: {stdout[-2000:]}"
            ) from e

    return {
        **metrics,
        "trace_prefix": str(workload_prefix),
        "world_size": spec.world_size,
        "wrapper_overhead_ms": round(elapsed_ms - metrics["collective_time_ms"], 3),
        # Real workload trace (not microbench snap) — full confidence
        # of the analytical backend's modelling fidelity.
        "confidence": 0.85,
    }


def predict(req: dict[str, Any]) -> dict[str, Any]:
    cfg = normalize(req)

    binary = Path(os.environ.get("ASTRASIM_BIN", DEFAULT_BINARY))
    examples = Path(os.environ.get("ASTRASIM_EXAMPLES", DEFAULT_EXAMPLES))
    timeout_s = float(os.environ.get("ASTRASIM_TIMEOUT_S", DEFAULT_TIMEOUT_S))

    if not binary.exists():
        log.error("binary missing at %s; ls -la %s -> %s",
                  binary, binary.parent,
                  list(binary.parent.iterdir()) if binary.parent.exists() else "[parent missing]")
        raise RuntimeError(
            f"astra-sim binary not found at {binary}; "
            f"override with ASTRASIM_BIN or rebuild the image."
        )

    workload_prefix = workload_path(examples, cfg["collective"], cfg["npus"], cfg["size_mb"])
    # astra-sim opens <prefix>.<rank>.et — verify rank-0 exists so we fail
    # cleanly instead of waiting on a stuck binary.
    rank0 = workload_prefix.with_name(workload_prefix.name + ".0.et")
    if not rank0.exists():
        log.error("workload trace missing at %s", rank0)
        raise RuntimeError(
            f"workload trace missing for preset {cfg['collective']}/"
            f"{cfg['npus']}npus_{cfg['size_mb']}MB at {rank0}"
        )

    remote_mem = examples / "remote_memory" / "analytical" / "no_memory_expansion.json"

    with tempfile.TemporaryDirectory(prefix="astrasim-") as tmp:
        tmp_path = Path(tmp)
        net_yml = tmp_path / "network.yml"
        sys_json = tmp_path / "system.json"
        net_yml.write_text(build_network_yml(
            cfg["npus"], cfg["topology"], cfg["bandwidth_gbps"], cfg["latency_ns"]
        ))
        sys_json.write_text(build_system_json())

        cmd = [
            str(binary),
            f"--workload-configuration={workload_prefix}",
            f"--system-configuration={sys_json}",
            f"--network-configuration={net_yml}",
            f"--remote-memory-configuration={remote_mem}",
        ]

        t0 = time.perf_counter()
        try:
            # Run from inside the tmp dir — the analytical binary creates a
            # `log/` subdir relative to cwd at startup, which would fail
            # against /app (owned by root, runtime UID is 1001) with a
            # std::filesystem permission_denied otherwise.
            r = subprocess.run(
                cmd,
                cwd=str(tmp_path),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"astra-sim timed out after {timeout_s}s") from e

        elapsed_ms = (time.perf_counter() - t0) * 1000.0

        if r.returncode != 0:
            log.error(
                "astra-sim exit=%d cmd=%s\nSTDOUT[-2000]:\n%s\nSTDERR[-2000]:\n%s",
                r.returncode, cmd, r.stdout[-2000:], r.stderr[-2000:],
            )
            raise RuntimeError(
                f"astra-sim exit {r.returncode}\nstderr tail: {r.stderr[-2000:]}\n"
                f"stdout tail: {r.stdout[-2000:]}"
            )

        try:
            metrics = parse_output(r.stdout + "\n" + r.stderr)
        except TranslationError as e:
            log.error(
                "parse_output failed: %s\nSTDOUT:\n%s\nSTDERR:\n%s",
                e, r.stdout[-2000:], r.stderr[-2000:],
            )
            raise RuntimeError(
                f"failed to parse astra-sim output ({e}); stdout tail: {r.stdout[-2000:]}"
            ) from e

    # Confidence: cycle-accurate event-driven analytical model, but we're
    # snapping requested NPUs/size to the nearest preset — penalise that.
    confidence = 0.85 if not cfg["snapped"] else 0.65

    return {
        **metrics,
        "topology":      cfg["topology"],
        "npus":          cfg["npus"],
        "collective":    cfg["collective"],
        "size_mb":       cfg["size_mb"],
        "bandwidth_gbps":cfg["bandwidth_gbps"],
        "latency_ns":    cfg["latency_ns"],
        "snapped":       cfg["snapped"],
        "requested_npus":cfg["requested_npus"],
        "requested_size_mb": cfg["requested_size"],
        "wrapper_overhead_ms": round(elapsed_ms - metrics["collective_time_ms"], 3),
        "confidence":    confidence,
    }
