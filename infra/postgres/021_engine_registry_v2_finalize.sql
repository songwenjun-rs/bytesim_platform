-- ByteSim RFC-001 §3 — Engine Registry v2 (M5 / cutover finalisation).
--
-- Removes the v1 routing surface entirely:
--   • drops `domain` / `granularity` / `capabilities` columns + their index
--   • drops the SQL-bootstrap rows from migrations 011 + 019; engines now
--     self-register on boot via shared.engine_runtime
--   • promotes `fidelity` and `coverage_envelope` to NOT NULL — they were
--     nullable in 020 only because v1 callers might write rows without them
--
-- Compatibility break: any code that still reads bs_engine.{domain,
-- granularity, capabilities} will fail. M2 cutover (PR/RFC-001) updates
-- engine-registry-svc, engine-svc, tuner-svc, scenario-svc, calibration-svc,
-- BFF, web/src/api/engines.ts, web/src/pages/Engines.tsx — they all stop
-- referencing the v1 columns before this migration runs.
--
-- See `docs/rfc/engine-registry-v2.md` §3 (Migration plan, M5 row) and §4.1
-- (Affected files).

-- ── 1. Remove SQL-bootstrap rows ─────────────────────────────────────
-- These were planted by 011 (surrogate) + 019 (astra). After M2 the engines
-- self-register on boot, so the bootstrap is redundant *and* would prevent
-- the NOT NULL constraints below from succeeding (these rows have no v2
-- envelope/fidelity yet).
DELETE FROM bs_engine WHERE name IN ('surrogate-analytical', 'astra-sim');

-- ── 2. Drop the v1 routing index (bs_engine_domain_status from 011) ──
DROP INDEX IF EXISTS bs_engine_domain_status;

-- ── 3. Drop v1 columns ───────────────────────────────────────────────
ALTER TABLE bs_engine
  DROP COLUMN IF EXISTS domain,
  DROP COLUMN IF EXISTS granularity,
  DROP COLUMN IF EXISTS capabilities;

-- ── 4. Promote v2 columns to NOT NULL ────────────────────────────────
-- Safe now: the only rows that still exist will be inserted by the v2
-- self-registration path, which always supplies these.
ALTER TABLE bs_engine
  ALTER COLUMN fidelity SET NOT NULL,
  ALTER COLUMN coverage_envelope SET NOT NULL;

-- ── 5. Comment refresh — v1 fields are gone, drop their deprecation notes
COMMENT ON COLUMN bs_engine.fidelity IS
  'RFC-001 v2 — analytical|hybrid|cycle-accurate. Required.';
COMMENT ON COLUMN bs_engine.coverage_envelope IS
  'RFC-001 v2 — Pydantic CoverageEnvelope JSON. Required.';
