import { useMemo, useState } from "react";
import ReactFlow, { Background, Controls, Handle, Position } from "reactflow";
import type { Edge, EdgeMouseHandler, Node, NodeMouseHandler } from "reactflow";
import "reactflow/dist/style.css";
import type {
  Cluster, HwSpecBody, IntraTopology, Leaf, Rack, ScaleOutFabric, ScaleOutTopology,
  ScaleUpDomain, Server, ServerKind, Spine,
} from "../../api/specs";
import {
  type TopologyOverlay,
  type OverlayLink,
  summarizeOverlays,
} from "./overlays";
import type { Selection } from "./Inspector";

// Layout — compact "architect view" (logical connectivity, not physical detail).
const SPINE_Y = 40;
const LEAF_Y = 170;
const DIVIDER_Y = 250;          // ⬅ band between scale-out and scale-up tiers
const SERVER_Y = 340;
const RACK_LABEL_Y = 290;       // rack label well above the envelope band
const RACK_GAP = 24;
const SRV_W = 60;               // wider tiles, room for "8× B200" text
const SRV_H = 42;
const SRV_GAP = 8;
const RACK_PAD_X = 8;
const LEAF_W = 90;
const LEAF_GAP = 6;
const ENV_PAD = 10;
const ENV_LABEL_H = 18;         // reserved at top of envelope for label

const SEVERITY_STROKE: Record<OverlayLink["severity"], string> = {
  high: "var(--red)", med: "var(--orange)", low: "var(--teal)",
};
const SEVERITY_WIDTH: Record<OverlayLink["severity"], number> = {
  high: 3.6, med: 2.6, low: 2.0,
};
const DOMAIN_FILL: Record<ScaleUpDomain["kind"], string> = {
  "nvlink": "rgba(72, 200, 116, 0.10)",
  "nvlink-switch": "rgba(72, 200, 116, 0.16)",
  "cxl": "rgba(180, 140, 255, 0.14)",
};
const DOMAIN_STROKE: Record<ScaleUpDomain["kind"], string> = {
  "nvlink": "rgba(72, 200, 116, 0.55)",
  "nvlink-switch": "rgba(72, 200, 116, 0.85)",
  "cxl": "rgba(180, 140, 255, 0.65)",
};
const KIND_ICON: Record<ServerKind, string> = { cpu: "C", gpu: "G", memory: "M", storage: "S" };

// Rail color palette (for spine/edge tinting). Cycles for >8 rails.
const RAIL_PALETTE = [
  "#4090ff", "#48c874", "#ffaf40", "#b48cff",
  "#ff7a70", "#8fe1ff", "#ffe066", "#f5a4d3",
];

function colorFor(util: number, down?: boolean): string {
  if (down) return "var(--t4)";
  if (util >= 80) return "var(--red)";
  if (util >= 60) return "var(--orange)";
  if (util >= 40) return "var(--teal)";
  return "var(--green)";
}

function buildOverlayLookup(overlays: TopologyOverlay[] | undefined): Record<string, OverlayLink> {
  const out: Record<string, OverlayLink> = {};
  if (!overlays) return out;
  for (const o of overlays) {
    if (!o.links) continue;
    for (const [k, v] of Object.entries(o.links)) out[k] = v;
  }
  return out;
}
function lookupEdge(lookup: Record<string, OverlayLink>, src: string, dst: string): OverlayLink | null {
  return lookup[`${src}-${dst}`] ?? lookup[`${dst}-${src}`] ?? null;
}

// Map spine.id → rail color (or null if not in any rail)
function buildRailMap(fabric: ScaleOutFabric | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!fabric?.rails) return m;
  fabric.rails.forEach((r, i) => {
    const color = RAIL_PALETTE[i % RAIL_PALETTE.length];
    for (const sid of r.spine_ids) m.set(sid, color);
  });
  return m;
}

// ── Spine layout (varies by fabric.topology) ────────────────────────────────

type SpinePos = { x: number; y: number };
type SpineLayout = {
  positions: Map<string, SpinePos>;
  /** Synthetic spine↔spine edges (visual hint for fat-tree core/agg or
   *  dragonfly intra-group full-mesh). Not stored in the data model. */
  extraEdges: { from: string; to: string; kind: "core-agg" | "intra-group" }[];
  /** Translucent background blocks behind grouped spines (rail-optimized). */
  bgRects: { x: number; y: number; w: number; h: number; color: string; label?: string }[];
};

const SPINE_NODE_W = 110;
const SPINE_NODE_H = 50;

function computeSpineLayout(fabric: ScaleOutFabric, baseLeftX: number, layoutWidth: number): SpineLayout {
  const N = fabric.spines.length;
  const positions = new Map<string, SpinePos>();
  const extraEdges: SpineLayout["extraEdges"] = [];
  const bgRects: SpineLayout["bgRects"] = [];
  if (N === 0) return { positions, extraEdges, bgRects };

  switch (fabric.topology) {
    case "rail-optimized": {
      // Group spines by rail. Each rail = visual cluster with color block.
      const rails = fabric.rails ?? [];
      type Group = { railId: string | null; railIdx: number; spineIds: string[] };
      const groups: Group[] = [];
      const claimed = new Set<string>();
      rails.forEach((r, i) => {
        const ids = r.spine_ids.filter((id) => fabric.spines.some((s) => s.id === id));
        if (ids.length > 0) {
          ids.forEach((id) => claimed.add(id));
          groups.push({ railId: r.id, railIdx: i, spineIds: ids });
        }
      });
      const ungrouped = fabric.spines.map((s) => s.id).filter((id) => !claimed.has(id));
      if (ungrouped.length > 0) groups.push({ railId: null, railIdx: -1, spineIds: ungrouped });

      const gap = 28;
      let cx = baseLeftX;
      groups.forEach((g) => {
        const gw = g.spineIds.length * SPINE_NODE_W + (g.spineIds.length - 1) * 8;
        const color = g.railIdx >= 0 ? RAIL_PALETTE[g.railIdx % RAIL_PALETTE.length] : "rgba(120,120,120,0.5)";
        bgRects.push({
          x: cx - 8, y: SPINE_Y - 14, w: gw + 16, h: SPINE_NODE_H + 24,
          color, label: g.railId ?? "未分组",
        });
        g.spineIds.forEach((sid, i) => {
          positions.set(sid, { x: cx + i * (SPINE_NODE_W + 8), y: SPINE_Y });
        });
        cx += gw + gap;
      });
      return { positions, extraEdges, bgRects };
    }

    case "fat-tree": {
      // 2 spine tiers: top = core, bottom = aggregation.
      const coreCount = Math.max(2, Math.ceil(N / 3));
      const coreIds = fabric.spines.slice(0, coreCount).map((s) => s.id);
      const aggIds = fabric.spines.slice(coreCount).map((s) => s.id);
      const CORE_Y = SPINE_Y - 70;
      const AGG_Y = SPINE_Y;
      const coreStep = layoutWidth / Math.max(coreIds.length, 1);
      coreIds.forEach((sid, i) => {
        positions.set(sid, { x: baseLeftX + i * coreStep + coreStep / 4, y: CORE_Y });
      });
      const aggStep = layoutWidth / Math.max(aggIds.length, 1);
      aggIds.forEach((sid, i) => {
        positions.set(sid, { x: baseLeftX + i * aggStep, y: AGG_Y });
      });
      // Visual edges: each core connects to every agg (CLOS bipartite hint)
      coreIds.forEach((c) => aggIds.forEach((a) => {
        extraEdges.push({ from: c, to: a, kind: "core-agg" });
      }));
      return { positions, extraEdges, bgRects };
    }

    case "dragonfly": {
      // Group spines into G clusters; intra-group all-to-all (visual hint).
      const G = Math.max(2, Math.min(N, Math.ceil(Math.sqrt(N))));
      const perGroup = Math.ceil(N / G);
      const groups: string[][] = [];
      for (let g = 0; g < G; g++) {
        const slice = fabric.spines.slice(g * perGroup, (g + 1) * perGroup).map((s) => s.id);
        if (slice.length > 0) groups.push(slice);
      }
      const slotW = layoutWidth / groups.length;
      groups.forEach((spines, gi) => {
        const groupCx = baseLeftX + gi * slotW + slotW / 2;
        spines.forEach((sid, i) => {
          // arrange members in a tight 2-column cluster
          const col = i % 2;
          const row = Math.floor(i / 2);
          positions.set(sid, {
            x: groupCx - SPINE_NODE_W / 2 + (col === 0 ? -45 : 45),
            y: SPINE_Y - row * 40,
          });
        });
        // Background block per supernode
        bgRects.push({
          x: groupCx - 90, y: SPINE_Y - 30,
          w: 180, h: 90,
          color: RAIL_PALETTE[gi % RAIL_PALETTE.length],
          label: `Supernode ${gi + 1}`,
        });
        // intra-group all-to-all
        for (let i = 0; i < spines.length; i++) {
          for (let j = i + 1; j < spines.length; j++) {
            extraEdges.push({ from: spines[i], to: spines[j], kind: "intra-group" });
          }
        }
      });
      return { positions, extraEdges, bgRects };
    }

    case "spine-leaf":
    default: {
      // Single row, evenly distributed.
      const stepX = Math.max(SPINE_NODE_W + 20, layoutWidth / N);
      fabric.spines.forEach((s, i) => {
        positions.set(s.id, { x: baseLeftX + i * stepX, y: SPINE_Y });
      });
      return { positions, extraEdges, bgRects };
    }
  }
}

// ── Per-cluster layout ──────────────────────────────────────────────────────

type ClusterLayout = {
  servers: Map<string, { x: number; y: number; rackId: string }>;
  racks: Map<string, { x: number; y: number; w: number; h: number; rack: Rack }>;
  leaves: Map<string, { x: number; y: number }>;
  width: number;
};

function layoutCluster(cluster: Cluster, activeFabricId: string | null): ClusterLayout {
  const servers = new Map<string, { x: number; y: number; rackId: string }>();
  const racks = new Map<string, { x: number; y: number; w: number; h: number; rack: Rack }>();
  const leaves = new Map<string, { x: number; y: number }>();

  let cursorX = 60;
  for (const rack of cluster.racks) {
    const srvCount = Math.max(rack.servers.length, 1);
    const rackW = RACK_PAD_X * 2 + srvCount * SRV_W + (srvCount - 1) * SRV_GAP;
    const rackY = RACK_LABEL_Y - 6;
    const rackH = (SERVER_Y - rackY) + SRV_H + 6;
    racks.set(rack.id, { x: cursorX, y: rackY, w: rackW, h: rackH, rack });

    rack.servers.forEach((s, i) => {
      const sx = cursorX + RACK_PAD_X + i * (SRV_W + SRV_GAP);
      servers.set(s.id, { x: sx, y: SERVER_Y, rackId: rack.id });
    });

    const fabricLeaves = (rack.leaves ?? []).filter(
      (l) => !activeFabricId || l.fabric_id === activeFabricId,
    );
    fabricLeaves.forEach((l, i) => {
      const lx = cursorX + RACK_PAD_X + i * (LEAF_W + LEAF_GAP);
      leaves.set(l.id, { x: lx, y: LEAF_Y });
    });

    cursorX += rackW + RACK_GAP;
  }

  return { servers, racks, leaves, width: Math.max(cursorX, 360) };
}

// ── Intra-domain topology rendering helpers ────────────────────────────────

type Pt = { x: number; y: number };

/** Center of a member tile. */
function memberCenter(p: { x: number; y: number }): Pt {
  return { x: p.x + SRV_W / 2, y: p.y + SRV_H / 2 };
}

/** Build the SVG line definitions for the chosen intra topology. */
function intraEdges(positions: Pt[], topology: IntraTopology): { from: Pt; to: Pt }[] {
  const n = positions.length;
  if (n < 2) return [];
  switch (topology) {
    case "full-mesh":
      return allPairs(positions);
    case "ring":
      return ringEdges(positions);
    case "switch":
      // No direct member-member edges; switch nodes drawn separately.
      return [];
    case "hypercube":
      return hypercubeEdges(positions);
    case "torus":
      return torusEdges(positions);
  }
}

function allPairs(ps: Pt[]): { from: Pt; to: Pt }[] {
  const out: { from: Pt; to: Pt }[] = [];
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) out.push({ from: ps[i], to: ps[j] });
  }
  return out;
}
function ringEdges(ps: Pt[]): { from: Pt; to: Pt }[] {
  const out: { from: Pt; to: Pt }[] = [];
  for (let i = 0; i < ps.length; i++) out.push({ from: ps[i], to: ps[(i + 1) % ps.length] });
  return out;
}
/**
 * Hypercube: connect i↔j when their indices differ in exactly one bit.
 * For non-power-of-two n, falls back to closest pow2 connections (extras dangle).
 */
function hypercubeEdges(ps: Pt[]): { from: Pt; to: Pt }[] {
  const out: { from: Pt; to: Pt }[] = [];
  const n = ps.length;
  for (let i = 0; i < n; i++) {
    for (let bit = 1; bit < n; bit <<= 1) {
      const j = i ^ bit;
      if (j < n && j > i) out.push({ from: ps[i], to: ps[j] });
    }
  }
  return out;
}
/**
 * 2D torus: lay members in a near-square grid; connect 4-neighbours with wrap.
 */
function torusEdges(ps: Pt[]): { from: Pt; to: Pt }[] {
  const n = ps.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: { from: Pt; to: Pt }[] = [];
  const at = (r: number, c: number) => {
    const idx = r * cols + c;
    return idx < n ? ps[idx] : null;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cur = at(r, c);
      if (!cur) continue;
      const right = at(r, (c + 1) % cols);
      const down = at((r + 1) % rows, c);
      if (right && right !== cur) out.push({ from: cur, to: right });
      if (down && down !== cur) out.push({ from: cur, to: down });
    }
  }
  return out;
}

// ── Single-cluster panel ────────────────────────────────────────────────────

type PanelProps = {
  body: HwSpecBody;
  cluster: Cluster;
  clusterIdx: number;
  activeFabric: ScaleOutFabric | null;
  overlays?: TopologyOverlay[];
  selection: Selection;
  onSelectSpine: (fabricId: string, spineId: string) => void;
  onSelectLeaf: (clusterId: string, rackId: string, leafId: string) => void;
  onSelectDomain: (clusterId: string, domainId: string) => void;
  onSelectServer: (clusterId: string, rackId: string, serverId: string) => void;
  onSelectRack: (clusterId: string, rackId: string) => void;
  onSelectLink: (clusterId: string, rackId: string, leafId: string, spineId: string) => void;
};

function ClusterNetworkPanel(props: PanelProps) {
  const {
    body, cluster, clusterIdx, activeFabric, overlays, selection,
    onSelectSpine, onSelectLeaf, onSelectDomain, onSelectServer, onSelectRack, onSelectLink,
  } = props;
  void body;

  const overlayLookup = useMemo(() => buildOverlayLookup(overlays), [overlays]);
  const railMap = useMemo(() => buildRailMap(activeFabric), [activeFabric]);
  const layout = useMemo(
    () => layoutCluster(cluster, activeFabric?.id ?? null),
    [cluster, activeFabric],
  );

  const selectedSpineId = selection?.kind === "spine" ? selection.spineId : null;
  const selectedLeafId =
    selection?.kind === "leaf" && selection.clusterId === cluster.id ? selection.leafId : null;
  const selectedDomainId =
    selection?.kind === "scale_up_domain" && selection.clusterId === cluster.id
      ? selection.domainId : null;
  const selectedServerId =
    selection?.kind === "server" && selection.clusterId === cluster.id ? selection.serverId : null;
  const selectedRackId =
    selection?.kind === "rack" && selection.clusterId === cluster.id ? selection.rackId : null;
  const selectedLink =
    selection?.kind === "link" && selection.clusterId === cluster.id
      ? { leafId: selection.leafId, spineId: selection.spineId } : null;

  const { nodes, edges, leafCount, linkCount, hotLink } = useMemo(() => {
    type HotLink = { src: string; dst: string; util: number };
    const ns: Node[] = [];
    const es: Edge[] = [];
    let hot = null as HotLink | null;
    let totalLinks = 0;
    let leafTotal = 0;

    // Pre-compute: server → (only) domain it belongs to, for inline SW badge on
    // single-server domains.
    const serverDomain = new Map<string, ScaleUpDomain>();
    for (const d of cluster.scale_up_domains ?? []) {
      if (d.members.length === 1) serverDomain.set(d.members[0].server_id, d);
    }

    // 1. Multi-server domain envelopes (single-member domains skip the envelope
    // and use an inline SW badge on the server dot instead).
    for (const d of cluster.scale_up_domains ?? []) {
      const memberPositions = d.members
        .map((m) => layout.servers.get(m.server_id))
        .filter((p): p is NonNullable<typeof p> => !!p);
      if (memberPositions.length === 0) continue;
      const sel = d.id === selectedDomainId;
      const topo = d.intra_topology ?? "full-mesh";

      if (memberPositions.length === 1) {
        // No envelope — visualization is the inline SW badge on the dot.
        // Still emit the envelope as a thin ring for selection feedback.
        if (sel) {
          const p = memberPositions[0];
          ns.push({
            id: `dom-${cluster.id}-${d.id}`,
            type: "default",
            position: { x: p.x - 4, y: p.y - 4 },
            data: { label: null, domainId: d.id, clusterId: cluster.id },
            style: {
              width: SRV_W + 8, height: SRV_H + 8,
              background: "transparent",
              border: `2px solid ${DOMAIN_STROKE[d.kind]}`,
              borderRadius: 8, padding: 0,
            },
            selectable: true, draggable: false, zIndex: 0,
          });
        }
        continue;
      }

      const minX = Math.min(...memberPositions.map((p) => p.x)) - ENV_PAD;
      const maxX = Math.max(...memberPositions.map((p) => p.x + SRV_W)) + ENV_PAD;
      const minY = Math.min(...memberPositions.map((p) => p.y)) - ENV_PAD - ENV_LABEL_H;
      const serverBottom = Math.max(...memberPositions.map((p) => p.y + SRV_H));
      // Reserve space below servers for: gap + SW node (50px = circle 32 + label) + tail pad.
      const maxY = serverBottom + 14 + 50 + 6;
      ns.push({
        id: `dom-${cluster.id}-${d.id}`,
        type: "default",
        position: { x: minX, y: minY },
        data: {
          label: <DomainEnvelope domain={d} sel={sel} />,
          domainId: d.id, clusterId: cluster.id,
        },
        style: {
          width: maxX - minX, height: maxY - minY,
          background: DOMAIN_FILL[d.kind],
          border: `1.5px ${sel ? "solid" : "dashed"} ${DOMAIN_STROKE[d.kind]}`,
          borderRadius: 8, padding: 0,
        },
        selectable: true, draggable: false, zIndex: 0,
      });

      if (topo === "switch") {
        // SW node aligned exactly with the server row, so each member's
        // handle sits directly below its server tile — lines stay vertical,
        // never cross. Sort members by x to keep order stable.
        const sortedPositions = [...memberPositions]
          .map((p, i) => ({ p, idx: i }))
          .sort((a, b) => a.p.x - b.p.x);
        const SW_W = memberPositions.length * SRV_W + (memberPositions.length - 1) * SRV_GAP;
        const SW_H = 56;
        const cx = sortedPositions[0].p.x;       // align with leftmost server
        const cy = serverBottom + 18;
        // Each handle i sits centered above its corresponding server (in SORTED
        // order). The edge below uses the same sorted index.
        ns.push({
          id: `sw-${cluster.id}-${d.id}`,
          type: "switchNode",
          position: { x: cx, y: cy },
          data: {
            domain: d, width: SW_W, height: SW_H,
            memberCount: memberPositions.length,
            srvW: SRV_W, srvGap: SRV_GAP,
          },
          style: { width: SW_W, height: SW_H, background: "transparent", border: "none", padding: 0 },
          draggable: false, selectable: false, zIndex: 4,
        });
        // Map member.server_id → its handle index (== its sorted x rank)
        const handleIdx = new Map<string, number>();
        sortedPositions.forEach((sp, i) => {
          handleIdx.set(d.members[sp.idx].server_id, i);
        });
        d.members.forEach((m, i) => {
          const hIdx = handleIdx.get(m.server_id) ?? i;
          es.push({
            id: `sw-edge-${cluster.id}-${d.id}-${i}`,
            source: `srv-${cluster.id}-${m.server_id}`,
            target: `sw-${cluster.id}-${d.id}`,
            sourceHandle: "srv-bottom",
            targetHandle: `sw-top-${hIdx}`,
            type: "straight",
            style: { stroke: DOMAIN_STROKE[d.kind], strokeWidth: 3, strokeOpacity: 1.0 },
            zIndex: 3,
            data: { intra: true },
          });
        });
      } else {
        const _edges = intraEdges(memberPositions.map(memberCenter), topo);
        const memberServerIds = d.members.map((m) => m.server_id);
        const ptIndex = memberPositions.map((p) => ({
          cx: p.x + SRV_W / 2, cy: p.y + SRV_H / 2,
        }));
        _edges.forEach((e, i) => {
          const fi = ptIndex.findIndex((pt) => pt.cx === e.from.x && pt.cy === e.from.y);
          const ti = ptIndex.findIndex((pt) => pt.cx === e.to.x && pt.cy === e.to.y);
          if (fi < 0 || ti < 0) return;
          es.push({
            id: `intra-${cluster.id}-${d.id}-${i}`,
            source: `srv-${cluster.id}-${memberServerIds[fi]}`,
            target: `srv-${cluster.id}-${memberServerIds[ti]}`,
            sourceHandle: "srv-bottom",
            targetHandle: "srv-bottom",
            type: "straight",
            // Server ↔ Server (mesh/ring/torus/hypercube) — also strong green.
            style: { stroke: DOMAIN_STROKE[d.kind], strokeWidth: 2.5, strokeOpacity: 0.95 },
            zIndex: 3,
            data: { intra: true },
          });
        });
      }
    }

    // 2. Rack containers — thin dashed box surrounding the rack's servers.
    // Plus a small label inside top-left.
    for (const [rackId, rb] of layout.racks) {
      const sel = rackId === selectedRackId;
      // Rack box covers everything: envelope label band, server row, gap,
      // SW node (32 circle + 18 BW label = 50), and trailing pad.
      const rackBoxY = SERVER_Y - 30;
      const rackBoxH = 30 + SRV_H + 14 + 50 + 10;  // ≈ 146
      ns.push({
        id: `rack-${cluster.id}-${rackId}`,
        type: "default",
        position: { x: rb.x - 4, y: rackBoxY },
        data: { label: null, rackId, clusterId: cluster.id },
        style: {
          width: rb.w + 8, height: rackBoxH,
          background: "transparent",
          border: `1px ${sel ? "solid" : "dashed"} ${sel ? "var(--blue)" : "var(--hairline-2)"}`,
          borderRadius: 6, padding: 0,
        },
        selectable: true, draggable: false, zIndex: 0,
      });
      // Rack label sits above the box.
      ns.push({
        id: `rack-label-${cluster.id}-${rackId}`,
        type: "default",
        position: { x: rb.x, y: RACK_LABEL_Y },
        data: { label: <RackLabel rack={rb.rack} sel={sel} />, rackId, clusterId: cluster.id },
        style: { width: rb.w, height: 14, background: "transparent", border: "none", padding: 0 },
        selectable: true, draggable: false, zIndex: 1,
      });
    }

    // 3. Server tiles (custom node with top + bottom handles so we can route
    //    Scale-up edges out the BOTTOM toward NVSwitch, away from the tile.)
    for (const r of cluster.racks) {
      for (const s of r.servers) {
        const p = layout.servers.get(s.id);
        if (!p) continue;
        const sel = s.id === selectedServerId;
        const inlineDomain = serverDomain.get(s.id);
        ns.push({
          id: `srv-${cluster.id}-${s.id}`,
          type: "serverNode",
          position: { x: p.x, y: p.y },
          data: {
            srv: s, sel, inlineDomain,
            serverId: s.id, rackId: r.id, clusterId: cluster.id,
          },
          selectable: true, draggable: false,
          zIndex: 5,
        });
      }
    }

    // 4. Spines + leaves of active fabric. Spine layout depends on
    //    fabric.topology — see computeSpineLayout.
    if (activeFabric) {
      const spineLayout = computeSpineLayout(activeFabric, 60, Math.max(layout.width - 120, 240));

      // 4a. Background blocks (rail tints / supernodes) — render BEHIND spines.
      spineLayout.bgRects.forEach((rc, idx) => {
        ns.push({
          id: `spine-bg-${cluster.id}-${activeFabric.id}-${idx}`,
          type: "default",
          position: { x: rc.x, y: rc.y },
          data: {
            label: rc.label ? (
              <div style={{
                position: "absolute", top: 2, left: 6,
                fontSize: 9, fontWeight: 600, color: rc.color,
              }}>{rc.label}</div>
            ) : null,
          },
          style: {
            width: rc.w, height: rc.h,
            background: `${rc.color}1A`,        // ~10% alpha
            border: `1px dashed ${rc.color}`,
            borderRadius: 6, padding: 0,
          },
          selectable: false, draggable: false, zIndex: 0,
        });
      });

      // 4b. Spines at their topology-specific positions
      activeFabric.spines.forEach((s) => {
        const pos = spineLayout.positions.get(s.id);
        if (!pos) return;
        const sel = s.id === selectedSpineId;
        const railColor = railMap.get(s.id);
        ns.push({
          id: `spine-${cluster.id}-${s.id}`,
          type: "spineNode",
          position: pos,
          data: { spine: s, sel, railColor, fabricId: activeFabric.id, spineId: s.id },
          selectable: true, draggable: false, zIndex: 5,
        });
      });

      // 4c. Synthetic spine↔spine edges (fat-tree core↔agg or dragonfly mesh).
      spineLayout.extraEdges.forEach((ex, idx) => {
        es.push({
          id: `xspine-${cluster.id}-${activeFabric.id}-${idx}`,
          source: `spine-${cluster.id}-${ex.from}`,
          target: `spine-${cluster.id}-${ex.to}`,
          type: "default",
          style: {
            stroke: ex.kind === "intra-group" ? "rgba(180,140,255,0.6)" : "rgba(64,144,255,0.5)",
            strokeWidth: 1.5,
            strokeDasharray: ex.kind === "intra-group" ? undefined : "5 4",
          },
          data: { decorative: true },
          zIndex: 2,
        });
      });

      for (const r of cluster.racks) {
        const fabricLeaves = (r.leaves ?? []).filter((l) => l.fabric_id === activeFabric.id);
        leafTotal += fabricLeaves.length;
        fabricLeaves.forEach((l) => {
          const p = layout.leaves.get(l.id);
          if (!p) return;
          const sel = l.id === selectedLeafId;
          ns.push({
            id: `leaf-${cluster.id}-${l.id}`,
            type: "leafNode",
            position: { x: p.x, y: p.y },
            data: { leaf: l, sel, leafId: l.id, rackId: r.id, clusterId: cluster.id },
            selectable: true, draggable: false, zIndex: 5,
          });
          // Subtle leaf → rack edge (1px hairline gray) — communicates
          // "this leaf serves this rack" without label clutter.
          es.push({
            id: `leaf-rack-${cluster.id}-${l.id}-${r.id}`,
            source: `leaf-${cluster.id}-${l.id}`,
            target: `rack-${cluster.id}-${r.id}`,
            type: "default",
            style: { stroke: "var(--hairline)", strokeWidth: 1, strokeOpacity: 0.7 },
            data: { decorative: true },
            zIndex: 1,
          });
          // Uplinks → spines (one edge per uplink, with aggregation label)
          l.uplinks.forEach((up) => {
            totalLinks += 1;
            const util = up.util_pct ?? 0;
            const down = up.down ?? false;
            const lanes = up.lanes ?? 1;
            const spine = activeFabric.spines.find((sp) => sp.id === up.spine);
            const perLaneBw = up.bandwidth_gbps ?? spine?.bandwidth_per_port_gbps ?? 0;
            const totalBw = lanes * perLaneBw;
            const ov = lookupEdge(overlayLookup, up.spine, l.id);
            const railColor = railMap.get(up.spine);
            const baseStroke = railColor ?? colorFor(util, down);
            const baseWidth = down ? 1 : Math.max(1, Math.min(4, Math.log2(Math.max(1, lanes)) + 1.2));
            const stroke = ov ? SEVERITY_STROKE[ov.severity] : baseStroke;
            const width = ov ? SEVERITY_WIDTH[ov.severity] : baseWidth;
            const animated = ov ? ov.severity !== "low" : (util >= 80 && !down);
            const isLinkSelected =
              selectedLink && selectedLink.leafId === l.id && selectedLink.spineId === up.spine;
            const label = down
              ? "down"
              : lanes > 1
                ? `${perLaneBw}G ×${lanes}${util ? ` · ${util}%` : ""}`
                : `${perLaneBw ? `${perLaneBw}G · ` : ""}${util}%`;
            es.push({
              id: `link-${cluster.id}-${up.spine}-${l.id}`,
              source: `spine-${cluster.id}-${up.spine}`, target: `leaf-${cluster.id}-${l.id}`,
              animated,
              style: {
                stroke, strokeWidth: isLinkSelected ? width + 1 : width,
                strokeDasharray: down ? "4 3" : undefined,
                filter: isLinkSelected ? "drop-shadow(0 0 4px var(--blue))" : undefined,
              },
              label,
              labelStyle: { fill: stroke, fontSize: 9 },
              labelBgStyle: { fill: "var(--bg-2)", fillOpacity: 0.85 },
              data: {
                overlay: ov ?? undefined,
                clusterId: cluster.id, rackId: r.id, leafId: l.id, spineId: up.spine,
                kind: "uplink",
              },
            });
            if (!down && (!hot || util > hot.util)) hot = { src: up.spine, dst: l.id, util };
            void totalBw;
          });
        });
      }
    }

    // 5. Tier divider (visual band between scale-out and scale-up)
    ns.push({
      id: `divider-${cluster.id}`,
      type: "default",
      position: { x: 0, y: DIVIDER_Y },
      data: { label: <TierDivider /> },
      style: { width: layout.width, height: 26, background: "transparent", border: "none", padding: 0 },
      draggable: false, selectable: false, zIndex: 0,
    });

    return { nodes: ns, edges: es, leafCount: leafTotal, linkCount: totalLinks, hotLink: hot };
  }, [cluster, layout, activeFabric, overlayLookup, railMap, selectedSpineId, selectedLeafId, selectedDomainId, selectedServerId, selectedRackId, selectedLink]);

  const handleNodeClick: NodeMouseHandler = (_e, node) => {
    const data: any = node.data ?? {};
    if (data.serverId) return onSelectServer(data.clusterId, data.rackId, data.serverId);
    if (data.rackId && !data.serverId && !data.leafId) return onSelectRack(data.clusterId, data.rackId);
    if (data.domainId) return onSelectDomain(data.clusterId, data.domainId);
    if (data.spineId && data.fabricId) return onSelectSpine(data.fabricId, data.spineId);
    if (data.leafId) return onSelectLeaf(data.clusterId, data.rackId, data.leafId);
  };

  const handleEdgeClick: EdgeMouseHandler = (_e, edge) => {
    const d: any = edge.data ?? {};
    if (d.kind === "uplink") {
      onSelectLink(d.clusterId, d.rackId, d.leafId, d.spineId);
    }
  };

  const totalDomains = (cluster.scale_up_domains ?? []).length;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <div className="card-t">
          <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 400 }}>
            C{String(clusterIdx + 1).padStart(2, "0")}
          </span>
          <span style={{ marginLeft: 8 }}>{cluster.name?.trim() || cluster.id}</span>
          <span style={{ color: "var(--t3)", fontSize: 11, fontWeight: 400, marginLeft: 12 }}>
            · {cluster.racks.length} 机柜 · {leafCount} Leaf · {totalDomains} Scale-up 域
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="tag tag-teal">链路 {linkCount}</span>
          {hotLink && (
            <span className="tag tag-red">
              热链 {hotLink.src} ↔ {hotLink.dst} · {hotLink.util}%
            </span>
          )}
        </div>
      </div>
      <div style={{ height: 520, border: "1px solid var(--hairline)", borderRadius: "var(--r-md)" }}>
        <ReactFlow
          nodes={nodes} edges={edges}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          nodeTypes={NODE_TYPES}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
        >
          <Background color="rgba(255,255,255,0.06)" gap={16} />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

// ── NetworkView (top-level orchestrator) ────────────────────────────────────

type Props = {
  body: HwSpecBody;
  overlays?: TopologyOverlay[];
  selection: Selection;
  onSelectFabric: (fabricId: string) => void;
  onSelectSpine: (fabricId: string, spineId: string) => void;
  onSelectLeaf: (clusterId: string, rackId: string, leafId: string) => void;
  onSelectDomain: (clusterId: string, domainId: string) => void;
  onSelectServer: (clusterId: string, rackId: string, serverId: string) => void;
  onSelectRack: (clusterId: string, rackId: string) => void;
  onSelectLink: (clusterId: string, rackId: string, leafId: string, spineId: string) => void;
  // The two architectural-decision edits supported in network view:
  onChangeFabricTopology: (fabricId: string, topology: ScaleOutTopology) => void;
  onApplyScaleUpScope: (racksPerDomain: number) => void;
};

const TOPOLOGY_CHOICES: ScaleOutTopology[] = ["spine-leaf", "fat-tree", "rail-optimized", "dragonfly"];

export function NetworkView(props: Props) {
  const {
    body, overlays, selection,
    onSelectFabric, onSelectSpine, onSelectLeaf, onSelectDomain, onSelectServer, onSelectRack, onSelectLink,
    onChangeFabricTopology, onApplyScaleUpScope,
  } = props;

  const fabrics: ScaleOutFabric[] = body.datacenter?.scale_out_fabrics ?? [];
  const clusters = body.datacenter?.clusters ?? [];
  const overlaySummary = summarizeOverlays(overlays);

  const activeFromSel =
    selection?.kind === "scale_out_fabric" ? selection.fabricId :
    selection?.kind === "spine" ? selection.fabricId :
    selection?.kind === "rail" ? selection.fabricId :
    null;
  const [localFabricId, setLocalFabricId] = useState<string | null>(null);
  const activeFabricId = activeFromSel ?? localFabricId ?? fabrics[0]?.id ?? null;
  const activeFabric = fabrics.find((f) => f.id === activeFabricId) ?? null;

  if (clusters.length === 0) {
    return (
      <div className="card" style={{ color: "var(--t3)", fontSize: 12 }}>
        当前 HwSpec 没有集群，先去「机房视图」新建集群。
      </div>
    );
  }

  return (
    <div>
      {/* Simplified toolbar: fabric tabs + 2 architectural decision controls. */}
      <div className="card" style={{
        marginBottom: 10, padding: "8px 12px",
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        {fabrics.map((f) => {
          const active = f.id === activeFabricId;
          return (
            <button
              key={f.id}
              className={`btn ${active ? "btn-primary" : "btn-ghost"}`}
              style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={() => { setLocalFabricId(f.id); onSelectFabric(f.id); }}
            >
              {f.name?.trim() || f.id}
              <span style={{ opacity: 0.6, marginLeft: 4 }}>· {f.kind}</span>
            </button>
          );
        })}

        <div style={{ marginLeft: 20, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--t3)" }}>Scale-out 拓扑</span>
          <select
            className="inp"
            disabled={!activeFabric}
            value={activeFabric?.topology ?? ""}
            onChange={(e) => activeFabric && onChangeFabricTopology(activeFabric.id, e.target.value as ScaleOutTopology)}
            style={{ fontSize: 12, padding: "4px 8px", minWidth: 130 }}
          >
            {TOPOLOGY_CHOICES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <ScopeInput onApply={onApplyScaleUpScope} />


        {overlaySummary && (
          <span className="tag tag-orange" data-testid="fabric-overlay-legend"
            title={overlays?.map((o) => o.legend).join(" · ")}
            style={{ marginLeft: "auto" }}>
            叠加 · {overlaySummary}
          </span>
        )}
      </div>

      {clusters.map((c, i) => (
        <ClusterNetworkPanel
          key={c.id}
          body={body} cluster={c} clusterIdx={i}
          activeFabric={activeFabric} overlays={overlays} selection={selection}
          onSelectSpine={onSelectSpine}
          onSelectLeaf={onSelectLeaf}
          onSelectDomain={onSelectDomain}
          onSelectServer={onSelectServer}
          onSelectRack={onSelectRack}
          onSelectLink={onSelectLink}
        />
      ))}

      <div className="card" style={{ padding: "8px 12px", fontSize: 10.5, color: "var(--t3)" }}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontWeight: 600, color: "var(--t2)" }}>连接图例：</span>
          <span>
            <svg width="34" height="10" style={{ verticalAlign: "middle" }}>
              <line x1="2" y1="5" x2="32" y2="5" stroke="var(--green)" strokeWidth="2" />
            </svg>{" "}Scale-out · uplink（按 util/rail 着色）
          </span>
          <span>
            <svg width="34" height="10" style={{ verticalAlign: "middle" }}>
              <line x1="2" y1="5" x2="32" y2="5" stroke="rgba(72,200,116,0.85)" strokeWidth="3" />
            </svg>{" "}Scale-up · NVLink/CXL
          </span>
          <span>
            <svg width="34" height="10" style={{ verticalAlign: "middle" }}>
              <line x1="2" y1="5" x2="32" y2="5" stroke="var(--hairline)" strokeWidth="1" />
            </svg>{" "}Leaf ↔ Rack 从属
          </span>
          <span>
            <svg width="34" height="10" style={{ verticalAlign: "middle" }}>
              <line x1="2" y1="5" x2="32" y2="5" stroke="var(--t4)" strokeWidth="1.5" strokeDasharray="3 3" />
            </svg>{" "}故障 / 离线
          </span>
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 5 }}>
          <span>
            <span style={{
              display: "inline-block", width: 10, height: 10,
              background: "rgba(72,200,116,0.16)",
              border: "1.5px dashed rgba(72,200,116,0.85)",
              borderRadius: 2, verticalAlign: "middle",
            }} /> Scale-up 域（envelope）
          </span>
          <span>
            <span style={{
              display: "inline-block", width: 10, height: 10,
              background: "rgba(72,200,116,0.32)",
              border: "2px solid rgba(72,200,116,1)",
              borderRadius: 5, verticalAlign: "middle",
            }} /> NVSwitch（中央节点）
          </span>
          <span style={{ marginLeft: "auto", opacity: 0.7 }}>
            网络视图为只读视图 · 详细编辑请到「机房视图」
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Custom node renderers (with Handles for connect mode) ───────────────────

function SpineNodeRf({ data }: { data: any }) {
  const s: Spine = data.spine;
  const sel: boolean = data.sel;
  const railColor: string | undefined = data.railColor;
  const cls = s.status === "fail" ? "fail" : s.status === "warn" ? "warn" : "";
  // Render the rail color as a strong border + fill tint, not just a top stripe.
  const railTint = railColor
    ? { borderColor: railColor, boxShadow: `inset 0 0 0 1px ${railColor}40, 0 0 0 1px ${railColor}30` }
    : {};
  return (
    <div className={`rf-node spine ${cls}`} style={{
      ...railTint,
      ...(sel ? { outline: "2px solid var(--blue)" } : {}),
      position: "relative",
    }}>
      {s.id}{s.status === "warn" && " ⚠"}{s.status === "fail" && " ✗"}
      {s.name && <span className="rf-node-sub">{s.name}</span>}
      <Handle type="source" position={Position.Bottom} style={{ background: "var(--blue)", width: 8, height: 8 }} />
    </div>
  );
}

function LeafNodeRf({ data }: { data: any }) {
  const l: Leaf = data.leaf;
  const sel: boolean = data.sel;
  const cls = l.status === "fail" ? "fail" : l.status === "warn" ? "warn" : "";
  return (
    <div className={`rf-node leaf ${cls}`} style={{
      ...(sel ? { outline: "2px solid var(--blue)" } : {}),
      position: "relative",
    }}>
      <Handle type="target" position={Position.Top} style={{ background: "var(--blue)", width: 8, height: 8 }} />
      {l.name?.trim() || l.id}
      {l.status === "warn" && " 🔥"}{l.status === "fail" && " ✗"}
      <span className="rf-node-sub">{l.uplinks.length} 上联</span>
      <Handle type="source" position={Position.Bottom} style={{ background: "transparent", border: "none", width: 1, height: 1 }} />
    </div>
  );
}

const NODE_TYPES = {
  spineNode: SpineNodeRf,
  leafNode: LeafNodeRf,
  serverNode: ServerNodeRf,
  switchNode: SwitchNodeRf,
};

function ServerNodeRf({ data }: { data: any }) {
  return (
    <>
      {/* invisible handles, positioned at top and bottom */}
      <Handle id="srv-top" type="target" position={Position.Top}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }} />
      <Handle id="srv-bottom" type="source" position={Position.Bottom}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }} />
      <ServerDot srv={data.srv} sel={data.sel} inlineDomain={data.inlineDomain} />
    </>
  );
}

function SwitchNodeRf({ data }: { data: any }) {
  const d: ScaleUpDomain = data.domain;
  const w: number = data.width ?? 96;
  const h: number = data.height ?? 56;
  const memberCount: number = data.memberCount ?? 1;
  const srvW: number = data.srvW ?? 60;
  const srvGap: number = data.srvGap ?? 8;
  // Place each handle at the px x that matches the corresponding server's
  // center. This makes every server→SW line strictly vertical.
  const handles = Array.from({ length: memberCount }, (_, i) => {
    const px = i * (srvW + srvGap) + srvW / 2;
    return (
      <Handle
        key={i}
        id={`sw-top-${i}`}
        type="target"
        position={Position.Top}
        style={{
          left: `${px}px`, transform: "translateX(-50%)",
          background: "transparent", border: "none",
          width: 1, height: 1, top: 0,
        }}
      />
    );
  });
  return (
    <div style={{
      width: w, height: h,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "flex-start",
      gap: 3, paddingTop: 2,
    }}>
      {handles}
      <div
        title={`NVSwitch ×${d.switch_count ?? 1} · ${d.bandwidth_gbps} GB/s`}
        style={{
          width: w - 8, height: 28, borderRadius: 6,
          background: "rgba(72, 200, 116, 0.32)",
          border: "2px solid rgba(72, 200, 116, 1.0)",
          display: "grid", placeItems: "center",
          fontSize: 10, fontWeight: 800, color: "#48c874",
          textAlign: "center", lineHeight: 1.0,
        }}
      >
        SW{d.switch_count && d.switch_count > 1 ? ` ×${d.switch_count}` : ""}
      </div>
      <div style={{
        fontSize: 10, fontWeight: 700,
        color: DOMAIN_STROKE[d.kind],
        whiteSpace: "nowrap",
      }}>
        {d.bandwidth_gbps} GB/s
      </div>
    </div>
  );
}

function ServerDot({
  srv, sel, inlineDomain,
}: {
  srv: Server;
  sel: boolean;
  inlineDomain?: ScaleUpDomain;
}) {
  const k: ServerKind = srv.kind ?? "gpu";
  const alert = srv.status !== "ok";
  const showSwBadge = inlineDomain && (inlineDomain.intra_topology ?? "full-mesh") === "switch";
  const detailLine = srv.gpu_count > 0
    ? `${srv.gpu_count}× ${srv.gpu_model}`
    : (srv.cpu_model ? srv.cpu_model.split(" ")[0] : k);
  return (
    <div
      title={`${srv.name?.trim() || srv.id}\n${srv.id}\n${srv.gpu_count > 0 ? `${srv.gpu_count}× ${srv.gpu_model}` : (srv.cpu_model || k)}${inlineDomain ? `\n域: ${inlineDomain.name?.trim() || inlineDomain.id} (${inlineDomain.kind})` : ""}`}
      style={{
        width: SRV_W, height: SRV_H, position: "relative",
        borderRadius: 4,
        background: alert ? "rgba(255, 175, 64, 0.18)" : "rgba(72, 200, 116, 0.16)",
        border: `1px solid ${sel ? "var(--blue)" : alert ? "rgba(255, 175, 64, 0.55)" : "rgba(72, 200, 116, 0.55)"}`,
        boxShadow: sel ? "0 0 0 1px var(--blue) inset" : undefined,
        display: "flex", flexDirection: "column", gap: 1,
        padding: "3px 5px",
        fontSize: 9.5, lineHeight: 1.15, cursor: "pointer",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        color: alert ? "#ffaf40" : "#48c874",
      }}>
        <span style={{ fontWeight: 700 }}>{KIND_ICON[k]}</span>
        <span style={{
          color: "var(--t3)", fontSize: 9, fontWeight: 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {srv.id.replace(/^srv-(train|inf)-/, "")}
        </span>
        {showSwBadge && (
          <span
            style={{
              marginLeft: "auto",
              padding: "0 3px", borderRadius: 2,
              background: DOMAIN_STROKE[inlineDomain.kind],
              color: "#fff", fontSize: 7.5, fontWeight: 700,
            }}
            title={`NVSwitch · ${inlineDomain.bandwidth_gbps} GB/s`}
          >
            SW
          </span>
        )}
      </div>
      <div style={{
        color: "var(--t1)", fontSize: 9, fontWeight: 600,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {detailLine}
      </div>
    </div>
  );
}

function RackLabel({ rack, sel }: { rack: Rack; sel: boolean }) {
  return (
    <div style={{
      width: "100%",
      display: "flex", alignItems: "center", gap: 4,
      fontSize: 10,
      color: sel ? "var(--blue)" : "var(--t3)",
      cursor: "pointer",
    }}>
      <span style={{ fontWeight: 600 }}>{rack.id}</span>
      {rack.name && <span style={{ opacity: 0.7 }}>· {rack.name}</span>}
    </div>
  );
}

function DomainEnvelope({ domain, sel }: { domain: ScaleUpDomain; sel: boolean }) {
  const topo = domain.intra_topology ?? "full-mesh";
  return (
    <div style={{
      position: "absolute", top: 4, left: 8,
      fontSize: 10, fontWeight: 600,
      color: sel ? DOMAIN_STROKE[domain.kind] : "rgba(72, 200, 116, 0.95)",
      background: "var(--bg-2)", padding: "1px 6px", borderRadius: 4,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      maxWidth: "calc(100% - 16px)",
    }}>
      {domain.name?.trim() || domain.id} · {topo}{domain.kind === "nvlink-switch" && domain.switch_count ? ` ×${domain.switch_count}` : ""}
    </div>
  );
}

function ScopeInput({ onApply }: { onApply: (racksPerDomain: number) => void }) {
  const [n, setN] = useState<string>("1");
  const apply = () => {
    const v = Math.max(1, Math.floor(Number(n) || 1));
    onApply(v);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: "var(--t3)" }}>Scale-up 域范围</span>
      <input
        className="inp" type="number" min={1} step={1} value={n}
        onChange={(e) => setN(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
        style={{ fontSize: 12, padding: "4px 8px", width: 60 }}
        title="每个 Scale-up 域跨多少个机柜"
      />
      <span style={{ fontSize: 11, color: "var(--t3)" }}>机柜 / 域</span>
      <button
        className="btn btn-ghost"
        style={{ fontSize: 11, padding: "4px 10px" }}
        onClick={apply}
        title="重新生成所有集群的 Scale-up 域"
      >
        应用
      </button>
    </div>
  );
}

function TierDivider() {
  return (
    <div style={{
      width: "100%", height: "100%",
      display: "flex", alignItems: "center", gap: 10,
      padding: "0 12px",
      borderTop: "1px solid var(--hairline)",
      borderBottom: "1px solid var(--hairline)",
      background: "linear-gradient(90deg, rgba(64,144,255,0.06), rgba(72,200,116,0.06))",
      fontSize: 10, color: "var(--t2)", fontWeight: 600, letterSpacing: ".04em",
    }}>
      <span style={{ color: "#4090ff" }}>↑ SCALE-OUT · CLOS · IB/RoCE</span>
      <span style={{ marginLeft: "auto", color: "#48c874" }}>↓ SCALE-UP · NVLink/CXL · 1.8 TB/s</span>
    </div>
  );
}
