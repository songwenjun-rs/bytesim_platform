-- Reverses 020_engine_registry_v2.sql.
--
-- Drops the four v2 columns + the v2 index + clears column comments. The v1
-- columns (`domain`, `granularity`, `capabilities`) are untouched, so v1
-- callers (registry / BFF / web) keep working unchanged.
--
-- DATA LOSS WARNING: rolling back drops any v2 envelope/calibration data
-- written by the SDK self-registration path (M3+). v1 INSERTs are unaffected
-- because they never wrote those columns.

DROP INDEX IF EXISTS bs_engine_status_fidelity;

ALTER TABLE bs_engine
  DROP COLUMN IF EXISTS calibration,
  DROP COLUMN IF EXISTS kpi_outputs,
  DROP COLUMN IF EXISTS coverage_envelope,
  DROP COLUMN IF EXISTS fidelity;

COMMENT ON COLUMN bs_engine.domain IS NULL;
COMMENT ON COLUMN bs_engine.granularity IS NULL;
COMMENT ON COLUMN bs_engine.capabilities IS NULL;
