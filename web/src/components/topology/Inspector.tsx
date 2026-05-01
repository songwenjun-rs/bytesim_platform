import { computeRackStatus } from "../../api/specs";
import type {
  Cluster, ClusterPurpose, CoolingKind,
  IntraTopology, Leaf, Rack, Rail,
  ScaleOutFabric, ScaleOutKind, ScaleOutTopology,
  ScaleUpDomain, ScaleUpKind,
  Server, ServerKind, ServerTemplate, Spine, Uplink,
} from "../../api/specs";
import { partLabel, type HwPart } from "../../lib/hardwareParts";
import { useCatalogItems } from "../../api/catalogItems";

export type Selection =
  | { kind: "server"; clusterId: string; rackId: string; serverId: string }
  | { kind: "rack"; clusterId: string; rackId: string }
  | { kind: "cluster"; clusterId: string }
  | { kind: "template"; templateId: string }
  | { kind: "spine"; fabricId: string; spineId: string }
  | { kind: "leaf"; clusterId: string; rackId: string; leafId: string }
  | { kind: "scale_out_fabric"; fabricId: string }
  | { kind: "scale_up_domain"; clusterId: string; domainId: string }
  | { kind: "link"; clusterId: string; rackId: string; leafId: string; spineId: string }
  | { kind: "rail"; fabricId: string; railId: string }
  | null;

type Props = {
  selection: Selection;
  clusters: Cluster[];
  templates: ServerTemplate[];
  onChangeServer: (
    clusterId: string,
    rackId: string,
    serverId: string,
    field: keyof Server,
    value: any,
  ) => void;
  onChangeRack: (
    clusterId: string,
    rackId: string,
    field: keyof Rack,
    value: any,
  ) => void;
  onChangeCluster: (
    clusterId: string,
    field: keyof Cluster,
    value: any,
  ) => void;
  onChangeTemplate: (
    templateId: string,
    field: keyof ServerTemplate,
    value: any,
  ) => void;
  // Scale-out fabric / spine / leaf editing (Step 3)
  fabrics: ScaleOutFabric[];
  onChangeFabric: (fabricId: string, field: keyof ScaleOutFabric, value: any) => void;
  onRemoveFabric: (fabricId: string) => void;
  onChangeSpine: (fabricId: string, spineId: string, field: keyof Spine, value: any) => void;
  onRemoveSpine: (fabricId: string, spineId: string) => void;
  onChangeLeaf: (
    clusterId: string, rackId: string, leafId: string,
    field: keyof Leaf, value: any,
  ) => void;
  onRemoveLeaf: (clusterId: string, rackId: string, leafId: string) => void;
  onAddUplink: (clusterId: string, rackId: string, leafId: string, spineId: string) => void;
  onRemoveUplink: (clusterId: string, rackId: string, leafId: string, spineId: string) => void;
  onChangeUplink: (
    clusterId: string, rackId: string, leafId: string, spineId: string,
    field: keyof Uplink, value: any,
  ) => void;
  // Scale-up domain editing (Step 4)
  onChangeDomain: (clusterId: string, domainId: string, field: keyof ScaleUpDomain, value: any) => void;
  onRemoveDomain: (clusterId: string, domainId: string) => void;
  onAddMember: (clusterId: string, domainId: string, serverId: string) => void;
  onRemoveMember: (clusterId: string, domainId: string, serverId: string) => void;
  // Rail editing (Step 6)
  onAddRail: (fabricId: string) => void;
  onRemoveRail: (fabricId: string, railId: string) => void;
  onChangeRail: (fabricId: string, railId: string, field: keyof Rail, value: any) => void;
  onSelectRail: (fabricId: string, railId: string) => void;
  onToggleRailSpine: (fabricId: string, railId: string, spineId: string) => void;
};

const STATUS_CHOICES: Server["status"][] = ["ok", "warn", "fail"];

/** Build the option list for a part dropdown.
 *  Catalog-only — values not in 硬件部件 仓库 are not selectable. The user
 *  must pick a catalog row; stale legacy values display as the raw string
 *  but the dropdown won't let you re-pick them. */
function partOptions(parts: HwPart[]): { value: string; label: string }[] {
  return parts.map((p) => ({ value: String(p.model), label: partLabel(p) }));
}
const KIND_CHOICES: { value: ServerKind; label: string }[] = [
  { value: "cpu", label: "CPU 服务器" },
  { value: "gpu", label: "GPU 服务器" },
  { value: "memory", label: "内存服务器" },
  { value: "storage", label: "存储服务器" },
];
const FABRIC_KIND_CHOICES: ScaleOutKind[] = ["infiniband", "roce", "ethernet", "slingshot"];
const FABRIC_TOPOLOGY_CHOICES: ScaleOutTopology[] = ["spine-leaf", "fat-tree", "rail-optimized", "dragonfly"];
const NODE_STATUS_CHOICES: Spine["status"][] = ["ok", "warn", "fail"];
const SCALE_UP_KIND_CHOICES: ScaleUpKind[] = ["nvlink", "nvlink-switch", "cxl"];
const INTRA_TOPOLOGY_CHOICES: IntraTopology[] = ["full-mesh", "switch", "ring", "hypercube", "torus"];
const COOLING_CHOICES: CoolingKind[] = ["风冷", "液冷", "直接液冷"];
const PURPOSE_CHOICES: ClusterPurpose[] = ["训练", "推理", "混合", "实验"];
const TOPOLOGY_CHOICES = ["spine-leaf", "fat-tree", "dragonfly", "rail-optimized"];

function serverStorageTb(s: Server): number {
  if (s.kind === "storage" && s.disk_count && s.disk_capacity_tb) {
    return s.disk_count * s.disk_capacity_tb;
  }
  return s.storage_tb ?? 0;
}
function rackPeakKw(rack: Rack): number {
  // Same heuristic SummaryBar uses: TDP × (gpu_count / 8) for GPU nodes,
  // straight TDP for non-GPU nodes (avoid div-by-zero).
  return rack.servers.reduce((a, srv) => {
    const factor = srv.gpu_count > 0 ? srv.gpu_count / 8 : 1;
    return a + (srv.tdp_kw ?? 0) * factor;
  }, 0);
}

const inputStyle: React.CSSProperties = { width: "100%" };

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-sec">
      <div className="form-l">{label}</div>
      {children}
    </div>
  );
}

function EmptyInspector() {
  return (
    <div className="inspector">
      <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 8 }}>
        已选中
      </div>
      <div style={{ color: "var(--t3)", fontSize: 12 }}>
        点击集群、机柜或服务器查看 / 编辑基本信息
      </div>
    </div>
  );
}

export function Inspector({
  selection, clusters, templates, fabrics,
  onChangeServer, onChangeRack, onChangeCluster, onChangeTemplate,
  onChangeFabric, onRemoveFabric,
  onChangeSpine, onRemoveSpine,
  onChangeLeaf, onRemoveLeaf,
  onAddUplink, onRemoveUplink, onChangeUplink,
  onChangeDomain, onRemoveDomain, onAddMember, onRemoveMember,
  onAddRail, onRemoveRail, onChangeRail, onSelectRail, onToggleRailSpine,
}: Props) {
  // 硬件部件 — read live from bs_catalog via React Query.
  const cpuQ = useCatalogItems("cpu");
  const gpuQ = useCatalogItems("gpu");
  const nicQ = useCatalogItems("nic");
  const ssdQ = useCatalogItems("ssd");
  const toParts = (q: { data?: { id: string; body: unknown }[] }): HwPart[] =>
    (q.data ?? []).map((it) => ({ id: it.id, ...(it.body as Record<string, string | number>) }));
  const cpuParts = toParts(cpuQ);
  const gpuParts = toParts(gpuQ);
  const nicParts = toParts(nicQ);
  const ssdParts = toParts(ssdQ);

  if (!selection) return <EmptyInspector />;

  if (selection.kind === "scale_up_domain") {
    const cluster = clusters.find((c) => c.id === selection.clusterId);
    const domain = cluster?.scale_up_domains?.find((d) => d.id === selection.domainId);
    if (!cluster || !domain) return <div className="inspector"><div style={{ color: "var(--t3)", fontSize: 12 }}>所选 Scale-up 域已不存在</div></div>;
    const setD = (field: keyof ScaleUpDomain, v: any) => onChangeDomain(cluster.id, domain.id, field, v);
    // Member resolution → derived stats
    const memberServers = domain.members
      .map((m) => {
        for (const r of cluster.racks) {
          const s = r.servers.find((sv) => sv.id === m.server_id);
          if (s) return { server: s, rack: r };
        }
        return null;
      })
      .filter((x): x is { server: Server; rack: Rack } => x !== null);
    const totalGpu = memberServers.reduce((a, m) => a + m.server.gpu_count, 0);
    const racksSpanned = new Set(memberServers.map((m) => m.rack.id)).size;
    const ro = { color: "var(--t2)", fontSize: 13 };
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · Scale-up 域
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {domain.name?.trim() || domain.id}
          <span style={{ color: "var(--t3)", fontSize: 12, marginLeft: 8 }}>
            · 集群 {cluster.name || cluster.id}
          </span>
        </div>
        <FieldRow label="名称">
          <input className="inp" style={inputStyle} value={domain.name}
            onChange={(e) => setD("name", e.target.value)} />
        </FieldRow>
        <FieldRow label="介质">
          <select className="inp" value={domain.kind}
            onChange={(e) => setD("kind", e.target.value as ScaleUpKind)}>
            {SCALE_UP_KIND_CHOICES.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="链路带宽 (GB/s)">
          <input className="inp" type="number" min={0} value={domain.bandwidth_gbps}
            onChange={(e) => setD("bandwidth_gbps", Math.max(0, parseInt(e.target.value || "0", 10)))} />
        </FieldRow>
        <FieldRow label="域内拓扑">
          <select className="inp" value={domain.intra_topology ?? "full-mesh"}
            onChange={(e) => setD("intra_topology", e.target.value as IntraTopology)}>
            {INTRA_TOPOLOGY_CHOICES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </FieldRow>
        {(domain.intra_topology ?? "full-mesh") === "switch" && (
          <FieldRow label="交换芯片数 (NVSwitch)">
            <input className="inp" type="number" min={0} value={domain.switch_count ?? 0}
              onChange={(e) => setD("switch_count", Math.max(0, parseInt(e.target.value || "0", 10)))} />
          </FieldRow>
        )}
        <FieldRow label="成员 server 数"><div style={ro}>{memberServers.length}</div></FieldRow>
        <FieldRow label="GPU 总数"><div style={ro}>{totalGpu}</div></FieldRow>
        <FieldRow label="跨机柜数"><div style={ro}>{racksSpanned}</div></FieldRow>

        <div className="form-sec">
          <div className="form-l">成员</div>
          {memberServers.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--t3)", padding: "4px 0" }}>该域还没有成员。</div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {memberServers.map((m) => (
              <span key={m.server.id} style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "3px 6px", borderRadius: 999, fontSize: 11,
                background: "var(--bg-3)", border: "1px solid var(--hairline)", color: "var(--t2)",
              }}>
                <span className="mono" style={{ color: "var(--t3)", fontSize: 10 }}>{m.rack.id}</span>
                <span>{m.server.name?.trim() || m.server.id}</span>
                <button
                  style={{ background: "transparent", border: "none", color: "var(--red)",
                    cursor: "pointer", fontSize: 11, padding: 0 }}
                  onClick={() => onRemoveMember(cluster.id, domain.id, m.server.id)}
                  title="从该域移除"
                >✕</button>
              </span>
            ))}
          </div>
          {/* Add picker — list cluster servers not yet in this domain (gpu-bearing first) */}
          {(() => {
            const inThis = new Set(domain.members.map((m) => m.server_id));
            const candidates: { server: Server; rackId: string; inOther: boolean }[] = [];
            const inOther = new Set<string>();
            for (const od of cluster.scale_up_domains ?? []) {
              if (od.id === domain.id) continue;
              for (const om of od.members) inOther.add(om.server_id);
            }
            for (const r of cluster.racks) {
              for (const s of r.servers) {
                if (inThis.has(s.id)) continue;
                if (s.gpu_count <= 0) continue;
                candidates.push({ server: s, rackId: r.id, inOther: inOther.has(s.id) });
              }
            }
            if (candidates.length === 0) return null;
            return (
              <select
                className="inp" defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    onAddMember(cluster.id, domain.id, e.target.value);
                    e.target.value = "";
                  }
                }}
                style={{ fontSize: 11, padding: "4px 6px", marginTop: 6 }}
              >
                <option value="">+ 加 server 到该域…</option>
                {candidates.map((c) => (
                  <option key={c.server.id} value={c.server.id}>
                    {c.rackId} · {c.server.name?.trim() || c.server.id} · {c.server.gpu_count}× {c.server.gpu_model}
                    {c.inOther ? "  ⤴(从其他域移走)" : ""}
                  </option>
                ))}
              </select>
            );
          })()}
        </div>

        <button className="btn btn-ghost" style={{ marginTop: 6, color: "var(--red)" }}
          onClick={() => onRemoveDomain(cluster.id, domain.id)}>
          🗑 删除该 Scale-up 域（成员变成"未分配"）
        </button>
      </div>
    );
  }

  if (selection.kind === "link") {
    const cluster = clusters.find((c) => c.id === selection.clusterId);
    const rack = cluster?.racks.find((r) => r.id === selection.rackId);
    const leaf = rack?.leaves?.find((x) => x.id === selection.leafId);
    const uplink = leaf?.uplinks.find((u) => u.spine === selection.spineId);
    if (!cluster || !rack || !leaf || !uplink) {
      return <div className="inspector"><div style={{ color: "var(--t3)", fontSize: 12 }}>所选链路已不存在</div></div>;
    }
    const fabric = fabrics.find((f) => f.id === leaf.fabric_id);
    const spine = fabric?.spines.find((s) => s.id === uplink.spine);
    const setU = (field: keyof Uplink, v: any) =>
      onChangeUplink(cluster.id, rack.id, leaf.id, uplink.spine, field, v);
    const lanes = uplink.lanes ?? 1;
    const bw = uplink.bandwidth_gbps ?? spine?.bandwidth_per_port_gbps ?? 0;
    const totalBw = lanes * bw;
    const ro = { color: "var(--t2)", fontSize: 13 };
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · 链路
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          {uplink.spine} <span style={{ color: "var(--t3)" }}>↔</span> {leaf.id}
        </div>
        <FieldRow label="对端 Spine">
          <select className="inp" value={uplink.spine}
            onChange={(e) => {
              // re-target: remove + add
              if (e.target.value !== uplink.spine) {
                onRemoveUplink(cluster.id, rack.id, leaf.id, uplink.spine);
                onAddUplink(cluster.id, rack.id, leaf.id, e.target.value);
              }
            }}>
            {(fabric?.spines ?? []).map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="聚合度 (lanes)">
          <input className="inp" type="number" min={1} max={32} value={lanes}
            onChange={(e) => setU("lanes", Math.max(1, parseInt(e.target.value || "1", 10)))} />
        </FieldRow>
        <FieldRow label="单 lane 带宽 (Gbps)">
          <input className="inp" type="number" min={0} value={uplink.bandwidth_gbps ?? bw}
            onChange={(e) => setU("bandwidth_gbps", Math.max(0, parseInt(e.target.value || "0", 10)))} />
        </FieldRow>
        <FieldRow label="合计带宽"><div style={ro}>{totalBw} Gbps ({lanes}×{bw}G)</div></FieldRow>
        <FieldRow label="利用率 (%)">
          <input className="inp" type="number" min={0} max={100} value={uplink.util_pct ?? 0}
            onChange={(e) => setU("util_pct", Math.max(0, Math.min(100, parseInt(e.target.value || "0", 10))))} />
        </FieldRow>
        <FieldRow label="状态">
          <label style={{ display: "flex", gap: 6, fontSize: 12, color: "var(--t2)" }}>
            <input type="checkbox" checked={uplink.down ?? false}
              onChange={(e) => setU("down", e.target.checked)} />
            标记为离线 (down)
          </label>
        </FieldRow>
        <button className="btn btn-ghost" style={{ marginTop: 6, color: "var(--red)" }}
          onClick={() => onRemoveUplink(cluster.id, rack.id, leaf.id, uplink.spine)}>
          🗑 删除该链路
        </button>
      </div>
    );
  }

  if (selection.kind === "rail") {
    const f = fabrics.find((x) => x.id === selection.fabricId);
    const rail = f?.rails?.find((r) => r.id === selection.railId);
    if (!f || !rail) {
      return <div className="inspector"><div style={{ color: "var(--t3)", fontSize: 12 }}>所选 Rail 已不存在</div></div>;
    }
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · Rail
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {rail.name?.trim() || rail.id}
          <span style={{ color: "var(--t3)", fontSize: 12, marginLeft: 8 }}>· {f.name}</span>
        </div>
        <FieldRow label="Rail 名称">
          <input className="inp" style={inputStyle} value={rail.name}
            onChange={(e) => onChangeRail(f.id, rail.id, "name", e.target.value)} />
        </FieldRow>
        <div className="form-sec">
          <div className="form-l">归属 Spine（可多选）</div>
          {f.spines.length === 0 && <div style={{ fontSize: 11, color: "var(--t3)" }}>该网络还没有 spine。</div>}
          {f.spines.map((s) => {
            const checked = rail.spine_ids.includes(s.id);
            return (
              <label key={s.id} style={{
                display: "flex", alignItems: "center", gap: 6,
                fontSize: 12, color: "var(--t2)", marginBottom: 3,
              }}>
                <input type="checkbox" checked={checked}
                  onChange={() => onToggleRailSpine(f.id, rail.id, s.id)} />
                <span className="mono">{s.id}</span>
                {s.name && <span style={{ color: "var(--t3)", fontSize: 11 }}>· {s.name}</span>}
              </label>
            );
          })}
        </div>
        <button className="btn btn-ghost" style={{ marginTop: 6, color: "var(--red)" }}
          onClick={() => onRemoveRail(f.id, rail.id)}>
          🗑 删除该 Rail
        </button>
      </div>
    );
  }

  if (selection.kind === "scale_out_fabric") {
    const f = fabrics.find((x) => x.id === selection.fabricId);
    if (!f) return <div className="inspector"><div style={{ color: "var(--t3)", fontSize: 12 }}>所选网络已不存在</div></div>;
    const totalLeaves = clusters.flatMap(c => c.racks).flatMap(r => r.leaves ?? []).filter(l => l.fabric_id === f.id).length;
    const totalLinks = clusters.flatMap(c => c.racks).flatMap(r => r.leaves ?? [])
      .filter(l => l.fabric_id === f.id).reduce((a, l) => a + l.uplinks.length, 0);
    const ro = { color: "var(--t2)", fontSize: 13 };
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · Scale-out 网络
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {f.name?.trim() || "未命名"}
        </div>
        <FieldRow label="名称">
          <input className="inp" style={inputStyle} value={f.name}
            onChange={(e) => onChangeFabric(f.id, "name", e.target.value)} />
        </FieldRow>
        <FieldRow label="介质">
          <select className="inp" value={f.kind}
            onChange={(e) => onChangeFabric(f.id, "kind", e.target.value as ScaleOutKind)}>
            {FABRIC_KIND_CHOICES.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="拓扑">
          <select className="inp" value={f.topology}
            onChange={(e) => onChangeFabric(f.id, "topology", e.target.value as ScaleOutTopology)}>
            {FABRIC_TOPOLOGY_CHOICES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="Spine 数"><div style={ro}>{f.spines.length}</div></FieldRow>
        <FieldRow label="Leaf 数"><div style={ro}>{totalLeaves}</div></FieldRow>
        <FieldRow label="链路数"><div style={ro}>{totalLinks}</div></FieldRow>
        <div className="form-sec">
          <div className="form-l">Rails（{(f.rails ?? []).length}）</div>
          {(f.rails ?? []).map((r) => (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 8px", marginBottom: 3,
              border: "1px solid var(--hairline)", borderRadius: 4,
              fontSize: 11.5, cursor: "pointer",
            }} onClick={() => onSelectRail(f.id, r.id)}>
              <span style={{ flex: 1 }}>{r.name?.trim() || r.id}</span>
              <span style={{ color: "var(--t3)", fontSize: 10.5 }}>{r.spine_ids.length} spine</span>
            </div>
          ))}
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 8px", width: "100%" }}
            onClick={() => onAddRail(f.id)}>+ 新建 Rail</button>
        </div>
        <button className="btn btn-ghost" style={{ marginTop: 6, color: "var(--red)" }}
          onClick={() => onRemoveFabric(f.id)}>
          🗑 删除整个网络（含所有 spine/leaf/上联/rail）
        </button>
      </div>
    );
  }

  if (selection.kind === "spine") {
    const f = fabrics.find((x) => x.id === selection.fabricId);
    const s = f?.spines.find((x) => x.id === selection.spineId);
    if (!f || !s) return <div className="inspector"><div style={{ color: "var(--t3)", fontSize: 12 }}>所选 spine 已不存在</div></div>;
    const setS = (field: keyof Spine, v: any) => onChangeSpine(f.id, s.id, field, v);
    const connectedLeaves = clusters.flatMap(c => c.racks).flatMap(r => r.leaves ?? [])
      .filter(l => l.fabric_id === f.id && l.uplinks.some(u => u.spine === s.id));
    const ro = { color: "var(--t2)", fontSize: 13 };
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · Spine
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {s.name?.trim() || s.id}
          <span style={{ color: "var(--t3)", fontSize: 12, marginLeft: 8 }}>· {f.name}</span>
        </div>
        <FieldRow label="名称">
          <input className="inp" style={inputStyle} value={s.name ?? ""}
            onChange={(e) => setS("name", e.target.value)} />
        </FieldRow>
        <FieldRow label="状态">
          <select className="inp" value={s.status}
            onChange={(e) => setS("status", e.target.value as Spine["status"])}>
            {NODE_STATUS_CHOICES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="端口数">
          <input className="inp" type="number" min={0} value={s.port_count ?? 0}
            onChange={(e) => setS("port_count", Math.max(0, parseInt(e.target.value || "0", 10)))} />
        </FieldRow>
        <FieldRow label="单端口带宽 (Gbps)">
          <input className="inp" type="number" min={0} value={s.bandwidth_per_port_gbps ?? 0}
            onChange={(e) => setS("bandwidth_per_port_gbps", Math.max(0, parseInt(e.target.value || "0", 10)))} />
        </FieldRow>
        <FieldRow label="已连接 Leaf 数"><div style={ro}>{connectedLeaves.length}</div></FieldRow>
        <button className="btn btn-ghost" style={{ marginTop: 6, color: "var(--red)" }}
          onClick={() => onRemoveSpine(f.id, s.id)}>
          🗑 删除该 spine（同时清除所有引用它的上联）
        </button>
      </div>
    );
  }

  if (selection.kind === "leaf") {
    const cluster = clusters.find((c) => c.id === selection.clusterId);
    const rack = cluster?.racks.find((r) => r.id === selection.rackId);
    const leaf = rack?.leaves?.find((x) => x.id === selection.leafId);
    if (!cluster || !rack || !leaf) return <div className="inspector"><div style={{ color: "var(--t3)", fontSize: 12 }}>所选 leaf 已不存在</div></div>;
    const fabric = fabrics.find((f) => f.id === leaf.fabric_id);
    const setL = (field: keyof Leaf, v: any) => onChangeLeaf(cluster.id, rack.id, leaf.id, field, v);
    const connectedSpineIds = new Set(leaf.uplinks.map((u) => u.spine));
    const candidateSpines = (fabric?.spines ?? []).filter((s) => !connectedSpineIds.has(s.id));
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · Leaf
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {leaf.name?.trim() || leaf.id}
          <span style={{ color: "var(--t3)", fontSize: 12, marginLeft: 8 }}>· 机柜 {rack.id}</span>
        </div>
        <FieldRow label="名称">
          <input className="inp" style={inputStyle} value={leaf.name ?? ""}
            onChange={(e) => setL("name", e.target.value)} />
        </FieldRow>
        <FieldRow label="所属网络">
          <select className="inp" value={leaf.fabric_id}
            onChange={(e) => setL("fabric_id", e.target.value)}>
            {fabrics.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.id})</option>)}
          </select>
        </FieldRow>
        <FieldRow label="状态">
          <select className="inp" value={leaf.status}
            onChange={(e) => setL("status", e.target.value as Leaf["status"])}>
            {NODE_STATUS_CHOICES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="端口数">
          <input className="inp" type="number" min={0} value={leaf.port_count ?? 0}
            onChange={(e) => setL("port_count", Math.max(0, parseInt(e.target.value || "0", 10)))} />
        </FieldRow>
        <FieldRow label="单端口带宽 (Gbps)">
          <input className="inp" type="number" min={0} value={leaf.bandwidth_per_port_gbps ?? 0}
            onChange={(e) => setL("bandwidth_per_port_gbps", Math.max(0, parseInt(e.target.value || "0", 10)))} />
        </FieldRow>
        <div className="form-sec">
          <div className="form-l">上联（spine）</div>
          {leaf.uplinks.length === 0 && (
            <div style={{ color: "var(--t3)", fontSize: 11.5, padding: "4px 0" }}>该 leaf 还没有上联。</div>
          )}
          {leaf.uplinks.map((up) => (
            <div key={up.spine} style={{
              display: "grid", gridTemplateColumns: "1fr 70px 50px auto",
              gap: 6, alignItems: "center", marginBottom: 4, fontSize: 11.5,
            }}>
              <span className="mono" style={{ color: "var(--t2)" }}>{up.spine}</span>
              <input className="inp" style={{ padding: "4px 6px", fontSize: 11 }}
                type="number" min={0} max={100} value={up.util_pct ?? 0}
                onChange={(e) => onChangeUplink(cluster.id, rack.id, leaf.id, up.spine, "util_pct", Math.max(0, Math.min(100, parseInt(e.target.value || "0", 10))))} />
              <label style={{ color: "var(--t3)", fontSize: 10.5, display: "flex", alignItems: "center", gap: 3 }}>
                <input type="checkbox" checked={up.down ?? false}
                  onChange={(e) => onChangeUplink(cluster.id, rack.id, leaf.id, up.spine, "down", e.target.checked)} />
                down
              </label>
              <button style={{ background: "transparent", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 11 }}
                onClick={() => onRemoveUplink(cluster.id, rack.id, leaf.id, up.spine)}
                title="删除该上联">🗑</button>
            </div>
          ))}
          {candidateSpines.length > 0 && (
            <select className="inp" defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  onAddUplink(cluster.id, rack.id, leaf.id, e.target.value);
                  e.target.value = "";  // reset
                }
              }}
              style={{ marginTop: 4, fontSize: 11 }}>
              <option value="">+ 加上联到 spine…</option>
              {candidateSpines.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
            </select>
          )}
        </div>
        <button className="btn btn-ghost" style={{ marginTop: 6, color: "var(--red)" }}
          onClick={() => onRemoveLeaf(cluster.id, rack.id, leaf.id)}>
          🗑 删除该 leaf
        </button>
      </div>
    );
  }

  if (selection.kind === "template") {
    const t = templates.find((x) => x.id === selection.templateId);
    if (!t) {
      return (
        <div className="inspector">
          <div style={{ color: "var(--t3)", fontSize: 12 }}>所选服务器已不存在</div>
        </div>
      );
    }
    const setT = (f: keyof ServerTemplate, v: any) => onChangeTemplate(t.id, f, v);
    const k = t.kind ?? "gpu";
    const showGpu = k === "gpu";
    const showStorageDisks = k === "storage";
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · 服务器
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {t.name?.trim() || "未命名"}
        </div>
        <FieldRow label="名称">
          <input className="inp" style={inputStyle} value={t.name}
            onChange={(e) => setT("name", e.target.value)} />
        </FieldRow>
        <FieldRow label="类型">
          <select className="inp" value={k}
            onChange={(e) => setT("kind", e.target.value as ServerKind)}>
            {KIND_CHOICES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="CPU 型号">
          <select className="inp" value={t.cpu_model ?? ""}
            onChange={(e) => setT("cpu_model", e.target.value)}>
            <option value="">— 未选 —</option>
            {partOptions(cpuParts).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="CPU 路数">
          <input className="inp" type="number" min={1} max={8} value={t.cpu_sockets ?? 2}
            onChange={(e) => setT("cpu_sockets", Math.max(1, parseInt(e.target.value || "2", 10)))} />
        </FieldRow>
        <FieldRow label="内存 (GB)">
          <input className="inp" type="number" min={0} value={t.ram_gb ?? 0}
            onChange={(e) => setT("ram_gb", Math.max(0, parseInt(e.target.value || "0", 10)))} />
        </FieldRow>
        {showGpu && (
          <>
            <FieldRow label="GPU 型号">
              <select className="inp" value={t.gpu_model}
                onChange={(e) => setT("gpu_model", e.target.value)}>
                {partOptions(gpuParts).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="GPU 数">
              <input className="inp" type="number" min={0} max={16} value={t.gpu_count}
                onChange={(e) => setT("gpu_count", Math.max(0, Math.min(16, parseInt(e.target.value || "0", 10))))} />
            </FieldRow>
            <FieldRow label="单卡 HBM (GB)">
              <input className="inp" type="number" min={0} value={t.gpu_mem_gb ?? 0}
                onChange={(e) => setT("gpu_mem_gb", Math.max(0, parseInt(e.target.value || "0", 10)))} />
            </FieldRow>
          </>
        )}
        <FieldRow label="网卡">
          <select className="inp" value={t.nic}
            onChange={(e) => setT("nic", e.target.value)}>
            {partOptions(nicParts).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="SSD 型号">
          <select className="inp" value={t.ssd_model ?? ""}
            onChange={(e) => setT("ssd_model", e.target.value)}>
            <option value="">— 未选 —</option>
            {partOptions(ssdParts).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </FieldRow>
        {showStorageDisks ? (
          <>
            <FieldRow label="盘的数量">
              <input className="inp" type="number" min={0} value={t.disk_count ?? 0}
                onChange={(e) => setT("disk_count", Math.max(0, parseInt(e.target.value || "0", 10)))} />
            </FieldRow>
            <FieldRow label="单盘容量 (TB)">
              <input className="inp" type="number" min={0} step={0.1} value={t.disk_capacity_tb ?? 0}
                onChange={(e) => setT("disk_capacity_tb", Math.max(0, parseFloat(e.target.value || "0")))} />
            </FieldRow>
          </>
        ) : (
          <FieldRow label="本地存储 (TB)">
            <input className="inp" type="number" min={0} step={0.1} value={t.storage_tb ?? 0}
              onChange={(e) => setT("storage_tb", Math.max(0, parseFloat(e.target.value || "0")))} />
          </FieldRow>
        )}
        <FieldRow label="单机 TDP (kW)">
          <input className="inp" type="number" step={0.1} min={0.1} value={t.tdp_kw}
            onChange={(e) => setT("tdp_kw", parseFloat(e.target.value || "0"))} />
        </FieldRow>
      </div>
    );
  }

  if (selection.kind === "cluster") {
    const c = clusters.find((c) => c.id === selection.clusterId);
    if (!c) {
      return (
        <div className="inspector">
          <div style={{ color: "var(--t3)", fontSize: 12 }}>所选集群已不存在</div>
        </div>
      );
    }
    const allServers = c.racks.flatMap((r) => r.servers);
    const totalSrv = allServers.length;
    const totalGpu = allServers.reduce((a, s) => a + s.gpu_count, 0);
    const totalCpuSockets = allServers.reduce((a, s) => a + (s.cpu_sockets ?? 0), 0);
    const totalRamGb = allServers.reduce((a, s) => a + (s.ram_gb ?? 0), 0);
    const totalStorageTb = allServers.reduce((a, s) => a + serverStorageTb(s), 0);
    const peakKw = c.racks.reduce((a, r) => a + rackPeakKw(r), 0);
    const ro = { color: "var(--t2)", fontSize: 13 };
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · 集群
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {c.name?.trim() || "未命名"}
        </div>
        <FieldRow label="集群名称">
          <input className="inp" style={inputStyle} value={c.name}
            onChange={(e) => onChangeCluster(c.id, "name", e.target.value)} />
        </FieldRow>
        <FieldRow label="用途">
          <select className="inp" value={c.purpose ?? "训练"}
            onChange={(e) => onChangeCluster(c.id, "purpose", e.target.value as ClusterPurpose)}>
            {PURPOSE_CHOICES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="网络拓扑">
          <select className="inp" value={c.topology ?? "spine-leaf"}
            onChange={(e) => onChangeCluster(c.id, "topology", e.target.value)}>
            {TOPOLOGY_CHOICES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="互联">
          <input className="inp" style={inputStyle}
            placeholder="InfiniBand NDR · 400 Gbps"
            value={c.interconnect ?? ""}
            onChange={(e) => onChangeCluster(c.id, "interconnect", e.target.value)} />
        </FieldRow>
        <FieldRow label="PUE">
          <input className="inp" type="number" step={0.01} min={1.0} max={3.0}
            value={c.pue ?? 1.25}
            onChange={(e) => onChangeCluster(c.id, "pue", parseFloat(e.target.value || "1.25"))} />
        </FieldRow>
        <FieldRow label="机柜数"><div style={ro}>{c.racks.length}</div></FieldRow>
        <FieldRow label="服务器数"><div style={ro}>{totalSrv}</div></FieldRow>
        <FieldRow label="GPU 卡数"><div style={ro}>{totalGpu}</div></FieldRow>
        <FieldRow label="CPU 路数总和"><div style={ro}>{totalCpuSockets}</div></FieldRow>
        <FieldRow label="内存总量">
          <div style={ro}>{totalRamGb >= 1024 ? `${(totalRamGb / 1024).toFixed(1)} TB` : `${totalRamGb} GB`}</div>
        </FieldRow>
        <FieldRow label="存储总量"><div style={ro}>{totalStorageTb.toFixed(0)} TB</div></FieldRow>
        <FieldRow label="估算峰值功率"><div style={ro}>{peakKw.toFixed(1)} kW</div></FieldRow>
      </div>
    );
  }

  if (selection.kind === "rack") {
    const cluster = clusters.find((c) => c.id === selection.clusterId);
    const rack = cluster?.racks.find((r) => r.id === selection.rackId);
    if (!rack || !cluster) {
      return (
        <div className="inspector">
          <div style={{ color: "var(--t3)", fontSize: 12 }}>所选机柜已不存在</div>
        </div>
      );
    }
    const totalGpu = rack.servers.reduce((a, s) => a + s.gpu_count, 0);
    const totalRamGb = rack.servers.reduce((a, s) => a + (s.ram_gb ?? 0), 0);
    const totalStorageTb = rack.servers.reduce((a, s) => a + serverStorageTb(s), 0);
    const peakKw = rackPeakKw(rack);
    const ro = { color: "var(--t2)", fontSize: 13 };
    return (
      <div className="inspector">
        <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
          已选中 · 机柜
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          {rack.name || rack.id}
          <span style={{ color: "var(--t3)", fontSize: 12, marginLeft: 8 }}>
            · 集群 {cluster.name || cluster.id}
          </span>
        </div>
        <FieldRow label="机柜名称">
          <input className="inp" style={inputStyle} value={rack.name ?? ""}
            onChange={(e) => onChangeRack(cluster.id, rack.id, "name", e.target.value)} />
        </FieldRow>
        <FieldRow label="状态（按服务器联动）">
          {(() => {
            const st = computeRackStatus(rack);
            const cls = st === "fail" ? "red" : st === "warn" ? "orange" : st === "empty" ? "white" : "green";
            const label = st === "fail" ? "故障" : st === "warn" ? "告警" : st === "empty" ? "空位" : "健康";
            return <span className={`tag tag-${cls}`}>{label}</span>;
          })()}
        </FieldRow>
        <FieldRow label="机柜规格 (U)">
          <input className="inp" type="number" min={1} max={60} value={rack.rack_u ?? 42}
            onChange={(e) => onChangeRack(cluster.id, rack.id, "rack_u", Math.max(1, parseInt(e.target.value || "42", 10)))} />
        </FieldRow>
        <FieldRow label="额定功率 (kW)">
          <input className="inp" type="number" min={0} step={0.5} value={rack.rated_power_kw ?? 0}
            onChange={(e) => onChangeRack(cluster.id, rack.id, "rated_power_kw", Math.max(0, parseFloat(e.target.value || "0")))} />
        </FieldRow>
        <FieldRow label="散热方式">
          <select className="inp" value={rack.cooling ?? "风冷"}
            onChange={(e) => onChangeRack(cluster.id, rack.id, "cooling", e.target.value as CoolingKind)}>
            {COOLING_CHOICES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="TOR 交换机">
          <input className="inp" style={inputStyle}
            placeholder="例：Mellanox SN5600"
            value={rack.tor_switch ?? ""}
            onChange={(e) => onChangeRack(cluster.id, rack.id, "tor_switch", e.target.value)} />
        </FieldRow>
        <FieldRow label="机房位置">
          <input className="inp" style={inputStyle}
            placeholder="例：B1-2-A-3"
            value={rack.location ?? ""}
            onChange={(e) => onChangeRack(cluster.id, rack.id, "location", e.target.value)} />
        </FieldRow>
        <FieldRow label="服务器数"><div style={ro}>{rack.servers.length}</div></FieldRow>
        <FieldRow label="GPU 卡数"><div style={ro}>{totalGpu}</div></FieldRow>
        <FieldRow label="内存总量">
          <div style={ro}>{totalRamGb >= 1024 ? `${(totalRamGb / 1024).toFixed(1)} TB` : `${totalRamGb} GB`}</div>
        </FieldRow>
        <FieldRow label="存储总量"><div style={ro}>{totalStorageTb.toFixed(0)} TB</div></FieldRow>
        <FieldRow label="估算当前功率"><div style={ro}>{peakKw.toFixed(1)} kW</div></FieldRow>
      </div>
    );
  }

  // selection.kind === "server"
  const cluster = clusters.find((c) => c.id === selection.clusterId);
  const rack = cluster?.racks.find((r) => r.id === selection.rackId);
  const srv = rack?.servers.find((s) => s.id === selection.serverId);
  if (!srv || !rack || !cluster) {
    return (
      <div className="inspector">
        <div style={{ color: "var(--t3)", fontSize: 12 }}>所选服务器已不存在</div>
      </div>
    );
  }
  const set = (f: keyof Server, v: any) => onChangeServer(cluster.id, rack.id, srv.id, f, v);
  const k = srv.kind ?? "gpu";
  const showGpu = k === "gpu";
  const showStorageDisks = k === "storage";
  return (
    <div className="inspector">
      <div style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: ".06em", marginBottom: 2 }}>
        已选中 · 服务器
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
        {srv.name || srv.id}
        <span style={{ color: "var(--t3)", fontSize: 12, marginLeft: 8 }}>
          · 机柜 {rack.name || rack.id}
        </span>
      </div>
      <FieldRow label="名称">
        <input className="inp" style={inputStyle} value={srv.name ?? ""}
          onChange={(e) => set("name", e.target.value)} />
      </FieldRow>
      <FieldRow label="类型">
        <select className="inp" value={k}
          onChange={(e) => set("kind", e.target.value as ServerKind)}>
          {KIND_CHOICES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      </FieldRow>
      <FieldRow label="CPU 型号">
        <select className="inp" value={srv.cpu_model ?? ""}
          onChange={(e) => set("cpu_model", e.target.value)}>
          <option value="">— 未选 —</option>
          {partOptions(cpuParts).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="CPU 路数">
        <input className="inp" type="number" min={1} max={8} value={srv.cpu_sockets ?? 2}
          onChange={(e) => set("cpu_sockets", Math.max(1, parseInt(e.target.value || "2", 10)))} />
      </FieldRow>
      <FieldRow label="内存 (GB)">
        <input className="inp" type="number" min={0} value={srv.ram_gb ?? 0}
          onChange={(e) => set("ram_gb", Math.max(0, parseInt(e.target.value || "0", 10)))} />
      </FieldRow>
      {showGpu && (
        <>
          <FieldRow label="GPU 型号">
            <select className="inp" value={srv.gpu_model}
              onChange={(e) => set("gpu_model", e.target.value)}>
              {partOptions(gpuParts).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="GPU 数">
            <input className="inp" type="number" min={0} max={16} value={srv.gpu_count}
              onChange={(e) => set("gpu_count", Math.max(0, Math.min(16, parseInt(e.target.value || "0", 10))))} />
          </FieldRow>
          <FieldRow label="单卡 HBM (GB)">
            <input className="inp" type="number" min={0} value={srv.gpu_mem_gb ?? 0}
              onChange={(e) => set("gpu_mem_gb", Math.max(0, parseInt(e.target.value || "0", 10)))} />
          </FieldRow>
        </>
      )}
      <FieldRow label="网卡">
        <select className="inp" value={srv.nic} onChange={(e) => set("nic", e.target.value)}>
          {partOptions(nicParts).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="SSD 型号">
        <select className="inp" value={srv.ssd_model ?? ""}
          onChange={(e) => set("ssd_model", e.target.value)}>
          <option value="">— 未选 —</option>
          {partOptions(ssdParts).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </FieldRow>
      {showStorageDisks ? (
        <>
          <FieldRow label="盘的数量">
            <input className="inp" type="number" min={0} value={srv.disk_count ?? 0}
              onChange={(e) => set("disk_count", Math.max(0, parseInt(e.target.value || "0", 10)))} />
          </FieldRow>
          <FieldRow label="单盘容量 (TB)">
            <input className="inp" type="number" min={0} step={0.1} value={srv.disk_capacity_tb ?? 0}
              onChange={(e) => set("disk_capacity_tb", Math.max(0, parseFloat(e.target.value || "0")))} />
          </FieldRow>
        </>
      ) : (
        <FieldRow label="本地存储 (TB)">
          <input className="inp" type="number" min={0} step={0.1} value={srv.storage_tb ?? 0}
            onChange={(e) => set("storage_tb", Math.max(0, parseFloat(e.target.value || "0")))} />
        </FieldRow>
      )}
      <FieldRow label="单机 TDP (kW)">
        <input className="inp" type="number" step={0.1} min={0.1} value={srv.tdp_kw}
          onChange={(e) => set("tdp_kw", parseFloat(e.target.value || "0"))} />
      </FieldRow>
      <FieldRow label="状态">
        <select className="inp" value={srv.status}
          onChange={(e) => set("status", e.target.value as Server["status"])}>
          {STATUS_CHOICES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </FieldRow>
    </div>
  );
}
