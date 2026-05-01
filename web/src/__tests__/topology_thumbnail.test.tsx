/**
 * S6.5 — TopologyThumbnail: compact, read-only spatial preview embedded
 * in Sim pages.
 *
 * Locks:
 *   - With no runId, deep link points to /sim/cluster/<spec> (no overlay).
 *   - With runId + bottleneck, deep link points to /sim/cluster/<spec>?overlay=run:<id>
 *     and the bn-hint banner shows the headline.
 *   - Rack tiles aggregate severity from server-level overlay nodes
 *     ("worst wins"); rack with no matching nodes stays neutral.
 *   - Empty state: spec without datacenter renders the empty card.
 *   - Loading state during spec fetch shows the loading card.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { TopologyThumbnail } from "../components/sim/TopologyThumbnail";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });

const specReply = (overrides: any = {}) => ok({
  spec: { id: "hwspec_topo_b1", kind: "hwspec", name: "demo",
          project_id: "p1", latest_hash: "h1", created_at: "2026-04-01T00:00:00Z" },
  version: {
    hash: "h1", spec_id: "hwspec_topo_b1", version_tag: "v1",
    created_at: "2026-04-01T00:00:00Z",
    body: {
      datacenter: {
        id: "dc1", name: "DC",
        clusters: [{
          id: "cl1", name: "C1",
          racks: [
            {
              id: "R1", status: "ok",
              servers: [
                { id: "srv-1", gpu_model: "B200", gpu_count: 8, nic: "CX7",
                  status: "ok", tdp_kw: 10 },
                { id: "srv-2", gpu_model: "B200", gpu_count: 8, nic: "CX7",
                  status: "ok", tdp_kw: 10 },
              ],
            },
            {
              id: "R2", status: "ok",
              servers: [
                { id: "srv-3", gpu_model: "H200", gpu_count: 8, nic: "CX7",
                  status: "ok", tdp_kw: 10 },
              ],
            },
          ],
        }],
      },
      ...overrides.body,
    },
  },
});

const runReply = (kpis: Record<string, unknown>) => ok({
  run: { id: "run-1", project_id: "p1", kind: "infer", title: "t",
         status: "done", inputs_hash: "h",
         kpis: kpis as Record<string, number>,
         artifacts: [], boundaries: [], created_at: "2026-04-27T00:00:00Z" },
  specs: [],
  lineage: { self: { kind: "run", id: "run-1", stale: false }, parents: [], children: [], edges: [] },
  derived: { self_stale: false },
});

beforeEach(() => {
  vi.spyOn(window, "fetch");
});

describe("<TopologyThumbnail>", () => {
  it("renders rack grid + counts when spec loads", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(specReply());
    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" />));
    await waitFor(() => {
      expect(screen.getByTestId("topology-thumbnail")).toBeInTheDocument();
    });
    expect(screen.getByText(/2 机柜.*3 服务器.*24 GPU/)).toBeInTheDocument();
    expect(screen.getByTestId("thumb-rack-R1")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-rack-R2")).toBeInTheDocument();
  });

  it("deep link omits overlay query when no runId provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(specReply());
    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" />));
    await waitFor(() => {
      const link = screen.getByTestId("topology-thumbnail-link") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("/sim/cluster/hwspec_topo_b1");
    });
  });

  it("with runId + bottleneck, deep link carries ?overlay=run:<id> and bn-hint shows", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply())
      .mockResolvedValueOnce(runReply({
        bottleneck: {
          primary: "nvlink", severity: "high",
          headline: "NVLink 链路 nv-1 利用率 94%",
          links: [{ id: "nv-1", fabric: "nvlink", util_pct: 94, severity: "high" }],
          nodes: [
            { id: "srv-1", issue: "memory_bw", severity: "high", metrics: {} },
          ],
        },
      }));

    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" runId="run-1" />));

    await waitFor(() => {
      const link = screen.getByTestId("topology-thumbnail-link") as HTMLAnchorElement;
      // After the deep link switched to URLSearchParams, ":" gets percent-
      // encoded to "%3A". Accept both forms; both decode identically.
      const href = link.getAttribute("href") ?? "";
      expect(
        href === "/sim/cluster/hwspec_topo_b1?overlay=run:run-1" ||
        href === "/sim/cluster/hwspec_topo_b1?overlay=run%3Arun-1"
      ).toBe(true);
    });
    expect(screen.getByTestId("topology-thumbnail-bn-hint").textContent).toContain("NVLink");
  });

  it("rack severity = worst-wins of matching server nodes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply())
      .mockResolvedValueOnce(runReply({
        bottleneck: {
          primary: "memory_bw", severity: "high", headline: "x",
          links: [],
          nodes: [
            { id: "srv-1", issue: "memory_bw", severity: "med", metrics: {} },
            { id: "srv-2", issue: "memory_bw", severity: "high", metrics: {} },
            // srv-3 is in R2 with no overlay match
          ],
        },
      }));
    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" runId="run-1" />));
    await waitFor(() => {
      // R1 has a "high"-severity server → tile should be high
      expect(screen.getByTestId("thumb-rack-R1").dataset.overlaySeverity).toBe("high");
    });
    // R2 has no overlay → no severity attribute
    expect(screen.getByTestId("thumb-rack-R2").dataset.overlaySeverity).toBeUndefined();
  });

  it("falls back to qualified <rack>.<srv> id form when matching nodes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply())
      .mockResolvedValueOnce(runReply({
        bottleneck: {
          primary: "memory_bw", severity: "med", headline: "x",
          links: [],
          nodes: [
            { id: "R2.srv-3", issue: "memory_bw", severity: "med", metrics: {} },
          ],
        },
      }));
    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" runId="run-1" />));
    await waitFor(() => {
      expect(screen.getByTestId("thumb-rack-R2").dataset.overlaySeverity).toBe("med");
    });
  });

  it("S6.8 — surfaces link-level hint when bottleneck has hot links", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply())
      .mockResolvedValueOnce(runReply({
        bottleneck: {
          primary: "nvlink", severity: "high",
          headline: "NVLink 链路 nv-1 利用率 94%",
          links: [
            { id: "nv-1", fabric: "nvlink", util_pct: 94, severity: "high" },
            { id: "nv-2", fabric: "nvlink", util_pct: 88, severity: "high" },
            { id: "ib-3", fabric: "infiniband", util_pct: 76, severity: "med" },
          ],
          nodes: [],
        },
      }));
    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" runId="run-1" />));
    await waitFor(() => {
      expect(screen.getByTestId("topology-thumbnail-links-hint")).toBeInTheDocument();
    });
    const hint = screen.getByTestId("topology-thumbnail-links-hint");
    expect(hint.textContent).toContain("3 条链路告警");
    // top 2 listed verbatim
    expect(hint.textContent).toContain("nv-1");
    expect(hint.textContent).toContain("94%");
    expect(hint.textContent).toContain("nv-2");
    expect(hint.textContent).toContain("88%");
    // "+1 条" overflow indicator
    expect(hint.textContent).toContain("+1 条");
    // 3rd link not listed
    expect(hint.textContent).not.toContain("ib-3");
  });

  it("S6.8 — link hint hidden when bottleneck has no links (only nodes)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply())
      .mockResolvedValueOnce(runReply({
        bottleneck: {
          primary: "kv_spill", severity: "high",
          headline: "KV 工作集超出 HBM",
          links: [],
          nodes: [
            { id: "srv-1", issue: "kv_spill", severity: "high", metrics: {} },
          ],
        },
      }));
    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" runId="run-1" />));
    await waitFor(() => {
      expect(screen.getByTestId("topology-thumbnail-bn-hint")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("topology-thumbnail-links-hint")).toBeNull();
  });

  it("renders empty state when datacenter has no racks", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(specReply({
      body: { datacenter: { id: "dc", name: "x", clusters: [] } },
    }));
    render(withProviders(<TopologyThumbnail hwspecId="hwspec_topo_b1" />));
    await waitFor(() => {
      expect(screen.getByTestId("topology-thumbnail-empty")).toBeInTheDocument();
    });
  });
});
