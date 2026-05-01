/**
 * S5.6 — Live KPI prediction hook + card.
 *
 * Locks:
 *   - enabled=false → no fetch fired, card hidden.
 *   - enabled=true  → POST to /v1/engines/predict with the payload.
 *   - Inference mode renders TTFT/TPOT row; training renders MFU/step.
 *   - Notes from engine response surface (capped at 2 + overflow).
 *   - feasible=false flips header subtitle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LivePredictCard } from "../components/sim/LivePredictCard";
import type { LivePredictPayload } from "../api/livePredict";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
const err503 = () => new Response(JSON.stringify({ detail: "no covered engine" }),
                                  { status: 503 });

const inferPayload: LivePredictPayload = {
  cluster: { gpu_model: "H200", gpu_count: 32 },
  workload: {
    mode: "inference", seq_len: 8192,
    activated_params_b: 37, total_params_b: 671, quant: "FP8",
    workload_family: "transformer-moe",
    kvcache_config: {
      kv_size_gb_per_seq: 0.020, prefix_share_ratio: 0.6,
      page_size_kb: 16, avg_active_seqs: 256,
    },
  },
  strategy: { TP: 8, PP: 1, EP: 4, CP: 1, recompute: "selective", overlap: "ZBv2" },
};

const trainPayload: LivePredictPayload = {
  cluster: { gpu_model: "B200", gpu_count: 1024 },
  workload: {
    mode: "training", seq_len: 8192, global_batch: 4096,
    activated_params_b: 405, total_params_b: 405, quant: "FP8",
    workload_family: "transformer-dense",
  },
  strategy: { TP: 8, PP: 8, EP: 1, CP: 2, recompute: "selective", overlap: "ZBv2" },
};

beforeEach(() => {
  vi.spyOn(window, "fetch");
});

describe("<LivePredictCard>", () => {
  it("renders nothing when enabled=false", () => {
    const { container } = render(withProviders(
      <LivePredictCard payload={inferPayload} enabled={false} />,
    ));
    expect(container.textContent).toBe("");
  });

  it("inference mode shows TTFT/TPOT/MFU/confidence cells", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      mfu_pct: 48.5, step_ms: 120, ttft_ms: 187, tpot_ms: 32.4,
      peak_kw: 200, confidence: 0.93, feasible: true,
      breakdown: { compute_ms: 80, comm_ms: 30, mem_stall_ms: 10 },
      coverage_status: "in_dist", notes: [],
    }));
    render(withProviders(<LivePredictCard payload={inferPayload} enabled={true} />));
    await waitFor(() => {
      expect(screen.getByTestId("live-ttft").textContent).toContain("187ms");
    });
    expect(screen.getByTestId("live-tpot").textContent).toContain("32.4ms");
    expect(screen.getByTestId("live-mfu").textContent).toContain("48.5%");
    expect(screen.getByTestId("live-confidence").textContent).toContain("0.93");
  });

  it("training mode shows MFU/step/peak/confidence cells", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      mfu_pct: 50, step_ms: 1840, peak_kw: 820, confidence: 0.94,
      feasible: true,
      breakdown: { compute_ms: 1500, comm_ms: 300, mem_stall_ms: 40 },
      coverage_status: "in_dist", notes: [],
    }));
    render(withProviders(<LivePredictCard payload={trainPayload} enabled={true} />));
    await waitFor(() => {
      expect(screen.getByTestId("live-mfu").textContent).toContain("50.0%");
    });
    expect(screen.getByTestId("live-step-ms").textContent).toContain("1.84s");
    expect(screen.getByTestId("live-peak-kw").textContent).toContain("820kW");
  });

  it("posts to /v1/engines/predict with the payload wrapped in envelope", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      mfu_pct: 50, step_ms: 100, peak_kw: 100, confidence: 0.9, feasible: true,
      breakdown: { compute_ms: 80, comm_ms: 10, mem_stall_ms: 10 },
      coverage_status: "in_dist", notes: [],
    }));
    render(withProviders(<LivePredictCard payload={inferPayload} enabled={true} />));
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call[0])).toBe("/v1/engines/predict");
    expect((call[1] as RequestInit).method).toBe("POST");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.payload.cluster.gpu_model).toBe("H200");
    expect(body.payload.strategy.TP).toBe(8);
  });

  it("renders feasible=false subtitle and notes from engine response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      mfu_pct: 5, step_ms: 9999, peak_kw: 900, confidence: 0.5, feasible: false,
      breakdown: { compute_ms: 9000, comm_ms: 999, mem_stall_ms: 0 },
      coverage_status: "in_dist",
      notes: ["TP×PP×EP×CP=128 > GPU 数 32", "EP=16 在 MI355X 上 OOD"],
    }));
    render(withProviders(<LivePredictCard payload={inferPayload} enabled={true} />));
    await waitFor(() => {
      expect(screen.getByText(/不可行/)).toBeInTheDocument();
    });
    const notes = screen.getByTestId("live-notes");
    expect(notes.textContent).toContain("TP×PP×EP×CP=128");
  });

  it("on 503 shows 预测不可用 subtitle without crashing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(err503());
    render(withProviders(<LivePredictCard payload={inferPayload} enabled={true} />));
    await waitFor(() => {
      expect(screen.getByText("预测不可用")).toBeInTheDocument();
    });
  });
});
