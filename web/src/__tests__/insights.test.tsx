/**
 * components/sim/insights — shared widgets for the sim pages.
 * Covers the pure helpers (summarizeHwSpec, checkEngine) end-to-end and
 * minimal render paths for the four widgets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  summarizeHwSpec, checkEngine, ProgressStrip, EngineCheckCard,
  GpuUtilDonut, ChipRow, FieldLabel,
} from "../components/sim/insights";
import type { Engine } from "../api/engines";
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

beforeEach(() => {
  setSession("t", "p_default");
});

// ── summarizeHwSpec ────────────────────────────────────────────────────────

describe("summarizeHwSpec", () => {
  const body = {
    datacenter: {
      id: "dc-1", name: "DC1",
      clusters: [
        {
          id: "C01", name: "main", purpose: "训练" as const, pue: 1.18,
          racks: [
            { id: "R01", status: "ok" as const, servers: [
              { id: "s1", gpu_model: "B200", gpu_count: 8, nic: "x", status: "ok" as const, tdp_kw: 11 },
              { id: "s2", gpu_model: "B200", gpu_count: 8, nic: "x", status: "ok" as const, tdp_kw: 11 },
            ]},
          ],
        },
        {
          id: "C02", name: "infer", purpose: "推理" as const,
          racks: [
            { id: "R02", status: "ok" as const, servers: [
              { id: "s3", gpu_model: "H200", gpu_count: 8, nic: "x", status: "ok" as const, tdp_kw: 6.5 },
            ]},
          ],
        },
      ],
      scale_out_fabrics: [{ id: "f", name: "Fab", kind: "infiniband" as const,
                            topology: "rail-optimized" as const, spines: [] }],
    },
  };

  it("scopes to a single cluster when clusterId is given", () => {
    const s = summarizeHwSpec(body, "C01");
    expect(s.gpu_count).toBe(16);
    expect(s.gpu_model).toBe("B200");
    expect(s.cluster_id).toBe("C01");
    expect(s.cluster_purpose).toBe("训练");
    expect(s.total_servers).toBe(2);
    expect(s.total_racks).toBe(1);
    expect(s.pue).toBeCloseTo(1.18);
  });

  it("aggregates across the whole datacenter when clusterId is null", () => {
    const s = summarizeHwSpec(body, null);
    expect(s.gpu_count).toBe(24);  // 16 B200 + 8 H200
    expect(s.gpu_model).toBe("B200");  // the dominant model
    expect(s.total_servers).toBe(3);
  });

  it("returns sane defaults when body is empty / undefined", () => {
    const s = summarizeHwSpec(undefined, null);
    expect(s.gpu_count).toBe(0);
    expect(s.cluster_id).toBeNull();
  });

  it("falls back to body.power.pue when no cluster pue", () => {
    const s = summarizeHwSpec({
      datacenter: { id: "x", name: "x", clusters: [] },
      power: { pue: 1.4 },
    } as any, null);
    expect(s.pue).toBe(1.4);
  });
});

// ── checkEngine ────────────────────────────────────────────────────────────

const baseEngine: Engine = {
  name: "x", version: "1", fidelity: "analytical", sla_p99_ms: 100,
  endpoint: "http://x", predict_path: "/v1/predict",
  coverage_envelope: {
    workload_families: ["transformer-dense"],
    parallelism: {
      TP: [1, 16], PP: [1, 8], EP: [1, 1], CP: [1, 1],
      recompute: ["selective"], overlap: ["1F1B"],
    },
    hardware: { gpu_models: ["B200"], fabric: ["nvlink"], scale_gpus: [8, 1024] },
    quant: ["FP8"],
    modes: ["training"],
  },
  kpi_outputs: ["mfu_pct"],
  calibration: {},
  status: "active", registered_at: "2026-01-01",
};

describe("checkEngine", () => {
  const inEnv = {
    TP: 8, PP: 8, EP: 1, CP: 1,
    recompute: "selective", overlap: "1F1B",
    quant: "FP8", workload_family: "transformer-dense",
    gpu_model: "B200", gpu_count: 256,
  };

  it("flags every axis green when fully in envelope", () => {
    const checks = checkEngine(baseEngine, inEnv);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("flags out-of-range parallelism", () => {
    const checks = checkEngine(baseEngine, { ...inEnv, EP: 8 });
    const ep = checks.find((c) => c.name === "EP")!;
    expect(ep.ok).toBe(false);
    expect(ep.current).toBe("8");
  });

  it("flags out-of-list quant / overlap / recompute", () => {
    const checks = checkEngine(baseEngine, { ...inEnv, overlap: "ZBv2" });
    expect(checks.find((c) => c.name === "Overlap")!.ok).toBe(false);
  });

  it("flags GPU model not in whitelist", () => {
    const checks = checkEngine(baseEngine, { ...inEnv, gpu_model: "MI355X" });
    expect(checks.find((c) => c.name === "GPU")!.ok).toBe(false);
  });

  it("flags GPU count out of scale_gpus range", () => {
    const checks = checkEngine(baseEngine, { ...inEnv, gpu_count: 4 });
    expect(checks.find((c) => c.name === "GPU")!.ok).toBe(false);
  });
});

// ── ProgressStrip ──────────────────────────────────────────────────────────

describe("<ProgressStrip>", () => {
  it("shows status text + percent for a running run", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      run: { id: "sim-1", status: "running", progress_pct: 42,
             kpis: {}, artifacts: [], boundaries: [], project_id: "p", kind: "train",
             title: "x", inputs_hash: "h", created_at: "2026-01-01" },
      specs: [], lineage: { self: { kind: "run", id: "sim-1", stale: false }, parents: [], children: [], edges: [] },
      derived: { self_stale: false },
    }));
    render(withProviders(<ProgressStrip runId="sim-1" onDismiss={() => {}} />));
    await waitFor(() => expect(screen.getByText(/42%/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/仿真中/)).toBeInTheDocument());
    expect(screen.getByTestId("sim-progress-link")).toBeVisible();
  });

  it("shows 完成 + 查看结果 link when status=done", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      run: { id: "sim-2", status: "done", progress_pct: 100,
             kpis: {}, artifacts: [], boundaries: [], project_id: "p", kind: "train",
             title: "x", inputs_hash: "h", created_at: "2026-01-01" },
      specs: [], lineage: { self: { kind: "run", id: "sim-2", stale: false }, parents: [], children: [], edges: [] },
      derived: { self_stale: false },
    }));
    render(withProviders(<ProgressStrip runId="sim-2" onDismiss={() => {}} />));
    await waitFor(() => expect(screen.getByText(/完成/)).toBeInTheDocument());
    expect(screen.getByText(/查看结果/)).toBeInTheDocument();
  });

  it("✗ button calls onDismiss", async () => {
    const onDismiss = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    vi.mocked(fetch).mockResolvedValueOnce(ok({
      run: { id: "x", status: "queued", kpis: {}, artifacts: [], boundaries: [],
             project_id: "p", kind: "train", title: "x", inputs_hash: "h", created_at: "2026-01-01" },
      specs: [], lineage: { self: { kind: "run", id: "x", stale: false }, parents: [], children: [], edges: [] },
      derived: { self_stale: false },
    }));
    render(withProviders(<ProgressStrip runId="x" onDismiss={onDismiss} />));
    await waitFor(() => screen.getByTestId("sim-progress-dismiss"));
    await user.click(screen.getByTestId("sim-progress-dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});

// ── EngineCheckCard ────────────────────────────────────────────────────────

describe("<EngineCheckCard>", () => {
  const cfg = {
    TP: 8, PP: 8, EP: 1, CP: 1,
    recompute: "selective", overlap: "1F1B",
    quant: "FP8", workload_family: "transformer-dense",
    gpu_model: "B200", gpu_count: 256,
  };

  it("shows green tag + engine info when config in envelope", () => {
    render(withProviders(
      <EngineCheckCard engines={[baseEngine]} selectedName="x" onSelect={() => {}} cfg={cfg} />
    ));
    expect(screen.getByText(/✓ 当前配置可用/)).toBeInTheDocument();
    expect(screen.getByText(/精度/)).toBeInTheDocument();
    expect(screen.getByText(/版本/)).toBeInTheDocument();
  });

  it("shows red warning + failing axes when out of envelope", () => {
    render(withProviders(
      <EngineCheckCard engines={[baseEngine]} selectedName="x"
        onSelect={() => {}} cfg={{ ...cfg, EP: 8 }} />
    ));
    expect(screen.getByText(/✗ 引擎不支持当前配置/)).toBeInTheDocument();
    expect(screen.getByText(/EP =/)).toBeInTheDocument();
  });

  it("shows empty notice when no engines available", () => {
    render(withProviders(
      <EngineCheckCard engines={[]} selectedName="" onSelect={() => {}} cfg={cfg} />
    ));
    expect(screen.getByText(/没有可用引擎/)).toBeInTheDocument();
  });

  it("renders calibration MAPE block when present", () => {
    const e: Engine = { ...baseEngine, calibration: { mape_pct: { mfu: 4.2 }, profile_runs: ["r1"] } };
    render(withProviders(<EngineCheckCard engines={[e]} selectedName="x" onSelect={() => {}} cfg={cfg} />));
    expect(screen.getByText(/校准 MAPE/)).toBeInTheDocument();
    expect(screen.getByText(/4\.2%/)).toBeInTheDocument();
  });
});

// ── GpuUtilDonut ───────────────────────────────────────────────────────────

describe("<GpuUtilDonut>", () => {
  it("renders pct + warns when used > total", () => {
    render(<GpuUtilDonut used={300} total={256} />);
    expect(screen.getByText(/超过总卡数/)).toBeInTheDocument();
  });
  it("perfectly-fits message when used == total", () => {
    render(<GpuUtilDonut used={256} total={256} />);
    expect(screen.getByText(/正好占满/)).toBeInTheDocument();
  });
  it("idle remainder message when used < total", () => {
    render(<GpuUtilDonut used={128} total={256} />);
    expect(screen.getByText(/张卡空闲|未被并行布局占用/)).toBeInTheDocument();
  });
});

// ── ChipRow / FieldLabel ───────────────────────────────────────────────────

describe("<ChipRow> / <FieldLabel>", () => {
  it("ChipRow active chip uses primary; click fires onChange", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const onChange = vi.fn();
    render(<ChipRow value={4} options={[1, 2, 4, 8]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "8" }));
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it("FieldLabel renders its children", () => {
    render(<FieldLabel>Foo</FieldLabel>);
    expect(screen.getByText("Foo")).toBeInTheDocument();
  });
});
