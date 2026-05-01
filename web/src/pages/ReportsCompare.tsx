/**
 * 仿真报告 · 多份对比 — 统一对比页（替代旧 /comparator）。
 *
 * 入口：/sim/reports 勾选 ≥2 份 → /sim/reports/compare?ids=id1,id2,...
 *
 * 三个 section：
 *   1. 仿真结果        —— KPI 表 + 雷达图 + 阶段分解条
 *   2. 集群方案 & 成本 —— 集群规格表 + 成本/功率 bar 对比
 *   3. 模型 & 并行策略 —— 模型规格表 + 并行布局可视化（ParallelismDiagram）
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useRunFull, type Run, type SpecRef } from "../api/runs";
import { RadarChart } from "../components/comparator/RadarChart";
import { ParallelismDiagram } from "../components/sim/ParallelismDiagram";
import type { HwSpecBody } from "../api/specs";

type PlanSlot = {
  slot: string;
  run_id: string;
  added_at: string;
  run?: Run;
};

const SLOT_COLORS = [
  "#7ab8ff", "#ffb854", "#7cdf90", "#d49bf7",
  "#8fe1ff", "#ff7a70",
];

// ── shared helpers ─────────────────────────────────────────────────────────

type Field = {
  key: string;
  label: string;
  /** max=越大越好；min=越小越好。 */
  dir: "max" | "min";
  fmt: (v: number) => string;
  /** 自定义提取器，默认 kpis[key]. */
  pick?: (r: Run) => number | undefined;
};

const KPI_FIELDS: Field[] = [
  { key: "mfu_pct",         label: "MFU",          dir: "max", fmt: (v) => `${v.toFixed(1)}%` },
  { key: "step_ms",         label: "单步耗时",     dir: "min", fmt: (v) => `${(v / 1000).toFixed(2)}s` },
  { key: "ttft_p99_ms",     label: "TTFT p99",     dir: "min", fmt: (v) => `${v.toFixed(0)} ms` },
  { key: "tpot_ms",         label: "TPOT",         dir: "min", fmt: (v) => `${v.toFixed(1)} ms` },
  { key: "train_days",      label: "训练天数",     dir: "min", fmt: (v) => `${v.toFixed(1)} 天` },
  { key: "wallclock_s",     label: "仿真 wallclock", dir: "min", fmt: (v) => `${v.toFixed(1)} s` },
  {
    key: "_confidence", label: "置信度", dir: "max", fmt: (v) => v.toFixed(2),
    pick: (r) => (typeof r.confidence === "number" ? r.confidence : undefined),
  },
];

const COST_FIELDS: Field[] = [
  { key: "peak_kw",              label: "峰值功率",      dir: "min", fmt: (v) => `${v.toFixed(0)} kW` },
  { key: "cost_per_m_tok_usd",   label: "成本 / Mtok",   dir: "min", fmt: (v) => `$${v.toFixed(2)}` },
  { key: "five_year_opex_musd",  label: "5 年 OPEX",     dir: "min", fmt: (v) => `$${v.toFixed(1)}M` },
];

function getValue(run: Run | undefined, f: Field): number | undefined {
  if (!run) return undefined;
  if (f.pick) return f.pick(run);
  const v = (run.kpis ?? {})[f.key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bestIdx(values: (number | undefined)[], dir: "max" | "min"): number | null {
  let best: number | null = null;
  let bestVal: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (bestVal == null || (dir === "max" ? v > bestVal : v < bestVal)) {
      bestVal = v; best = i;
    }
  }
  return best;
}

function summarizeCluster(body: HwSpecBody | undefined, scopedClusterId: string | null) {
  const allClusters = body?.datacenter?.clusters ?? [];
  const scoped = scopedClusterId
    ? allClusters.filter((c) => c.id === scopedClusterId)
    : allClusters;
  const racks = scoped.flatMap((c) => c.racks);
  const servers = racks.flatMap((r) => r.servers);
  const gpuServers = servers.filter((s) => (s.gpu_count ?? 0) > 0);
  const tally = new Map<string, number>();
  for (const s of gpuServers) tally.set(s.gpu_model, (tally.get(s.gpu_model) ?? 0) + s.gpu_count);
  let gpu_model: string | null = null; let best = -1;
  for (const [m, n] of tally) if (n > best) { gpu_model = m; best = n; }
  const fab = body?.datacenter?.scale_out_fabrics?.[0] ?? null;
  const c0 = scoped[0] ?? null;
  return {
    cluster_id: c0?.id ?? null,
    cluster_name: c0?.name ?? null,
    cluster_purpose: c0?.purpose ?? null,
    gpu_model,
    gpu_count: gpuServers.reduce((a, s) => a + s.gpu_count, 0),
    total_servers: servers.length,
    total_racks: racks.length,
    fabric_kind: fab?.kind ?? null,
    fabric_topology: fab?.topology ?? null,
    pue: c0?.pue ?? body?.power?.pue ?? null,
  };
}

function provLine(run: Run | undefined): string {
  if (!run) return "—";
  const prov = (run.kpis ?? ({} as any))._engine_provenance as
    { engine?: string; fidelity?: string; version?: string } | undefined;
  if (!prov || typeof prov !== "object") return "—";
  return [prov.engine, prov.fidelity, prov.version].filter(Boolean).join(" · ");
}

// ── main ───────────────────────────────────────────────────────────────────

export function ReportsCompare() {
  const [params] = useSearchParams();
  const ids = useMemo(() =>
    (params.get("ids") ?? "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 6),
    [params],
  );

  // Up to 6 parallel fetches (useRunFull is gated by id).
  const r0 = useRunFull(ids[0] ?? "", { enabled: !!ids[0] });
  const r1 = useRunFull(ids[1] ?? "", { enabled: !!ids[1] });
  const r2 = useRunFull(ids[2] ?? "", { enabled: !!ids[2] });
  const r3 = useRunFull(ids[3] ?? "", { enabled: !!ids[3] });
  const r4 = useRunFull(ids[4] ?? "", { enabled: !!ids[4] });
  const r5 = useRunFull(ids[5] ?? "", { enabled: !!ids[5] });
  const fulls = [r0, r1, r2, r3, r4, r5].slice(0, ids.length);
  const runs = fulls.map((q) => q.data?.run);
  const specs = fulls.map((q) => q.data?.specs ?? []);
  const loading = fulls.some((q) => q.isLoading);

  // PlanSlot wrapper for the (kept) RadarChart. Maps run → slot{ A, B, C, ... }.
  const slots: PlanSlot[] = useMemo(() =>
    runs.map((r, i) => ({
      slot: String.fromCharCode(65 + i),
      run_id: ids[i],
      added_at: r?.created_at ?? "",
      run: r,
    })),
    [runs, ids],
  );

  if (ids.length < 2) {
    return (
      <>
        <BackBar />
        <div className="card boundary-warn">
          至少选择 2 份报告才能对比。<Link to="/sim/reports" style={{ marginLeft: 8 }}>返回列表 →</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <BackBar />
      <div className="page-hd">
        <h1 className="page-ttl">仿真报告对比 · {ids.length} 份</h1>
      </div>

      {loading && (
        <div className="card" style={{ marginBottom: 14, color: "var(--t3)", fontSize: 12 }}>
          加载中…
        </div>
      )}

      {/* Identity strip */}
      <IdentityStrip ids={ids} runs={runs} />

      {/* ─── Section 1: 仿真结果 ─── */}
      <SectionTitle index="1" title="仿真结果" subtitle="KPI 对比 / 雷达 / 阶段分解" />
      <div className="grid g2-3" style={{ gap: 14, marginBottom: 14, alignItems: "start" }}>
        <ComparisonTable ids={ids} runs={runs} fields={KPI_FIELDS} />
        <RadarChart slots={slots} recommendedRunId={null} />
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><div className="card-t">阶段分解</div></div>
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(ids.length, 3)}, 1fr)`,
          gap: 14,
        }}>
          {runs.map((r, i) => (
            <PhaseBars key={ids[i]} runId={ids[i]} colorIdx={i} run={r} />
          ))}
        </div>
      </div>

      {/* ─── Section 2: 集群方案 & 成本 ─── */}
      <SectionTitle index="2" title="集群方案 & 成本" subtitle="硬件规格 + 功率 / OPEX 对比" />
      <ClusterSpecGrid ids={ids} runs={runs} specs={specs} />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><div className="card-t">成本与功率</div></div>
        <ComparisonTable ids={ids} runs={runs} fields={COST_FIELDS} embedded />
        <CostBars runs={runs} />
      </div>

      {/* ─── Section 3: 模型 & 并行策略 ─── */}
      <SectionTitle index="3" title="模型 & 并行策略" subtitle="模型规格 + 并行布局可视化" />
      <ModelSpecGrid ids={ids} runs={runs} specs={specs} />
      <div className="card">
        <div className="card-head"><div className="card-t">并行策略可视化</div></div>
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(ids.length, 3)}, 1fr)`,
          gap: 18, marginTop: 8,
        }}>
          {runs.map((r, i) => (
            <StrategyCard key={ids[i]} colorIdx={i} runId={ids[i]} run={r} />
          ))}
        </div>
      </div>
    </>
  );
}

// ── sub-components ─────────────────────────────────────────────────────────

function BackBar() {
  return (
    <div style={{ marginBottom: 10 }}>
      <Link
        to="/sim/reports"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "6px 12px", borderRadius: "var(--r-sm)",
          background: "var(--surface-2)", border: "1px solid var(--hairline)",
          color: "var(--t2)", fontSize: 12, textDecoration: "none",
        }}
      >
        ← 返回仿真报告
      </Link>
    </div>
  );
}

function SectionTitle({ index, title, subtitle }: { index: string; title: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "20px 0 10px" }}>
      <span style={{
        display: "inline-block", width: 22, height: 22, borderRadius: 4,
        background: "var(--blue)", color: "var(--t1)",
        fontSize: 12, fontWeight: 700, textAlign: "center", lineHeight: "22px",
      }}>{index}</span>
      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--t1)" }}>{title}</span>
      <span style={{ fontSize: 11.5, color: "var(--t3)" }}>{subtitle}</span>
    </div>
  );
}

function IdentityStrip({ ids, runs }: { ids: string[]; runs: (Run | undefined)[] }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${Math.min(ids.length, 3)}, 1fr)`,
      gap: 12, marginBottom: 14,
    }}>
      {runs.map((r, i) => (
        <div key={ids[i]} className="card" style={{
          padding: "12px 14px",
          borderTop: `3px solid ${SLOT_COLORS[i]}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{
              width: 22, height: 22, borderRadius: 11, background: SLOT_COLORS[i],
              color: "#000", fontSize: 11, fontWeight: 700, textAlign: "center", lineHeight: "22px",
            }}>{String.fromCharCode(65 + i)}</span>
            <Link to={`/sim/reports/${ids[i]}`} className="mono" style={{ fontSize: 12, color: "var(--blue)" }}>
              {ids[i]}
            </Link>
            {r?.status && (
              <span className={`tag ${
                r.status === "done" ? "tag-green" :
                r.status === "failed" ? "tag-red" :
                r.status === "running" ? "tag-teal" : "tag-orange"
              }`} style={{ fontSize: 10 }}>{r.status}</span>
            )}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", marginBottom: 4 }}>
            {r?.title ?? "—"}
          </div>
          <div style={{ fontSize: 11, color: "var(--t3)" }}>
            <div>引擎 {provLine(r)}</div>
            <div style={{ marginTop: 2 }}>{r?.created_at?.slice(0, 19).replace("T", " ") ?? ""}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ComparisonTable({
  ids, runs, fields, embedded = false,
}: {
  ids: string[];
  runs: (Run | undefined)[];
  fields: Field[];
  embedded?: boolean;
}) {
  const inner = (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ background: "var(--surface-2)", color: "var(--t3)", fontSize: 11 }}>
          <th style={{ ...thStyle, minWidth: 110 }}>对比项</th>
          {ids.map((id, i) => (
            <th key={id} style={{ ...thStyle, minWidth: 130 }}>
              <span style={{
                display: "inline-block", width: 8, height: 8, borderRadius: 2,
                background: SLOT_COLORS[i], marginRight: 5, verticalAlign: "middle",
              }} />
              {String.fromCharCode(65 + i)} · <span className="mono">{id}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => {
          const vals = runs.map((r) => getValue(r, f));
          const best = bestIdx(vals, f.dir);
          if (vals.every((v) => v == null)) return null;
          return (
            <tr key={f.key} style={{ borderTop: "1px solid var(--hairline)" }}>
              <td style={{ ...tdStyle, color: "var(--t3)" }}>{f.label}</td>
              {vals.map((v, i) => {
                const isBest = i === best && vals.filter((x) => x != null).length > 1;
                const baseVal = best != null ? vals[best] : undefined;
                let delta = "";
                if (v != null && baseVal != null && i !== best) {
                  const pct = ((v - baseVal) / baseVal) * 100;
                  delta = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
                }
                return (
                  <td key={i} style={{
                    ...tdStyle, fontFamily: "var(--mono)",
                    color: isBest ? "var(--green)" : "var(--t1)",
                    fontWeight: isBest ? 700 : 400,
                  }}>
                    {v != null ? f.fmt(v) : <span style={{ color: "var(--t3)" }}>—</span>}
                    {delta && (
                      <span style={{ marginLeft: 8, color: "var(--t3)", fontSize: 10.5, fontWeight: 400 }}>
                        {delta}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  if (embedded) return inner;
  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <div className="card-head" style={{ padding: "10px 14px" }}>
        <div className="card-t">仿真 KPI</div>
      </div>
      {inner}
    </div>
  );
}

function PhaseBars({
  runId, run, colorIdx,
}: { runId: string; run: Run | undefined; colorIdx: number }) {
  const phases = (run?.kpis?.phase_breakdown as unknown as { phase: string; ms: number }[] | undefined) ?? [];
  const total = phases.reduce((a, p) => a + p.ms, 0);
  const COLORS: Record<string, string> = {
    compute: "var(--blue)", comm: "var(--orange)",
    mem_stall: "var(--red)", idle: "var(--teal)",
  };
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--t3)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 2, background: SLOT_COLORS[colorIdx],
        }}/>
        <span className="mono">{runId}</span>
      </div>
      {phases.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--t3)" }}>无阶段数据</div>
      ) : (
        <>
          <div style={{ display: "flex", height: 16, borderRadius: 3, overflow: "hidden", marginBottom: 6 }}>
            {phases.map((p) => (
              <div key={p.phase} style={{
                width: `${(p.ms / total) * 100}%`,
                background: COLORS[p.phase] ?? "var(--t3)",
              }} title={`${p.phase}: ${(p.ms/1000).toFixed(2)}s`} />
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--t3)", display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
            {phases.map((p) => (
              <span key={p.phase}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: 2,
                  background: COLORS[p.phase] ?? "var(--t3)", marginRight: 4,
                }} />
                {p.phase} {((p.ms / total) * 100).toFixed(0)}%
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ClusterSpecGrid({
  ids, runs, specs,
}: {
  ids: string[];
  runs: (Run | undefined)[];
  specs: SpecRef[][];
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${Math.min(ids.length, 3)}, 1fr)`,
      gap: 12, marginBottom: 14,
    }}>
      {runs.map((r, i) => {
        const hwspec = specs[i].find((s) => s.kind === "hwspec");
        const body = hwspec?.body as HwSpecBody | undefined;
        const ovr = (r?.kpis ?? ({} as any))._cluster_override as
          { gpu_model?: string; gpu_count?: number; pue?: number; electricity_usd_per_kwh?: number } | undefined;
        // Try to scope summarizeCluster to the cluster the override matches
        // (by gpu_count). When ambiguous, fall back to the whole datacenter.
        const targetGpu = ovr?.gpu_count;
        let scopedId: string | null = null;
        if (targetGpu && body?.datacenter?.clusters) {
          for (const c of body.datacenter.clusters) {
            const n = c.racks.flatMap((rk) => rk.servers).reduce((a, s) => a + s.gpu_count, 0);
            if (n === targetGpu) { scopedId = c.id; break; }
          }
        }
        const sum = summarizeCluster(body, scopedId);
        const gpu_model = ovr?.gpu_model ?? sum.gpu_model ?? "—";
        const gpu_count = ovr?.gpu_count ?? sum.gpu_count ?? 0;
        const pue = ovr?.pue ?? sum.pue ?? null;
        const electricity = ovr?.electricity_usd_per_kwh ?? null;
        return (
          <div key={ids[i]} className="card" style={{ borderTop: `3px solid ${SLOT_COLORS[i]}` }}>
            <div className="card-head" style={{ marginBottom: 8 }}>
              <div className="card-t">{String.fromCharCode(65 + i)} · 集群规格</div>
              {sum.cluster_purpose && <span className="tag tag-blue" style={{ fontSize: 10 }}>{sum.cluster_purpose}</span>}
            </div>
            <KvTable rows={[
              ["集群", sum.cluster_id ? `${sum.cluster_id}${sum.cluster_name ? " · " + sum.cluster_name : ""}` : "—"],
              ["GPU", `${gpu_count}× ${gpu_model}`],
              ["服务器", String(sum.total_servers || "—")],
              ["机柜", String(sum.total_racks || "—")],
              ["Scale-out", sum.fabric_kind ? `${sum.fabric_kind} · ${sum.fabric_topology}` : "—"],
              ["PUE", pue != null ? pue.toFixed(2) : "—"],
              ["电价", electricity != null ? `$${electricity.toFixed(3)}/kWh` : "—"],
            ]}/>
          </div>
        );
      })}
    </div>
  );
}

function CostBars({ runs }: { runs: (Run | undefined)[] }) {
  // For each cost dimension, render a horizontal bar normalized to that
  // dimension's max across the slots. Bars labelled with formatted value.
  const dims = COST_FIELDS;
  return (
    <div style={{ marginTop: 12 }}>
      {dims.map((f) => {
        const vals = runs.map((r) => getValue(r, f));
        const max = Math.max(...vals.filter((v): v is number => v != null), 0);
        const bestI = bestIdx(vals, f.dir);
        if (max <= 0) return null;
        return (
          <div key={f.key} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: "var(--t3)", marginBottom: 4 }}>{f.label}</div>
            {vals.map((v, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "30px 1fr 80px", gap: 8,
                alignItems: "center", marginBottom: 3,
              }}>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--t3)" }}>
                  {String.fromCharCode(65 + i)}
                </span>
                <span style={{ height: 10, background: "var(--surface-2)", borderRadius: 2, position: "relative" }}>
                  <span style={{
                    position: "absolute", left: 0, top: 0, bottom: 0,
                    width: v != null ? `${(v / max) * 100}%` : 0,
                    background: i === bestI ? "var(--green)" : SLOT_COLORS[i],
                    borderRadius: 2,
                  }}/>
                </span>
                <span className="mono" style={{
                  fontSize: 11, textAlign: "right",
                  color: i === bestI ? "var(--green)" : "var(--t1)",
                  fontWeight: i === bestI ? 700 : 400,
                }}>
                  {v != null ? f.fmt(v) : "—"}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ModelSpecGrid({
  ids, runs, specs,
}: {
  ids: string[];
  runs: (Run | undefined)[];
  specs: SpecRef[][];
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${Math.min(ids.length, 3)}, 1fr)`,
      gap: 12, marginBottom: 14,
    }}>
      {runs.map((r, i) => {
        const modelSpec = specs[i].find((s) => s.kind === "model");
        const body = (modelSpec?.body ?? {}) as Record<string, unknown>;
        const wovr = (r?.kpis ?? ({} as any))._workload_override as
          { seq_len?: number; global_batch?: number; quant?: string;
            activated_params_b?: number; total_params_b?: number; mode?: string } | undefined;
        const name = (body.model_name as string | undefined) ?? "—";
        const family = (body.family as string | undefined) ?? "";
        const params = (body.params as string | undefined) ?? (wovr?.total_params_b ? `${wovr.total_params_b}B` : "—");
        const layers = (body.layers as number | undefined) ?? "—";
        const hidden = (body.hidden as number | undefined) ?? "—";
        const heads = (body.heads as number | undefined) ?? "—";
        const seqMax = (body.max_context as number | undefined) ?? (body.seq_len as number | undefined) ?? "—";
        return (
          <div key={ids[i]} className="card" style={{ borderTop: `3px solid ${SLOT_COLORS[i]}` }}>
            <div className="card-head" style={{ marginBottom: 8 }}>
              <div className="card-t">{String.fromCharCode(65 + i)} · 模型 / 负载</div>
              {wovr?.mode && <span className="tag tag-purple" style={{ fontSize: 10 }}>{wovr.mode}</span>}
            </div>
            <KvTable rows={[
              ["模型", name],
              ["类别", family || "—"],
              ["参数", String(params)],
              ["层 / 隐藏 / 头", `${layers} / ${hidden} / ${heads}`],
              ["最大上下文", String(seqMax)],
              ["训练 seq", wovr?.seq_len ? String(wovr.seq_len) : "—"],
              ["Global batch", wovr?.global_batch ? String(wovr.global_batch) : "—"],
              ["量化", wovr?.quant ?? "—"],
            ]}/>
          </div>
        );
      })}
    </div>
  );
}

function StrategyCard({
  runId, run, colorIdx,
}: { runId: string; run: Run | undefined; colorIdx: number }) {
  const sovr = (run?.kpis ?? ({} as any))._strategy_override as
    { TP?: number; PP?: number; EP?: number; CP?: number; recompute?: string; overlap?: string } | undefined;
  const cluster = (run?.kpis ?? ({} as any))._cluster_override as { gpu_count?: number } | undefined;
  const TP = sovr?.TP ?? 1, PP = sovr?.PP ?? 1, EP = sovr?.EP ?? 1, CP = sovr?.CP ?? 1;
  const gpu_count = cluster?.gpu_count ?? TP * PP * EP * CP;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 2, background: SLOT_COLORS[colorIdx],
        }}/>
        <span className="mono" style={{ fontSize: 11, color: "var(--t2)" }}>{runId}</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--t3)" }}>
          recompute: {sovr?.recompute ?? "—"} · overlap: {sovr?.overlap ?? "—"}
        </span>
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6,
        fontSize: 11, marginBottom: 8,
      }}>
        {(["TP", "PP", "EP", "CP"] as const).map((k) => (
          <div key={k} style={{
            padding: "6px 8px", background: "var(--surface-2)",
            borderRadius: 3, textAlign: "center",
          }}>
            <div style={{ fontSize: 9.5, color: "var(--t3)", letterSpacing: ".05em" }}>{k}</div>
            <div className="mono" style={{ fontSize: 14, color: "var(--t1)", marginTop: 2 }}>
              {sovr?.[k] ?? "—"}
            </div>
          </div>
        ))}
      </div>
      <ParallelismDiagram TP={TP} PP={PP} EP={EP} CP={CP} gpu_count={gpu_count}/>
    </div>
  );
}

function KvTable({ rows }: { rows: [string, string][] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td style={{ padding: "5px 0", color: "var(--t3)", width: 100 }}>{k}</td>
            <td className="mono" style={{ padding: "5px 0", color: "var(--t1)" }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "8px 12px",
  fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase",
};
const tdStyle: React.CSSProperties = { padding: "8px 12px", verticalAlign: "middle" };
