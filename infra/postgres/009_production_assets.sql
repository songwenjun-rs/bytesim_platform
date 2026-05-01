-- ByteSim §6: Production data offline calibration assets.
--
-- 设计原则（呼应 v3 综合方案）：
--   * 平台不连生产；snapshot 由生产侧脱敏后投递入库
--   * snapshot 是不可变的（只新建、不修改）— 校准结果可重放
--   * 入库走 data_steward 审批 (§7)
--   * 多消费者（calibration / TCO 校验 / mix fitter）通过 bs_snapshot_consumed_by
--     记录引用关系，做血缘
--
-- 编号：009 是按 v3 方案给 §6 预留的位置（008 = resource_ontology, 010 = TCO,
-- 011 = engine_registry 已经按这个顺序部署）。

CREATE TABLE bs_production_snapshot (
  id              TEXT PRIMARY KEY,             -- "snap-2026q1-b200-moe-prod"
  project_id      TEXT NOT NULL REFERENCES bs_project(id),
  name            TEXT NOT NULL,
  source_kind     TEXT NOT NULL CHECK (source_kind IN (
                    'dcgm','nsight','slurm','k8s_event','bms','custom'
                  )),
  source_adapter  TEXT NOT NULL,                -- 适配器名 + version, e.g. "dcgm-csv@v1"
  storage_uri     TEXT NOT NULL,                -- file:///… or s3://…
  sha256          TEXT NOT NULL,
  row_count       BIGINT,
  bytes           BIGINT,

  covers_period   TSTZRANGE NOT NULL,           -- 数据覆盖的真实时间段（生产侧）
  hardware_scope  JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                -- {gpu_models:[B200], idc:[bj1]}
  workload_scope  JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                -- {model_families:[MoE], modes:[train]}
  redaction       JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                -- {removed_fields:[...], hash_method:"sha256"}

  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by     TEXT NOT NULL,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review','approved','rejected','expired')),
  retention_until TIMESTAMPTZ,

  notes           TEXT
);
CREATE INDEX bs_production_snapshot_status ON bs_production_snapshot (status, source_kind);
CREATE INDEX bs_production_snapshot_period ON bs_production_snapshot USING gist (covers_period);

-- N:N 消费血缘：哪些 calibration job / TCO validator / mix fitter 用了哪些 snapshot
CREATE TABLE bs_snapshot_consumed_by (
  snapshot_id   TEXT NOT NULL REFERENCES bs_production_snapshot(id),
  consumer_kind TEXT NOT NULL CHECK (consumer_kind IN (
                  'calibration_job','tco_validation','mix_fit'
                )),
  consumer_id   TEXT NOT NULL,
  consumed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, consumer_kind, consumer_id)
);
CREATE INDEX bs_snapshot_consumed_by_consumer ON bs_snapshot_consumed_by (consumer_kind, consumer_id);

-- §6.3 calibration job columns once lived here as
--   ALTER TABLE bs_calibration_job ADD COLUMN snapshot_ids ... ;
-- The bs_calibration_job table came from migration 004 (calibration-svc),
-- which was removed in the Tier B teardown. The ALTER is no longer
-- applicable; the snapshot consumer link above (bs_snapshot_consumed_by)
-- is generic and works for any future caller, calibration-svc or
-- otherwise.
