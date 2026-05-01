/**
 * S1.2 — Run metrics types & accessors.
 *
 * The shape of the engine-attributed bottleneck / phase decomposition the
 * UI consumes. Mirrors `shared/engine_contracts/predict.py` 1:1; the names
 * and constraints must move in lockstep with the Python contract.
 *
 * Why a dedicated module rather than tacking onto `runs.ts`:
 *   1. `runs.ts` is the React Query / fetch surface — keeping pure types
 *      here means non-fetching consumers (Topology overlays, Comparator
 *      diff helpers, Tuner Pareto adapters) can import without dragging
 *      `@tanstack/react-query` into their bundle.
 *   2. Run.kpis is intentionally narrow (`Record<string, number>`) for the
 *      legacy KPI consumers; structured metrics live under a separate
 *      lens (`getRunMetrics`) so we can later widen by promoting metrics
 *      to a top-level RunFull field without touching kpi consumers.
 *
 * `runs.ts` re-exports these names verbatim for back-compat with imports
 * written before this slice.
 */

import type { Run } from "./runs";

// ── Enums (mirror engine_contracts) ────────────────────────────────────────

export type Severity = "low" | "med" | "high";

export type BottleneckKind =
  | "nvlink" | "infiniband" | "roce" | "leaf_spine" | "pcie"
  | "compute" | "memory_bw" | "kv_spill" | "kv_pressure"
  | "pp_bubble" | "ep_alltoall" | "unknown";

export type FabricKind =
  | "nvlink" | "infiniband" | "roce" | "cxl" | "pcie" | "ethernet";

// ── Attribution types ──────────────────────────────────────────────────────

export type LinkAttribution = {
  id: string;
  fabric: FabricKind;
  util_pct: number;
  severity: Severity;
  contributes_ms?: number | null;
};

export type NodeAttribution = {
  id: string;
  issue: BottleneckKind;
  severity: Severity;
  metrics?: Record<string, number>;
};

export type BottleneckAttribution = {
  primary: BottleneckKind;
  severity: Severity;
  headline: string;
  suggested_action?: string | null;
  links: LinkAttribution[];
  nodes: NodeAttribution[];
};

export type PhaseBreakdownEntry = { phase: string; ms: number };

// ── Bundle: the typed surface for run-level metrics ────────────────────────
//
// Today the engine response is transported nested inside `Run.kpis` (Go's
// `map[string]any`). When run-svc grows a typed Metrics column we'll
// promote this to a top-level `RunFull.metrics` field; the lens below is
// the single migration point.

export type RunMetrics = {
  bottleneck: BottleneckAttribution | null;
  phase_breakdown: PhaseBreakdownEntry[] | null;
};

// ── Accessors ──────────────────────────────────────────────────────────────

/**
 * Lift the structured metrics view out of a Run. Casts through unknown
 * because `Run.kpis` is typed `Record<string, number>` for back-compat
 * with numeric-KPI consumers — engine attribution lives under the same
 * map but as nested objects (run-svc transports map[string]any verbatim).
 *
 * Always returns a populated RunMetrics object so consumers can render
 * `metrics.bottleneck === null` as "engine did not attribute" without
 * undefined-checks scattered through the UI.
 */
export function getRunMetrics(run: Run): RunMetrics {
  const kpis = run.kpis as unknown as Record<string, unknown> | undefined;
  const rawBn = kpis?.["bottleneck"];
  const rawPb = kpis?.["phase_breakdown"];
  return {
    bottleneck: rawBn && typeof rawBn === "object" && !Array.isArray(rawBn)
      ? (rawBn as BottleneckAttribution)
      : null,
    phase_breakdown: Array.isArray(rawPb)
      ? (rawPb as PhaseBreakdownEntry[])
      : null,
  };
}

export function getBottleneck(run: Run): BottleneckAttribution | null {
  return getRunMetrics(run).bottleneck;
}

export function getPhaseBreakdown(run: Run): PhaseBreakdownEntry[] | null {
  return getRunMetrics(run).phase_breakdown;
}
