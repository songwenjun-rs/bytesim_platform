-- Slice-15: a second project so the project switcher in the UI has somewhere
-- to switch to. Mirrors the same shape as p_default but with totally different
-- data — no shared spec / run IDs, so cross-project leaks are obvious.

INSERT INTO bs_project (id, name, env) VALUES
  ('p_lab', 'preview-lab-2027q1', 'staging');

INSERT INTO bs_spec (id, kind, name, project_id, latest_hash) VALUES
  ('hwspec_lab_a',     'hwspec',   'lab-singapore-a',     'p_lab', '0000000000000000000000000000000000000a04'),
  ('model_lab_dense',  'model',    'dense-72b',           'p_lab', '0000000000000000000000000000000000000a02'),
  ('strategy_lab',     'strategy', 'baseline-no-MoE',     'p_lab', '0000000000000000000000000000000000000a52'),
  ('workload_lab_inf', 'workload', 'inference-72B',       'p_lab', '0000000000000000000000000000000000000a91');

INSERT INTO bs_spec_version (hash, spec_id, parent_hash, version_tag, body) VALUES
  ('0000000000000000000000000000000000000a04', 'hwspec_lab_a', NULL, 'v1',
    '{"cluster":"H200 NVL × 8 · 256 GPU","gpu":"Hopper H200 · HBM3e 141 GB · 989 TF (BF16)","interconnect":{"scale_up":"NVLink-4 · 900 GB/s","scale_out":"InfiniBand NDR · 400 Gbps"},"power":{"peak_kw":210,"pue":1.25},"server_templates":[{"id":"tpl-gpu","name":"GPU 训练节点","kind":"gpu","gpu_model":"H200","gpu_count":8,"nic":"CX-7","tdp_kw":6.5,"cpu_model":"Intel Xeon Platinum 8480+","cpu_sockets":2,"ram_gb":1024,"storage_tb":15,"gpu_mem_gb":141,"form_factor":"HGX 8-GPU 4U"}],"datacenter":{"id":"sg-lab-a","name":"新加坡 Lab A","clusters":[{"id":"cl-sg-a","name":"实验集群","purpose":"实验","topology":"spine-leaf","interconnect":"InfiniBand NDR · 400 Gbps","pue":1.25,"racks":[{"id":"R01","name":"实验机柜 1","status":"ok","rack_u":42,"rated_power_kw":12,"cooling":"风冷","tor_switch":"Mellanox SN4600","location":"SG-A-1","servers":[{"id":"srv-l01","name":"H200 实验节点","gpu_model":"H200","gpu_count":8,"nic":"CX-7","kind":"gpu","status":"ok","tdp_kw":6.5,"cpu_model":"Intel Xeon Platinum 8480+","cpu_sockets":2,"ram_gb":1024,"storage_tb":15,"gpu_mem_gb":141,"form_factor":"HGX 8-GPU 4U"}]}],"scale_up_domains":[{"id":"sud-srv-l01","name":"NVLink-srv-l01","kind":"nvlink","bandwidth_gbps":900,"members":[{"server_id":"srv-l01"}]}]}]}}'::jsonb),
  ('0000000000000000000000000000000000000a02', 'model_lab_dense', NULL, 'v1',
    '{"family":"Dense Transformer","params":"72B","layers":80,"hidden":8192}'::jsonb),
  ('0000000000000000000000000000000000000a52', 'strategy_lab', NULL, 'v1',
    '{"TP":[2,4],"PP":[1,2],"recompute":["selective"]}'::jsonb),
  ('0000000000000000000000000000000000000a91', 'workload_lab_inf', NULL, 'v1',
    '{"mode":"inference","qps_target":120,"seq_len":4096}'::jsonb);

INSERT INTO bs_run (id, project_id, kind, title, status, progress_pct, inputs_hash, surrogate_ver, confidence, parent_run_id, started_at, finished_at, kpis, artifacts, boundaries, created_by) VALUES
  ('lab-001', 'p_lab', 'infer', 'Dense-72B 推理基线', 'done', NULL,
    '00000000000000000000000000000000lab00001', 'v2.4', 0.92, NULL,
    NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days' + INTERVAL '40 minutes',
    '{"mfu_pct":42.0,"qps":118,"ttft_p99_ms":210}'::jsonb,
    '[]'::jsonb,
    '[{"level":"info","text":"staging 项目 · 仅用于演示多项目隔离"}]'::jsonb,
    'songwenjun'),
  ('lab-002', 'p_lab', 'infer', 'Dense-72B FP8 加速', 'queued', NULL,
    '00000000000000000000000000000000lab00002', 'v2.4', 0.81, 'lab-001',
    NULL, NULL, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'lihaoran');

INSERT INTO bs_run_uses_spec (run_id, spec_hash) VALUES
  ('lab-001', '0000000000000000000000000000000000000a04'),
  ('lab-001', '0000000000000000000000000000000000000a02'),
  ('lab-001', '0000000000000000000000000000000000000a52'),
  ('lab-001', '0000000000000000000000000000000000000a91'),
  ('lab-002', '0000000000000000000000000000000000000a04'),
  ('lab-002', '0000000000000000000000000000000000000a02'),
  ('lab-002', '0000000000000000000000000000000000000a52'),
  ('lab-002', '0000000000000000000000000000000000000a91');
