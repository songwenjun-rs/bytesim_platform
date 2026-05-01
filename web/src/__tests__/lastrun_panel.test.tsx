/**
 * S2.2a — LastRunPanel: localStorage-backed "last submitted run" surface
 * on the Sim pages.
 *
 * Tests cover three layers:
 *   1. Storage helpers: rememberLastRun / readLastRun / clearLastRun do
 *      what they say and tolerate missing or malformed entries.
 *   2. Panel renders nothing when no last run is recorded — keeps the
 *      Sim page clean for first-time users.
 *   3. Panel fetches the recorded run, renders its title + status + a
 *      BottleneckCard. When the run is fetched 404 (deleted) we silently
 *      clear and render nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import {
  LastRunPanel,
  rememberLastRun,
  readLastRun,
  clearLastRun,
} from "../components/sim/LastRunPanel";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
const notFound = () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });

const baseRunFull = (overrides: any = {}) => ({
  run: {
    id: "run-42", project_id: "p1", kind: "infer", title: "测试推理",
    status: "done", inputs_hash: "h",
    kpis: {
      bottleneck: {
        primary: "nvlink", severity: "high",
        headline: "NVLink 链路 nv-1 利用率 94% — 接近饱和",
        suggested_action: "TP=8 → TP=4",
        links: [{ id: "nv-1", fabric: "nvlink", util_pct: 94, severity: "high" }],
        nodes: [],
      },
    },
    artifacts: [], boundaries: [], created_at: "2026-04-27T00:00:00Z",
    ...overrides,
  },
  specs: [],
  lineage: { self: { kind: "run", id: "run-42", stale: false }, parents: [], children: [], edges: [] },
  derived: { self_stale: false },
});

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(window, "fetch");
});

// ── Storage helpers ────────────────────────────────────────────────────────

describe("LastRunPanel storage helpers", () => {
  it("rememberLastRun + readLastRun round-trip", () => {
    rememberLastRun("infer", "run-42");
    const got = readLastRun("infer");
    expect(got?.runId).toBe("run-42");
    expect(typeof got?.savedAt).toBe("string");
  });

  it("readLastRun returns null when nothing stored", () => {
    expect(readLastRun("train")).toBeNull();
  });

  it("readLastRun tolerates malformed JSON gracefully", () => {
    window.localStorage.setItem("bytesim:lastRun:infer", "{not json");
    expect(readLastRun("infer")).toBeNull();
  });

  it("readLastRun rejects entries without runId string", () => {
    window.localStorage.setItem("bytesim:lastRun:infer", JSON.stringify({ x: 1 }));
    expect(readLastRun("infer")).toBeNull();
  });

  it("clearLastRun removes the entry", () => {
    rememberLastRun("train", "run-7");
    clearLastRun("train");
    expect(readLastRun("train")).toBeNull();
  });
});

// ── Panel rendering ────────────────────────────────────────────────────────

describe("<LastRunPanel>", () => {
  it("renders nothing when no last run is recorded", () => {
    const { container } = render(withProviders(<LastRunPanel kind="infer" />));
    expect(container.textContent).toBe("");
  });

  it("fetches and renders bottleneck card from the recorded run", async () => {
    rememberLastRun("infer", "run-42");
    vi.mocked(fetch).mockResolvedValueOnce(ok(baseRunFull()));

    render(withProviders(<LastRunPanel kind="infer" />));

    await waitFor(() => {
      expect(screen.getByTestId("lastrun-panel")).toBeInTheDocument();
    });
    expect(screen.getByText(/上次推理仿真.*测试推理/)).toBeInTheDocument();
    // BottleneckCard rendered nested
    expect(screen.getByText("NVLink 饱和")).toBeInTheDocument();
    expect(screen.getByText(/TP=8 → TP=4/)).toBeInTheDocument();
    // "查看完整结果" deep link present
    const link = screen.getByText("查看完整结果 →") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/sim/reports/run-42");
  });

  it("kind=train shows training label", async () => {
    rememberLastRun("train", "run-7");
    vi.mocked(fetch).mockResolvedValueOnce(ok(baseRunFull({
      id: "run-7", kind: "train", title: "训练 demo",
    })));
    render(withProviders(<LastRunPanel kind="train" />));
    await waitFor(() => {
      expect(screen.getByText(/上次训练仿真.*训练 demo/)).toBeInTheDocument();
    });
  });

  it("clears localStorage and renders nothing when fetch 404s", async () => {
    rememberLastRun("infer", "run-stale");
    vi.mocked(fetch).mockResolvedValueOnce(notFound());

    const { container } = render(withProviders(<LastRunPanel kind="infer" />));

    // Cleanup happens in useEffect after the query settles; wait on the
    // localStorage state directly rather than the DOM (which goes empty
    // during the loading→error transition too).
    await waitFor(() => {
      expect(readLastRun("infer")).toBeNull();
    });
    expect(container.querySelector('[data-testid="lastrun-panel"]')).toBeNull();
  });
});
