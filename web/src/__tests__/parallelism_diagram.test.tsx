/**
 * L1.1 — ParallelismDiagram TP×PP×EP×CP visual.
 *
 * Locks:
 *   - Empty placeholder when TP*PP = 0 (mid-edit case).
 *   - Cell count = TP × PP (capped at MAX_DIM each axis).
 *   - replicas = floor(gpu_count / TP*PP); annotated in subtitle.
 *   - EP groups cycle colors; cells carry data-ep-group attribute.
 *   - CP > 1 produces dashed cells for non-zero CP groups.
 *   - TP/PP truncation indicators visible past MAX_DIM.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { ParallelismDiagram } from "../components/sim/ParallelismDiagram";

describe("<ParallelismDiagram>", () => {
  it("renders empty placeholder when TP*PP = 0", () => {
    render(<ParallelismDiagram TP={0} PP={1} EP={1} CP={1} gpu_count={32} />);
    expect(screen.getByTestId("parallelism-diagram-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("parallelism-diagram")).toBeNull();
  });

  it("renders TP×PP cells when both > 0", () => {
    render(<ParallelismDiagram TP={4} PP={2} EP={1} CP={1} gpu_count={64} />);
    expect(screen.getByTestId("parallelism-diagram")).toBeInTheDocument();
    // 4 cols × 2 rows = 8 cells
    const cells = screen.getAllByTestId(/^gpu-cell-/);
    expect(cells.length).toBe(8);
  });

  it("subtitle reflects per-replica + replica count + total covered", () => {
    render(<ParallelismDiagram TP={4} PP={4} EP={1} CP={1} gpu_count={64} />);
    // 4*4 = 16 GPU/replica, 64/16 = 4 replicas, 4*16 = 64 covered
    const card = screen.getByTestId("parallelism-diagram");
    expect(card.dataset.replicas).toBe("4");
    expect(card.textContent).toContain("16 GPU/replica");
    expect(card.textContent).toContain("× 4 replicas");
    expect(card.textContent).not.toContain("未编排");
  });

  it("flags 未编排 when gpu_count not divisible by per-replica", () => {
    render(<ParallelismDiagram TP={4} PP={4} EP={1} CP={1} gpu_count={70} />);
    expect(screen.getByTestId("parallelism-diagram").textContent)
      .toContain("6 未编排");
  });

  it("EP groups: cells cycle EP colors via data-ep-group", () => {
    render(<ParallelismDiagram TP={4} PP={1} EP={4} CP={1} gpu_count={4} />);
    // gIdx = 0..3, mod EP=4 → groups 0,1,2,3
    expect(screen.getByTestId("gpu-cell-0-0").dataset.epGroup).toBe("0");
    expect(screen.getByTestId("gpu-cell-0-1").dataset.epGroup).toBe("1");
    expect(screen.getByTestId("gpu-cell-0-2").dataset.epGroup).toBe("2");
    expect(screen.getByTestId("gpu-cell-0-3").dataset.epGroup).toBe("3");
  });

  it("EP=1 → all cells in group 0; legend hidden", () => {
    render(<ParallelismDiagram TP={4} PP={1} EP={1} CP={1} gpu_count={4} />);
    expect(screen.getByTestId("gpu-cell-0-0").dataset.epGroup).toBe("0");
    expect(screen.getByTestId("gpu-cell-0-3").dataset.epGroup).toBe("0");
    // Legend only shown when EP > 1
    expect(screen.queryByTestId("parallelism-ep-legend")).toBeNull();
  });

  it("CP > 1 → cells get cp-group annotation", () => {
    render(<ParallelismDiagram TP={2} PP={2} EP={2} CP={2} gpu_count={8} />);
    // gIdx 0..3, EP=2 → epGroup = gIdx % 2
    // cpGroup = floor(gIdx / EP) % CP
    expect(screen.getByTestId("gpu-cell-0-0").dataset.cpGroup).toBe("0");
    expect(screen.getByTestId("gpu-cell-1-0").dataset.cpGroup).toBe("1");
  });

  it("truncates TP > MAX_DIM with indicator text", () => {
    render(<ParallelismDiagram TP={32} PP={1} EP={1} CP={1} gpu_count={32} />);
    // Only first 16 cells rendered
    const cells = screen.getAllByTestId(/^gpu-cell-/);
    expect(cells.length).toBe(16);
    // Truncation indicator shown
    expect(screen.getByText(/实际 32/)).toBeInTheDocument();
  });
});
