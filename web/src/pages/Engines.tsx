/**
 * §2 Engine registry page (RFC-001 v2).
 *
 * Browse-only — registration happens out-of-band (engines self-register on
 * boot via POST /v1/engines/register). This page just shows what's live,
 * each engine's coverage envelope, and last_seen heartbeats.
 *
 * Layout mirrors 仿真报告 (Reports.tsx): stat-chips overview → filter card
 * → table list. Click a row to expand the full coverage envelope inline.
 */
import { useMemo, useState } from "react";
import { useEngines, type Engine, type Fidelity } from "../api/engines";

const FIDELITY_LABEL: Record<Fidelity, string> = {
  analytical: "分析型",
  hybrid: "混合",
  "cycle-accurate": "时钟精确",
};

const FIDELITY_TAG: Record<Fidelity, string> = {
  analytical: "tag-blue",
  hybrid: "tag-teal",
  "cycle-accurate": "tag-purple",
};

const STATUS_LABEL: Record<Engine["status"], string> = {
  active: "在线",
  deprecated: "弃用中",
  disabled: "已停用",
};

const STATUS_TAG: Record<Engine["status"], string> = {
  active: "tag-green",
  deprecated: "tag-orange",
  disabled: "tag-red",
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export function Engines() {
  const [fidelity, setFidelity] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  const list = useEngines(status ? { status } : undefined);
  const all = list.data ?? [];

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((e) => {
      if (fidelity && e.fidelity !== fidelity) return false;
      if (s && !e.name.toLowerCase().includes(s) && !e.version.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [all, fidelity, search]);

  // Counts the *unfiltered* list so the chip strip stays anchored as users
  // narrow with the controls below it (matches Reports.tsx convention).
  const counts = useMemo(() => {
    const c = { total: 0, active: 0, deprecated: 0, disabled: 0, max_scale: 0 };
    for (const e of all) {
      c.total += 1;
      if (e.status === "active") c.active += 1;
      else if (e.status === "deprecated") c.deprecated += 1;
      else if (e.status === "disabled") c.disabled += 1;
      const top = e.coverage_envelope?.hardware?.scale_gpus?.[1] ?? 0;
      if (top > c.max_scale) c.max_scale = top;
    }
    return c;
  }, [all]);

  return (
    <>
      <div className="page-hd">
        <div>
          <h1 className="page-ttl">仿真引擎</h1>
          <div className="page-sub">
            §2 引擎插件注册表 · 路由按 coverage_envelope 匹配 + SLA 预算 + fidelity · provenance 自动标注
          </div>
        </div>
      </div>

      {/* Status overview chips — at-a-glance registry health. */}
      <div className="stat-chips">
        <div className="stat-chip">
          <div className="num">{counts.total}</div>
          <div className="lab">引擎总数</div>
        </div>
        <div className="stat-chip">
          <div className="num green">{counts.active}</div>
          <div className="lab">在线</div>
        </div>
        <div className="stat-chip">
          <div className="num orange">{counts.deprecated}</div>
          <div className="lab">弃用中</div>
        </div>
        <div className="stat-chip">
          <div className="num red">{counts.disabled}</div>
          <div className="lab">已停用</div>
        </div>
        <div className="stat-chip">
          <div className="num">{counts.max_scale ? counts.max_scale.toLocaleString() : "—"}</div>
          <div className="lab">最大集群规模 (GPU)</div>
        </div>
      </div>

      {/* Filter row */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 搜索引擎名称或版本…"
            style={{
              width: 420, maxWidth: "100%", flexShrink: 0,
              padding: "7px 12px",
              background: "var(--bg-3)", border: "1px solid var(--hairline)",
              borderRadius: "var(--r-sm)", color: "var(--t1)", fontSize: 13,
            }}
          />
          <span style={{ fontSize: 11.5, color: "var(--t3)" }}>fidelity</span>
          <select value={fidelity} onChange={(e) => setFidelity(e.target.value)} style={selectStyle}>
            <option value="">全部</option>
            <option value="analytical">分析型</option>
            <option value="hybrid">混合</option>
            <option value="cycle-accurate">时钟精确</option>
          </select>
          <span style={{ fontSize: 11.5, color: "var(--t3)" }}>状态</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
            <option value="">全部</option>
            <option value="active">在线</option>
            <option value="deprecated">弃用中</option>
            <option value="disabled">已停用</option>
          </select>
          {(fidelity || status || search) && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: "5px 10px" }}
              onClick={() => { setFidelity(""); setStatus(""); setSearch(""); }}
            >
              清除筛选
            </button>
          )}
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--t3)" }}>
            共 <strong style={{ color: "var(--t1)" }}>{filtered.length}</strong>
            {filtered.length !== counts.total && <> / {counts.total}</>} 个
          </span>
        </div>
      </div>

      {/* Engine cards — 2 per row (g2). Click anywhere does nothing; this
          is browse-only and each card carries its own full detail block. */}
      {list.isLoading && <div className="card">加载中…</div>}
      {list.error && <div className="card boundary-warn">加载失败：{String(list.error)}</div>}

      {!list.isLoading && !list.error && filtered.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--t3)" }}>
          {all.length === 0 ? (
            <>
              <div style={{ fontSize: 36, marginBottom: 8 }}>🔌</div>
              <div>当前条件下没有注册的引擎</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>
                引擎自启动时调用 <span className="mono">POST /v1/engines/register</span> 入库；管理员可移除。
              </div>
            </>
          ) : (
            <div>无匹配结果，请调整筛选。</div>
          )}
        </div>
      )}

      {!list.isLoading && filtered.length > 0 && (
        <div className="grid g2">
          {filtered.map((e) => <EngineCard key={e.name} engine={e} />)}
        </div>
      )}
    </>
  );
}

function EngineCard({ engine }: { engine: Engine }) {
  const env = engine.coverage_envelope;
  const lastSeen = fmtTime(engine.last_seen_at);
  const mape = engine.calibration?.mape_pct ?? {};

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-t">
            🔌 <span className="mono">{engine.name}</span>
            <span style={{ color: "var(--t3)", fontSize: 11, marginLeft: 6 }}>{engine.version}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>
            <span className={`tag ${FIDELITY_TAG[engine.fidelity] ?? "tag-white"}`}>
              {FIDELITY_LABEL[engine.fidelity] ?? engine.fidelity}
            </span>
            <span style={{ marginLeft: 6 }}>SLA p99 {engine.sla_p99_ms} ms</span>
          </div>
        </div>
        <span className={`tag ${STATUS_TAG[engine.status]}`}>
          {STATUS_LABEL[engine.status] ?? engine.status}
        </span>
      </div>

      <KV label="endpoint" value={<span className="mono" style={{ fontSize: 10.5 }}>{engine.endpoint}{engine.predict_path}</span>} />
      <KV label="last_seen" value={lastSeen} />

      {env && (
        <div style={{ marginTop: 10 }}>
          <div className="card-t" style={{ marginBottom: 4 }}>coverage envelope</div>
          <KV label="workloads" value={<TagList items={env.workload_families} />} />
          <KV label="modes" value={<TagList items={env.modes} />} />
          <KV label="quant" value={<TagList items={env.quant} />} />
          <KV label="GPU" value={<TagList items={env.hardware.gpu_models} />} />
          <KV label="fabric" value={<TagList items={env.hardware.fabric} />} />
          <KV label="scale (GPU)" value={`[${env.hardware.scale_gpus[0]}, ${env.hardware.scale_gpus[1]}]`} />
          <KV label="TP×PP×EP×CP" value={
            <span className="mono" style={{ fontSize: 10.5 }}>
              [{env.parallelism.TP[0]},{env.parallelism.TP[1]}] ×
              [{env.parallelism.PP[0]},{env.parallelism.PP[1]}] ×
              [{env.parallelism.EP[0]},{env.parallelism.EP[1]}] ×
              [{env.parallelism.CP[0]},{env.parallelism.CP[1]}]
            </span>
          } />
          <KV label="overlap" value={<TagList items={env.parallelism.overlap} />} />
        </div>
      )}

      {engine.kpi_outputs && engine.kpi_outputs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="card-t" style={{ marginBottom: 4 }}>KPI outputs</div>
          <TagList items={engine.kpi_outputs} />
        </div>
      )}

      {Object.keys(mape).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="card-t" style={{ marginBottom: 4 }}>calibration MAPE %</div>
          {Object.entries(mape).map(([k, v]) => <KV key={k} label={k} value={String(v)} />)}
        </div>
      )}

      {engine.notes && (
        <div className="boundary-info" style={{ marginTop: 10, padding: 8, fontSize: 11, whiteSpace: "pre-wrap" }}>
          {engine.notes}
        </div>
      )}
    </div>
  );
}

function TagList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return <span className="row-dim">—</span>;
  return (
    <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {items.map((x) => <span key={x} className="tag tag-white">{x}</span>)}
    </span>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 11.5, gap: 12 }}>
      <span style={{ color: "var(--t3)", flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--t1)", textAlign: "right", maxWidth: "70%", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: 110,
  padding: "6px 10px",
  background: "var(--surface-2)",
  border: "1px solid var(--hairline)",
  borderRadius: "var(--r-sm)",
  color: "var(--t1)",
  fontSize: 12,
};
