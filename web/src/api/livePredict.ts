/**
 * S5.6 — Live KPI prediction for Sim form fields.
 *
 * As the architect edits the form, this hook quietly POSTs the current
 * (cluster + workload + strategy) shape to BFF's `/v1/engines/predict`
 * (which routes through engine-registry to the surrogate) and returns
 * the predicted KPIs. Closes the "edit → submit → wait → check" loop:
 * the architect sees the rough impact of each tweak in real time and
 * only commits to a real Run when the predicted KPIs look right.
 *
 * Debounce: form edits typically come in bursts (typing a number, then
 * stopping). 300ms covers the common keystroke gap without making the
 * preview feel laggy. React Query's keepPreviousData keeps the last
 * good result on screen during refetch so the card never blanks.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authFetch } from "./client";

export type LivePredictPayload = {
  cluster: {
    gpu_model: string;
    gpu_count: number;
    electricity_usd_per_kwh?: number;
    pue?: number;
  };
  workload: {
    mode: "training" | "inference";
    seq_len: number;
    global_batch?: number;
    activated_params_b: number;
    total_params_b: number;
    quant: string;
    workload_family?: string;
    kvcache_config?: {
      kv_size_gb_per_seq: number;
      prefix_share_ratio: number;
      page_size_kb: number;
      avg_active_seqs: number;
    };
  };
  strategy: {
    TP: number; PP: number; EP: number; CP: number;
    recompute: string;
    overlap: string;
  };
};

export type LivePredictResult = {
  mfu_pct?: number;
  step_ms?: number;
  ttft_ms?: number | null;
  tpot_ms?: number | null;
  peak_kw?: number;
  confidence?: number;
  feasible?: boolean | null;
  notes?: string[];
};

const DEBOUNCE_MS = 300;

/**
 * Returns the latest predicted KPIs for the given payload.
 *
 * `enabled` lets callers disable when prerequisites aren't met (e.g.
 * specs still loading). When disabled, the hook stays inert — no fetch,
 * no debounce, no stale data leak between sessions.
 */
export function useLivePredict(payload: LivePredictPayload, enabled: boolean) {
  // Debounce the payload — re-runs only fire after the user stops
  // editing for DEBOUNCE_MS. We compare via JSON for deep equality
  // since the payload is rebuilt on every render.
  const payloadKey = JSON.stringify(payload);
  const [debouncedKey, setDebouncedKey] = useState(payloadKey);
  useEffect(() => {
    if (payloadKey === debouncedKey) return;
    const t = setTimeout(() => setDebouncedKey(payloadKey), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [payloadKey, debouncedKey]);

  return useQuery({
    queryKey: ["live-predict", debouncedKey],
    queryFn: async (): Promise<LivePredictResult> => {
      const r = await authFetch("/v1/engines/predict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: enabled && !!debouncedKey,
    // Keep previous data so the card doesn't blank during typing bursts.
    placeholderData: (prev) => prev,
    // Conservative retry — engine selector returns 503 on covered=∅,
    // and we don't want to hammer it while the architect is mid-edit.
    retry: false,
    staleTime: 5_000,
  });
}
