# ByteSim Engine Integration Specification

**Version:** 5.0
**Date:** 2026-05-05
**Status:** Draft
**Target Branch:** `main`

---

## 1. Overview

### 1.1 What ByteSim Is

ByteSim is a **GPU cluster performance simulator** — a full simulation stack for LLM training and inference on distributed GPU clusters. It is NOT a simple network calculator or a single collective formula. ByteSim models:

- **Compute**: Charon op-level scheduling (TimelineSimulator), per-op latency via LookupBackend / RooflineBackend / GpuBackend
- **Network**: NCCL collective simulation (ring, double-binary-tree, all-to-all) via ByteSim C++ DES engine (netbula/htsim/ns3), called via pybind11 (`bytesim_py.so`)
- **In-process integration (WS-A)**: `NetworkBackendRuntime` wraps `ByteSimSession` (pybind11) with adaptive flush, shadow mode, and timing-aware co-simulation support

### 1.2 Integration Architecture

There is **one ByteSim system**, exposed through two interfaces:

```
┌─────────────────────────────────────────────────────────────────┐
│                        ByteSim (engine/bytesim/)                  │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  synverse/src/                                             │   │
│  │                                                             │   │
│  │  WS-A Network Backend (network_backend_runtime.py):         │   │
│  │    NetworkBackendRuntime  ← manages ByteSimSession (GT)     │   │
│  │    ByteSimSession         ← pybind11 → bytesim_py.so       │   │
│  │    M4Session              ← ML network fast path (WS-C)     │   │
│  │                                                             │   │
│  │  Simulation scripts (entry points):                         │   │
│  │    run_sim.py            ← HuggingFace LLM (train + infer)  │   │
│  │    run_sim_m12.py        ← M12 DiT training                │   │
│  │    run_sim_mlsys_dit.py  ← DiT inference via xllm/vllm      │   │
│  │  (run_sim_m12.py and run_sim_mlsys_dit.py will be folded   │   │
│  │   into run_sim.py in a future unification pass)             │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**bytesim_svc (this spec)** wraps the simulation scripts (`run_sim.py`, etc.) as **HTTP-accessible services** with JSON request/response framing. It is a thin FastAPI shim — all actual simulation logic lives in the scripts above.

The scripts (`run_sim.py`, `run_sim_m12.py`, `run_sim_mlsys_dit.py`) are the canonical integration surface for ByteSim. There is no separate "WS-A deep integration" vs "bytesim_svc" as two independent systems — the scripts themselves invoke the WS-A `NetworkBackendRuntime` internally.

### 1.3 Simulation Entry Points

| Script | Purpose | Mode | Output |
|--------|---------|------|--------|
| `run_sim.py` | LLM training/inference via HuggingFace config | training / inference | `e2e_output.json` |
| `run_sim_m12.py` | M12-specific DiT training with Charon+Aether | training | `aether_trace_3D_timeline.json` + bytesim CSV |
| `run_sim_mlsys_dit.py` | DiT (Diffusion Transformer) inference via xllm/vllm | inference | `trace_3D_timeline.json` + bytesim CSV |
| `sweep_sim_mlsys_dit.py` | Sweep harness over `run_sim_mlsys_dit.py` | inference | `summary.json` / `summary.csv` |

**Future consolidation:** `run_sim_m12.py` and `run_sim_mlsys_dit.py` will be unified into `run_sim.py` (adding `--backend m12` / `--backend dit` flags). The bytesim_svc API will converge to a single `/v1/predict` endpoint once consolidation is complete. The current separate endpoints (`/v1/predict/training`, `/v1/predict/inference`) will be replaced by a unified `/v1/predict` accepting a `backend` field.

Each script accepts model config, parallelism (TP/PP/DP/EP/SP/CP), batch/sequence parameters, and produces step-level latency metrics.

### 1.4 Positioning vs. Other Engines

| Engine | Domain | Fidelity | SLA p99 | Output KPIs |
|--------|--------|----------|---------|-------------|
| surrogate_svc | training | MFU model | ~1000ms | MFU, step_ms |
| **bytesim_svc** | **training + inference** | **simulation (WS-A network + Charon compute)** | **~300ms** | **step_time_s, compute_time_s, comm_time_s, MFU, frames_per_second_s** |

---

## 2. Architecture

### 2.1 Service Topology

```
engine_registry_svc (:8089)
    ├── GET  /v1/engines              → lists all registered engines
    ├── POST /v1/predict              → coverage-aware routing → bytesim_svc
    └── (engine self-registers on boot via engine_runtime)

bytesim_svc (:8083)
    ├── GET  /healthz                 → smoke test (pytest)
    ├── GET  /v1/capabilities         → CoverageEnvelope for self-attest
    ├── POST /v1/predict/training      → run_sim.py or run_sim_m12.py
    ├── POST /v1/predict/inference    → run_sim_mlsys_dit.py
    └── POST /v1/sweep                → run sweep_sim_mlsys_dit.py

engine/bytesim/ (submodule, docker branch)
    ├── synverse/src/run_sim.py
    ├── synverse/src/run_sim_m12.py
    ├── synverse/src/run_sim_mlsys_dit.py
    ├── synverse/src/sweep_sim_mlsys_dit.py
    ├── synverse/src/test_ws_a.py     → 88 pytest tests
    └── extern/charon/                → Charon submodule
```

### 2.2 Registry Selection

1. **Filter:** active engines only
2. **Filter:** `coverage_envelope ⊇ request` (via `envelope_covers()`)
3. **Filter:** optional `sla_budget_ms`, `fidelity_floor`
4. **Sort:** `(-fidelity_rank, calibration_mape, sla_p99_ms)` — min wins
5. **Return first**; if none → 503 with per-engine miss reasons

---

## 3. Simulation Subprocess Interface

### 3.1 run_sim.py

**Command:**
```bash
python run_sim.py \
  --model_cfg_path /path/to/llama3-70b \
  --gpu_type h100-80gb \
  --tp 8 --pp 4 --dp 16 --gbs 512 --seq_len 8192 \
  --e2e_mode training \
  --e2e_output /tmp/e2e_output.json \
  [--network_backend bytesim_api] \
  [--timing_aware_cosim]
```

**Output (`/tmp/e2e_output.json`):**
```json
{
  "mode": "training",
  "step_time_s": 0.1823,
  "compute_time_s": 0.150,
  "comm_time_s": 0.032,
  "overlap_ratio": 0.825
}
```

For inference mode (`--e2e_mode inference`):
```json
{
  "mode": "inference",
  "ttft_s": 0.045,
  "tpot_s": 0.012,
  "request_latency_s": 0.58
}
```

### 3.2 run_sim_m12.py

**Command:**
```bash
python run_sim_m12.py \
  --model_cfg_path /path/to/m12 \
  --gpu_type h800 \
  --seqlen 8192 --avg_seqlen 1024 \
  --micro_batch_size 2 --micro_batch_num 8 \
  --pp 6 --dp 8 --ep 8 --sp 1 --attn_tp 1 \
  --e2e_mode training \
  --e2e_output end2end_output/
```

**Output:** Writes per-config `.log` files (JSON) into `end2end_output/`.

### 3.3 run_sim_mlsys_dit.py

**Command:**
```bash
python run_sim_mlsys_dit.py \
  --model wan_diffusion_pipeline \
  --backend vllm \
  --model_cfg_path sweep/inference/xllm/model_cfg/wan/Wan2.1-T2V-14B.json \
  --tp 1 --sp 2 --cp 2 \
  --batch_size 1 --num_frames 81 --height 720 --width 1280 \
  --layer_num 40 \
  --bytesim_dp_size 1 \
  --bytesim_measurement bytesim_output/charon/measurement_data.csv \
  --e2e_output end2end_output_dit.log \
  --e2e_mode inference \
  --timesteps 50
```

**Output (`end2end_output_dit.log`):**
```json
{
  "mode": "inference",
  "single_step_compute_time_s": 0.210,
  "single_step_comm_time_s": 0.018,
  "single_step_latency_s": 0.228,
  "compute_time_s": 10.5,
  "comm_time_s": 0.9,
  "e2e_latency_s": 11.4,
  "frames_per_second_s": 4.82,
  "time_per_frame_s": 0.207,
  "request_latency_s": 11.4
}
```

### 3.4 sweep_sim_mlsys_dit.py

**Command:**
```bash
python sweep_sim_mlsys_dit.py \
  --preset quick \
  --backend vllm \
  --model wan_diffusion_pipeline \
  --model_cfg_path sweep/inference/xllm/model_cfg/wan/Wan2.1-T2V-14B.json \
  --out_dir outputs/sweep_mlsys_dit/run_001/ \
  --e2e_mode inference
```

**Output:** `summary.json` + `summary.csv` in `outputs/sweep_mlsys_dit/run_001/`.

---

## 4. bytesim_svc API

### 4.1 Health Check — `GET /healthz`

**Response (200):**
```json
{
  "status": "ok",
  "pytest_test": "test_ws_a.py::TestDataclassDefaults::test_collective_request_fields",
  "test_result": "PASSED",
  "venv_path": "/opt/bytesim_svc/venv"
}
```

### 4.2 Capabilities — `GET /v1/capabilities`

```json
{
  "coverage_envelope": {
    "workload_families": ["transformer-dense", "transformer-moe", "dlrm", "dit", "rnn", "ssm"],
    "parallelism": {
      "TP": [1, 1024], "PP": [1, 128], "EP": [1, 512], "CP": [1, 64],
      "recompute": ["selective", "full", "none"],
      "overlap": ["default", "no_overlap"]
    },
    "hardware": {
      "gpu_models": ["B200", "H100", "H200", "GB300", "MI355X", "B100", "NPU-910"],
      "fabric": ["nvlink", "infiniband", "roce", "cxl", "pcie", "ethernet"],
      "scale_gpus": [2, 4096]
    },
    "quant": ["BF16", "FP8", "INT8", "INT4"],
    "modes": ["training", "inference"]
  },
  "fidelity": "simulation",
  "sla_p99_ms": 300,
  "name": "bytesim",
  "version": "v1.0.0",
  "kpi_outputs": ["step_time_s", "compute_time_s", "comm_time_s", "frames_per_second_s", "MFU"]
}
```

### 4.3 Predict — Training — `POST /v1/predict/training`

**Request:**
```json
{
  "cluster": {
    "gpu_count": 512,
    "gpu_model": "H100"
  },
  "workload": {
    "workload_family": "transformer-dense",
    "model_cfg_path": "/models/llama3-70b",
    "seq_len": 8192,
    "global_batch": 4096,
    "quant": "BF16"
  },
  "strategy": {
    "TP": 8, "PP": 4, "DP": 16, "EP": 1, "CP": 1,
    "recompute": "selective",
    "overlap": "default"
  },
  "run_backend": "hf"   // "hf" | "m12" — selects run_sim.py vs run_sim_m12.py
}
```

**Response (200):**
```json
{
  "step_time_s": 0.1823,
  "compute_time_s": 0.150,
  "comm_time_s": 0.032,
  "overlap_ratio": 0.825,
  "run_backend": "hf",
  "config": {
    "tp": 8, "pp": 4, "dp": 16, "ep": 1, "cp": 1,
    "gbs": 4096, "seq_len": 8192
  },
  "_provenance": {
    "engine": "bytesim",
    "version": "v1.0.0",
    "script": "synverse/src/run_sim.py",
    "fidelity": "simulation",
    "domain": "training",
    "confidence": 0.82,
    "fabric_aware": true,
    "selected_by": "auto",
    "kpi_outputs": ["step_time_s", "compute_time_s", "comm_time_s", "frames_per_second_s", "MFU"]
  }
}
```

### 4.4 Predict — Inference — `POST /v1/predict/inference`

**Request:**
```json
{
  "cluster": {
    "gpu_count": 8,
    "gpu_model": "H100"
  },
  "workload": {
    "workload_family": "dit",
    "model": "wan_diffusion_pipeline",
    "model_cfg_path": "sweep/inference/xllm/model_cfg/wan/Wan2.1-T2V-14B.json",
    "backend": "vllm",
    "num_frames": 81,
    "height": 720,
    "width": 1280,
    "timesteps": 50
  },
  "strategy": {
    "TP": 1, "SP": 2, "CP": 2
  }
}
```

**Response (200):**
```json
{
  "single_step_compute_time_s": 0.210,
  "single_step_comm_time_s": 0.018,
  "single_step_latency_s": 0.228,
  "compute_time_s": 10.5,
  "comm_time_s": 0.9,
  "e2e_latency_s": 11.4,
  "frames_per_second_s": 4.82,
  "time_per_frame_s": 0.207,
  "request_latency_s": 11.4,
  "run_backend": "dit",
  "config": {
    "tp": 1, "sp": 2, "cp": 2,
    "batch_size": 1, "num_frames": 81,
    "height": 720, "width": 1280
  },
  "_provenance": {
    "engine": "bytesim",
    "version": "v1.0.0",
    "script": "synverse/src/run_sim_mlsys_dit.py",
    "fidelity": "simulation",
    "domain": "inference",
    "confidence": 0.82,
    "fabric_aware": true,
    "selected_by": "auto",
    "kpi_outputs": ["step_time_s", "compute_time_s", "comm_time_s", "frames_per_second_s", "MFU"]
  }
}
```

### 4.5 Sweep — `POST /v1/sweep`

Runs `sweep_sim_mlsys_dit.py` with the given cases.

**Request:**
```json
{
  "workload": {
    "model": "wan_diffusion_pipeline",
    "model_cfg_path": "sweep/inference/xllm/model_cfg/wan/Wan2.1-T2V-14B.json",
    "backend": "vllm"
  },
  "cases": [
    { "name": "baseline", "tp": 1, "sp": 1, "cp": 1 },
    { "name": "sp2_cp1", "tp": 1, "sp": 2, "cp": 1 },
    { "name": "sp2_cp2_cfg", "tp": 1, "sp": 2, "cp": 2, "enable_cfg": true }
  ],
  "preset": "quick"
}
```

**Response (202):**
```json
{
  "status": "accepted",
  "sweep_id": "sw_01a2b3c4",
  "out_dir": "/tmp/bytesim_sweep/sw_01a2b3c4",
  "status_url": "/v1/sweep/sw_01a2b3c4/status"
}
```

**`GET /v1/sweep/{sweep_id}/status`:**
```json
{
  "sweep_id": "sw_01a2b3c4",
  "status": "running",
  "completed_cases": 1,
  "total_cases": 3,
  "results": [
    { "name": "baseline", "status": "ok", "e2e_latency_s": 11.4, "run_dir": "..." }
  ]
}
```

**`GET /v1/sweep/{sweep_id}/results`:**
```json
{
  "sweep_id": "sw_01a2b3c4",
  "status": "completed",
  "summary_json": "/tmp/bytesim_sweep/sw_01a2b3c4/summary.json",
  "summary_csv": "/tmp/bytesim_sweep/sw_01a2b3c4/summary.csv",
  "results": [
    {
      "name": "baseline", "label": "tp1_sp1_cp1_bs1_ts50_nf81",
      "tp": 1, "sp": 1, "cp": 1,
      "single_step_compute_time_s": 0.210,
      "single_step_comm_time_s": 0.018,
      "single_step_latency_s": 0.228,
      "compute_time_s": 10.5,
      "comm_time_s": 0.9,
      "e2e_latency_s": 11.4,
      "frames_per_second_s": 4.82,
      "time_per_frame_s": 0.207,
      "request_latency_s": 11.4,
      "status": "ok"
    }
  ]
}
```

### 4.6 Error Responses

```json
{
  "detail": "simulation failed: returncode=1, stderr=ValueError: model not found at /models/llama3-70b"
}
```

```json
{
  "detail": "unsupported workload_family 'unknown'; expected transformer-dense, transformer-moe, dlrm, dit, rnn, ssm"
}
```

---

## 5. Validation Rules

| Field | Constraint | Error |
|-------|------------|-------|
| `gpu_count` | Integer ≥ 2 | `gpu_count must be ≥ 2, got {value}` |
| `workload_family` | One of: `transformer-dense`, `transformer-moe`, `dlrm`, `dit`, `rnn`, `ssm` | `unsupported workload_family '{value}'` |
| `model_cfg_path` | Valid path or accessible HF repo | `model not found` (forwarded from script) |
| `run_backend` | One of: `hf`, `m12`, `dit` | `unsupported run_backend '{value}'` |
| `gpu_model` | One of: `B200`, `H100`, `H200`, `GB300`, `MI355X`, `B100`, `NPU-910` | Applied automatically with warning |

---

## 6. Docker Build

**Base:** `python:3.12-slim` (~180 MB uncompressed, ~80 MB compressed)

**Packages:**
- `pytest==8.3.5`
- `fastapi==0.115.0`
- `pydantic==2.12.5`
- `uvicorn[standard]==0.32.0`
- `transformers` (latest, for HuggingFace config loading)
- `torch` (CPU only, for DiT inference graphs)

**Entrypoint:** `services/bytesim_svc/entrypoint.service.sh`
- Sets `PYTHONPATH="/opt/bytesim/synverse/src:/opt/bytesim/extern/charon:${PYTHONPATH:-}"`
- Activates venv at `/opt/bytesim_svc/venv`
- `exec "$@"` (default: uvicorn on 8083)

**HEALTHCHECK:** `curl -f http://localhost:8083/healthz`

---

## 7. Database Registration

### 7.1 Forward Migration

**Path:** `infra/postgres/027_bytesim_engine.sql`

```sql
INSERT INTO bs_engine (
  name, version,
  fidelity, sla_p99_ms,
  coverage_envelope, kpi_outputs, calibration,
  endpoint, predict_path, status, notes
) VALUES (
  'bytesim',
  'v1.0.0',
  'simulation',
  300,
  '{
    "workload_families": ["transformer-dense", "transformer-moe", "dlrm", "dit", "rnn", "ssm"],
    "parallelism": {
      "TP": [1, 1024], "PP": [1, 128], "EP": [1, 512], "CP": [1, 64],
      "recompute": ["selective", "full", "none"],
      "overlap": ["default", "no_overlap"]
    },
    "hardware": {
      "gpu_models": ["B200", "H100", "H200", "GB300", "MI355X", "B100", "NPU-910"],
      "fabric": ["nvlink", "infiniband", "roce", "cxl", "pcie", "ethernet"],
      "scale_gpus": [2, 4096]
    },
    "quant": ["BF16", "FP8", "INT8", "INT4"],
    "modes": ["training", "inference"]
  }'::jsonb,
  ARRAY['step_time_s', 'compute_time_s', 'comm_time_s', 'frames_per_second_s', 'MFU'],
  '{"mape_pct": {"step_time_s": 15.0}}'::jsonb,
  'http://bytesim_svc:8083',
  '/v1/predict',
  'active',
  'GPU cluster simulator: Charon compute + ByteSim C++ network DES. Supports LLM training/inference via run_sim.py / run_sim_m12.py / run_sim_mlsys_dit.py.'
)
ON CONFLICT (name) DO UPDATE SET
  version = EXCLUDED.version, fidelity = EXCLUDED.fidelity,
  sla_p99_ms = EXCLUDED.sla_p99_ms,
  coverage_envelope = EXCLUDED.coverage_envelope,
  kpi_outputs = EXCLUDED.kpi_outputs, calibration = EXCLUDED.calibration,
  endpoint = 'http://bytesim_svc:8083', status = 'active', notes = EXCLUDED.notes;
```

---

## 8. File Structure

```
services/bytesim_svc/
├── Dockerfile
├── entrypoint.service.sh
├── pyproject.toml
├── requirements.lock
└── app/
    ├── __init__.py
    ├── main.py              # FastAPI (healthz, /v1/capabilities, /v1/predict/*, /v1/sweep)
    ├── runner.py             # Subprocess runner for simulation scripts
    └── parser.py             # Parse JSON/CSV output from simulation scripts

engine/bytesim/ (submodule, docker branch)
├── synverse/src/
│   ├── run_sim.py                    # HuggingFace LLM training/inference
│   ├── run_sim_m12.py                # M12 DiT training
│   ├── run_sim_mlsys_dit.py          # DiT inference
│   ├── sweep_sim_mlsys_dit.py        # Sweep harness
│   ├── e2e_merge.py                  # Output parsing utilities
│   ├── test_ws_a.py                  # 88 pytest tests
│   ├── network_backend_bytesim.py     # WS-A ByteSimSession (pybind11)
│   └── ...
├── extern/charon/                    # Charon op scheduler
└── extern/m4/                        # M4 ML network simulator (WS-C)

infra/postgres/
├── 027_bytesim_engine.sql
└── down/
    ├── README.md
    └── 027_bytesim_engine.sql

shared/engine_contracts/  (on main)
├── envelope.py              # CoverageEnvelope, envelope_covers()
├── predict.py              # EnginePredictRequest/Response (extra="allow")
└── results.py              # PredictResult, ProvenanceV1
```

---

## 9. Relationship to Workstream Ecosystem

bytesim_svc wraps the simulation scripts as **HTTP-accessible wrappers**. The WS-A `NetworkBackendRuntime` and its `ByteSimSession` (pybind11) are **inside the scripts** — they are not a separate integration path. The scripts are the canonical interface.

| Aspect | bytesim_svc (this spec) | WS-A (inside scripts) |
|--------|-------------------------|----------------------|
| Interface | FastAPI HTTP | pybind11 (in-process) |
| What it wraps | Simulation scripts | ByteSim C++ engine |
| Called by | BFF, CLI, other services | TimelineSimulator |
| Lives in | `services/bytesim_svc/` | `synverse/src/network_backend_*.py` |

The workstream ecosystem (WS-A through WS-E) **lives inside the scripts**. bytesim_svc does not re-implement anything — it only adds HTTP framing and request/response translation.

| Workstream | Scope | Status | Lives in |
|------------|-------|--------|----------|
| WS-A Native Network Backend | `NetworkBackendRuntime`, `ByteSimSession`, adaptive flush, shadow mode | Implemented (88 tests pass) | `synverse/src/network_backend_*.py` |
| WS-B Accorde Compute Backend | `AccordeFeatureExtractor`, compute shadow | Branch only | `synverse/src/compute_backend_*.py` |
| WS-C M4 Network Fast Path | `M4Session`, retraining, calibration gate | Branch only | `synverse/src/network_backend_m4.py` |
| WS-D Co-Simulation | `start_time_ns` semantics, `CosimScheduler` | Branch only | `synverse/src/cosim_scheduler.py` |
| WS-E Variance | `variance_model.py`, Monte Carlo, straggler analysis | Branch only | `synverse/src/variance_model.py` |

---

## 10. Test Matrix

### Happy Path

| Case | Endpoint | Expected KPIs |
|------|----------|---------------|
| LLaMA3-70B training, 512 GPUs | `POST /v1/predict/training` | `step_time_s > 0`, `compute_time_s > 0`, `comm_time_s > 0` |
| DiT inference, 8 GPUs | `POST /v1/predict/inference` | `frames_per_second_s > 0`, `request_latency_s > 0` |
| DiT sweep, 3 cases | `POST /v1/sweep` → results | `summary.csv` with 3 rows |

### Error Path

| Case | Expected |
|------|----------|
| Invalid workload_family | 400: `unsupported workload_family 'unknown'` |
| Script failure (bad model path) | 502: `simulation failed: returncode=N` |
| Sweep case parse error | 400: `invalid case: ...` |
| GPU count < 2 | 400: `gpu_count must be ≥ 2, got 1` |

---

## 11. Implementation Checklist

- [ ] Create `services/bytesim_svc/` (Dockerfile, entrypoint, pyproject.toml, requirements.lock)
- [ ] Create `services/bytesim_svc/app/runner.py` — subprocess invocation for all 4 scripts
- [ ] Create `services/bytesim_svc/app/parser.py` — parse JSON/CSV outputs
- [ ] Create `services/bytesim_svc/app/main.py` — FastAPI (all endpoints)
- [ ] Create `infra/postgres/027_bytesim_engine.sql`
- [ ] Add bytesim_svc to `docker-compose.yml`
- [ ] Run `docker compose build bytesim_svc`
- [ ] Verify healthcheck passes
- [ ] Test training predict endpoint
- [ ] Test inference predict endpoint
- [ ] Test sweep endpoint + status + results
- [ ] Test error path cases
