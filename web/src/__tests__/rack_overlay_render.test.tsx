/**
 * S6.3 — RackCanvas reverse-projects engine bottleneck onto server tiles.
 *
 * Locks:
 *   - Server tile gets `data-overlay-severity` attribute when matched.
 *   - Three severity tiers paint visibly distinct border / background.
 *   - Badge renders with engine's `issue` text when `badge` set.
 *   - Non-matching servers get nothing extra; the legend chip already
 *     covers cluster-wide attribution.
 *   - Lookup falls back to `<rack>.<srv>` qualified id form.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { RackCanvas } from "../components/topology/RackCanvas";
import type { Cluster, Rack } from "../api/specs";

const RACKS: Rack[] = [
  {
    id: "R1", status: "ok",
    servers: [
      { id: "srv-1", gpu_model: "B200", gpu_count: 8, nic: "CX7", status: "ok", tdp_kw: 10 },
      { id: "srv-2", gpu_model: "B200", gpu_count: 8, nic: "CX7", status: "ok", tdp_kw: 10 },
    ],
  },
  {
    id: "R2", status: "ok",
    servers: [
      { id: "srv-3", gpu_model: "H200", gpu_count: 8, nic: "CX7", status: "ok", tdp_kw: 10 },
    ],
  },
];

const CLUSTERS: Cluster[] = [{ id: "cl1", name: "C1", racks: RACKS }];

const baseProps = {
  selection: null,
  onSelectServer: () => {},
  onSelectRack: () => {},
  onSelectCluster: () => {},
  onAddServer: () => {},
  onAddRack: () => {},
  onAddCluster: () => {},
  onRemoveServer: () => {},
  onRemoveRack: () => {},
  onRemoveCluster: () => {},
};

describe("RackCanvas overlay node rendering", () => {
  it("baseline: no overlay → no severity attribute on any server", () => {
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} />);
    expect(screen.getByTestId("rack-server-srv-1").dataset.overlaySeverity).toBeUndefined();
    expect(screen.getByTestId("rack-server-srv-2").dataset.overlaySeverity).toBeUndefined();
    expect(screen.getByTestId("rack-server-srv-3").dataset.overlaySeverity).toBeUndefined();
  });

  it("matches server by exact id and stamps severity attribute", () => {
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} overlays={[{
      kind: "bottleneck", legend: "x",
      nodes: { "srv-2": { severity: "high", badge: "kv_spill" } },
    }]} />);
    const tile = screen.getByTestId("rack-server-srv-2");
    expect(tile.dataset.overlaySeverity).toBe("high");
    // Other servers untouched
    expect(screen.getByTestId("rack-server-srv-1").dataset.overlaySeverity).toBeUndefined();
    expect(screen.getByTestId("rack-server-srv-3").dataset.overlaySeverity).toBeUndefined();
  });

  it("renders severity-colored border on matched server", () => {
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} overlays={[{
      kind: "bottleneck", legend: "x",
      nodes: {
        "srv-1": { severity: "high" },
        "srv-2": { severity: "med" },
        "srv-3": { severity: "low" },
      },
    }]} />);
    expect(screen.getByTestId("rack-server-srv-1").style.borderLeft).toContain("var(--red)");
    expect(screen.getByTestId("rack-server-srv-2").style.borderLeft).toContain("var(--orange)");
    expect(screen.getByTestId("rack-server-srv-3").style.borderLeft).toContain("var(--teal)");
  });

  it("renders badge tag with severity-tinted color when engine provided one", () => {
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} overlays={[{
      kind: "bottleneck", legend: "x",
      nodes: { "srv-1": { severity: "high", badge: "kv_spill" } },
    }]} />);
    const badge = screen.getByTestId("rack-server-srv-1-badge");
    expect(badge.textContent).toBe("kv_spill");
    expect(badge.className).toContain("tag-red");
  });

  it("omits badge element when overlay node has no badge string", () => {
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} overlays={[{
      kind: "bottleneck", legend: "x",
      nodes: { "srv-1": { severity: "med" } },
    }]} />);
    expect(screen.queryByTestId("rack-server-srv-1-badge")).toBeNull();
    // But severity styling still applied
    expect(screen.getByTestId("rack-server-srv-1").dataset.overlaySeverity).toBe("med");
  });

  it("falls back to qualified <rack>.<srv> id form", () => {
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} overlays={[{
      kind: "bottleneck", legend: "x",
      nodes: { "R1.srv-1": { severity: "high", badge: "memory_bw" } },
    }]} />);
    expect(screen.getByTestId("rack-server-srv-1").dataset.overlaySeverity).toBe("high");
  });

  it("cluster-wide id (e.g. 'cluster') does not paint individual servers", () => {
    // The legend chip already shows cluster-wide attribution; per-server
    // rendering only fires on real matches to avoid painting everything red.
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} overlays={[{
      kind: "bottleneck", legend: "x",
      nodes: { "cluster": { severity: "high", badge: "kv_spill" } },
    }]} />);
    expect(screen.getByTestId("rack-server-srv-1").dataset.overlaySeverity).toBeUndefined();
    expect(screen.getByTestId("rack-server-srv-3").dataset.overlaySeverity).toBeUndefined();
    // But the legend chip is present (regression check on S6.1 behavior)
    expect(screen.getByTestId("rack-overlay-legend")).toBeInTheDocument();
  });

  it("title attribute composes badge + tooltip for hover affordance", () => {
    render(<RackCanvas {...baseProps} clusters={CLUSTERS} overlays={[{
      kind: "bottleneck", legend: "x",
      nodes: {
        "srv-1": { severity: "high", badge: "kv_spill", tooltip: "spill 12%" },
      },
    }]} />);
    const tile = screen.getByTestId("rack-server-srv-1");
    expect(tile.getAttribute("title")).toContain("kv_spill");
    expect(tile.getAttribute("title")).toContain("spill 12%");
  });
});
