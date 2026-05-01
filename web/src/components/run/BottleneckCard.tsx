import { Link } from "react-router-dom";
import type { Run } from "../../api/runs";
import {
  getBottleneck,
  type BottleneckKind,
  type Severity,
} from "../../api/runs";

const KIND_LABEL: Record<BottleneckKind, string> = {
  nvlink: "NVLink 饱和",
  infiniband: "InfiniBand 饱和",
  roce: "RoCE 饱和",
  leaf_spine: "Leaf-Spine 拥塞",
  pcie: "PCIe 饱和",
  compute: "计算瓶颈",
  memory_bw: "显存带宽瓶颈",
  kv_spill: "KV 溢出",
  kv_pressure: "KV 压力",
  pp_bubble: "流水气泡",
  ep_alltoall: "MoE All-to-All",
  unknown: "未分类",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "严重",
  med: "中等",
  low: "轻微",
};

// Reuse existing boundary classes for consistent severity tinting.
const SEVERITY_TONE: Record<Severity, string> = {
  high: "boundary-warn",
  med: "boundary-info",
  low: "boundary-ok",
};

const SEVERITY_DOT: Record<Severity, string> = {
  high: "status-fail",
  med: "status-wait",
  low: "status-ok",
};

type Props = {
  run: Run;
  /**
   * S6.4 — when supplied AND the bottleneck has projectable geometry
   * (links or nodes), render a "在拓扑视图查看" deep link to the topology
   * page with the run's overlay attached. Omit to suppress the link
   * (RunDetail supplies it; SubmittedRunPanel may suppress to avoid
   * encouraging navigation away mid-iteration).
   */
  hwspecId?: string;
};

export function BottleneckCard({ run, hwspecId }: Props) {
  const b = getBottleneck(run);

  if (!b) {
    // Distinguish "engine did not attribute" (no card data) from "no
    // bottleneck" (engine ran fine, picked compute/low). The former we
    // explicitly say so the architect doesn't read a green box as
    // "everything fine".
    return (
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <div className="card-t">瓶颈定位</div>
          <div className="card-x">引擎未产出归因</div>
        </div>
        <div className="boundary-info">
          引擎本次未提供瓶颈归因数据 — 不代表无瓶颈，可能是 fidelity 不足或字段缺失。
        </div>
      </div>
    );
  }

  const projectable = b.links.length > 0 || b.nodes.length > 0;
  const topologyLink = hwspecId && projectable
    ? `/sim/cluster/${hwspecId}?overlay=run:${run.id}`
    : null;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <div className="card-t">瓶颈定位</div>
        <div className="card-x" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>
            {b.links.length > 0 && `${b.links.length} 链路 · `}
            {b.nodes.length > 0 && `${b.nodes.length} 节点 · `}
            来自 engine.bottleneck
          </span>
          {topologyLink && (
            <Link
              to={topologyLink}
              data-testid="bn-topology-link"
              style={{ fontSize: 11, whiteSpace: "nowrap" }}
            >
              在拓扑视图查看 →
            </Link>
          )}
        </div>
      </div>

      <div className={SEVERITY_TONE[b.severity]} data-testid="bn-tone">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span className={`status-dot ${SEVERITY_DOT[b.severity]}`} />
          <span style={{ fontWeight: 600, fontSize: 13 }}>
            {KIND_LABEL[b.primary]}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--t3)",
              padding: "2px 6px",
              border: "1px solid var(--hairline)",
              borderRadius: 4,
            }}
          >
            {SEVERITY_LABEL[b.severity]}
          </span>
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{b.headline}</div>

        {b.suggested_action && (
          <div
            style={{
              marginTop: 8,
              padding: "4px 10px",
              display: "inline-block",
              fontSize: 12,
              background: "var(--surface-2)",
              border: "1px solid var(--hairline)",
              borderRadius: 4,
              color: "var(--t2)",
            }}
            data-testid="bn-suggested"
          >
            建议: {b.suggested_action}
          </div>
        )}
      </div>

      {(b.links.length > 0 || b.nodes.length > 0) && (
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            color: "var(--t3)",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
          }}
          data-testid="bn-context"
        >
          {b.links.length > 0 && (
            <div>
              <div style={{ marginBottom: 4 }}>热点链路</div>
              {b.links.slice(0, 3).map((l) => (
                <div key={l.id} style={{ fontFamily: "var(--mono)" }}>
                  {l.id} · {l.fabric} · {l.util_pct.toFixed(0)}%
                </div>
              ))}
              {b.links.length > 3 && <div>+{b.links.length - 3} 条…</div>}
            </div>
          )}
          {b.nodes.length > 0 && (
            <div>
              <div style={{ marginBottom: 4 }}>问题节点</div>
              {b.nodes.slice(0, 3).map((n) => (
                <div key={n.id} style={{ fontFamily: "var(--mono)" }}>
                  {n.id} · {KIND_LABEL[n.issue]}
                </div>
              ))}
              {b.nodes.length > 3 && <div>+{b.nodes.length - 3} 个…</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
