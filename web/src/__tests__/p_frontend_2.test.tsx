/** P-Frontend-2: smoke tests for Topbar / Modal / Engines. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { setSession } from "../api/client";
import { Topbar } from "../components/shell/Topbar";
import { Modal } from "../components/shell/Modal";
import { Engines } from "../pages/Engines";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (json: any) => new Response(JSON.stringify(json), { status: 200 });

beforeEach(() => {
  setSession("t", "p_default");
});

// ── Topbar ───────────────────────────────────────────────────────────
//
// Topbar was gutted when login / multi-project were removed; it's now a
// blank spacing element. The legacy project picker / role tag / 退出 tests
// were dropped — leaving a single smoke test that the component mounts
// without trying to fetch /v1/auth/me.

describe("Topbar", () => {
  it("renders without making any API calls", () => {
    const fetchSpy = vi.mocked(fetch);
    fetchSpy.mockClear();
    render(withProviders(<Topbar />));
    // Topbar is now a blank div — verify no auth fetch fired.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Modal ────────────────────────────────────────────────────────────

describe("Modal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Modal open={false} title="x" onClose={() => {}}>body</Modal>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders body + title when open", () => {
    render(<Modal open title="My Modal" onClose={() => {}}>hello body</Modal>);
    expect(screen.getByText("My Modal")).toBeInTheDocument();
    expect(screen.getByText("hello body")).toBeInTheDocument();
  });

  it("calls onClose when backdrop clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open title="x" onClose={onClose}>body</Modal>);
    // Click the dialog (which is the backdrop)
    const dialog = screen.getByRole("dialog");
    await user.click(dialog);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when ✕ button clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open title="x" onClose={onClose}>body</Modal>);
    await user.click(screen.getByLabelText("关闭"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onSubmit when 确定 clicked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Modal open title="x" onClose={() => {}} onSubmit={onSubmit} submitLabel="✓ Save">
        body
      </Modal>,
    );
    await user.click(screen.getByText("✓ Save"));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("submit disabled when submitDisabled=true", () => {
    render(
      <Modal open title="x" onClose={() => {}} onSubmit={() => {}} submitDisabled>
        body
      </Modal>,
    );
    const btn = screen.getByText("确定") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Esc closes modal", () => {
    const onClose = vi.fn();
    render(<Modal open title="x" onClose={onClose}>body</Modal>);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("destructive styling renders red submit", () => {
    render(
      <Modal open title="Delete?" onClose={() => {}} onSubmit={() => {}}
             destructive submitLabel="✗ Delete">
        sure?
      </Modal>,
    );
    expect(screen.getByText("✗ Delete")).toBeInTheDocument();
  });
});

// ── Engines ──────────────────────────────────────────────────────────

describe("Engines page", () => {
  it("shows empty state when no engines", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok([]));
    render(withProviders(<Engines />));
    await screen.findByText(/没有注册的引擎/);
  });

  it("renders engine cards grouped by fidelity (RFC-001 v2)", async () => {
    const wideEnv = {
      workload_families: ["transformer-dense", "transformer-moe"],
      parallelism: { TP: [1, 64], PP: [1, 64], EP: [1, 64], CP: [1, 8],
                     recompute: ["selective"], overlap: ["1F1B", "ZBv2"] },
      hardware: { gpu_models: ["B200", "H200"], fabric: ["nvlink"],
                  scale_gpus: [8, 8192] },
      quant: ["BF16", "FP8"], modes: ["training", "inference"],
    };
    const narrowEnv = {
      workload_families: ["transformer-dense"],
      parallelism: { TP: [1, 16], PP: [1, 1], EP: [1, 1], CP: [1, 1],
                     recompute: ["selective"], overlap: ["1F1B"] },
      hardware: { gpu_models: ["B200", "H200", "H100"], fabric: ["nvlink", "infiniband"],
                  scale_gpus: [4, 16] },
      quant: ["BF16", "FP8"], modes: ["training"],
    };
    vi.mocked(fetch).mockResolvedValueOnce(ok([
      {
        name: "surrogate-analytical", version: "v0.2.0",
        fidelity: "analytical",
        sla_p99_ms: 100, endpoint: "http://surrogate-svc:8083",
        predict_path: "/v1/predict",
        coverage_envelope: wideEnv, kpi_outputs: ["mfu_pct", "step_ms"],
        calibration: {},
        status: "active", registered_at: "2026-01-01T00:00:00Z",
        last_seen_at: "2026-04-25T00:00:00Z", notes: "Bootstrap engine",
      },
      {
        name: "astra-sim", version: "v2.0.0-analytical",
        fidelity: "cycle-accurate",
        sla_p99_ms: 5000, endpoint: "http://astra-sim-svc:8092",
        predict_path: "/v1/predict",
        coverage_envelope: narrowEnv, kpi_outputs: ["mfu_pct", "step_ms"],
        calibration: {},
        status: "active",
        registered_at: "2026-02-01T00:00:00Z", last_seen_at: null, notes: null,
      },
    ]));
    render(withProviders(<Engines />));
    await screen.findByText("surrogate-analytical");
    expect(screen.getByText("astra-sim")).toBeInTheDocument();
    // fidelity summary tag — "时钟精确" appears for cycle-accurate
    expect(screen.getAllByText("时钟精确").length).toBeGreaterThan(0);
  });
});

