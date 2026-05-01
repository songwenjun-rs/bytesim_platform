-- ByteSim P-Domain-1: KVCache topology + workload kvcache hints + TCO breakdown
--
-- 推理经济学的关键变量是 KV 缓存命中率与分层放置 — 不建模这一层，平台
-- 对 inference scenario 的预测只能反映训练侧的 MFU，命中率 60→80% 单卡
-- QPS 翻倍的关键差异看不见。
--
-- 本迁移做三件事：
--   1) 新表 bs_kvcache_topology — 描述 cluster 上的 KV 缓存层级
--      （HBM → DRAM → CXL → NVMe），单价、容量、带宽
--   2) 给 bs_tco_breakdown 加 kvcache_storage_opex_usd 字段（从 storage 总
--      数中拆出，便于对比 KV 存储成本）
--   3) workload_class.body JSONB 加 kvcache 假设（kv_size_gb_per_seq /
--      prefix_share_ratio / page_size_kb），更新现有推理种子
--
-- 引擎插件协议：mode=inference 且 workload 含 kvcache_config 的预测
-- 必须在 PredictResponse 里返回 kv_hit_rate / cache_pressure_pct（见
-- services/surrogate-svc/app/predict.py）。

-- ── 1) KVCache topology ────────────────────────────────────────────────

CREATE TABLE bs_kvcache_topology (
  id                  TEXT PRIMARY KEY,                 -- "kvtop-default-b200"
  cluster_id          TEXT,                             -- 留空 = 全局默认
  tier                TEXT NOT NULL CHECK (tier IN ('HBM','DRAM','CXL','NVMe')),
  capacity_gb         NUMERIC NOT NULL,                 -- 单 GPU 视角的可用容量
  bw_gbps             NUMERIC NOT NULL,                 -- 该层到 GPU 的有效带宽
  usd_per_gb_month    NUMERIC NOT NULL DEFAULT 0,       -- 摊销单价（CapEx + 部分 OpEx）
  evict_policy        TEXT NOT NULL DEFAULT 'lru'
                      CHECK (evict_policy IN ('lru','lfu','arc','fifo')),
  attrs               JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                        -- {paged: bool, page_size_kb: int, ...}
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_kvcache_topology_cluster ON bs_kvcache_topology (cluster_id, tier);

-- 默认 4 层种子（和 B200 配套，可被 cluster-specific 覆盖）
INSERT INTO bs_kvcache_topology (id, cluster_id, tier, capacity_gb, bw_gbps, usd_per_gb_month, evict_policy, attrs, notes) VALUES
  ('kvtop-default-hbm',  NULL, 'HBM',  180,  3000, 0.000,  'lru',
    '{"paged":true,"page_size_kb":16}'::jsonb,
    'B200 HBM3e 单卡可用容量；价格已计入 GPU CapEx，本字段记 0'),
  ('kvtop-default-dram', NULL, 'DRAM', 1024,  100, 0.003,  'lru',
    '{"paged":true,"page_size_kb":16}'::jsonb,
    '主机 DRAM；spill 第一层，PCIe 带宽限制'),
  ('kvtop-default-cxl',  NULL, 'CXL',  4096,   50, 0.012,  'arc',
    '{"paged":true,"page_size_kb":64,"controller":"Astera/Leo"}'::jsonb,
    'CXL.mem 池；中等延迟，块大获益于 prefix 共享'),
  ('kvtop-default-nvme', NULL, 'NVMe', 32768,  12, 0.020,  'fifo',
    '{"paged":false,"controller":"Generic"}'::jsonb,
    '本地 NVMe；最深一级 spill，主要承接 cold prefix');

-- ── 2) TCO breakdown 增列 ──────────────────────────────────────────────

-- 默认 0 保证现有 run 历史数据兼容；compute_tco 新跑会填充实际值。
ALTER TABLE bs_tco_breakdown
  ADD COLUMN kvcache_storage_opex_usd NUMERIC NOT NULL DEFAULT 0;

-- ── 3) 更新 workload_class 推理种子，加 kvcache_config ──────────────────

-- jsonb_set 在 body 里追加 kvcache_config 子对象。
UPDATE bs_workload_class
SET body = jsonb_set(body, '{kvcache_config}',
  '{"kv_size_gb_per_seq":0.020,"prefix_share_ratio":0.45,"page_size_kb":16,"avg_active_seqs":256}'::jsonb)
WHERE id = 'wlc-infer-llama70b';

-- batch_eval 推理：低 prefix share（每条样本独立）
UPDATE bs_workload_class
SET body = jsonb_set(body, '{kvcache_config}',
  '{"kv_size_gb_per_seq":0.012,"prefix_share_ratio":0.05,"page_size_kb":16,"avg_active_seqs":1024}'::jsonb)
WHERE id = 'wlc-batch-eval';

-- ── 4) 新增推理种子，带 chat 模板（高 prefix share） ──────────────────────

INSERT INTO bs_workload_class (id, project_id, name, team_id, kind, sla, body, arrival) VALUES
  ('wlc-infer-chat-72b', 'p_default', 'Chat-72B 在线推理（高 prefix）', 'rec-search',
    'inference',
    '{"ttft_p99_ms":250,"decode_p99_ms":40}'::jsonb,
    '{"model_family":"LLM","activated_params_b":72,"total_params_b":72,"seq_len":8192,"quant":"FP8",
      "kvcache_config":{"kv_size_gb_per_seq":0.024,"prefix_share_ratio":0.78,"page_size_kb":16,"avg_active_seqs":512}}'::jsonb,
    '{"pattern":"poisson","rate":80.0}'::jsonb);
