/**
 * 推理仿真 — Plan A layout (mirrors TrainingSim).
 *
 * Sticky topbar (name + preset actions + submit) → progress strip → preset
 * card → 2-column grid (left: cluster + model + KV cache + parallel + SLO;
 * right sticky: engine selector + GPU util + live predict + constraints +
 * last-run panel).
 *
 * Differences vs TrainingSim:
 *   - workload.mode = "inference"
 *   - KV cache section (kv_size_gb_per_seq / prefix_share_ratio /
 *     page_size_kb / avg_active_seqs) — drives surrogate's TTFT/TPOT/
 *     hit_rate / cache_pressure outputs
 *   - SLO targets (TTFT p99, TPOT) — surfaced for the constraints panel
 *   - No global_batch / recompute / overlap as user-facing knobs (recompute
 *     and overlap go in strategy_override with sane defaults so the
 *     registry envelope check still works)
 */
import { useEffect, useMemo, useState } from "react";
import { useCreateRun } from "../api/runs";
import { useEngines } from "../api/engines";
import { useSpecLatest, useSpecList } from "../api/specs";
import { pushToast } from "../components/shell/Toast";
import { LastRunPanel, rememberLastRun, readLastRun } from "../components/sim/LastRunPanel";
import { pushRecentRun } from "../components/sim/recentRuns";
import { PresetSelector, PresetActionsRow } from "../components/sim/PresetSelector";
import { type InferencePresetForm } from "../components/sim/presets";
import { useCatalogItems } from "../api/catalogItems";
import { TopologyThumbnail } from "../components/sim/TopologyThumbnail";
import { ConstraintsPanel } from "../components/sim/ConstraintsPanel";
import { checkInference, hasErrors } from "../components/sim/constraints";
import { LivePredictCard } from "../components/sim/LivePredictCard";
import type { LivePredictPayload } from "../api/livePredict";
import { ParallelismDiagram } from "../components/sim/ParallelismDiagram";
import { KvFootprintBar } from "../components/sim/KvFootprintBar";
import {
  ChipRow, FieldLabel, ProgressStrip, EngineCheckCard, GpuUtilDonut,
  summarizeHwSpec, type CurrentConfig,
} from "../components/sim/insights";

const QUANT_CHOICES = ["FP8", "BF16"] as const;
const TP_CHOICES = [1, 2, 4, 8, 16, 32];
const PP_CHOICES = [1, 2, 4, 8];
const EP_CHOICES = [1, 2, 4, 8];
const CP_CHOICES = [1, 2, 4];

export function InferenceSim() {
  const create = useCreateRun();
  // Presets — bs_catalog kind=infer_preset.
  const presetsQuery = useCatalogItems<InferencePresetForm>("infer_preset");
  const presets = (presetsQuery.data ?? []).map((it) => ({
    id: it.id, name: it.name,
    desc: (it.body as any).desc ?? "", form: it.body,
  }));
  const [submittedRunId, setSubmittedRunId] = useState<string | null>(null);
  const [presetsVersion, setPresetsVersion] = useState(0);

  const specList = useSpecList("hwspec");
  const [hwspecId, setHwspecId] = useState<string>("hwspec_topo_b1");
  useEffect(() => {
    if (specList.data && specList.data.length > 0) {
      const exists = specList.data.some((s) => s.id === hwspecId);
      if (!exists) setHwspecId(specList.data[0].id);
    }
  }, [specList.data, hwspecId]);

  const hwspec = useSpecLatest("hwspec", hwspecId);
  const model = useSpecLatest("model", "model_moe256e");

  // Cluster picker — lists clusters within the loaded hwspec body.
  // Inference users typically pick the inference cluster (C02 / 64×H200) but
  // any cluster works.
  const availableClusters = hwspec.data?.version.body.datacenter?.clusters ?? [];
  const [clusterId, setClusterId] = useState<string>("");
  useEffect(() => {
    if (availableClusters.length === 0) return;
    const exists = availableClusters.some((c) => c.id === clusterId);
    if (!exists) {
      // Default-prefer "推理" purpose if multiple clusters configured.
      const inferCluster = availableClusters.find((c) => c.purpose === "推理");
      setClusterId((inferCluster ?? availableClusters[0]).id);
    }
  }, [availableClusters, clusterId]);

  const cluster = useMemo(
    () => summarizeHwSpec(hwspec.data?.version.body, clusterId || null),
    [hwspec.data, clusterId],
  );

  const [form, setForm] = useState({
    title: "",
    activated_params_b: 37,
    total_params_b: 671,
    seq_len: 8192,
    quant: "FP8" as (typeof QUANT_CHOICES)[number],
    // KV cache
    kv_size_gb_per_seq: 0.020,
    prefix_share_ratio: 0.6,
    page_size_kb: 16,
    avg_active_seqs: 256,
    // parallel
    TP: 8,
    PP: 1,
    EP: 4,
    CP: 1,
    // SLO targets — inputs to the constraints panel + envelope hint
    slo_ttft_p99_ms: 300,
    slo_tpot_ms: 50,
  });

  const parallelCapacity = form.TP * form.PP * form.EP * form.CP;
  const workingSetGb = form.avg_active_seqs * form.kv_size_gb_per_seq;

  const constraintForm: any = {
    ...form,
    gpu_model: cluster.gpu_model,
    gpu_count: cluster.gpu_count,
    pue: cluster.pue,
    electricity_usd_per_kwh: cluster.electricity_usd_per_kwh,
  };
  const constraints = checkInference(constraintForm);
  const overSubscribed = hasErrors(constraints);

  // Engine selector — only show engines whose envelope includes "inference"
  // mode. Today that's just `surrogate-analytical`; astra-sim is training-only.
  const engineList = useEngines({ status: "active" });
  const inferenceEngines = useMemo(() => {
    return (engineList.data ?? []).filter((e) =>
      e.coverage_envelope?.modes?.includes("inference"),
    );
  }, [engineList.data]);
  const [engineName, setEngineName] = useState<string>("");
  useEffect(() => {
    if (inferenceEngines.length > 0 && !engineName) {
      setEngineName(inferenceEngines[0].name);
    }
  }, [inferenceEngines, engineName]);

  const currentCfg: CurrentConfig = {
    TP: form.TP, PP: form.PP, EP: form.EP, CP: form.CP,
    // Defaults — surrogate accepts any of these; envelope will pass.
    recompute: "selective", overlap: "ZBv2",
    quant: form.quant,
    workload_family: "transformer-moe",
    gpu_model: cluster.gpu_model, gpu_count: cluster.gpu_count,
  };

  const ready = !!(hwspec.data && model.data && cluster.gpu_count > 0);

  const onSubmit = async () => {
    if (!ready) {
      pushToast("基础 spec 还在加载或集群无 GPU，请稍候…", "warn");
      return;
    }
    if (overSubscribed) {
      pushToast("配置存在阻塞性问题，请先处理", "err");
      return;
    }
    try {
      const run = await create.mutateAsync({
        kind: "infer",
        title: form.title,
        hwspec_hash: hwspec.data!.version.hash,
        model_hash: model.data!.version.hash,
        cluster_override: {
          gpu_model: cluster.gpu_model,
          gpu_count: cluster.gpu_count,
          electricity_usd_per_kwh: cluster.electricity_usd_per_kwh,
          pue: cluster.pue,
        },
        workload_override: {
          mode: "inference",
          seq_len: form.seq_len,
          activated_params_b: form.activated_params_b,
          total_params_b: form.total_params_b,
          quant: form.quant,
          kvcache_config: {
            kv_size_gb_per_seq: form.kv_size_gb_per_seq,
            prefix_share_ratio: form.prefix_share_ratio,
            page_size_kb: form.page_size_kb,
            avg_active_seqs: form.avg_active_seqs,
          },
        },
        strategy_override: {
          TP: form.TP, PP: form.PP, EP: form.EP, CP: form.CP,
          recompute: "selective", overlap: "ZBv2",
        },
        ...(engineName ? { engine_preference: engineName } : {}),
      });
      rememberLastRun("infer", run.id);
      pushRecentRun({
        runId: run.id, kind: "infer", title: form.title, hwspecId,
      });
      pushToast(`已提交 ${run.id} · 进度面板已展开`, "ok");
      setSubmittedRunId(run.id);
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    } catch (e) {
      pushToast("提交失败：" + String(e), "err");
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg-3)",
    border: "1px solid var(--hairline)",
    borderRadius: "var(--r-sm)",
    color: "var(--t1)",
    padding: "5px 8px",
    fontSize: 12,
  };

  return (
    <>
      <div className="page-hd">
        <div>
          <h1 className="page-ttl">推理仿真</h1>
        </div>
      </div>

      {/* Sticky topbar — name + preset actions + submit, all on one row */}
      <div
        style={{
          position: "sticky", top: 0, zIndex: 100,
          marginBottom: 14,
          padding: "10px 14px",
          background: "var(--bg-2)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--r-md)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          backdropFilter: "blur(6px)",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--t2)", flexShrink: 0 }}>名称</span>
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="本次推理仿真名称"
          style={{ ...inputStyle, flex: "1 1 360px", minWidth: 280, padding: "7px 10px", fontSize: 13 }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
          <PresetActionsRow<InferencePresetForm>
            kind="infer"
            currentForm={{
              ...form,
              gpu_model: cluster.gpu_model,
              gpu_count: cluster.gpu_count,
              pue: cluster.pue,
              electricity_usd_per_kwh: cluster.electricity_usd_per_kwh,
            } as any}
            onApply={(p, meta) => setForm({ ...form, ...p, title: meta?.name ?? p.title ?? form.title })}
            onChange={() => setPresetsVersion((v) => v + 1)}
          />
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={create.isPending || !ready || overSubscribed}
            style={{ fontSize: 13, padding: "7px 18px", flexShrink: 0 }}
          >
            {create.isPending ? "提交中…" : "▶ 启动推理仿真"}
          </button>
        </div>
      </div>

      {submittedRunId && (
        <ProgressStrip
          runId={submittedRunId}
          onDismiss={() => setSubmittedRunId(null)}
        />
      )}

      <PresetSelector<InferencePresetForm>
        presets={presets}
        onApply={(p, meta) => setForm({ ...form, ...p, title: meta?.name ?? p.title ?? form.title })}
        kind="infer"
        currentForm={{
          ...form,
          gpu_model: cluster.gpu_model,
          gpu_count: cluster.gpu_count,
          pue: cluster.pue,
          electricity_usd_per_kwh: cluster.electricity_usd_per_kwh,
        } as any}
        hideActions
        presetsVersion={presetsVersion}
      />

      {/* Two-column main area */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
        gap: 14,
        alignItems: "start",
      }}>
        {/* ── Left: configuration ─────────────────────────────── */}
        <div>
          {/* Cluster picker + summary + thumbnail */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div className="card-t">集群配置</div>
              <span style={{ fontSize: 10.5, color: "var(--t3)" }}>
                来自集群配置 · 修改请到「集群配置」页
              </span>
            </div>
            <FieldLabel>选择集群</FieldLabel>
            <select
              value={clusterId}
              onChange={(e) => setClusterId(e.target.value)}
              style={inputStyle}
              disabled={availableClusters.length === 0}
            >
              {availableClusters.length === 0 && (
                <option value="">— 集群配置中尚无集群 —</option>
              )}
              {availableClusters.map((c) => (
                <option key={c.id} value={c.id}>{c.id} · {c.name}</option>
              ))}
            </select>
            <div className="mono" style={{
              marginTop: 10, padding: "8px 12px", borderRadius: "var(--r-sm)",
              background: "var(--surface-2)", color: "var(--t2)", fontSize: 11.5,
              lineHeight: 1.65,
            }}>
              <div>
                <strong>{cluster.gpu_count}× {cluster.gpu_model}</strong>
                {" · "}{cluster.total_servers} 服务器
                {" · "}{cluster.total_racks} 机柜
                {cluster.cluster_purpose && <> {" · "}{cluster.cluster_purpose}</>}
                {" · "}PUE {cluster.pue.toFixed(2)}
              </div>
              {cluster.fabric_kind && (
                <div style={{ color: "var(--t3)" }}>
                  Scale-out · {cluster.fabric_kind} · {cluster.fabric_topology}
                </div>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <TopologyThumbnail
                hwspecId={hwspecId}
                clusterId={clusterId || undefined}
                runId={readLastRun("infer")?.runId}
              />
            </div>
          </div>

          {/* Model + workload */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><div className="card-t">模型配置</div></div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 10,
            }}>
              <div>
                <FieldLabel>激活参数 (B) · MoE 仅算激活专家</FieldLabel>
                <input type="number" min={1} value={form.activated_params_b}
                  onChange={(e) => setForm({ ...form, activated_params_b: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div>
                <FieldLabel>总参数 (B)</FieldLabel>
                <input type="number" min={1} value={form.total_params_b}
                  onChange={(e) => setForm({ ...form, total_params_b: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div>
                <FieldLabel>上下文长度</FieldLabel>
                <input type="number" min={512} step={512} value={form.seq_len}
                  onChange={(e) => setForm({ ...form, seq_len: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
            </div>
            <FieldLabel>量化</FieldLabel>
            <ChipRow value={form.quant} options={QUANT_CHOICES}
              onChange={(v) => setForm({ ...form, quant: v })} />
          </div>

          {/* KV cache */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div className="card-t">KV Cache</div>
              <span className="tag tag-teal" style={{ fontSize: 10 }}>
                工作集 ≈ {workingSetGb.toFixed(1)} GB
              </span>
            </div>
            <KvFootprintBar
              gpu_model={cluster.gpu_model}
              gpu_count={cluster.gpu_count}
              avg_active_seqs={form.avg_active_seqs}
              kv_size_gb_per_seq={form.kv_size_gb_per_seq}
            />
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 10, marginTop: 10,
            }}>
              <div>
                <FieldLabel>单 seq KV (GB)</FieldLabel>
                <input type="number" step={0.001} min={0} value={form.kv_size_gb_per_seq}
                  onChange={(e) => setForm({ ...form, kv_size_gb_per_seq: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div>
                <FieldLabel>Prefix 共享率 (0–1)</FieldLabel>
                <input type="number" step={0.05} min={0} max={1} value={form.prefix_share_ratio}
                  onChange={(e) => setForm({ ...form, prefix_share_ratio: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div>
                <FieldLabel>Paged 块 (KB)</FieldLabel>
                <input type="number" step={4} min={4} value={form.page_size_kb}
                  onChange={(e) => setForm({ ...form, page_size_kb: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div>
                <FieldLabel>平均活跃 seq</FieldLabel>
                <input type="number" step={16} min={1} value={form.avg_active_seqs}
                  onChange={(e) => setForm({ ...form, avg_active_seqs: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
            </div>
          </div>

          {/* Parallel strategy */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div className="card-t">并行策略</div>
              <span style={{ fontSize: 10.5, color: "var(--t3)" }}>
                TP×PP×EP×CP = {parallelCapacity}
              </span>
            </div>

            <div style={{
              display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10,
            }}>
              <div>
                <FieldLabel>TP（张量并行）</FieldLabel>
                <ChipRow value={form.TP} options={TP_CHOICES}
                  onChange={(v) => setForm({ ...form, TP: v })} />
              </div>
              <div>
                <FieldLabel>PP（流水并行 · 推理通常 1）</FieldLabel>
                <ChipRow value={form.PP} options={PP_CHOICES}
                  onChange={(v) => setForm({ ...form, PP: v })} />
              </div>
              <div>
                <FieldLabel>EP（专家并行 · MoE ≥ 2）</FieldLabel>
                <ChipRow value={form.EP} options={EP_CHOICES}
                  onChange={(v) => setForm({ ...form, EP: v })} />
              </div>
              <div>
                <FieldLabel>CP（上下文并行）</FieldLabel>
                <ChipRow value={form.CP} options={CP_CHOICES}
                  onChange={(v) => setForm({ ...form, CP: v })} />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <ParallelismDiagram
                TP={form.TP} PP={form.PP} EP={form.EP} CP={form.CP}
                gpu_count={cluster.gpu_count}
              />
            </div>
          </div>

          {/* SLO targets */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head"><div className="card-t">SLO 目标</div></div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 10,
            }}>
              <div>
                <FieldLabel>TTFT p99 (ms) · surrogate 硬上限 300</FieldLabel>
                <input type="number" step={10} min={50} value={form.slo_ttft_p99_ms}
                  onChange={(e) => setForm({ ...form, slo_ttft_p99_ms: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div>
                <FieldLabel>TPOT (ms)</FieldLabel>
                <input type="number" step={5} min={5} value={form.slo_tpot_ms}
                  onChange={(e) => setForm({ ...form, slo_tpot_ms: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Right: live insights (sticky) ───────────────────── */}
        <div style={{ position: "sticky", top: 88, alignSelf: "start" }}>
          <EngineCheckCard
            engines={inferenceEngines}
            selectedName={engineName}
            onSelect={setEngineName}
            cfg={currentCfg}
          />
          <GpuUtilDonut used={parallelCapacity} total={cluster.gpu_count} />

          <LivePredictCard
            enabled={ready && !overSubscribed}
            payload={{
              cluster: {
                gpu_model: cluster.gpu_model,
                gpu_count: cluster.gpu_count,
                electricity_usd_per_kwh: cluster.electricity_usd_per_kwh,
                pue: cluster.pue,
              },
              workload: {
                mode: "inference",
                seq_len: form.seq_len,
                activated_params_b: form.activated_params_b,
                total_params_b: form.total_params_b,
                quant: form.quant,
                workload_family: "transformer-moe",
                kvcache_config: {
                  kv_size_gb_per_seq: form.kv_size_gb_per_seq,
                  prefix_share_ratio: form.prefix_share_ratio,
                  page_size_kb: form.page_size_kb,
                  avg_active_seqs: form.avg_active_seqs,
                },
              },
              strategy: {
                TP: form.TP, PP: form.PP, EP: form.EP, CP: form.CP,
                recompute: "selective", overlap: "ZBv2",
              },
            } satisfies LivePredictPayload}
          />

          <ConstraintsPanel
            constraints={constraints}
            onFix={(patch) => setForm({ ...form, ...(patch as any) })}
          />

          <LastRunPanel kind="infer" />
        </div>
      </div>
    </>
  );
}
