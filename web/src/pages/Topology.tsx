import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useSnapshot, useSpecLatest } from "../api/specs";
import { useRunFull, getBottleneck } from "../api/runs";
import { useCatalogItems } from "../api/catalogItems";
import type {
  Cluster, HwSpecBody, Leaf, Rail, ScaleOutFabric, ScaleUpDomain,
  Server, ServerTemplate, Spine, Uplink,
} from "../api/specs";
import { Palette } from "../components/topology/Palette";
import { RackCanvas } from "../components/topology/RackCanvas";
import { Inspector, type Selection } from "../components/topology/Inspector";
import { SummaryBar } from "../components/topology/SummaryBar";
import { VersionBar } from "../components/topology/VersionBar";
import { NetworkView } from "../components/topology/NetworkView";
import { buildBottleneckOverlay, parseOverlayParam } from "../components/topology/overlays";

type Tab = "rack" | "fabric";

export function Topology() {
  const { specId = "hwspec_topo_b1" } = useParams();
  const { data: latest, isLoading, error } = useSpecLatest("hwspec", specId);
  const snap = useSnapshot("hwspec", specId);

  // ?overlay=run:<id> deep-link from RunDetail still paints onto the rack/fabric
  // canvases. The picker UI was removed, but the deep-link path is kept so
  // jump-from-Run-detail keeps working.
  const [searchParams] = useSearchParams();
  const overlaySource = parseOverlayParam(searchParams.get("overlay"));
  const overlayRunId = overlaySource?.kind === "run" ? overlaySource.id : null;

  const { data: overlayRunFull } = useRunFull(overlayRunId ?? "", {
    enabled: !!overlayRunId,
  });

  const overlays = useMemo(() => {
    if (!overlayRunId || !overlayRunFull?.run) return undefined;
    const bn = getBottleneck(overlayRunFull.run);
    if (!bn) return undefined;
    return [buildBottleneckOverlay(bn, { id: overlayRunId, kind: "run" })];
  }, [overlayRunId, overlayRunFull]);

  const seed = latest?.version.body;
  const [body, setBody] = useState<HwSpecBody | null>(null);
  useEffect(() => {
    if (seed) setBody(seed);
  }, [seed, specId]);

  // 硬件部件 — used by addTemplate() so a brand-new server template defaults
  // to the first row of each kind in the catalog (rather than empty strings).
  const cpuQ = useCatalogItems("cpu");
  const gpuQ = useCatalogItems("gpu");
  const nicQ = useCatalogItems("nic");
  const ssdQ = useCatalogItems("ssd");
  const firstModel = (q: { data?: { body: { model?: string } }[] }): string =>
    String(q.data?.[0]?.body?.model ?? "");
  // datacenter → clusters[*] → racks[*] → servers[*]
  // Mutators all walk this 4-level path.
  const mapClusters = (
    prev: HwSpecBody | null,
    fn: (clusters: Cluster[]) => Cluster[],
  ): HwSpecBody | null => {
    if (!prev) return prev;
    const dc = prev.datacenter ?? { id: "dc-default", name: "未命名数据中心", clusters: [] };
    return { ...prev, datacenter: { ...dc, clusters: fn(dc.clusters ?? []) } };
  };
  // Rack IDs are scoped per-cluster — each cluster's racks number from R01.
  // Server IDs need clusterId to stay unique across the whole spec.
  const clusterRackIds = (clusters: Cluster[], clusterId: string) =>
    new Set(
      (clusters.find((c) => c.id === clusterId)?.racks ?? []).map((r) => r.id.toLowerCase()),
    );
  const allClusterIds = (clusters: Cluster[]) =>
    new Set(clusters.map((c) => c.id.toLowerCase()));

  const addServer = (clusterId: string, rackId: string, server: Server) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) =>
        clusters.map((c) => {
          if (c.id !== clusterId) return c;
          return {
            ...c,
            racks: c.racks.map((r) => {
              if (r.id !== rackId) return r;
              const next = { ...r, servers: [...r.servers, server] };
              if (r.status === "empty") next.status = "ok";
              return next;
            }),
          };
        }),
      ),
    );
  };
  const addRack = (clusterId: string) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) => {
        const taken = clusterRackIds(clusters, clusterId);
        let n = 1;
        let id = `R${String(n).padStart(2, "0")}`;
        while (taken.has(id.toLowerCase())) {
          n += 1;
          id = `R${String(n).padStart(2, "0")}`;
        }
        // Typical empty rack: 42U, 风冷, 30 kW rated. Name + TOR + location
        // start blank — operator fills them per real-world deployment.
        const newRack = {
          id,
          name: "",
          status: "empty" as const,
          servers: [],
          rack_u: 42,
          rated_power_kw: 30,
          cooling: "风冷" as const,
          tor_switch: "",
          location: "",
        };
        return clusters.map((c) =>
          c.id === clusterId ? { ...c, racks: [...c.racks, newRack] } : c,
        );
      }),
    );
  };
  const addCluster = () => {
    setBody((prev) =>
      mapClusters(prev, (clusters) => {
        const taken = allClusterIds(clusters);
        let n = clusters.length + 1;
        let id = `C${String(n).padStart(2, "0")}`;
        while (taken.has(id.toLowerCase())) {
          n += 1;
          id = `C${String(n).padStart(2, "0")}`;
        }
        const newCluster: Cluster = {
          id,
          name: "",
          racks: [],
          purpose: "训练",
          topology: "spine-leaf",
          interconnect: "InfiniBand NDR · 400 Gbps",
          pue: 1.25,
        };
        return [...clusters, newCluster];
      }),
    );
  };
  const updateServerField = (
    clusterId: string,
    rackId: string,
    serverId: string,
    field: keyof Server,
    value: any,
  ) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) =>
        clusters.map((c) => {
          if (c.id !== clusterId) return c;
          return {
            ...c,
            racks: c.racks.map((r) => {
              if (r.id !== rackId) return r;
              return {
                ...r,
                servers: r.servers.map((s) =>
                  s.id === serverId ? ({ ...s, [field]: value } as Server) : s,
                ),
              };
            }),
          };
        }),
      ),
    );
  };
  const updateRackField = (
    clusterId: string,
    rackId: string,
    field: keyof import("../api/specs").Rack,
    value: any,
  ) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) =>
        clusters.map((c) => {
          if (c.id !== clusterId) return c;
          return {
            ...c,
            racks: c.racks.map((r) => (r.id === rackId ? { ...r, [field]: value } : r)),
          };
        }),
      ),
    );
  };
  const updateClusterField = (
    clusterId: string,
    field: keyof Cluster,
    value: any,
  ) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) =>
        clusters.map((c) => (c.id === clusterId ? { ...c, [field]: value } : c)),
      ),
    );
  };
  const removeServer = (clusterId: string, rackId: string, serverId: string) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) =>
        clusters.map((c) => {
          if (c.id !== clusterId) return c;
          return {
            ...c,
            racks: c.racks.map((r) => {
              if (r.id !== rackId) return r;
              const servers = r.servers.filter((s) => s.id !== serverId);
              const status = servers.length === 0 ? "empty" as const : r.status;
              return { ...r, servers, status };
            }),
          };
        }),
      ),
    );
  };
  const removeRack = (clusterId: string, rackId: string) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) =>
        clusters.map((c) =>
          c.id === clusterId ? { ...c, racks: c.racks.filter((r) => r.id !== rackId) } : c,
        ),
      ),
    );
  };
  const removeCluster = (clusterId: string) => {
    setBody((prev) =>
      mapClusters(prev, (clusters) => clusters.filter((c) => c.id !== clusterId)),
    );
  };

  const mapTemplates = (
    prev: HwSpecBody | null,
    fn: (templates: ServerTemplate[]) => ServerTemplate[],
  ): HwSpecBody | null => {
    if (!prev) return prev;
    return { ...prev, server_templates: fn(prev.server_templates ?? []) };
  };
  const addTemplate = () => {
    setBody((prev) =>
      mapTemplates(prev, (templates) => {
        const taken = new Set(templates.map((t) => t.id.toLowerCase()));
        let n = templates.length + 1;
        let id = `tpl-${String(n).padStart(2, "0")}`;
        while (taken.has(id.toLowerCase())) {
          n += 1;
          id = `tpl-${String(n).padStart(2, "0")}`;
        }
        // Default each part field to the first row of its 硬件部件仓库 kind.
        // If a kind is empty, fall back to "" (Inspector dropdown shows blank).
        const newTpl: ServerTemplate = {
          id,
          name: "",
          kind: "gpu",
          gpu_model: firstModel(gpuQ),
          gpu_count: 8,
          nic: firstModel(nicQ),
          tdp_kw: 11.0,
          cpu_model: firstModel(cpuQ),
          cpu_sockets: 2,
          ram_gb: 2048,
          storage_tb: 30,
          gpu_mem_gb: 192,
          form_factor: "HGX 8-GPU 4U",
          ssd_model: firstModel(ssdQ),
        };
        return [...templates, newTpl];
      }),
    );
  };
  const updateTemplateField = (
    templateId: string,
    field: keyof ServerTemplate,
    value: any,
  ) => {
    setBody((prev) =>
      mapTemplates(prev, (templates) =>
        templates.map((t) => (t.id === templateId ? ({ ...t, [field]: value } as ServerTemplate) : t)),
      ),
    );
  };
  const removeTemplate = (templateId: string) => {
    setBody((prev) =>
      mapTemplates(prev, (templates) => templates.filter((t) => t.id !== templateId)),
    );
  };

  // ── Scale-out fabric / spine / leaf / uplink mutators ──
  const mapDatacenter = (
    prev: HwSpecBody | null,
    fn: (dc: NonNullable<HwSpecBody["datacenter"]>) => NonNullable<HwSpecBody["datacenter"]>,
  ): HwSpecBody | null => {
    if (!prev) return prev;
    const dc = prev.datacenter ?? { id: "dc-default", name: "未命名数据中心", clusters: [] };
    return { ...prev, datacenter: fn(dc) };
  };
  const mapFabrics = (
    prev: HwSpecBody | null,
    fn: (fabrics: ScaleOutFabric[]) => ScaleOutFabric[],
  ): HwSpecBody | null =>
    mapDatacenter(prev, (dc) => ({ ...dc, scale_out_fabrics: fn(dc.scale_out_fabrics ?? []) }));
  const mapLeaves = (
    prev: HwSpecBody | null,
    clusterId: string,
    rackId: string,
    fn: (leaves: Leaf[]) => Leaf[],
  ): HwSpecBody | null =>
    mapClusters(prev, (clusters) =>
      clusters.map((c) =>
        c.id === clusterId
          ? {
              ...c,
              racks: c.racks.map((r) =>
                r.id === rackId ? { ...r, leaves: fn(r.leaves ?? []) } : r,
              ),
            }
          : c,
      ),
    );

  const removeFabric = (fabricId: string) => {
    setBody((prev) => {
      // Drop the fabric, then drop any leaves bound to it from all racks.
      const dropped = mapFabrics(prev, (fabrics) => fabrics.filter((f) => f.id !== fabricId));
      return mapClusters(dropped, (clusters) =>
        clusters.map((c) => ({
          ...c,
          racks: c.racks.map((r) => ({
            ...r,
            leaves: (r.leaves ?? []).filter((l) => l.fabric_id !== fabricId),
          })),
        })),
      );
    });
    setSelection(null);
  };
  const updateFabricField = (fabricId: string, field: keyof ScaleOutFabric, value: any) => {
    setBody((prev) =>
      mapFabrics(prev, (fabrics) =>
        fabrics.map((f) => (f.id === fabricId ? ({ ...f, [field]: value } as ScaleOutFabric) : f)),
      ),
    );
  };

  const removeSpine = (fabricId: string, spineId: string) => {
    setBody((prev) => {
      const dropped = mapFabrics(prev, (fabrics) =>
        fabrics.map((f) =>
          f.id === fabricId ? { ...f, spines: f.spines.filter((s) => s.id !== spineId) } : f,
        ),
      );
      // Also clean uplinks that referenced this spine.
      return mapClusters(dropped, (clusters) =>
        clusters.map((c) => ({
          ...c,
          racks: c.racks.map((r) => ({
            ...r,
            leaves: (r.leaves ?? []).map((l) =>
              l.fabric_id === fabricId
                ? { ...l, uplinks: l.uplinks.filter((u) => u.spine !== spineId) }
                : l,
            ),
          })),
        })),
      );
    });
    setSelection(null);
  };
  const updateSpineField = (fabricId: string, spineId: string, field: keyof Spine, value: any) => {
    setBody((prev) =>
      mapFabrics(prev, (fabrics) =>
        fabrics.map((f) =>
          f.id === fabricId
            ? { ...f, spines: f.spines.map((s) => (s.id === spineId ? ({ ...s, [field]: value } as Spine) : s)) }
            : f,
        ),
      ),
    );
  };

  const removeLeaf = (clusterId: string, rackId: string, leafId: string) => {
    setBody((prev) =>
      mapLeaves(prev, clusterId, rackId, (leaves) => leaves.filter((l) => l.id !== leafId)),
    );
    setSelection(null);
  };
  const updateLeafField = (
    clusterId: string, rackId: string, leafId: string, field: keyof Leaf, value: any,
  ) => {
    setBody((prev) =>
      mapLeaves(prev, clusterId, rackId, (leaves) =>
        leaves.map((l) => (l.id === leafId ? ({ ...l, [field]: value } as Leaf) : l)),
      ),
    );
  };
  const addUplink = (clusterId: string, rackId: string, leafId: string, spineId: string) => {
    setBody((prev) =>
      mapLeaves(prev, clusterId, rackId, (leaves) =>
        leaves.map((l) => {
          if (l.id !== leafId) return l;
          if (l.uplinks.some((u) => u.spine === spineId)) return l;
          return { ...l, uplinks: [...l.uplinks, { spine: spineId, util_pct: 0 }] };
        }),
      ),
    );
  };
  const removeUplink = (clusterId: string, rackId: string, leafId: string, spineId: string) => {
    setBody((prev) =>
      mapLeaves(prev, clusterId, rackId, (leaves) =>
        leaves.map((l) =>
          l.id === leafId ? { ...l, uplinks: l.uplinks.filter((u) => u.spine !== spineId) } : l,
        ),
      ),
    );
  };
  const updateUplinkField = (
    clusterId: string, rackId: string, leafId: string, spineId: string,
    field: keyof Uplink, value: any,
  ) => {
    setBody((prev) =>
      mapLeaves(prev, clusterId, rackId, (leaves) =>
        leaves.map((l) =>
          l.id === leafId
            ? {
                ...l,
                uplinks: l.uplinks.map((u) =>
                  u.spine === spineId ? ({ ...u, [field]: value } as Uplink) : u,
                ),
              }
            : l,
        ),
      ),
    );
  };

  // ── Scale-up domain / member mutators (Step 4) ──
  const mapDomains = (
    prev: HwSpecBody | null,
    clusterId: string,
    fn: (domains: ScaleUpDomain[]) => ScaleUpDomain[],
  ): HwSpecBody | null =>
    mapClusters(prev, (clusters) =>
      clusters.map((c) =>
        c.id === clusterId ? { ...c, scale_up_domains: fn(c.scale_up_domains ?? []) } : c,
      ),
    );

  const removeDomain = (clusterId: string, domainId: string) => {
    setBody((prev) =>
      mapDomains(prev, clusterId, (domains) => domains.filter((d) => d.id !== domainId)),
    );
    setSelection(null);
  };
  const updateDomainField = (
    clusterId: string, domainId: string, field: keyof ScaleUpDomain, value: any,
  ) => {
    setBody((prev) =>
      mapDomains(prev, clusterId, (domains) =>
        domains.map((d) => (d.id === domainId ? ({ ...d, [field]: value } as ScaleUpDomain) : d)),
      ),
    );
  };
  /**
   * Add a server to a domain. Scale-up membership is exclusive within a
   * cluster — if the server is already in another domain there, we move it.
   */
  const addMember = (clusterId: string, domainId: string, serverId: string) => {
    setBody((prev) =>
      mapDomains(prev, clusterId, (domains) =>
        domains.map((d) => {
          if (d.id === domainId) {
            if (d.members.some((m) => m.server_id === serverId)) return d;
            return { ...d, members: [...d.members, { server_id: serverId }] };
          }
          // remove from other domains
          if (d.members.some((m) => m.server_id === serverId)) {
            return { ...d, members: d.members.filter((m) => m.server_id !== serverId) };
          }
          return d;
        }),
      ),
    );
  };
  const removeMember = (clusterId: string, domainId: string, serverId: string) => {
    setBody((prev) =>
      mapDomains(prev, clusterId, (domains) =>
        domains.map((d) =>
          d.id === domainId
            ? { ...d, members: d.members.filter((m) => m.server_id !== serverId) }
            : d,
        ),
      ),
    );
  };

  // ── Rail mutators (Step 6) ──
  const mapRails = (
    prev: HwSpecBody | null, fabricId: string,
    fn: (rails: Rail[]) => Rail[],
  ): HwSpecBody | null =>
    mapFabrics(prev, (fabrics) =>
      fabrics.map((f) => f.id === fabricId ? { ...f, rails: fn(f.rails ?? []) } : f),
    );
  const addRail = (fabricId: string) => {
    setBody((prev) =>
      mapRails(prev, fabricId, (rails) => {
        const taken = new Set(rails.map((r) => r.id));
        let n = rails.length + 1;
        let id = `rail-${String(n).padStart(2, "0")}`;
        while (taken.has(id)) { n += 1; id = `rail-${String(n).padStart(2, "0")}`; }
        return [...rails, { id, name: `Rail ${n}`, spine_ids: [] }];
      }),
    );
  };
  const removeRail = (fabricId: string, railId: string) => {
    setBody((prev) =>
      mapRails(prev, fabricId, (rails) => rails.filter((r) => r.id !== railId)),
    );
    setSelection(null);
  };
  const updateRailField = (
    fabricId: string, railId: string, field: keyof Rail, value: any,
  ) => {
    setBody((prev) =>
      mapRails(prev, fabricId, (rails) =>
        rails.map((r) => (r.id === railId ? ({ ...r, [field]: value } as Rail) : r)),
      ),
    );
  };
  /**
   * Regenerate every cluster's scale_up_domains so each domain spans
   * `racksPerDomain` consecutive racks. The last group may have fewer racks
   * if `cluster.racks.length` isn't a multiple of N.
   *
   * Defaults: kind=nvlink-switch, intra_topology=switch, 1800 GB/s,
   * switch_count = 9 × racksPerDomain (NVL72-class scaling heuristic).
   */
  const applyScaleUpScope = (racksPerDomain: number) => {
    const n = Math.max(1, Math.floor(racksPerDomain));
    setBody((prev) =>
      mapClusters(prev, (clusters) =>
        clusters.map((c) => {
          const newDomains: ScaleUpDomain[] = [];
          for (let i = 0; i < c.racks.length; i += n) {
            const slice = c.racks.slice(i, i + n);
            const gpuServers = slice.flatMap((r) => r.servers.filter((s) => s.gpu_count > 0));
            if (gpuServers.length === 0) continue;
            const rackIds = slice.map((r) => r.id);
            const id = `sud-${c.id}-${rackIds[0]}${slice.length > 1 ? `_${slice[slice.length - 1].id}` : ""}`;
            const name = slice.length === 1
              ? `NVL-${rackIds[0]}`
              : `NVL-${rackIds[0]}…${rackIds[rackIds.length - 1]} (${slice.length} 柜)`;
            newDomains.push({
              id, name,
              kind: "nvlink-switch",
              intra_topology: "switch",
              switch_count: Math.max(4, 9 * slice.length),
              bandwidth_gbps: 1800,
              members: gpuServers.map((s) => ({ server_id: s.id })),
            });
          }
          return { ...c, scale_up_domains: newDomains };
        }),
      ),
    );
    setSelection(null);
  };

  const toggleRailSpine = (fabricId: string, railId: string, spineId: string) => {
    setBody((prev) =>
      mapRails(prev, fabricId, (rails) =>
        rails.map((r) => {
          if (r.id !== railId) return r;
          const has = r.spine_ids.includes(spineId);
          return { ...r, spine_ids: has ? r.spine_ids.filter((s) => s !== spineId) : [...r.spine_ids, spineId] };
        }),
      ),
    );
  };

  const snapshotJSON = (): HwSpecBody | null => body;

  const [tab, setTab] = useState<Tab>("rack");
  const [selection, setSelection] = useState<Selection>(null);

  // Honor the `?cluster=<id>` deep-link param coming from TrainingSim's
  // 拓扑概览 → 进入完整视图. Once the body is loaded (so we can verify the
  // cluster exists), select it and switch to the rack tab. Run only on
  // first body load so we don't fight user clicks afterwards.
  const deepLinkClusterId = searchParams.get("cluster");
  const deepLinkAppliedRef = useState({ done: false })[0];
  useEffect(() => {
    if (deepLinkAppliedRef.done) return;
    if (!body || !deepLinkClusterId) return;
    const exists = (body.datacenter?.clusters ?? []).some(
      (c) => c.id === deepLinkClusterId,
    );
    if (exists) {
      setSelection({ kind: "cluster", clusterId: deepLinkClusterId });
      setTab("rack");
    }
    deepLinkAppliedRef.done = true;
  }, [body, deepLinkClusterId, deepLinkAppliedRef]);

  const confirmRemoveCluster = (label: string, fn: () => void) => {
    if (window.confirm(`确认删除该集群 ${label}？`)) {
      fn();
      setSelection(null);
    }
  };

  if (isLoading) return <div className="card">加载中…</div>;
  // 404 → render empty shell so user can build from scratch and 保存 will
  // bootstrap the spec via asset-svc's self-create-on-snapshot path.
  // Other errors still bail with a visible message.
  if (error && !String(error).includes("404")) {
    return <div className="card boundary-warn">加载失败：{String(error)}</div>;
  }
  if (!latest && !body) {
    // Initialise an in-memory empty hwspec body; first 保存 click will
    // POST it via /v1/specs/hwspec/{id}/snapshot (auto-creates bs_spec row).
    setBody({
      datacenter: { id: "dc-default", name: "默认数据中心", clusters: [], scale_out_fabrics: [] },
      server_templates: [],
    } as HwSpecBody);
    return <div className="card">初始化空白集群配置…</div>;
  }
  if (!latest && !body) return null;

  const clusters = body?.datacenter?.clusters ?? [];
  const findClusterIdByRack = (rackId: string): string | null => {
    for (const c of clusters) {
      if (c.racks.some((r) => r.id === rackId)) return c.id;
    }
    return null;
  };

  return (
    <>
      <VersionBar
        saving={snap.isPending}
        onSave={() => {
          const snapshot = snapshotJSON();
          if (snapshot) snap.mutate(snapshot);
        }}
      />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
        <div className="tabbar">
          <button className={`btn ${tab === "rack" ? "on" : ""}`} onClick={() => setTab("rack")}>机房视图</button>
          <button className={`btn ${tab === "fabric" ? "on" : ""}`} onClick={() => setTab("fabric")}>网络视图</button>
        </div>
      </div>

      {body && <SummaryBar body={body} />}

      {tab === "rack" ? (
        <div className="topo-wrap">
          <Palette
            templates={body?.server_templates ?? []}
            selection={selection}
            onSelect={(templateId) => setSelection({ kind: "template", templateId })}
            onAdd={addTemplate}
            onRemove={(templateId) => {
              removeTemplate(templateId);
              setSelection(null);
            }}
          />
          <RackCanvas
            clusters={clusters}
            selection={selection}
            onSelectServer={(clusterId, rackId, serverId) =>
              setSelection({ kind: "server", clusterId, rackId, serverId })}
            onSelectRack={(clusterId, rackId) =>
              setSelection({ kind: "rack", clusterId, rackId })}
            onSelectCluster={(clusterId) => setSelection({ kind: "cluster", clusterId })}
            onAddServer={(rackId, server) => {
              const cid = findClusterIdByRack(rackId);
              if (cid) addServer(cid, rackId, server);
            }}
            onAddRack={addRack}
            onAddCluster={addCluster}
            onRemoveServer={(clusterId, rackId, serverId) => {
              removeServer(clusterId, rackId, serverId);
              setSelection(null);
            }}
            onRemoveRack={(clusterId, rackId) => {
              removeRack(clusterId, rackId);
              setSelection(null);
            }}
            onRemoveCluster={(clusterId) =>
              confirmRemoveCluster(clusterId, () => removeCluster(clusterId))}
            overlays={overlays}
          />
          <Inspector
            selection={selection}
            clusters={clusters}
            templates={body?.server_templates ?? []}
            fabrics={body?.datacenter?.scale_out_fabrics ?? []}
            onChangeServer={updateServerField}
            onChangeRack={updateRackField}
            onChangeCluster={updateClusterField}
            onChangeTemplate={updateTemplateField}
            onChangeFabric={updateFabricField}
            onRemoveFabric={removeFabric}
            onChangeSpine={updateSpineField}
            onRemoveSpine={removeSpine}
            onChangeLeaf={updateLeafField}
            onRemoveLeaf={removeLeaf}
            onAddUplink={addUplink}
            onRemoveUplink={removeUplink}
            onChangeUplink={updateUplinkField}
            onChangeDomain={updateDomainField}
            onRemoveDomain={removeDomain}
            onAddMember={addMember}
            onRemoveMember={removeMember}
            onAddRail={addRail}
            onRemoveRail={removeRail}
            onChangeRail={updateRailField}
            onSelectRail={(fabricId, railId) => setSelection({ kind: "rail", fabricId, railId })}
            onToggleRailSpine={toggleRailSpine}
          />
        </div>
      ) : (
        body && (
          // Network view is read-only (besides 2 architecture-level
          // dropdowns inside the toolbar). No Inspector here.
          <NetworkView
            body={body}
            overlays={overlays}
            selection={selection}
            onSelectFabric={(fabricId) => setSelection({ kind: "scale_out_fabric", fabricId })}
            onSelectSpine={(fabricId, spineId) => setSelection({ kind: "spine", fabricId, spineId })}
            onSelectLeaf={(clusterId, rackId, leafId) =>
              setSelection({ kind: "leaf", clusterId, rackId, leafId })}
            onSelectDomain={(clusterId, domainId) =>
              setSelection({ kind: "scale_up_domain", clusterId, domainId })}
            onSelectServer={(clusterId, rackId, serverId) =>
              setSelection({ kind: "server", clusterId, rackId, serverId })}
            onSelectRack={(clusterId, rackId) =>
              setSelection({ kind: "rack", clusterId, rackId })}
            onSelectLink={(clusterId, rackId, leafId, spineId) =>
              setSelection({ kind: "link", clusterId, rackId, leafId, spineId })}
            onChangeFabricTopology={(fabricId, topo) =>
              updateFabricField(fabricId, "topology", topo)}
            onApplyScaleUpScope={applyScaleUpScope}
          />
        )
      )}

      {snap.isSuccess && (
        <div className="card boundary-ok" style={{ marginTop: 14 }}>
          ✓ 已快照为新版本 <span className="mono">{snap.data.version_tag}</span> · hash {snap.data.hash.slice(0, 8)}…
        </div>
      )}
      {snap.isError && (
        <div className="card boundary-warn" style={{ marginTop: 14 }}>
          快照失败：{String(snap.error)}
        </div>
      )}

    </>
  );
}
