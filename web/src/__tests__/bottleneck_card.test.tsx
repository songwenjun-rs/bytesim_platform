/**
 * S2.1 — BottleneckCard renders engine-attributed bottleneck data the
 * RunDetail page reads from `Run.kpis.bottleneck` via getBottleneck().
 *
 * Three states matter:
 *   1. Engine did not attribute (no `bottleneck` field on kpis) → explicit
 *      "did not attribute" boundary, NOT a green "all good" panel.
 *   2. Low-severity (compute-bound default) → green tone, no suggested chip.
 *   3. High-severity with link/node geometry → warn tone, suggested chip,
 *      hot-link/problem-node lists capped at 3 with overflow indicator.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { BottleneckCard } from "../components/run/BottleneckCard";
import type { Run } from "../api/runs";

// All renders need a router because BottleneckCard renders <Link> when
// hwspecId is supplied. Wrap once via a helper.
const r = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

function baseRun(kpis: Record<string, unknown>): Run {
  return {
    id: "run-1",
    project_id: "p1",
    kind: "infer",
    title: "demo",
    status: "done",
    inputs_hash: "h",
    kpis: kpis as Record<string, number>,
    artifacts: [],
    boundaries: [],
    created_at: "2026-04-27T00:00:00Z",
  };
}

describe("BottleneckCard", () => {
  it("shows explicit 'did-not-attribute' note when engine omitted bottleneck", () => {
    r(<BottleneckCard run={baseRun({ mfu_pct: 50 })} />);
    expect(screen.getByText("瓶颈定位")).toBeInTheDocument();
    expect(screen.getByText("引擎未产出归因")).toBeInTheDocument();
    expect(
      screen.getByText(/不代表无瓶颈/),
    ).toBeInTheDocument();
  });

  it("renders compute-bound low-severity with no suggested chip", () => {
    const run = baseRun({
      mfu_pct: 50,
      bottleneck: {
        primary: "compute",
        severity: "low",
        headline: "以计算为主，MFU 50%",
        links: [],
        nodes: [],
      },
    });
    r(<BottleneckCard run={run} />);
    expect(screen.getByText("计算瓶颈")).toBeInTheDocument();
    expect(screen.getByText("轻微")).toBeInTheDocument();
    expect(screen.getByText("以计算为主，MFU 50%")).toBeInTheDocument();
    // No suggested_action ⇒ no "建议:" chip rendered
    expect(screen.queryByTestId("bn-suggested")).toBeNull();
    // No links/nodes ⇒ context grid hidden
    expect(screen.queryByTestId("bn-context")).toBeNull();
    // Tone: low → boundary-ok
    expect(screen.getByTestId("bn-tone")).toHaveClass("boundary-ok");
  });

  it("renders high-severity nvlink with suggested action and link list", () => {
    const run = baseRun({
      bottleneck: {
        primary: "nvlink",
        severity: "high",
        headline: "NVLink 链路 nv-1 利用率 94% — 接近饱和",
        suggested_action: "TP=8 → TP=4",
        links: [
          { id: "nv-1", fabric: "nvlink", util_pct: 94, severity: "high" },
          { id: "nv-2", fabric: "nvlink", util_pct: 82, severity: "med" },
          { id: "nv-3", fabric: "nvlink", util_pct: 76, severity: "med" },
          { id: "nv-4", fabric: "nvlink", util_pct: 70, severity: "low" },
        ],
        nodes: [],
      },
    });
    r(<BottleneckCard run={run} />);
    expect(screen.getByText("NVLink 饱和")).toBeInTheDocument();
    expect(screen.getByText("严重")).toBeInTheDocument();
    const chip = screen.getByTestId("bn-suggested");
    expect(chip.textContent).toContain("TP=8 → TP=4");
    // Tone: high → boundary-warn
    expect(screen.getByTestId("bn-tone")).toHaveClass("boundary-warn");
    // Hot-link list: shows top 3 + overflow line
    const ctx = screen.getByTestId("bn-context");
    expect(within(ctx).getByText(/nv-1.*nvlink.*94%/)).toBeInTheDocument();
    expect(within(ctx).getByText(/nv-3.*76%/)).toBeInTheDocument();
    expect(within(ctx).queryByText(/nv-4/)).toBeNull();
    expect(within(ctx).getByText("+1 条…")).toBeInTheDocument();
  });

  it("renders 在拓扑视图查看 link when hwspecId + projectable geometry both supplied", () => {
    const run = baseRun({
      bottleneck: {
        primary: "nvlink", severity: "high", headline: "x",
        suggested_action: "TP=8 → TP=4",
        links: [{ id: "nv-1", fabric: "nvlink", util_pct: 90, severity: "high" }],
        nodes: [],
      },
    });
    r(<BottleneckCard run={run} hwspecId="hwspec-foo" />);
    const link = screen.getByTestId("bn-topology-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/sim/cluster/hwspec-foo?overlay=run:run-1");
  });

  it("hides topology link when bottleneck has no projectable geometry", () => {
    const run = baseRun({
      bottleneck: {
        primary: "compute", severity: "low", headline: "x",
        links: [], nodes: [],
      },
    });
    r(<BottleneckCard run={run} hwspecId="hwspec-foo" />);
    expect(screen.queryByTestId("bn-topology-link")).toBeNull();
  });

  it("hides topology link when hwspecId omitted", () => {
    const run = baseRun({
      bottleneck: {
        primary: "nvlink", severity: "high", headline: "x",
        links: [{ id: "nv-1", fabric: "nvlink", util_pct: 90, severity: "high" }],
        nodes: [],
      },
    });
    r(<BottleneckCard run={run} />);
    expect(screen.queryByTestId("bn-topology-link")).toBeNull();
  });

  it("renders problem-node list when nodes have geometry", () => {
    const run = baseRun({
      bottleneck: {
        primary: "kv_spill",
        severity: "high",
        headline: "KV 工作集 180% 超出 HBM",
        links: [],
        nodes: [
          { id: "cluster", issue: "kv_spill", severity: "high",
            metrics: { pressure_pct: 180 } },
        ],
      },
    });
    r(<BottleneckCard run={run} />);
    expect(screen.getByText("KV 溢出")).toBeInTheDocument();
    const ctx = screen.getByTestId("bn-context");
    expect(within(ctx).getByText("问题节点")).toBeInTheDocument();
    expect(within(ctx).getByText(/cluster.*KV 溢出/)).toBeInTheDocument();
  });
});
