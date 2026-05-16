# ByteSim

ByteSim 是 AI 基础设施的仿真平台。给定硬件拓扑、模型、并行策略与工作负载，平台输出训练 / 推理的关键指标（MFU、step 时延、KV cache 占用、TCO 拆解、功耗、置信度），并通过引擎注册表把请求路由到 surrogate（解析公式，亚秒级）或 bytesim（仿真，秒级）。

平台不涉及采购、合同、机房与财务预算；它只回答"在某组配置下系统会跑多快、要多少钱、置信多少"。

## 目录

- [快速开始](#快速开始)
- [架构](#架构)
- [仓库结构（8 submodule + 1 编排仓）](#仓库结构9-submodule--1-编排仓)
- [服务清单](#服务清单)
- [数据层](#数据层)
- [测试与 CI](#测试与-ci)
- [前端](#前端)
- [SDK 与 CLI](#sdk-与-cli)
- [开发规范](#开发规范)

## 快速开始

### 先决条件

- Docker 24+ 与 Docker Compose v2
- Git（含 `git submodule` 支持）
- 可选：Python 3.12+（本地跑测试）、Node 20+（本地跑前端）、Go 1.22+（本地编译 data_svc）

### 克隆 + 初始化 submodule

```bash
git clone --recurse-submodules git@github.com:songwenjun-rs/bytesim_platform.git
cd bytesim_platform
# 已经 clone 但没拉 submodule？
git submodule update --init --recursive
```

9 个 service 仓会被拉到 `frontend/`、`gateway/`、`backend/` 三个目录下，外加 `engine_contracts/` 在仓根。每个都是独立 GitHub 仓，pin 在 `.gitmodules` 里的 commit。

### 一键启动

```bash
make up        # docker-compose up --build -d
make ps        # 健康状态
make logs      # 跟踪日志
```

启动后：

- 前端：<http://localhost:5173>（自动登录 + 自动 seed 默认 spec，开盒即用）
- BFF：<http://localhost:8080/healthz>
- 各微服务：见 [服务清单](#服务清单)

> **bytesim_svc 例外**：它的 ByteSim 引擎资产（`engine/bytesim/synverse,extern/charon,topo_files`）在 git 里是空目录，需要单独从内部源拿到才能 build。详见 [service/bytesim_svc/README.md](service/bytesim_svc/README.md)。其它 8 个服务不依赖 bytesim_svc，能独立工作。

### 停机

```bash
make down       # 保留 volume（pgdata + 用户数据）
make reset      # docker-compose down -v && up，清空 PG
```

## 架构

```
       Web SPA  :5173  (dashboard)
             │
             ▼
   ┌──────  bff  :8080  (bff)  ──────┐
   │  thin proxy + auth + JSON Schema 导出   │
   │                                          │
   ▼                                          ▼
data_svc :8081                    engine_svc :8087
(service/data_svc, Go)            (service/engine_svc, Py)
  │                                │  5 阶段管线 + claim
  │ runs / specs / catalog          │  + 引擎注册/路由（合并自 engine_registry_svc）
  │ artifacts / events / engines    │
  │                                 ├──→ surrogate_svc :8083  (service/surrogate_svc)
  │                                 └──→ bytesim_svc :8083(8086) (service/bytesim_svc)
  │
  │                          tco_svc :8090
  │                          (service/tco_svc, Py)
  │                          │  rule-based TCO breakdown
  ▼                          ▼
Postgres 16 :5432 (托管, schema migrations from service/data_svc/migrations/)
```

### 数据流主线（一次完整 Run）

1. 前端提交 envelope（cluster + model + workload + strategy） + 4 个 spec hash
2. BFF 把 envelope 寻址 snapshot 成 `kind=runspec` 的 spec（asset 路径），把 `runspec_hash` 附给 data_svc 创建 Run（顺序 ID `sim-001` / `inf-001`）
3. engine_svc 原子 claim Run，5 阶段执行：validate → baseline / pinned → scan → top-k → select
4. validate 真做 `TP×PP×EP×CP ≤ gpu_count` 检查；不可行直接 raise，零 predict 浪费
5. engine_preference 存在 → `_run_pinned`（registry 强制路由该引擎）；否则 `_run_baseline + _run_scan` 按 fidelity / MAPE / SLA 自动路由
6. 每条 predict 响应 verbatim 写入 `bs_run_engine_call`；每个阶段转换写入 `bs_run_event`
7. select 阶段：mark is_best、上传 4 个 artifact（Phase 2 后走 HTTP，不再共享卷）、调 tco_svc → `bs_tco_breakdown`
8. 前端 `useRunReport` 每 2 s 拉 `/v1/runs/{id}/report`（data_svc 内部 errgroup 并发组装）

## 仓库结构（8 submodule + 1 编排仓）

```
bytesim_platform/                      ← 编排仓（this repo）
├── docker-compose.yml                 docker compose 编排（context 指向 submodule 目录）
├── .gitmodules                        8 个 submodule 声明（URL → github.com/songwenjun-rs/bytesim-*）
├── Makefile                           make up / e2e
│
├── engine_contracts/                  ⬅ submodule · 跨服务契约源（OpenAPI YAML）
├── frontend/
│   └── web/                           ⬅ submodule · Vite/React SPA
├── gateway/
│   └── bff/                           ⬅ submodule · FastAPI 网关
├── backend/
│   ├── data_svc/                      ⬅ submodule · Go：runs/specs/catalog/artifacts + 33 migrations
│   ├── engine_svc/                    ⬅ submodule · Python：5 阶段管线 + 引擎注册/路由
│   ├── surrogate_svc/                 ⬅ submodule · Python：解析模型引擎
│   ├── bytesim_svc/                   ⬅ submodule · Python：cycle-accurate 引擎包装
│   └── tco_svc/                ⬅ submodule · Python：TCO 计算
│
├── docs/                              架构 / 设计文档
│   ├── DESIGN.md                       主设计文档
│   └── ...
├── tests/                             跨服务集成测试（CI 默认 skip — 见 [测试与 CI](#测试与-ci)）
│   ├── _svc_path.py                    服务名→tier 路径的映射工具
│   ├── conftest.py
│   ├── engine_smoke/                  contract harness 跨多 engine
│   ├── db/                            多服务 PG 集成（用 pgserver 临时 PG，不碰生产）
│   ├── main_modules/                  每个服务的 main.py 启动验证
│   ├── sdk/                           Python SDK 端到端
│   ├── engine_contracts/              schema 完整性 + envelope_covers 逻辑
│   ├── generated/                     codegen 副本，给跨服务测试 import
│   └── tools/                         平台运维脚本
├── sdk/bytesim/                       用户态 Python SDK + CLI
├── scripts/                           e2e.sh / e2e_ci.sh
└── tools/                             平台运维工具
```

> **没有 `services/` / `shared/` / `web/` / `engine/` / `infra/postgres/`** —— 这些目录在 Phase 1/2/3 拆仓过程中已删除，内容分散到 8 个 submodule。

## 服务清单

| Submodule | 端口 | 语言 | 职责 | README |
|---|---:|---|---|---|
| **bff** | 8080 | Python | 网关：JWT + CORS + 透传 + Monaco schema 导出 | [bff](bff/README.md) |
| **data_svc** | 8081 | Go | 数据层：runs / specs / catalog / artifacts + 33 migrations | [service/data_svc](service/data_svc/README.md) |
| **surrogate_svc** | 8083 | Python | 解析公式 surrogate（< 100 ms what-if） | [service/surrogate_svc](service/surrogate_svc/README.md) |
| **bytesim_svc** | 8086 → 8083 | Python | ByteSim 仿真引擎（~300 ms SLA） | [service/bytesim_svc](service/bytesim_svc/README.md) |
| **engine_svc** | 8087 | Python | 5 阶段管线 + 原子 claim + 引擎注册/envelope 路由（合并自 engine_registry_svc） | [service/engine_svc](service/engine_svc/README.md) |
| **tco_svc** | 8090 | Python | rule-based TCO breakdown（侧路） | [service/tco_svc](service/tco_svc/README.md) |
| **web** | 5173 | TS/React | Vite SPA + Playwright | [dashboard](dashboard/README.md) |
| **engine_contracts** | — | YAML | 跨服务数据契约的单一源 | [engine_contracts](engine_contracts/README.md) |

## 数据层

### Postgres（PG 16）

33 个 forward migration，归 [service/data_svc/migrations/](service/data_svc/) 持有：

| 阶段 | 编号 | 主题 |
|---|---|---|
| 基础 | 001-002 | 项目骨架 + seed |
| Domain v1 | 006-017 | plan / multi-project / TCO / engine registry v1 / KV cache / fabric / jsonb merge |
| Engine Registry v2 | 020-021 | engine registry v2 cutover |
| Run lifecycle | 022-023 | sim experiments / run id sequences |
| Catalog | 024-029 | bs_catalog / 3-block / preset seed drop / astra-sim retire |
| GPU SKU | 031-032 | surrogate fields / H20 |
| Data path v2 | 033-034 | bs_run_engine_call / bs_run_event / bs_artifact / 删除老 PATCH 列 |
| 2026 杂项 | 035-037 | runspec kind / pipeline stages / 复合 PK |
| Phase 2 | **038** | `bs_artifact` 加 `content jsonb` 列（artifact 内容入库）|

编号 003 / 004 / 005 / 018 / 019 / 030 留空 = 已下线的 tuner / calibration / mcp / audit / astra-sim 子系统。

### 共享 migration 的工程方式

migrations 归 data_svc 仓所有；其它需要 PG 集成测试的 Python 服务（tco-svc）在自己的 `tests/integration/migrations/` 下 **vendored 一份副本**。data_svc 改 schema 时手动同步——GitHub Actions 默认 `GITHUB_TOKEN` 不能 clone 私有 sibling，submodule 方案被这条限制堵了，这是务实折中。（注：engine-registry 仓在 P3 收敛中已合并入 engine_svc，连带它的 vendored migrations 也已退役。）

### Phase 2：artifact 内容入库

`bs_run_engine_call` 之外，engine_svc 写的 4 个 artifact（result.json / timeline.json / roofline.json / snapshot.json）从前在 `infra/artifacts/<run_id>/` 共享卷里；Phase 2 后内容存进 `bs_artifact.content` JSONB 列，data_svc 通过 `POST /v1/runs/{id}/artifacts/{name}` 接收。共享卷已经从 docker-compose 移除——engine_svc 和 data_svc 可以部署到不同节点。

## 测试与 CI

### 三层测试

| 层 | 在哪 | 谁跑 |
|---|---|---|
| **单元 / mock** | 各 submodule `tests/`（或 Go 的 `internal/*/_test.go`） | 每个 submodule 的 GitHub Actions CI |
| **集成（live PG）** | 各 submodule `tests/integration/`（data_svc 用 `_test.go` build tag） | submodule CI 里的 integration job（postgres:16-alpine service container）|
| **跨服务集成** | 本仓 `tests/`（engine_smoke / db / main_modules / sdk） | CI **默认不跑**，需要本地 setup 多 svc 联动 |

### `PG_DSN` 永远不被测试读取

测试只认 `BYTESIM_TEST_PG_DSN`。两者相等时（手动短路），测试 `t.Fatalf` / `pytest.fail` 拒绝执行。这条规则是 2026-05-14 的事故吃出来的——之前 `Snapshot_AddsNewVersion` 用 PG_DSN 跑过 docker-compose 的 PG，把用户 `hwspec_topo_b1` 覆盖空了。修法：env 命名空间隔离 + 守护检查。

详见 [service/data_svc/README.md](service/data_svc/README.md#测试访问-pg-的安全约定)。

### 覆盖率（2026-05-14 实测）

| 仓 | 单元 | 集成（live PG）后 |
|---|---|---|
| bff | 84% | — |
| surrogate_svc | 87% | — |
| engine_svc | 82% | — |
| tco_svc | 82% | store: 24% → **90%** |
| data_svc | 35% | total 35% → **61%**, store 3.5% → **47.5%** |
| web | 73% lines | — |

P1/P2 收敛后只有 data_svc 真连 PG；tco_svc 还保留 PG 集成测试以验证 vendored migrations 与 data_svc 仓同步。

## 前端

`dashboard/` 是 Vite + React 18 SPA，TanStack Query 管状态，React Flow 画拓扑，Vitest 单测，Playwright e2e。详见 [dashboard/README.md](dashboard/README.md)。

## SDK 与 CLI

`sdk/bytesim/` 是 Python SDK，附带 `bytesim` CLI。本仓直接管理（不是 submodule），与 BFF 一起演进。

```bash
pip install -e sdk/
bytesim config show
bytesim run create --kind train --hwspec hwspec_topo_b1 --model model_moe256e
bytesim run get <run-id>
```

## 开发规范

### 服务级 commit

各 submodule 独立 commit / push 自己仓。改 schema → push data_svc → 在本仓 `git add service/data_svc && git commit && git push` 把 submodule 指针推进。

### 契约改动

1. 本仓里 `cd engine_contracts`
2. 改 `openapi/openapi.yaml`
3. push 到 engine_contracts repo
4. 各消费者仓里跑 `gen-python.sh` / `gen-typescript.sh` 重生 generated/
5. 各消费者仓提 PR 升级
6. 在本仓推进每个 submodule 的指针

### 跨仓改动的 CI gate

`engine_contracts` CI 的 codegen smoke 抓宽接口缺字段；各消费者 CI 抓本服务断裂。跨服务 e2e 当前不在 CI 内——靠手动 `make e2e`。

### 提交约定

- Conventional commits：`feat(<svc>): ...` / `fix(<svc>): ...` / `chore(...)` / `docs(...)`
- PR 需通过对应 submodule 的 CI（各 submodule 一份 `ci.yml`）
- 工程纪律见 [CLAUDE.md](CLAUDE.md)（思考先行、最小改动、外科手术式编辑）

---

历史：本仓在 2026-05 从 monorepo 拆分成 1 编排仓 + 9 个服务仓，分 3 个 Phase 完成：
- **Phase 1**：`shared/engine_contracts` + `shared/engine_runtime` Python 包替换成 OpenAPI YAML + codegen（每个消费者 vendor 生成产物）
- **Phase 2**：artifact 内容从共享卷迁到 PG `bs_artifact.content` JSONB
- **Phase 3**：物理拆出 9 个独立 git 仓，按 `frontend/` `gateway/` `backend/` `engine_contracts/` 四层组织，注册为 submodule

详见 [docs/DESIGN.md](docs/DESIGN.md)。
