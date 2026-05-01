/** Smoke tests for new pages — render with mocked fetch + verify key UI states. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { setSession } from "../api/client";
import { Catalog } from "../pages/Catalog";
import { TcoBreakdown } from "../components/run/TcoBreakdown";
import { ToastHost, pushToast } from "../components/shell/Toast";

function withProviders(ui: React.ReactNode, initial: string = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (json: any) => new Response(JSON.stringify(json), { status: 200 });

beforeEach(() => {
  setSession("t", "p_default");
});

// ── Toast ────────────────────────────────────────────────────────────

describe("Toast", () => {
  it("renders pushed messages and auto-dismisses", async () => {
    render(<ToastHost />);
    pushToast("hello", "ok");
    await screen.findByText("hello");
  });

  it("clicking a toast dismisses it", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<ToastHost />);
    pushToast("clickme", "warn");
    const el = await screen.findByText("clickme");
    await user.click(el);
    await waitFor(() => expect(screen.queryByText("clickme")).toBeNull());
  });
});

// ── Catalog ──────────────────────────────────────────────────────────

describe("Catalog page (硬件部件)", () => {
  it("renders all four kind tabs + count chips", async () => {
    // 4 GET /v1/catalog/items/{kind} fire in parallel on mount.
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok([])) // cpu
      .mockResolvedValueOnce(ok([])) // gpu
      .mockResolvedValueOnce(ok([])) // nic
      .mockResolvedValueOnce(ok([]));// ssd
    render(withProviders(<Catalog />));
    expect(await screen.findByText(/硬件部件/)).toBeInTheDocument();
    // Each label appears twice (chip + tab button); use getAllByText to
    // assert presence without ambiguity.
    expect(screen.getAllByText(/CPU/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/网卡/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("SSD").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the empty-state message when no parts of the active kind are registered", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok([])) // cpu (empty triggers empty state)
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([]));
    render(withProviders(<Catalog />));
    await waitFor(() => {
      expect(screen.getByText(/尚无 CPU 部件/)).toBeInTheDocument();
    });
  });
});

// ── TcoBreakdown ─────────────────────────────────────────────────────

describe("TcoBreakdown", () => {
  it("renders breakdown bar + table when data exists", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      hw_capex_amortized_usd: 50, power_opex_usd: 30,
      cooling_opex_usd: 5, network_opex_usd: 5, storage_opex_usd: 5,
      failure_penalty_usd: 5, total_usd: 100,
      per_m_token_usd: 0.001, per_gpu_hour_usd: 0.5,
      per_inference_request_usd: null,
      rule_versions: { "gpu/B200": "gpu/B200/v2026q1" },
      sensitivities: { d_total_per_card: 5 },
    }));
    render(withProviders(<TcoBreakdown runId="sim-x" />));
    await screen.findByText(/TCO 拆解/);
  });

  it("shows empty hint on 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 404 }));
    render(withProviders(<TcoBreakdown runId="sim-missing" />));
    await screen.findByText(/此 Run 尚无 TCO 数据/);
  });

  it("renders sensitivities section + per-unit prices when present", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      hw_capex_amortized_usd: 100, power_opex_usd: 0, cooling_opex_usd: 0,
      network_opex_usd: 0, storage_opex_usd: 0, failure_penalty_usd: 0,
      total_usd: 100,
      per_m_token_usd: 0.0012, per_gpu_hour_usd: 0.5,
      per_inference_request_usd: 0.000002,
      rule_versions: { "gpu/B200": "gpu/B200/v2026q1", "storage/x": "storage/x/v1" },
      sensitivities: { d_total_per_card: 5.0, d_total_per_hour: -1.2, d_total_per_util_pp: 0.3 },
    }));
    render(withProviders(<TcoBreakdown runId="sim-y" />));
    await screen.findByText(/敏感度/);
    expect(screen.getByText(/每百万 Token/)).toBeInTheDocument();
    expect(screen.getByText(/每 GPU·小时/)).toBeInTheDocument();
    expect(screen.getByText(/每推理请求/)).toBeInTheDocument();
    expect(screen.getByText(/ruleset/)).toBeInTheDocument();
  });
});
