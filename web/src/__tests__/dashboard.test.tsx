/**
 * Dashboard — refactored 工作台 with stat chips + quick actions + cluster
 * overview + recent runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Dashboard } from "../pages/Dashboard";
import { setSession } from "../api/client";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const RUNS = [
  { id: "sim-001", project_id: "p", kind: "train", title: "Run A",
    status: "done", inputs_hash: "h", kpis: { mfu_pct: 55 },
    artifacts: [], boundaries: [], created_at: "2026-05-01T01:00:00Z" },
  { id: "sim-002", project_id: "p", kind: "train", title: "Run B",
    status: "running", progress_pct: 33, inputs_hash: "h", kpis: {},
    artifacts: [], boundaries: [], created_at: "2026-05-01T02:00:00Z" },
];

const HWSPEC_LIST = [
  { id: "hwspec_topo_b1", kind: "hwspec", name: "topo", project_id: "p",
    latest_hash: "h", created_at: "2026-01-01" },
];

const HWSPEC_BODY = {
  spec: HWSPEC_LIST[0],
  version: {
    hash: "h", spec_id: "hwspec_topo_b1", parent_hash: null, version_tag: "v1",
    body: {
      datacenter: {
        id: "dc", name: "DC", clusters: [
          {
            id: "C01", name: "main", purpose: "训练",
            racks: [{
              id: "R01", status: "ok", servers: [
                { id: "s1", gpu_model: "B200", gpu_count: 8, nic: "x", status: "ok", tdp_kw: 11 },
              ],
            }],
          },
        ],
        scale_out_fabrics: [],
      },
    },
    created_at: "2026-01-01",
  },
};

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
});

describe("<Dashboard>", () => {
  it("renders heading + 4 stat chips + quick action grid", async () => {
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/v1/runs")) return ok(RUNS);
      if (url.includes("/v1/specs/hwspec/hwspec_topo_b1")) return ok(HWSPEC_BODY);
      if (url.match(/\/v1\/specs\/hwspec(\?.*)?$/)) return ok(HWSPEC_LIST);
      return new Response("not-mocked: " + url, { status: 404 });
    });
    render(withProviders(<Dashboard />));
    await waitFor(() => expect(screen.getByRole("heading", { name: "工作台" })).toBeInTheDocument());
    expect(screen.getByText("仿真总数")).toBeInTheDocument();
    expect(screen.getAllByText(/完成/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/进行中/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/失败/).length).toBeGreaterThanOrEqual(1);
    // 4 quick actions
    expect(screen.getByText("集群配置")).toBeInTheDocument();
    expect(screen.getByText("训练仿真")).toBeInTheDocument();
    expect(screen.getByText("推理仿真")).toBeInTheDocument();
    expect(screen.getByText("仿真报告")).toBeInTheDocument();
  });

  it("shows cluster overview with derived gpu summary line", async () => {
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/v1/runs")) return ok(RUNS);
      if (url.includes("/v1/specs/hwspec/hwspec_topo_b1")) return ok(HWSPEC_BODY);
      if (url.match(/\/v1\/specs\/hwspec(\?.*)?$/)) return ok(HWSPEC_LIST);
      return new Response("not-mocked", { status: 404 });
    });
    render(withProviders(<Dashboard />));
    await waitFor(() => expect(screen.getByText("集群概览")).toBeInTheDocument());
    // C01 cluster card with gpu line
    await waitFor(() => expect(screen.getByText("C01")).toBeInTheDocument());
    expect(screen.getByText(/8× B200/)).toBeInTheDocument();
  });

  it("shows recent runs table with rows", async () => {
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/v1/runs")) return ok(RUNS);
      if (url.includes("/v1/specs/hwspec/hwspec_topo_b1")) return ok(HWSPEC_BODY);
      if (url.match(/\/v1\/specs\/hwspec(\?.*)?$/)) return ok(HWSPEC_LIST);
      return new Response("not-mocked", { status: 404 });
    });
    render(withProviders(<Dashboard />));
    await waitFor(() => expect(screen.getByText("最近仿真")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("sim-001")).toBeInTheDocument());
    expect(screen.getByText("Run A")).toBeInTheDocument();
  });

  it("shows empty placeholder when no runs", async () => {
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/v1/runs")) return ok([]);
      if (url.includes("/v1/specs/hwspec/hwspec_topo_b1")) return ok(HWSPEC_BODY);
      if (url.match(/\/v1\/specs\/hwspec(\?.*)?$/)) return ok(HWSPEC_LIST);
      return new Response("not-mocked", { status: 404 });
    });
    render(withProviders(<Dashboard />));
    await waitFor(() => expect(screen.getByText(/还没有仿真任务/)).toBeInTheDocument());
  });
});
