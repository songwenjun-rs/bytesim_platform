/**
 * Inspector — covers each selection.kind branch's render path + a couple of
 * field-edit dispatches. The component is huge (≈ 990 lines / 9 selection
 * branches), so tests group by branch with a shared fixture.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Inspector } from "../components/topology/Inspector";
import type {
  Cluster, ServerTemplate, ScaleOutFabric,
} from "../api/specs";
import type { Selection } from "../components/topology/Inspector";
import { setSession } from "../api/client";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

// ── Fixture ────────────────────────────────────────────────────────────────

const SERVER = {
  id: "srv-1", name: "Train-001", kind: "gpu" as const,
  gpu_model: "B200 SXM", gpu_count: 8, nic: "ConnectX-8",
  status: "ok" as const, tdp_kw: 11, cpu_model: "Xeon",
  cpu_sockets: 2, ram_gb: 2048, gpu_mem_gb: 192, storage_tb: 30,
};

const RACK = {
  id: "R01", name: "训练-1", status: "ok" as const, rack_u: 48,
  rated_power_kw: 60, cooling: "直接液冷" as const,
  tor_switch: "Mellanox SN5600", location: "B1-A-1",
  servers: [SERVER],
  leaves: [{
    id: "L01", name: "Leaf-1", status: "ok" as const,
    fabric_id: "compute-net",
    uplinks: [{ spine: "Spine-1", util_pct: 41, lanes: 2, bandwidth_gbps: 400 }],
    port_count: 48, bandwidth_per_port_gbps: 400,
  }],
};

const CLUSTER: Cluster = {
  id: "C01", name: "main", purpose: "训练", topology: "rail-optimized",
  interconnect: "InfiniBand NDR", pue: 1.18,
  racks: [RACK],
  scale_up_domains: [{
    id: "sud-1", name: "NVL72-R01", kind: "nvlink-switch",
    bandwidth_gbps: 1800, intra_topology: "switch", switch_count: 9,
    members: [{ server_id: "srv-1" }],
  }],
};

const FABRIC: ScaleOutFabric = {
  id: "compute-net", name: "Compute Net", kind: "infiniband",
  topology: "rail-optimized",
  spines: [{ id: "Spine-1", status: "ok", port_count: 64, bandwidth_per_port_gbps: 400 }],
  rails: [{ id: "rail-1", name: "Rail 1", spine_ids: ["Spine-1"] }],
};

const TEMPLATE: ServerTemplate = {
  id: "tpl-gpu-b200", name: "8× B200", kind: "gpu",
  gpu_model: "B200 SXM", gpu_count: 8, nic: "ConnectX-8",
  tdp_kw: 11, cpu_model: "Xeon", cpu_sockets: 2, ram_gb: 2048,
  gpu_mem_gb: 192,
};

// no-op handlers wrap into one bag; tests selectively spy on what they need
function mkHandlers() {
  return {
    onChangeServer: vi.fn(), onChangeRack: vi.fn(), onChangeCluster: vi.fn(),
    onChangeTemplate: vi.fn(),
    onChangeFabric: vi.fn(), onRemoveFabric: vi.fn(),
    onChangeSpine: vi.fn(), onRemoveSpine: vi.fn(),
    onChangeLeaf: vi.fn(), onRemoveLeaf: vi.fn(),
    onAddUplink: vi.fn(), onRemoveUplink: vi.fn(), onChangeUplink: vi.fn(),
    onChangeDomain: vi.fn(), onRemoveDomain: vi.fn(),
    onAddMember: vi.fn(), onRemoveMember: vi.fn(),
    onAddRail: vi.fn(), onRemoveRail: vi.fn(),
    onChangeRail: vi.fn(), onSelectRail: vi.fn(), onToggleRailSpine: vi.fn(),
  };
}

function renderInspector(selection: Selection, overrides: any = {}) {
  const h = mkHandlers();
  render(withProviders(
    <Inspector
      selection={selection}
      clusters={[CLUSTER]}
      templates={[TEMPLATE]}
      fabrics={[FABRIC]}
      {...h}
      {...overrides}
    />
  ));
  return h;
}

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
  // Inspector uses useCatalogItems for cpu/gpu/nic/ssd dropdowns.
  vi.mocked(fetch).mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("/v1/catalog/items/")) return ok([]);
    return new Response("not-mocked: " + url, { status: 404 });
  });
});

// ── Empty + branch render tests ───────────────────────────────────────────

describe("<Inspector>", () => {
  it("renders the empty state when selection is null", () => {
    renderInspector(null);
    expect(screen.getByText(/点击集群、机柜或服务器/)).toBeInTheDocument();
  });

  it("scale_up_domain branch — shows domain name + bandwidth + intra-topology", () => {
    renderInspector({ kind: "scale_up_domain", clusterId: "C01", domainId: "sud-1" });
    expect(screen.getAllByText(/NVL72-R01/).length).toBeGreaterThan(0);
    // Domain editor surfaces the bandwidth value (1800 Gbps) somewhere.
    expect(screen.getByDisplayValue(1800)).toBeInTheDocument();
  });

  it("scale_up_domain branch — disappears gracefully when domain id unknown", () => {
    renderInspector({ kind: "scale_up_domain", clusterId: "C01", domainId: "ghost" });
    expect(screen.getByText(/不存在|尚未选择/)).toBeInTheDocument();
  });

  it("link branch — shows uplink util editor", () => {
    renderInspector({ kind: "link", clusterId: "C01", rackId: "R01",
                      leafId: "L01", spineId: "Spine-1" });
    expect(screen.getByDisplayValue(41)).toBeInTheDocument();
  });

  it("rail branch — shows rail name + spine toggles", () => {
    renderInspector({ kind: "rail", fabricId: "compute-net", railId: "rail-1" });
    expect(screen.getAllByText(/Rail 1/).length).toBeGreaterThan(0);
  });

  it("scale_out_fabric branch — shows fabric kind + topology selectors", () => {
    renderInspector({ kind: "scale_out_fabric", fabricId: "compute-net" });
    expect(screen.getAllByText(/Compute Net/).length).toBeGreaterThan(0);
  });

  it("spine branch — shows port_count input", () => {
    renderInspector({ kind: "spine", fabricId: "compute-net", spineId: "Spine-1" });
    expect(screen.getByDisplayValue(64)).toBeInTheDocument();
  });

  it("leaf branch — shows uplink list + leaf name", () => {
    renderInspector({ kind: "leaf", clusterId: "C01", rackId: "R01", leafId: "L01" });
    expect(screen.getAllByText(/Leaf-1/).length).toBeGreaterThan(0);
  });

  it("template branch — shows template name editor + GPU dropdown", () => {
    renderInspector({ kind: "template", templateId: "tpl-gpu-b200" });
    expect(screen.getByDisplayValue("8× B200")).toBeInTheDocument();
  });

  it("template branch — vanishes when templateId unknown", () => {
    renderInspector({ kind: "template", templateId: "ghost" });
    expect(screen.getByText(/未找到|不存在/)).toBeInTheDocument();
  });

  it("cluster branch — shows cluster name + purpose + total servers/GPU", () => {
    renderInspector({ kind: "cluster", clusterId: "C01" });
    expect(screen.getByDisplayValue("main")).toBeInTheDocument();
    // Aggregates: 1 server, 8 GPU
    expect(screen.getByText(/^训练$/).closest("option")).toBeTruthy();
  });

  it("rack branch — shows rack name + cooling + tor", () => {
    renderInspector({ kind: "rack", clusterId: "C01", rackId: "R01" });
    expect(screen.getByDisplayValue("训练-1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Mellanox SN5600")).toBeInTheDocument();
  });

  it("server branch — shows server name + GPU count + NIC", () => {
    renderInspector({ kind: "server", clusterId: "C01", rackId: "R01", serverId: "srv-1" });
    expect(screen.getByDisplayValue("Train-001")).toBeInTheDocument();
    expect(screen.getByDisplayValue(8)).toBeInTheDocument();
  });

  it("server branch — vanishes when ids unknown", () => {
    renderInspector({ kind: "server", clusterId: "C01", rackId: "R01", serverId: "ghost" });
    expect(screen.getByText(/不存在|未找到/)).toBeInTheDocument();
  });
});

// ── Edit dispatch ──────────────────────────────────────────────────────────

describe("Inspector edit dispatch", () => {
  it("editing rack name fires onChangeRack with the new value", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const h = renderInspector({ kind: "rack", clusterId: "C01", rackId: "R01" });
    const nameInput = screen.getByDisplayValue("训练-1");
    await act(async () => {
      await user.clear(nameInput);
      await user.type(nameInput, "Renamed");
    });
    expect(h.onChangeRack).toHaveBeenCalled();
    const last = h.onChangeRack.mock.calls.at(-1)!;
    expect(last[0]).toBe("C01");
    expect(last[1]).toBe("R01");
    expect(last[2]).toBe("name");
  });

  it("editing cluster purpose dispatches onChangeCluster", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const h = renderInspector({ kind: "cluster", clusterId: "C01" });
    // Labels in Inspector use a co-located <FieldRow> rather than htmlFor,
    // so getByRole+name won't pair them. Pick the select by the option list
    // it owns (训练 / 推理 / 混合 / 实验).
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const purposeSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === "推理"),
    )!;
    await act(async () => { await user.selectOptions(purposeSelect, "推理"); });
    expect(h.onChangeCluster).toHaveBeenCalled();
  });

  it("uplink util_pct edit dispatches onChangeUplink", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const h = renderInspector({
      kind: "link", clusterId: "C01", rackId: "R01",
      leafId: "L01", spineId: "Spine-1",
    });
    const util = screen.getByDisplayValue(41);
    await act(async () => {
      await user.clear(util);
      await user.type(util, "75");
    });
    expect(h.onChangeUplink).toHaveBeenCalled();
  });
});
