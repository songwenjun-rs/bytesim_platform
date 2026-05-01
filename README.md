# ByteSim

ByteSim 是 AI 基础设施的仿真平台。给定硬件拓扑、模型、并行策略与工作负载，平台输出训练 / 推理两类工作负载的关键指标（MFU、step 时延、KV cache 占用、TCO 拆解、功耗、置信度），并通过引擎注册表把请求路由到 surrogate（解析公式，亚秒级）或 astra-sim（cycle-accurate，分钟级）。

平台不涉及采购、合同、机房与财务预算；它只回答"在某组配置下系统会跑多快、要多少钱、置信多少"。

## 目录

- [快速开始](#快速开始)
- [仓库结构](#仓库结构)
- [架构](#架构)
- [服务清单](#服务清单)
- [数据层](#数据层)
- [第三方引擎（astra-sim）](#第三方引擎astra-sim)
- [前端](#前端)
- [SDK 与 CLI](#sdk-与-cli)
- [构建与测试](#构建与测试)
- [观测](#观测)
- [配置](#配置)
- [开发规范](#开发规范)

## 快速开始

### 先决条件

- Docker 24+ 与 Docker Compose v2
- Git（含 `git submodule` 支持）
- 可选：Python 3.12+（本地跑测试）、Node 20+（本地跑前端）、Go 1.23+（本地编译 Go 服务）

### 克隆并初始化 submodule

`engine/astra-sim` 是 git submodule，astra-sim 自身又依赖若干上游 submodule。本仓只初始化 analytical-path 所需的 5 个，跳过 ns-3 与 csg-htsim 这两个未打包的网络后端（体量大且未接入构建）。

```bash
git clone <repo-url> bytesim_platform
cd bytesim_platform

# 1) 拉本仓的 astra-sim submodule
git submodule update --init engine/astra-sim

# 2) 在 astra-sim 内部，仅初始化 analytical-path 子模块
git -C engine/astra-sim submodule update --init -- \
    extern/graph_frontend/chakra \
    extern/network_backend/analytical \
    extern/remote_memory_backend/analytical \
    extern/helper/fmt \
    extern/helper/spdlog
```

> 不要使用 `git submodule update --init --recursive`，那会把 ns-3 和 csg-htsim 也拉下来，二者各数百 MB，且未接入构建链。

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

### 端到端冒烟

```bash
make e2e        # 本地：14 步主线 vertical
make e2e-ci     # CI 包装：build → up → e2e → log dump
make e2e-engines  # 引擎注册表 + astra-sim 路由专项
```

### 停机

```bash
make down       # 保留 volume
make reset      # docker-compose down -v && up，清空 PG / Kafka 数据
```

清空后首次访问会触发前端 `bootstrapDefaultSpecs()`，自动 POST 一份最小 hwspec + model spec 让仿真页面立刻可用。

## 仓库结构

```
bytesim_platform/
├── docker-compose.yml                 # 主编排（9 个 service + Postgres + Redpanda）
├── docker-compose.observability.yml   # 可选 sidecar：Prometheus + Grafana
├── Makefile                           # make up / e2e / obs-up / 业务脚手架命令
├── .github/workflows/                 # unit · build · e2e · playwright
├── infra/
│   ├── postgres/                      # 20 个 forward migration（编号断开为已删除）
│   │   └── down/                      # 配套 down 脚本（部分）
│   ├── prometheus/                    # 抓取配置
│   ├── grafana/                       # provisioning + RED 面板
│   └── artifacts/                     # engine-svc 在运行期写入的产物（bind-mount）
├── engine/
│   └── astra-sim/                     # submodule，astra-sim 上游 + 5 个 analytical 子模块
├── services/                          # 9 个后端服务源码
├── shared/                            # 跨服务共享库（engine_contracts、engine_runtime）
├── sdk/bytesim/                       # Python SDK + CLI
├── web/                               # React SPA（Vite）+ Playwright e2e
├── reports/                           # 端到端验证报告（手工 + 自动）
├── tests/                             # 跨服务集成测试 + 单服务套件
└── scripts/                           # e2e.sh / e2e_ci.sh / e2e_engines.sh + bash helpers
```

## 架构

```
   Web SPA :5173
        │
        ▼
      BFF :8080  ────  视图聚合 / WebSocket 流式 / 自动 token bootstrap / Prometheus
        │
        ├─▶ run-svc            :8081  (Go)  permalink, claim, sequence, DELETE
        ├─▶ asset-svc          :8082  (Go)  spec 版本 + bs_catalog (硬件部件 / 仿真模板)
        ├─▶ surrogate-svc      :8083        analytical fallback engine
        ├─▶ engine-svc         :8087        5 阶段管线 + engine_preference 透传
        ├─▶ engine-registry-svc:8089        引擎插件注册 + 路由 + 心跳
        ├─▶ tco-engine-svc     :8090        rule-based TCO breakdown
        ├─▶ ingest-svc         :8091        profile ingest + data_steward 双签
        └─▶ astra-sim-svc      :8092        astra-sim wrapper（async subprocess）

   postgres :5432   — 业务真源；20 个 migration
   redpanda :19092  — Kafka 兼容总线，主题 bs.events
```

数据流主线（一次完整 Run）：

1. 用户在前端提交 spec 组合（hwspec + model + strategy + workload）
2. BFF 透传至 run-svc 创建 Run（顺序 ID `sim-001` / `inf-001`），写入 PG
3. engine-svc 通过原子 claim 拿到 Run，按 5 阶段执行（validate → baseline / pinned → scan → topk → attribution）
4. 若 Run 携带 `engine_preference`，pipeline 走 `_run_pinned`（只跑用户策略，不做 scan），registry 强制路由该引擎
5. 其它情况走 `_run_baseline + _run_scan`：每条候选交给 registry 按 fidelity / MAPE / SLA 路由（surrogate 兜底）
6. tco-engine-svc 拆 TCO，结果回写 PG，前端通过 useRunFull 轮询（2s）展示进度

## 服务清单

| 服务 | 端口 | 语言 | 职责 |
|------|-----:|------|------|
| **bff** | 8080 | Python | 视图聚合、WebSocket 流、Prometheus、自动 token |
| **run-svc** | 8081 | Go | Run permalink、artifact 元数据、原子 claim、顺序 ID（per-kind sequence）、DELETE |
| **asset-svc** | 8082 | Go | Spec 版本 + Diff + Fork；Snapshot 自创建 bs_spec 行；硬件部件 + 仿真模板 CRUD（`/v1/catalog/items/{kind}`） |
| **surrogate-svc** | 8083 | Python | 解析公式 surrogate（< 100 ms what-if） |
| **engine-svc** | 8087 | Python | 5 阶段仿真管线 + N worker 原子 claim + engine_preference 透传 |
| **engine-registry-svc** | 8089 | Python | 引擎插件注册（self-attest）+ 心跳 + predict 路由（按 fidelity / MAPE / SLA） |
| **tco-engine-svc** | 8090 | Python | rule-based TCO breakdown + 灵敏度分析 |
| **ingest-svc** | 8091 | Python | Profile 多 adapter ingest |
| **astra-sim-svc** | 8092 | Python | astra-sim analytical wrapper + Chakra 写入 + RFC-003 trace cache（async subprocess，不阻塞 heartbeat） |

> 历史上的 `mcp-svc`（Copilot）、`realtime-svc`（Yjs 协同）、`tuner-svc`（自动寻优）、`calibration-svc`（校准中心）、`scenario-svc`（workload mix）已经全部从主分支移除 —— 自动寻优和校准中心待产品节奏成熟后再以新形态接入。

## 数据层

### Postgres（PG 16）

20 个 forward migration，按顺序执行；命名 `NNN_topic.sql`。

| 编号 | 主题 |
|------|------|
| 001 | 项目骨架、`bs_run`、spec 表 |
| 002 | seed 数据（demo 项目 / 用户 / 256× B200 训练集群 + 64× H200 推理集群） |
| 006 | plan slot |
| 007 | 多项目 + RLS-prep |
| 008 | resource ontology |
| 009 | production assets |
| 010 | TCO 模型 |
| 011 | engine registry v1 |
| 012 | workload mix |
| 013 | scenarios |
| 014 | accuracy benchmark |
| 015 | KV cache 表 |
| 016 | engine fabric 字段 |
| 017 | jsonb deep merge function |
| 019 | astra-sim engine 注册种子 |
| 020 | engine registry v2 |
| 021 | engine registry v2 finalize |
| 022 | sim experiments（forkable spec 组合） |
| 023 | run ID per-kind sequence（`sim-001` / `inf-001` 顺序号） |
| 024 | bs_catalog（CPU/GPU/NIC/SSD 部件 + 训练 / 推理模板） |

> 编号 003 / 004 / 005 / 018 留空对应已下线的 tuner / calibration / mcp / audit 子系统。`infra/postgres/down/` 提供部分回滚脚本。012 / 013 / 014 创建的 workload_mix / scenarios / accuracy_benchmark 表当前没有服务读写，作为 inert schema 留下来。

### Kafka（Redpanda）

总线主题 `bs.events`，承载 Run 生命周期相关异步事件。Redpanda 在 docker-compose 内运行，外部端口 19092（Kafka API），18081（schema registry）。

## 第三方引擎（astra-sim）

`engine/astra-sim/` 是上游 [astra-sim/astra-sim](https://github.com/astra-sim/astra-sim) 的 git submodule，pin 到具体 commit。astra-sim-svc 在 docker build 时通过 `COPY engine/astra-sim /src/astra-sim` 把整树打入镜像，再在容器内做 cmake 全量编译（约 10–15 分钟首次构建）。

### 选择性初始化

astra-sim 上游声明了 7 个 submodule，本仓只用 5 个 analytical-path 必需的：

- `extern/graph_frontend/chakra`
- `extern/network_backend/analytical`
- `extern/remote_memory_backend/analytical`
- `extern/helper/fmt`
- `extern/helper/spdlog`

跳过 `extern/network_backend/ns-3` 与 `extern/network_backend/csg-htsim` —— 体量数百 MB，未接入构建。要打开 ns-3 后端需在 astra-sim 内 `submodule update --init` 并改 cmake target。

### 运行时模型

astra-sim wrapper 内部用 `asyncio.create_subprocess_exec` 跑二进制，event loop 不被阻塞，因此心跳协程与 predict 调用并发执行。无 wrapper 内置 timeout —— cancellation 由 HTTP 链路（engine-svc httpx 180s）统管，CancelledError 会触发 `SIGTERM → 5s grace → SIGKILL` 清理 subprocess。

### 升级 submodule

```bash
git -C engine/astra-sim fetch origin main
git -C engine/astra-sim checkout <new-commit>
git add engine/astra-sim
git commit -m "chore(astra-sim): bump submodule to <new-commit>"
```

## 前端

`web/` 是 Vite + React 18 单页应用，TanStack Query 管状态，React Flow 画拓扑，Vitest 跑单测，Playwright 跑 e2e。

### 侧边栏 / 页面

| 分组 | 入口 | 状态 |
|---|---|---|
| 系统概览 | Dashboard | ✅ 工作台首页：4 stat chips + 4 quick action + 集群概览 + 最近仿真 |
| 仿真工作台 | 集群配置 | ✅ datacenter → cluster → rack → server → leaf 全栈编辑器，机房视图 + 网络视图双 tab |
|  | 训练仿真 | ✅ 顶栏（名称 + 模板 actions + 启动）+ 2 列布局（cluster picker / 模型 / KV / 并行 + 引擎检查 / GPU 占用 / 实时 predict） |
|  | 推理仿真 | ✅ 同款布局，加 KV cache section + SLO 目标 |
|  | 仿真报告 | ✅ 列表 + 多选 + 删除 + 对比（≥2 进 `/reports/compare?ids=…` 多份并排，三段式：仿真结果 / 集群成本 / 模型并行）；行点击切选，详情链接进 `/runs/:id` |
| 资源仓库 | 硬件部件 | ✅ CPU / GPU / 网卡 / SSD 四类 + CRUD（`bs_catalog` 持久化），Topology Inspector 服务器编辑器跨页读取 |
|  | 仿真引擎 | ✅ 注册表查看 + 覆盖范围 + 校准 MAPE |

无登录页面：BFF 仍要 token，但 `main.tsx` 启动时调 `/v1/auth/login`（fake-login）拿 token + 自动 seed 缺失的 hwspec / model spec，对用户透明。

### API 客户端（`web/src/api/`）

每个域一个模块（`runs.ts` / `catalogItems.ts` / `engines.ts` / `specs.ts` / …），统一通过 `client.ts` 注入鉴权头与 baseURL。`useRunFull` 在状态非终态时自动 2s 轮询，用于 `ProgressStrip` 与 `SubmittedRunPanel`。

### 共用部件（`web/src/components/sim/insights.tsx`）

训练 / 推理 / 仿真报告共用：`ProgressStrip` · `EngineCheckCard` · `GpuUtilDonut` · `summarizeHwSpec` · `checkEngine` · `ChipRow` · `FieldLabel`。

## SDK 与 CLI

`sdk/bytesim/` 是 Python SDK，附带 `bytesim` CLI（`python -m bytesim` 或 `bytesim` 入口点）。

```bash
pip install -e sdk/             # 开发模式安装
bytesim config show             # 看当前 BFF endpoint / 鉴权状态
bytesim project list
bytesim run create --kind train --hwspec hwspec_topo_b1 --model model_moe256e
bytesim run get <run-id>
bytesim run tail <run-id>       # 跟随 engine.log
bytesim spec diff <id-a> <id-b>
```

子命令分组：`config` · `project` · `run` · `spec` · `snapshot` · `dashboard`。完整列表见 `bytesim --help`。

## 构建与测试

### Make 目标速查

| 目标 | 作用 |
|------|------|
| `make up` / `down` / `reset` | docker compose 启停 / 清盘重启 |
| `make logs` / `ps` | 跟踪日志 / 健康表 |
| `make psql` | 进 Postgres shell |
| `make e2e` | 14 步主线 vertical（本地） |
| `make e2e-ci` | CI 包装：build → up → e2e → log dump |
| `make e2e-engines` | 引擎注册表 + astra-sim 路由专项 |
| `make migrate-down` | 按 down/ 脚本回滚迁移 |
| `make obs-up` / `obs-down` / `obs-status` | 观测 sidecar 启停 |
| `make tidy` / `fmt` | Go mod tidy / fmt（run-svc + asset-svc） |

### 测试矩阵

| 层 | 工具 | 现状（2026-05-01） |
|---|---|---|
| Python 单测 + 集成 | `pytest tests/` | **77%** lines · 575 passed / 3 needs-stack-up · 9 svc + sdk |
| Go run-svc / asset-svc | `go test -cover ./...` | api 27% / 38%；store 10% / 7%（store 测试需 testcontainer） |
| Web 单测 | `cd web && npm test` | **70%** lines · 443 passed / 0 failed / 10 skipped · 48 文件 |
| Web 浏览器 e2e | `cd web && npm run test:e2e` | 5 条 critical path（Playwright + Chromium） |
| 跨服务 e2e | `scripts/e2e.sh` | 已挂 docker compose，覆盖 snapshot → run → calibration 链路 |

### CI（GitHub Actions，4 个 workflow）

- `unit.yml` — Python pytest（`--cov-fail-under=72`）+ Go × 2 + Web vitest（threshold 68/72/56/64 lines/stmt/fn/branch）
- `build.yml` — 10 个服务镜像并行 build smoke
- `e2e.yml` — docker compose 起栈，跑 `scripts/e2e_ci.sh`
- `playwright.yml` — docker compose 起栈 + 装 chromium，跑 `web/e2e/*.spec.ts` 5 条关键路径

每次 PR 默认跑全部 4 个 workflow，覆盖率不可下滑。

## 观测

opt-in，不影响主链路：

```bash
make obs-up       # 启 Prometheus + Grafana sidecar
make obs-status   # 看采集状态
```

- Prometheus：<http://localhost:9090>，按 `infra/prometheus/prometheus.yml` 抓取各服务的 `/metrics`
- Grafana：<http://localhost:3000>，预置 RED 面板（rate / errors / duration），数据源自动 provisioning

各 Python 服务通过 structlog 输出 JSON 日志（`SERVICE_NAME` 字段），go 服务通过 `services/run-svc/internal/obs/obs.go` 输出同结构日志。

## 配置

服务通过环境变量配置；`docker-compose.yml` 已默认填入开发值。生产部署时务必覆盖：

| 变量 | 说明 |
|------|------|
| `BFF_JWT_SECRET` | BFF JWT 签名密钥；缺省时拒绝启动（除非显式置位 `BFF_ALLOW_DEV_SECRET=1`） |
| `BFF_CORS_ORIGINS` | 允许的前端 origin；同上需 `BFF_ALLOW_DEV_CORS=1` 才接受默认 |
| `PG_DSN` | Postgres 连接串 |
| `KAFKA_BOOTSTRAP` | Redpanda / Kafka 地址 |
| `ENGINE_REGISTRY_URL` | engine-svc / 引擎 self-register 时使用 |
| `ENGINE_PREDICT_TIMEOUT_S` | engine-registry 转发到引擎的 httpx 超时（默认 180s） |
| `ENGINE_REGISTRY_STALE_S` | 心跳超时阈值（默认 240s） |
| `ASTRASIM_BIN` | astra-sim 二进制路径 |
| `ASTRASIM_CHAKRA_CACHE` | astra-sim chakra trace 缓存目录（容器内）|

每个服务自身的 `app/main.py` 顶部列出其专属变量。

## 开发规范

### 加新服务

1. 在 `services/<name>-svc/` 起目录，至少含 `Dockerfile`、`app/main.py`、`requirements.lock`（Python）或 `go.mod`（Go）
2. 在 `docker-compose.yml` 加 service block，端口按 8080+ 顺序分配
3. 在 BFF 加 client（`services/bff/app/clients/<name>_svc.py`）与 router（`services/bff/app/api/<name>.py`）
4. 写 `tests/<name>/` 套件并配 `tests/<name>/conftest.py`
5. 在 `.github/workflows/build.yml` 的 matrix 增加镜像

### 加 migration

1. 取下一个空闲编号（避开历史已删除编号），命名 `NNN_topic.sql`
2. 同步在 `infra/postgres/down/` 写回滚（破坏性变更必须）
3. 在 `tests/db/test_pg_stores.py` 或 `tests/db/test_down_migrations.py` 加用例
4. 本地 `make reset` 重新刷库验证

### 加 BFF 路由

1. `services/bff/app/api/<domain>.py` 写 router
2. `services/bff/app/main.py` 注册
3. `web/src/api/<domain>.ts` 加客户端，页面层用 TanStack Query 调用
4. `tests/bff/test_proxy_routes.py` 加 happy / error 用例

### 加前端测试

1. 单测放 `web/src/__tests__/<topic>.test.tsx`，覆盖率门禁会自动监督
2. e2e 放 `web/e2e/<NN>-<topic>.spec.ts`（Playwright），加到 `playwright.yml` 自动跑
3. 千万别把覆盖率 threshold 调低 —— 调高才是正确方向；当前基线见 `vitest.config.ts` 注释

### 加 migration 后清空恢复

`make reset` 后，前端 `main.tsx` 的 `bootstrapDefaultSpecs()` 会自动 POST 缺失的 `hwspec_topo_b1` + `model_moe256e`（asset-svc 的 `Snapshot()` 自创建 spec 行）。如果有自定义默认 spec，把 body 加进 `web/src/main.tsx` 的 `DEFAULT_SPECS` 数组。

### 提交约定

- Conventional commits：`feat(<svc>): ...` / `fix(<svc>): ...` / `chore(...)` / `docs(...)`
- PR 需通过 unit + build + e2e + playwright 四个 workflow
- 本仓的工程纪律见 `CLAUDE.md`（思考先行、最小改动、外科手术式编辑）
