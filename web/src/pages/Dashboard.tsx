/**
 * Dashboard — 架构师工作台首页。
 *
 * 重构之前的视角是「平台运维大屏」（AI 简报 / surrogate 版本 / 校准 inbox），
 * 但当前产品定位是「架构师工作台」，自动寻优 / 校准中心 / 生产数据 都还在
 * 建设中，所以那些 widget 大量空载或不相关。
 *
 * 新版聚焦三件事：
 *   1. 仿真任务总体状态（4 个 stat chip）
 *   2. 快速进入主流程（训练 / 推理 / 集群 / 报告 4 个 CTA）
 *   3. 当前集群概览 + 最近仿真清单
 */
import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useRunList, type Run } from "../api/runs";
import { useSpecLatest, useSpecList } from "../api/specs";

const KIND_LABEL: Record<Run["kind"], string> = {
  train: "训练", infer: "推理", batch: "批量",
  agent: "Agent", tco: "TCO", calibration: "校准",
};

const STATUS_LABEL: Record<Run["status"], string> = {
  queued: "排队中", running: "仿真中", done: "完成",
  failed: "失败", cancelled: "已取消",
};

const STATUS_TAG: Record<Run["status"], string> = {
  queued: "tag-orange", running: "tag-teal",
  done: "tag-green", failed: "tag-red", cancelled: "tag-white",
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

export function Dashboard() {
  const { data: runs, isLoading } = useRunList({ limit: 50 });
  const specList = useSpecList("hwspec");
  const hwspecId = specList.data?.[0]?.id ?? "hwspec_topo_b1";
  const hwspec = useSpecLatest("hwspec", hwspecId);

  const counts = useMemo(() => {
    const c = { total: 0, done: 0, running: 0, failed: 0 };
    for (const r of runs ?? []) {
      c.total += 1;
      if (r.status === "done") c.done += 1;
      else if (r.status === "running" || r.status === "queued") c.running += 1;
      else if (r.status === "failed") c.failed += 1;
    }
    return c;
  }, [runs]);

  const clusters = hwspec.data?.version.body.datacenter?.clusters ?? [];
  const recent5 = (runs ?? []).slice(0, 5);

  return (
    <>
      <div className="page-hd">
        <h1 className="page-ttl">工作台</h1>
      </div>

      {/* Stat chips */}
      <div className="stat-chips">
        <div className="stat-chip">
          <div className="num">{counts.total}</div>
          <div className="lab">仿真总数</div>
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
      </div>

      {/* Quick actions */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head" style={{ marginBottom: 10 }}>
          <div className="card-t">快速操作</div>
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
        }}>
          <QuickAction to={`/sim/cluster/${hwspecId}`} label="集群配置"
            sub="datacenter · cluster · rack · server" />
          <QuickAction to="/sim/training" label="训练仿真"
            sub="选模板 / 配并行 / 出 KPI" />
          <QuickAction to="/sim/inference" label="推理仿真"
            sub="KV cache + SLO + TTFT/TPOT" />
          <QuickAction to="/sim/reports" label="仿真报告"
            sub="历史 run · 多份对比" />
        </div>
      </div>

      {/* 2-column main */}
      <div className="grid g2-3" style={{ gap: 14, marginBottom: 14, alignItems: "start" }}>
        {/* Cluster overview */}
        <div className="card">
          <div className="card-head" style={{ marginBottom: 8 }}>
            <div className="card-t">集群概览</div>
            <Link to={`/sim/cluster/${hwspecId}`} style={{ fontSize: 11, color: "var(--blue)" }}>
              管理 →
            </Link>
          </div>
          {hwspec.isLoading ? (
            <div style={{ fontSize: 12, color: "var(--t3)" }}>加载中…</div>
          ) : clusters.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--t3)" }}>
              当前 hwspec 中尚无集群 — 到「集群配置」新增。
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {clusters.map((c) => {
                const servers = c.racks.flatMap((r) => r.servers);
                const tally = new Map<string, number>();
                for (const s of servers) if (s.gpu_count > 0) {
                  tally.set(s.gpu_model, (tally.get(s.gpu_model) ?? 0) + s.gpu_count);
                }
                const gpuLine = Array.from(tally.entries())
                  .map(([m, n]) => `${n}× ${m}`).join(" · ") || "无 GPU";
                return (
                  <Link
                    key={c.id}
                    to={`/sim/cluster/${hwspecId}?cluster=${c.id}`}
                    style={{
                      padding: "10px 12px", background: "var(--surface-2)",
                      borderRadius: "var(--r-sm)", textDecoration: "none",
                      display: "flex", alignItems: "center", gap: 10,
                    }}
                  >
                    <span className="mono" style={{
                      padding: "2px 8px", background: "var(--blue-s)",
                      color: "var(--blue)", borderRadius: 3,
                      fontSize: 11, fontWeight: 600,
                    }}>{c.id}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: "var(--t1)", fontWeight: 600 }}>
                        {c.name || "未命名"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>
                        {gpuLine} · {servers.length} 服务器 · {c.racks.length} 机柜
                      </div>
                    </div>
                    {c.purpose && (
                      <span className="tag tag-blue" style={{ fontSize: 10 }}>
                        {c.purpose}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent runs */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="card-head" style={{ padding: "12px 14px 8px", marginBottom: 0 }}>
            <div className="card-t">最近仿真</div>
            <Link to="/sim/reports" style={{ fontSize: 11, color: "var(--blue)" }}>
              全部 →
            </Link>
          </div>
          {isLoading ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--t3)" }}>加载中…</div>
          ) : recent5.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--t3)", fontSize: 12 }}>
              还没有仿真任务 —
              <Link to="/sim/training" style={{ color: "var(--blue)", marginLeft: 4 }}>
                启动一次训练仿真 →
              </Link>
            </div>
          ) : (
            <table className="report-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>ID</th>
                  <th>名称</th>
                  <th style={{ width: 50 }}>类型</th>
                  <th style={{ width: 70 }}>状态</th>
                  <th style={{ width: 90 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {recent5.map((r) => (
                  <tr key={r.id} className="report-row" onClick={() => {
                    window.location.assign(`/sim/reports/${r.id}`);
                  }}>
                    <td className="row-id">{r.id}</td>
                    <td style={{ color: "var(--t1)" }}>{r.title || "未命名"}</td>
                    <td className="row-dim">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td>
                      <span className={`tag ${STATUS_TAG[r.status] || ""}`} style={{ fontSize: 10 }}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="row-dim">{fmtTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function QuickAction({ to, label, sub }: { to: string; label: string; sub: string }) {
  return (
    <Link
      to={to}
      style={{
        display: "block", textDecoration: "none",
        padding: "14px 16px",
        background: "var(--surface-2)", border: "1px solid var(--hairline)",
        borderRadius: "var(--r-sm)",
        transition: "border-color .12s ease, background .12s ease",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--blue)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--hairline)"; }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)" }}>
        {label}
      </div>
      <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 4 }}>
        {sub}
      </div>
    </Link>
  );
}
