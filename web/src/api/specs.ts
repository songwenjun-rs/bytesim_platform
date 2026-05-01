import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch, getJSON } from "./client";

export type Spec = {
  id: string;
  kind: "hwspec" | "model" | "strategy" | "workload";
  name: string;
  project_id: string;
  latest_hash: string;
  created_at: string;
};

export type SpecLatest = {
  spec: Spec;
  version: {
    hash: string;
    spec_id: string;
    parent_hash?: string | null;
    version_tag: string;
    body: HwSpecBody;
    created_at: string;
  };
};

export type SpecVersion = {
  hash: string;
  spec_id: string;
  parent_hash?: string | null;
  version_tag: string;
  created_at: string;
};

export type ServerKind = "cpu" | "gpu" | "memory" | "storage";

export type Server = {
  id: string;
  name?: string;
  kind?: ServerKind;
  gpu_model: string;
  gpu_count: number;
  nic: string;
  status: "ok" | "warn" | "fail";
  tdp_kw: number;
  cpu_model?: string;
  cpu_sockets?: number;
  ram_gb?: number;
  storage_tb?: number;
  // Storage servers: split storage into disk count × per-disk capacity.
  disk_count?: number;
  disk_capacity_tb?: number;
  // Concrete SSD SKU for storage servers — picked from 硬件部件 SSD library.
  ssd_model?: string;
  gpu_mem_gb?: number;
  form_factor?: string;
  note?: string;
};

export type CoolingKind = "风冷" | "液冷" | "直接液冷";

export type RackStatus = "ok" | "warn" | "fail" | "empty";

/**
 * Rack health is derived from its servers (worst-takes-all):
 *   no servers           → empty
 *   any server "fail"    → fail (rack-level red)
 *   any server "warn"    → warn (rack-level orange)
 *   all "ok"             → ok
 * The stored `rack.status` field is ignored at render time (kept in the
 * schema for seed back-compat).
 */
export function computeRackStatus(rack: { servers: Server[] }): RackStatus {
  if (rack.servers.length === 0) return "empty";
  if (rack.servers.some((s) => s.status === "fail")) return "fail";
  if (rack.servers.some((s) => s.status === "warn")) return "warn";
  return "ok";
}

export type Rack = {
  id: string;
  name?: string;
  status: "ok" | "warn" | "empty";
  servers: Server[];
  // Physical / facility fields (optional, surfaced in Inspector).
  rack_u?: number;
  rated_power_kw?: number;
  cooling?: CoolingKind;
  tor_switch?: string;
  location?: string;
  // Network: the TOR/Leaf switches physically located in this rack. Each
  // Leaf belongs to one ScaleOutFabric (referenced by fabric_id).
  leaves?: Leaf[];
};

export type ClusterPurpose = "训练" | "推理" | "混合" | "实验";

export type Cluster = {
  id: string;
  name: string;
  racks: Rack[];
  // Cluster-level metadata surfaced in Inspector.
  purpose?: ClusterPurpose;
  topology?: string;
  interconnect?: string;
  pue?: number;
  // Scale-up (NVLink/NVSwitch/CXL) domains live at cluster level so they can
  // span multiple racks (NVL72×2, etc).
  scale_up_domains?: ScaleUpDomain[];
};

export type ScaleUpKind = "nvlink" | "nvlink-switch" | "cxl";
export type IntraTopology = "full-mesh" | "switch" | "ring" | "hypercube" | "torus";

export type ScaleUpDomain = {
  id: string;
  name: string;
  kind: ScaleUpKind;
  bandwidth_gbps: number;
  members: ScaleUpMember[];
  intra_topology?: IntraTopology;  // intra-domain topology shape
  switch_count?: number;            // for "switch" kind: # of NVSwitch chips
};

export type ScaleUpMember = {
  server_id: string;             // refers to Server.id within this cluster
  gpu_indices?: number[];        // omit = all GPUs of that server
};

export type ScaleOutKind = "infiniband" | "roce" | "ethernet" | "slingshot";
export type ScaleOutTopology = "spine-leaf" | "fat-tree" | "rail-optimized" | "dragonfly";

export type ScaleOutFabric = {
  id: string;
  name: string;
  kind: ScaleOutKind;
  topology: ScaleOutTopology;
  spines: Spine[];
  rails?: Rail[];
};

export type Rail = {
  id: string;
  name: string;
  spine_ids: string[];           // which spines belong to this rail
};

export type Spine = {
  id: string;
  name?: string;
  status: "ok" | "warn" | "fail";
  port_count?: number;
  bandwidth_per_port_gbps?: number;
};

export type Leaf = {
  id: string;
  name?: string;
  status: "ok" | "warn" | "fail";
  fabric_id: string;             // which scale-out fabric this leaf joins
  uplinks: Uplink[];             // one entry per spine connection
  port_count?: number;
  bandwidth_per_port_gbps?: number;
};

export type Uplink = {
  spine: string;                 // spine.id within the same fabric
  util_pct?: number;
  down?: boolean;
  lanes?: number;                // physical link aggregation (default 1)
  bandwidth_gbps?: number;       // per-lane bandwidth (default: inherit from spine)
};

export type ServerTemplate = {
  id: string;
  name: string;
  kind: ServerKind;
  gpu_model: string;
  gpu_count: number;
  nic: string;
  tdp_kw: number;
  cpu_model?: string;
  cpu_sockets?: number;
  ram_gb?: number;
  storage_tb?: number;
  disk_count?: number;
  disk_capacity_tb?: number;
  ssd_model?: string;
  gpu_mem_gb?: number;
  form_factor?: string;
};

export type FabricNode = { id: string; status: "ok" | "warn"; rack?: string };
export type FabricLink = { src: string; dst: string; util_pct: number; down?: boolean };

export type HwSpecBody = {
  cluster?: string;
  gpu?: string;
  interconnect?: { scale_up?: string; scale_out?: string };
  power?: { peak_kw?: number; pue?: number };
  datacenter?: {
    id: string;
    name: string;
    clusters: Cluster[];
    // Scale-out fabrics (CLOS) at datacenter level. Each has its own spines;
    // leaves are physically nested inside racks (rack.leaves[*].fabric_id).
    scale_out_fabrics?: ScaleOutFabric[];
  };
  server_templates?: ServerTemplate[];
  /** @deprecated kept only for legacy shape detection on old hwspec rows. */
  fabric?: { topology: string; spines: FabricNode[]; leaves: FabricNode[]; links: FabricLink[] };
};

export function useSpecList(kind: string) {
  return useQuery({
    queryKey: ["spec-list", kind],
    queryFn: () => getJSON<Spec[]>(`/v1/specs/${kind}`),
  });
}

export function useSpecLatest(kind: string, id: string) {
  return useQuery({
    queryKey: ["spec-latest", kind, id],
    queryFn: () => getJSON<SpecLatest>(`/v1/specs/${kind}/${id}`),
  });
}

export function useSpecVersions(kind: string, id: string) {
  return useQuery({
    queryKey: ["spec-versions", kind, id],
    queryFn: () => getJSON<SpecVersion[]>(`/v1/specs/${kind}/${id}/versions`),
  });
}

export type DiffEntry = {
  path: string;
  op: "added" | "removed" | "changed";
  from?: any;
  to?: any;
};

export type DiffResult = {
  from: SpecVersion;
  to: SpecVersion;
  entries: DiffEntry[];
};

export function useSpecDiff(kind: string, id: string, fromHash: string | null, toHash: string | null) {
  return useQuery({
    queryKey: ["spec-diff", kind, id, fromHash, toHash],
    queryFn: () => getJSON<DiffResult>(`/v1/specs/${kind}/${id}/diff?from=${fromHash}&to=${toHash}`),
    enabled: !!fromHash && !!toHash && fromHash !== toHash,
  });
}

export function useFork(kind: string, sourceId: string) {
  return useMutation({
    mutationFn: async (body: { new_name: string; from_hash?: string; new_spec_id?: string }) => {
      const r = await authFetch(`/v1/specs/${kind}/${sourceId}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json() as Promise<SpecLatest>;
    },
  });
}

export function useSnapshot(kind: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: HwSpecBody) => {
      const r = await authFetch(`/v1/specs/${kind}/${id}/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json() as Promise<SpecVersion>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spec-latest", kind, id] });
      qc.invalidateQueries({ queryKey: ["spec-versions", kind, id] });
    },
  });
}
