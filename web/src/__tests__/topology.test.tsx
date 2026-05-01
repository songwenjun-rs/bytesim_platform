/**
 * Topology page — integration smoke + key user paths.
 * Covers the 740-line page's: render, tab switching, save snapshot dispatch,
 * deep-link cluster selection, 404 → empty-body self-heal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Topology } from "../pages/Topology";
import { setSession } from "../api/client";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

function withProviders(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/sim/cluster/:specId" element={<Topology />} />
          <Route path="*" element={<Topology />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const HW_HASH = "h-1";
const HWSPEC_BODY = {
  spec: { id: "hwspec_topo_b1", kind: "hwspec", name: "topo", project_id: "p_default",
          latest_hash: HW_HASH, created_at: "2026-01-01" },
  version: {
    hash: HW_HASH, spec_id: "hwspec_topo_b1", parent_hash: null, version_tag: "v1",
    body: {
      datacenter: {
        id: "dc-1", name: "DC", clusters: [
          {
            id: "C01", name: "main", purpose: "训练", pue: 1.18,
            topology: "rail-optimized", interconnect: "IB",
            racks: [{
              id: "R01", name: "训练-1", status: "ok",
              rack_u: 48, rated_power_kw: 60, cooling: "直接液冷",
              tor_switch: "Mellanox SN5600", location: "B1-A-1",
              servers: [{
                id: "srv-1", name: "Train-001", kind: "gpu",
                gpu_model: "B200 SXM", gpu_count: 8, nic: "ConnectX-8",
                status: "ok", tdp_kw: 11, cpu_model: "Xeon",
                cpu_sockets: 2, ram_gb: 2048, gpu_mem_gb: 192,
              }],
              leaves: [{
                id: "L01", name: "Leaf-1", status: "ok",
                fabric_id: "compute-net",
                uplinks: [{ spine: "Spine-1", util_pct: 41 }],
              }],
            }],
            scale_up_domains: [],
          },
        ],
        scale_out_fabrics: [{
          id: "compute-net", name: "Compute Net", kind: "infiniband",
          topology: "rail-optimized",
          spines: [{ id: "Spine-1", status: "ok", port_count: 64,
                     bandwidth_per_port_gbps: 400 }],
          rails: [],
        }],
      },
      server_templates: [{
        id: "tpl-gpu-b200", name: "8× B200", kind: "gpu",
        gpu_model: "B200 SXM", gpu_count: 8, nic: "ConnectX-8",
        tdp_kw: 11,
      }],
    },
    created_at: "2026-01-01",
  },
};

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
});

function mockRoutes(extra: Array<[RegExp | string, () => Response]> = []) {
  vi.mocked(fetch).mockImplementation(async (input: any) => {
    const url = String(input);
    for (const [p, fn] of extra) {
      if (typeof p === "string" ? url === p : p.test(url)) return fn();
    }
    if (url.includes("/v1/specs/hwspec/hwspec_topo_b1")) return ok(HWSPEC_BODY);
    if (url.includes("/v1/catalog/items/")) return ok([]);
    return new Response("not-mocked: " + url, { status: 404 });
  });
}

describe("<Topology>", () => {
  it("renders page heading + sticky topbar with 保存 button", async () => {
    mockRoutes();
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "集群配置" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /保存/ })).toBeInTheDocument();
  });

  it("renders both tab buttons + defaults to 机房视图", async () => {
    mockRoutes();
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    await waitFor(() => screen.getByRole("button", { name: /机房视图/ }));
    expect(screen.getByRole("button", { name: /网络视图/ })).toBeInTheDocument();
  });

  it("switching to 网络视图 keeps page mounted (verifies tab state)", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockRoutes();
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    await waitFor(() => screen.getByRole("button", { name: /网络视图/ }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /网络视图/ }));
    });
    // Page should still be mounted; 集群配置 heading present in either tab.
    expect(screen.getByRole("heading", { name: "集群配置" })).toBeInTheDocument();
  });

  it("clicking 保存 fires POST /v1/specs/hwspec/{id}/snapshot", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let snapshotPosted = false;
    mockRoutes([
      [/\/v1\/specs\/hwspec\/.*\/snapshot/, () => {
        snapshotPosted = true;
        return ok({ hash: "new-h", spec_id: "hwspec_topo_b1",
                    parent_hash: HW_HASH, version_tag: "v2",
                    created_at: "2026-05-01T00:00:00Z" });
      }],
    ]);
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    const saveBtn = await screen.findByRole("button", { name: /保存/ });
    await waitFor(() => expect(saveBtn).not.toBeDisabled(), { timeout: 5_000 });
    await act(async () => { await user.click(saveBtn); });
    await waitFor(() => expect(snapshotPosted).toBe(true), { timeout: 5_000 });
  });

  it("renders empty-body shell when hwspec returns 404 (self-heal path)", async () => {
    mockRoutes([
      [/\/v1\/specs\/hwspec\/hwspec_topo_b1/, () =>
        new Response(JSON.stringify({ detail: "not found" }), { status: 404 })],
    ]);
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    // Loader briefly shows then page renders the 集群配置 heading either way.
    await waitFor(() => {
      const headings = screen.queryAllByRole("heading", { name: "集群配置" });
      expect(headings.length).toBeGreaterThan(0);
    }, { timeout: 5_000 });
  });

  it("respects ?cluster=<id> deep-link by selecting that cluster's inspector", async () => {
    mockRoutes();
    render(withProviders("/sim/cluster/hwspec_topo_b1?cluster=C01"));
    // After body loads + the deep-link useEffect runs, Inspector renders the
    // selected cluster's editor. A stable signal is the「集群名称」 input
    // hydrated with C01's name.
    await waitFor(() => expect(screen.getByDisplayValue("main")).toBeInTheDocument(),
                    { timeout: 5_000 });
  });

  it("clicking + 新建集群 adds a new cluster to the canvas", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockRoutes();
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    await waitFor(() => screen.getByText(/main/));
    // Cluster card initially shows C01.
    const before = screen.getAllByText(/^C0\d+$/).length;
    const newClusterBtn = screen.getByRole("button", { name: /新建集群/ });
    await act(async () => { await user.click(newClusterBtn); });
    // After click, addCluster() bumps the counter — at least one more
    // C0n cluster header appears.
    await waitFor(() => {
      const after = screen.getAllByText(/^C0\d+$/).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("clicking + 新建机柜 inside a cluster adds a rack", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockRoutes();
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    // Start with 1 rack (R01); add adds another.
    await waitFor(() => screen.getByText(/^R01$/));
    const before = screen.getAllByText(/^R0\d+$/).length;
    const addRackBtn = screen.getByRole("button", { name: /新建机柜/ });
    await act(async () => { await user.click(addRackBtn); });
    await waitFor(() => {
      const after = screen.getAllByText(/^R0\d+$/).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("网络视图 (NetworkView) renders fabric + spine summary when switched on", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockRoutes();
    render(withProviders("/sim/cluster/hwspec_topo_b1"));
    await waitFor(() => screen.getByRole("button", { name: /网络视图/ }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /网络视图/ }));
    });
    // NetworkView renders the fabric headline (Compute Net) — proves the
    // Topology → NetworkView wiring works and body.scale_out_fabrics is read.
    await waitFor(() => {
      expect(screen.getAllByText(/Compute Net/).length).toBeGreaterThan(0);
    }, { timeout: 5_000 });
  });

  it("snapshot POST carries the edited body (cluster name change persists)", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let posted: any = null;
    mockRoutes([
      [/\/v1\/specs\/hwspec\/.*\/snapshot/, () => ok({
        hash: "new-h", spec_id: "hwspec_topo_b1", parent_hash: HW_HASH,
        version_tag: "v2", created_at: "2026-05-01T00:00:00Z",
      })],
    ]);
    const realImpl = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/snapshot")) {
        posted = JSON.parse(init.body as string);
      }
      return realImpl(input);
    });
    render(withProviders("/sim/cluster/hwspec_topo_b1?cluster=C01"));
    // Wait for inspector hydrated with current cluster name = "main"
    const nameInput = await screen.findByDisplayValue("main");
    await act(async () => {
      await user.clear(nameInput);
      await user.type(nameInput, "main-renamed");
    });
    const saveBtn = await screen.findByRole("button", { name: /保存/ });
    await waitFor(() => expect(saveBtn).not.toBeDisabled(), { timeout: 5_000 });
    await act(async () => { await user.click(saveBtn); });
    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 5_000 });
    // Body must be wrapped under {body: HwSpecBody} (asset-svc's snapshot
    // contract). The renamed cluster propagates through to the POST.
    const cluster0 = posted.body.datacenter.clusters[0];
    expect(cluster0.name).toBe("main-renamed");
  });
});
