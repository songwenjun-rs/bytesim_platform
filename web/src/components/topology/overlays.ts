/**
 * S6.1 — Topology overlay contract.
 *
 * The shared shape that RackCanvas / FabricView accept as a `overlays` prop.
 * Day-1 (this slice) RackCanvas/FabricView only render a legend chip from
 * this — full geometry rendering (link recoloring, server badges) is S6's
 * job. Defining the API now means producers (RunDetail, Comparator) can
 * start emitting overlays in advance.
 *
 * Keys the overlays index by string id so consumers don't need to walk the
 * full topology to apply highlights. The convention:
 *   - link id      → matches `HwSpecBody.fabric.links[*].id` (FabricView)
 *                    or a synthetic `<rack>.<srv>.<nvlink/pcie>-<n>` id
 *                    (RackCanvas, when we add intra-server links in S6)
 *   - node id      → matches `HwSpecBody.datacenter.clusters[*].racks[*].servers[*].id`
 *                    or a finer `<rack>.<srv>.gpu-<n>` id once per-GPU
 *                    rendering lands
 *
 * Producers should use the helper builders at the bottom of this file
 * rather than constructing `TopologyOverlay` literals — the helpers
 * encode the contract (e.g. severity → tooltip phrasing) so the legend
 * stays consistent across pages.
 */

import type {
  BottleneckAttribution,
  Severity,
} from "../../api/runs";

export type OverlayKind = "bottleneck" | "utilization" | "workload-mapping";

export type OverlayLink = {
  severity: Severity;
  tooltip?: string;
};

export type OverlayNode = {
  severity: Severity;
  badge?: string;
  tooltip?: string;
};

export type TopologyOverlay = {
  kind: OverlayKind;
  /** Short label rendered in the canvas legend chip. */
  legend: string;
  /** Indexed by link id (matches HwSpecBody.fabric.links[*].id). */
  links?: Record<string, OverlayLink>;
  /** Indexed by node id (server id or GPU id, depending on resolution). */
  nodes?: Record<string, OverlayNode>;
  /** Optional source id — when present, UI may render a "back to source"
   *  affordance (e.g. linking the overlay back to the Run that produced it). */
  sourceId?: string;
  sourceKind?: "run" | "study" | "calibration";
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Adapt an engine-attributed `BottleneckAttribution` into an overlay the
 * topology canvases can render. Day-1 consumers (RunDetail's "回到拓扑"
 * link, Comparator) call this — it's the single bridge between the S1
 * attribution schema and the S6 rendering contract.
 *
 * `severity` is preserved verbatim; `tooltip` is composed from util / metrics
 * so the canvas hover doesn't need to re-reason about the attribution.
 */
export function buildBottleneckOverlay(
  bn: BottleneckAttribution,
  source?: { id: string; kind: "run" | "study" | "calibration" },
): TopologyOverlay {
  const links: Record<string, OverlayLink> = {};
  for (const l of bn.links) {
    links[l.id] = {
      severity: l.severity,
      tooltip: `${l.fabric} · ${l.util_pct.toFixed(0)}% util`
        + (l.contributes_ms != null ? ` · ${l.contributes_ms.toFixed(1)} ms` : ""),
    };
  }

  const nodes: Record<string, OverlayNode> = {};
  for (const n of bn.nodes) {
    const metricBits = Object.entries(n.metrics ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ");
    nodes[n.id] = {
      severity: n.severity,
      badge: n.issue,
      tooltip: metricBits || n.issue,
    };
  }

  return {
    kind: "bottleneck",
    legend: `瓶颈: ${bn.headline}`,
    links: Object.keys(links).length > 0 ? links : undefined,
    nodes: Object.keys(nodes).length > 0 ? nodes : undefined,
    sourceId: source?.id,
    sourceKind: source?.kind,
  };
}

/**
 * Parse Topology page's `?overlay=<source>:<id>` deep-link param.
 *
 * Today only `run:<id>` is supported. Future sources slot in here without
 * touching the rendering path:
 *   - `study:<id>`       — Pareto-derived attribution from a tuner study
 *   - `calibration:<id>` — measured-vs-predicted overlay
 *
 * Unsupported / malformed → null. Caller treats null as "no overlay".
 */
export function parseOverlayParam(
  raw: string | null | undefined,
): { kind: "run"; id: string } | null {
  if (!raw) return null;
  if (raw.startsWith("run:")) {
    const id = raw.slice("run:".length);
    return id.length > 0 ? { kind: "run", id } : null;
  }
  return null;
}

/**
 * Aggregate counts for the legend chip — single source so RackCanvas and
 * FabricView render the same summary string.
 */
export function summarizeOverlays(overlays: TopologyOverlay[] | undefined): string | null {
  if (!overlays || overlays.length === 0) return null;
  const linkCount = overlays.reduce(
    (a, o) => a + Object.keys(o.links ?? {}).length, 0,
  );
  const nodeCount = overlays.reduce(
    (a, o) => a + Object.keys(o.nodes ?? {}).length, 0,
  );
  const parts: string[] = [`${overlays.length} 叠加`];
  if (linkCount > 0) parts.push(`${linkCount} 链路`);
  if (nodeCount > 0) parts.push(`${nodeCount} 节点`);
  return parts.join(" · ");
}
