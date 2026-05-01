/**
 * Shared widgets for TrainingSim / InferenceSim right-column "live insights"
 * + sticky topbar progress strip + cluster summary derivation.
 *
 * Originally lived inline in TrainingSim; extracted so the inference page
 * can mirror the training page's layout without duplicating ~250 lines.
 *
 * Widgets:
 *   - <ProgressStrip>     —— slim run progress bar that sits under the topbar
 *   - <EngineCheckCard>   —— engine selector + envelope check + red warning
 *   - <GpuUtilDonut>      —— TP×PP×EP×CP / total cards visualization
 * Helpers:
 *   - summarizeHwSpec()   —— derive ClusterSummary from a single cluster
 *   - checkEngine()       —— per-axis envelope check
 *   - CurrentConfig type
 */
import { Link } from "react-router-dom";
import { useRunFull } from "../../api/runs";
import type { Engine } from "../../api/engines";
import type { HwSpecBody } from "../../api/specs";

// ── Cluster summary ─────────────────────────────────────────────────────────

export type ClusterSummary = {
  gpu_model: string;
  gpu_count: number;
  pue: number;
  electricity_usd_per_kwh: number;
  total_servers: number;
  total_racks: number;
  cluster_id: string | null;
  cluster_name: string | null;
  cluster_purpose: string | null;
  fabric_kind: string | null;
  fabric_topology: string | null;
};

/** Summarise either a single cluster (when clusterId given) or the whole
 *  datacenter (clusterId = null). */
export function summarizeHwSpec(
  body: HwSpecBody | undefined,
  clusterId: string | null,
): ClusterSummary {
  const allClusters = body?.datacenter?.clusters ?? [];
  const scoped = clusterId
    ? allClusters.filter((c) => c.id === clusterId)
    : allClusters;
  const racks = scoped.flatMap((c) => c.racks);
  const servers = racks.flatMap((r) => r.servers);
  const gpuServers = servers.filter((s) => (s.gpu_count ?? 0) > 0);
  const tally = new Map<string, number>();
  for (const s of gpuServers) {
    tally.set(s.gpu_model, (tally.get(s.gpu_model) ?? 0) + s.gpu_count);
  }
  let gpu_model = "B200";
  let best = -1;
  for (const [m, n] of tally) {
    if (n > best) { gpu_model = m; best = n; }
  }
  const gpu_count = gpuServers.reduce((a, s) => a + s.gpu_count, 0);
  const pue =
    scoped.find((c) => typeof c.pue === "number")?.pue ??
    body?.power?.pue ??
    1.18;
  const fab = body?.datacenter?.scale_out_fabrics?.[0] ?? null;
  const c0 = scoped[0] ?? null;
  return {
    gpu_model, gpu_count, pue,
    electricity_usd_per_kwh: 0.092,
    total_servers: servers.length,
    total_racks: racks.length,
    cluster_id: c0?.id ?? null,
    cluster_name: c0?.name ?? null,
    cluster_purpose: c0?.purpose ?? null,
    fabric_kind: fab?.kind ?? null,
    fabric_topology: fab?.topology ?? null,
  };
}

// ── Envelope check ──────────────────────────────────────────────────────────

export type CurrentConfig = {
  TP: number; PP: number; EP: number; CP: number;
  recompute: string; overlap: string;
  quant: string;
  workload_family: string;
  gpu_model: string; gpu_count: number;
};

/** Run the config against a single engine's coverage envelope. Returns one
 *  row per axis with `ok` flag + current vs supported range strings. */
export function checkEngine(engine: Engine, cfg: CurrentConfig) {
  const env = engine.coverage_envelope;
  const inRange = (val: number, [lo, hi]: [number, number]) => val >= lo && val <= hi;
  return [
    { name: "TP",       ok: inRange(cfg.TP, env.parallelism.TP),     current: String(cfg.TP), range: `[${env.parallelism.TP[0]}, ${env.parallelism.TP[1]}]` },
    { name: "PP",       ok: inRange(cfg.PP, env.parallelism.PP),     current: String(cfg.PP), range: `[${env.parallelism.PP[0]}, ${env.parallelism.PP[1]}]` },
    { name: "EP",       ok: inRange(cfg.EP, env.parallelism.EP),     current: String(cfg.EP), range: `[${env.parallelism.EP[0]}, ${env.parallelism.EP[1]}]` },
    { name: "CP",       ok: inRange(cfg.CP, env.parallelism.CP),     current: String(cfg.CP), range: `[${env.parallelism.CP[0]}, ${env.parallelism.CP[1]}]` },
    { name: "Recompute",ok: env.parallelism.recompute.includes(cfg.recompute), current: cfg.recompute, range: env.parallelism.recompute.join(" / ") },
    { name: "Overlap",  ok: env.parallelism.overlap.includes(cfg.overlap),     current: cfg.overlap,   range: env.parallelism.overlap.join(" / ") },
    { name: "量化",     ok: env.quant.includes(cfg.quant),                     current: cfg.quant,     range: env.quant.join(" / ") },
    { name: "GPU",      ok: env.hardware.gpu_models.includes(cfg.gpu_model) && inRange(cfg.gpu_count, env.hardware.scale_gpus), current: `${cfg.gpu_count}× ${cfg.gpu_model}`, range: `${env.hardware.scale_gpus[0]}-${env.hardware.scale_gpus[1]} · ${env.hardware.gpu_models.join(", ")}` },
    { name: "Workload", ok: env.workload_families.includes(cfg.workload_family), current: cfg.workload_family, range: env.workload_families.join(" / ") },
  ];
}

// ── Color helpers ───────────────────────────────────────────────────────────

const FIDELITY_COLOR: Record<string, string> = {
  "cycle-accurate": "var(--green)",
  "hybrid": "var(--teal)",
  "analytical": "var(--blue)",
};

function slaColor(ms: number) {
  if (ms <= 100) return "var(--green)";
  if (ms <= 500) return "var(--teal)";
  if (ms <= 2000) return "var(--orange)";
  return "var(--red)";
}

function mapeColor(pct: number) {
  if (pct < 5) return "var(--green)";
  if (pct < 10) return "var(--teal)";
  if (pct < 15) return "var(--orange)";
  return "var(--red)";
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "70px 1fr", gap: 10,
      alignItems: "baseline", padding: "5px 0",
      borderTop: "1px solid var(--hairline)",
    }}>
      <span style={{ fontSize: 10.5, color: "var(--t3)", letterSpacing: ".04em" }}>{label}</span>
      <span style={{ fontSize: 11.5, color: "var(--t1)", lineHeight: 1.55 }}>{children}</span>
    </div>
  );
}

function EngineInfoBlock({ engine }: { engine: Engine }) {
  const fidColor = FIDELITY_COLOR[engine.fidelity] ?? "var(--t1)";
  return (
    <div style={{
      padding: "4px 12px 8px", borderRadius: "var(--r-sm)",
      background: "var(--surface-2)",
    }}>
      <InfoRow label="精度">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", background: fidColor,
          }} />
          <strong style={{ color: fidColor }}>{engine.fidelity}</strong>
        </span>
      </InfoRow>
      <InfoRow label="版本">
        <span className="mono" style={{ color: "var(--t2)" }}>{engine.version}</span>
      </InfoRow>
      <InfoRow label="SLA p99">
        <strong style={{ color: slaColor(engine.sla_p99_ms) }}>
          ≤ {engine.sla_p99_ms} ms
        </strong>
      </InfoRow>
      <InfoRow label="KPI 输出">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 6px" }}>
          {engine.kpi_outputs.map((k) => (
            <span key={k} className="mono" style={{
              padding: "1px 6px", borderRadius: 3,
              background: "var(--bg-3)", color: "var(--t2)",
              fontSize: 10.5,
            }}>{k}</span>
          ))}
        </div>
      </InfoRow>
      {engine.notes && (
        <InfoRow label="说明">
          <span style={{ color: "var(--t3)", fontStyle: "italic" }}>{engine.notes}</span>
        </InfoRow>
      )}
    </div>
  );
}

function CalibrationBlock({
  mape, profiles,
}: {
  mape: Record<string, number>;
  profiles: number;
}) {
  const keys = Object.keys(mape);
  return (
    <div style={{
      marginTop: 8, padding: "8px 12px", borderRadius: "var(--r-sm)",
      background: "var(--surface-2)",
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4,
      }}>
        <span style={{ fontSize: 11, color: "var(--t2)", fontWeight: 600 }}>
          校准 MAPE
        </span>
        {profiles > 0 && (
          <span style={{ fontSize: 10.5, color: "var(--t3)" }}>
            基于 {profiles} 次 profile run
          </span>
        )}
      </div>
      {keys.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--t3)" }}>暂无 MAPE 数据</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {keys.map((k) => {
            const v = mape[k];
            const c = mapeColor(v);
            const barW = Math.min(100, v * 4);
            return (
              <div key={k} style={{
                display: "grid", gridTemplateColumns: "80px 1fr 56px",
                alignItems: "center", gap: 8,
              }}>
                <span style={{ fontSize: 10.5, color: "var(--t3)" }}>{k}</span>
                <span style={{
                  height: 5, borderRadius: 3, background: "var(--hairline)",
                  position: "relative", overflow: "hidden",
                }}>
                  <span style={{
                    position: "absolute", left: 0, top: 0, bottom: 0,
                    width: `${barW}%`, background: c,
                  }} />
                </span>
                <strong className="mono" style={{
                  fontSize: 11, color: c, textAlign: "right",
                }}>{v.toFixed(1)}%</strong>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Public widgets ──────────────────────────────────────────────────────────

/** Slim inline progress strip — single thin bar + small text + dismiss + link.
 *  No KPI grid / phase stepper / bottleneck card — those live on /sim/reports/:id. */
export function ProgressStrip({ runId, onDismiss }: { runId: string; onDismiss: () => void }) {
  const { data } = useRunFull(runId);
  const status = data?.run.status ?? "queued";
  const pct = data?.run.progress_pct;
  const isRunning = status === "queued" || status === "running";
  const isDone = status === "done";
  const isFail = status === "failed";

  const barPct = isDone ? 100 : isFail ? (pct ?? 0) : (pct ?? 0);
  const barColor =
    isFail ? "var(--red)" :
    isDone ? "var(--green)" :
    "var(--blue)";

  const statusText =
    status === "queued"  ? "排队中" :
    status === "running" ? "仿真中" :
    status === "done"    ? "完成" :
    status === "failed"  ? "失败" :
    status;

  return (
    <div
      className="card"
      style={{ marginBottom: 14, padding: "10px 14px" }}
      data-testid="sim-progress-strip"
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 10, fontSize: 11.5,
        color: "var(--t2)", marginBottom: 6,
      }}>
        <span className="mono" style={{ color: "var(--t3)" }}>{runId}</span>
        <span style={{
          color: isDone ? "var(--green)" : isFail ? "var(--red)" : "var(--blue)",
          fontWeight: 600,
        }}>
          {statusText}{isRunning && pct != null ? ` · ${Math.round(pct)}%` : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <Link
            to={`/sim/reports/${runId}`}
            style={{ fontSize: 11, color: "var(--blue)" }}
            data-testid="sim-progress-link"
          >
            {isDone ? "查看结果 →" : "进入详情 →"}
          </Link>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={onDismiss}
            data-testid="sim-progress-dismiss"
          >
            ✗
          </button>
        </span>
      </div>
      <div style={{
        height: 4, borderRadius: 2,
        background: "var(--hairline)", overflow: "hidden",
      }}>
        <div style={{
          width: `${Math.max(2, barPct)}%`,
          height: "100%",
          background: barColor,
          transition: "width .3s ease, background-color .3s ease",
        }} />
      </div>
    </div>
  );
}

export function EngineCheckCard({
  engines, selectedName, onSelect, cfg,
}: {
  engines: Engine[];
  selectedName: string;
  onSelect: (name: string) => void;
  cfg: CurrentConfig;
}) {
  const selected = engines.find((e) => e.name === selectedName) ?? engines[0];
  const checks = selected ? checkEngine(selected, cfg) : [];
  const failing = checks.filter((c) => !c.ok);
  const allOk = checks.length > 0 && failing.length === 0;
  const cal = selected?.calibration;
  const mape = cal?.mape_pct ?? {};
  const mapeKeys = Object.keys(mape).slice(0, 3);
  const profiles = cal?.profile_runs?.length ?? 0;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="card-head" style={{ marginBottom: 8 }}>
        <div className="card-t">仿真引擎</div>
        {selected && (
          <span className={`tag ${allOk ? "tag-green" : "tag-red"}`}>
            {allOk ? "✓ 当前配置可用" : "✗ 引擎不支持当前配置"}
          </span>
        )}
      </div>

      {engines.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--t3)" }}>
          没有可用引擎（registry 为空 / 加载失败）
        </div>
      )}

      {engines.length > 0 && (
        <select
          value={selected?.name ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            width: "100%",
            background: "var(--bg-3)", border: "1px solid var(--hairline)",
            borderRadius: "var(--r-sm)", color: "var(--t1)",
            padding: "5px 8px", fontSize: 12, marginBottom: 8,
          }}
        >
          {engines.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
        </select>
      )}

      {selected && (
        <>
          <EngineInfoBlock engine={selected} />
          {(mapeKeys.length > 0 || profiles > 0) && (
            <CalibrationBlock mape={mape} profiles={profiles} />
          )}
          {failing.length > 0 && (
            <div style={{
              marginTop: 8, padding: "8px 10px", borderRadius: "var(--r-sm)",
              background: "var(--red-s)", border: "1px solid var(--red)",
              fontSize: 11, lineHeight: 1.6,
            }}>
              <div style={{ color: "var(--red)", fontWeight: 600, marginBottom: 4 }}>
                以下维度超出 {selected.name} 的覆盖范围：
              </div>
              {failing.map((c) => (
                <div key={c.name} style={{ color: "var(--red)", fontFamily: "var(--mono)", fontSize: 10.5 }}>
                  • {c.name} = <strong>{c.current}</strong>
                  <span style={{ color: "var(--t3)", marginLeft: 6 }}>
                    支持 {c.range}
                  </span>
                </div>
              ))}
              <div style={{ marginTop: 4, color: "var(--t3)", fontSize: 10.5 }}>
                提交时 registry 会改用其他引擎或 surrogate 兜底。
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function GpuUtilDonut({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const r = 38;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  const over = used > total;
  const color = over ? "var(--red)" : pct < 50 ? "var(--orange)" : pct < 90 ? "var(--teal)" : "var(--green)";
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="card-head">
        <div className="card-t">GPU 占用</div>
        <span className="tag tag-teal" style={{ fontSize: 10 }}>
          TP×PP×EP×CP / 总卡数
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <svg width={100} height={100} viewBox="0 0 100 100" style={{ flexShrink: 0 }}>
          <circle cx={50} cy={50} r={r} fill="none" stroke="var(--hairline)" strokeWidth={9} />
          <circle cx={50} cy={50} r={r} fill="none" stroke={color} strokeWidth={9}
            strokeDasharray={c} strokeDashoffset={offset}
            strokeLinecap="round" transform="rotate(-90 50 50)" />
          <text x={50} y={49} textAnchor="middle" fontSize={18} fontWeight={700} fill="var(--t1)">
            {pct.toFixed(0)}%
          </text>
          <text x={50} y={64} textAnchor="middle" fontSize={9} fill="var(--t3)">
            {used} / {total}
          </text>
        </svg>
        <div style={{ fontSize: 11.5, color: "var(--t2)", lineHeight: 1.6 }}>
          {over ? (
            <span style={{ color: "var(--red)" }}>
              并行积超过总卡数 {used - total} 张
            </span>
          ) : pct < 50 ? (
            <span>剩余 {total - used} 张卡未被并行布局占用</span>
          ) : pct < 100 ? (
            <span>{total - used} 张卡空闲（用作冗余 / data-parallel 副本）</span>
          ) : (
            <span style={{ color: "var(--green)" }}>正好占满 {total} 张卡</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Form helpers (also reused by both pages) ────────────────────────────────

export function ChipRow<T extends string | number>({
  value, options, onChange, formatter,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  formatter?: (v: T) => string;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={String(o)}
            type="button"
            className={`btn ${active ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: 11, padding: "4px 12px", minWidth: 38 }}
            onClick={() => onChange(o)}
          >
            {formatter ? formatter(o) : String(o)}
          </button>
        );
      })}
    </div>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5, color: "var(--t3)", letterSpacing: ".06em",
      marginBottom: 4, marginTop: 8,
    }}>
      {children}
    </div>
  );
}
