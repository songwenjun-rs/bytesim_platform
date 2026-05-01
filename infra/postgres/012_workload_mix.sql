-- ByteSim §4: Workload classes + mixes — multi-tenant workload modeling.
--
-- Why two tables (class vs mix):
--   * Class: long-lived "what kind of work is this" — a team's pretraining
--     spec, a specific inference SLA, a batch eval recipe. Versioned by hash
--     when its body changes; same class can be used by many scenarios.
--   * Mix: a combination of classes with weights + time windows. A mix says
--     "in this scenario, 70% of resources go to train-moe-256e, 30% to
--     inference-llama70b, except weekends when ratio flips".
--
-- Both tables are scenario inputs (§3). Mix is also produced by the
-- mix-fitter consumer reading approved k8s-event snapshots (§6 ↔ §4 wiring).

CREATE TABLE bs_workload_class (
  id            TEXT PRIMARY KEY,                 -- "wlc-train-moe-256e"
  project_id    TEXT NOT NULL REFERENCES bs_project(id),
  name          TEXT NOT NULL,
  team_id       TEXT,                             -- 用于成本归属（不是分摊）
  kind          TEXT NOT NULL CHECK (kind IN (
                  'pretraining','sft','rlhf','inference','batch_infer','eval'
                )),
  sla           JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                  -- {ttft_p99_ms, decode_p99_ms, mfu_target_pct}
  body          JSONB NOT NULL,                   -- workload spec (model, seq_len, batch, …)
  arrival       JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                  -- {pattern: poisson|trace|constant, rate, trace_uri}
  source        TEXT NOT NULL DEFAULT 'hand_curated'
                CHECK (source IN ('hand_curated','imported_from_snapshot')),
  fitted_from_snapshot TEXT REFERENCES bs_production_snapshot(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_workload_class_project ON bs_workload_class (project_id, kind);

CREATE TABLE bs_workload_mix (
  id          TEXT PRIMARY KEY,                   -- "mix-bj1-train-heavy"
  project_id  TEXT NOT NULL REFERENCES bs_project(id),
  name        TEXT NOT NULL,
  members     JSONB NOT NULL,
                                                  -- [{class_id, weight, time_window: cron|always}]
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_workload_mix_project ON bs_workload_mix (project_id);

-- Demo seed: 3 classes + 1 mix referencing them.
INSERT INTO bs_workload_class (id, project_id, name, team_id, kind, sla, body, arrival) VALUES
  ('wlc-train-moe-256e', 'p_default', 'MoE-256e Pretraining', 'foundation',
    'pretraining',
    '{"mfu_target_pct": 50}'::jsonb,
    '{"model_family":"MoE","activated_params_b":8.0,"total_params_b":512,"seq_len":8192,"global_batch":4096,"quant":"FP8"}'::jsonb,
    '{"pattern":"constant","rate":1.0}'::jsonb),
  ('wlc-infer-llama70b', 'p_default', 'Llama-70B Online Inference', 'rec-search',
    'inference',
    '{"ttft_p99_ms":300,"decode_p99_ms":50}'::jsonb,
    '{"model_family":"LLM","activated_params_b":70,"total_params_b":70,"seq_len":4096,"quant":"FP8"}'::jsonb,
    '{"pattern":"poisson","rate":120.0}'::jsonb),
  ('wlc-batch-eval', 'p_default', '夜间批量评测', 'foundation',
    'batch_infer',
    '{"deadline_h":6}'::jsonb,
    '{"model_family":"LLM","seq_len":2048,"global_batch":1024,"quant":"BF16"}'::jsonb,
    '{"pattern":"constant","rate":1.0}'::jsonb);

INSERT INTO bs_workload_mix (id, project_id, name, members, notes) VALUES
  ('mix-bj1-default', 'p_default', '默认混部（白天训推 7:3 · 夜间纯训）',
    '[
      {"class_id":"wlc-train-moe-256e","weight":0.7,"time_window":"always"},
      {"class_id":"wlc-infer-llama70b","weight":0.3,"time_window":"hours:0-22"},
      {"class_id":"wlc-batch-eval","weight":0.0,"time_window":"hours:23-23"}
    ]'::jsonb,
    'Demo mix; weights are nominal and need calibration via mix-fitter once snapshots arrive.');
