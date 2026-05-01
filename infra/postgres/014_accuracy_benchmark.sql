-- ByteSim P3: Simulation accuracy reconciliation + benchmark suite.
--
-- 三件事：
--   1. accuracy_record: 一条预测 vs 实测的对账行（per Run / KPI / engine version)
--   2. benchmark: 命名的可重放测试场景（fixed seed + fixed inputs）
--   3. benchmark_run: benchmark 的一次执行结果（per engine version）
--
-- 这是平台真正的"可信度治理"层：让"surrogate v3.0 在 B200/MoE 上 MAPE 4.2%"这种
-- 主张能被独立重算 + 历史溯源 + 跨引擎对比。

CREATE TABLE bs_accuracy_record (
  id              BIGSERIAL PRIMARY KEY,
  run_id          TEXT REFERENCES bs_run(id) ON DELETE CASCADE,
                                                -- which simulation Run was reconciled
  snapshot_id     TEXT REFERENCES bs_production_snapshot(id),
                                                -- the production snapshot used as ground truth
  engine_name     TEXT NOT NULL,                -- engine that produced the prediction
  engine_version  TEXT NOT NULL,                -- engine version (provenance)
  surrogate_ver   TEXT,                         -- if applicable
  hardware        TEXT,                         -- e.g. "B200"
  model_family    TEXT,                         -- e.g. "MoE"
  kpi             TEXT NOT NULL,                -- mfu_pct | step_ms | peak_kw | ttft_ms | ...
  predicted       NUMERIC NOT NULL,
  measured        NUMERIC NOT NULL,
  abs_error       NUMERIC NOT NULL,             -- |predicted - measured|
  pct_error       NUMERIC NOT NULL,             -- abs_error / measured (0.0 - 1.0)
  reconciled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_by   TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX bs_accuracy_record_engine ON bs_accuracy_record (engine_name, engine_version, kpi);
CREATE INDEX bs_accuracy_record_hw_mf ON bs_accuracy_record (hardware, model_family, kpi);
CREATE INDEX bs_accuracy_record_recent ON bs_accuracy_record (reconciled_at DESC);


CREATE TABLE bs_benchmark (
  id            TEXT PRIMARY KEY,               -- "bench-b200-moe-train"
  name          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN (
                  'training','inference','mixed','failure'
                )),
  description   TEXT,
  inputs        JSONB NOT NULL,                 -- fixed cluster + workload + strategy + seed
  expected      JSONB NOT NULL,                 -- {kpi: {value, tolerance_pct}}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE bs_benchmark_run (
  id              BIGSERIAL PRIMARY KEY,
  benchmark_id    TEXT NOT NULL REFERENCES bs_benchmark(id),
  engine_name     TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  prediction      JSONB NOT NULL,               -- the engine's raw response
  pass            BOOLEAN NOT NULL,             -- all KPIs within expected tolerance
  failures        JSONB NOT NULL DEFAULT '[]'::jsonb,
                                                -- [{kpi, predicted, expected, tolerance_pct, deviation}]
  latency_ms      NUMERIC,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ran_by          TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX bs_benchmark_run_engine ON bs_benchmark_run (benchmark_id, engine_name, engine_version);
CREATE INDEX bs_benchmark_run_recent ON bs_benchmark_run (ran_at DESC);


-- ── Seed: 5 canonical benchmarks covering the analytical surrogate's domain ──

INSERT INTO bs_benchmark (id, name, category, description, inputs, expected) VALUES

  ('bench-b200-moe-train-512', 'B200 · MoE-512B 训练基线',
    'training', '1024 GPU B200 跑 MoE-512B 训练，TP4·PP8·EP8·ZBv2',
    '{
      "cluster":{"gpu_model":"B200","gpu_count":1024,"electricity_usd_per_kwh":0.092,"pue":1.18},
      "workload":{"mode":"training","seq_len":8192,"global_batch":4096,"activated_params_b":8.0,"total_params_b":512.0,"quant":"FP8"},
      "strategy":{"TP":4,"PP":8,"EP":8,"CP":2,"recompute":"selective","overlap":"ZBv2"},
      "seed":42
    }'::jsonb,
    '{
      "mfu_pct":{"value":55,"tolerance_pct":15},
      "feasible":{"value":true,"tolerance_pct":0}
    }'::jsonb),

  ('bench-h200-llm-train-70b', 'H200 · LLM-70B 训练',
    'training', '512 GPU H200 跑 LLM-70B 密集训练，TP8·PP4',
    '{
      "cluster":{"gpu_model":"H200","gpu_count":512,"electricity_usd_per_kwh":0.092,"pue":1.20},
      "workload":{"mode":"training","seq_len":4096,"global_batch":2048,"activated_params_b":70,"total_params_b":70,"quant":"FP8"},
      "strategy":{"TP":8,"PP":4,"EP":1,"CP":1,"recompute":"selective","overlap":"1F1B"},
      "seed":42
    }'::jsonb,
    '{
      "mfu_pct":{"value":48,"tolerance_pct":15},
      "feasible":{"value":true,"tolerance_pct":0}
    }'::jsonb),

  ('bench-b200-llm-infer', 'B200 · LLM-70B 推理 SLO',
    'inference', '64 GPU B200 推理，TTFT < 300ms',
    '{
      "cluster":{"gpu_model":"B200","gpu_count":64,"electricity_usd_per_kwh":0.092,"pue":1.18},
      "workload":{"mode":"inference","seq_len":4096,"global_batch":1,"activated_params_b":70,"total_params_b":70,"quant":"FP8"},
      "strategy":{"TP":4,"PP":2,"EP":1,"CP":1,"recompute":"selective","overlap":"ZBv2"},
      "seed":42
    }'::jsonb,
    '{
      "ttft_ms":{"value":200,"tolerance_pct":50},
      "feasible":{"value":true,"tolerance_pct":0}
    }'::jsonb),

  ('bench-mi355x-ood', 'MI355X · 已知 OOD 场景',
    'failure', 'EP=16 在 MI355X NVLink 域=8 上必然不可行（regression test）',
    '{
      "cluster":{"gpu_model":"MI355X","gpu_count":256,"electricity_usd_per_kwh":0.092,"pue":1.22},
      "workload":{"mode":"training","seq_len":8192,"global_batch":2048,"activated_params_b":8.0,"total_params_b":256,"quant":"FP8"},
      "strategy":{"TP":4,"PP":8,"EP":16,"CP":1,"recompute":"selective","overlap":"ZBv2"},
      "seed":42
    }'::jsonb,
    '{
      "feasible":{"value":false,"tolerance_pct":0}
    }'::jsonb),

  ('bench-power-cap', 'B200 大集群功率上限触发',
    'failure', '4096 张 B200 必触发 900kW 机房限（regression test）',
    '{
      "cluster":{"gpu_model":"B200","gpu_count":4096,"electricity_usd_per_kwh":0.092,"pue":1.18},
      "workload":{"mode":"training","seq_len":8192,"global_batch":4096,"activated_params_b":8.0,"total_params_b":512.0,"quant":"FP8"},
      "strategy":{"TP":4,"PP":8,"EP":8,"CP":2,"recompute":"selective","overlap":"ZBv2"},
      "seed":42
    }'::jsonb,
    '{
      "feasible":{"value":false,"tolerance_pct":0}
    }'::jsonb);
