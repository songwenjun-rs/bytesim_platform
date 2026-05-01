/**
 * S6.5 — Compact topology preview embedded in Sim pages.
 *
 * Workbench three-pane layout's right column: a glanceable view of the
 * hwspec the architect is about to (or just did) simulate against.
 * When a `runId` is provided we paint the run's bottleneck attribution
 * onto the rack grid using the same severity scale FabricView /
 * RackCanvas use — visual continuity across pages.
 *
 * Contrast with RackCanvas: this is read-only, no drag/drop, no
 * per-server detail. Whole component fits in 280px tall.
 * Click anywhere → navigate to the full Topology page with the same
 * overlay applied (?overlay=run:<id>).
 */
import { Link } from "react-router-dom";
import { useSpecLatest } from "../../api/specs";
import { useRunFull, getBottleneck, type Severity } from "../../api/runs";

const SEVERITY_BG: Record<Severity, string> = {
  high: "var(--red-s)",
  med:  "var(--orange-s)",
  low:  "var(--teal-s)",
};
const SEVERITY_BORDER: Record<Severity, string> = {
  high: "var(--red)",
  med:  "var(--orange)",
  low:  "var(--teal)",
};

type Props = {
  hwspecId: string;
  /** Optional cluster id — scope the thumbnail to a single cluster within
   *  the hwspec. When omitted, all clusters in the datacenter are flattened
   *  (legacy behaviour). */
  clusterId?: string;
  /** Optional run id — when supplied, paint the run's attribution on the
   *  thumbnail and the deep link includes `?overlay=run:<id>`. */
  runId?: string;
};

export function TopologyThumbnail({ hwspecId, clusterId, runId }: Props) {
  const { data: latest, isLoading: specLoading } = useSpecLatest("hwspec", hwspecId);

  // Conditional fetch — same gate trick used in LastRunPanel/Topology.
  // S1.2's useRunFull(enabled) widening makes this a one-liner.
  const { data: runFull } = useRunFull(runId ?? "", { enabled: !!runId });

  const body = latest?.version.body;
  const allClusters = body?.datacenter?.clusters ?? [];
  const scopedClusters = clusterId
    ? allClusters.filter((c) => c.id === clusterId)
    : allClusters;
  const racks = scopedClusters.flatMap((c) => c.racks);
  const totalServers = racks.reduce((a, r) => a + r.servers.length, 0);
  const totalGpus = racks.reduce(
    (a, r) => a + r.servers.reduce((s, srv) => s + srv.gpu_count, 0),
    0,
  );

  const bn = runFull?.run ? getBottleneck(runFull.run) : null;
  // Build a quick `serverId -> severity` map from the run's bottleneck.
  // Reuses the lookup-by-srv-id convention RackCanvas uses; we only need
  // the severity here, no need for full overlay objects.
  const serverSeverity = new Map<string, Severity>();
  if (bn) {
    for (const n of bn.nodes) {
      // Unqualified id (matches `srv-...`)
      serverSeverity.set(n.id, n.severity);
      // Qualified `<rack>.<srv>` — split and store the unqualified part too
      const dot = n.id.indexOf(".");
      if (dot > 0) {
        serverSeverity.set(n.id.slice(dot + 1), n.severity);
      }
    }
  }

  const deepLinkParams = new URLSearchParams();
  if (clusterId) deepLinkParams.set("cluster", clusterId);
  if (runId) deepLinkParams.set("overlay", `run:${runId}`);
  const deepLink = `/sim/cluster/${hwspecId}${
    deepLinkParams.toString() ? `?${deepLinkParams}` : ""
  }`;

  if (specLoading) {
    return (
      <div className="card" style={{ marginBottom: 14 }} data-testid="topology-thumbnail-loading">
        <div className="card-head">
          <div className="card-t">拓扑概览</div>
          <div className="card-x">{hwspecId} · 加载中…</div>
        </div>
      </div>
    );
  }
  if (!body || racks.length === 0) {
    return (
      <div className="card" style={{ marginBottom: 14 }} data-testid="topology-thumbnail-empty">
        <div className="card-head">
          <div className="card-t">拓扑概览</div>
          <div className="card-x">{hwspecId} · 无机柜数据</div>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="topology-thumbnail">
      <div className="card-head">
        <div className="card-t">拓扑概览</div>
        <div className="card-x" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span>
            {racks.length} 机柜 · {totalServers} 服务器 · {totalGpus} GPU
          </span>
          <Link
            to={deepLink}
            data-testid="topology-thumbnail-link"
            style={{ fontSize: 11, whiteSpace: "nowrap" }}
          >
            {bn ? "查看反投影 →" : "进入完整视图 →"}
          </Link>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(racks.length, 4)}, 1fr)`,
          gap: 8,
        }}
        data-testid="topology-thumbnail-grid"
      >
        {racks.map((rack) => {
          // Aggregate severity for the rack from its servers' overlay status.
          // "Worst wins" — if any server has high severity, paint the rack
          // high. This mirrors how an architect reads the canvas at a glance.
          const severities = rack.servers
            .map((s) => serverSeverity.get(s.id))
            .filter((s): s is Severity => !!s);
          const rackSeverity: Severity | undefined =
            severities.includes("high") ? "high"
            : severities.includes("med") ? "med"
            : severities.includes("low") ? "low"
            : undefined;

          return (
            <div
              key={rack.id}
              data-testid={`thumb-rack-${rack.id}`}
              data-overlay-severity={rackSeverity}
              style={{
                padding: 8,
                background: rackSeverity ? SEVERITY_BG[rackSeverity] : "var(--surface-2)",
                border: `1px solid ${rackSeverity ? SEVERITY_BORDER[rackSeverity] : "var(--hairline)"}`,
                borderRadius: 4,
                fontSize: 10.5,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>机柜 {rack.id}</div>
              <div style={{ color: "var(--t3)" }}>
                {rack.servers.length} 服务器 ·{" "}
                {rack.servers.reduce((a, s) => a + s.gpu_count, 0)} GPU
              </div>
              {rackSeverity && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 9.5,
                    color: SEVERITY_BORDER[rackSeverity],
                    fontWeight: 600,
                  }}
                >
                  {severities.length} 节点告警
                </div>
              )}
            </div>
          );
        })}
      </div>

      {bn && (
        <div
          style={{
            marginTop: 10, padding: "6px 10px",
            background: "var(--surface-2)", borderRadius: 4,
            fontSize: 11, color: "var(--t2)",
          }}
          data-testid="topology-thumbnail-bn-hint"
        >
          <div>⚠ 当前 run 主瓶颈：{bn.headline}</div>
          {/* S6.8 — link-level hint. The rack tiles only render
              node-level severity (servers); architects also want to know
              "which fabric link is the actual hot one". Show top
              high-severity links, capped at 2 to keep the thumbnail
              compact. */}
          {bn.links.length > 0 && (
            <div
              data-testid="topology-thumbnail-links-hint"
              style={{ marginTop: 4, color: "var(--t3)", fontSize: 10.5 }}
            >
              {bn.links.length} 条链路告警 ·{" "}
              {bn.links.slice(0, 2).map((l, i) => (
                <span key={l.id} className="mono">
                  {i > 0 && " · "}
                  {l.id}({l.util_pct.toFixed(0)}%)
                </span>
              ))}
              {bn.links.length > 2 && (
                <span className="mono"> +{bn.links.length - 2} 条</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
