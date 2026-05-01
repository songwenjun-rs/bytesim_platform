/**
 * InferenceSim — refactored 2-column page, mirrors TrainingSim structure.
 * Light coverage: render + cluster summary + submit POST shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { InferenceSim } from "../pages/InferenceSim";
import { setSession } from "../api/client";
import { ToastHost } from "../components/shell/Toast";

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/sim/inference"]}>
        <Routes>
          <Route path="/sim/inference" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
        <ToastHost />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const HW_HASH = "h-hw";
const MD_HASH = "h-md";

const HWSPEC_LIST = [
  { id: "hwspec_topo_b1", kind: "hwspec", name: "topo", project_id: "p_default",
    latest_hash: HW_HASH, created_at: "2026-01-01" },
];
const HWSPEC_BODY = {
  spec: HWSPEC_LIST[0],
  version: {
    hash: HW_HASH, spec_id: "hwspec_topo_b1", parent_hash: null, version_tag: "v1",
    body: {
      datacenter: {
        id: "dc-1", name: "DC", clusters: [
          {
            id: "C02", name: "infer", purpose: "推理", pue: 1.20,
            racks: [{
              id: "R01", status: "ok", servers: Array.from({ length: 8 }, (_, i) => ({
                id: `s-${i}`, gpu_model: "H200", gpu_count: 8,
                nic: "x", status: "ok", tdp_kw: 6.5,
              })),
            }],
          },
        ],
        scale_out_fabrics: [],
      },
    },
    created_at: "2026-01-01",
  },
};
const MODEL_BODY = {
  spec: { id: "model_moe256e", kind: "model", name: "M", project_id: "p_default",
          latest_hash: MD_HASH, created_at: "2026-01-01" },
  version: {
    hash: MD_HASH, spec_id: "model_moe256e", parent_hash: null, version_tag: "v1",
    body: { model_name: "Llama-3.1-405B" }, created_at: "2026-01-01",
  },
};
const ENGINES = [{
  name: "surrogate-analytical", version: "0.2.0", fidelity: "analytical",
  sla_p99_ms: 100, endpoint: "http://x", predict_path: "/v1/predict",
  coverage_envelope: {
    workload_families: ["transformer-dense", "transformer-moe"],
    parallelism: {
      TP: [1, 64], PP: [1, 64], EP: [1, 64], CP: [1, 8],
      recompute: ["selective", "full"],
      overlap: ["1F1B", "ZB", "ZBv2", "ring_compress", "Chimera"],
    },
    hardware: { gpu_models: ["B200", "H200"], fabric: ["nvlink"], scale_gpus: [8, 8192] },
    quant: ["FP8", "BF16"], modes: ["training", "inference"],
  },
  kpi_outputs: ["mfu_pct", "ttft_ms", "tpot_ms"],
  calibration: {}, status: "active", registered_at: "2026-01-01",
}];

beforeEach(() => {
  setSession("t", "p_default");
  vi.mocked(fetch).mockReset();
});

function mockRoutes(extra: Array<[RegExp | string, () => Response]> = []) {
  vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
    const url = String(input);
    for (const [p, fn] of extra) {
      if (typeof p === "string" ? url === p : p.test(url)) return fn();
    }
    if (url.match(/\/v1\/specs\/hwspec(\?.*)?$/)) return ok(HWSPEC_LIST);
    if (url.includes("/v1/specs/hwspec/hwspec_topo_b1")) return ok(HWSPEC_BODY);
    if (url.includes("/v1/specs/model/model_moe256e")) return ok(MODEL_BODY);
    if (url.includes("/v1/engines")) return ok(ENGINES);
    if (url.includes("/v1/catalog/items/infer_preset")) return ok([]);
    if (url.includes("/v1/predict") || url.includes("/v1/livepredict")) {
      return ok({ mfu_pct: 50, step_ms: 1000, peak_kw: 100, ttft_ms: 100, tpot_ms: 30,
                  breakdown: { compute_ms: 800, comm_ms: 100, mem_stall_ms: 100, idle_ms: 0 },
                  confidence: 0.85, coverage_status: "in_dist", feasible: true, notes: [] });
    }
    return new Response("not-mocked: " + url, { status: 404 });
  });
}

describe("<InferenceSim>", () => {
  it("renders heading + 启动推理仿真 button + KV cache section", async () => {
    mockRoutes();
    render(withProviders(<InferenceSim />));
    await waitFor(() => expect(screen.getByRole("heading", { name: "推理仿真" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /启动推理仿真/ })).toBeInTheDocument();
    expect(screen.getByText("KV Cache")).toBeInTheDocument();
    expect(screen.getByText("SLO 目标")).toBeInTheDocument();
  });

  it("auto-selects 推理-purpose cluster by default", async () => {
    mockRoutes();
    render(withProviders(<InferenceSim />));
    // C02 is purpose=推理 → preferred over alphabetically-first. The cluster
    // dropdown reflects the selected id once the auto-select effect runs.
    await waitFor(() => {
      const sel = screen.getAllByRole("combobox").find(
        (s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === "C02"),
      ) as HTMLSelectElement | undefined;
      expect(sel?.value).toBe("C02");
    }, { timeout: 8_000 });
  }, 12_000);

  it("submit POSTs /v1/runs with kind=infer + kvcache_config", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let postBody: any = null;
    mockRoutes([
      ["/v1/runs", () => ok({ id: "inf-001", project_id: "p_default", kind: "infer",
                              title: "x", status: "queued", inputs_hash: "h",
                              kpis: {}, artifacts: [], boundaries: [],
                              created_at: "2026-05-01T00:00:00Z" })],
    ]);
    const realImpl = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      if (String(input) === "/v1/runs" && init?.method === "POST") {
        postBody = JSON.parse(init.body as string);
      }
      return realImpl(input, init);
    });

    render(withProviders(<InferenceSim />));
    const btn = await screen.findByRole("button", { name: /启动推理仿真/ });
    await waitFor(() => expect(btn).not.toBeDisabled(), { timeout: 5_000 });
    await act(async () => { await user.click(btn); });

    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody.kind).toBe("infer");
    expect(postBody.workload_override.mode).toBe("inference");
    expect(postBody.workload_override.kvcache_config).toBeDefined();
    expect(postBody.workload_override.kvcache_config.avg_active_seqs).toBe(256);
    expect(postBody.strategy_override).toMatchObject({ TP: 8, PP: 1, EP: 4, CP: 1 });
  });

  it("typing 名称 carries through to the run title on submit", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let postBody: any = null;
    mockRoutes([
      ["/v1/runs", () => ok({ id: "inf-002", project_id: "p_default", kind: "infer",
                                title: "infer-job-2", status: "queued", inputs_hash: "h",
                                kpis: {}, artifacts: [], boundaries: [],
                                created_at: "2026-05-01T00:00:00Z" })],
    ]);
    const realImpl = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: RequestInit) => {
      if (String(input) === "/v1/runs" && init?.method === "POST") {
        postBody = JSON.parse(init.body as string);
      }
      return realImpl(input, init);
    });
    render(withProviders(<InferenceSim />));
    const input = await screen.findByPlaceholderText(/本次推理仿真名称/);
    await act(async () => { await user.type(input, "infer-job-2"); });
    const btn = await screen.findByRole("button", { name: /启动推理仿真/ });
    await waitFor(() => expect(btn).not.toBeDisabled(), { timeout: 5_000 });
    await act(async () => { await user.click(btn); });
    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody.title).toBe("infer-job-2");
  });

  it("toast error when /v1/runs returns 500", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockRoutes([
      ["/v1/runs", () => new Response(JSON.stringify({ detail: "down" }), { status: 500 })],
    ]);
    render(withProviders(<InferenceSim />));
    const btn = await screen.findByRole("button", { name: /启动推理仿真/ });
    await waitFor(() => expect(btn).not.toBeDisabled(), { timeout: 5_000 });
    await act(async () => { await user.click(btn); });
    await waitFor(() => {
      expect(screen.getAllByText(/提交失败/).length).toBeGreaterThan(0);
    }, { timeout: 5_000 });
  });

  it("renders ProgressStrip after a successful submit", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockRoutes([
      ["/v1/runs", () => ok({ id: "inf-progress-1", project_id: "p_default", kind: "infer",
                                title: "x", status: "queued", inputs_hash: "h",
                                kpis: {}, artifacts: [], boundaries: [],
                                created_at: "2026-05-01T00:00:00Z" })],
      [/\/v1\/runs\/inf-progress-1\/full/, () => ok({
        run: { id: "inf-progress-1", kind: "infer", status: "queued", title: "x",
                kpis: {}, artifacts: [], boundaries: [],
                created_at: "2026-05-01T00:00:00Z", project_id: "p_default", inputs_hash: "h" },
        specs: [], lineage: { self: {}, parents: [], children: [], edges: [] },
      })],
    ]);
    render(withProviders(<InferenceSim />));
    const btn = await screen.findByRole("button", { name: /启动推理仿真/ });
    await waitFor(() => expect(btn).not.toBeDisabled(), { timeout: 5_000 });
    await act(async () => { await user.click(btn); });
    await waitFor(() => expect(screen.getByTestId("sim-progress-strip")).toBeInTheDocument(),
                    { timeout: 5_000 });
  });
});
