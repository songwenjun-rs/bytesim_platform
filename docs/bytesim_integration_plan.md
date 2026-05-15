# ByteSim Engine Integration — Implementation Plan

**Spec:** `docs/bytesim_integration_spec.md` (v5.0, 2026-05-05)
**Target Branch:** `bytesim-integration`
**Working Dir:** `/Users/bytedance/wk/bytesim_platform`

---

## Phase 0: Environment & Submodule Setup

- [ ] Confirm bytesim submodule is on `docker` branch and synced
  ```bash
  git submodule set-branch --branch docker engine/bytesim
  git submodule update --remote engine/bytesim
  git submodule update --init --recursive engine/bytesim
  ```
- [ ] Verify submodule files exist: `engine/bytesim/synverse/src/run_sim.py`, `run_sim_m12.py`, `run_sim_mlsys_dit.py`, `sweep_sim_mlsys_dit.py`, `test_ws_a.py`
- [ ] Verify `shared/engine_contracts/` is present on `main` (already merged)
- [ ] Verify `infra/postgres/020_engine_registry_v2.sql` (v2 schema) is on `main`

---

## Phase 1: Create Service Skeleton

### 1.1 Package init

Create `services/bytesim_svc/app/__init__.py`:
```python
# bytesim_svc — HTTP wrapper for ByteSim simulation scripts
```

### 1.2 pyproject.toml

Create `services/bytesim_svc/pyproject.toml`:
```toml
[project]
name = "bytesim_svc"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "pytest==8.3.5",
    "fastapi==0.115.0",
    "pydantic==2.12.5",
    "uvicorn[standard]==0.32.0",
]

[project.optional-dependencies]
dev = []
```

### 1.3 requirements.lock

Generate via:
```bash
cd services/bytesim_svc && pip install -e . && pip freeze > requirements.lock
```

### 1.4 Dockerfile

Create `services/bytesim_svc/Dockerfile`:
- Base: `python:3.12-slim`
- Install: pytest, fastapi, pydantic, uvicorn, transformers, torch (CPU-only)
- Copy submodule source: `engine/bytesim/synverse/src` → `/opt/bytesim/synverse/src`
- Copy submodule extern/charon → `/opt/bytesim/extern/charon`
- Copy submodule `network_config.toml` → `/opt/bytesim/`
- Copy submodule `topo_files/` → `/opt/bytesim/topo_files/`
- Copy `shared/engine_contracts/` → install as pip package
- Copy `services/bytesim_svc/app/` → `/app`
- Copy `entrypoint.service.sh` → `/usr/local/bin/`
- Venv at `/opt/bytesim_svc/venv`
- User: `bytesim:1001`
- `EXPOSE 8083`
- `HEALTHCHECK`: `curl -f http://localhost:8083/healthz`
- `ENTRYPOINT ["/usr/local/bin/entrypoint.service.sh"]`
- `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8083"]`

### 1.5 Entrypoint

Create `services/bytesim_svc/entrypoint.service.sh`:
```bash
#!/bin/bash
export PYTHONPATH="/opt/bytesim/synverse/src:/opt/bytesim/extern/charon:/app:${PYTHONPATH:-}"
source /opt/bytesim_svc/venv/bin/activate
exec "$@"
```

---

## Phase 2: Implement runner.py

Create `services/bytesim_svc/app/runner.py`:

**`run_sim` function** — invoke `run_sim.py`:
```python
def run_sim(
    model_cfg_path: str,
    gpu_type: str,
    tp: int, pp: int, dp: int, gbs: int, seq_len: int,
    e2e_mode: str = "training",
    network_backend: str = "legacy_trace",
    timing_aware_cosim: bool = False,
    output_path: str = "/tmp/e2e_output.json",
) -> dict:
    cmd = [
        sys.executable,
        "/opt/bytesim/synverse/src/run_sim.py",
        "--model_cfg_path", model_cfg_path,
        "--gpu_type", gpu_type,
        "--tp", str(tp), "--pp", str(pp), "--dp", str(dp),
        "--gbs", str(gbs), "--seq_len", str(seq_len),
        "--e2e_mode", e2e_mode,
        "--e2e_output", output_path,
    ]
    if network_backend != "legacy_trace":
        cmd += ["--network_backend", network_backend]
    if timing_aware_cosim:
        cmd += ["--timing_aware_cosim"]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise SimulationError(f"returncode={result.returncode}", result.stderr)
    with open(output_path) as f:
        return json.load(f)
```

**`run_sim_m12` function** — invoke `run_sim_m12.py`:
```python
def run_sim_m12(
    model_cfg_path: str,
    gpu_type: str,
    seqlen: int, avg_seqlen: int,
    micro_batch_size: int, micro_batch_num: int,
    pp: int, dp: int, ep: int, sp: int, attn_tp: int,
    e2e_mode: str = "training",
    output_dir: str = "/tmp/end2end_output",
) -> list[dict]:
    # ... subprocess call, parse per-config .log files from output_dir
```

**`run_sim_mlsys_dit` function** — invoke `run_sim_mlsys_dit.py`:
```python
def run_sim_mlsys_dit(
    model: str,
    backend: str,
    model_cfg_path: str,
    tp: int, sp: int, cp: int,
    batch_size: int, num_frames: int, height: int, width: int,
    layer_num: int,
    timesteps: int,
    bytesim_dp_size: int = 1,
    output_path: str = "/tmp/end2end_output_dit.log",
    e2e_mode: str = "inference",
) -> dict:
    # ... subprocess call, return parsed JSON from output_path
```

**`run_sweep` function** — invoke `sweep_sim_mlsys_dit.py`:
```python
def run_sweep(
    model: str,
    backend: str,
    model_cfg_path: str,
    cases: list[SweepCase],
    out_dir: str,
    preset: str = "quick",
) -> str:
    # writes cases.json to out_dir, runs subprocess
    # returns sweep_id (derived from out_dir)
```

**`SimulationError`** exception:
```python
class SimulationError(Exception):
    def __init__(self, returncode: int, stderr: str): ...
```

---

## Phase 3: Implement parser.py

Create `services/bytesim_svc/app/parser.py`:

Functions:
- `parse_e2e_output(path: str) -> dict` — parse `e2e_output.json` from `run_sim.py`
- `parse_m12_outputs(output_dir: str) -> list[dict]` — parse per-config `.log` files from `run_sim_m12.py`
- `parse_dit_output(path: str) -> dict` — parse `end2end_output_dit.log` from `run_sim_mlsys_dit.py`
- `parse_sweep_summary(out_dir: str) -> tuple[list[dict], str, str]` — return `results`, `summary_json_path`, `summary_csv_path`

---

## Phase 4: Implement main.py

Create `services/bytesim_svc/app/main.py`:

**Imports:**
```python
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
import sys, os, uuid, asyncio, threading

from runner import run_sim, run_sim_m12, run_sim_mlsys_dit, run_sweep, SimulationError
from parser import parse_e2e_output, parse_m12_outputs, parse_dit_output, parse_sweep_summary
from engine_contracts import CoverageEnvelope
```

**Pydantic models:**
```python
class ClusterConfig(BaseModel):
    gpu_count: int
    gpu_model: str

class WorkloadTraining(BaseModel):
    workload_family: str
    model_cfg_path: str
    seq_len: int
    global_batch: int
    quant: str = "BF16"

class StrategyTraining(BaseModel):
    TP: int, PP: int, DP: int, EP: int = 1, CP: int = 1
    recompute: str = "selective"
    overlap: str = "default"

class PredictTrainingRequest(BaseModel):
    cluster: ClusterConfig
    workload: WorkloadTraining
    strategy: StrategyTraining
    run_backend: str = "hf"  # "hf" | "m12"

class WorkloadInference(BaseModel):
    workload_family: str
    model: str
    model_cfg_path: str
    backend: str = "vllm"
    num_frames: int
    height: int
    width: int
    timesteps: int

class StrategyInference(BaseModel):
    TP: int = 1, SP: int = 1, CP: int = 1

class PredictInferenceRequest(BaseModel):
    cluster: ClusterConfig
    workload: WorkloadInference
    strategy: StrategyInference

class SweepCaseRequest(BaseModel):
    name: str
    tp: int = 1, sp: int = 1, cp: int = 1
    enable_cfg: bool = False

class SweepRequest(BaseModel):
    workload: WorkloadInference
    cases: list[SweepCaseRequest]
    preset: str = "quick"

class ProvenanceBlock(BaseModel):
    engine: str = "bytesim"
    version: str = "v1.0.0"
    script: str
    fidelity: str = "simulation"
    domain: str
    confidence: float = 0.82
    fabric_aware: bool = True
    selected_by: str = "auto"
    kpi_outputs: list[str]
```

**Endpoints:**

`GET /healthz`:
```python
def healthcheck():
    import subprocess
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "test_ws_a.py::TestDataclassDefaults::test_collective_request_fields", "-v"],
        capture_output=True, text=True, timeout=30,
        cwd="/opt/bytesim/synverse/src"
    )
    if result.returncode == 0:
        return {"status": "ok", "test_result": "PASSED"}
    raise HTTPException(503, detail=f"pytest failed: {result.stdout}")
```

`GET /v1/capabilities`:
```python
def capabilities():
    return {
        "coverage_envelope": CoverageEnvelope(...).model_dump(),
        "fidelity": "simulation",
        "sla_p99_ms": 300,
        "name": "bytesim",
        "version": "v1.0.0",
        "kpi_outputs": ["step_time_s", "compute_time_s", "comm_time_s", "frames_per_second_s", "MFU"]
    }
```

`POST /v1/predict/training`:
- Validate `workload.workload_family` against allowed list
- Validate `gpu_count >= 2`
- Derive world_size = TP * PP * DP * EP * CP
- Map `gpu_model` to `gpu_type` string
- Call `runner.run_sim()` or `runner.run_sim_m12()`
- Attach `_provenance` block
- Return 400 on validation error, 502 on simulation failure

`POST /v1/predict/inference`:
- Validate `workload.workload_family == "dit"` (DiT-only for inference)
- Call `runner.run_sim_mlsys_dit()`
- Attach `_provenance` block
- Return 400 on validation error, 502 on simulation failure

`POST /v1/sweep`:
- Validate cases list
- Generate `sweep_id = uuid.uuid4().hex[:8]`
- Write cases to temp JSON
- Spawn background thread running `runner.run_sweep()`
- Return 202 with `sweep_id`, `out_dir`, `status_url`

`GET /v1/sweep/{sweep_id}/status`:
- Read in-memory sweep state (dict keyed by sweep_id)
- Return current status, completed/total cases, partial results

`GET /v1/sweep/{sweep_id}/results`:
- Read summary.json / summary.csv
- Return full results list

**Global sweep state:**
```python
_sweep_results: dict[str, dict] = {}
_sweep_lock = threading.Lock()
```

**Error responses** must include `returncode` and `stderr` from the subprocess.

---

## Phase 5: Database Migrations

### 5.1 Forward migration

Create `infra/postgres/027_bytesim_engine.sql`:
```sql
INSERT INTO bs_engine (name, version, fidelity, sla_p99_ms, coverage_envelope, kpi_outputs, calibration, endpoint, predict_path, status, notes)
VALUES (
  'bytesim', 'v1.0.0', 'simulation', 300,
  '{"workload_families":["transformer-dense","transformer-moe","dlrm","dit","rnn","ssm"],...}'::jsonb,
  ARRAY['step_time_s','compute_time_s','comm_time_s','frames_per_second_s','MFU'],
  '{"mape_pct":{"step_time_s":15.0}}'::jsonb,
  'http://bytesim_svc:8083', '/v1/predict', 'active',
  'GPU cluster simulator: Charon compute + ByteSim C++ network DES.'
)
ON CONFLICT (name) DO UPDATE SET ...;
```

---

## Phase 6: Docker Compose Integration

Add to `docker-compose.yml`:
```yaml
bytesim_svc:
  restart: unless-stopped
  build:
    context: .
    dockerfile: services/bytesim_svc/Dockerfile
  environment:
    ENGINE_REGISTRY_URL: "http://engine_registry_svc:8089"
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8083/healthz"]
    start_period: 20s
    interval: 10s
    timeout: 5s
    retries: 5
  ports:
    - "8083:8083"
```

---

## Phase 7: Verification

### 7.1 Build
```bash
docker compose build bytesim_svc
```

### 7.2 Smoke test
```bash
docker compose up -d bytesim_svc
curl http://localhost:8083/healthz
docker compose logs bytesim_svc | grep "PASSED"
```

### 7.3 Training predict (happy path)
```bash
# Note: requires model config accessible inside container
curl -X POST http://localhost:8083/v1/predict/training \
  -H 'content-type: application/json' \
  -d '{
    "cluster": {"gpu_count": 64, "gpu_model": "H100"},
    "workload": {"workload_family": "transformer-dense", "model_cfg_path": "...", "seq_len": 8192, "global_batch": 256},
    "strategy": {"TP": 8, "PP": 1, "DP": 8}
  }'
# Expected: 200 + step_time_s, compute_time_s, comm_time_s > 0
```

### 7.4 Inference predict (happy path)
```bash
curl -X POST http://localhost:8083/v1/predict/inference \
  -H 'content-type: application/json' \
  -d '{
    "cluster": {"gpu_count": 8, "gpu_model": "H100"},
    "workload": {"workload_family": "dit", "model": "wan_diffusion_pipeline", ...},
    "strategy": {"TP": 1, "SP": 2, "CP": 2}
  }'
# Expected: 200 + frames_per_second_s, request_latency_s > 0
```

### 7.5 Sweep (happy path)
```bash
curl -X POST http://localhost:8083/v1/sweep \
  -H 'content-type: application/json' \
  -d '{"cases": [{"name": "baseline", "tp": 1, "sp": 1, "cp": 1}]}'
# Expected: 202 + sweep_id
curl http://localhost:8083/v1/sweep/{sweep_id}/results
# Expected: 200 + results list
```

### 7.6 Error path
```bash
# Invalid workload_family → 400
# GPU count < 2 → 400
# Script failure → 502
```

---

## Implementation Order

| Step | Task | Dependency |
|------|------|-----------|
| 1 | Phase 0: submodule + env setup | — |
| 2 | Phase 1: skeleton (Dockerfile, entrypoint, pyproject) | — |
| 3 | Phase 2: runner.py | Phase 1 |
| 4 | Phase 3: parser.py | Phase 1 |
| 5 | Phase 4: main.py | Phase 2, 3 |
| 6 | Phase 5: DB migrations | Phase 4 (api shape stable) |
| 7 | Phase 6: docker-compose | Phase 1 |
| 8 | Phase 7.1: build | Phase 1–6 |
| 9 | Phase 7.2: smoke test | Phase 8 |
| 10 | Phase 7.3–7.6: integration tests | Phase 9 |

---

## Discrepancies to Address Before/After Implementation

| Item | Spec Says | Needs Clarification |
|------|-----------|--------------------|
| `gpu_type` mapping | "Applied automatically with warning" | No explicit gpu_model → gpu_type mapping defined yet |
| `run_backend` selection | "hf" uses run_sim.py, "m12" uses run_sim_m12.py | What selects between them in the registry routing? |
| Model config path inside container | Relative path e.g. `sweep/inference/xllm/model_cfg/wan/Wan2.1-T2V-14B.json` | Must be accessible inside Docker image or mounted |
| Sweep state persistence | In-memory dict + threading | What happens on restart? Should be persisted to disk |
| Multi-arch build | Not specified | Add `docker buildx` cross-compile for amd64 + arm64 |
