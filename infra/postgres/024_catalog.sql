-- ByteSim — unified catalog table for hardware parts (CPU/GPU/NIC/SSD) +
-- sim presets (train/infer).
--
-- Before this migration both data sets lived only on the frontend
-- (硬件部件 page / TRAINING_PRESETS / INFERENCE_PRESETS in TS) — fine for
-- a single-user demo, but anyone refreshing in another browser saw stale
-- defaults. With the table multi-client UIs converge.
--
-- Schema is intentionally generic: composite PK (kind, id) + JSONB body,
-- no per-kind columns. The frontend knows the JSONB shape per kind:
--   kind in (cpu, gpu, nic, ssd)         → HwPart   (model/vendor/...)
--   kind in (train_preset, infer_preset) → Preset.form

CREATE TABLE IF NOT EXISTS bs_catalog (
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS bs_catalog_kind_created
  ON bs_catalog (kind, created_at DESC);

-- ── Hardware parts seed ─────────────────────────────────────────────────────

INSERT INTO bs_catalog (kind, id, name, body) VALUES
  ('gpu', 'gpu-nv-gb300', 'GB300 NVL72',
    '{"model":"GB300 NVL72","vendor":"NVIDIA","fp8_tflops":18000,"bf16_tflops":9000,"hbm_gb":288,"mem_bw_tbs":8.0,"tdp_w":1400,"year":2025}'::jsonb),
  ('gpu', 'gpu-nv-b200',  'B200 SXM',
    '{"model":"B200 SXM","vendor":"NVIDIA","fp8_tflops":9000,"bf16_tflops":4500,"hbm_gb":192,"mem_bw_tbs":8.0,"tdp_w":1000,"year":2024}'::jsonb),
  ('gpu', 'gpu-hw-910c',  'Ascend 910C',
    '{"model":"Ascend 910C","vendor":"Huawei","fp8_tflops":0,"bf16_tflops":800,"hbm_gb":128,"mem_bw_tbs":3.2,"tdp_w":550,"year":2024}'::jsonb),
  ('gpu', 'gpu-hw-910b',  'Ascend 910B3',
    '{"model":"Ascend 910B3","vendor":"Huawei","fp8_tflops":0,"bf16_tflops":376,"hbm_gb":64,"mem_bw_tbs":1.6,"tdp_w":400,"year":2024}'::jsonb),

  ('cpu', 'cpu-intel-6980p', 'Xeon 6980P (Granite Rapids)',
    '{"model":"Xeon 6980P (Granite Rapids)","vendor":"Intel","cores":128,"base_ghz":2.0,"boost_ghz":3.9,"tdp_w":500,"mem_channels":12}'::jsonb),
  ('cpu', 'cpu-intel-6960p', 'Xeon 6960P (Granite Rapids)',
    '{"model":"Xeon 6960P (Granite Rapids)","vendor":"Intel","cores":72,"base_ghz":2.7,"boost_ghz":3.8,"tdp_w":500,"mem_channels":12}'::jsonb),
  ('cpu', 'cpu-amd-9755',    'EPYC 9755 (Turin)',
    '{"model":"EPYC 9755 (Turin)","vendor":"AMD","cores":128,"base_ghz":2.7,"boost_ghz":4.1,"tdp_w":500,"mem_channels":12}'::jsonb),
  ('cpu', 'cpu-amd-9965',    'EPYC 9965 (Turin Dense)',
    '{"model":"EPYC 9965 (Turin Dense)","vendor":"AMD","cores":192,"base_ghz":2.25,"boost_ghz":3.7,"tdp_w":500,"mem_channels":12}'::jsonb),

  ('nic', 'nic-nv-cx8',    'ConnectX-8',
    '{"model":"ConnectX-8","vendor":"NVIDIA","bw_gbps":800,"ports":1,"protocol":"IB XDR / 800GbE","tdp_w":30}'::jsonb),
  ('nic', 'nic-nv-bf3',    'BlueField-3 DPU',
    '{"model":"BlueField-3 DPU","vendor":"NVIDIA","bw_gbps":400,"ports":2,"protocol":"400GbE / IB NDR","tdp_w":75}'::jsonb),
  ('nic', 'nic-bcm-thor2', 'Thor 2 (BCM57608)',
    '{"model":"Thor 2 (BCM57608)","vendor":"Broadcom","bw_gbps":400,"ports":1,"protocol":"400GbE RoCEv2","tdp_w":30}'::jsonb),
  ('nic', 'nic-bcm-ps1750','PS1750 800G PCIe Gen5',
    '{"model":"PS1750 800G PCIe Gen5","vendor":"Broadcom","bw_gbps":800,"ports":1,"protocol":"800GbE RoCEv2","tdp_w":38}'::jsonb),

  ('ssd', 'ssd-sam-pm9d3a-30', 'PM9D3a 30.72TB',
    '{"model":"PM9D3a 30.72TB","vendor":"Samsung","capacity_tb":30.72,"interface":"NVMe Gen5 x4","read_gbs":14.8,"write_gbs":11.0}'::jsonb),
  ('ssd', 'ssd-sam-pm9d3a-15', 'PM9D3a 15.36TB',
    '{"model":"PM9D3a 15.36TB","vendor":"Samsung","capacity_tb":15.36,"interface":"NVMe Gen5 x4","read_gbs":14.8,"write_gbs":11.0}'::jsonb),
  ('ssd', 'ssd-sam-bm1743',    'BM1743 QLC 122TB',
    '{"model":"BM1743 QLC 122TB","vendor":"Samsung","capacity_tb":122.88,"interface":"NVMe Gen5 x4","read_gbs":7.5,"write_gbs":3.0}'::jsonb),
  ('ssd', 'ssd-sam-pm1743',    'PM1743 15.36TB',
    '{"model":"PM1743 15.36TB","vendor":"Samsung","capacity_tb":15.36,"interface":"NVMe Gen5 x4","read_gbs":13.0,"write_gbs":6.6}'::jsonb)
ON CONFLICT (kind, id) DO NOTHING;

-- ── Training presets seed ──────────────────────────────────────────────────

INSERT INTO bs_catalog (kind, id, name, body) VALUES
  ('train_preset', 'llama31-405b-pretrain-256b200',
    'Llama-3.1-405B 全量预训练',
    '{"desc":"256× B200 · TP=8 PP=8 · DP=4 · FP8 · 全 256 卡占满","title":"训练仿真 · Llama-3.1-405B 预训练 / 256× B200","gpu_model":"B200","gpu_count":256,"electricity_usd_per_kwh":0.092,"pue":1.18,"activated_params_b":405,"total_params_b":405,"seq_len":8192,"global_batch":4096,"quant":"FP8","TP":8,"PP":8,"EP":1,"CP":1,"recompute":"selective","overlap":"1F1B"}'::jsonb),
  ('train_preset', 'llama31-70b-pretrain-64b200',
    'Llama-3.1-70B 预训练（子集）',
    '{"desc":"64× B200 子集 · TP=4 PP=2 · DP=8 · FP8","title":"训练仿真 · Llama-3.1-70B / 64× B200","gpu_model":"B200","gpu_count":64,"electricity_usd_per_kwh":0.092,"pue":1.18,"activated_params_b":70,"total_params_b":70,"seq_len":8192,"global_batch":2048,"quant":"FP8","TP":4,"PP":2,"EP":1,"CP":1,"recompute":"selective","overlap":"1F1B"}'::jsonb),
  ('train_preset', 'llama31-8b-finetune-8b200',
    'Llama-3.1-8B 单机微调',
    '{"desc":"8× B200 单机 · TP=2 · DP=4 · BF16 · 最小参考","title":"训练仿真 · Llama-3.1-8B SFT / 8× B200","gpu_model":"B200","gpu_count":8,"electricity_usd_per_kwh":0.092,"pue":1.18,"activated_params_b":8,"total_params_b":8,"seq_len":8192,"global_batch":256,"quant":"BF16","TP":2,"PP":1,"EP":1,"CP":1,"recompute":"selective","overlap":"1F1B"}'::jsonb),
  ('train_preset', 'llama31-405b-pretrain-512b200',
    'Llama-3.1-405B 大规模预训练',
    '{"desc":"512× B200 · TP=16 PP=8 · DP=4 · FP8 · 接近 Llama 3.1 paper","title":"训练仿真 · Llama-3.1-405B 大规模 / 512× B200","gpu_model":"B200","gpu_count":512,"electricity_usd_per_kwh":0.092,"pue":1.18,"activated_params_b":405,"total_params_b":405,"seq_len":8192,"global_batch":8192,"quant":"FP8","TP":16,"PP":8,"EP":1,"CP":1,"recompute":"selective","overlap":"1F1B"}'::jsonb)
ON CONFLICT (kind, id) DO NOTHING;

-- ── Inference presets seed ─────────────────────────────────────────────────

INSERT INTO bs_catalog (kind, id, name, body) VALUES
  ('infer_preset', 'llama31-8b-online-8h200',
    'Llama-3.1-8B 在线服务',
    '{"desc":"8× H200 单机 · TP=8 · 高并发 · 低延迟 chatbot","title":"推理仿真 · Llama-3.1-8B / 8× H200","gpu_model":"H200","gpu_count":8,"electricity_usd_per_kwh":0.092,"pue":1.20,"activated_params_b":8,"total_params_b":8,"seq_len":8192,"quant":"FP8","kv_size_gb_per_seq":0.10,"prefix_share_ratio":0.6,"page_size_kb":16,"avg_active_seqs":512,"TP":8,"PP":1,"EP":1,"CP":1,"slo_ttft_p99_ms":100,"slo_tpot_ms":25}'::jsonb),
  ('infer_preset', 'llama31-70b-online-16h200',
    'Llama-3.1-70B 在线服务',
    '{"desc":"16× H200 (2 服务器) · TP=8 PP=2 · 中等规模量产","title":"推理仿真 · Llama-3.1-70B / 16× H200","gpu_model":"H200","gpu_count":16,"electricity_usd_per_kwh":0.092,"pue":1.20,"activated_params_b":70,"total_params_b":70,"seq_len":8192,"quant":"FP8","kv_size_gb_per_seq":0.30,"prefix_share_ratio":0.5,"page_size_kb":16,"avg_active_seqs":256,"TP":8,"PP":2,"EP":1,"CP":1,"slo_ttft_p99_ms":250,"slo_tpot_ms":40}'::jsonb),
  ('infer_preset', 'llama31-405b-online-64h200',
    'Llama-3.1-405B 在线服务',
    '{"desc":"64× H200 (全 C02) · TP=8 PP=8 · 旗舰 dense","title":"推理仿真 · Llama-3.1-405B / 64× H200","gpu_model":"H200","gpu_count":64,"electricity_usd_per_kwh":0.092,"pue":1.20,"activated_params_b":405,"total_params_b":405,"seq_len":8192,"quant":"FP8","kv_size_gb_per_seq":0.80,"prefix_share_ratio":0.4,"page_size_kb":32,"avg_active_seqs":96,"TP":8,"PP":8,"EP":1,"CP":1,"slo_ttft_p99_ms":600,"slo_tpot_ms":60}'::jsonb),
  ('infer_preset', 'deepseek-v3-671b-moe',
    'DeepSeek-V3 671B (MoE) 推理',
    '{"desc":"64× H200 (全 C02) · 激活 37B / 总 671B · MLA · TP=8 PP=4 EP=2","title":"推理仿真 · DeepSeek-V3 671B / 64× H200","gpu_model":"H200","gpu_count":64,"electricity_usd_per_kwh":0.092,"pue":1.20,"activated_params_b":37,"total_params_b":671,"seq_len":8192,"quant":"FP8","kv_size_gb_per_seq":0.040,"prefix_share_ratio":0.7,"page_size_kb":16,"avg_active_seqs":512,"TP":8,"PP":4,"EP":2,"CP":1,"slo_ttft_p99_ms":200,"slo_tpot_ms":30}'::jsonb),
  ('infer_preset', 'mixtral-8x7b-moe',
    'Mixtral 8×7B (MoE) 在线服务',
    '{"desc":"8× H200 单机 · 激活 13B / 总 47B · TP=8 EP=2","title":"推理仿真 · Mixtral 8×7B / 8× H200","gpu_model":"H200","gpu_count":8,"electricity_usd_per_kwh":0.092,"pue":1.20,"activated_params_b":13,"total_params_b":47,"seq_len":8192,"quant":"FP8","kv_size_gb_per_seq":0.080,"prefix_share_ratio":0.5,"page_size_kb":16,"avg_active_seqs":256,"TP":8,"PP":1,"EP":2,"CP":1,"slo_ttft_p99_ms":150,"slo_tpot_ms":30}'::jsonb)
ON CONFLICT (kind, id) DO NOTHING;
