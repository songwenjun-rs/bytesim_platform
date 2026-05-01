import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch, getJSON } from "./client";

export type Run = {
  id: string;
  project_id: string;
  kind: "train" | "infer" | "batch" | "agent" | "tco" | "calibration";
  title: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress_pct?: number | null;
  inputs_hash: string;
  surrogate_ver?: string | null;
  confidence?: number | null;
  parent_run_id?: string | null;
  budget_gpuh?: number | null;
  cost_usd?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  kpis: Record<string, number>;
  artifacts: Artifact[];
  boundaries: Boundary[];
  created_by?: string | null;
  created_at: string;
};

export type Artifact = { name: string; file: string; bytes: number; icon: string };
export type Boundary = { level: "ok" | "warn" | "err" | "info"; text: string };

// ── S1 visualization contract — mirrors shared/engine_contracts/predict.py ──
//
// The metrics types and accessors moved to `./metrics` so non-fetching
// consumers can import them without pulling React Query into their bundle.
// Re-exported here for back-compat with imports written before S1.2.
export type {
  Severity,
  BottleneckKind,
  FabricKind,
  LinkAttribution,
  NodeAttribution,
  BottleneckAttribution,
  PhaseBreakdownEntry,
  RunMetrics,
} from "./metrics";
export { getRunMetrics, getBottleneck, getPhaseBreakdown } from "./metrics";

export type SpecRef = {
  hash: string;
  spec_id: string;
  kind: "hwspec" | "model" | "strategy" | "workload";
  name: string;
  version_tag: string;
  body: unknown;
  stale: boolean;
};

export type LineageNode = {
  kind: "run" | "calibration" | "study";
  id: string;
  title?: string;
  status?: string;
  stale: boolean;
};

export type LineageEdge = {
  src_kind: string;
  src_id: string;
  dst_kind: string;
  dst_id: string;
  rel: string;
};

export type Lineage = {
  self: LineageNode;
  parents: LineageNode[];
  children: LineageNode[];
  edges: LineageEdge[];
};

export type RunFull = {
  run: Run;
  specs: SpecRef[];
  lineage: Lineage;
  derived: { self_stale: boolean };
};

export type CreateRunBody = {
  kind?: "train" | "infer" | "batch" | "agent" | "tco";
  title?: string;
  hwspec_hash: string;
  model_hash: string;
  strategy_hash?: string;
  workload_hash?: string;
  parent_run_id?: string;
  derived_from_study?: string;
  derived_from_trial?: number;
  strategy_override?: Record<string, any>;
  cluster_override?: Record<string, any>;
  workload_override?: Record<string, any>;
  /** Pin the engine-registry to a specific engine name (e.g. "astra-sim").
   *  When unset, registry routes by fidelity / calibration MAPE / SLA. */
  engine_preference?: string;
  surrogate_ver?: string;
  created_by?: string;
};

export function useCreateRun() {
  return useMutation({
    mutationFn: async (body: CreateRunBody) => {
      const r = await authFetch("/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json() as Promise<Run>;
    },
  });
}

export function useCancelRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await authFetch(`/v1/runs/${runId}/cancel`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["run-full", runId] }),
  });
}

export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      const r = await authFetch(`/v1/runs/${runId}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error(`${r.status} ${await r.text()}`);
      return runId;
    },
    onSuccess: (runId) => {
      qc.invalidateQueries({ queryKey: ["run-list"] });
      qc.removeQueries({ queryKey: ["run-full", runId] });
    },
  });
}

export function useRunList(filters?: {
  status?: string;
  kind?: string;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set("status", filters.status);
  if (filters?.kind) qs.set("kind", filters.kind);
  qs.set("limit", String(filters?.limit ?? 50));
  return useQuery({
    queryKey: ["run-list", filters ?? {}],
    queryFn: () => getJSON<Run[]>(`/v1/runs?${qs}`),
    refetchInterval: 5000,
  });
}

export function useRunFull(runId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["run-full", runId],
    queryFn: () => getJSON<RunFull>(`/v1/runs/${runId}/full`),
    // Conditional fetch — Topology's `?overlay=run:<id>` deep-link mode
    // calls this hook whether or not an id was supplied; without the
    // gate it'd fire `/v1/runs//full`. Default true keeps every other
    // call site (RunDetail, LastRunInner) unchanged.
    enabled: options?.enabled ?? true,
    // Live progress polling — re-fetch every 2s while the run is mid-flight
    // (queued / running). Once the run reaches a terminal state (done /
    // failed / cancelled) the interval drops to false so we don't keep
    // hammering the BFF. ProgressStrip / SubmittedRunPanel rely on this to
    // show the running → done transition without a manual refresh.
    refetchInterval: (query) => {
      const status = (query.state.data as RunFull | undefined)?.run.status;
      if (!status || status === "queued" || status === "running") return 2000;
      return false;
    },
  });
}
