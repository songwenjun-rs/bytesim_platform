"""Pure translator between ByteSim's predict request shape and astra-sim CLI
inputs. Kept side-effect-free so we can unit-test the mapping without the
binary present.

ByteSim payload (network domain) is a subset of the cross-domain shape:

    {
      "cluster": {
        "gpu_count": 8,                       # → npus_count
        "fabric_topology": {
          "topology":      "ring|switch|fully_connected",
          "bandwidth_gbps": 50,               # per-link
          "latency_ns":     500
        }
      },
      "workload": {
        "collective":      "all_reduce|all_gather|reduce_scatter|all_to_all",
        "message_size_mb": 1                  # currently snaps to 1 MB preset
      }
    }

Everything not specified falls back to bench-validated defaults. We only ship
the analytical backend's bundled microbench traces (4/8/16 NPU × 1MB), so
the translator clamps npus_count + message_size to whatever preset exists.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


# Topology name as ByteSim sends it → astra-sim YAML token.
_TOPOLOGY_MAP = {
    "ring":            "Ring",
    "switch":          "Switch",
    "fully_connected": "FullyConnected",
    "fc":              "FullyConnected",
}

# Collective family → preset directory name (matches engine/astra-sim/examples/workload).
_COLLECTIVE_MAP = {
    "all_reduce":     "all_reduce",
    "allreduce":      "all_reduce",
    "all_gather":     "all_gather",
    "allgather":      "all_gather",
    "reduce_scatter": "reduce_scatter",
    "reducescatter":  "reduce_scatter",
    "all_to_all":     "all_to_all",
    "alltoall":       "all_to_all",
}

# Bundled trace inventory per collective. Each entry yields (npus, size_mb).
_PRESETS: dict[str, list[tuple[int, int]]] = {
    "all_reduce":     [(4, 1), (8, 1), (16, 1)],
    "all_gather":     [(8, 1)],
    "reduce_scatter": [(4, 1), (8, 1), (16, 1)],
    "all_to_all":     [(4, 1), (8, 1), (16, 1)],
}


class TranslationError(ValueError):
    """Caller-supplied payload doesn't map to any bundled preset."""


def normalize(req: dict[str, Any]) -> dict[str, Any]:
    """Pull the network-relevant fields out of a possibly-richer payload and
    apply defaults. Snaps npus_count + message_size to the closest bundled
    preset for the chosen collective."""
    cluster = req.get("cluster") or {}
    workload = req.get("workload") or {}
    fabric = cluster.get("fabric_topology") or {}

    raw_collective = str(workload.get("collective", "all_reduce")).lower().strip()
    collective = _COLLECTIVE_MAP.get(raw_collective)
    if collective is None:
        raise TranslationError(
            f"unsupported collective '{raw_collective}'; expected one of "
            f"{sorted(set(_COLLECTIVE_MAP))}"
        )

    raw_topology = str(fabric.get("topology", "ring")).lower().strip()
    topology = _TOPOLOGY_MAP.get(raw_topology)
    if topology is None:
        raise TranslationError(
            f"unsupported topology '{raw_topology}'; expected one of "
            f"{sorted(set(_TOPOLOGY_MAP))}"
        )

    requested_npus = int(cluster.get("gpu_count", 8))
    requested_size = int(workload.get("message_size_mb", 1))

    npus, size = _snap_to_preset(collective, requested_npus, requested_size)

    bandwidth = float(fabric.get("bandwidth_gbps", 50.0))
    latency = float(fabric.get("latency_ns", 500.0))

    return {
        "collective":     collective,
        "topology":       topology,
        "npus":           npus,
        "size_mb":        size,
        "bandwidth_gbps": bandwidth,
        "latency_ns":     latency,
        "snapped":        (npus != requested_npus) or (size != requested_size),
        "requested_npus": requested_npus,
        "requested_size": requested_size,
    }


def _snap_to_preset(collective: str, npus: int, size_mb: int) -> tuple[int, int]:
    """Pick the bundled preset whose npus_count is closest (≤ then ≥) to
    requested. Size is clamped to the only bundled value (1 MB)."""
    presets = _PRESETS[collective]
    smaller = [p for p in presets if p[0] <= npus]
    chosen = max(smaller, key=lambda p: p[0]) if smaller else min(presets, key=lambda p: p[0])
    return chosen


def workload_path(examples_root: Path, collective: str, npus: int, size_mb: int) -> Path:
    """Path to the chakra ET prefix astra-sim expects (without the per-NPU
    suffix). Astra-sim itself appends .{rank}.et when reading."""
    return (examples_root / "workload" / "microbenchmarks" / collective
            / f"{npus}npus_{size_mb}MB" / collective)


def build_network_yml(npus: int, topology: str, bandwidth_gbps: float, latency_ns: float) -> str:
    """Single-dimension analytical network config — astra-sim accepts a list per
    dimension but our presets are 1-D."""
    return (
        f"topology: [ {topology} ]\n"
        f"npus_count: [ {npus} ]\n"
        f"bandwidth: [ {bandwidth_gbps:g} ]  # GB/s\n"
        f"latency: [ {latency_ns:g} ]  # ns\n"
    )


def build_system_json(local_mem_bw_gbps: float = 1600) -> str:
    """Use ring implementations for every collective + LIFO scheduling — this
    matches the bundled Ring_4chunks.json shape, just parametric."""
    import json
    return json.dumps({
        "scheduling-policy":            "LIFO",
        "endpoint-delay":               10,
        "active-chunks-per-dimension":  1,
        "preferred-dataset-splits":     4,
        "all-reduce-implementation":    ["ring"],
        "all-gather-implementation":    ["ring"],
        "reduce-scatter-implementation":["ring"],
        "all-to-all-implementation":    ["ring"],
        "collective-optimization":      "localBWAware",
        "local-mem-bw":                 local_mem_bw_gbps,
        "boost-mode":                   0,
    }, indent=2)


def parse_output(stdout: str) -> dict[str, Any]:
    """Pull per-sys metrics out of astra-sim's spdlog stream. The simulator
    emits one line per metric per sys, e.g.

        [info] sys[0], Wall time: 12345
        [info] sys[0], Comm time: 12000

    We aggregate by metric: max(wall_time) ≈ end-to-end collective time
    (last sys to finish), avg(comm_time) over sys ids."""
    wall_ticks: list[int] = []
    comm_ticks: list[int] = []
    for line in stdout.splitlines():
        line = line.strip()
        if "Wall time:" in line:
            wall_ticks.append(_extract_int_after(line, "Wall time:"))
        elif "Comm time:" in line:
            comm_ticks.append(_extract_int_after(line, "Comm time:"))

    if not wall_ticks:
        raise TranslationError(
            "astra-sim produced no `Wall time:` lines; output truncated?"
        )

    wall_ns = max(wall_ticks)
    comm_ns = max(comm_ticks) if comm_ticks else wall_ns

    return {
        "wall_time_ns":         wall_ns,
        "collective_time_ms":   wall_ns / 1_000_000.0,
        "comm_time_ms":         comm_ns / 1_000_000.0,
        "sys_count":            len(wall_ticks),
    }


def _extract_int_after(line: str, marker: str) -> int:
    tail = line.split(marker, 1)[1].strip()
    # Drop anything past the first whitespace; tail may carry colours / extras.
    token = tail.split()[0].rstrip(",")
    return int(token)
