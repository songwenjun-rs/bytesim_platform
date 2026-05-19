# bytesim_svc 详细设计方案

## 1. 文档目标

本文档基于当前 `bytesim_platform` 主干代码，对以下内容进行统一设计：

- 当前平台整体架构与服务协作方式
- `engine/bytesim` 仿真引擎的代码结构、运行依赖与服务化边界
- `service/surrogate_svc` 的可复用模式
- `service/bytesim_svc` 的目标设计、模块拆分、注册接入流程与上线验收标准

本文档的目标不是重新发明一套新架构，而是在**当前仓库已经存在的平台约束下**，给出一套能让 `engine/bytesim` 正常注册到 `engine_svc`，并在整个平台中可被路由、调用、观测、排障和演进的落地方案。

结论先行：

1. 当前工程已经具备“新引擎接入”的主体骨架，关键机制都已存在。
2. `bytesim_svc` 也已经有一个可运行雏形，但与平台契约、`engine/bytesim` 实际输入输出、以及 `surrogate_svc` 的成熟实现相比，仍有若干关键缺口。
3. 推荐方案不是推倒重写，而是沿用 `surrogate_svc` 的“引擎壳 + 契约适配 + 自注册”模式，对 `bytesim_svc` 做一次**契约对齐、资产预检、输入解析、输出归一、观测补强**的工程化补全。

---

## 2. 当前系统工程架构分析

### 2.1 平台分层

当前工程是一个编排型 monorepo，顶层负责组合多个服务与引擎子模块：

- `dashboard/`：前端 SPA，负责提交仿真请求、展示 run report、查看引擎输出
- `bff/`：统一网关，负责鉴权、透传、schema 导出、对前端屏蔽后端细节
- `service/data_svc/`：唯一数据写入面，负责 runs/specs/catalog/artifacts/events/engines
- `service/engine_svc/`：执行 5 阶段 pipeline，同时内置 engine registry 能力
- `service/surrogate_svc/`：解析型引擎，低延迟、宽覆盖
- `service/bytesim_svc/`：ByteSim 仿真引擎包装层
- `service/tco_svc/`：TCO 计算
- `engine/bytesim/`：真实仿真内核与脚本资产，不直接对外提供 HTTP

平台的核心链路是：

`dashboard -> bff -> data_svc / engine_svc -> 某个引擎服务 -> engine_svc 持久化 -> data_svc report -> dashboard`

### 2.2 引擎接入的系统约束

当前平台对“引擎服务”的要求已经比较明确：

1. 必须提供标准 HTTP 接口：
   - `GET /v1/capabilities`
   - `GET /v1/smoke_matrix`
   - `POST /v1/predict`
   - `GET /healthz`
2. 必须使用 `EnginePredictRequest -> EnginePredictResponse` 契约。
3. 启动后要主动向 `engine_svc` 暴露的 registry surface 自注册。
4. 需要持续 heartbeat，失联后会被 `engine_svc` sweeper 标记为 stale/disabled。
5. 注册信息必须与 `GET /v1/capabilities` 返回内容一致，否则注册会被拒绝。
6. `engine_svc` 在路由时按 fidelity、calibration、SLA、coverage envelope 选择引擎。

因此，`engine/bytesim` 能否接进当前平台，不取决于仿真内核本身是否存在，而取决于是否有一个**契约正确、能力声明准确、部署可达、健康可观测**的 `bytesim_svc` 外壳。

### 2.3 engine_svc 对引擎的选择逻辑

`engine_svc` 当前的路由策略可以概括为：

1. 筛选 active 引擎
2. 用 `coverage_envelope` 判断请求是否被覆盖
3. 可选过滤 `sla_budget_ms` 与 `fidelity_floor`
4. 排序优先级：
   - fidelity：`cycle-accurate > hybrid > analytical`
   - calibration MAPE 越小越优
   - `sla_p99_ms` 越小越优

这意味着 `bytesim_svc` 设计时必须重点保证三件事：

- **不要虚报 envelope**
- **不要虚报 fidelity**
- **不要在资产不完整时继续注册**

否则就会出现“路由选中了 bytesim，但实际无法执行”的平台级错误。

---

## 3. surrogate_svc 的可复用模式

`surrogate_svc` 是当前平台中最成熟的引擎接入样板，它的价值不在于公式模型本身，而在于它展示了一套稳定的服务化模式。

### 3.1 可直接复用的设计原则

#### 原则 A：引擎核心与 HTTP 壳解耦

`surrogate_svc` 的真实预测逻辑在 `predict.py`，而 HTTP 服务、契约适配、能力声明、自注册都集中在 `main.py` 与 `engine_runtime/`。

这套拆分非常适合 `bytesim_svc`：

- `engine/bytesim` 保持“仿真内核 + 脚本入口”定位
- `service/bytesim_svc` 只负责把平台契约翻译成脚本参数，再把脚本输出翻译回平台响应

#### 原则 B：使用统一的 engine runtime 装配能力接口和自注册

`surrogate_svc` 通过 `mount_engine_runtime()` 一次性装配：

- `/v1/capabilities`
- `/v1/smoke_matrix`
- `/v1/predict`
- 启动注册
- 定时 heartbeat
- 关闭 deprecate

`bytesim_svc` 不应重新实现一套注册逻辑，而应继续复用同一个 runtime 模式。

#### 原则 C：主文件负责契约适配，核心模块负责算法

`surrogate_svc` 中 `main.py` 承担 contract adapter 职责：

- 输入：OpenAPI 生成的 contract model
- 内部：业务预测结构
- 输出：统一的 `EnginePredictResponse`

对于 `bytesim_svc`，这个适配层反而更重要，因为 `engine/bytesim` 的脚本参数与平台契约并不一一对应。

#### 原则 D：启动阶段尽量完成预检与缓存预热

`surrogate_svc` 会在启动阶段完成 catalog/calibration 预热；其思想可以迁移为：

- `bytesim_svc` 启动时检查 ByteSim 资产是否齐全
- 校验关键脚本、拓扑文件、Python 依赖、外部目录是否可读
- 只有预检通过后才允许进入 ready/registered 状态

### 3.2 不应直接照搬的部分

`surrogate_svc` 的某些实现不应该原样复制：

1. 它的能力 envelope 非常宽，是解析引擎特性，不适合仿真引擎。
2. 它大量依赖 data_svc 的 catalog/calibration 数据；`bytesim_svc` 的第一阶段不必强依赖 data_svc。
3. 它的核心是纯 Python 计算，`bytesim_svc` 的核心是**重型脚本 + 外部资产 + 子进程执行**，故障模型不同。

---

## 4. engine/bytesim 架构分析

### 4.1 engine/bytesim 的定位

`engine/bytesim` 不是 HTTP 服务，而是一个多组件仿真工程，主要包含：

- C++ DES 仿真内核
- htsim / ns-3 两类网络后端
- NCCL / collective 仿真
- Python 脚本层
- 与 Charon 计算模拟的集成
- topology / network_config / trace 相关资产

它本质上是“仿真资产仓”，而不是“平台原生服务”。

### 4.2 关键组成

#### 1）构建与运行入口

- 顶层脚本：`engine/bytesim/bytesim`
- 顶层构建：`engine/bytesim/CMakeLists.txt`
- 全局网络配置：`engine/bytesim/network_config.toml`

#### 2）Python 脚本入口

当前服务化最关键的三个脚本是：

- `synverse/src/run_sim.py`
  - 面向 LLM training / inference
  - 输入包括 `model_cfg_path`、并行度、batch、seq_len 等
  - 输出 `e2e_output.json`
- `synverse/src/run_sim_m12.py`
  - 面向特定 M12/DiT 训练流
- `synverse/src/run_sim_mlsys_dit.py`
  - 面向 DiT inference / xllm/vllm 路径

这说明 `bytesim_svc` 不应该直接嵌入 C++ API，而应把这些脚本视为**稳定的服务化边界**。

#### 3）资产依赖

`engine/bytesim` 的运行不是纯 Python 依赖，还依赖：

- `synverse/src`
- `extern/charon`
- `topo_files`
- `network_config.toml`
- 某些场景下的 pybind/trace/perfetto/protobuf 环境

这也是为什么 `bytesim_svc` 必须有一个明确的“资产预检 + 容器装配”设计。

### 4.3 对服务化最关键的约束

从 `engine/bytesim` 当前脚本实现看，至少存在以下服务化约束：

1. 脚本要求 `model_cfg_path`，而平台契约里没有强制该字段。
2. 脚本对 topology、backend、timing-aware、模型类型等参数有隐式假设。
3. 不同脚本输出 JSON 结构不完全一致，需要统一归一化。
4. 某些脚本内部会动态装依赖或依赖特定 protobuf 版本，可能引入冷启动不稳定性。
5. 当前脚本更像“研究入口”，不是直接面向线上 HTTP 调用设计的。

因此，`bytesim_svc` 的关键工作不是“调用 subprocess”这么简单，而是要构建一层**参数解析器、模型解析器、拓扑解析器、结果归一器和故障屏蔽层**。

---

## 5. 当前 bytesim_svc 现状评估

当前仓库里的 `service/bytesim_svc` 已经具备以下能力：

1. FastAPI 服务骨架已存在
2. 已 vendored `engine_runtime`
3. 已支持 `/v1/capabilities`、`/v1/smoke_matrix`、`/v1/predict`
4. 已具备注册与 heartbeat 机制
5. 已封装 `runner.py` 调 `run_sim.py` / `run_sim_m12.py` / `run_sim_mlsys_dit.py`
6. 已有 Dockerfile，可把 `engine/bytesim` 资产拷入镜像

但该实现距离“可正常注册并长期稳定使用”还有明显缺口。

### 5.1 关键问题

#### 问题 1：平台契约与 ByteSim 输入未对齐

当前 `main.py` 中对请求字段的理解仍然带有旧设计痕迹，例如直接读取不存在于统一契约中的 `workload.model_cfg_path`。但实际 `EnginePredictRequest` 的标准字段并不包含这个必填项。

这意味着：

- 当前实现无法仅依赖平台标准 envelope 完成真实 ByteSim 调用
- 在 engine_svc 正常 scan/predict 路径下，可能出现参数缺失

#### 问题 2：coverage envelope 过宽

当前 descriptor 声明了过宽的 `model_families` / modes / hardware 支持范围，但实际脚本能力主要集中在：

- transformer 类训练
- 部分 inference / DiT 路径

若 envelope 声明超出真实支持范围，engine_svc 会把本不应路由给 bytesim 的请求发给它。

#### 问题 3：fidelity 声明与真实模式不一致

当前实现把 `bytesim` 注册为 `hybrid`，但平台定位期望它作为高保真仿真引擎参与路由。若实际调用走的是 `legacy_trace`，那它确实不应宣称 `cycle-accurate`；但若资产完整并走 `bytesim_api` / DES 路径，则应该声明为 `cycle-accurate`。

因此 fidelity 不应写死，而应与实际 backend 绑定。

#### 问题 4：资产预检不足

当前健康检查是执行一个 pytest case，但没有在注册前校验：

- `run_sim.py` 是否存在
- `extern/charon` 是否存在
- topo 文件是否存在
- 关键 Python import 是否可用
- `bytesim_api` 模式是否真的可用

若这些条件不满足，服务仍可能启动，但在第一次 predict 才失败。

#### 问题 5：缺少标准化的错误与观测

当前子进程失败时只截取部分 stderr 返回 502，但缺少：

- 结构化错误分类
- trace id 贯穿
- subprocess 输入输出摘要
- 最近一次执行的 runlog/工作目录保留
- timeout / returncode / missing asset 的可区分诊断

#### 问题 6：测试与验收不足

当前缺少：

- 对 `runner.py` 参数拼装的单测
- 对 `model -> script args` 映射的单测
- 对 fake subprocess 输出到 `EnginePredictResponse` 的单测
- 对注册成功路径的集成验证

---

## 6. 目标设计总览

### 6.1 设计目标

本方案的目标是让 `bytesim_svc` 满足以下条件：

1. **能够被 engine_svc 正常注册**
2. **能够被 engine_svc 的 registry 按 envelope 正确选择**
3. **能够接受当前平台标准 `EnginePredictRequest`**
4. **能够稳定调用 `engine/bytesim` 的脚本入口**
5. **能够把仿真结果归一为平台统一 KPI**
6. **在资产缺失、参数不全、脚本失败时可快速诊断**
7. **与 surrogate_svc 在服务壳层保持一致的工程模式**

### 6.2 非目标

当前设计不要求在第一阶段完成以下事项：

- 把 `engine/bytesim` 重写为库内调用模式
- 修改 `engine_svc` 的路由策略
- 让 `bytesim_svc` 直接写 PG
- 让 `bytesim_svc` 自己维护完整 calibration 数据闭环
- 一次性覆盖全部 `engine/bytesim` 的研究脚本和模型类型

---

## 7. bytesim_svc 的目标模块设计

### 7.1 总体结构

推荐将 `service/bytesim_svc` 调整为如下结构：

```text
service/bytesim_svc/
├── app/
│   ├── main.py
│   ├── runner.py
│   ├── preflight.py
│   ├── resolver.py
│   ├── mapper.py
│   ├── normalizer.py
│   ├── models.py
│   ├── obs.py
│   └── engine_runtime/
├── config/
│   ├── model_registry.yaml
│   ├── topology_registry.yaml
│   └── backend_policy.yaml
├── tests/
│   ├── test_runner.py
│   ├── test_resolver.py
│   ├── test_normalizer.py
│   └── test_registration.py
├── generated/
├── Dockerfile
├── entrypoint.service.sh
└── README.md
```

其中各模块职责如下：

- `main.py`：服务入口、descriptor 构建、路由装配、startup/shutdown 生命周期
- `preflight.py`：资产与依赖预检
- `resolver.py`：把平台 envelope 解析为 ByteSim 可执行参数
- `mapper.py`：请求级映射逻辑，按训练/推理/DiT 等路径分派脚本
- `runner.py`：子进程调用、工作目录创建、超时/日志捕获
- `normalizer.py`：把脚本输出统一转换为 `EnginePredictResponse`
- `obs.py`：日志、trace id、中间件、指标

### 7.2 核心设计原则

#### 1）保持“薄壳”

`bytesim_svc` 不承载仿真算法，只承担以下职责：

- 参数校验
- 路径解析
- 脚本调用
- 结果归一
- 平台接入

#### 2）显式建模，而不是散落在 main.py 中

当前一些逻辑散落在 `main.py` 中，比如 GPU 映射、训练/推理分支、默认参数等。目标设计应把它们拆为独立模块，原因是：

- 便于单测
- 便于后续接新脚本
- 便于区分“平台契约问题”和“ByteSim 内核问题”

#### 3）把“可注册”与“可运行”绑定

`bytesim_svc` 只有在满足 ready 条件时才允许完成自注册：

- 资产存在
- 关键 import 成功
- backend 可用
- smoke case 通过最小验收

否则服务可以启动为 degraded，但必须拒绝注册或返回 not ready。

---

## 8. 请求处理与脚本调度设计

### 8.1 平台请求到 ByteSim 参数的转换总流程

一次 `POST /v1/predict` 的推荐处理链路如下：

```text
EnginePredictRequest
  -> schema validate
  -> resolver.resolve_model()
  -> resolver.resolve_topology()
  -> resolver.resolve_backend()
  -> mapper.build_script_invocation()
  -> runner.execute()
  -> normalizer.to_engine_response()
  -> EnginePredictResponse
```

### 8.2 ModelConfigResolver 设计

这是整个 bytesim_svc 成败的关键。

当前 ByteSim 脚本需要 `model_cfg_path`，而平台统一请求并不保证显式提供这个字段。因此必须设计一个统一解析策略：

#### 解析优先级

1. `req.runtime.extras.model_cfg_path`
2. `req.model` 的 extra 字段，例如 `hf_model_id` / `pretrained_path` / `model_cfg_path`
3. 本地静态映射表 `config/model_registry.yaml`
4. 无法解析则返回 422

#### 推荐的 model registry 键

建议使用如下维度做匹配：

- `family`
- `total_params_b`
- `activated_params_b`
- `weight_quant`
- `num_layers`
- `hidden_size`
- `n_routed_experts`
- `max_position_embeddings`
- `mode`

#### 设计原因

1. 不修改平台统一 contract 也能落地
2. 保持与现有 engine_svc/pipeline 兼容
3. 允许前端或 pipeline 在未来通过 `runtime.extras` 显式覆写
4. 允许本地静态配置先支撑主路径，再逐步演进为 catalog 化管理

### 8.3 TopologyResolver 设计

ByteSim 需要明确的 topology 文件和网络 backend 配置，但平台请求里只有抽象的 `cluster.fabric_topology` 与 `gpu_count`。

因此需要增加一个 `TopologyResolver`：

#### 输入

- `cluster.gpu_model`
- `cluster.gpu_count`
- `cluster.fabric_topology`
- `runtime.extras.topology_profile`
- `runtime.extras.intra_host_topo`
- `runtime.extras.inter_host_topo`

#### 输出

- `intra_host_topo`
- `inter_host_topo`
- `gpus_per_host`
- `use_intra_host_link`
- `network_config_overrides`

#### 默认策略

1. 若调用方显式给出 topo path，则优先使用
2. 否则根据 `gpu_model + gpu_count` 匹配 `config/topology_registry.yaml`
3. 若存在 `fabric_topology`，则将其作为 envelope 覆盖校验依据，同时允许映射到预定义 profile
4. 没有匹配到 topology 时直接 422，不进入仿真

这一步是为了防止“参数合法但拓扑不存在”的隐式失败。

### 8.4 BackendSelector 设计

推荐把 backend 策略显式化，而不是在代码里写死默认值。

#### 生产默认

- 训练：`bytesim_api`
- 推理（普通 transformer）：优先 `run_sim.py` 的 inference 路径
- DiT inference：`run_sim_mlsys_dit.py`
- `legacy_trace` 仅作为降级或开发模式，不应作为默认注册态

#### runtime.extras 扩展

建议允许以下可选字段：

- `network_backend`
- `timing_aware_cosim`
- `backend`
- `model_cfg_path`
- `topology_profile`
- `intra_host_topo`
- `inter_host_topo`
- `bytesim_dp_size`
- `output_length`

这些内容不需要修改 OpenAPI 主体结构，利用 `runtime.extras` 即可。

### 8.5 ScriptMapper 设计

建议将脚本分派规则固定为：

#### 路径 A：标准训练

满足条件：

- `workload.mode == "training"`
- `model.family in ["transformer-dense", "transformer-moe"]`
- 非 M12 特化

调用：

- `run_sim.py`

#### 路径 B：M12 / 特化训练

满足条件：

- `runtime.extras.training_backend == "m12"` 或 model profile 命中 M12

调用：

- `run_sim_m12.py`

#### 路径 C：普通推理

满足条件：

- `workload.mode == "inference"`
- 非 DiT

优先：

- 仍走 `run_sim.py` inference 路径

#### 路径 D：DiT 推理

满足条件：

- `model.family == "dit"` 或 `runtime.extras.inference_backend == "dit"`

调用：

- `run_sim_mlsys_dit.py`

这样可以保证 `POST /v1/predict` 对外保持统一，而内部按 profile 分派到不同 ByteSim 脚本。

---

## 9. 输出归一与平台契约映射设计

### 9.1 统一响应目标

无论底层脚本输出是训练 JSON、inference JSON 还是 DiT JSON，最终都必须归一为平台标准 `EnginePredictResponse`。

### 9.2 KPI 映射规范

#### 训练场景

ByteSim 输出优先映射：

- `step_time_s -> step_ms`
- `compute_time_s -> breakdown.compute_ms`
- `comm_time_s -> breakdown.comm_ms`
- `peak_power_w -> peak_kw`
- `MFU -> mfu_pct`

若缺少某些字段：

- `mem_stall_ms = 0`
- `idle_ms = max(step_ms - compute_ms - comm_ms, 0)`

#### 推理场景

普通推理优先映射：

- `request_latency_s -> step_ms`
- `ttft_s -> ttft_ms`
- `tpot_s -> tpot_ms`
- `compute_time_s -> breakdown.compute_ms`
- `comm_time_s -> breakdown.comm_ms`

DiT 场景优先映射：

- `e2e_latency_s -> step_ms`
- `single_step_compute_time_s` / `compute_time_s`
- `single_step_comm_time_s` / `comm_time_s`
- `frames_per_second_s`

### 9.3 confidence 设计

`bytesim_svc` 的 confidence 不应写死常数，建议按以下规则计算：

基础分：

- `bytesim_api + timing_aware_cosim = 0.92`
- `bytesim_api = 0.88`
- `shadow = 0.78`
- `legacy_trace = 0.65`

扣分项：

- 使用 fallback model registry：`-0.05`
- 使用 fallback topology profile：`-0.05`
- 未命中校准 profile：`-0.03`
- 输出字段缺失后用默认值填充：`-0.05`

最终区间裁剪到 `[0.3, 0.98]`。

### 9.4 coverage_status 设计

建议规则如下：

- 完全命中已声明模型/拓扑/模式：`in_dist`
- 依赖 fallback registry/topology 或 debug backend：`extrapolated`

不要把“仿真执行成功”错误地等同于“in_dist”。

### 9.5 附加信息

建议补充以下平台可用字段：

- `notes`
  - 本次脚本入口
  - backend 类型
  - topology profile
  - output/log 目录
- `engine_info`
  - build variant
  - bytesim version
  - backend mode
- `boundaries`
  - 标识使用了哪些 fallback
- `recommendations`
  - 例如通信占比过高、拓扑不匹配等

这样前端和 report 页面能直接复用现有展示组件。

---

## 10. 注册与能力声明设计

### 10.1 注册策略

`bytesim_svc` 继续使用与 `surrogate_svc` 相同的注册模式：

1. 启动
2. 执行 preflight
3. 构造 descriptor
4. `POST /v1/engines/register`
5. 周期性 `PATCH heartbeat`
6. 关闭时 `POST deprecate`

### 10.2 descriptor 设计原则

#### 1）fidelity 必须动态决定

建议：

- 只有在默认执行模式为 `bytesim_api` 且预检确认 DES 能力可用时，注册为 `cycle-accurate`
- 若只允许 `legacy_trace` / `shadow` 运行，则注册为 `hybrid`
- 若关键资产缺失，则**不注册**

#### 2）coverage envelope 必须收窄到真实支持范围

第一阶段建议声明为：

- `model_families`
  - `transformer-dense`
  - `transformer-moe`
  - `dit`
- `modes`
  - `training`
  - `inference`
- `gpu_models`
  - 与本地 topology/model registry 实际支持集一致
- `parallelism`
  - 仅声明已验证范围

不要在第一阶段继续宣称 `dlrm/rnn/ssm`。

#### 3）sla_p99_ms 不能按理想值声明

建议把 `sla_p99_ms` 设为符合当前实际子进程模型的值，例如：

- 生产仿真路径：`3000 ~ 10000 ms`

原因是当前 `bytesim_svc` 不是解析引擎，且脚本调用、冷启动、I/O、拓扑加载都明显重于 surrogate。若现在声明 `300 ms`，会误导 routing 和前端预期。

### 10.3 smoke_matrix 设计

建议至少内置 3 组 smoke case：

1. `transformer-dense` 训练
2. `transformer-moe` 训练
3. `dit` 推理

每个 case 只校验宽范围：

- `step_ms > 0`
- `mfu_pct in [0, 100]`
- `confidence in [0, 1]`
- 关键字段存在

启动健康检查不必每次都真正跑重型仿真，但 smoke matrix 必须可供 CI 和 contract test 使用。

---

## 11. 资产装配与部署设计

### 11.1 资产分层原则

`bytesim_svc` 的容器镜像应清晰区分三层：

1. 服务层：`app/` + `generated/`
2. Python 运行时层：venv + requirements
3. ByteSim 资产层：`engine/bytesim/synverse/src`、`extern/charon`、`topo_files`、`network_config.toml`

### 11.2 启动前预检清单

`preflight.py` 建议检查：

- `BYTESIM_SRC/run_sim.py` 存在
- `BYTESIM_SRC/run_sim_mlsys_dit.py` 存在
- `/opt/bytesim/extern/charon` 存在
- `/opt/bytesim/topo_files` 非空
- 能 import `transformers`
- 能 import `torch`
- 若默认 backend 是 `bytesim_api`，则确认相关模块可 import
- 必要文件路径均可读

输出应形成结构化结果：

```json
{
  "ready": true,
  "mode": "cycle-accurate",
  "checks": [
    {"name": "run_sim.py", "ok": true},
    {"name": "charon", "ok": true},
    {"name": "topo_files", "ok": true}
  ]
}
```

### 11.3 健康检查与就绪检查

建议拆分为：

- `/healthz`
  - 轻量存活检查
  - 不跑重型仿真
- `/readyz`
  - 返回 preflight 状态
  - 未 ready 时不注册

现有把 pytest 作为健康检查的方式可以保留为 debug 工具，但不建议继续作为默认 liveness probe。

### 11.4 docker-compose 集成策略

当前根 `docker-compose.yml` 已给出 `bytesim_svc` 定义，但设计上应补齐以下约束：

1. 明确 `bytesim_svc` 只有在 ByteSim 资产 ready 时才参与 `make up-all`
2. `ENGINE_SELF_URL`、`ENGINE_REGISTRY_URL` 使用与 surrogate 同样的环境变量约定
3. 如未来跨机部署，`ENGINE_SELF_URL` 必须外部可达，不能依赖容器内部 service-name 假设

---

## 12. 可观测性与错误处理设计

### 12.1 日志

建议直接复用平台已有观测模式：

- JSON logging
- trace id 透传
- request/response 耗时
- subprocess 执行摘要

至少记录：

- engine request hash
- selected script
- backend
- model profile
- topology profile
- timeout / returncode
- output dir

### 12.2 错误分类

建议把当前“统一 502”细分为：

- `422`
  - 合约参数非法
  - model registry 无法解析
  - topology 不支持
- `424`
  - 资产存在但 backend 不可用
- `502`
  - 脚本执行失败
- `504`
  - 仿真超时
- `503`
  - 服务未 ready 或未注册

### 12.3 子进程执行策略

`runner.py` 推荐提供统一执行模型：

- 每次请求创建独立工作目录
- stdout/stderr 分别落盘
- 返回结构包含：
  - `output_json`
  - `stdout_path`
  - `stderr_path`
  - `work_dir`
  - `elapsed_ms`

这样即使平台上层只持久化响应 JSON，本地容器内仍能快速定位失败原因。

### 12.4 并发与资源保护

由于 ByteSim 调用成本远高于 surrogate，建议增加：

- 并发上限 `BYTESIM_MAX_CONCURRENCY`
- 子进程超时 `BYTESIM_TIMEOUT_S`
- 每次请求独立临时目录
- 清理策略 `BYTESIM_KEEP_LAST_N_RUNS`

避免多个仿真请求同时打爆 CPU / 内存 / I/O。

---

## 13. 与当前系统的集成设计

### 13.1 与 engine_svc 的关系

`bytesim_svc` 只需要依赖 `engine_svc` 的 registry/predict surface，不需要直连 PG。

集成点：

1. `ENGINE_REGISTRY_URL=http://engine_svc:8087`
2. 启动后自注册
3. engine_svc 通过 `/v1/capabilities` 反向校验
4. engine_svc 在 scan/pinned 路径中路由请求到 `bytesim_svc`

### 13.2 与 data_svc 的关系

第一阶段 `bytesim_svc` 可不直连 `data_svc`。

原因：

- 当前 run、event、artifact、engine_call 的持久化已经由 engine_svc/data_svc 链路完成
- bytesim_svc 只需返回标准响应

第二阶段如需增强排障，可考虑：

- 通过 engine_svc 把 bytesim 的 stdout/stderr 摘要上传为 artifact
- 或在 response 中增加 `notes` / `engine_info` 提供定位线索

### 13.3 与 dashboard/BFF 的关系

`dashboard` 和 `bff` 不需要感知 `bytesim_svc` 的脚本细节，只感知：

- registry 中多了一个高保真引擎
- 某些 run 被 bytesim 命中
- report 中返回了更丰富的 breakdown / notes / confidence

因此本设计尽量把变化控制在 `service/bytesim_svc` 内部。

---

## 14. 建议的改造项清单

### 14.1 必做项

1. 新增 `preflight.py`
2. 新增 `resolver.py`
3. 新增 `normalizer.py`
4. 收窄 `descriptor.coverage_envelope`
5. 按真实 backend 动态决定 `fidelity`
6. 将默认 backend 从 `legacy_trace` 调整为可注册态真实后端
7. 把 `/healthz` 改为轻量检查，新增 `/readyz`
8. 增加 `runner.py` 的结构化执行结果
9. 为 contract -> script args -> response 建立单元测试
10. 仅在 ready 时执行自注册

### 14.2 建议项

1. 新增 `config/model_registry.yaml`
2. 新增 `config/topology_registry.yaml`
3. 新增 `obs.py`，对齐平台统一日志/指标模式
4. 增加 `engine_info` / `boundaries` / `recommendations`
5. 在 README 中明确资产依赖与部署方式

### 14.3 可延后项

1. calibration 闭环接入
2. artifact 回传能力
3. 多脚本统一到单入口
4. 把部分 registry 配置迁移到 data_svc catalog

---

## 15. 分阶段落地计划

### Phase 1：可注册、可调用、可诊断

目标：

- bytesim_svc 只在资产 ready 时注册
- engine_svc 能正常选中并调用 bytesim_svc
- 能完成至少一条 training smoke 和一条 inference smoke

产出：

- preflight
- resolver
- healthz/readyz
- accurate descriptor
- 基础单测

### Phase 2：可观测、可维护

目标：

- 增加日志、trace、错误分类
- 增加 output dir 与 stderr 归档
- 与 report 页面形成更丰富的输出

### Phase 3：覆盖面扩展

目标：

- 扩展 model registry
- 扩展 topology profile
- 支持更多 engine/bytesim 脚本入口
- 逐步引入 calibration

---

## 16. 验收标准

当以下条件全部满足时，可认为 `engine/bytesim` 已正常接入当前系统工程：

### 16.1 注册验收

1. `bytesim_svc` 启动后成功出现在 `GET /v1/engines`
2. registry 中 `coverage_envelope`、`fidelity`、`endpoint` 正确
3. heartbeat 正常更新，停止服务后会被 deprecate 或 stale sweep 移除

### 16.2 调用验收

1. 通过 `engine_svc /v1/predict` 能路由到 `bytesim_svc`
2. training 请求返回合法 `EnginePredictResponse`
3. inference / dit 请求返回合法 `EnginePredictResponse`
4. 不支持的请求返回清晰 422/503，而不是模糊 500

### 16.3 平台链路验收

1. 新建 run 后，engine_svc 能把某些 candidate 路由给 bytesim
2. `bs_run_engine_call` 中能看到 bytesim 的响应
3. 前端 report 能展示 bytesim 的 KPI
4. bytesim 不可用时不会误注册、不会污染路由

### 16.4 工程验收

1. runner / resolver / normalizer 有单测
2. smoke_matrix 覆盖训练与推理至少各一条
3. Docker 镜像能稳定构建
4. README 明确资产依赖和启动方式

---

## 17. 最终设计结论

基于当前代码工程，`bytesim_svc` 的正确定位应该是：

> **ByteSim 仿真资产的 HTTP 契约包装层，而不是新的仿真内核。**

它应当：

1. 沿用 `surrogate_svc` 的 `engine_runtime + descriptor + contract adapter` 模式
2. 保持对 `engine/bytesim` 的薄壳封装，不侵入仿真核心
3. 把“能否注册”建立在“资产是否 ready、backend 是否真实可用”之上
4. 用 resolver / mapper / normalizer 把平台统一 envelope 与 ByteSim 脚本接口桥接起来
5. 用准确的 capability、fidelity、SLA 和 smoke case 融入现有 routing 体系

按本方案落地后，`engine/bytesim` 将通过 `service/bytesim_svc` 作为一个标准引擎注册到当前平台中，参与 `engine_svc` 的自动路由与 pipeline 执行，并在 dashboard、BFF、data_svc、engine_svc 的既有链路中正常工作。
