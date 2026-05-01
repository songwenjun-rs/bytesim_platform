/**
 * RadarChart — multi-dimensional plan-slot profile.
 *
 * Locks:
 *   - Empty slots → renders nothing.
 *   - One polygon per slot up to cap (6); recommended polygon last in DOM.
 *   - Direction normalization: best slot's polygon hits the outer ring on
 *     each axis (score ≈ 1).
 *   - Missing kpi → vertex collapses to center (score 0).
 *   - Legend reflects the (capped) drawn list and marks recommended.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { RadarChart } from "../components/comparator/RadarChart";
import type { Run } from "../api/runs";

type PlanSlot = {
  slot: string;
  run_id: string;
  added_at: string;
  run?: Run;
};

function mkSlot(slot: string, runId: string, kpis: Record<string, number>,
                confidence?: number): PlanSlot {
  const run: Run = {
    id: runId, project_id: "p", kind: "infer", title: slot,
    status: "done", inputs_hash: "h", kpis,
    artifacts: [], boundaries: [],
    confidence: confidence ?? null,
    created_at: "2026-04-27T00:00:00Z",
  };
  return { slot, run_id: runId, added_at: "2026-04-27T00:00:00Z", run };
}

describe("<RadarChart>", () => {
  it("renders nothing when slots empty", () => {
    const { container } = render(<RadarChart slots={[]} />);
    expect(container.textContent).toBe("");
  });

  it("renders one polygon per slot", () => {
    render(<RadarChart slots={[
      mkSlot("A", "run-A", { mfu_pct: 50, cost_per_m_tok_usd: 0.4, ttft_p99_ms: 200, peak_kw: 700 }, 0.9),
      mkSlot("B", "run-B", { mfu_pct: 60, cost_per_m_tok_usd: 0.3, ttft_p99_ms: 250, peak_kw: 800 }, 0.85),
    ]} />);
    expect(screen.getByTestId("radar-polygon-A")).toBeInTheDocument();
    expect(screen.getByTestId("radar-polygon-B")).toBeInTheDocument();
  });

  it("caps at 6 polygons even when more slots provided", () => {
    const slots = Array.from({ length: 10 }).map((_, i) =>
      mkSlot(`s${i}`, `r${i}`, { mfu_pct: 50 + i }),
    );
    render(<RadarChart slots={slots} />);
    // 7..10 not drawn
    expect(screen.queryByTestId("radar-polygon-s6")).toBeNull();
    expect(screen.queryByTestId("radar-polygon-s9")).toBeNull();
    // 0..5 drawn
    expect(screen.getByTestId("radar-polygon-s0")).toBeInTheDocument();
    expect(screen.getByTestId("radar-polygon-s5")).toBeInTheDocument();
    // Overflow indicator
    expect(screen.getByText(/4 方案未画/)).toBeInTheDocument();
  });

  it("recommended polygon flagged via data-recommended + drawn last", () => {
    const slots = [
      mkSlot("A", "run-A", { mfu_pct: 50 }),
      mkSlot("B", "run-B", { mfu_pct: 60 }),
    ];
    const { container } = render(<RadarChart slots={slots} recommendedRunId="run-A" />);
    expect(screen.getByTestId("radar-polygon-A").dataset.recommended).toBe("true");
    expect(screen.getByTestId("radar-polygon-B").dataset.recommended).toBeUndefined();
    // DOM order — last polygon = on top = recommended A
    const polys = container.querySelectorAll("polygon[data-testid^=radar-polygon]");
    expect(polys.length).toBe(2);
    expect((polys[polys.length - 1] as SVGElement).getAttribute("data-testid"))
      .toBe("radar-polygon-A");
  });

  it("legend lists each drawn slot, marking recommended with ★", () => {
    const slots = [
      mkSlot("alpha", "run-1", { mfu_pct: 50 }),
      mkSlot("beta", "run-2", { mfu_pct: 60 }),
    ];
    render(<RadarChart slots={slots} recommendedRunId="run-1" />);
    const legend = screen.getByTestId("radar-legend");
    expect(legend.textContent).toContain("alpha");
    expect(legend.textContent).toContain("beta");
    expect(legend.textContent).toContain("★");
  });

  it("polygon points have 5 vertices (one per axis)", () => {
    const slots = [mkSlot("A", "run-A", {
      mfu_pct: 50, cost_per_m_tok_usd: 0.4, ttft_p99_ms: 200, peak_kw: 700,
    }, 0.9)];
    render(<RadarChart slots={slots} />);
    const points = screen.getByTestId("radar-polygon-A").getAttribute("points")!;
    const verts = points.split(" ").filter(Boolean);
    expect(verts.length).toBe(5);
  });
});
