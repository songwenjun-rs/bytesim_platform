/**
 * S4.2 — PhaseBreakdownBar + KvPressureCard.
 *
 * Empty-state behavior matters product-wise: training runs without KV
 * config get *no* KV card (don't render an empty one); engines without
 * phase_breakdown get *no* phase chart. This is what distinguishes
 * "engine didn't attribute" from "everything fine".
 *
 * Slice widths and severity tiers are the chart's contract — locked here
 * because the rendered visual is what the architect interprets.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PhaseBreakdownBar } from "../components/run/PhaseBreakdownBar";
import { KvPressureCard } from "../components/run/KvPressureCard";
import type { Run } from "../api/runs";

function mkRun(kpis: Record<string, unknown>): Run {
  return {
    id: "r", project_id: "p", kind: "infer", title: "t",
    status: "done", inputs_hash: "h",
    kpis: kpis as Record<string, number>,
    artifacts: [], boundaries: [], created_at: "2026-04-27T00:00:00Z",
  };
}

// ── PhaseBreakdownBar ──────────────────────────────────────────────────────

describe("<PhaseBreakdownBar>", () => {
  it("renders nothing when phase_breakdown is missing", () => {
    const { container } = render(<PhaseBreakdownBar run={mkRun({ mfu_pct: 50 })} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when phase_breakdown total is zero", () => {
    const { container } = render(<PhaseBreakdownBar run={mkRun({
      phase_breakdown: [{ phase: "compute", ms: 0 }, { phase: "comm", ms: 0 }],
    })} />);
    expect(container.textContent).toBe("");
  });

  it("renders one slice per phase with widths summing to 100%", () => {
    render(<PhaseBreakdownBar run={mkRun({
      phase_breakdown: [
        { phase: "compute",   ms: 320 },
        { phase: "comm",      ms:  90 },
        { phase: "mem_stall", ms:  45 },
        { phase: "idle",      ms:  45 },
      ],
    })} />);
    expect(screen.getByTestId("phase-breakdown")).toBeInTheDocument();
    const compute = screen.getByTestId("phase-slice-compute");
    const comm    = screen.getByTestId("phase-slice-comm");
    const mem     = screen.getByTestId("phase-slice-mem_stall");
    const idle    = screen.getByTestId("phase-slice-idle");
    const sum =
      Number(compute.dataset.pct) + Number(comm.dataset.pct)
      + Number(mem.dataset.pct) + Number(idle.dataset.pct);
    expect(sum).toBeCloseTo(100, 1);
    // 320/(320+90+45+45) = 64%
    expect(Number(compute.dataset.pct)).toBeCloseTo(64, 0);
  });

  it("renders total ms in the header", () => {
    render(<PhaseBreakdownBar run={mkRun({
      phase_breakdown: [
        { phase: "compute", ms: 100 }, { phase: "comm", ms: 50 },
      ],
    })} />);
    expect(screen.getByText("总 150.0 ms · 2 阶段")).toBeInTheDocument();
  });

  it("hides legend entries for unknown phases via fallback color, but still labels them", () => {
    render(<PhaseBreakdownBar run={mkRun({
      phase_breakdown: [
        { phase: "compute", ms: 50 },
        { phase: "exotic_phase", ms: 50 },
      ],
    })} />);
    const legend = screen.getByTestId("phase-legend");
    expect(legend.textContent).toContain("计算");
    // unknown phase falls back to its raw name
    expect(legend.textContent).toContain("exotic_phase");
  });
});

// ── KvPressureCard ─────────────────────────────────────────────────────────

describe("<KvPressureCard>", () => {
  it("renders nothing when no KV fields present (training run)", () => {
    const { container } = render(<KvPressureCard run={mkRun({ mfu_pct: 50 })} />);
    expect(container.textContent).toBe("");
  });

  it("renders all 3 metrics when engine emitted them", () => {
    render(<KvPressureCard run={mkRun({
      kv_hit_rate: 0.78,
      cache_pressure_pct: 65,
      spill_bytes_per_s: 0,
    })} />);
    expect(screen.getByTestId("kv-pressure")).toBeInTheDocument();
    expect(screen.getByTestId("kv-hit-rate")).toBeInTheDocument();
    expect(screen.getByTestId("kv-pressure-pct")).toBeInTheDocument();
    expect(screen.getByTestId("kv-spill-bps")).toBeInTheDocument();
  });

  it("severity tiers match thresholds: hit 0.78 → low (healthy)", () => {
    render(<KvPressureCard run={mkRun({ kv_hit_rate: 0.78 })} />);
    expect(screen.getByTestId("kv-hit-rate").dataset.severity).toBe("low");
  });

  it("severity tiers match thresholds: hit 0.45 → high (poor)", () => {
    render(<KvPressureCard run={mkRun({ kv_hit_rate: 0.45 })} />);
    expect(screen.getByTestId("kv-hit-rate").dataset.severity).toBe("high");
  });

  it("pressure 120% → high + redline element shown at 100%", () => {
    render(<KvPressureCard run={mkRun({ cache_pressure_pct: 120 })} />);
    expect(screen.getByTestId("kv-pressure-pct").dataset.severity).toBe("high");
    expect(screen.getByTestId("kv-pressure-pct-redline")).toBeInTheDocument();
    expect(screen.getByText(/超出 HBM/)).toBeInTheDocument();
  });

  it("spill 0 B/s → low (healthy)", () => {
    render(<KvPressureCard run={mkRun({ spill_bytes_per_s: 0 })} />);
    expect(screen.getByTestId("kv-spill-bps").dataset.severity).toBe("low");
    expect(screen.getByText("无 spill")).toBeInTheDocument();
  });

  it("spill 5 GB/s → high + GB/s formatted value", () => {
    render(<KvPressureCard run={mkRun({ spill_bytes_per_s: 5e9 })} />);
    expect(screen.getByTestId("kv-spill-bps").dataset.severity).toBe("high");
    expect(screen.getByText("5.0 GB/s")).toBeInTheDocument();
  });

  it("renders only the metrics that engine emitted (partial data)", () => {
    render(<KvPressureCard run={mkRun({ kv_hit_rate: 0.9 })} />);
    expect(screen.getByTestId("kv-hit-rate")).toBeInTheDocument();
    expect(screen.queryByTestId("kv-pressure-pct")).toBeNull();
    expect(screen.queryByTestId("kv-spill-bps")).toBeNull();
  });

  it("ignores non-numeric values (defensive against bad serialization)", () => {
    const { container } = render(<KvPressureCard run={mkRun({
      kv_hit_rate: "garbage" as unknown as number,
      cache_pressure_pct: NaN as unknown as number,
    })} />);
    // All three readings end up null ⇒ the whole card hides
    expect(container.textContent).toBe("");
  });
});
