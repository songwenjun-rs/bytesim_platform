# ByteSim

ByteSim is an AI infrastructure simulation platform. Given a hardware topology, model, parallelism strategy, and workload, the platform outputs key metrics for training and inference workloads (MFU, step latency, KV cache usage, TCO breakdown, power consumption, confidence), routing requests to **surrogate** (analytical, sub-second) or **bytesim** (cycle-accurate, ~seconds) via the engine registry.

The platform is not concerned with procurement, contracts, datacenters, or budgets — it answers "how fast will this configuration run, how much will it cost, and how confident are we."

## Contents

- [Quickstart](#quickstart)
- [Architecture](#architecture)
- [Repository Layout (9 submodules + 1 orchestration repo)](#repository-layout-9-submodules--1-orchestration-repo)
- [Services](#services)
- [Data Layer](#data-layer)
- [Tests & CI](#tests--ci)
- [Frontend](#frontend)
- [SDK & CLI](#sdk--cli)
- [Development Conventions](#development-conventions)

## Quickstart

### Prerequisites

- Docker 24+ with Docker Compose v2
- Git with submodule support
- Optional: Python 3.12+, Node 20+, Go 1.22+ (for local development)

### Clone + init submodules

```bash
git clone --recurse-submodules git@github.com:songwenjun-rs/bytesim_platform.git
cd bytesim_platform
# Already cloned but missing submodules?
git submodule update --init --recursive
```

The 9 service repos check out under `frontend/`, `gateway/`, `backend/`, plus `engine_contracts/` at the repo root. Each is an independent GitHub repo pinned in `.gitmodules`.

### One-shot startup

```bash
make up        # docker-compose up --build -d
make ps        # health
make logs      # tail logs
```

Once up:

- Frontend: <http://localhost:5173> (auto-login + auto-seed default specs — opens out of the box)
- BFF: <http://localhost:8080/healthz>
- Individual services: see [Services](#services)

> **bytesim_svc caveat**: its ByteSim engine assets (`engine/bytesim/synverse,extern/charon,topo_files`) are empty in git and must be sourced internally. See [service/bytesim_svc/README.md](service/bytesim_svc/README.md). The other 8 services don't depend on bytesim_svc and work independently.

### Stop

```bash
make down       # keep the volume (pgdata + user data)
make reset      # docker-compose down -v && up — wipes PG
```

## Architecture

```
       Web SPA  :5173  (dashboard)
             │
             ▼
   ┌──────  bff  :8080  (bff)  ──────┐
   │  thin proxy + auth + JSON Schema export │
   │                                          │
   ▼                                          ▼
data_svc :8081           engine_registry_svc :8089
(service/data_svc, Go)     (service/engine_registry_svc, Py)
  │                          │
  │ runs / specs / catalog    │ envelope match + routing
  │ artifacts / events        │
  │                          ├──→ surrogate_svc :8083  (service/surrogate_svc)
  │                          └──→ bytesim_svc :8083(8086) (service/bytesim_svc)
  │
engine_svc :8087              tco_svc :8090
(service/engine_svc, Py)      (service/tco_svc, Py)
  │                          │
  │ 5-stage pipeline + claim │ rule-based TCO breakdown
  │                          │
  ▼                          ▼
Postgres 16 :5432 (managed; schema migrations from service/data_svc/migrations/)
```

### Main data flow (one complete Run)

1. UI submits an envelope (cluster + model + workload + strategy) + 4 spec hashes
2. BFF snapshots the envelope as a `kind=runspec` spec (asset path), passes `runspec_hash` to data_svc to create the Run (sequential ID `sim-001` / `inf-001`)
3. engine_svc atomically claims the Run; runs the 5-stage pipeline: validate → baseline / pinned → scan → top-k → select
4. validate checks `TP×PP×EP×CP ≤ gpu_count`; infeasible → raise, zero wasted predicts
5. With `engine_preference`, `_run_pinned` forces routing to that engine; otherwise `_run_baseline + _run_scan` routes by fidelity / MAPE / SLA
6. Each predict's request + response is written verbatim to `bs_run_engine_call`; each stage transition writes a `bs_run_event`
7. select stage: mark is_best, upload 4 artifacts (Phase 2 — over HTTP, no shared volume), call tco_svc → `bs_tco_breakdown`
8. UI's `useRunReport` polls `/v1/runs/{id}/report` every 2s (data_svc assembles in-process with errgroup)

## Repository Layout (9 submodules + 1 orchestration repo)

```
bytesim_platform/                      ← orchestration repo (this)
├── docker-compose.yml                 build contexts point at submodule dirs
├── .gitmodules                        9 submodule declarations
├── Makefile                           make up / e2e
│
├── engine_contracts/                  ⬅ submodule · cross-service contract source (OpenAPI YAML)
├── frontend/
│   └── web/                           ⬅ submodule · Vite/React SPA
├── gateway/
│   └── bff/                           ⬅ submodule · FastAPI gateway
├── backend/
│   ├── data_svc/                      ⬅ submodule · Go: runs/specs/catalog/artifacts + 33 migrations
│   ├── engine_svc/                    ⬅ submodule · Python: 5-stage pipeline
│   ├── engine_registry_svc/           ⬅ submodule · Python: engine registry + routing
│   ├── surrogate_svc/                 ⬅ submodule · Python: analytical engine
│   ├── bytesim_svc/                   ⬅ submodule · Python: cycle-accurate engine wrapper
│   └── tco_svc/                ⬅ submodule · Python: TCO computation
│
├── docs/                              architecture + design docs
├── tests/                             cross-service integration (CI default: skip)
├── sdk/bytesim/                       Python SDK + CLI
├── scripts/                           e2e.sh
└── tools/                             platform-level scripts
```

> No `services/` / `shared/` / `web/` / `engine/` / `infra/postgres/` — those dirs were deleted in the Phase 1/2/3 split; contents are now in the 9 submodules.

## Services

| Submodule | Port | Lang | Role | README |
|---|---:|---|---|---|
| **bff** | 8080 | Python | Gateway: JWT + CORS + proxy + Monaco schema export | [bff](bff/README.md) |
| **data_svc** | 8081 | Go | Data layer: runs / specs / catalog / artifacts + 33 migrations | [service/data_svc](service/data_svc/README.md) |
| **surrogate_svc** | 8083 | Python | Analytical surrogate (< 100 ms what-if) | [service/surrogate_svc](service/surrogate_svc/README.md) |
| **bytesim_svc** | 8086 → 8083 | Python | ByteSim simulation engine (~300 ms SLA) | [service/bytesim_svc](service/bytesim_svc/README.md) |
| **engine_svc** | 8087 | Python | 5-stage pipeline + atomic claim | [service/engine_svc](service/engine_svc/README.md) |
| **engine_registry_svc** | 8089 | Python | Engine registry + envelope routing | [service/engine_registry_svc](service/engine_registry_svc/README.md) |
| **tco_svc** | 8090 | Python | Rule-based TCO breakdown (side-path) | [service/tco_svc](service/tco_svc/README.md) |
| **web** | 5173 | TS/React | Vite SPA + Playwright | [dashboard](dashboard/README.md) |
| **engine_contracts** | — | YAML | Single source of cross-service data contracts | [engine_contracts](engine_contracts/README.md) |

## Data Layer

### Postgres 16

33 forward migrations owned by [service/data_svc/migrations/](service/data_svc/):

| Phase | Numbers | Theme |
|---|---|---|
| Bootstrap | 001-002 | Project scaffolding + seed |
| Domain v1 | 006-017 | plan / multi-project / TCO / engine registry v1 / KV cache / fabric / jsonb merge |
| Engine Registry v2 | 020-021 | engine registry v2 cutover |
| Run lifecycle | 022-023 | sim experiments / per-kind sequence IDs |
| Catalog | 024-029 | bs_catalog / 3-block / preset seed drop / astra-sim retire |
| GPU SKUs | 031-032 | surrogate fields / H20 |
| Data-path v2 | 033-034 | bs_run_engine_call / bs_run_event / bs_artifact / dropped PATCH columns |
| Misc 2026 | 035-037 | runspec kind / pipeline stages / composite PK |
| Phase 2 | **038** | `bs_artifact.content jsonb` column (artifact content moves to DB) |

Numbers 003-005 / 018-019 / 030 are gaps from removed subsystems (tuner / calibration / mcp / audit / astra-sim).

### Sharing migrations across services

Migrations live in data_svc. Other Python services that need PG integration tests (engine-registry / tco-svc) keep a **vendored copy** under `tests/integration/migrations/`. Data-svc schema changes require manual sync — GitHub Actions' default `GITHUB_TOKEN` can't clone private siblings, which ruled out the git-submodule approach. This is a pragmatic tradeoff.

### Phase 2: artifact content in DB

In addition to `bs_run_engine_call`, the 4 artifacts engine_svc writes per Run (result.json / timeline.json / roofline.json / snapshot.json) used to live under `infra/artifacts/<run_id>/` on a shared volume. Phase 2 moved the content into the `bs_artifact.content` JSONB column, with engine_svc uploading via `POST /v1/runs/{id}/artifacts/{name}`. The shared volume is gone — engine_svc and data_svc can now deploy on separate nodes.

## Tests & CI

### Three layers

| Layer | Where | Run by |
|---|---|---|
| **Unit / mock** | Each submodule's `tests/` (or Go `internal/*/_test.go`) | Each submodule's GitHub Actions CI |
| **Integration (live PG)** | Each submodule's `tests/integration/` (data_svc via build tag) | submodule CI integration job (postgres:16-alpine service container) |
| **Cross-service** | This repo's `tests/` (engine_smoke / db / main_modules / sdk) | CI **does not run by default** — needs multi-service local setup |

### `PG_DSN` is never read by tests

Tests only read `BYTESIM_TEST_PG_DSN`. If both env vars are set to the same value (a foot-gun shortcut), tests `t.Fatalf` / `pytest.fail` and refuse to run. This rule emerged from a 2026-05-14 incident — `Snapshot_AddsNewVersion` had been run with `PG_DSN` pointed at the docker-compose stack and silently overwrote the user's `hwspec_topo_b1`. Fix: namespace separation + guard.

See [service/data_svc/README.md](service/data_svc/README.md#测试访问-pg-的安全约定) for the design.

### Coverage (2026-05-14 measured)

| Repo | Unit | After integration (live PG) |
|---|---|---|
| bff | 84% | — |
| surrogate_svc | 87% | — |
| engine_svc | 82% | — |
| engine_registry_svc | 68% overall | store: 26% → **88%** |
| tco_svc | 82% overall | store: 24% → **90%** |
| data_svc | 35% | total 35% → **61%**, store 3.5% → **47.5%** |
| web | 73% lines | — |

The 3 services with PG persistence use a service container + 33 migrations to exercise SQL; the rest are well-covered by mocks alone.

## Frontend

`dashboard/` is a Vite + React 18 SPA. TanStack Query for state, React Flow for topology, Vitest for unit tests, Playwright for e2e. See [dashboard/README.md](dashboard/README.md).

## SDK & CLI

`sdk/bytesim/` is the Python SDK with a `bytesim` CLI. Owned by this orchestration repo (not a submodule) — evolves alongside BFF.

```bash
pip install -e sdk/
bytesim config show
bytesim run create --kind train --hwspec hwspec_topo_b1 --model model_moe256e
bytesim run get <run-id>
```

## Development Conventions

### Per-service commits

Each submodule commits / pushes its own repo. After a schema change pushed in data_svc, advance the submodule pointer in this repo:

```bash
git add service/data_svc && git commit && git push
```

### Contract changes

1. `cd engine_contracts`
2. Edit `openapi/openapi.yaml`
3. Push to the engine_contracts repo
4. In each consumer repo, run `gen-python.sh` / `gen-typescript.sh` to regenerate `generated/`
5. Each consumer submits a PR to upgrade
6. Advance the submodule pointers in this orchestration repo

### Cross-repo CI gating

`engine_contracts` CI codegen smoke catches missing core types; each consumer CI catches its own breaks. Cross-service e2e is not currently in CI — run manually via `make e2e`.

### Commit conventions

- Conventional commits: `feat(<svc>): ...` / `fix(<svc>): ...` / `chore(...)` / `docs(...)`
- A PR must pass the affected submodule's CI
- See [CLAUDE.md](CLAUDE.md) for working norms (think-first, minimal change, surgical edits)

---

History: this repo was split from a monorepo into 1 orchestration repo + 9 service repos in 2026-05, across three phases:
- **Phase 1**: `shared/engine_contracts` + `shared/engine_runtime` Python packages replaced with OpenAPI YAML + codegen (each consumer vendors generated code)
- **Phase 2**: artifact content moved from a shared volume to PG `bs_artifact.content` JSONB
- **Phase 3**: 9 independent git repos physically split out, organized into `frontend/` / `gateway/` / `backend/` / `engine_contracts/`, registered as submodules

See [docs/DESIGN.md](docs/DESIGN.md) for the full design.
