/**
 * S4.4 — PhaseCostCard time-share-driven cost attribution.
 *
 * Locks:
 *   - Renders nothing if either phase_breakdown or TCO is missing.
 *   - Cost slices proportional to time slices: 64% time → 64% of total $.
 *   - Both legend $ + % stay in sync.
 *   - Defensive: zero total_ms / zero total_usd skips render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PhaseCostCard } from "../components/run/PhaseCostCard";
import type { Run } from "../api/runs";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
const notFound = () => new Response("nope", { status: 404 });

const tcoReply = (total: number) => ok({
  hw_capex_amortized_usd: total * 0.2,
  power_opex_usd: total * 0.5,
  cooling_opex_usd: total * 0.1,
  network_opex_usd: total * 0.1,
  storage_opex_usd: total * 0.05,
  failure_penalty_usd: total * 0.05,
  total_usd: total,
  per_m_token_usd: 0.4,
  per_gpu_hour_usd: 1.0,
  per_inference_request_usd: null,
  rule_versions: {},
  sensitivities: {},
});

function mkRun(over: Record<string, unknown> = {}): Run {
  return {
    id: "run-X", project_id: "p", kind: "infer", title: "t",
    status: "done", inputs_hash: "h",
    kpis: over as Record<string, number>,
    artifacts: [], boundaries: [], created_at: "2026-04-27T00:00:00Z",
  };
}

beforeEach(() => {
  vi.spyOn(window, "fetch");
});

describe("<PhaseCostCard>", () => {
  it("renders nothing without phase_breakdown", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tcoReply(100));
    const { container } = render(withProviders(<PhaseCostCard run={mkRun({})} />));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('[data-testid="phase-cost-card"]')).toBeNull();
  });

  it("renders nothing on TCO 404 (no cost data)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(notFound());
    const { container } = render(withProviders(<PhaseCostCard run={mkRun({
      phase_breakdown: [
        { phase: "compute", ms: 100 }, { phase: "comm", ms: 50 },
      ],
    })} />));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('[data-testid="phase-cost-card"]')).toBeNull();
  });

  it("attributes cost in proportion to phase time-share", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tcoReply(100));
    render(withProviders(<PhaseCostCard run={mkRun({
      phase_breakdown: [
        { phase: "compute", ms: 320 },   // 64%
        { phase: "comm",    ms:  90 },   // 18%
        { phase: "mem_stall", ms: 45 },  // 9%
        { phase: "idle",    ms:  45 },   // 9%
      ],
    })} />));
    await waitFor(() => {
      expect(screen.getByTestId("phase-cost-card")).toBeInTheDocument();
    });
    const compute = screen.getByTestId("phase-cost-slice-compute");
    expect(Number(compute.dataset.pct)).toBeCloseTo(64, 0);
    expect(Number(compute.dataset.usd)).toBeCloseTo(64, 0);

    const comm = screen.getByTestId("phase-cost-slice-comm");
    expect(Number(comm.dataset.pct)).toBeCloseTo(18, 0);
    expect(Number(comm.dataset.usd)).toBeCloseTo(18, 0);
  });

  it("legend rows show $ and % consistent with bar slices", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tcoReply(200));
    render(withProviders(<PhaseCostCard run={mkRun({
      phase_breakdown: [{ phase: "compute", ms: 100 }, { phase: "comm", ms: 100 }],
    })} />));
    await waitFor(() => {
      expect(screen.getByTestId("phase-cost-card")).toBeInTheDocument();
    });
    const computeRow = screen.getByTestId("phase-cost-row-compute");
    expect(computeRow.textContent).toContain("$100.00");
    expect(computeRow.textContent).toContain("50.0%");
  });

  it("zero total_ms (all phases ms=0) skips render rather than dividing by zero", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tcoReply(100));
    const { container } = render(withProviders(<PhaseCostCard run={mkRun({
      phase_breakdown: [{ phase: "compute", ms: 0 }, { phase: "comm", ms: 0 }],
    })} />));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('[data-testid="phase-cost-card"]')).toBeNull();
  });
});
