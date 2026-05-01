-- ByteSim — SimExperiment object: a saved (hwspec + model + strategy +
-- workload) combination representing one bookmarked Sim form configuration.
--
-- Distinct from bs_scenario (timed simulation with workload mix) and
-- bs_run (single execution). An experiment is the "configuration template"
-- the architect saves and re-runs over time, plus the lineage of forks.
--
-- Spec hashes are nullable because not every engine path requires all four
-- (e.g. inference doesn't need strategy_hash if defaults are used).
-- parent_experiment_id captures the fork lineage so the UI can render
-- "this experiment was derived from X by changing Y".

CREATE TABLE bs_sim_experiment (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES bs_project(id),
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('train_sim','infer_sim')),
  hwspec_hash          TEXT,
  model_hash           TEXT,
  strategy_hash        TEXT,
  workload_hash        TEXT,
  parent_experiment_id TEXT REFERENCES bs_sim_experiment(id) ON DELETE SET NULL,
  -- Summary KPIs from the most recent run derived from this experiment.
  -- Updated lazily by the runs pipeline; stays NULL until first run finishes.
  best_summary         JSONB,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_sim_experiment_project ON bs_sim_experiment (project_id);
CREATE INDEX bs_sim_experiment_kind ON bs_sim_experiment (kind);
CREATE INDEX bs_sim_experiment_parent ON bs_sim_experiment (parent_experiment_id);
CREATE INDEX bs_sim_experiment_created_at ON bs_sim_experiment (created_at DESC);
