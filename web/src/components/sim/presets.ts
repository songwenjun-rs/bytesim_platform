/**
 * S5.1 — Workload presets for the Sim pages.
 *
 * The Sim form has ~15 fields. Architects iterate against a handful of
 * canonical scenarios; without presets they re-key the same numbers each
 * session. Each preset is a fully-formed scenario the user can drop in
 * and tweak from. Naming follows industry shorthand so a glance tells
 * the architect "this is the chat MoE" or "this is the long-context".
 *
 * Form shape mirrors InferenceSim/TrainingSim local state. We do NOT
 * import their state types directly — keep this file the single source
 * of truth for canonical scenarios. Pages spread the preset over their
 * existing state and filter unknown keys naturally.
 */

export type InferencePresetForm = {
  title: string;
  gpu_model: "B200" | "H200" | "GB300" | "MI355X" | "H100" | "NPU-910";
  gpu_count: number;
  electricity_usd_per_kwh: number;
  pue: number;
  activated_params_b: number;
  total_params_b: number;
  seq_len: number;
  quant: "FP8" | "BF16";
  kv_size_gb_per_seq: number;
  prefix_share_ratio: number;
  page_size_kb: number;
  avg_active_seqs: number;
  TP: number;
  PP: number;
  EP: number;
  CP: number;
  slo_ttft_p99_ms: number;
  slo_tpot_ms: number;
};

export type TrainingPresetForm = {
  title: string;
  gpu_model: "B200" | "H200" | "GB300" | "MI355X" | "H100" | "NPU-910";
  gpu_count: number;
  electricity_usd_per_kwh: number;
  pue: number;
  activated_params_b: number;
  total_params_b: number;
  seq_len: number;
  global_batch: number;
  quant: "FP8" | "BF16";
  TP: number;
  PP: number;
  EP: number;
  CP: number;
  recompute: "selective" | "full";
  overlap: "1F1B" | "ZB" | "ZBv2" | "ring_compress" | "Chimera";
};

export type Preset<F> = {
  /** Stable id for keyed selection + URL state. */
  id: string;
  /** Short human label (≤ 20 chars). */
  name: string;
  /** One-sentence "when to pick this" hint shown next to the dropdown. */
  desc: string;
  /** The form fields this preset supplies. */
  form: F;
};

// ── Inference ──────────────────────────────────────────────────────────────

// Built-in inference presets — typical open-source models of 2025, sized to
// fit C02 inference cluster (64× H200 / 8 servers). Three dense Llama-3.1
// presets cover edge → mid → premium; DeepSeek-V3 + Mixtral cover MoE.
export const INFERENCE_PRESETS: Preset<InferencePresetForm>[] = [
  {
    id: "llama31-8b-online-8h200",
    name: "Llama-3.1-8B 在线服务",
    desc: "8× H200 单机 · TP=8 · 高并发 · 低延迟 chatbot",
    form: {
      title: "推理仿真 · Llama-3.1-8B / 8× H200",
      gpu_model: "H200", gpu_count: 8,
      electricity_usd_per_kwh: 0.092, pue: 1.20,
      activated_params_b: 8, total_params_b: 8,
      seq_len: 8192, quant: "FP8",
      kv_size_gb_per_seq: 0.10, prefix_share_ratio: 0.6,
      page_size_kb: 16, avg_active_seqs: 512,
      TP: 8, PP: 1, EP: 1, CP: 1,
      slo_ttft_p99_ms: 100, slo_tpot_ms: 25,
    },
  },
  {
    id: "llama31-70b-online-16h200",
    name: "Llama-3.1-70B 在线服务",
    desc: "16× H200 (2 服务器) · TP=8 PP=2 · 中等规模量产",
    form: {
      title: "推理仿真 · Llama-3.1-70B / 16× H200",
      gpu_model: "H200", gpu_count: 16,
      electricity_usd_per_kwh: 0.092, pue: 1.20,
      activated_params_b: 70, total_params_b: 70,
      seq_len: 8192, quant: "FP8",
      kv_size_gb_per_seq: 0.30, prefix_share_ratio: 0.5,
      page_size_kb: 16, avg_active_seqs: 256,
      TP: 8, PP: 2, EP: 1, CP: 1,
      slo_ttft_p99_ms: 250, slo_tpot_ms: 40,
    },
  },
  {
    id: "llama31-405b-online-64h200",
    name: "Llama-3.1-405B 在线服务",
    desc: "64× H200 (全 C02) · TP=8 PP=8 · 旗舰 dense",
    form: {
      title: "推理仿真 · Llama-3.1-405B / 64× H200",
      gpu_model: "H200", gpu_count: 64,
      electricity_usd_per_kwh: 0.092, pue: 1.20,
      activated_params_b: 405, total_params_b: 405,
      seq_len: 8192, quant: "FP8",
      kv_size_gb_per_seq: 0.80, prefix_share_ratio: 0.4,
      page_size_kb: 32, avg_active_seqs: 96,
      TP: 8, PP: 8, EP: 1, CP: 1,
      slo_ttft_p99_ms: 600, slo_tpot_ms: 60,
    },
  },
  {
    id: "deepseek-v3-671b-moe",
    name: "DeepSeek-V3 671B (MoE) 推理",
    desc: "64× H200 (全 C02) · 激活 37B / 总 671B · MLA · TP=8 PP=4 EP=2",
    form: {
      title: "推理仿真 · DeepSeek-V3 671B / 64× H200",
      gpu_model: "H200", gpu_count: 64,
      electricity_usd_per_kwh: 0.092, pue: 1.20,
      activated_params_b: 37, total_params_b: 671,
      seq_len: 8192, quant: "FP8",
      kv_size_gb_per_seq: 0.040, prefix_share_ratio: 0.7,
      page_size_kb: 16, avg_active_seqs: 512,
      TP: 8, PP: 4, EP: 2, CP: 1,
      slo_ttft_p99_ms: 200, slo_tpot_ms: 30,
    },
  },
  {
    id: "mixtral-8x7b-moe",
    name: "Mixtral 8×7B (MoE) 在线服务",
    desc: "8× H200 单机 MoE · 激活 13B / 总 47B · TP=4 EP=2",
    form: {
      title: "推理仿真 · Mixtral 8×7B / 8× H200",
      gpu_model: "H200", gpu_count: 8,
      electricity_usd_per_kwh: 0.092, pue: 1.20,
      activated_params_b: 13, total_params_b: 47,
      seq_len: 8192, quant: "FP8",
      kv_size_gb_per_seq: 0.080, prefix_share_ratio: 0.5,
      page_size_kb: 16, avg_active_seqs: 256,
      TP: 4, PP: 1, EP: 2, CP: 1,
      slo_ttft_p99_ms: 150, slo_tpot_ms: 30,
    },
  },
];

// ── Training ───────────────────────────────────────────────────────────────

// Built-in training presets — all Llama-3.1 dense family, sized to fit
// Astra-sim's envelope (TP[1,16] PP[1,8] EP=1 CP=1 selective 1F1B FP8/BF16)
// and the seeded 256× B200 main training cluster + 64× H200 inference cluster.
export const TRAINING_PRESETS: Preset<TrainingPresetForm>[] = [
  {
    id: "llama31-405b-pretrain-256b200",
    name: "Llama-3.1-405B 全量预训练",
    desc: "256× B200 · TP=8 PP=8 · DP=4 · FP8 · 全 256 卡占满",
    form: {
      title: "训练仿真 · Llama-3.1-405B 预训练 / 256× B200",
      gpu_model: "B200", gpu_count: 256,
      electricity_usd_per_kwh: 0.092, pue: 1.18,
      activated_params_b: 405, total_params_b: 405,
      seq_len: 8192, global_batch: 4096, quant: "FP8",
      TP: 8, PP: 8, EP: 1, CP: 1,
      recompute: "selective", overlap: "1F1B",
    },
  },
  {
    id: "llama31-70b-pretrain-64b200",
    name: "Llama-3.1-70B 预训练（子集）",
    desc: "64× B200 子集 · TP=4 PP=2 · DP=8 · FP8",
    form: {
      title: "训练仿真 · Llama-3.1-70B / 64× B200",
      gpu_model: "B200", gpu_count: 64,
      electricity_usd_per_kwh: 0.092, pue: 1.18,
      activated_params_b: 70, total_params_b: 70,
      seq_len: 8192, global_batch: 2048, quant: "FP8",
      TP: 4, PP: 2, EP: 1, CP: 1,
      recompute: "selective", overlap: "1F1B",
    },
  },
  {
    id: "llama31-8b-finetune-8b200",
    name: "Llama-3.1-8B 单机微调",
    desc: "8× B200 单机 · TP=2 · DP=4 · BF16 · 最小参考",
    form: {
      title: "训练仿真 · Llama-3.1-8B SFT / 8× B200",
      gpu_model: "B200", gpu_count: 8,
      electricity_usd_per_kwh: 0.092, pue: 1.18,
      activated_params_b: 8, total_params_b: 8,
      seq_len: 8192, global_batch: 256, quant: "BF16",
      TP: 2, PP: 1, EP: 1, CP: 1,
      recompute: "selective", overlap: "1F1B",
    },
  },
  {
    id: "llama31-405b-pretrain-512b200",
    name: "Llama-3.1-405B 大规模预训练",
    desc: "512× B200 · TP=16 PP=8 · DP=4 · FP8 · 接近 Llama 3.1 paper",
    form: {
      title: "训练仿真 · Llama-3.1-405B 大规模 / 512× B200",
      gpu_model: "B200", gpu_count: 512,
      electricity_usd_per_kwh: 0.092, pue: 1.18,
      activated_params_b: 405, total_params_b: 405,
      seq_len: 8192, global_batch: 8192, quant: "FP8",
      TP: 16, PP: 8, EP: 1, CP: 1,
      recompute: "selective", overlap: "1F1B",
    },
  },
];
