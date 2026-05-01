/** Tests for /sim/training and /sim/inference single-job pages. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { setSession } from "../api/client";
import { TrainingSim } from "../pages/TrainingSim";
import { InferenceSim } from "../pages/InferenceSim";

function withProviders(ui: React.ReactNode, initial = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/sim/training" element={ui} />
          <Route path="/sim/inference" element={ui} />
          <Route path="/sim/reports/:runId" element={<div data-testid="run-detail-stub">Run detail</div>} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (json: any) => new Response(JSON.stringify(json), { status: 200 });

const specReply = (kind: string, id: string, hash: string) =>
  ok({
    spec: {
      id, kind, name: id, project_id: "p_default", latest_hash: hash,
      created_at: "2026-04-01T00:00:00Z",
    },
    version: {
      hash, spec_id: id, parent_hash: null, version_tag: "v1", body: {},
      created_at: "2026-04-01T00:00:00Z",
    },
  });

/**
 * URL-routed fetch mock — newer tests rely on this because pages now
 * fire side-channel fetches (S5.6 live predict, S6.5 thumbnail spec
 * re-read, etc.) whose order isn't stable. Match by URL path first;
 * unmatched URLs return 404 so the form-level state still resolves.
 */
function mockFetchByUrl(routes: Array<[RegExp | string, () => Response]>) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    for (const [pattern, fn] of routes) {
      if (typeof pattern === "string" ? url === pattern : pattern.test(url)) {
        return fn();
      }
    }
    return new Response("not-mocked: " + url, { status: 404 });
  });
}

const HW_HASH = "0000000000000000000000000000000000000004";
const MD_HASH = "0000000000000000000000000000000000000102";

beforeEach(() => {
  setSession("t", "p_default");
});

// TODO Phase 2 — these tests target the pre-refactor TrainingSim/InferenceSim
// (form-only state, 1024×B200 default, SubmittedRunPanel). Current pages have:
//   - sticky topbar with name input + PresetActionsRow + submit button
//   - cluster picker driven by hwspec body, gpu_count derived from selected
//   - ProgressStrip (slim) instead of SubmittedRunPanel
//   - presets read via /v1/catalog/items/{train,infer}_preset, not from
//     hardcoded TRAINING_PRESETS arrays
//   - title default empty; engine_preference field on submit
// Skip wholesale; Phase 2 re-writes against the new structure.
describe.skip("TrainingSim page (legacy)", () => {
  it("renders the form with Llama-3-405B / 1024×B200 defaults", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply("hwspec", "hwspec_topo_b1", HW_HASH))
      .mockResolvedValueOnce(specReply("model", "model_moe256e", MD_HASH));
    render(withProviders(<TrainingSim />, "/sim/training"));
    await screen.findByText(/训练仿真 · 单次/);
    // Title input prefilled
    expect(screen.getByDisplayValue(/Llama-3-405B/)).toBeInTheDocument();
    // gpu_count default
    expect(screen.getByDisplayValue("1024")).toBeInTheDocument();
    // capacity preview shows TP·PP·EP·CP=8·8·1·2=128
    await screen.findByText(/TP×PP×EP×CP = 128/);
  });

  it("submits POST /v1/runs with cluster/workload/strategy overrides + opens in-place progress panel", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockFetchByUrl([
      [/\/v1\/specs\/hwspec\/hwspec_topo_b1/, () => specReply("hwspec", "hwspec_topo_b1", HW_HASH)],
      [/\/v1\/specs\/model\/model_moe256e/, () => specReply("model", "model_moe256e", MD_HASH)],
      ["/v1/runs", () => ok({ id: "sim-abc" })],
      [/\/v1\/runs\/sim-abc\/full/, () => ok({
        run: { id: "sim-abc", project_id: "p_default", kind: "train",
               title: "x", status: "running", inputs_hash: "h",
               kpis: {}, artifacts: [], boundaries: [], created_at: "2026-04-27T00:00:00Z" },
        specs: [], lineage: { self: { kind: "run", id: "sim-abc", stale: false }, parents: [], children: [], edges: [] },
        derived: { self_stale: false },
      })],
      ["/v1/engines/predict", () => ok({                // S5.6 live predict
        mfu_pct: 50, step_ms: 100, peak_kw: 100, confidence: 0.9, feasible: true,
        breakdown: { compute_ms: 80, comm_ms: 10, mem_stall_ms: 10 },
        coverage_status: "in_dist", notes: [],
      })],
    ]);

    render(withProviders(<TrainingSim />, "/sim/training"));
    const btn = await screen.findByRole("button", { name: /启动训练仿真/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => { await user.click(btn); });

    // Find the POST call
    const postCall = vi.mocked(fetch).mock.calls.find(
      (c) => String(c[0]) === "/v1/runs" && (c[1] as RequestInit)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.kind).toBe("train");
    expect(body.hwspec_hash).toBe(HW_HASH);
    expect(body.model_hash).toBe(MD_HASH);
    expect(body.cluster_override).toMatchObject({ gpu_model: "B200", gpu_count: 1024 });
    expect(body.workload_override).toMatchObject({
      mode: "training", quant: "FP8", activated_params_b: 405,
    });
    expect(body.strategy_override).toMatchObject({
      TP: 8, PP: 8, EP: 1, CP: 2, recompute: "selective", overlap: "ZBv2",
    });

    // S2.2b: page stays put; SubmittedRunPanel takes over the LastRunPanel slot
    await screen.findByTestId("submitted-run-panel");
    // "查看完整结果" link points to the run detail page
    const link = screen.getByTestId("submitted-run-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/sim/reports/sim-abc");
    // No navigation occurred — form is still mounted
    expect(screen.queryByTestId("run-detail-stub")).toBeNull();
  });

  it("blocks submit when TP×PP×EP×CP > gpu_count", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply("hwspec", "hwspec_topo_b1", HW_HASH))
      .mockResolvedValueOnce(specReply("model", "model_moe256e", MD_HASH));
    render(withProviders(<TrainingSim />, "/sim/training"));
    const gpuInput = await screen.findByDisplayValue("1024");
    await act(async () => {
      await user.clear(gpuInput);
      await user.type(gpuInput, "32");
    });
    await screen.findByText(/超过 GPU 数/);
    const btn = screen.getByRole("button", { name: /启动训练仿真/ });
    expect(btn).toBeDisabled();
  });
});

describe.skip("InferenceSim page (legacy)", () => {
  it("renders the form with DeepSeek-V3 / 32×H200 defaults", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(specReply("hwspec", "hwspec_topo_b1", HW_HASH))
      .mockResolvedValueOnce(specReply("model", "model_moe256e", MD_HASH));
    render(withProviders(<InferenceSim />, "/sim/inference"));
    await screen.findByRole("heading", { name: /推理仿真/ });
    expect(screen.getByDisplayValue(/DeepSeek-V3/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("32")).toBeInTheDocument();
    // KV working set bar visible (specific to L1.2 KvFootprintBar — there
    // are now multiple "KV 工作集" matches; assert via testid).
    await screen.findByTestId("kv-footprint-bar");
  });

  it("submits POST /v1/runs with kind=infer and kvcache_config + opens progress panel", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    mockFetchByUrl([
      [/\/v1\/specs\/hwspec\/hwspec_topo_b1/, () => specReply("hwspec", "hwspec_topo_b1", HW_HASH)],
      [/\/v1\/specs\/model\/model_moe256e/, () => specReply("model", "model_moe256e", MD_HASH)],
      ["/v1/runs", () => ok({ id: "inf-xyz" })],
      [/\/v1\/runs\/inf-xyz\/full/, () => ok({
        run: { id: "inf-xyz", project_id: "p_default", kind: "infer",
               title: "x", status: "running", inputs_hash: "h",
               kpis: {}, artifacts: [], boundaries: [], created_at: "2026-04-27T00:00:00Z" },
        specs: [], lineage: { self: { kind: "run", id: "inf-xyz", stale: false }, parents: [], children: [], edges: [] },
        derived: { self_stale: false },
      })],
      ["/v1/engines/predict", () => ok({
        mfu_pct: 48, step_ms: 100, peak_kw: 100, confidence: 0.9,
        feasible: true, ttft_ms: 150, tpot_ms: 30,
        breakdown: { compute_ms: 80, comm_ms: 10, mem_stall_ms: 10 },
        coverage_status: "in_dist", notes: [],
      })],
    ]);

    render(withProviders(<InferenceSim />, "/sim/inference"));
    const btn = await screen.findByRole("button", { name: /启动推理仿真/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => { await user.click(btn); });

    const postCall = vi.mocked(fetch).mock.calls.find(
      (c) => String(c[0]) === "/v1/runs" && (c[1] as RequestInit)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.kind).toBe("infer");
    expect(body.workload_override.mode).toBe("inference");
    expect(body.workload_override.kvcache_config).toMatchObject({
      kv_size_gb_per_seq: 0.020,
      prefix_share_ratio: 0.6,
      avg_active_seqs: 256,
    });
    expect(body.strategy_override).toMatchObject({ TP: 8, PP: 1, EP: 4, CP: 1 });

    await screen.findByTestId("submitted-run-panel");
    expect(screen.queryByTestId("run-detail-stub")).toBeNull();
  });
});
