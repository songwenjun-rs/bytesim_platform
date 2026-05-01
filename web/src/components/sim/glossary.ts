/**
 * S5.2 — Single source of truth for the simulation domain vocabulary.
 *
 * Every Sim form field (and over time: Tuner / Calibration) reads its
 * popover content here. Centralizing the glossary fixes the longstanding
 * "代理 vs surrogate" / "EP vs MoE Expert Parallel" inconsistencies the
 * earlier audit flagged: one term, one definition, one place to update.
 *
 * Each entry follows the same shape:
 *   - title: the canonical Chinese label shown as the popover heading
 *   - english: the English term most commonly seen in papers / code
 *   - desc: 1-2 sentence intuition (NOT the math)
 *   - typical: typical-value examples (helps newcomers calibrate inputs)
 *
 * Keys are stable identifiers (TP / PP / etc.). Adding a new field's
 * popover ⇒ pick a key, drop an entry here, pass `term="<key>"` to
 * SimField. No other plumbing.
 */

export type GlossaryEntry = {
  title: string;
  english?: string;
  desc: string;
  typical?: string;
};

export const GLOSSARY: Record<string, GlossaryEntry> = {
  TP: {
    title: "张量并行 TP",
    english: "Tensor Parallelism",
    desc: "把单个矩阵乘法切分到多张 GPU 上协同完成。属于 intra-layer 并行，对带宽要求最高，跨 NVLink 域会显著掉性能。",
    typical: "TP=4 / 8 是 NVLink 域内常见；> 8 通常意味着跨节点，性能塌方风险高。",
  },
  PP: {
    title: "流水并行 PP",
    english: "Pipeline Parallelism",
    desc: "把模型按层切到不同 GPU，每张卡只跑模型的一个阶段。引入 pipeline bubble（idle）开销，Overlap 算法可显著缓解。",
    typical: "PP=8 / 16 在大模型训练中常见；推理通常 PP=1。",
  },
  EP: {
    title: "专家并行 EP",
    english: "Expert Parallelism",
    desc: "MoE 模型把不同的 expert 分配到不同 GPU 上。会触发 all-to-all 通信，跨 NVLink 域时是常见瓶颈。",
    typical: "Mixtral / DeepSeek-V3 类 EP=8 / 16；dense 模型 EP=1。",
  },
  CP: {
    title: "上下文并行 CP",
    english: "Context Parallelism",
    desc: "把 attention 沿序列维度切分。长上下文（≥ 8k）训练几乎必须，否则 KV cache 在单卡放不下。",
    typical: "seq=8k 时 CP=2 是基线；128k 长上下文常见 CP=4 / 8。",
  },
  recompute: {
    title: "重计算策略",
    english: "Activation Recomputation",
    desc: "前向不保留中间激活，反向时重新计算。selective 只重算贵的算子，full 全部重算（省显存最多但慢）。",
    typical: "selective 是默认；显存吃紧时切 full；推理通常无需。",
  },
  overlap: {
    title: "Overlap 算法",
    english: "Comm-Compute Overlap",
    desc: "把通信（TP all-reduce、PP send/recv）与计算重叠以掩盖延迟。ZBv2/Chimera 是社区前沿，1F1B 是基线。",
    typical: "ZBv2 比 1F1B bubble 减半；Chimera 实验性、置信度低。",
  },
  prefix_share_ratio: {
    title: "Prefix 共享率",
    english: "Prefix Sharing Ratio",
    desc: "推理 KV cache 中可被多 request 共享的前缀占比。0 = 纯批量推理（每个 seq 独立）；0.6+ = 典型 chat / RAG（系统提示词共享）。",
    typical: "Batch 推理 0；chat 0.5–0.8；RAG 0.7–0.9。",
  },
  kv_size_gb_per_seq: {
    title: "单 seq KV 占用",
    english: "KV Cache GB / Sequence",
    desc: "每个并发请求的 KV cache 显存占用。粗估 = 2 × num_layers × hidden_dim × seq_len × bytes_per_element。",
    typical: "70B BF16 8k seq ≈ 0.012 GB；405B 8k ≈ 0.020 GB；128k long ctx ≈ 0.25 GB。",
  },
  page_size_kb: {
    title: "Paged KV 块大小",
    english: "PagedAttention Block Size",
    desc: "vLLM/SGLang 把 KV cache 分页管理的块大小。块越小越省（碎片少）但管理开销越大。",
    typical: "16 是 vLLM 默认；32–64 适合长 seq + 宽 batch。",
  },
  avg_active_seqs: {
    title: "平均活跃 seq 数",
    english: "Avg Active Sequences",
    desc: "稳态下同时在 GPU 上推理的请求数。决定 KV 工作集大小（active_seqs × kv_size_gb_per_seq）。",
    typical: "Chat 100–300；批量 1k+；边缘 < 50。",
  },
  slo_ttft_p99_ms: {
    title: "TTFT p99 SLO",
    english: "Time-To-First-Token p99",
    desc: "首 token 出来的延迟（p99）。surrogate 设硬上限 300ms，超过即视为不可行。",
    typical: "Chat 200ms；批量 600ms+；交互 < 150ms。",
  },
  slo_tpot_ms: {
    title: "TPOT SLO",
    english: "Time-Per-Output-Token",
    desc: "生成阶段每 token 的延迟。直接决定 stream 体感（30 ms ≈ 30 token/s ≈ 阅读速度）。",
    typical: "Chat 30–50ms；批量 80ms+。",
  },
  global_batch: {
    title: "全局 batch",
    english: "Global Batch Size",
    desc: "一步训练消耗的 token 数 = global_batch × seq_len。决定收敛速度与梯度噪声。",
    typical: "405B 4M token / step（gb=4096, seq=8k）；7B 1M token；MoE 调小避免 EP 通信冲洗。",
  },
};

/** Lookup with no fallback — undefined for keys not in the catalog. */
export function getGlossary(term: string | undefined): GlossaryEntry | null {
  if (!term) return null;
  return GLOSSARY[term] ?? null;
}
