/**
 * 仿真报告 — 一站式查看历史 run。
 *
 * 顶部一排状态统计 chip + 搜索 + 过滤；中间是 run 列表，行 hover/sel 复用
 * 集群配置页同款蓝边+蓝底约定（global.css 里的 .report-row）；底部勾选 ≥2
 * 时浮出对比条，跳到 /sim/reports/compare?ids=…。
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDeleteRun, useRunList, type Run } from "../api/runs";
import { pushToast } from "../components/shell/Toast";

const KIND_LABEL: Record<Run["kind"], string> = {
  train: "训练",
  infer: "推理",
  batch: "批量",
  agent: "Agent",
  tco: "TCO",
  calibration: "校准",
};

const STATUS_LABEL: Record<Run["status"], string> = {
  queued: "排队中",
  running: "仿真中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_TAG: Record<Run["status"], string> = {
  queued: "tag-orange",
  running: "tag-teal",
  done: "tag-green",
  failed: "tag-red",
  cancelled: "tag-white",
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

function fmtKpi(run: Run, key: string): string {
  const v = (run.kpis ?? {})[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (key === "step_ms") return `${(v / 1000).toFixed(1)}s`;
  if (key === "mfu_pct") return `${v.toFixed(1)}%`;
  return String(v);
}

function engineOf(run: Run): string | null {
  const prov = (run.kpis ?? ({} as any))._engine_provenance as { engine?: string } | undefined;
  return prov?.engine ?? null;
}

export function Reports() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const filters = useMemo(() => ({
    kind: kind || undefined,
    status: status || undefined,
    limit: 100,
  }), [kind, status]);
  const { data: runs, isLoading, error } = useRunList(filters);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return runs ?? [];
    return (runs ?? []).filter((r) =>
      r.id.toLowerCase().includes(s) || (r.title ?? "").toLowerCase().includes(s),
    );
  }, [runs, search]);

  // Status counts — drives the chip row. Counts the *unfiltered* list so the
  // strip stays anchored as users narrow with the controls below it.
  const counts = useMemo(() => {
    const c = { total: 0, done: 0, running: 0, failed: 0, mfu_max: 0 };
    for (const r of runs ?? []) {
      c.total += 1;
      if (r.status === "done") c.done += 1;
      else if (r.status === "running" || r.status === "queued") c.running += 1;
      else if (r.status === "failed") c.failed += 1;
      const mfu = r.kpis?.mfu_pct;
      if (typeof mfu === "number" && mfu > c.mfu_max) c.mfu_max = mfu;
    }
    return c;
  }, [runs]);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const goCompare = () => {
    if (picked.size < 2) return;
    navigate(`/sim/reports/compare?ids=${Array.from(picked).join(",")}`);
  };

  const del = useDeleteRun();
  const goDelete = async () => {
    if (picked.size === 0) return;
    const n = picked.size;
    if (!window.confirm(`确认删除选中的 ${n} 份仿真报告？\n\n该操作不可恢复，将同时清除关联的 artifacts (timeline / result.json / 日志等)。`)) return;
    let ok = 0, fail = 0;
    for (const id of Array.from(picked)) {
      try { await del.mutateAsync(id); ok += 1; } catch { fail += 1; }
    }
    setPicked(new Set());
    if (fail === 0) pushToast(`已删除 ${ok} 份报告`, "ok");
    else pushToast(`删除完成: ${ok} 成功, ${fail} 失败`, "warn");
  };

  return (
    <>
      <div className="page-hd">
        <h1 className="page-ttl">仿真报告</h1>
      </div>

      {/* Status overview chips — at-a-glance fleet health. */}
      <div className="stat-chips">
        <div className="stat-chip">
          <div className="num">{counts.total}</div>
          <div className="lab">报告总数</div>
        </div>
        <div className="stat-chip">
          <div className="num green">{counts.done}</div>
          <div className="lab">完成</div>
        </div>
        <div className="stat-chip">
          <div className="num teal">{counts.running}</div>
          <div className="lab">进行中</div>
        </div>
        <div className="stat-chip">
          <div className="num red">{counts.failed}</div>
          <div className="lab">失败</div>
        </div>
        <div className="stat-chip">
          <div className="num">{counts.mfu_max ? counts.mfu_max.toFixed(1) + "%" : "—"}</div>
          <div className="lab">最高 MFU</div>
        </div>
      </div>

      {/* Filter row */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 搜索 ID 或名称…"
            style={{
              width: 420, maxWidth: "100%", flexShrink: 0,
              padding: "7px 12px",
              background: "var(--bg-3)", border: "1px solid var(--hairline)",
              borderRadius: "var(--r-sm)", color: "var(--t1)", fontSize: 13,
            }}
          />
          <span style={{ fontSize: 11.5, color: "var(--t3)" }}>类型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={selectStyle}>
            <option value="">全部</option>
            <option value="train">训练</option>
            <option value="infer">推理</option>
            <option value="batch">批量</option>
            <option value="tco">TCO</option>
          </select>
          <span style={{ fontSize: 11.5, color: "var(--t3)" }}>状态</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
            <option value="">全部</option>
            <option value="done">完成</option>
            <option value="running">仿真中</option>
            <option value="queued">排队中</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
          {(kind || status || search) && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: "5px 10px" }}
              onClick={() => { setKind(""); setStatus(""); setSearch(""); }}
            >
              清除筛选
            </button>
          )}
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--t3)" }}>
            共 <strong style={{ color: "var(--t1)" }}>{filtered.length}</strong>
            {filtered.length !== counts.total && <> / {counts.total}</>} 条
          </span>
        </div>
      </div>

      {/* Run table */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {isLoading && (
          <div style={{ padding: 16, color: "var(--t3)", fontSize: 12 }}>加载中…</div>
        )}
        {error && (
          <div className="boundary-warn" style={{ margin: 12 }}>加载失败：{String(error)}</div>
        )}
        {!isLoading && !error && filtered.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: "var(--t3)", fontSize: 12 }}>
            {(runs?.length ?? 0) === 0
              ? "暂无仿真任务。新建一个训练或推理仿真试试 →"
              : "无匹配结果，请调整筛选。"}
          </div>
        )}
        {!isLoading && filtered.length > 0 && (
          <table className="report-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th style={{ width: 110 }}>ID</th>
                <th style={{ minWidth: 240 }}>名称</th>
                <th style={{ width: 60 }}>类型</th>
                <th style={{ width: 80 }}>状态</th>
                <th style={{ width: 130 }}>引擎</th>
                <th style={{ width: 70, textAlign: "right" }}>MFU</th>
                <th style={{ width: 90, textAlign: "right" }}>单步</th>
                <th style={{ width: 110 }}>创建时间</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const checked = picked.has(r.id);
                const inProgress = r.status === "running" || r.status === "queued";
                const mfu = r.kpis?.mfu_pct;
                const isMfuTop = typeof mfu === "number" && counts.mfu_max > 0 && mfu === counts.mfu_max;
                return (
                  <tr
                    key={r.id}
                    className={`report-row ${checked ? "sel" : ""}`}
                    onClick={(e) => {
                      // Only the "详情 →" link drills in; everywhere else on
                      // the row toggles selection (mirrors gmail-style list).
                      const t = e.target as HTMLElement;
                      if (t.closest("a")) return;
                      togglePick(r.id);
                    }}
                  >
                    <td>
                      <input type="checkbox" checked={checked} readOnly style={{ cursor: "pointer" }} />
                    </td>
                    <td className="row-id">{r.id}</td>
                    <td>
                      <div style={{ color: "var(--t1)" }}>{r.title || "未命名"}</div>
                      {inProgress && r.progress_pct != null && (
                        <div className="row-bar"><span style={{ width: `${Math.max(2, r.progress_pct)}%` }}/></div>
                      )}
                    </td>
                    <td className="row-dim">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td>
                      <span className={`tag ${STATUS_TAG[r.status] || ""}`} style={{ fontSize: 10.5 }}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="row-mono" style={{ fontSize: 11 }}>{engineOf(r) ?? "—"}</td>
                    <td className={`row-num ${isMfuTop ? "win" : ""}`}>{fmtKpi(r, "mfu_pct")}</td>
                    <td className="row-num">{fmtKpi(r, "step_ms")}</td>
                    <td className="row-dim">{fmtTime(r.created_at)}</td>
                    <td>
                      <Link to={`/sim/reports/${r.id}`} style={{ fontSize: 11, color: "var(--blue)" }}>
                        详情 →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Floating compare bar — appears when ≥1 picked. */}
      {picked.size > 0 && (
        <div className="compare-bar">
          <span style={{ fontSize: 12, color: "var(--t2)" }}>
            已选 <strong style={{ color: "var(--t1)" }}>{picked.size}</strong> 份报告
          </span>
          <div style={{ display: "flex", gap: 6, fontSize: 10.5, color: "var(--t3)", flexWrap: "wrap", flex: 1 }}>
            {Array.from(picked).slice(0, 4).map((id) => (
              <span key={id} className="mono" style={{
                padding: "2px 8px", background: "var(--surface-2)",
                borderRadius: 3,
              }}>{id}</span>
            ))}
            {picked.size > 4 && <span className="mono">+{picked.size - 4}…</span>}
          </div>
          <button
            className="btn btn-primary"
            disabled={picked.size === 0}
            onClick={() => setPicked(new Set())}
            style={{ fontSize: 12, padding: "7px 14px" }}
          >
            清空
          </button>
          <button
            className="btn btn-primary"
            disabled={del.isPending || picked.size === 0}
            onClick={goDelete}
            style={{ fontSize: 12, padding: "7px 14px" }}
            title={`删除选中的 ${picked.size} 份`}
          >
            {del.isPending ? "删除中…" : "删除"}
          </button>
          <button
            className="btn btn-primary"
            disabled={picked.size < 2}
            onClick={goCompare}
            style={{ fontSize: 12, padding: "7px 16px" }}
            title={picked.size < 2 ? "至少选 2 份" : "对比所选报告"}
          >
            对比
          </button>
        </div>
      )}
    </>
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
