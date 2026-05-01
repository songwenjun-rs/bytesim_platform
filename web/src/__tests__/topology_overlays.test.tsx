/**
 * S6.1 — Topology overlay contract tests.
 *
 * The overlay schema is the bridge between S1's engine attribution and the
 * S6 reverse-projection rendering. These tests lock:
 *   1. `buildBottleneckOverlay` correctly indexes BottleneckAttribution
 *      links/nodes by id, preserves severity, and composes tooltips.
 *   2. `summarizeOverlays` aggregates counts for the legend chip.
 *   3. RackCanvas / FabricView accept `overlays` prop and render the
 *      legend chip — geometry rendering is S6 and intentionally absent.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  buildBottleneckOverlay,
  parseOverlayParam,
  summarizeOverlays,
  type TopologyOverlay,
} from "../components/topology/overlays";
import { RackCanvas } from "../components/topology/RackCanvas";
import type { BottleneckAttribution } from "../api/runs";
import type { Rack } from "../api/specs";

// reactflow doesn't render in jsdom out-of-the-box; keep the mock minimal.
vi.mock("reactflow", () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="rf">{children}</div>,
  Background: () => null,
  Controls: () => null,
  Position: { Top: "top", Bottom: "bottom" },
}));

// ── builder ────────────────────────────────────────────────────────────────

describe("buildBottleneckOverlay", () => {
  it("indexes links by id and preserves severity", () => {
    const bn: BottleneckAttribution = {
      primary: "nvlink",
      severity: "high",
      headline: "NVLink 饱和",
      links: [
        { id: "nv-1", fabric: "nvlink", util_pct: 94, severity: "high" },
        { id: "ib-2", fabric: "infiniband", util_pct: 70, severity: "med" },
      ],
      nodes: [],
    };
    const o = buildBottleneckOverlay(bn, { id: "run-42", kind: "run" });
    expect(o.kind).toBe("bottleneck");
    expect(o.legend).toContain("NVLink 饱和");
    expect(o.links!["nv-1"].severity).toBe("high");
    expect(o.links!["nv-1"].tooltip).toContain("nvlink");
    expect(o.links!["nv-1"].tooltip).toContain("94%");
    expect(o.sourceId).toBe("run-42");
    expect(o.sourceKind).toBe("run");
  });

  it("composes node tooltip from metrics", () => {
    const bn: BottleneckAttribution = {
      primary: "kv_spill",
      severity: "high",
      headline: "x",
      links: [],
      nodes: [
        { id: "rack-A.srv-3", issue: "kv_spill", severity: "high",
          metrics: { spill_pct: 12, hbm_used_gb: 78 } },
      ],
    };
    const o = buildBottleneckOverlay(bn);
    expect(o.nodes!["rack-A.srv-3"].badge).toBe("kv_spill");
    expect(o.nodes!["rack-A.srv-3"].tooltip).toContain("spill_pct=12");
    expect(o.nodes!["rack-A.srv-3"].tooltip).toContain("hbm_used_gb=78");
  });

  it("omits empty maps so consumers can branch on presence", () => {
    const bn: BottleneckAttribution = {
      primary: "compute", severity: "low", headline: "x",
      links: [], nodes: [],
    };
    const o = buildBottleneckOverlay(bn);
    expect(o.links).toBeUndefined();
    expect(o.nodes).toBeUndefined();
  });

  it("preserves contributes_ms in tooltip when engine reports it", () => {
    const bn: BottleneckAttribution = {
      primary: "nvlink", severity: "high", headline: "x",
      links: [{
        id: "nv-1", fabric: "nvlink", util_pct: 90,
        severity: "high", contributes_ms: 12.4,
      }],
      nodes: [],
    };
    const o = buildBottleneckOverlay(bn);
    expect(o.links!["nv-1"].tooltip).toContain("12.4 ms");
  });
});

// ── deep-link parser ──────────────────────────────────────────────────────

describe("parseOverlayParam (S6.4 deep link)", () => {
  it("parses run:<id> form", () => {
    expect(parseOverlayParam("run:run-42")).toEqual({ kind: "run", id: "run-42" });
  });

  it("returns null for null/empty input", () => {
    expect(parseOverlayParam(null)).toBeNull();
    expect(parseOverlayParam(undefined)).toBeNull();
    expect(parseOverlayParam("")).toBeNull();
  });

  it("returns null for unsupported source kinds (future-extensible)", () => {
    expect(parseOverlayParam("study:s-1")).toBeNull();
    expect(parseOverlayParam("calibration:c-1")).toBeNull();
    expect(parseOverlayParam("garbage")).toBeNull();
  });

  it("returns null when run: prefix has empty id", () => {
    expect(parseOverlayParam("run:")).toBeNull();
  });

  it("preserves run id with colons (uuid-like)", () => {
    expect(parseOverlayParam("run:abc:def")).toEqual({ kind: "run", id: "abc:def" });
  });
});

// ── summarizer ─────────────────────────────────────────────────────────────

describe("summarizeOverlays", () => {
  it("returns null on empty input", () => {
    expect(summarizeOverlays(undefined)).toBeNull();
    expect(summarizeOverlays([])).toBeNull();
  });

  it("counts links and nodes across multiple overlays", () => {
    const o1: TopologyOverlay = {
      kind: "bottleneck", legend: "x",
      links: { L1: { severity: "high" }, L2: { severity: "med" } },
    };
    const o2: TopologyOverlay = {
      kind: "utilization", legend: "y",
      nodes: { N1: { severity: "low" } },
    };
    expect(summarizeOverlays([o1, o2])).toBe("2 叠加 · 2 链路 · 1 节点");
  });

  it("omits zero counts from the chip text", () => {
    const o: TopologyOverlay = {
      kind: "bottleneck", legend: "x",
      links: { L1: { severity: "high" } },
    };
    expect(summarizeOverlays([o])).toBe("1 叠加 · 1 链路");
  });
});

// ── RackCanvas legend ──────────────────────────────────────────────────────

const RACK: Rack = {
  id: "R1", status: "ok",
  servers: [{
    id: "srv-1", gpu_model: "B200", gpu_count: 8,
    nic: "CX7", status: "ok", tdp_kw: 10,
  }],
};

describe("RackCanvas overlays prop", () => {
  it("renders nothing extra when overlays is undefined", () => {
    render(
      <RackCanvas
        clusters={[{ id: "cl1", name: "C1", racks: [RACK] }]} selection={null}
        onSelectServer={() => {}} onSelectRack={() => {}} onSelectCluster={() => {}}
        onAddServer={() => {}} onAddRack={() => {}} onAddCluster={() => {}}
        onRemoveServer={() => {}} onRemoveRack={() => {}} onRemoveCluster={() => {}}
      />,
    );
    expect(screen.queryByTestId("rack-overlay-legend")).toBeNull();
  });

  it("renders summary chip when overlays supplied", () => {
    render(
      <RackCanvas
        clusters={[{ id: "cl1", name: "C1", racks: [RACK] }]} selection={null}
        onSelectServer={() => {}} onSelectRack={() => {}} onSelectCluster={() => {}}
        onAddServer={() => {}} onAddRack={() => {}} onAddCluster={() => {}}
        onRemoveServer={() => {}} onRemoveRack={() => {}} onRemoveCluster={() => {}}
        overlays={[{
          kind: "bottleneck", legend: "瓶颈: NVLink 饱和",
          links: { "nv-1": { severity: "high" } },
        }]}
      />,
    );
    const chip = screen.getByTestId("rack-overlay-legend");
    expect(chip.textContent).toContain("1 叠加");
    expect(chip.textContent).toContain("1 链路");
    expect(chip.getAttribute("title")).toContain("NVLink 饱和");
  });
});

