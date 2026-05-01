-- ByteSim RFC-001 §2.2 — Engine Registry v2 (M1: ADDITIVE).
--
-- Adds the four columns the v2 selector needs alongside the existing v1
-- columns. M1 deliberately preserves `domain` / `granularity` / `capabilities`
-- so the current registry, BFF, web, and tests keep working unchanged. The
-- v2 columns are NULL-able for now; M3 will populate them via the new
-- self-registration path. M5 will drop the v1 columns (separate migration).
--
-- Compatibility: every existing INSERT (`011`, `019`) keeps working — the new
-- columns default to NULL / '{}' so no rewrite is needed. Down migration is
-- safely reversible: it drops only the new columns, no data loss for v1.
--
-- See `docs/rfc/engine-registry-v2.md` §2.2, §3 (Migration plan), §4.2
-- (envelope shapes for surrogate + astra-sim that M3 will install).

-- ── 1. fidelity ─────────────────────────────────────────────────────────
-- Replaces `granularity` semantics with the RFC-001 vocabulary. Default
-- 'analytical' is conservative — engines self-correct when they re-register
-- via the SDK in M3.
ALTER TABLE bs_engine
  ADD COLUMN IF NOT EXISTS fidelity TEXT
  CHECK (fidelity IN ('analytical', 'hybrid', 'cycle-accurate'));

-- ── 2. coverage_envelope ────────────────────────────────────────────────
-- Strong-typed (Pydantic-validated at registry boundary) replacement for
-- the free-form `capabilities` JSONB. Schema lives in
-- shared/engine_contracts/envelope.py · CoverageEnvelope.
-- NULL during M1-M2; required after M5.
ALTER TABLE bs_engine
  ADD COLUMN IF NOT EXISTS coverage_envelope JSONB
  CHECK (coverage_envelope IS NULL OR jsonb_typeof(coverage_envelope) = 'object');

-- ── 3. kpi_outputs ──────────────────────────────────────────────────────
-- Which fields of EnginePredictResponse this engine actually populates.
-- Used by shadow-engine selection (RFC §2.7) to verify two engines have
-- common KPI surface before doing a Δ comparison.
ALTER TABLE bs_engine
  ADD COLUMN IF NOT EXISTS kpi_outputs TEXT[] NOT NULL DEFAULT '{}';

-- ── 4. calibration ──────────────────────────────────────────────────────
-- {profile_runs: [snapshot_id...], mape_pct: {mfu: 3.2, step_ms: 4.1}}.
-- Used as the secondary selector key when fidelity ties. Populated by
-- calibration-svc on each retrain (RFC-004, future).
ALTER TABLE bs_engine
  ADD COLUMN IF NOT EXISTS calibration JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(calibration) = 'object');

-- ── 5. forward-compat index ─────────────────────────────────────────────
-- The v2 selector filters by status + fidelity then sorts by
-- (fidelity desc, calibration_mape asc, sla asc). A two-column index
-- accelerates the most common path (`status='active'` already 99% of rows).
CREATE INDEX IF NOT EXISTS bs_engine_status_fidelity
  ON bs_engine (status, fidelity);

-- ── 6. column-level documentation ───────────────────────────────────────
COMMENT ON COLUMN bs_engine.fidelity IS
  'RFC-001 v2 — analytical|hybrid|cycle-accurate. Replaces v1.granularity at M5.';
COMMENT ON COLUMN bs_engine.coverage_envelope IS
  'RFC-001 v2 — Pydantic CoverageEnvelope JSON. Replaces v1.capabilities at M5.';
COMMENT ON COLUMN bs_engine.kpi_outputs IS
  'RFC-001 v2 — which EnginePredictResponse fields the engine populates.';
COMMENT ON COLUMN bs_engine.calibration IS
  'RFC-001 v2 — profile_runs + mape_pct from calibration-svc.';
COMMENT ON COLUMN bs_engine.domain IS
  'DEPRECATED (RFC-001 v2). Kept for v1 routing during M1-M4. Drops at M5.';
COMMENT ON COLUMN bs_engine.granularity IS
  'DEPRECATED (RFC-001 v2). Superseded by `fidelity`. Drops at M5.';
COMMENT ON COLUMN bs_engine.capabilities IS
  'DEPRECATED (RFC-001 v2). Superseded by `coverage_envelope`. Drops at M5.';
