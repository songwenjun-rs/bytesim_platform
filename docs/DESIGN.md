# ByteSim 平台设计文档

> 版本：2026-05-14 · 适用分支：`main` · 维护：本文档反映 9 仓拆分（Phase 1-3）完成后的主干。
>
> 自上版（2026-05-12）以来的重大变更：
>
> **架构重组 · 1 monorepo → 1 编排仓 + 9 service 仓**
> - **Phase 1**：`shared/engine_contracts` + `shared/engine_runtime` 退役；契约迁到独立仓 [`engine_contracts`](https://github.com/songwenjun-rs/bytesim_engine_contracts)，以 OpenAPI 3.1 YAML 为单一源；各消费者仓在 build 时 codegen 入 `generated/`（mode A：纯契约，无运行时包）。`shared/` 目录从平台仓彻底删除。
> - **Phase 2**：artifact 内容从共享卷迁到 PG —— `bs_artifact` 加 `content jsonb` 列（migration **038**）；engine_svc 通过 `POST /v1/runs/{id}/artifacts/{name}` 推送 JSON body；data_svc 算 sha256 落库实现内容去重。`./infra/artifacts:/artifacts` 共享卷 + `artifacts-init` + `ARTIFACTS_DIR` env 全部移除——**engine_svc 和 data_svc 可以部署到不同节点 / pod**。
> - **Phase 3**：9 个服务物理拆出独立 git 仓，按 3 层布局组织：
>   - `dashboard/` — Vite SPA
>   - `bff/` — FastAPI 网关
>   - `backend/{data_svc,engine_svc,surrogate_svc,bytesim_svc,tco_svc}/` — 5 个后端（P3 收敛中 engine_registry_svc 已合并入 engine_svc）
>   - `engine_contracts/` — 跨服务契约源
>
>   每个仓通过 git submodule 接入平台仓，9 个仓全部在 GitHub `songwenjun-rs/bytesim-*` 私有。`docker-compose.yml` 的 build context 全部改成 `./<tier>/<svc>`。
>
> **测试基础设施**
> - 单服务测试下沉到各 submodule；平台仓 `tests/` 只保留跨服务集成（`engine_smoke/` / `db/` / `main_modules/` / `sdk/`）。
> - 每个 submodule 一份 `.github/workflows/ci.yml`，独立 gate；平台仓 CI 只做 `docker compose config` + submodule 指针一致性校验。
> - **PG 持久化**：P1/P2 收敛后只有 data_svc 直连 PG；tco_svc 还保留 PG 集成测试以验证 vendored migrations。CI 加 `postgres:16-alpine` service container + 全 33 migrations apply + live-PG integration job。覆盖率：store.py 从 ~3-26% 拉到 47-90%。
> - **`PG_DSN` 不再被测试代码读取**：测试只认 `BYTESIM_TEST_PG_DSN`，两者相等时 refuse to run。这条规则是 2026-05-14 事故吃出来的（Snapshot 测试用 PG_DSN 把用户 hwspec_topo_b1 覆盖空了），结构上保证测试不能碰生产 DB。
>
> 上一版（2026-05-12）的关键变更仍在主干上：
> - **服务整合方案 A**：`run_svc` + `asset-svc` 合并为 `data_svc`（单 Go binary on :8081）
> - **data path v2 (phase 1-8)** 完成：`bs_run_engine_call` / `bs_run_event` / `bs_artifact` 取代 PATCH 风格的 `bs_run.kpis`
> - **P1.1 α**：BFF 自动 snapshot runspec
> - **P1.2 / P1.3**：TCO 走 `bs_tco_breakdown` 不再伪装 engine_call
> - **P1.4 / P1.5**：validate 真做约束检查；阶段命名修正
> - **P2.1**：engine.log 改读 `bs_run_event(kind=log)`
> - **P2.3**：Kafka / Redpanda 完全退役
> - **P3.1**：`/v1/runs/{id}/report` 在 data_svc 内部 errgroup 并发；BFF 退化为 thin proxy
> - **Migration 037**：`bs_spec_version` PK 改为复合 `(hash, spec_id)`

---

## 0. 文档目的与读者

本文档面向需要快速建立对 ByteSim 平台整体认知的工程师与技术决策者，覆盖：

- **总体定位** —— 平台解决的问题与不解决的问题
- **架构** —— 服务拓扑、数据流、控制流
- **服务详解** —— 每个微服务的职责、接口、关键算法
- **数据层** —— Postgres schema（含 bs_run_event 生命周期表）、Artifact 存储
- **共享契约** —— `engine_contracts` / `engine_runtime` 两个 SDK 化的内核
- **前端与 SDK** —— SPA 结构、路由、状态、CLI 命令分组
- **基础设施与 CI** —— Docker Compose、Migration、E2E、可观测、流水线
- **关键设计决策** —— "为什么这么做"的 10 条主线

阅读建议：先看 §1 与 §2 建立全景；再按照感兴趣的服务跳到 §3；如要落地新功能，重点是 §6 的契约与 §10 的开发规范。

---

## 1. 平台定位

ByteSim 是 **AI 基础设施仿真平台**。给定硬件拓扑、模型、并行策略与工作负载，平台输出训练 / 推理两类工作负载的关键指标：

- **MFU**（Model FLOPs Utilization 百分比）
- **Step 时延**（ms / 优化步）
- **TTFT / TPOT**（推理首 token / 后续 token 延迟）
- **KV cache 占用与命中率**
- **TCO 拆解**（CapEx 摊销 + 功耗 + 冷却 + 网络 + 存储 + 失败惩罚）
- **峰值功率**与 **置信度**

平台通过 **引擎注册表** 把 `predict` 请求路由到 surrogate（解析公式，亚秒级）或 bytesim（仿真，秒级），实现"快速 what-if + 精细复核"的双轨工作流。

**不在范围内**：采购、合同、机房选址、财务预算。平台只回答"在某组配置下系统会跑多快、要多少钱、置信多少"。

---

## 2. 架构总览

### 2.1 服务拓扑

```
                                ┌──────────────────────┐
                                │   Web SPA :5173      │
                                │  (Vite + React 18)   │
                                └──────────┬───────────┘
                                           │ HTTPS / WebSocket
                                           ▼
                                ┌──────────────────────┐
                                │     BFF :8080        │
                                │  thin proxy + auth   │
                                │  自动 runspec snapshot│
                                │  Prometheus / Trace  │
                                └─┬───┬───┬───┬───┬────┘
        ┌────────┬──────────────┘   │   │   │   │
        ▼        ▼                  ▼   ▼   ▼   ▼
 ┌────────────┐ ┌──────────┐ ┌────────┐ ┌──────────────────┐ ┌─────────┐ ┌─────────────┐
 │ data_svc   │ │engine_svc (含registry)│ │tco-svc │ │surrogate│ │bytesim_svc  │
 │ :8081 (Go) │ │       :8087           │ │ :8090  │ │ :8083   │ │   :8083     │
 │ runs +     │ │ (Python) │ │(Python)│ │     (Python)     │ │(Python) │ │  (Python)   │
 │ specs +    │ │          │ │        │ │                  │ │         │ │             │
 │ catalog    │ │          │ │        │ │                  │ │         │ │             │
 └────┬───────┘ └────┬─────┘ └────┬───┘ └────────┬─────────┘ └────┬────┘ └────┬────────┘
      │              │            │              │  predict 路由   │           │
      │              └────────────┼──────────────┴────────────────┴───────────┘
      │                           │
      └───────────────────────────┴────────────┐
                                                ▼
                                   ┌────────────────────────┐
                                   │   Postgres :5432       │  (业务真源 · 33 个 migration · 归 service/data_svc/ 仓持有)
                                   ├────────────────────────┤
                                   │  Run 生命周期事件存于 bs_run_event 表，无独立消息总线 — P2.3
                                   │  Artifact 内容存于 bs_artifact.content JSONB — Phase 2
                                   └────────────────────────┘
```

> **已下线**：Tuner / Calibration / MCP / Realtime / Ingest / Scenario 等子系统已完全从主干移除。Ingest 相关的 `bs_snapshot*` 表在 migration 025/026 物理删除。

### 2.2 数据流主线（一次完整 Run）

```
1. 用户在前端提交 envelope (cluster + model + workload + strategy) + 4 个 spec hash
2. BFF.POST /v1/runs：
   a. 把 envelope 序列化为 runspec body，sha1 计算 hash
   b. 调 data_svc.Snapshot("runspec", "runspec_<sha8>", body)
      (内容寻址：相同 envelope → 相同 spec_id → 同一行 dedup)
   c. 拿到 runspec_hash，附加到 data_svc create body
3. BFF → data_svc.POST /v1/runs：
   事务里写 bs_run(status=queued, inputs_hash=runspec_hash, params=...)
        + bs_run_uses_spec ×{hwspec, model, strategy?, workload?, runspec}
        + bs_lineage_edge（如果有 parent）
4. BFF "best-effort kick" → engine_svc.POST /v1/engine/kick/{run_id}
   （worker 2s 轮询也会接住，kick 只是降首 run 延迟）
5. engine_svc worker 执行原子 claim：UPDATE ... FOR UPDATE SKIP LOCKED → status=running
6. Pipeline 5 阶段执行（命名 P1.4 整理后）：
   ├─ validate    (0–10%)   TP×PP×EP×CP ≤ gpu_count；不可行直接 raise → run failed
   ├─ baseline OR pinned (10–75%)
   │      • 普通：跑参考策略 TP4·PP4·EP8·1F1B 作为基线 (stage='baseline')
   │      • engine_preference 存在：跳过 scan，跑用户钉死的策略 (stage='pinned')
   ├─ scan        (25–75%)  顺序 5 条候选 → registry surface（engine_svc 自身）→ predict；中途取消可 break
   ├─ top-k       (75–90%)  按 MFU 排前三，剔除 MFU=0 的不可行解
   └─ select      (90–100%) 标记 is_best、写 4 个 synthetic artifact、调 tco
7. 每个 predict 响应 verbatim INSERT 到 bs_run_engine_call.response_jsonb（不 PATCH bs_run）
8. 每个 stage 转换 INSERT bs_run_event(kind=stage_start/stage_end/log/status_change)
9. select 阶段：
   a. UPDATE bs_run_engine_call SET is_best=true WHERE id=<winner>
   b. write_result/timeline/roofline/snapshot.json → POST /v1/runs/{id}/artifacts/{name}
      → data_svc 写 bs_artifact.content JSONB + bs_run_artifact 链接（Phase 2，
      已退役共享卷 / ARTIFACTS_DIR / file-on-disk）
   c. POST tco_svc /v1/tco/compute (persist=true) → bs_tco_breakdown
10. 终态 PATCH bs_run SET status='done', progress_pct=100, finished_at=now()
11. 前端 useRunReport 2s 轮询 /v1/runs/{id}/report 拿统一 payload
    (data_svc 内部用 errgroup 并发取 run/specs/lineage/best_calls/artifacts/tco)
```

> 与 P1.1 α 之前的差异：(2a/2b) 是新的 runspec 自动快照层，(7) 的 verbatim INSERT 替代了
> 老的 "engine_svc PATCH bs_run.kpis" 路径，(9c) 不再 forge `bs_run_engine_call(tco-analytical)` 行。

### 2.3 控制流：原子 claim + 取消 + 校验失败

- **原子 claim**：每个 engine_svc worker 协程定期 (默认 2s) 调用 `POST /v1/runs/claim`。data_svc 用 `FOR UPDATE SKIP LOCKED` 保证多副本安全；新创建的 Run 还能被 BFF "kick" 立即唤醒。
- **取消**（P2.3 之后）：用户取消 → BFF → data_svc 翻状态为 `cancelled` → engine_svc Pipeline 在每个阶段边界（含 scan 的每个 candidate 之间）`GET /v1/runs/{id}` 检查 `status` → 发现 cancelled 即在下一个安全点优雅退出。无 Kafka，无独立 watcher 协程，无 in-memory asyncio.Event。Cancel 延迟上限 = 最长 stage 时长（~0.6s）。
- **校验失败**（P1.4 之后）：validate 阶段从 0.6s 假睡眠改为真校验。当 runspec.body.strategy 已知时，pipeline 计算 `TP×PP×EP×CP` 与 `cluster.gpu_count` 的关系；超出立即 `raise ValueError(msg)` → pipeline 异常分支 PATCH `status='failed'` + emit `status_change(running→failed, error=...)` 事件。零 predict 浪费。Scan 模式（无 fixed strategy）下 validate 是 no-op，候选自身的 envelope 检查由 surrogate / registry 在 predict 时做。

---

## 3. 服务详解

### 3.1 BFF（FastAPI · :8080）

#### 职责

- 鉴权（手写 HS256 JWT，无 PyJWT 依赖）
- 自动 token bootstrap（前端 `main.tsx` 启动调 `/v1/auth/login` 拿 token）
- runspec 自动快照（P1.1 α）：POST /v1/runs 时把 envelope 转 spec body、调 data_svc.Snapshot、附 runspec_hash 给 data_svc
- 透传代理 + 错误归一（502 / 404 映射）
- WebSocket 流式日志透传
- Prometheus 指标 + 分布式 trace

> 旧版 "视图聚合" 已退役 —— P3.1 之后 `/v1/runs/{id}/report` 的并发 fan-out 在 data_svc 内部完成，BFF 只是 thin proxy。

#### 关键路由

| Method | Path | 说明 |
|--------|------|------|
| POST | `/v1/auth/login` | 假登录，产 JWT（`sub`、`projects`、`role`） |
| GET  | `/v1/auth/me` | 当前 actor 上下文 |
| POST | `/v1/runs` | runspec 自动快照 + 透传到 data_svc + best-effort kick engine_svc |
| GET  | `/v1/runs/{id}/report` | thin proxy → data_svc `/report` 统一 payload（P3.1） |
| POST | `/v1/runs/{id}/cancel` | 翻状态；engine_svc 下次轮询 status 时自行退出 |
| DELETE | `/v1/runs/{id}` | 删 run + cascade 删 engine_call / event / artifact_ref / tco_breakdown |
| GET / POST | `/v1/specs/{kind}/{id}/...` | 透传 data_svc 的 spec 路由，含 snapshot / diff / fork |
| GET / POST / PUT / DELETE | `/v1/catalog/items/{kind}` | 硬件部件（cpu/gpu/nic/ssd）+ 仿真模板（train_preset/infer_preset） |
| POST | `/v1/engines/predict` | 透传 PredictRequestEnvelope 到 engine_svc 的 registry surface（合并自 engine_registry_svc）|
| WS   | `/v1/streams/run/{id}/log` | 代理 data_svc 的同名 WS，源是 `bs_run_event(kind=log)` 而非 engine.log 文件 |

#### 鉴权与中间件

- `BFF_JWT_SECRET` 缺省时**拒绝启动**，除非显式 `BFF_ALLOW_DEV_SECRET=1`。
- 中间件顺序（从外到内）：CORS → Prometheus → TraceId → **Auth**。Auth 在路由前拦截 401/403；TraceId/Prometheus 在 Auth 外面，确保鉴权失败的请求也有 trace 与指标。
- `X-Project-ID` 头或 query 决定 actor 的活跃项目；不在 JWT `projects` 列表里返回 403。
- 公开路径白名单：`/healthz`, `/metrics`, `/v1/auth/login`, `/v1/auth/users`, WebSocket 升级。

> P2.3 之前 BFF 还托管一个 Kafka 桥（订阅 bs.events fan-out 给 WebSocket，并在 cancel 时 publish run.cancelled）。Kafka 已退役 —— 取消信号靠 engine_svc 轮询 bs_run.status；前端实时数据走 data_svc 的 bs_run_event WebSocket。

### 3.2 data_svc（Go stdlib net/http · :8081）

> **整合背景**：原 `run_svc` 与 `asset-svc` 是两个独立 Go 服务，都连同一个 PG、都用 stdlib net/http、共 ~3700 行 Go。拆开纯属"run 域 vs spec 域"概念区分，没有真正架构理由 —— 共享一个 PG pool / 一份镜像 / 一份 health check 更经济。方案 A 把它们合成一个 binary 名为 `data_svc`，单一端口 :8081，路由空间分别为 `/v1/runs/...`（含 data path v2 的 engine_calls / events / artifact_refs）、`/v1/specs/...`、`/v1/catalog/...`，互不冲突。



#### 职责

- Run 生命周期 CRUD（permalink 风格，sim-001 / inf-001 顺序号）
- 原子 claim（worker 协程的入口）
- Spec stale 标记（latest_hash 与 Run 引用版本是否一致）
- Lineage 图查询（parents / children / study bridges）
- **Data path v2 写入端**：`bs_run_engine_call` / `bs_run_event` / `bs_artifact + bs_run_artifact` 的 CRUD（engine_svc 写、report-svc 读）
- **Report 聚合端（P3.1）**：单端点 `/v1/runs/{id}/report`，内部 errgroup 并发 6 路 SQL
- Artifact 文件流（filesystem，bind-mount 到 `infra/artifacts/`）
- WebSocket 日志播放（源是 `bs_run_event`，P2.1 之后不再读 engine.log 文件）

#### 关键端点

| Method | Path | 说明 |
|--------|------|------|
| POST | `/v1/runs` | 事务：插 `bs_run` + `bs_run_uses_spec`（含 runspec_hash 若传） + `bs_lineage_edge` |
| GET  | `/v1/runs/{id}` | 单 Run，含 LATERAL JOIN 出的 headline kpis / confidence / engine（is_best 行） |
| GET  | `/v1/runs/{id}/report` | **P3.1** 统一 payload：run + specs + lineage + predict + tco + artifacts |
| POST | `/v1/runs/claim` | `UPDATE ... FOR UPDATE SKIP LOCKED` 取下一条 queued |
| PATCH | `/v1/runs/{id}` | 只动 lifecycle 字段：status / progress_pct / started_at / finished_at（phase 8 之后 kpis/artifacts/boundaries 列已删） |
| GET | `/v1/runs/{id}/specs` | 返回 hwspec/model/strategy/workload/runspec + stale 标记 |
| GET | `/v1/runs/{id}/lineage` | parent / children / study 桥接 |
| GET | `/v1/runs-stale` | 仪表盘列表：specs 已更新但 Run 未重跑 |
| **Data path v2** | | |
| POST/GET | `/v1/runs/{id}/engine_calls` | engine_svc INSERT verbatim 行；list 支持 is_best/engine_name/stage 过滤 |
| POST | `/v1/runs/{id}/engine_calls/{cid}/mark_best` | select 阶段标记 winner |
| POST/GET | `/v1/runs/{id}/events` | append-only 事件流；`since_id` 支持 follow |
| POST/GET | `/v1/runs/{id}/artifact_refs` | 内容寻址 artifact 注册 + 列表 |
| WS  | `/v1/streams/run/{id}/log` | 轮询 `bs_run_event(kind='log')`；解析 `[HH:MM:SS] SOURCE msg` 为 `LogEvent`；run 终态后排空再 EOF |

#### 关键 SQL：原子 claim

```sql
WITH picked AS (
  SELECT id FROM bs_run
  WHERE project_id = $1 AND status = 'queued'
  ORDER BY COALESCE(started_at, created_at)
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE bs_run
   SET status = 'running',
       started_at = COALESCE(started_at, now())
 WHERE id IN (SELECT id FROM picked)
RETURNING id;
```

每个 engine_svc worker 协程独立调用，永不互相阻塞，永不重复消费。

#### 顺序 ID

每个 Run kind（train/infer/batch/agent/tco）有独立 Postgres sequence；Run ID 形如 `sim-001` / `inf-001` / `bat-001` / `agt-001` / `tco-001`，对终端用户友好。Migration 023 引入。

### 3.3 data_svc 的 spec / catalog 端（formerly asset-svc）

#### 职责

- Spec 版本管理（`bs_spec` 元数据 + `bs_spec_version` 不可变版本）
- 版本 Diff（深度 JSON 路径对比）
- Fork（克隆到新 `spec_id`，独立版本树）
- 硬件部件 + 仿真模板 CRUD（`bs_catalog`，CPU/GPU/NIC/SSD/train_preset/infer_preset）

#### 不可变版本 + 复合 PK（migration 037）

- 每次 `Snapshot()` 先 SHA1 计算 body 哈希、`FOR UPDATE` 锁 `bs_spec`、若客户端没传 `parent_hash` 就用 `latest_hash`、插入 `bs_spec_version`、最后把 `bs_spec.latest_hash` 指针指向新版本。
- **复合 PK**（migration 037）：`bs_spec_version` 的 PK 是 `(hash, spec_id)`。同一份 body 内容（同 hash）可以同时属于多个 spec_id（fork-without-mods、跨项目共享 template 等场景）。pre-037 的 PK 只在 `hash` 上，会因唯一性违反返回 500；现在每个 spec 拥有自己的版本链。
- 配套：`bs_run_uses_spec.spec_hash` 的外键已删（hash 不再全局唯一）；app-layer 在 INSERT 时只用已解析存在的 hash，cascade-delete 通过 `bs_run` 完成 orphan 清理。
- **自创建逻辑**（关键）：用户在前端"保存"时若 spec 不存在，data_svc 会按 ID 前缀（`hwspec_*` / `model_*` / `strategy_*` / `workload_*` / **`runspec_*`**）自动 mint 一行 `bs_spec`，并兜底创建 `bs_project` `p_default`。这让 `make reset` 后前端 `bootstrapDefaultSpecs()` + BFF 的 runspec 自动快照都不需要管理员介入。

#### Diff 算法

递归遍历两版本 JSON，按路径输出 `{path, op: added|removed|changed, from, to}`，对象按 key 字典序排序保证稳定性，数组与标量按值对比。前端用于版本面板的高亮。`GetVersion(hash, spec_id)` 在 037 之后强制带 spec_id 形参，diff 端点用 URL 路径的 `{id}` 作为 scope。

### 3.4 engine_svc（FastAPI · :8087）

#### 职责

- 仿真 Pipeline 编排（5 阶段）
- N 个 worker 协程并发拉 queued
- engine_preference 透传（pin 引擎与策略）
- 取消感知（每阶段轮询 bs_run.status；P2.3 之后无 Kafka）
- Artifact 写盘（`/artifacts/{run_id}/`）
- 调用 tco_svc 拆 TCO（best-effort）

#### 5 阶段 Pipeline（P1.4 / P1.5 之后）

| Stage | Progress | 时长 | 内容 |
|-------|---------:|------|------|
| validate | 0–10% | <100ms | 真校验：`TP×PP×EP×CP ≤ cluster.gpu_count`；不可行则 raise → run failed，零 predict |
| baseline | 10–25% | ≈0.4s | 参考策略 TP4·PP4·EP8·1F1B 单次 predict，stage='baseline' |
| pinned | 10–75% | ≈0.4s | engine_preference 存在时替代 baseline+scan，stage='pinned'（migration 036 入 CHECK） |
| scan | 25–75% | 5×0.25s 顺序 | 5 条候选 → registry → predict；候选间检查 cancel 可早停 |
| top-k | 75–90% | ≈0.4s | 按 MFU 取 Top-3，剔除 MFU=0 / not feasible |
| select | 90–100% | ≈0.5s | mark is_best · 写 4 个 artifact · best-effort 调 tco-svc（P1.4 rename，旧名 attribution） |

> 前端 `EnginePhases` 组件维护一个 legacy alias `attribution → select`，保证 pre-P1.4 老 run 的 log 仍能驱动 stepper。

**默认扫描候选**（tuner 参考 Top-5）：

```python
[
  {"TP": 4, "PP": 8, "EP": 8, "CP": 2, "recompute": "selective", "overlap": "ZBv2"},
  {"TP": 8, "PP": 2, "EP": 8, "CP": 1, "recompute": "selective", "overlap": "1F1B"},
  {"TP": 4, "PP": 8, "EP": 4, "CP": 2, "recompute": "selective", "overlap": "ZBv2"},
  {"TP": 2, "PP": 4, "EP": 16,"CP": 2, "recompute": "full",      "overlap": "Chimera"},
  {"TP": 8, "PP": 4, "EP": 4, "CP": 1, "recompute": "selective", "overlap": "1F1B"},
]
```

#### Pinned 路径与 503 处理

若 Run 携带 `_engine_preference`，Pipeline 走 `_run_pinned`：仅跑用户策略，registry 强制路由该引擎。若引擎覆盖范围（envelope）拒绝（HTTP 503），把候选标记 `MFU=0` 而不是 fail Pipeline，给前端"不可行"的诚实信号。

#### 生命周期事件（P2.3 之后无 Kafka）

每个阶段转换 INSERT 一行 `bs_run_event(kind, payload_jsonb)`，前端通过 data_svc 的 WS endpoint 拉取。kind 有 `status_change` / `stage_start` / `stage_end` / `log` / `warn`。详见 §4.3。

### 3.5 engine_svc 内的 registry surface（合并自 engine_registry_svc · :8087）

> **历史**：原本是独立服务 `engine_registry_svc :8089`。P3 收敛把它合并进 engine_svc —— 三大职责（select / fanout / sweep）都属于 "engine 编排"，把它们放在 engine_svc 同进程内省一跳（pipeline → registry → engine 变成 pipeline → engine），运行时少一个容器、CI 少一个 image、bs_engine 数据访问仍走 data_svc HTTP（沿用 P2 的 RegistryStore 模式）。

实现在 `service/engine_svc/app/registry/` 子包内：

- `routes.py` — `/v1/engines` CRUD + `/v1/predict` 6 个 FastAPI 路由，挂在 engine_svc 主 app 上
- `selector.py` / `router.py` — 包络匹配 + 选择算法
- `store.py` — `RegistryStore`，通过 `RUN_SVC_URL` 调用 data_svc

主进程在 `lifespan` 里同时启动 N 个 pipeline worker + 1 个 30s sweep task。

#### 职责

- 引擎插件注册表（self-attest）
- 心跳 / stale sweep
- 路由（按 fidelity → MAPE → SLA）
- predict 转发 + provenance 注入

#### 选择算法

```
1. 过滤：active 且 coverage_envelope 包含请求
2. 过滤：可选 SLA budget、fidelity floor
3. 排序：(-fidelity_rank, calibration_mape, sla_p99_ms) min
   fidelity_rank: analytical=0 < hybrid=1 < cycle-accurate=2
4. 命中第一个引擎；若全部不覆盖 → 503 + 每引擎 misses 详细列表
```

> 即"先选最高保真度（cycle-accurate 优先），再按 MAPE 精度，再按延迟 SLA"。MAPE 默认 99.0（RFC-004 校准前），每次 calibration `PATCH` 更新 `bs_engine.calibration` JSONB。

#### Provenance 注入

转发响应里塞入：

```json
"_provenance": {
  "engine": "surrogate-analytical",
  "version": "0.2.0",
  "fidelity": "analytical",
  "confidence": 0.94,
  "coverage_status": "in_dist",
  "latency_ms": 12.345,
  "selected_by": "auto" | "engine_preference"
}
```

让 engine_svc pipeline 与前端可追溯结果来源。

#### 心跳 sweep

后台 30s 跑一次 `disable_stale()`，把 `last_seen_at < now() - ENGINE_REGISTRY_STALE_S (默认 240s)` 的引擎置 `disabled`。引擎重新心跳后自动恢复 `active`。多 replica 并存时 sweep 幂等，无需 leader election。

### 3.6 surrogate_svc（FastAPI · :8083）

**Fidelity = analytical · SLA p99 = 100ms**

解析公式 + 启发式合成的"快算"引擎，覆盖：transformer-dense / MoE，TP/PP/EP/CP 大范围，B200/H200/GB300/MI355X/H100/NPU-910，训练 + 推理。

#### 关键公式

- **MFU 上限**：B200 FP8 = 60%，否则 52%
- **Bubble loss**：`max(0, (PP-1) × 0.006 - 0.005)`
- **Overlap drag**：1F1B=0.040 / ZB=0.020 / ZBv2=0.000 / ring_compress=0.012 / Chimera=0.018
- **Recompute drag**：selective=0.020 / full=0.055
- **EP 跨域惩罚**：`max(0, (EP - nvlink_domain/8)) × 0.012`
- **CP 增益**：`seq_len ≥ 8192 且 CP ≥ 2` 时 +0.005
- **Step 时延**：`step_ms = flops_per_step / (cluster_flops × mfu)`
- **峰值功率**：`gpu_count × tdp_kw × pue + (PP-1) × 0.4`
- **TTFT/TPOT** （推理）：`80 + PP×20 + (TP/4)×30 + (1-mfu)×200` / `12 + (TP-1)×1.2 + (1-mfu)×60`

#### KV cache 子模型（P-Domain-1）

- `pressure_pct = working_set_gb / hbm_gb × 100`
- `hit_rate = prefix_share + (1 - prefix_share) × min(1, hbm / working_set)`
- `spill_bytes_per_s = max(0, working_set - hbm) × (1 - prefix_share) / step_seconds`

#### Fabric 子模型（P-Domain-2）

按 link 类型给出利用率启发式：NVLink (intra-server TP) ≈ `mfu × tp_load × 50%`、IB/RoCE (cross-rack) ≈ `mfu × 30 + (PP-1) × 0.15 × 100 + ep_cross × 20`。

#### 瓶颈归因

按优先级判定 `bottleneck.primary`：

1. `kv_spill`（pressure > 100）→ severity=high
2. `saturated_link`（top util ≥ 90）→ severity=high
3. `pp_bubble`（idle% ≥ 5）→ severity=med
4. `compute`（默认）→ severity=low

每条带 `headline` 与 `suggested_action`，前端 BottleneckCard 直接渲染。

### 3.7 tco_svc（FastAPI · :8090）

> **角色**（P1.2 之后）：TCO 是侧路服务，**不在** registry 选路链路内（即不参与 §3.5 的 select / fanout）。pipeline.select 阶段直接 POST `/v1/tco/compute` 带 `persist=true`，tco_svc 写入 `bs_tco_breakdown` 表（专表，有结构化列），data_svc 的 `/report` 从那里读出来组装为 `report.tco`，engine identity 硬编码为 `tco-direct` / `0.1`。pre-P1.2 的"forge bs_run_engine_call(engine_name=tco-analytical) 行"路径已经移除 —— `bs_run_engine_call.request_jsonb` 重新只放 `EnginePredictRequest`。

#### 端点

| Method | Path | 说明 |
|--------|------|------|
| POST | `/v1/tco/compute` | TcoInputs → TcoBreakdown，可选 persist（=true 时 upsert bs_tco_breakdown） |
| GET  | `/v1/tco/runs/{run_id}` | 历史拆解读取（仍可单独调，但 RunDetail 不再用它） |
| POST | `/v1/tco/compare` | 同规则集下两个设计 ΔTCO |
| GET  | `/v1/tco/rules` | 透明披露当前规则集 |

#### 计算桶

1. **HW CapEx 摊销**：`capex_usd × (wall_clock_h / amortization_window_h) × count`
2. **功耗 OpEx**：`(util × power_load + (1-util) × power_idle) × h × count × $/kWh`
3. **冷却 OpEx**：`power_opex × (pue - 1)`
4. **存储 OpEx**：`∑ gb × months × $/gb/month`（KV cache 子集独立追踪）
5. **网络 OpEx**：调用方提供
6. **失败惩罚**：`restart_fraction × extra_h × gpu_hour_usd × count`

#### 灵敏度（数值导数）

- `∂total/∂gpu_count` (USD/卡)
- `∂total/∂wall_clock_s` (USD/小时)
- `∂total/∂utilization` (USD/%-point)

#### Per-unit 价格

`per_m_token_usd` / `per_gpu_hour_usd` / `per_inference_request_usd` —— 用于不同规模设计的横向对比。

---

## 4. 数据层

### 4.1 Postgres（PG 16-alpine · 33 个 forward migration）

> 按 `service/data_svc/migrations/NNN_topic.sql` 顺序执行（migrations 归 data_svc 仓持有）。编号 003 / 004 / 005 / 018 / 019 / 030 留空对应已下线子系统。回滚通过部署上一个镜像 tag + 必要时从 pg_dump 还原。
>
> **跨仓共享方式**：tco_svc 的 `tests/integration/migrations/` vendor 一份完整副本（CI 用 postgres service container 时 apply）。data_svc 改 schema 时手工同步——GitHub Actions 默认 `GITHUB_TOKEN` 不能 clone 私有 sibling，submodule 方案被堵。（P3 之前 engine_registry_svc 也有自己的 vendored 副本，合并入 engine_svc 后随仓退役。）

| 编号 | 主题 | 关键表 |
|-----:|------|------|
| 001 | 项目骨架 | `bs_project`, `bs_spec`, `bs_spec_version`, `bs_run`, `bs_run_artifact` |
| 002 | seed 数据 | demo 项目 + 用户 + 256× B200 训练集群 + 64× H200 推理集群 |
| 006 | plan slot | `bs_plan`, `bs_plan_slot`（8 槽 A–H） |
| 007 | 多项目 + RLS-prep | 项目隔离 |
| 008 | resource ontology | `bs_resource`, `bs_resource_edge`（已被 026 删） |
| 009 | production assets | （已被 026 删） |
| 010 | TCO 模型 | `bs_tco_rule`, `bs_tco_breakdown` |
| 011 | engine registry v1 | `bs_engine`（domain/granularity/sla_p99_ms 等） |
| 012 | workload mix | （已被 025/026 删） |
| 013 | scenarios | （已被 025/026 删） |
| 014 | accuracy benchmark | （已被 025/026 删） |
| 015 | KV cache 表 | （已被 025/026 删） |
| 016 | engine fabric 字段 | `bs_engine` 增 fabric 列 |
| 017 | jsonb deep merge function | utility |
| 020 | engine registry v2 | `bs_engine` 增 fidelity / coverage_envelope / kpi_outputs / calibration |
| 021 | engine registry v2 finalize | drop v1 列 |
| 022 | sim experiments | （已被 025 删） |
| 023 | run ID per-kind sequence | `bs_run_train_seq` 等 5 条 sequence |
| 024 | bs_catalog | 部件 + 模板 |
| 025 | current-product schema prune | 物理删 inert / API-only 表 |
| 026 | runtime schema prune | 物理删 resource 拓扑 / 生产快照表 |
| 027 | bytesim 引擎注册 | `bs_engine` 插入 bytesim 行 |
| 028 | catalog 3-block | preset body 拆 cluster / model / strategy 三块 |
| 029 | drop preset seed | 移除 seed 阶段灌的 preset 行 |
| 030 | drop astra_sim engine | 历史试装的引擎下线 |
| 031 | catalog gpu surrogate fields | bs_catalog 加 surrogate 用字段 |
| 032 | catalog H20 | 灌 H20 GPU SKU |
| **033** | **data path v2 (phase 1-2)** | `bs_run_engine_call` + `bs_run_event` + `bs_artifact` + `bs_run_artifact` + `bs_calibration_snapshot` |
| **034** | **data path v2 (phase 8)** | DROP `bs_run` 的 kpis / boundaries / artifacts / confidence / surrogate_ver 列；ADD `params jsonb` |
| **035** | **runspec kind**（P1.1 α） | `bs_spec.kind` CHECK 加 `'runspec'` |
| **036** | **pipeline stages**（P1.4 / P1.5） | `bs_run_engine_call.stage` CHECK 加 `'pinned'` + `'select'`（旧值保留） |
| **037** | **spec version 复合 PK** | `bs_spec_version_pkey` 改为 `(hash, spec_id)`；删 `bs_run_uses_spec.spec_hash` FK |

### 4.2 当前产品主链表（migration 034 / 035 / 037 之后）

```
bs_project              项目元数据
bs_spec                 spec 元数据 + latest_hash 指针；kind ∈ {hwspec, model, strategy, workload, runspec}
bs_spec_version         不可变版本，PK=(hash, spec_id)；同 hash 可跨 spec 共存
bs_run                  纯生命周期：id, project_id, kind, title, status, progress_pct,
                        inputs_hash (=runspec_hash 当存在), started_at, finished_at,
                        budget_gpuh, cost_usd, parent_run_id, created_by, created_at, params(jsonb)
                        ⚠ pre-data-path-v2 的 kpis/artifacts/boundaries/confidence/surrogate_ver 列已删
bs_run_uses_spec        run ↔ 多个 spec hash（hwspec / model / strategy / workload / runspec）
bs_lineage_edge         有向 DAG（derived_from / derived_from_study）
bs_plan / bs_plan_slot  8 槽计划（保留以待 tuner 重新接入）
bs_engine               引擎插件注册（v2 schema：fidelity / coverage / calibration）
bs_catalog              硬件部件 + 仿真模板
bs_tco_rule             TCO 价格规则
bs_tco_breakdown        per-run TCO 拆解；P1.2 之后是 report.tco 的唯一来源

── data path v2 (migration 033) ──
bs_run_engine_call      每条 predict 的 verbatim request_jsonb + response_jsonb +
                        engine_name / engine_version / contract_version / stage / is_best;
                        Partial index ON (run_id) WHERE is_best 让 /report 单行 lookup 廉价
bs_run_event            append-only 生命周期事件：status_change / stage_start /
                        stage_end / log / warn；data_svc WebSocket 的数据源
bs_artifact             内容寻址 artifact 元数据（sha256 PK + bytes + mime + label）
bs_run_artifact         run ↔ artifact 多对多 link 表，per-run filename
bs_calibration_snapshot 引擎级 calibration 元数据（去重共享）
```

### 4.3 Run 生命周期事件（`bs_run_event` 表）

P2.3 之前 Run 生命周期 fan-out 通过 Kafka (`bs.events` topic on Redpanda)。已退役 —— 全部消费者要么早就废弃（BFF 的 WS 桥）要么换实现（engine_svc cancel watcher 改为轮询 bs_run.status）。

现在所有阶段转换、日志行、状态变化都 INSERT 到 `bs_run_event(run_id, ts, kind, payload_jsonb)`：

| event.kind | 生产者 | 消费者 |
|------------|--------|--------|
| `status_change` | engine_svc + data_svc | RunDetail header / EnginePhases (via data_svc WS) |
| `stage_start` / `stage_end` | engine_svc | EnginePhases stepper |
| `log` | engine_svc | EngineLog (via WS) |
| `warn` | engine_svc | EngineLog warn 标记 |

### 4.4 Artifact 文件系统

`infra/artifacts/` 是 host bind-mount，engine_svc 写入，data_svc 服务 GET：

```
infra/artifacts/<run_id>/
├── timeline.json      # 占位 · 合成（4 stages × 4 microbatches 1F1B）
├── roofline.json      # 占位 · 合成（6 个 kernel 的样本）
├── snapshot.json      # inputs_hash + strategy_used + provenance
└── result.json        # best strategy + Top-5 排名
```

P2.1 之后 **engine.log 不再写文件**：pipeline 的日志行通过 `bs_run_event(kind='log')` 持久化，前端 WS 直接消费数据库行。剩下 4 个文件是 select 阶段写盘 + 注册为内容寻址 `bs_run_artifact` 的产物；timeline / roofline 的内容是合成数据，label 已标注"占位"。

`artifacts-init` 一次性容器在 compose 启动时把目录权限调成 engine_svc:1001 / data_svc:65532 共可写。

---

## 5. 共享契约（Phase 1 后的形态）

### 5.1 单一源：`engine_contracts` 独立仓

跨服务的 Pydantic 类型 + wire shapes 不再以 Python 包形式存在。所有跨服务数据契约现在 **以 OpenAPI 3.1 YAML 为单一真源**，存在独立的 [`engine_contracts`](https://github.com/songwenjun-rs/bytesim_engine_contracts) 仓（作为平台的一个 submodule 挂在仓根的 `engine_contracts/`）。

YAML 描述 30+ 个 `components/schemas`：
- **CoverageEnvelope** — 引擎自报覆盖范围（model_families / parallelism / hardware / quant / modes）
- **EnginePredictRequest** — cluster + model + workload + strategy
- **EnginePredictResponse** — mfu_pct / step_ms / breakdown / peak_kw / confidence / feasible / coverage_status + 可选 KPI（ttft_ms / tpot_ms / kv_hit_rate / bottleneck / phase_breakdown 等）
- **Wire shapes** — `EngineRegisterRequest`, `EngineCapabilities`, `EngineSmokeMatrix`（engine_svc 内的 registry surface ↔ 引擎间的注册 / 心跳 / smoke 协议）

仓内只有 `components/schemas`，**没有 paths** —— HTTP 路径归各服务自己管，不集中在共享仓。

### 5.2 消费者怎么用：mode A 纯契约 + codegen

每个消费者（bff / surrogate_svc / engine_svc / bytesim_svc / web）在 build 时跑 codegen 脚本，把 YAML 转成本地代码：

```
engine_contracts/
├── openapi/openapi.yaml          # 单一真源
└── scripts/
    ├── gen-python.sh    # datamodel-code-generator → Pydantic v2 模型
    └── gen-typescript.sh # openapi-typescript → readonly TS 类型
```

各消费者 repo 的 `generated/` 目录（如 `bff/generated/engine_contracts.py`）是 codegen 产物，**入 git** 让 PR diff 能看到契约影响。

#### 为什么 mode A（每仓独立 codegen）而不是发包

平台没有内网 PyPI / npm registry。**契约改动流程**：
1. 改 `engine_contracts/openapi/openapi.yaml`
2. push 到 engine_contracts repo
3. 各消费者仓里跑 `gen-python.sh` / `gen-typescript.sh` 重生 `generated/`
4. 各消费者仓提 PR 升级
5. 在平台仓推进对应 submodule 指针

代价：N 个仓改动；收益：每个仓 100% 自治，无包发布 / 依赖管理基础设施。

### 5.3 envelope_covers 不在契约里

选择逻辑（`envelope_covers(env, request) -> (ok, miss_reasons)`）原本在 `shared/engine_contracts/envelope.py`，Phase 1 拆分时识别出这是 **registry 私有业务**（其他服务都不调用），整体搬到当时的 `service/engine_registry_svc/app/selector.py`。同时把 `validate_envelope_intervals(env)`（JSON Schema 表达不了的 `lo ≤ hi` runtime check）也搬过去，在 register handler 调用。P3 收敛中这一对模块随 registry surface 一起迁入 `service/engine_svc/app/registry/`。

### 5.4 engine_runtime 退役 → 各引擎 vendor 一份

原 `shared/engine_runtime/` 是个 FastAPI mount + asyncio 自注册 + heartbeat 循环的 helper（"少代码挂载"工具）。Phase 1 拆分时，每个引擎服务（surrogate_svc 和 bytesim_svc）**vendor 一份 150 行的副本** 到 `app/engine_runtime/`，import 路径从 `from engine_runtime` 改成 `from app.engine_runtime`，内部 import 指向本地 `generated.engine_contracts`。

代价：~300 行代码 × 2 副本；收益：每个引擎仓完全自包含，没有跨仓 Python 包依赖。

新引擎接入仍是同款模式：
1. 写一个 `predict(request) -> response` 函数
2. 写一个 `EngineDescriptor`（name / version / fidelity / sla_p99_ms / coverage_envelope / kpi_outputs / smoke_matrix）
3. `mount_engine_runtime(app, descriptor, predict_fn)` —— 它会挂 `/v1/predict` + `/v1/capabilities` + `/v1/smoke_matrix`，启动 background 任务做注册 + 心跳

Wire shapes（EngineRegisterRequest / EngineCapabilities / SmokeCase）仍由 engine_contracts 仓的 YAML 定义，确保所有引擎对 registry 说同一种语言。

---

## 6. 前端

### 6.1 技术栈

- **构建**：Vite 5.4
- **框架**：React 18.3 + TypeScript 5.6（strict）
- **路由**：React Router DOM 6.27
- **状态/数据**：TanStack React Query 5.59
- **拓扑**：ReactFlow 11.11
- **测试**：Vitest 4.1（单测） + Playwright 1.48（e2e）

Dev 端口 5173，Vite 把 `/v1/*` 代理到 BFF :8080；生产用 `VITE_BFF_URL`。

### 6.2 自动登录与默认 spec

无登录页：`main.tsx` 启动时调 `bootstrapAuth()` → POST `/v1/auth/login` （hardcoded `user_id: "songwenjun"`）拿到 JWT 与 projects，写入 localStorage（`bytesim.jwt` / `bytesim.project`）。所有 API 自动加 `Authorization: Bearer ...` 与 `X-Project-ID` 头；401 则清空重登。

`bootstrapDefaultSpecs()` 紧随其后，确保 `hwspec_topo_b1` 与 `model_moe256e` 必存（GET 200 不动；404 就 POST snapshot 创建）。`make reset` 后用户进首页就能仿真，不需要任何手动种数据。

### 6.3 路由树

| 路径 | 页面 | 用途 |
|------|------|------|
| `/dashboard` | Dashboard | 工作台首页（4 stat chips + 4 quick action + 集群概览 + 最近仿真） |
| `/sim/training` | TrainingSim | 训练仿真：顶栏（名称 + 模板 + 启动）+ 2 列布局（cluster picker / 模型 / KV / 并行 + 引擎检查 / GPU 占用 / 实时 predict） |
| `/sim/inference` | InferenceSim | 推理仿真：同款布局 + KV cache section + SLO 目标 |
| `/sim/reports` | Reports | 列表 + 多选 + 删除 + 对比触发 |
| `/sim/reports/:runId` | RunDetail | 单 Run 深度详情 |
| `/sim/reports/compare?ids=…` | ReportsCompare | ≥2 份并排：仿真结果 / 集群成本 / 模型并行 |
| `/sim/cluster/:specId` | Topology | datacenter → cluster → rack → server → leaf 全栈编辑器，机房视图 + 网络视图双 tab |
| `/registry/parts/:rootId?` | Catalog | CPU / GPU / 网卡 / SSD CRUD |
| `/registry/engines` | Engines | 注册表查看 + 覆盖范围 + 校准 MAPE |
| `/sim/tuner` `/sim/calibration` `/sim/kvcache` | Placeholders | 待重新设计 |

### 6.4 状态管理约定

- TanStack Query：所有读用 `useQuery`，所有写用 `useMutation`。`onSuccess` 一律 invalidate 关联 query key 触发刷新。
- 自适应轮询：`useRunReport`（data path v2 之后，前身 `useRunFull`）在状态非终态时 `refetchInterval: 2000`，到达 `done/failed/cancelled` 自动停（`refetchInterval: false`），驱动 ProgressStrip 与 SubmittedRunPanel。
- 表单：纯 `useState`，无 Redux/Zustand。
- localStorage 持久：JWT、project_id、最近 Run（"上一次 Run 的瓶颈"叠加层）。

### 6.5 关键组件分组

- `components/shell/` — Sidebar / Topbar / Modal / Toast 框架
- `components/run/` — KpiGrid / BottleneckCard / EnginePhases / TcoBreakdown / LineageGraph / PrevRunDeltaCard
- `components/sim/` — PresetSelector / ConstraintsPanel / LivePredictCard / SubmittedRunPanel / `insights.tsx`（训练 / 推理 / 报告共用）
- `components/topology/` — RackCanvas / NetworkView / Inspector / OverlayRunPicker / Palette / SummaryBar / VersionBar
- `components/comparator/` — RadarChart 等多 Run 对比
- `components/charts/` — 图表原语（持续扩展）

---

## 7. SDK 与 CLI

`sdk/bytesim/` 提供 Python SDK + `bytesim` CLI（`python -m bytesim` 或入口点）。

### 7.1 程序化使用

```python
from bytesim import Client
c = Client()  # 读 ~/.bytesim/config.toml
run = c.runs.get("sim-7f2a")
runs = c.runs.list(status="done", limit=10)
created = c.runs.create(hwspec_hash="…", model_hash="…", title="My run")
c.runs.cancel("sim-7f2a")
for line in c.runs.tail("sim-7f2a"):
    print(line)
```

### 7.2 CLI 子命令分组

- **config / auth**：`bytesim login <user_id>` · `bytesim logout` · `bytesim whoami` · `bytesim config show`
- **project**：`list` · `switch <id>`
- **run**：`list` · `get <id> [--full]` · `create` · `cancel` · `kick` · `tail`
- **spec**：`get` · `versions` · `diff --from h1 --to h2` · `fork` · `snapshot --from-file body.json --tag v1`
- **snapshot / dashboard**：附属命令组

每个命令都支持 `--json`（机器可读）、`--base-url` `--project` `--token`（一次性覆盖）。配置写到 `~/.bytesim/config.toml`。

---

## 8. 基础设施与 CI

### 8.1 Docker Compose

`docker-compose.yml` 主编排：服务 + Postgres + 一次性 `artifacts-init` 容器（P2.3 之后无 Redpanda）。

关键挂载：

- `./service/data_svc/migrations:/docker-entrypoint-initdb.d:ro` —— Postgres 启动自动跑 33 个 migration
- `./infra/artifacts:/artifacts` —— Run 产物 host 持久化

关键 env：`PG_DSN`、`ARTIFACTS_DIR=/artifacts`、`ENGINE_REGISTRY_URL=http://engine_svc:8087`（P3 合并后默认就是 engine_svc 自身；同进程内 pipeline 走 `http://localhost:8087` loopback）、`ENGINE_PREDICT_TIMEOUT_S=180`（容纳更慢的引擎插件）、`ENGINE_REGISTRY_STALE_S=240`、`POLL_INTERVAL_S=2`。Dev 还需 `BFF_ALLOW_DEV_SECRET=1` / `BFF_ALLOW_DEV_CORS=1`。


### 8.2 Makefile 速查

| 目标 | 作用 |
|------|------|
| `up` / `down` / `reset` | docker compose 启停 / 清盘重启 |
| `logs` / `ps` / `psql` | 跟踪日志 / 健康表 / Postgres shell |
| `surrogate-bench` | POST /v1/predict/timed 压测 |
| `run-create` / `run-status` / `run-watch` / `run-artifacts` / `engine-kick` | Run 自动化辅助 |
| `e2e` / `e2e-ci` / `e2e-engines` | 端到端冒烟 / CI 包装 / 引擎专项 |
| `tidy` / `fmt` | Go mod tidy / fmt |

### 8.3 测试矩阵（2026-05-14 拆仓后）

| 层 | 工具 | 现状 |
|---|---|---|
| **bff 单测** | `pytest tests/`（在 `bff/`） | **84% 行覆盖** · 89 passed |
| **surrogate_svc 单测** | `pytest tests/`（在 `service/surrogate_svc/`） | **87% 行覆盖** · 78 passed |
| **engine_svc 单测** | `pytest tests/`（在 `service/engine_svc/`） | **82% 行覆盖** · 26 passed |
| **tco_svc** unit + integration | `pytest tests/[integration]`，CI 加 PG service container | unit 29 + integration 2 → **store: 24% → 90%** |
| **data_svc** unit + integration | `go test -short` + `go test -tags=integration` | total **35% → 61%**, store **3.5% → 47.5%** |
| **bytesim_svc** | `python -m py_compile app/**.py` | 无 runtime 测试（subprocess 外部 binary 难以单测）|
| **engine_contracts** | codegen smoke（Python + TS） | 验证核心类型出现在生成产物 |
| **web 单测** | `cd dashboard && npm test` | **73% 行覆盖** · 360 passed · 38 文件 |
| **web 浏览器 e2e** | `cd dashboard && npm run test:e2e` | 7 条 Playwright + Chromium（**未接 CI**） |
| **跨服务集成** | platform `tests/db/` `tests/sdk/` `tests/main_modules/` `tests/engine_smoke/` | CI 默认不跑（需多 svc 联动 + pgserver） |
| **平台 e2e** | `scripts/e2e.sh` | docker compose 全栈 vertical 冒烟 |

### 8.4 CI（GitHub Actions · 每仓一份 ci.yml）

**每个 submodule 一份独立的 `.github/workflows/ci.yml`**（共 9 个，含平台仓自身）：

| 仓 | CI job | 内容 |
|---|---|---|
| engine_contracts | codegen-smoke | Python + TS codegen，断言核心类型存在 |
| dashboard | test | `npm ci && npm test` |
| bff | test | `pytest tests/` |
| service/data_svc | **unit + integration** | unit: `go test -short`；integration: PG service container + 33 migrations apply + `go test -tags=integration` |
| service/engine_svc | test | `pytest tests/`（P3 收敛后包含 registry surface 路由测试） |
| service/surrogate_svc | test | `pytest tests/` |
| service/bytesim_svc | compile | `python -m py_compile app/**.py` |
| service/tco_svc | **unit + integration** | unit: `pytest --ignore=tests/integration`；integration: PG service container + vendored migrations + `pytest tests/integration` |
| **bytesim_platform**（编排仓） | validate | `docker compose config` + `.gitmodules` 完整性 + gitlink ↔ 声明一致性 |

#### 测试 PG 命名空间隔离（2026-05-14 引入）

P1/P2 收敛后只有 data_svc 直连 PG；剩下 tco-svc 还保留 PG 集成测试（验证 vendored migrations）。这些测试代码**只读 `BYTESIM_TEST_PG_DSN`**，**永不读 `PG_DSN`**（后者是生产 / docker-compose 的连接串）。两者相等时（手动短路），测试 `t.Fatalf` / `pytest.fail` 拒绝执行。

这条规则是事故吃出来的：拆仓前 Snapshot 测试用 PG_DSN 跑过 docker-compose PG，把用户 `hwspec_topo_b1` 覆盖空了。现在 env 命名空间隔离 + 守护检查使测试结构上不可能碰生产 DB。

#### 跨仓 migration 共享

data_svc 是 schema 的唯一拥有者（33 个 `.sql` 在 `service/data_svc/migrations/`）。其它需要 PG 集成测试的 Python 服务（tco-svc）在自己仓 `tests/integration/migrations/` 下 **vendor 一份副本**。data_svc 改 schema 时手动同步——GitHub Actions 默认 `GITHUB_TOKEN` 不能 clone 私有 sibling 仓，submodule 方案被这条限制堵了。

### 8.5 端到端脚本

- **scripts/e2e.sh** — 17 阶段 vertical 冒烟（health → login → snapshot → 14 步主线 → registry 健康）
- **scripts/e2e_ci.sh** — 包装 e2e.sh，前后加 build/up/log dump/down
- **scripts/e2e_engines.sh** — 5 阶段引擎层快速验证（registry visibility / heartbeat / envelope-miss 503 / 路由 tiebreaker）
- **scripts/_lib.sh** — 共享 helpers（`curl_auth`、`wait_for_field`、`assert_python` 等）

### 8.6 可观测

每个服务都暴露 `/metrics`（Prometheus exposition 格式）：bff、engine_svc、data_svc 已接入 `_obs.py` / `internal/obs/`，其余服务 Phase 1 滚进。生产环境的 Prometheus / Grafana / Datadog 等观测栈直接抓取这些端点即可，平台本身不再内置开发用的观测 sidecar（早期 `infra/prometheus/` + `infra/grafana/` 已在 2026-05 移除）。

各 Python 服务 structlog JSON 输出（`SERVICE_NAME` 字段），Go 服务通过 `service/data_svc/internal/obs/obs.go` 输出同结构 slog。`X-Trace-Id`（16 位 hex）跨 HTTP 调用自动传递——任何 trace_id 都能在 6 个服务的日志里聚合查询。

---

## 9. 关键设计决策

> 这些主线"为什么这么做"，是后续读代码 / 改代码时最重要的上下文。

### 9.1 原子 claim：SQL `FOR UPDATE SKIP LOCKED` > 任务队列

不引入 Redis Stream / RabbitMQ —— Postgres 已经是真源；多 worker 副本通过单条 `UPDATE` 即可保证不重复消费。代价是必须容忍 2s 轮询延迟，但被 BFF "best-effort kick" 弥补。

### 9.2 spec 不可变 + latest_hash 指针 + 复合 PK (037)

每次 snapshot 写新 `bs_spec_version` 行（hash = SHA1 canonical body），`bs_spec.latest_hash` 单独维护"当前指针"。Run 引用具体 hash，不引用 spec_id；upgrade spec 不会改写历史 Run 的输入，但会触发 stale 标记，UI 据此引导用户重跑。

Migration 037 把 PK 改为复合 `(hash, spec_id)`：之前 PK 只在 `hash` 上违反了 `spec_id` 列的存在意图（fork-without-mods、跨项目共享 template 这种合理场景会 PK 冲突 500）。现在每个 spec 拥有自己的版本链，跨 spec 同 body 各存一行。

### 9.3 runspec 自动快照：input fingerprint 真兑现（P1.1 α）

pre-α：pipeline 用 `bs_run.params.*_override` 块 shallow merge 到硬编码 default 上跑预测；`bs_run.inputs_hash` 是 4 个 spec_hash 的 sha1 但 pipeline 根本不读 spec body —— 同 hash 可能产出不同结果，"输入指纹"是装饰。

α 路：BFF 在 POST /v1/runs 时把 envelope 序列化成 spec body，调 data_svc 内容寻址 snapshot（id = `runspec_<sha8>`，相同 envelope 落同一行），把 `runspec_hash` 附给 data_svc create body，pipeline 直接读 runspec.body verbatim 跑。`inputs_hash` 在有 runspec 时直接等于 runspec_hash —— 真正"同 hash → 同输入 → 同结果"。Legacy fallback：runspec 缺席时 pipeline 走旧的 override 合并路径，老 run 仍可重放。

### 9.4 引擎 envelope：宁愿"诚实小"也不"假装大"

引擎在自注册时声明 envelope（model_families × parallelism × hardware × quant × modes）。请求超出 envelope 直接 503 + per-engine misses 列表，而不是悄悄 fallback 到能力差异更大的引擎；用户清楚知道"我这次跑的是哪个引擎"。

### 9.5 Pinned 路径：respect engine_preference > 自动选最优

用户在 UI 钉死引擎时，Pipeline 走 `_run_pinned`：跳过 scan，registry 强制路由该引擎。引擎拒绝 503 时把候选标记 MFU=0 而不是 fail Pipeline——给前端"不可行"的诚实信号，可视化体验稳定。Migration 036 给 `bs_run_engine_call.stage` CHECK 加 `'pinned'`，之前不得不写成 `'baseline'` 的混淆审计场景消失。

### 9.6 Data path v2：JSONB verbatim > 字段 allowlist

pre-v2：engine_svc 在 pipeline 末尾把 surrogate 的响应 cherry-pick 几个字段 PATCH 进 `bs_run.kpis`；任何新字段都要改 engine_svc 的 allowlist 才能被前端看到，是一个 cross-service couple 点。

v2：engine_svc INSERT `bs_run_engine_call` 一整行 `response_jsonb`，**data_svc 不做任何字段过滤**；前端读 `report.predict.response.X` 直接获取最新字段。Contract version 列允许同 run 携带多版响应。Pipeline 末尾的 `bs_run` PATCH 只动 status / progress / timestamps；写放大降到最低。

### 9.7 取消信号走 HTTP poll，不走 Kafka（P2.3）

pre-P2.3：BFF cancel 时 publish 一条 Kafka `run.cancelled`，engine_svc 的 cancel-watcher 协程消费后 set 一个 in-memory asyncio.Event，pipeline 在阶段边界检查 Event。整条链 dependence on：Redpanda 容器 + aiokafka 依赖 + 一个常驻协程 + 一份 in-memory 状态。

P2.3：删掉 Kafka，pipeline 在每个 stage 边界 `GET /v1/runs/{id}` 检查 `status` —— 拿到 cancelled 就在下一个安全点退出。cancel 延迟从 ~10ms 变成 ~600ms（一个 stage 时长），但代价是负的：少一个外部组件、少一个 in-flight asyncio state、少一份 lifecycle event 重复写（pre-P2.3 lifecycle 同时存在 Kafka + bs_run_event 两路）。

### 9.8 fidelity 排序：`(-fidelity_rank, MAPE, SLA)` 字典序

cycle-accurate 优先于 analytical（精度高 > 快），同保真度比 MAPE（已校准 > 未校准），最后 tie-break SLA。这个排序明确把"用户能接受多慢"放最末位 —— 真要快就显式给 SLA budget 过滤。

### 9.9 best-effort TCO：侧路服务（P1.2 之后）

engine_svc 完成 select 后调一次 tco_svc 带 `persist=true`，**失败只记日志，不 fail Run**。TCO 写自己的 `bs_tco_breakdown` 表，data_svc `/report` 从那里读出来塞进 `report.tco`。TCO **不在** §3.5 的 registry 选路链路内 —— 它没有 calibration / heartbeat / envelope，是一个 rule-based 价格服务。把它伪装成 engine_call 行的旧路径（pre-P1.2）已删除，`bs_run_engine_call.request_jsonb` 重新只放 `EnginePredictRequest`。

### 9.10 `_provenance` 注入 + X-Trace-Id：可追溯

每条 predict 响应被 registry 塞 `_provenance`（engine name / version / fidelity / latency_ms / selected_by），engine_svc verbatim 写进 `bs_run_engine_call.response_jsonb`；前端能追溯"这个数是哪个引擎出的、置信度多少、为什么选它"。X-Trace-Id 把日志 / 指标 / bs_run_event 串在一起，分布式排查不靠猜。`_provenance` 是权威的 routing-side 视图，engine 自报的 `engine_info` 只用来补 `build_sha`（pre-P2.4 顺序反了导致 self-reported 覆盖 registry，已修正）。

### 9.11 报告聚合在 data_svc，不在 BFF（P3.1）

design 文档原先约定的 "report-svc" 没有单独建服务，但它的职责（数据库 JOIN + payload 组装）从 BFF 搬到了 data_svc 的 `/v1/runs/{id}/report`。内部用 `errgroup` 并发 6 路 SQL（run / specs / lineage / best_calls / artifacts / tco_breakdown），BFF 退化为 thin proxy。RunDetail 打开时的 RPC 从每秒 ~2.5 次降到 ~0.5 次。"predict / tco" 的拆分由 data_svc 完成（mild coupling on engine_name 字符串），匹配 redesign §4 "bff stops aggregating" 的设计意图。

### 9.12 自创建 spec / 自动 token / 自动 seed：开盒即用

`make reset` 清盘后，前端一进来：

1. `bootstrapAuth()` → 自动登录，拿 token
2. `bootstrapDefaultSpecs()` → 自动 POST `hwspec_topo_b1` / `model_moe256e` snapshot
3. 用户进训练页提交时 BFF 自动 snapshot runspec
4. data_svc 在每个 snapshot 自动创建缺失的 `bs_spec` + `bs_project` 行（按 id 前缀 `hwspec_/model_/strategy_/workload_/runspec_` 推断 kind）

整个体验对用户透明 —— 任何没有"管理员设置数据"步骤的工程，正确做法都是这样。

---

## 10. 扩展指南

### 10.1 加新引擎

1. 在 `backend/<engine>-svc/` 起 FastAPI 服务，写 `predict_fn` 与 `EngineDescriptor`。
2. `mount_engine_runtime(app, descriptor, predict_fn)` —— 自动得到 `/v1/capabilities` `/v1/predict` + 自注册 + 心跳。
3. `docker-compose.yml` 加 service block，端口接续 8080+ 顺序。
4. 在 `tests/<engine>/` 写 smoke 测试，envelope 边界用例必备。
5. （可选）在 `scripts/e2e_engines.sh` 加专项断言。

### 10.2 加新 KPI / P-Domain

1. 在 `engine_contracts/openapi/openapi.yaml` 的 `EnginePredictResponse` schema 加可选字段；push 后各消费者仓跑 `gen-python.sh` / `gen-typescript.sh` 重生 `generated/`。
2. 老引擎不动（不返回 = `null`）；新引擎按需填充。
3. 前端在 RunDetail 渲染 `null` 时降级展示 "n/a"，不要崩。
4. 文档（本文 §3 与 §5）补一条说明。

### 10.3 加 migration

1. 取下一个空闲编号（避开 003 / 004 / 005 / 018），命名 `NNN_topic.sql`。
2. `tests/db/test_pg_stores.py` 加用例。
3. `make reset` 重新刷库验证。

### 10.4 加 BFF 路由

1. `bff/app/api/<domain>.py` 写 router；`bff/app/main.py` 注册。
2. `bff/app/clients/<svc>.py` 加下游客户端（用 `traced_async_client()` 注入 trace）。
3. `dashboard/src/api/<domain>.ts` 加客户端，页面层用 `useQuery`/`useMutation`。
4. `tests/bff/test_proxy_routes.py` 加 happy / error 用例。

### 10.5 加前端测试

1. 单测：`dashboard/src/__tests__/<topic>.test.tsx`，覆盖率门禁自动监督。
2. e2e：`dashboard/e2e/<NN>-<topic>.spec.ts`（Playwright）。
3. **永远不要调低**覆盖率 threshold；调高才是正确方向。

### 10.6 提交约定

- Conventional commits：`feat(<svc>): ...` / `fix(<svc>): ...` / `chore(...)` / `docs(...)`
- PR 必过 unit + build + e2e + playwright 四个 workflow
- 工程纪律见 `CLAUDE.md`（思考先行、最小改动、外科手术式编辑）

---

## 11. 已下线子系统

记录给后人当作"为什么这里有空洞"的提示：

- `mcp-svc`（Copilot 助手）—— 已移除
- `realtime-svc`（Yjs 协同）—— 已移除
- `tuner-svc`（自动寻优）—— 已移除，待产品节奏成熟以新形态接入
- `calibration-svc`（校准中心）—— 同上
- `scenario-svc`（workload mix / 时间维度）—— 已移除
- `ingest-svc`（生产快照接入）—— 已移除（曾用于校准链路 ground truth 入口）
- migration 003 / 004 / 005 / 018 —— 留空对应上述子系统

`bs_plan` / `bs_plan_slot` 在产品 schema 中保留，作为 tuner 重新接入的锚点。

---

## 12. 词汇表

| 术语 | 含义 |
|------|------|
| **MFU** | Model FLOPs Utilization，模型实际利用算力百分比 |
| **TTFT / TPOT** | 推理首 token 延迟 / 后续 per token 延迟 |
| **TP / PP / EP / CP** | Tensor / Pipeline / Expert / Context Parallelism 维度 |
| **1F1B / ZB / ZBv2 / Chimera** | 流水线 overlap 调度策略 |
| **Envelope** | 引擎自报的覆盖范围，用于 registry 拒绝越界请求 |
| **Pinned** | 用户在 UI 钉死引擎与策略，跳过 scan 直接跑 |
| **Bubble** | 流水线阶段间的空隙时间（PP 越大越多） |
| **PUE** | Power Usage Effectiveness（数据中心电效） |
| **HBM** | High Bandwidth Memory（GPU 显存） |
| **provenance** | registry 注入的"这条结果由哪个引擎、哪版本算出"元信息 |
| **stale spec** | Run 引用的 spec 版本已不是 latest（spec 在 Run 后被更新） |

---

> 本文档随主分支演进。源码与本文描述出现偏差时以源码为准；如发现持续不一致，请提 PR 同步更新本文。
