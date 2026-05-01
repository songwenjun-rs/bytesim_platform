/**
 * 建设中占位页 — Tuner / Calibration / Production。
 *
 * 这三块在 README 里被标记为"待产品节奏成熟后再以新形态接入"
 * （tuner-svc / calibration-svc 已从 main 移除；生产数据接入是新需求）。
 * 先在导航里露出，避免架构师误以为功能不存在；点击进入有简介和路线图。
 */

type Plan = {
  emoji: string;
  title: string;
  subtitle: string;
  intro: string;
  features: string[];
  status: string;
};

function UnderConstruction({ plan }: { plan: Plan }) {
  return (
    <>
      <div className="page-hd">
        <div>
          <h1 className="page-ttl">{plan.title}</h1>
          <div className="page-sub">{plan.subtitle}</div>
        </div>
        <div className="page-act">
          <span className="tag tag-orange">建设中</span>
        </div>
      </div>

      <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
        <div style={{ fontSize: 56, marginBottom: 12, lineHeight: 1 }}>{plan.emoji}</div>
        <div style={{ fontSize: 17, color: "var(--t1)", fontWeight: 600, marginBottom: 8 }}>
          功能建设中
        </div>
        <div style={{ fontSize: 12.5, color: "var(--t3)", maxWidth: 520, margin: "0 auto", lineHeight: 1.7 }}>
          {plan.intro}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="card-t" style={{ marginBottom: 10 }}>规划能力</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--t2)", lineHeight: 1.9 }}>
            {plan.features.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
        <div className="card">
          <div className="card-t" style={{ marginBottom: 10 }}>当前状态</div>
          <div className="boundary-info" style={{ whiteSpace: "pre-wrap" }}>{plan.status}</div>
        </div>
      </div>
    </>
  );
}

export function Tuner() {
  return <UnderConstruction plan={{
    emoji: "🎯",
    title: "自动寻优",
    subtitle: "在 cluster × workload × strategy 空间内自动搜索 Pareto 最优解",
    intro:
      "给定目标（最大 MFU / 最低单 token 成本 / 最低延迟）和约束（GPU 预算 / 显存上限 / 拓扑），" +
      "自动寻优会在并行策略与硬件配置上做受约束搜索，输出 Pareto 前沿，并自动落库为可对比的仿真报告。",
    features: [
      "目标函数 + 约束声明（DSL / UI 双入口）",
      "并行策略空间扫描（TP × PP × EP × CP × overlap × recompute）",
      "Pareto 前沿可视化与候选解一键转 Run",
      "同 Tuner 多次实验的可重现追踪",
    ],
    status:
      "tuner-svc 已从主分支下线，待产品节奏成熟后以新形态接入。\n" +
      "现阶段建议在「训练仿真 / 推理仿真」中手动调参，或让 SRE 通过批量 Run 做 sweep。",
  }} />;
}

export function KVCacheSim() {
  return <UnderConstruction plan={{
    emoji: "🧠",
    title: "KVCache",
    subtitle: "在线推理 KV 缓存命中率、复用与抖动建模",
    intro:
      "在给定模型 / 流量 / 长上下文比例 / 前缀共享率的输入下，仿真 KVCache 在分页 / 共享 / 卸载策略下的" +
      "命中率、显存占用、TTFT 与 TPOT 影响，辅助判断 prefix-cache、PagedAttention、CPU/SSD offload 的收益。",
    features: [
      "PagedAttention 分页大小扫描与命中率曲线",
      "Prefix sharing / Radix tree 命中率仿真",
      "CPU / SSD offload 容量×带宽下的复用收益",
      "Cache-aware 调度对 TTFT P99 / TPOT 的影响评估",
    ],
    status:
      "数据通道与算子模型设计中，待与推理仿真主路径合流。\n" +
      "当前可在「推理仿真」中通过 kv_size_gb_per_seq / prefix_share_ratio / page_size_kb 参数做单点估算。",
  }} />;
}

export function Calibration() {
  return <UnderConstruction plan={{
    emoji: "🎚️",
    title: "校准中心",
    subtitle: "用真跑数据反向校准仿真引擎，量化 surrogate 与 cycle-accurate 的精度差",
    intro:
      "通过把生产 / profile run 的实测 KPI 与同输入仿真结果对齐，自动估算每个引擎在不同 (workload × hw × strategy) " +
      "切片上的 MAPE，决定路由优先级与 confidence 提示。",
    features: [
      "Profile run 录入与对齐（同 hash / 同 workload）",
      "按引擎 × 切片维度滚动计算 MAPE，自动写回 engine.calibration",
      "校准 inbox：触发偏差告警，定位失准切片",
      "失准切片自动屏蔽 surrogate，路由 fallback 到 cycle-accurate",
    ],
    status:
      "calibration-svc 已从主分支下线；引擎自带 calibration.mape_pct 字段保留。\n" +
      "短期内仍以 e2e 校准脚本（scripts/calibrate.sh，规划中）离线产出。",
  }} />;
}

export function Production() {
  return <UnderConstruction plan={{
    emoji: "📡",
    title: "生产数据",
    subtitle: "对接实际训练 / 推理集群的 telemetry，作为校准与校验的真值源",
    intro:
      "拉取 Prometheus / Slurm / OTel 中的真实 step time / MFU / 通信占比等指标，" +
      "按 hwspec × workload × strategy 归一化后入库，供「校准中心」与「仿真报告」做侧对侧比较。",
    features: [
      "多源采集器（Prometheus / OTel / 自定义 webhook）",
      "运行时元数据自动抽取与 spec hash 关联",
      "生产 Run 与仿真 Run 的并排对比视图",
      "异常步态识别 + 自动建 calibration ticket",
    ],
    status:
      "数据通道与 schema 设计中。\n" +
      "现阶段可手动把生产观测整理成 profile run 录入校准中心（待启用）。",
  }} />;
}
