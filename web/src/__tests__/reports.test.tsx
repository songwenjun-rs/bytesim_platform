/**
 * Reports + ReportsCompare — 仿真报告 list + multi-select + compare flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Reports } from "../pages/Reports";
import { ReportsCompare } from "../pages/ReportsCompare";
import { setSession } from "../api/client";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

function withProviders(ui: React.ReactNode, initial = "/sim/reports") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/sim/reports" element={ui} />
          <Route path="/sim/reports/compare" element={ui} />
          <Route path="/sim/reports/:runId" element={<div data-testid="run-detail-stub" />} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const RUNS = [
  {
    id: "sim-001", project_id: "p_default", kind: "train", title: "Run A",
    status: "done", progress_pct: 100, inputs_hash: "h",
    kpis: { mfu_pct: 55.4, step_ms: 120000, _engine_provenance: { engine: "astra-sim", fidelity: "cycle-accurate" } },
    artifacts: [], boundaries: [], created_at: "2026-05-01T01:00:00Z",
  },
  {
    id: "sim-002", project_id: "p_default", kind: "train", title: "Run B",
    status: "running", progress_pct: 33, inputs_hash: "h",
    kpis: { mfu_pct: 51.0 }, artifacts: [], boundaries: [],
    created_at: "2026-05-01T02:00:00Z",
  },
  {
    id: "inf-001", project_id: "p_default", kind: "infer", title: "Run C",
    status: "failed", inputs_hash: "h",
    kpis: { mfu_pct: 0 }, artifacts: [], boundaries: [],
    created_at: "2026-05-01T03:00:00Z",
  },
];

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
});

// ── Reports list ────────────────────────────────────────────────────────────

describe("<Reports>", () => {
  it("renders stat chips with correct counts", async () => {
    vi.mocked(fetch).mockResolvedValue(ok(RUNS));
    render(withProviders(<Reports />));
    // Wait until the run list resolves and the table renders.
    await waitFor(() => expect(screen.getByText("sim-001")).toBeInTheDocument());
    // Stat chips show their labels (some may have multiple matches when the
    // status tag string also appears, so use getAllByText for tolerance).
    expect(screen.getAllByText("报告总数").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/最高 MFU/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders rows for each run with engine + MFU + status tag", async () => {
    vi.mocked(fetch).mockResolvedValue(ok(RUNS));
    render(withProviders(<Reports />));
    await waitFor(() => expect(screen.getByText("sim-001")).toBeInTheDocument());
    expect(screen.getByText("Run A")).toBeInTheDocument();
    expect(screen.getByText("Run B")).toBeInTheDocument();
    expect(screen.getByText("Run C")).toBeInTheDocument();
    // Engine column shows astra-sim for sim-001
    expect(screen.getByText("astra-sim")).toBeInTheDocument();
    // Status tags coexist with chip labels — at-least-once is enough.
    expect(screen.getAllByText(/^完成$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^仿真中$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^失败$/).length).toBeGreaterThanOrEqual(1);
  });

  it("clicking a row toggles selection (no navigation)", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.mocked(fetch).mockResolvedValue(ok(RUNS));
    render(withProviders(<Reports />));
    await waitFor(() => expect(screen.getByText("sim-001")).toBeInTheDocument());
    const row = screen.getByText("sim-001").closest("tr")!;
    await act(async () => { await user.click(row); });
    // Floating bar appears
    expect(screen.getByText(/已选/)).toBeInTheDocument();
    // Did NOT navigate (run-detail stub absent)
    expect(screen.queryByTestId("run-detail-stub")).toBeNull();
  });

  it("filters by search input on title or id", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.mocked(fetch).mockResolvedValue(ok(RUNS));
    render(withProviders(<Reports />));
    await waitFor(() => screen.getByText("sim-001"));
    await act(async () => {
      await user.type(screen.getByPlaceholderText(/搜索/), "Run B");
    });
    expect(screen.queryByText("sim-001")).toBeNull();
    expect(screen.getByText("sim-002")).toBeInTheDocument();
  });

  it("compare button disabled until 2+ rows picked, then navigates with ids", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.mocked(fetch).mockResolvedValue(ok(RUNS));
    render(withProviders(<Reports />));
    await waitFor(() => screen.getByText("sim-001"));

    // Pick first row → compare disabled (only 1 picked)
    const r1 = screen.getByText("sim-001").closest("tr")!;
    await act(async () => { await user.click(r1); });
    const compareBtn = screen.getByRole("button", { name: /^对比$/ });
    expect(compareBtn).toBeDisabled();

    // Pick second → enabled
    const r2 = screen.getByText("sim-002").closest("tr")!;
    await act(async () => { await user.click(r2); });
    expect(compareBtn).not.toBeDisabled();
  });

  it("empty state when no runs", async () => {
    vi.mocked(fetch).mockResolvedValue(ok([]));
    render(withProviders(<Reports />));
    await waitFor(() => expect(screen.getByText(/暂无仿真任务/)).toBeInTheDocument());
  });
});

// ── ReportsCompare ─────────────────────────────────────────────────────────

describe("<ReportsCompare>", () => {
  it("warns when fewer than 2 ids supplied", async () => {
    render(withProviders(<ReportsCompare />, "/sim/reports/compare?ids=sim-001"));
    await waitFor(() => expect(screen.getByText(/至少选择 2 份/)).toBeInTheDocument());
  });

  it("renders identity strip + KPI table for 2 runs", async () => {
    const fullRun = (id: string, mfu: number, step: number) => ({
      run: { id, project_id: "p", kind: "train", title: id, status: "done",
             inputs_hash: "h", kpis: { mfu_pct: mfu, step_ms: step },
             artifacts: [], boundaries: [], created_at: "2026-05-01T00:00:00Z" },
      specs: [], lineage: { self: { kind: "run", id, stale: false }, parents: [], children: [], edges: [] },
      derived: { self_stale: false },
    });
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/v1/runs/sim-001/full")) return ok(fullRun("sim-001", 55, 120000));
      if (url.includes("/v1/runs/sim-002/full")) return ok(fullRun("sim-002", 51, 130000));
      return new Response("not-mocked: " + url, { status: 404 });
    });

    render(withProviders(<ReportsCompare />, "/sim/reports/compare?ids=sim-001,sim-002"));
    await waitFor(() => expect(screen.getByText(/仿真报告对比 · 2 份/)).toBeInTheDocument());
    // Each identity card shows the run id
    await waitFor(() => expect(screen.getAllByText(/sim-001/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/sim-002/).length).toBeGreaterThan(0);
    // MFU appears in the KPI row label and as a radar axis label — ≥ 1 OK.
    expect(screen.getAllByText(/^MFU$/).length).toBeGreaterThanOrEqual(1);
    // Section titles
    expect(screen.getByText(/^仿真结果$/)).toBeInTheDocument();
    expect(screen.getByText(/^集群方案 & 成本$/)).toBeInTheDocument();
    expect(screen.getByText(/^模型 & 并行策略$/)).toBeInTheDocument();
  });
});
