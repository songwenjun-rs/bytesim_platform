-- ByteSim §3: Scenarios — time-dimension simulation.
--
-- A scenario is "given this hardware footprint, this workload mix, and these
-- failure assumptions, simulate over [start, end] and emit per-tick KPIs".
-- Tick granularity is 1 hour by default; horizon caps at 7 days (168 ticks)
-- per the v3 scope.
--
-- bs_scenario_tick is the wide-format time series: one row per (scenario,
-- tick_ts, kpi_kind, optional resource_id). Plot/aggregate downstream.

CREATE TABLE bs_scenario (
  id              TEXT PRIMARY KEY,             -- "sce-q2-train-heavy"
  project_id      TEXT NOT NULL REFERENCES bs_project(id),
  name            TEXT NOT NULL,
  horizon         TSTZRANGE NOT NULL,           -- 仿真时间窗（GIST + range)
  tick_seconds    INT NOT NULL DEFAULT 3600,    -- bucket granularity (default 1h)
  workload_mix_id TEXT NOT NULL REFERENCES bs_workload_mix(id),
  resource_root_id TEXT REFERENCES bs_resource(id),
                                                -- e.g. "site-bj1" — defines hardware capacity
  fault_model     JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                -- {gpu_mtbf_h, link_mtbf_h, restart_cost_h}
  policy_refs     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
                                                -- 调度策略引用（后续接 scheduler-svc）
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','failed','cancelled')),
  best_summary    JSONB,                        -- aggregate stats after run
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_scenario_status ON bs_scenario (status);
CREATE INDEX bs_scenario_horizon ON bs_scenario USING gist (horizon);
CREATE INDEX bs_scenario_project ON bs_scenario (project_id);

CREATE TABLE bs_scenario_tick (
  scenario_id   TEXT NOT NULL REFERENCES bs_scenario(id) ON DELETE CASCADE,
  tick_ts       TIMESTAMPTZ NOT NULL,
  kpi_kind      TEXT NOT NULL,                  -- mfu_pct | qps | failed_jobs | queue_depth | tco_usd
  -- "_agg" sentinel marks aggregate (non-resource-scoped) values; saves a
  -- partial-index workaround for NULL-in-PK and keeps queries straightforward.
  resource_id   TEXT NOT NULL DEFAULT '_agg',
  value         NUMERIC NOT NULL,
  PRIMARY KEY (scenario_id, tick_ts, kpi_kind, resource_id)
);
CREATE INDEX bs_scenario_tick_kpi ON bs_scenario_tick (scenario_id, kpi_kind, tick_ts);
