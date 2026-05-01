/**
 * §2 Engine registry — read-only view of which simulation engines are
 * currently registered (RFC-001 v2). Tech architects use this to:
 *   - confirm which engine version produced a given Run (via _provenance)
 *   - see whether a "faster but coarser" engine option is available for
 *     interactive Tuner exploration
 *   - read each engine's coverage_envelope so they know what (workload ×
 *     hw × strategy) tuples it actually supports
 */
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "./client";

export type Fidelity = "analytical" | "hybrid" | "cycle-accurate";

export type CoverageEnvelope = {
  workload_families: string[];
  parallelism: {
    TP: [number, number]; PP: [number, number];
    EP: [number, number]; CP: [number, number];
    recompute: string[];
    overlap: string[];
  };
  hardware: {
    gpu_models: string[];
    fabric: string[];
    scale_gpus: [number, number];
  };
  quant: string[];
  modes: string[];
};

export type Engine = {
  name: string;
  version: string;
  fidelity: Fidelity;
  sla_p99_ms: number;
  endpoint: string;
  predict_path: string;
  coverage_envelope: CoverageEnvelope;
  kpi_outputs: string[];
  calibration: {
    profile_runs?: string[];
    mape_pct?: Record<string, number>;
  };
  status: "active" | "deprecated" | "disabled";
  registered_at: string;
  last_seen_at?: string | null;
  notes?: string | null;
};

export type Provenance = {
  engine: string;
  version: string;
  fidelity: Fidelity;
  confidence: number | null;
  coverage_status: "in_dist" | "extrapolated";
  latency_ms: number;
  selected_by: "auto" | "engine_preference";
};

export const useEngines = (filters?: { status?: string }) =>
  useQuery({
    queryKey: ["engines", filters],
    queryFn: () => {
      const qs = new URLSearchParams(
        Object.entries(filters ?? {}).filter(([, v]) => v) as [string, string][]
      ).toString();
      return getJSON<Engine[]>(`/v1/engines${qs ? `?${qs}` : ""}`);
    },
  });

export const useEngine = (name: string) =>
  useQuery({
    queryKey: ["engine", name],
    queryFn: () => getJSON<Engine>(`/v1/engines/${name}`),
    enabled: !!name,
  });
