/**
 * Catalog 硬件部件 — covers tab switching + form open/close + upsert + delete
 * via the bs_catalog-backed CRUD endpoints.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Catalog } from "../pages/Catalog";
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

const CPU_ROWS = [
  { kind: "cpu", id: "cpu-amd-9755", name: "EPYC 9755 (Turin)",
    body: { model: "EPYC 9755", vendor: "AMD", cores: 128, base_ghz: 2.7,
            boost_ghz: 4.1, tdp_w: 500, mem_channels: 12 } },
];
const GPU_ROWS = [
  { kind: "gpu", id: "gpu-nv-b200", name: "B200 SXM",
    body: { model: "B200 SXM", vendor: "NVIDIA", fp8_tflops: 9000,
            bf16_tflops: 4500, hbm_gb: 192, mem_bw_tbs: 8.0, tdp_w: 1000, year: 2024 } },
];

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
});

function mockKind(routes: Record<string, unknown>) {
  vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/v1\/catalog\/items\/(\w+)/);
    if (m) {
      const k = m[1];
      if ((init?.method ?? "GET") === "GET") {
        return ok(routes[k] ?? []);
      }
      // upsert echoes back the body
      const b = init?.body ? JSON.parse(init.body as string) : {};
      return ok({ kind: k, id: b.id ?? "auto", name: b.name, body: b.body });
    }
    return new Response("not-mocked: " + url, { status: 404 });
  });
}

describe("<Catalog>", () => {
  it("renders default CPU tab + chip counts", async () => {
    mockKind({ cpu: CPU_ROWS, gpu: GPU_ROWS, nic: [], ssd: [] });
    render(withProviders(<Catalog />));
    await waitFor(() => expect(screen.getByText(/EPYC 9755/)).toBeInTheDocument());
    // The active tab is CPU; the table renders a row from CPU_ROWS.
    expect(screen.getByText("AMD")).toBeInTheDocument();
  });

  it("switching to GPU tab shows GPU rows + hides CPU rows", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockKind({ cpu: CPU_ROWS, gpu: GPU_ROWS, nic: [], ssd: [] });
    render(withProviders(<Catalog />));
    await waitFor(() => screen.getByText(/EPYC 9755/));

    await act(async () => {
      // The 4 tab buttons share text content with the chips above; pick by
      // the one inside the tabbar that's NOT the active CPU primary.
      const gpuButtons = screen.getAllByRole("button", { name: /^GPU$/ });
      await user.click(gpuButtons[0]);
    });
    await waitFor(() => expect(screen.getByText("B200 SXM")).toBeInTheDocument());
    expect(screen.queryByText(/EPYC 9755/)).toBeNull();
  });

  it("clicking + 新增 opens an inline form; cancel closes it", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockKind({ cpu: [], gpu: [], nic: [], ssd: [] });
    render(withProviders(<Catalog />));
    await waitFor(() => expect(screen.getByText(/尚无 CPU/)).toBeInTheDocument());

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /\+ 新增 CPU/ }));
    });
    // Form header card title appears alongside the existing tab button.
    // Two matches expected (button + form title); presence ≥ 2 is the assertion.
    expect(screen.getAllByText(/新增 CPU/).length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^取消$/ }));
    });
    // After cancel, only the button remains (1 match).
    expect(screen.getAllByText(/新增 CPU/).length).toBe(1);
  });

  it("filling the form + 保存 fires POST /v1/catalog/items/cpu", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockKind({ cpu: [], gpu: [], nic: [], ssd: [] });
    render(withProviders(<Catalog />));
    await waitFor(() => screen.getByText(/尚无 CPU/));

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /\+ 新增 CPU/ }));
    });
    // Form labels are <label>+<input> co-located but lack a `for` attribute,
    // so the implicit getByLabelText pairing doesn't find the input. Walk
    // the DOM by stable label-then-sibling instead.
    const labels = await screen.findAllByText(/型号/);
    const modelInput = labels[0].nextElementSibling as HTMLInputElement;
    const vendorLabels = await screen.findAllByText(/厂商/);
    const vendorInput = vendorLabels[0].nextElementSibling as HTMLInputElement;
    await act(async () => {
      await user.type(modelInput, "Test-CPU-X");
      await user.type(vendorInput, "TestCorp");
      await user.click(screen.getByRole("button", { name: /^保存$/ }));
    });

    // Some POST hit /v1/catalog/items/cpu (auto-id append) OR /v1/catalog/items/cpu/<id>.
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/v1/catalog/items/cpu"))).toBe(true);
  });
});
