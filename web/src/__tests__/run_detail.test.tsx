/**
 * RunDetail page — render with mocked /v1/runs/:id/full + verify back link
 * and core panels mount.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RunDetail } from "../pages/RunDetail";
import { setSession } from "../api/client";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

function withProviders(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/sim/reports/:runId" element={<RunDetail />} />
          <Route path="/sim/reports" element={<div data-testid="reports-stub" />} />
          <Route path="*" element={<RunDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const FULL = {
  run: {
    id: "sim-001", project_id: "p_default", kind: "train",
    title: "Demo run", status: "done", progress_pct: 100,
    inputs_hash: "abc", confidence: 0.85,
    started_at: "2026-05-01T01:00:00Z",
    finished_at: "2026-05-01T01:01:00Z",
    created_at: "2026-05-01T01:00:00Z",
    kpis: { mfu_pct: 53.7, step_ms: 1200, peak_kw: 256 },
    artifacts: [], boundaries: [],
  },
  specs: [
    { hash: "h1", spec_id: "hwspec_topo_b1", kind: "hwspec", name: "topo",
      version_tag: "v4", body: {}, stale: false },
  ],
  lineage: { self: { kind: "run", id: "sim-001", stale: false },
             parents: [], children: [], edges: [] },
  derived: { self_stale: false },
};

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
});

describe("<RunDetail>", () => {
  it("renders the back link + run header when /v1/runs/:id/full resolves", async () => {
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/v1/runs/sim-001/full")) return ok(FULL);
      return new Response("not-mocked", { status: 404 });
    });
    render(withProviders("/sim/reports/sim-001"));

    await waitFor(() => expect(screen.getByText(/← 返回/)).toBeInTheDocument());
    // RunHeader + permalink + various sub-cards may render the id multiple
    // times; presence-or-more is the intended assertion.
    await waitFor(() => expect(screen.getAllByText(/sim-001/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Demo run/).length).toBeGreaterThan(0);
  });

  it("shows loading state until the full payload resolves", () => {
    // Don't resolve the fetch — verify the loading skeleton renders.
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    render(withProviders("/sim/reports/sim-001"));
    expect(screen.getByText(/加载中…/)).toBeInTheDocument();
  });

  it("shows error state when the fetch fails non-404", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("server fire", { status: 500 }),
    );
    render(withProviders("/sim/reports/sim-001"));
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument());
  });
});
