/**
 * S4.6 — PrevRunDeltaCard direction-aware KPI delta display.
 *
 * Locks:
 *   - Hidden when run.status !== "done" (no useful delta mid-flight).
 *   - Hidden when no recentRuns entry matches the hwspec.
 *   - Hidden when only the current run is in recentRuns (excludes self).
 *   - Direction normalization: MFU up → ↑ green; step_ms up → ↓ red.
 *   - confidence is read from Run.confidence (top-level), not kpis.
 *   - Per-field "无 baseline" when previous run lacks the KPI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { PrevRunDeltaCard } from "../components/run/PrevRunDeltaCard";
import { pushRecentRun, clearRecentRuns } from "../components/sim/recentRuns";
import type { Run } from "../api/runs";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });

function mkRun(id: string, status: Run["status"], kpis: Record<string, number>,
               confidence?: number, kind: Run["kind"] = "train"): Run {
  return {
    id, project_id: "p", kind, title: id,
    status, inputs_hash: "h",
    kpis, artifacts: [], boundaries: [],
    confidence: confidence ?? null,
    created_at: "2026-04-27T00:00:00Z",
  };
}

const runFullStub = (run: Run) => ok({
  run, specs: [],
  lineage: { self: { kind: "run", id: run.id, stale: false }, parents: [], children: [], edges: [] },
  derived: { self_stale: false },
});

beforeEach(() => {
  window.localStorage.clear();
  clearRecentRuns();
  vi.spyOn(window, "fetch");
});

describe("<PrevRunDeltaCard>", () => {
  it("hidden when current run is not done yet", () => {
    pushRecentRun({ runId: "old", kind: "train", hwspecId: "hw1" });
    const { container } = render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur", "running", { mfu_pct: 50 })}
        hwspecId="hw1"
      />,
    ));
    expect(container.textContent).toBe("");
  });

  it("hidden when no recentRuns matches the hwspec", () => {
    pushRecentRun({ runId: "old", kind: "train", hwspecId: "other-hw" });
    const { container } = render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur", "done", { mfu_pct: 50 })}
        hwspecId="hw1"
      />,
    ));
    expect(container.textContent).toBe("");
  });

  it("hidden when the only recentRun is the current run itself", () => {
    pushRecentRun({ runId: "cur", kind: "train", hwspecId: "hw1" });
    const { container } = render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur", "done", { mfu_pct: 50 })}
        hwspecId="hw1"
      />,
    ));
    expect(container.textContent).toBe("");
  });

  it("hidden when hwspecId not supplied (older runs without lineage)", () => {
    pushRecentRun({ runId: "old", kind: "train", hwspecId: "hw1" });
    const { container } = render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur", "done", { mfu_pct: 50 })}
      />,
    ));
    expect(container.textContent).toBe("");
  });

  it("training KPI delta: +MFU green ↑, +step_ms red ↓", async () => {
    pushRecentRun({ runId: "old", kind: "train", hwspecId: "hw1" });
    vi.mocked(fetch).mockResolvedValueOnce(runFullStub(
      mkRun("old", "done", { mfu_pct: 40, step_ms: 2000, peak_kw: 700 }, 0.9, "train"),
    ));
    render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur", "done", { mfu_pct: 50, step_ms: 2200, peak_kw: 700 }, 0.85, "train")}
        hwspecId="hw1"
      />,
    ));
    await waitFor(() => {
      expect(screen.getByTestId("prev-run-delta")).toBeInTheDocument();
    });
    // MFU: cur 50 - old 40 = +10pp, max-dir → up = improvement → green
    expect(screen.getByTestId("prev-run-delta-mfu_pct").dataset.sign).toBe("up");
    expect(screen.getByTestId("prev-run-delta-mfu_pct").textContent).toContain("+10.0pp");
    // step_ms: cur 2200 - old 2000 = +200ms, min-dir → up means worse → red
    expect(screen.getByTestId("prev-run-delta-step_ms").dataset.sign).toBe("down");
    // peak_kw: 0 delta → none
    expect(screen.getByTestId("prev-run-delta-peak_kw").dataset.sign).toBe("none");
    // confidence: cur 0.85 - old 0.9 = -0.05, max-dir → down
    expect(screen.getByTestId("prev-run-delta-confidence").dataset.sign).toBe("down");
  });

  it("inference run uses TTFT/TPOT/MFU/conf field set", async () => {
    pushRecentRun({ runId: "old-i", kind: "infer", hwspecId: "hw1" });
    vi.mocked(fetch).mockResolvedValueOnce(runFullStub(
      mkRun("old-i", "done", { ttft_p99_ms: 200, tpot_ms: 50, mfu_pct: 40 }, 0.9, "infer"),
    ));
    render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur-i", "done", { ttft_p99_ms: 180, tpot_ms: 45, mfu_pct: 50 }, 0.92, "infer")}
        hwspecId="hw1"
      />,
    ));
    await waitFor(() => {
      // TTFT: cur 180 - old 200 = -20ms, min-dir → down = improvement → green ↑
      expect(screen.getByTestId("prev-run-delta-ttft_p99_ms").dataset.sign).toBe("up");
    });
    expect(screen.getByTestId("prev-run-delta-tpot_ms").dataset.sign).toBe("up");
  });

  it("renders 无 baseline when previous run lacks a KPI", async () => {
    pushRecentRun({ runId: "old", kind: "train", hwspecId: "hw1" });
    vi.mocked(fetch).mockResolvedValueOnce(runFullStub(
      // old run lacks step_ms
      mkRun("old", "done", { mfu_pct: 40 }, 0.9, "train"),
    ));
    render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur", "done", { mfu_pct: 50, step_ms: 2200 }, 0.85, "train")}
        hwspecId="hw1"
      />,
    ));
    await waitFor(() => {
      expect(screen.getByTestId("prev-run-delta-step_ms").textContent)
        .toContain("无 baseline");
    });
  });

  it("link href points to the previous run detail page", async () => {
    pushRecentRun({ runId: "older", kind: "train", hwspecId: "hw1" });
    vi.mocked(fetch).mockResolvedValueOnce(runFullStub(
      mkRun("older", "done", { mfu_pct: 40 }, 0.9, "train"),
    ));
    render(withProviders(
      <PrevRunDeltaCard
        run={mkRun("cur", "done", { mfu_pct: 50 }, 0.85, "train")}
        hwspecId="hw1"
      />,
    ));
    await waitFor(() => {
      const link = screen.getByTestId("prev-run-link") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("/sim/reports/older");
    });
  });
});
