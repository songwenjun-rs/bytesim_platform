/**
 * §5 Technical TCO Engine — read API.
 *
 * Tech architects use this to:
 *   - inspect a Run's full cost breakdown (capex, power, cooling, storage,
 *     network, failure penalty)
 *   - browse the TCO ruleset (which $/W/PUE values were assumed)
 *   - compare two designs (delta breakdown)
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { authFetch, getJSON } from "./client";

export type TcoBreakdown = {
  hw_capex_amortized_usd: number;
  power_opex_usd: number;
  cooling_opex_usd: number;
  network_opex_usd: number;
  storage_opex_usd: number;
  /** Subset of storage_opex_usd attributable to KV cache tiers. */
  kvcache_storage_opex_usd?: number;
  failure_penalty_usd: number;
  total_usd: number;
  per_m_token_usd: number | null;
  per_gpu_hour_usd: number | null;
  per_inference_request_usd: number | null;
  rule_versions: Record<string, string>;
  sensitivities: Record<string, number>;
};

export type TcoRule = {
  id: string;
  resource_kind: string;
  vendor_sku: string | null;
  amortization_y: number;
  capex_usd: number | null;
  power_w_idle: number | null;
  power_w_load: number | null;
  pue_assumed: number | null;
  electricity_usd_per_kwh: number;
  storage_usd_per_gb_month: number | null;
  notes: string | null;
};

export type TcoCompareResult = {
  a: TcoBreakdown;
  b: TcoBreakdown;
  delta_b_minus_a: Partial<Record<keyof TcoBreakdown, number | null>>;
};

export const useRunTco = (runId: string) =>
  useQuery({
    queryKey: ["run-tco", runId],
    queryFn: () => getJSON<TcoBreakdown>(`/v1/runs/${runId}/tco`),
    retry: false,
  });

export const useTcoRules = (resourceKind?: string) =>
  useQuery({
    queryKey: ["tco-rules", resourceKind],
    queryFn: () => getJSON<TcoRule[]>(
      `/v1/tco/rules${resourceKind ? `?resource_kind=${resourceKind}` : ""}`
    ),
  });

export function useCompareDesigns() {
  return useMutation({
    mutationFn: async (body: { a: any; b: any }) => {
      const r = await authFetch("/v1/tco/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json() as Promise<TcoCompareResult>;
    },
  });
}
