/**
 * App + Sidebar — high-level shell smoke. Both files are tiny but were
 * sitting at 0% pulling the average down.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { Sidebar } from "../components/shell/Sidebar";
import { setSession } from "../api/client";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
  // Catch-all for any page that mounts under App's "/dashboard" landing.
  vi.mocked(fetch).mockImplementation(async () => ok([]));
});

describe("<App>", () => {
  it("renders Sidebar + Topbar + main content area without crashing", () => {
    // App brings its own Routes, so use MemoryRouter to seed the URL.
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Sidebar brand + Dashboard heading prove both shells mounted.
    expect(screen.getByText(/ByteSim/)).toBeInTheDocument();
  });
});

describe("<Sidebar>", () => {
  it("renders all nav groups + items in order", () => {
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.getByText("ByteSim-2.0")).toBeInTheDocument();
    expect(screen.getByText("AI Factory Digital Twin")).toBeInTheDocument();
    // 仿真工作台 group items
    expect(screen.getByText("集群配置")).toBeInTheDocument();
    expect(screen.getByText("训练仿真")).toBeInTheDocument();
    expect(screen.getByText("推理仿真")).toBeInTheDocument();
    expect(screen.getByText("仿真报告")).toBeInTheDocument();
    // 资源仓库 group
    expect(screen.getByText("硬件部件")).toBeInTheDocument();
    expect(screen.getByText("仿真引擎")).toBeInTheDocument();
  });
});
