-- ByteSim slice-1 minimal schema. Subset of design_doc.md §5.2.
-- Conventions: TEXT primary keys (ULID generated app-side), JSONB for spec bodies,
-- content-addressed spec_version.hash = sha1(canonical_json) computed app-side.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE bs_project (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  env         TEXT NOT NULL CHECK (env IN ('dev','staging','prod')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bs_spec (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('hwspec','model','strategy','workload')),
  name         TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES bs_project,
  latest_hash  CHAR(40) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_spec_project_kind ON bs_spec (project_id, kind);

CREATE TABLE bs_spec_version (
  hash         CHAR(40) PRIMARY KEY,
  spec_id      TEXT NOT NULL REFERENCES bs_spec,
  parent_hash  CHAR(40),
  version_tag  TEXT NOT NULL,           -- v1, v2, v3-gb300...
  body         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (spec_id, version_tag)
);

CREATE TABLE bs_run (
  id             TEXT PRIMARY KEY,         -- sim-7f2a / inf-5g3x / cal-241
  project_id     TEXT NOT NULL REFERENCES bs_project,
  kind           TEXT NOT NULL CHECK (kind IN ('train','infer','batch','agent','tco','calibration')),
  title          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  progress_pct   NUMERIC,                  -- 0..100, NULL for terminal states
  inputs_hash    CHAR(40) NOT NULL,        -- sha1 of joined spec hashes
  surrogate_ver  TEXT,
  confidence     NUMERIC,
  parent_run_id  TEXT,
  budget_gpuh    NUMERIC,
  cost_usd       NUMERIC,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  kpis           JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifacts      JSONB NOT NULL DEFAULT '[]'::jsonb,
  boundaries     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_run_project_started ON bs_run (project_id, started_at DESC);

CREATE TABLE bs_run_uses_spec (
  run_id     TEXT NOT NULL REFERENCES bs_run ON DELETE CASCADE,
  spec_hash  CHAR(40) NOT NULL REFERENCES bs_spec_version,
  PRIMARY KEY (run_id, spec_hash)
);

-- Generic lineage edge (run-run, run-asset_version, run-calibration ...).
-- Recursive CTE walks dst_kind/dst_id forward.
CREATE TABLE bs_lineage_edge (
  src_kind  TEXT NOT NULL,
  src_id    TEXT NOT NULL,
  dst_kind  TEXT NOT NULL,
  dst_id    TEXT NOT NULL,
  rel       TEXT NOT NULL,                 -- derived_from | uses_version | calibrated_by | exported_to
  meta      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (src_kind, src_id, dst_kind, dst_id, rel)
);
CREATE INDEX bs_lineage_dst ON bs_lineage_edge (dst_kind, dst_id);
