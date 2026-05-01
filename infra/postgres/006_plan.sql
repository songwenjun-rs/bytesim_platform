-- Slice-7 plan tables. design_doc.md §5.2 already specified these but slice-1
-- DDL didn't materialize them; do it now.
--   bs_plan       — a comparison set referenced by the comparator UI
--   bs_plan_slot  — N runs pinned to slots A..H

CREATE TABLE bs_plan (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES bs_project,
  name                 TEXT NOT NULL,
  recommended_run_id   TEXT,                  -- one of the slot run_ids; UI shows ★
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_plan_project ON bs_plan (project_id);

CREATE TABLE bs_plan_slot (
  plan_id     TEXT NOT NULL REFERENCES bs_plan ON DELETE CASCADE,
  slot        CHAR(1) NOT NULL CHECK (slot ~ '^[A-H]$'),
  run_id      TEXT NOT NULL REFERENCES bs_run,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, slot)
);
CREATE INDEX bs_plan_slot_run ON bs_plan_slot (run_id);

-- ────────────────────────────────────────────────────────────────
-- Seed: enrich existing demo Runs so the comparator has fields to align,
-- then bind them into a 4-slot plan-demo (A=current best, B=baseline,
-- C=cost-only candidate, D=GB300 with low confidence).
-- ────────────────────────────────────────────────────────────────

-- sim-7e90 baseline KPIs already include MFU/step/cost/days; add power & opex
-- so all four cells render. UPDATE in place so we keep slice-1 lineage intact.
UPDATE bs_run
SET kpis = kpis || '{"peak_kw": 680, "five_year_opex_musd": 62.1, "hardware_capex_musd": 32.8, "ttft_p99_ms": 244}'::jsonb
WHERE id = 'sim-7e90';

UPDATE bs_run
SET kpis = kpis || '{"peak_kw": 812, "five_year_opex_musd": 61.4, "hardware_capex_musd": 40.2, "ttft_p99_ms": 186, "gpu_count": 1024}'::jsonb
WHERE id = 'sim-7f2a';

UPDATE bs_run
SET kpis = kpis || '{"peak_kw": 812, "hardware_capex_musd": 40.2, "ttft_p99_ms": 186, "gpu_count": 1024}'::jsonb,
    kind = 'tco',
    title = 'B200 × 1024 · 5 年运营成本估算'
WHERE id = 'sim-9c11';
-- sim-9c11 may not exist in slice-1 seed; insert if missing
INSERT INTO bs_run (id, project_id, kind, title, status, inputs_hash, surrogate_ver, confidence, started_at, finished_at, kpis, created_by)
SELECT 'sim-9c11', 'p_default', 'tco', 'B200 × 1024 · 5 年运营成本估算', 'done',
       '00000000000000000000000000000000deadbe9c', 'v2.4', 0.96,
       NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours',
       '{"five_year_opex_musd": 61.4, "cost_per_m_tok_usd": 0.41, "peak_kw": 812, "hardware_capex_musd": 40.2, "ttft_p99_ms": 186, "gpu_count": 1024, "mfu_pct": 48.7, "step_ms": 1840}'::jsonb,
       'lihaoran'
WHERE NOT EXISTS (SELECT 1 FROM bs_run WHERE id = 'sim-9c11');

-- sim-7f2a-d2 (GB300 alt, low confidence) seeded in slice-1 with empty kpis;
-- fill demo numbers so it shows up as the "infeasible/low conf" column.
UPDATE bs_run
SET kpis = kpis || '{"mfu_pct": 38.6, "step_ms": 2140, "cost_per_m_tok_usd": 0.46, "five_year_opex_musd": 68.7, "peak_kw": 760, "hardware_capex_musd": 38.9, "ttft_p99_ms": 262, "gpu_count": 1024, "train_days": 14.2}'::jsonb,
    status = 'done', confidence = 0.82, finished_at = NOW() - INTERVAL '40 minutes'
WHERE id = 'sim-7f2a-d2';

INSERT INTO bs_plan (id, project_id, name, recommended_run_id, created_by) VALUES
  ('plan-demo', 'p_default', 'B200 vs H200 vs GB300 · 训练评估', 'sim-7f2a', 'songwenjun');

INSERT INTO bs_plan_slot (plan_id, slot, run_id) VALUES
  ('plan-demo', 'A', 'sim-7f2a'),
  ('plan-demo', 'B', 'sim-7e90'),
  ('plan-demo', 'C', 'sim-9c11'),
  ('plan-demo', 'D', 'sim-7f2a-d2');
