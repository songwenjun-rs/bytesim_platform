/**
 * S1.2 — metrics module + back-compat re-export from runs.ts.
 *
 * Two contracts to lock:
 *   1. `getRunMetrics` returns BOTH fields in one shot (single source —
 *      consumers that need both shouldn't call two helpers and risk
 *      drifting reads of `run.kpis`).
 *   2. The `runs.ts` re-export path still resolves identical symbols.
 *      If anyone unwittingly defines parallel types in `runs.ts` again,
 *      this test fails to remind them to keep one source of truth.
 */
import { describe, it, expect } from "vitest";

import {
  getRunMetrics,
  getBottleneck,
  getPhaseBreakdown,
  type RunMetrics,
} from "../api/metrics";

import * as runsApi from "../api/runs";
import type { Run } from "../api/runs";

function mkRun(kpis: Record<string, unknown>): Run {
  return {
    id: "r", project_id: "p", kind: "infer", title: "t",
    status: "done", inputs_hash: "h",
    kpis: kpis as Record<string, number>,
    artifacts: [], boundaries: [],
    created_at: "2026-04-27T00:00:00Z",
  };
}

describe("getRunMetrics", () => {
  it("returns nulls for both fields when engine did not attribute", () => {
    const m: RunMetrics = getRunMetrics(mkRun({ mfu_pct: 50 }));
    expect(m.bottleneck).toBeNull();
    expect(m.phase_breakdown).toBeNull();
  });

  it("returns populated bottleneck and phase_breakdown together", () => {
    const m = getRunMetrics(mkRun({
      bottleneck: {
        primary: "nvlink", severity: "high", headline: "x",
        links: [], nodes: [],
      },
      phase_breakdown: [
        { phase: "compute", ms: 8 },
        { phase: "comm", ms: 1 },
      ],
    }));
    expect(m.bottleneck?.primary).toBe("nvlink");
    expect(m.phase_breakdown).toHaveLength(2);
  });

  it("rejects non-object bottleneck and non-array phase_breakdown", () => {
    // Defensive: if engine ever serializes wrong shape, we return null
    // rather than handing the UI a number-typed bottleneck.
    const m = getRunMetrics(mkRun({
      bottleneck: 42,
      phase_breakdown: { not: "an array" },
    }));
    expect(m.bottleneck).toBeNull();
    expect(m.phase_breakdown).toBeNull();
  });

  it("getBottleneck and getPhaseBreakdown read the same source", () => {
    const run = mkRun({
      bottleneck: {
        primary: "kv_spill", severity: "high", headline: "x",
        links: [], nodes: [],
      },
    });
    expect(getBottleneck(run)?.primary).toBe("kv_spill");
    expect(getPhaseBreakdown(run)).toBeNull();
  });
});

describe("runs.ts re-exports keep one source of truth", () => {
  it("getBottleneck identity is preserved via runs.ts re-export", () => {
    expect(runsApi.getBottleneck).toBe(getBottleneck);
    expect(runsApi.getPhaseBreakdown).toBe(getPhaseBreakdown);
    expect(runsApi.getRunMetrics).toBe(getRunMetrics);
  });
});
