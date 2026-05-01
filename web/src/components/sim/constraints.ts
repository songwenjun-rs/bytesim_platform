/**
 * S5.3 — Business-level constraint checks for the Sim forms.
 *
 * The original "TP×PP×EP×CP > gpu_count" check was a single hard error.
 * Architects need finer-grained guidance — three tiers, all surfaced
 * concurrently (not "first violation wins"):
 *
 *   - error: physically impossible / engine will reject. Submit blocked.
 *   - warn:  technically valid but a known performance footgun. Submit
 *            allowed with a visible caution.
 *   - info:  hint of a more idiomatic configuration. Pure advisory.
 *
 * Knowledge baked in here mirrors what surrogate-svc / engine docs
 * encode about each GPU model. When the surrogate's GPU_PROFILE expands
 * (new SKU, revised NVLink domain), this table moves with it.
 */

import type {
  InferencePresetForm,
  TrainingPresetForm,
} from "./presets";

export type ConstraintLevel = "error" | "warn" | "info";

export type Constraint = {
  level: ConstraintLevel;
  /** Stable id, useful for tests and a11y. */
  id: string;
  /** Sentence rendered to the user (Chinese). */
  msg: string;
  /**
   * S5.4 — optional one-click remedy. Caller passes `onFix` to the
   * panel; clicking the button invokes `onFix(patch)`. The patch is an
   * untyped subset of form fields — the page already knows its own
   * form shape and spreads safely. Errors typically have no single
   * one-shot fix (architect must choose which axis to reduce); only
   * warn/info-level constraints set this.
   */
  fix?: {
    label: string;
    patch: Record<string, unknown>;
  };
};

// Mirrors services/surrogate-svc/app/predict.py:GPU_PROFILE — only the
// fields the frontend uses (HBM ceiling, NVLink scale-up domain).
export type GpuFacts = { hbm_gb: number; nvlink_domain: number };

export const GPU_FACTS: Record<string, GpuFacts> = {
  B200:    { hbm_gb: 192, nvlink_domain: 72 },
  H200:    { hbm_gb: 141, nvlink_domain: 32 },
  GB300:   { hbm_gb: 288, nvlink_domain: 72 },
  MI355X:  { hbm_gb: 288, nvlink_domain: 8 },
  H100:    { hbm_gb: 80,  nvlink_domain: 32 },
  "NPU-910": { hbm_gb: 96, nvlink_domain: 8 },
};

export function gpuFacts(model: string): GpuFacts {
  // Unknown SKU shouldn't crash; fall back to a conservative guess.
  return GPU_FACTS[model] ?? { hbm_gb: 80, nvlink_domain: 8 };
}

// ── Common rules (shared by both modes) ───────────────────────────────────

function checkParallelCapacity(
  form: { TP: number; PP: number; EP: number; CP: number; gpu_count: number },
): Constraint[] {
  const cap = form.TP * form.PP * form.EP * form.CP;
  if (cap > form.gpu_count) {
    return [{
      level: "error", id: "parallel_overcommit",
      msg: `TP×PP×EP×CP = ${cap} 超过 GPU 数 ${form.gpu_count}（引擎将拒绝）`,
    }];
  }
  return [];
}

function checkTpVsNvlinkDomain(
  form: { TP: number; gpu_model: string },
): Constraint[] {
  const facts = gpuFacts(form.gpu_model);
  // TP collectives on NVLink are fast; once TP > nvlink_domain the
  // all-reduce hops onto scale-out fabric and effective tput drops 2-3×.
  if (form.TP > facts.nvlink_domain) {
    return [{
      level: "warn", id: "tp_cross_nvlink",
      msg: `TP=${form.TP} 超过 ${form.gpu_model} NVLink 域 ${facts.nvlink_domain}，跨机 TP 通常掉 2-3× 吞吐`,
      fix: {
        label: `应用 TP=${facts.nvlink_domain}`,
        patch: { TP: facts.nvlink_domain },
      },
    }];
  }
  return [];
}

function checkSeqVsCp(
  form: { seq_len: number; CP: number },
): Constraint[] {
  if (form.seq_len >= 8192 && form.CP < 2) {
    return [{
      level: "info", id: "seq_long_low_cp",
      msg: `seq=${form.seq_len} ≥ 8k 但 CP=${form.CP}，建议 CP ≥ 2 避免单卡 attention 显存压力`,
      fix: { label: "应用 CP=2", patch: { CP: 2 } },
    }];
  }
  return [];
}

// ── Inference-only rules ───────────────────────────────────────────────────

function checkKvWorkingSet(
  form: Pick<InferencePresetForm,
    "avg_active_seqs" | "kv_size_gb_per_seq" | "gpu_count" | "gpu_model">,
): Constraint[] {
  const workingSetGb = form.avg_active_seqs * form.kv_size_gb_per_seq;
  const totalHbmGb = form.gpu_count * gpuFacts(form.gpu_model).hbm_gb;
  // Working set must leave room for weights + activations. Below 80% is
  // safe; 80-100% is squeeze; >100% is impossible.
  if (workingSetGb > totalHbmGb) {
    return [{
      level: "error", id: "kv_exceeds_total_hbm",
      msg: `KV 工作集 ${workingSetGb.toFixed(0)} GB 超过总 HBM ${totalHbmGb.toFixed(0)} GB（无空间放权重）`,
    }];
  }
  if (workingSetGb > totalHbmGb * 0.8) {
    return [{
      level: "warn", id: "kv_near_hbm",
      msg: `KV 工作集 ${workingSetGb.toFixed(0)} GB 占总 HBM ${(workingSetGb / totalHbmGb * 100).toFixed(0)}%，权重 + 激活可能挤占 (>80%)`,
    }];
  }
  return [];
}

function checkPrefixShareVsSlo(
  form: Pick<InferencePresetForm, "prefix_share_ratio" | "slo_ttft_p99_ms">,
): Constraint[] {
  // Chat-level SLO (TTFT ≤ 250ms) usually requires prefix sharing > 0.3
  // so the first-pass attention can hit cached KV. Setting prefix=0 with
  // a chat SLO is a common newcomer error (treats the workload as batch).
  if (form.prefix_share_ratio < 0.1 && form.slo_ttft_p99_ms <= 250) {
    return [{
      level: "warn", id: "prefix_zero_chat_slo",
      msg: `prefix 共享率 ${form.prefix_share_ratio.toFixed(2)} 偏低，但 SLO 设的是 chat 级 (TTFT ≤ ${form.slo_ttft_p99_ms}ms)，可能需要 ≥0.3 才能达成`,
      fix: { label: "应用 prefix=0.5", patch: { prefix_share_ratio: 0.5 } },
    }];
  }
  return [];
}

// ── Training-only rules ────────────────────────────────────────────────────

function checkLargeClusterPp(
  form: Pick<TrainingPresetForm, "PP" | "gpu_count">,
): Constraint[] {
  // PP=1 on a large cluster (≥64 GPU) wastes scale-out bandwidth — TP+DP
  // alone rarely fills it efficiently for dense models.
  if (form.PP === 1 && form.gpu_count >= 64) {
    return [{
      level: "info", id: "large_cluster_no_pp",
      msg: `${form.gpu_count} GPU 但 PP=1，大集群通常 PP ≥ 4 能改善 NVLink 域外通信`,
      fix: { label: "应用 PP=4", patch: { PP: 4 } },
    }];
  }
  return [];
}

// ── Public entry points ────────────────────────────────────────────────────

export function checkInference(form: InferencePresetForm): Constraint[] {
  return [
    ...checkParallelCapacity(form),
    ...checkKvWorkingSet(form),
    ...checkTpVsNvlinkDomain(form),
    ...checkPrefixShareVsSlo(form),
    ...checkSeqVsCp(form),
  ];
}

export function checkTraining(form: TrainingPresetForm): Constraint[] {
  return [
    ...checkParallelCapacity(form),
    ...checkTpVsNvlinkDomain(form),
    ...checkSeqVsCp(form),
    ...checkLargeClusterPp(form),
  ];
}

/** True iff there's any error-level constraint — caller blocks submit. */
export function hasErrors(constraints: Constraint[]): boolean {
  return constraints.some((c) => c.level === "error");
}
