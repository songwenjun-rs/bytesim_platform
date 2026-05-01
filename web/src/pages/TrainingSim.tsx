/**
 * 训练仿真 — Plan A layout: sticky topbar + 2-column (config / live insights).
 *
 * Cluster info is read-only here (configure in 集群配置 page).
 * Right column updates as user edits left column.
 * Submit → POST /v1/runs → navigate to /sim/reports/:id (RunDetail shows progress + result).
 */
import { useEffect, useMemo, useState } from "react";
import { useCreateRun } from "../api/runs";
import { useEngines } from "../api/engines";
import { useSpecLatest, useSpecList } from "../api/specs";
import { pushToast } from "../components/shell/Toast";
import { LastRunPanel, rememberLastRun, readLastRun } from "../components/sim/LastRunPanel";
import { pushRecentRun } from "../components/sim/recentRuns";
import { PresetSelector, PresetActionsRow } from "../components/sim/PresetSelector";
import { type TrainingPresetForm } from "../components/sim/presets";
import { useCatalogItems } from "../api/catalogItems";
import { TopologyThumbnail } from "../components/sim/TopologyThumbnail";
import { ConstraintsPanel } from "../components/sim/ConstraintsPanel";
import { checkTraining, hasErrors } from "../components/sim/constraints";
import { LivePredictCard } from "../components/sim/LivePredictCard";
import type { LivePredictPayload } from "../api/livePredict";
import { ParallelismDiagram } from "../components/sim/ParallelismDiagram";
import {
  ChipRow, FieldLabel, ProgressStrip, EngineCheckCard, GpuUtilDonut,
  summarizeHwSpec, type CurrentConfig,
} from "../components/sim/insights";

const QUANT_CHOICES = ["FP8", "BF16"] as const;
const RECOMPUTE_CHOICES = ["selective", "full"] as const;
const OVERLAP_CHOICES = ["1F1B", "ZB", "ZBv2", "ring_compress", "Chimera"] as const;
const TP_CHOICES = [1, 2, 4, 8, 16, 32];
const PP_CHOICES = [1, 2, 4, 8, 16];
const EP_CHOICES = [1, 2, 4, 8];
const CP_CHOICES = [1, 2, 4];

// ── Main page ───────────────────────────────────────────────────────────────

export function TrainingSim() {
  const create = useCreateRun();
  // Presets — bs_catalog kind=train_preset. Each row.body is the form payload.
  const presetsQuery = useCatalogItems<TrainingPresetForm>("train_preset");
  const presets = (presetsQuery.data ?? []).map((it) => ({
    id: it.id, name: it.name,
    desc: (it.body as any).desc ?? "", form: it.body,
  }));
  const [submittedRunId, setSubmittedRunId] = useState<string | null>(null);
  // Bumped after PresetActionsRow saves/imports — propagated to PresetSelector
  // so the dropdown re-reads the localStorage custom-preset list.
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

  // Cluster picker — replaces the old hwspec picker. The dropdown lists
  // each cluster configured in the loaded hwspec body (1:1 with what the
  // 集群配置 page shows). Simulation is scoped to the selected cluster.
  const availableClusters = hwspec.data?.version.body.datacenter?.clusters ?? [];
  const [clusterId, setClusterId] = useState<string>("");
  useEffect(() => {
    if (availableClusters.length === 0) return;
    const exists = availableClusters.some((c) => c.id === clusterId);
    if (!exists) setClusterId(availableClusters[0].id);
  }, [availableClusters, clusterId]);

  const cluster = useMemo(
    () => summarizeHwSpec(hwspec.data?.version.body, clusterId || null),
    [hwspec.data, clusterId],
  );

  const [form, setForm] = useState({
    title: "",
    activated_params_b: 405,
    total_params_b: 405,
    seq_len: 8192,
    global_batch: 4096,
    quant: "FP8" as (typeof QUANT_CHOICES)[number],
    TP: 8,
    PP: 8,
    EP: 1,
    CP: 1,
    recompute: "selective" as (typeof RECOMPUTE_CHOICES)[number],
    overlap: "1F1B" as (typeof OVERLAP_CHOICES)[number],
  });

  const parallelCapacity = form.TP * form.PP * form.EP * form.CP;

  const constraintForm: any = {
    ...form,
    gpu_model: cluster.gpu_model,
    gpu_count: cluster.gpu_count,
    pue: cluster.pue,
    electricity_usd_per_kwh: cluster.electricity_usd_per_kwh,
  };
  const constraints = checkTraining(constraintForm);
  const overSubscribed = hasErrors(constraints);

  // Engines list (active only) for the selector card on the right.
  const engineList = useEngines({ status: "active" });
  const [engineName, setEngineName] = useState<string>("");
  useEffect(() => {
    if (engineList.data && engineList.data.length > 0 && !engineName) {
      // Default to the highest-fidelity engine (cycle-accurate first).
      const sorted = [...engineList.data].sort((a, b) => {
        const rank: Record<string, number> = {
          "cycle-accurate": 3, "hybrid": 2, "analytical": 1,
        };
        return (rank[b.fidelity] ?? 0) - (rank[a.fidelity] ?? 0);
      });
      setEngineName(sorted[0].name);
    }
  }, [engineList.data, engineName]);

  const currentCfg: CurrentConfig = {
    TP: form.TP, PP: form.PP, EP: form.EP, CP: form.CP,
    recompute: form.recompute, overlap: form.overlap,
    quant: form.quant,
    workload_family: "transformer-dense",
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
        kind: "train",
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
          mode: "training",
          seq_len: form.seq_len,
          global_batch: form.global_batch,
          activated_params_b: form.activated_params_b,
          total_params_b: form.total_params_b,
          quant: form.quant,
        },
        strategy_override: {
          TP: form.TP, PP: form.PP, EP: form.EP, CP: form.CP,
          recompute: form.recompute, overlap: form.overlap,
        },
        // Pin the engine the architect picked in the right-side selector
        // — pipeline forwards this to engine-registry on every predict.
        ...(engineName ? { engine_preference: engineName } : {}),
      });
      rememberLastRun("train", run.id);
      pushRecentRun({
        runId: run.id, kind: "train", title: form.title, hwspecId,
      });
      pushToast(`已提交 ${run.id} · 进度面板已展开`, "ok");
      setSubmittedRunId(run.id);
      // Smooth-scroll to the top so the just-inserted progress panel is in view.
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
          <h1 className="page-ttl">训练仿真</h1>
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
          placeholder="本次训练仿真名称"
          style={{ ...inputStyle, flex: "1 1 360px", minWidth: 280, padding: "7px 10px", fontSize: 13 }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
          <PresetActionsRow<TrainingPresetForm>
            kind="train"
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
            {create.isPending ? "提交中…" : "▶ 启动训练仿真"}
          </button>
        </div>
      </div>

      {/* Slim progress strip — single thin bar + tiny status text. Full
       *  KPI / phase analysis lives on /sim/reports/:id (link in the strip). */}
      {submittedRunId && (
        <ProgressStrip
          runId={submittedRunId}
          onDismiss={() => setSubmittedRunId(null)}
        />
      )}

      {/* Preset row — actions buttons live in the topbar above (hideActions). */}
      <PresetSelector<TrainingPresetForm>
        presets={presets}
        onApply={(p, meta) => setForm({ ...form, ...p, title: meta?.name ?? p.title ?? form.title })}
        kind="train"
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
        {/* ── Left column: configuration ─────────────────────────────── */}
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
                runId={readLastRun("train")?.runId}
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
                <FieldLabel>激活参数 (B)</FieldLabel>
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
                <FieldLabel>序列长度</FieldLabel>
                <input type="number" min={512} step={512} value={form.seq_len}
                  onChange={(e) => setForm({ ...form, seq_len: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
              <div>
                <FieldLabel>Global Batch</FieldLabel>
                <input type="number" min={1} step={64} value={form.global_batch}
                  onChange={(e) => setForm({ ...form, global_batch: Number(e.target.value) })}
                  style={inputStyle} />
              </div>
            </div>
            <FieldLabel>量化</FieldLabel>
            <ChipRow value={form.quant} options={QUANT_CHOICES}
              onChange={(v) => setForm({ ...form, quant: v })} />
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
                <FieldLabel>PP（流水并行）</FieldLabel>
                <ChipRow value={form.PP} options={PP_CHOICES}
                  onChange={(v) => setForm({ ...form, PP: v })} />
              </div>
              <div>
                <FieldLabel>EP（专家并行 · dense 用 1）</FieldLabel>
                <ChipRow value={form.EP} options={EP_CHOICES}
                  onChange={(v) => setForm({ ...form, EP: v })} />
              </div>
              <div>
                <FieldLabel>CP（上下文并行）</FieldLabel>
                <ChipRow value={form.CP} options={CP_CHOICES}
                  onChange={(v) => setForm({ ...form, CP: v })} />
              </div>
              <div>
                <FieldLabel>Recompute</FieldLabel>
                <ChipRow value={form.recompute} options={RECOMPUTE_CHOICES}
                  onChange={(v) => setForm({ ...form, recompute: v })} />
              </div>
              <div>
                <FieldLabel>Overlap</FieldLabel>
                <ChipRow value={form.overlap} options={OVERLAP_CHOICES}
                  onChange={(v) => setForm({ ...form, overlap: v })} />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <ParallelismDiagram
                TP={form.TP} PP={form.PP} EP={form.EP} CP={form.CP}
                gpu_count={cluster.gpu_count}
              />
            </div>
          </div>
        </div>

        {/* ── Right column: live insights (sticky) ───────────────────── */}
        <div style={{ position: "sticky", top: 88, alignSelf: "start" }}>
          <EngineCheckCard
            engines={engineList.data ?? []}
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
                mode: "training",
                seq_len: form.seq_len,
                global_batch: form.global_batch,
                activated_params_b: form.activated_params_b,
                total_params_b: form.total_params_b,
                quant: form.quant,
                workload_family: "transformer-dense",
              },
              strategy: {
                TP: form.TP, PP: form.PP, EP: form.EP, CP: form.CP,
                recompute: form.recompute, overlap: form.overlap,
              },
            } satisfies LivePredictPayload}
          />

          <ConstraintsPanel
            constraints={constraints}
            onFix={(patch) => setForm({ ...form, ...(patch as any) })}
          />

          <LastRunPanel kind="train" />
        </div>
      </div>
    </>
  );
}
