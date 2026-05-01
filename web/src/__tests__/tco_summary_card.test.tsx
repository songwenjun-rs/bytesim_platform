/**
 * S4.3 — TcoSummaryCard top-of-page cost teaser.
 *
 * Locks:
 *   - Renders nothing on 404 / loading / total_usd <= 0 (defers to the
 *     full TcoBreakdown's own "no data" message).
 *   - Top contributor is the bucket with the largest pct of total.
 *   - Per-Mtoken price is rendered with 4-decimal precision.
 *   - Stacked bar segments render with widths matching the bucket pct.
 *   - "完整拆解 ↓" anchor href = #tco-breakdown.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TcoSummaryCard } from "../components/run/TcoSummaryCard";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
const notFound = () => new Response("nope", { status: 404 });

const tco = (over: any = {}) => ok({
  hw_capex_amortized_usd: 100,
  power_opex_usd: 250,        // dominant bucket
  cooling_opex_usd: 60,
  network_opex_usd: 40,
  storage_opex_usd: 30,
  failure_penalty_usd: 20,
  total_usd: 500,
  per_m_token_usd: 0.4567,
  per_gpu_hour_usd: 0.812,
  per_inference_request_usd: null,
  rule_versions: {},
  sensitivities: {},
  ...over,
});

beforeEach(() => {
  vi.spyOn(window, "fetch");
});

describe("<TcoSummaryCard>", () => {
  it("renders nothing while loading", () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));  // never resolves
    const { container } = render(withProviders(<TcoSummaryCard runId="r1" />));
    expect(container.textContent).toBe("");
  });

  it("renders nothing on 404 (defers to full TcoBreakdown)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(notFound());
    const { container } = render(withProviders(<TcoSummaryCard runId="r1" />));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="tco-summary-card"]')).toBeNull();
    });
  });

  it("renders nothing when total_usd <= 0 (no real cost data)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tco({ total_usd: 0 }));
    const { container } = render(withProviders(<TcoSummaryCard runId="r1" />));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="tco-summary-card"]')).toBeNull();
    });
  });

  it("renders top contributor based on largest bucket %", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tco());
    render(withProviders(<TcoSummaryCard runId="r1" />));
    await waitFor(() => {
      expect(screen.getByTestId("tco-top-contributor")).toBeInTheDocument();
    });
    // power = 250/500 = 50%
    expect(screen.getByTestId("tco-top-contributor").textContent).toContain("电力");
    expect(screen.getByTestId("tco-top-contributor").textContent).toContain("50%");
  });

  it("renders per-Mtoken with 4-decimal precision", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tco({ per_m_token_usd: 0.4567 }));
    render(withProviders(<TcoSummaryCard runId="r1" />));
    await waitFor(() => {
      expect(screen.getByTestId("tco-per-mtoken").textContent).toContain("$0.4567");
    });
  });

  it("renders — for missing per-Mtoken (training-only TCO)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tco({ per_m_token_usd: null }));
    render(withProviders(<TcoSummaryCard runId="r1" />));
    await waitFor(() => {
      expect(screen.getByTestId("tco-per-mtoken").textContent).toContain("—");
    });
  });

  it("stacked bar segments carry pct values matching the buckets", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tco());
    render(withProviders(<TcoSummaryCard runId="r1" />));
    await waitFor(() => {
      const power = screen.getByTestId("tco-segment-power_opex_usd");
      // 250 / 500 = 50%
      expect(Number(power.dataset.pct)).toBeCloseTo(50, 0);
    });
    const capex = screen.getByTestId("tco-segment-hw_capex_amortized_usd");
    expect(Number(capex.dataset.pct)).toBeCloseTo(20, 0);
  });

  it("anchor link points to #tco-breakdown", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tco());
    render(withProviders(<TcoSummaryCard runId="r1" />));
    await waitFor(() => {
      const link = screen.getByTestId("tco-summary-link") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("#tco-breakdown");
    });
  });
});
