/**
 * S2.2b — SubmittedRunPanel: in-place progress for the just-submitted run.
 *
 * Three states the architect cares about:
 *   - running    → phase stepper visible, no KPI/bottleneck yet
 *   - done       → KPI grid + BottleneckCard + phase breakdown all present
 *   - failed     → warning boundary surfaces, link to RunDetail still works
 *   - reset      → onReset callback fires when 重置 button clicked
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { SubmittedRunPanel } from "../components/sim/SubmittedRunPanel";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });

const runFull = (status: string, kpis: Record<string, unknown> = {}) => ok({
  run: {
    id: "run-X", project_id: "p1", kind: "infer", title: "demo",
    status, inputs_hash: "h",
    kpis: kpis as Record<string, number>,
    artifacts: [], boundaries: [], created_at: "2026-04-27T00:00:00Z",
  },
  specs: [],
  lineage: { self: { kind: "run", id: "run-X", stale: false }, parents: [], children: [], edges: [] },
  derived: { self_stale: false },
});

beforeEach(() => {
  vi.spyOn(window, "fetch");
});

describe("<SubmittedRunPanel>", () => {
  it("renders header with run id and a 查看完整结果 link", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(runFull("running"));
    render(withProviders(<SubmittedRunPanel runId="run-X" onReset={() => {}} />));
    expect(screen.getByText(/本次提交.*run-X/)).toBeInTheDocument();
    const link = screen.getByTestId("submitted-run-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/sim/reports/run-X");
  });

  it("running state: phase stepper visible, no KPI grid yet", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(runFull("running"));
    render(withProviders(<SubmittedRunPanel runId="run-X" onReset={() => {}} />));
    // EnginePhases mounts immediately
    await waitFor(() => {
      expect(screen.getByTestId("engine-phases")).toBeInTheDocument();
    });
    // KPI grid does NOT appear until status=done
    expect(screen.queryByText("MFU")).toBeNull();
  });

  it("done state: KPI grid + BottleneckCard + phase breakdown all rendered", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(runFull("done", {
      mfu_pct: 48, step_ms: 1840, ttft_ms: 187,
      bottleneck: {
        primary: "nvlink", severity: "high", headline: "NVLink 链路 nv-1 利用率 94%",
        suggested_action: "TP=8 → TP=4",
        links: [], nodes: [],
      },
      phase_breakdown: [
        { phase: "compute", ms: 1500 },
        { phase: "comm", ms: 300 },
      ],
    }));
    render(withProviders(<SubmittedRunPanel runId="run-X" onReset={() => {}} />));
    await waitFor(() => {
      // BottleneckCard visible
      expect(screen.getByText("NVLink 饱和")).toBeInTheDocument();
    });
    // Phase chart visible
    expect(screen.getByTestId("phase-breakdown")).toBeInTheDocument();
    // KPI grid visible — kind=infer uses TTFT/TPOT (not MFU which is train-only)
    expect(screen.getByText("TTFT")).toBeInTheDocument();
  });

  it("S2.3 — done state: PhaseCostCard renders when both phase_breakdown and TCO available", async () => {
    // Two responses queued: run-full first, run-tco second. Order matters
    // because useRunFull mounts before useRunTco/useRunTco-via-Phase fires.
    vi.mocked(fetch)
      .mockResolvedValueOnce(runFull("done", {
        ttft_ms: 187,
        phase_breakdown: [
          { phase: "compute", ms: 800 },
          { phase: "comm", ms: 200 },
        ],
      }))
      .mockResolvedValue(ok({
        hw_capex_amortized_usd: 30, power_opex_usd: 50, cooling_opex_usd: 5,
        network_opex_usd: 10, storage_opex_usd: 3, failure_penalty_usd: 2,
        total_usd: 100, per_m_token_usd: 0.4,
        per_gpu_hour_usd: 1, per_inference_request_usd: null,
        rule_versions: {}, sensitivities: {},
      }));
    render(withProviders(<SubmittedRunPanel runId="run-X" onReset={() => {}} />));
    await waitFor(() => {
      // PhaseCostCard mounted (depends on phase_breakdown + TCO both)
      expect(screen.getByTestId("phase-cost-card")).toBeInTheDocument();
    });
    // 800/(800+200) = 80% time → 80% of $100 = $80 attributed to compute
    expect(screen.getByTestId("phase-cost-row-compute").textContent).toContain("$80.00");
  });

  it("failed state: surfaces warning boundary", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(runFull("failed"));
    render(withProviders(<SubmittedRunPanel runId="run-X" onReset={() => {}} />));
    await waitFor(() => {
      expect(screen.getByTestId("submitted-run-failed")).toBeInTheDocument();
    });
    expect(screen.getByText(/仿真失败/)).toBeInTheDocument();
  });

  it("reset button calls onReset", async () => {
    const onReset = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(runFull("running"));
    render(withProviders(<SubmittedRunPanel runId="run-X" onReset={onReset} />));
    const user = (await import("@testing-library/user-event")).default.setup();
    await act(async () => {
      await user.click(screen.getByTestId("submitted-run-reset"));
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
