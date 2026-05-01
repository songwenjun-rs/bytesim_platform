import { useMemo, useRef, useState } from "react";
import type { PaletteItem } from "./Palette";
import { computeRackStatus, type Cluster, type Rack, type Server, type ServerKind } from "../../api/specs";
import type { Selection } from "./Inspector";
import {
  type OverlayNode,
  type TopologyOverlay,
  summarizeOverlays,
} from "./overlays";

const NODE_SEVERITY_BORDER: Record<OverlayNode["severity"], string> = {
  high: "var(--red)",
  med:  "var(--orange)",
  low:  "var(--teal)",
};
const NODE_SEVERITY_BG: Record<OverlayNode["severity"], string> = {
  high: "var(--red-s)",
  med:  "var(--orange-s)",
  low:  "var(--teal-s)",
};

function buildOverlayNodeLookup(
  overlays: TopologyOverlay[] | undefined,
): Record<string, OverlayNode> {
  const out: Record<string, OverlayNode> = {};
  if (!overlays) return out;
  for (const o of overlays) {
    if (!o.nodes) continue;
    for (const [k, v] of Object.entries(o.nodes)) {
      out[k] = v;
    }
  }
  return out;
}

function lookupServerOverlay(
  lookup: Record<string, OverlayNode>,
  rackId: string,
  srvId: string,
): OverlayNode | null {
  return lookup[srvId] ?? lookup[`${rackId}.${srvId}`] ?? null;
}

type Props = {
  clusters: Cluster[];
  selection: Selection;
  onSelectServer: (clusterId: string, rackId: string, serverId: string) => void;
  onSelectRack: (clusterId: string, rackId: string) => void;
  onSelectCluster: (clusterId: string) => void;
  onAddServer: (rackId: string, server: Server) => void;
  onAddRack: (clusterId: string) => void;
  onAddCluster: () => void;
  onRemoveServer: (clusterId: string, rackId: string, serverId: string) => void;
  onRemoveRack: (clusterId: string, rackId: string) => void;
  onRemoveCluster: (clusterId: string) => void;
  overlays?: TopologyOverlay[];
};

const KIND_ICON: Record<ServerKind, string> = { cpu: "C", gpu: "G", memory: "M", storage: "S" };
// Status-driven coloring (rack tile only): ok → green, warn → yellow, fail → red.
const ICON_OK_BG = "rgba(72, 200, 116, 0.20)";
const ICON_OK_FG = "#48c874";
const ICON_WARN_BG = "rgba(255, 175, 64, 0.22)";
const ICON_WARN_FG = "#ffaf40";
const ICON_FAIL_BG = "rgba(255, 100, 100, 0.22)";
const ICON_FAIL_FG = "#ff7a70";

const trashBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: "2px 8px", marginLeft: 6,
  color: "var(--red)",
};

function isSelectedServer(selection: Selection, rackId: string, serverId: string) {
  return selection?.kind === "server" && selection.rackId === rackId && selection.serverId === serverId;
}
function isSelectedRack(selection: Selection, rackId: string) {
  return selection?.kind === "rack" && selection.rackId === rackId;
}
function isSelectedCluster(selection: Selection, clusterId: string) {
  return selection?.kind === "cluster" && selection.clusterId === clusterId;
}

export function RackCanvas({
  clusters, selection,
  onSelectServer, onSelectRack, onSelectCluster,
  onAddServer, onAddRack, onAddCluster,
  onRemoveServer, onRemoveRack, onRemoveCluster,
  overlays,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<string | null>(null);

  const racks = clusters.flatMap((c) => c.racks);
  const totalRacks = racks.length;
  const totalGPU = racks.reduce((a, r) => a + r.servers.reduce((s, srv) => s + srv.gpu_count, 0), 0);
  const totalSrv = racks.reduce((a, r) => a + r.servers.length, 0);
  const peakKw = racks.reduce((a, r) => a + r.servers.reduce((s, srv) => s + srv.tdp_kw * srv.gpu_count / 8, 0), 0);

  const overlaySummary = summarizeOverlays(overlays);
  const overlayNodeLookup = useMemo(
    () => buildOverlayNodeLookup(overlays),
    [overlays],
  );

  const handleDrop = (rackId: string, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const raw = e.dataTransfer.getData("application/x-bytesim-palette");
    if (!raw) return;
    const item = JSON.parse(raw) as PaletteItem;
    const rack = racks.find((r) => r.id === rackId);
    const idx = (rack?.servers.length ?? 0) + 1;
    // Include cluster id in the server prefix — rack IDs (R01, R02…) may
    // repeat across clusters now, but server IDs must stay globally unique.
    const cluster = clusters.find((c) => c.racks.some((r) => r.id === rackId));
    const prefix = cluster ? `${cluster.id.toLowerCase()}-${rackId.toLowerCase()}` : rackId.toLowerCase();
    const id = `srv-${prefix}-${idx}`;
    const t = item.template;
    onAddServer(rackId, {
      id,
      name: `${t.name || t.gpu_model} #${idx}`,
      kind: t.kind,
      gpu_model: t.gpu_model,
      gpu_count: t.gpu_count,
      nic: t.nic,
      tdp_kw: t.tdp_kw,
      status: "ok",
      cpu_model: t.cpu_model,
      cpu_sockets: t.cpu_sockets,
      ram_gb: t.ram_gb,
      storage_tb: t.storage_tb,
      ssd_model: t.ssd_model,
      disk_count: t.disk_count,
      disk_capacity_tb: t.disk_capacity_tb,
      gpu_mem_gb: t.gpu_mem_gb,
      form_factor: t.form_factor,
    });
  };

  const renderRack = (cluster: Cluster, rack: Rack) => (
    <div
      key={rack.id}
      className={`rack ${computeRackStatus(rack) === "empty" ? "empty" : ""} ${isSelectedRack(selection, rack.id) ? "sel" : ""}`}
      data-testid={`rack-${rack.id}`}
      onClick={(e) => { e.stopPropagation(); onSelectRack(cluster.id, rack.id); }}
    >
      <div className="rack-hd" style={{ display: "block", marginBottom: 10 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 11, color: "var(--t3)", fontWeight: 400,
        }}>
          <span style={{ flex: 1 }}>{rack.id}</span>
          {(() => {
            const st = computeRackStatus(rack);
            const cls = st === "fail" ? "red" : st === "warn" ? "orange" : st === "empty" ? "white" : "green";
            const label = st === "fail" ? "故障" : st === "warn" ? "告警" : st === "empty" ? "空位" : "健康";
            return <span className={`tag tag-${cls}`}>{label}</span>;
          })()}
          <button
            className="btn btn-ghost"
            style={trashBtnStyle}
            onClick={(e) => { e.stopPropagation(); onRemoveRack(cluster.id, rack.id); }}
            title="删除该机柜"
            data-testid={`topology-remove-rack-${rack.id}`}
          >
            🗑
          </button>
        </div>
        {rack.name && (
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--t1)", marginTop: 3 }}>
            {rack.name}
          </div>
        )}
      </div>
      {rack.servers.map((srv, i) => {
        const ov = lookupServerOverlay(overlayNodeLookup, rack.id, srv.id);
        const overlayStyle = ov
          ? {
              borderLeft: `3px solid ${NODE_SEVERITY_BORDER[ov.severity]}`,
              background: NODE_SEVERITY_BG[ov.severity],
            }
          : undefined;
        const k: ServerKind = srv.kind ?? "gpu";
        const iconBg =
          srv.status === "fail" ? ICON_FAIL_BG :
          srv.status === "warn" ? ICON_WARN_BG :
          ICON_OK_BG;
        const iconFg =
          srv.status === "fail" ? ICON_FAIL_FG :
          srv.status === "warn" ? ICON_WARN_FG :
          ICON_OK_FG;
        const statusHint =
          srv.status === "fail" ? " · 故障" :
          srv.status === "warn" ? " · 告警" : "";
        return (
          <div
            key={srv.id}
            className={`server ${isSelectedServer(selection, rack.id, srv.id) ? "sel" : ""}`}
            onClick={(e) => { e.stopPropagation(); onSelectServer(cluster.id, rack.id, srv.id); }}
            style={{
              ...overlayStyle,
              position: "relative",
              gridTemplateColumns: "auto 1fr auto",
              gridTemplateRows: "auto auto",
              alignItems: "center",
              rowGap: 4,
              padding: "10px",
              paddingRight: 24,
              minHeight: 56,
            }}
            data-testid={`rack-server-${srv.id}`}
            data-overlay-severity={ov?.severity}
            title={ov ? `${ov.badge ?? ov.tooltip ?? "瓶颈"} · ${ov.tooltip ?? ""}` : undefined}
          >
            <span
              style={{
                gridColumn: 1, gridRow: "1 / 3",
                width: 22, height: 22, borderRadius: 5,
                background: iconBg, color: iconFg,
                display: "inline-grid", placeItems: "center",
                alignSelf: "center",
                fontSize: 11, fontWeight: 700,
              }}
              title={`服务器类型：${k}${statusHint}`}
            >
              {KIND_ICON[k]}
            </span>
            <div style={{ gridColumn: 2, gridRow: 1, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--t3)", fontSize: 10.5 }}>
                S{String(i + 1).padStart(2, "0")}
              </span>
              {ov?.badge && (
                <span
                  className={`tag tag-${ov.severity === "high" ? "red" : ov.severity === "med" ? "orange" : "teal"}`}
                  style={{ fontSize: 9.5 }}
                  data-testid={`rack-server-${srv.id}-badge`}
                >
                  {ov.badge}
                </span>
              )}
            </div>
            <div className="gpu-chip" style={{ gridColumn: 3, gridRow: 1 }}>
              {Array.from({ length: srv.gpu_count }).map((_, j) => (
                <span key={j} className={srv.status === "warn" && j < 2 ? "hot" : undefined} />
              ))}
            </div>
            <div style={{
              gridColumn: "2 / -1", gridRow: 2,
              fontWeight: 600, wordBreak: "break-word",
            }}>
              {srv.name || srv.id}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveServer(cluster.id, rack.id, srv.id); }}
              title="删除该服务器"
              data-testid={`topology-remove-server-${srv.id}`}
              style={{
                position: "absolute", right: 6, bottom: 6,
                fontSize: 11, padding: "0 4px", lineHeight: 1,
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--red)",
              }}
            >
              🗑
            </button>
          </div>
        );
      })}
      <div
        className={`rack-drop ${over === rack.id ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(rack.id); }}
        onDragLeave={() => setOver((s) => (s === rack.id ? null : s))}
        onDrop={(e) => handleDrop(rack.id, e)}
      >
        + 拖入服务器
      </div>
    </div>
  );

  return (
    <div className="canvas" ref={ref}>
      <div className="canvas-hd">
        <div style={{ color: "var(--t2)" }}>
          <strong>{clusters.length} 集群</strong> · {totalRacks} 机柜 · {totalSrv} 服务器 · {totalGPU} GPU · 峰值 {peakKw.toFixed(0)} kW
        </div>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 11, padding: "4px 10px" }}
          onClick={onAddCluster}
          data-testid="topology-add-cluster"
        >
          + 新建集群
        </button>
      </div>
      {overlaySummary && (
        <div
          className="tag tag-orange"
          style={{ margin: "6px 0 10px", display: "inline-block" }}
          data-testid="rack-overlay-legend"
          title={overlays?.map((o) => o.legend).join(" · ")}
        >
          叠加 · {overlaySummary}
        </div>
      )}
      {clusters.length === 0 && (
        <div style={{ padding: "20px 12px", color: "var(--t3)", fontSize: 12 }}>
          当前数据中心没有集群。点击右上「+ 新建集群」开始。
        </div>
      )}
      {clusters.map((cluster, ci) => (
        <div
          key={cluster.id}
          className={`card cluster-card ${isSelectedCluster(selection, cluster.id) ? "sel" : ""}`}
          style={{ marginBottom: 14, padding: 12 }}
          data-testid={`cluster-section-${cluster.id}`}
          onClick={(e) => { e.stopPropagation(); onSelectCluster(cluster.id); }}
        >
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "flex-start",
            gap: 10, marginBottom: 10,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--t3)" }}>
                C{String(ci + 1).padStart(2, "0")}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", marginTop: 2 }}>
                {cluster.name}
              </div>
            </div>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: "4px 10px" }}
              onClick={(e) => { e.stopPropagation(); onAddRack(cluster.id); }}
              data-testid={`topology-add-rack-${cluster.id}`}
            >
              + 新建机柜
            </button>
            <button
              className="btn btn-ghost"
              style={trashBtnStyle}
              onClick={(e) => { e.stopPropagation(); onRemoveCluster(cluster.id); }}
              title="删除该集群"
              data-testid={`topology-remove-cluster-${cluster.id}`}
            >
              🗑
            </button>
          </div>
          {cluster.racks.length === 0 ? (
            <div style={{ padding: "12px", color: "var(--t3)", fontSize: 12 }}>
              该集群下还没有机柜。
            </div>
          ) : (
            <div className="rack-grid">{cluster.racks.map((r) => renderRack(cluster, r))}</div>
          )}
        </div>
      ))}
    </div>
  );
}
