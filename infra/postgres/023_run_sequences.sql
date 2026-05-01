-- ByteSim — sequential run IDs per kind.
--
-- Old IDs were `<prefix>-<random-3-hex>` (sim-fa7ec6, inf-893081…) which had
-- two annoyances: (a) hex looked random / hard to read, (b) two runs created
-- back-to-back didn't sort by creation time. New IDs use a per-kind monotonic
-- sequence, zero-padded to 3 digits with overflow:
--   train → sim-001 / sim-002 / ...
--   infer → inf-001 / inf-002 / ...
--   batch → bat-001 / ...
--   agent → agt-001 / ...
--   tco   → tco-001 / ...
--
-- Each kind gets its own SEQUENCE so concurrent CreateRun calls for different
-- kinds don't share a counter. Sequences are race-free (postgres internals)
-- so two parallel train runs always get distinct numbers.

CREATE SEQUENCE IF NOT EXISTS bs_run_train_seq START 1;
CREATE SEQUENCE IF NOT EXISTS bs_run_infer_seq START 1;
CREATE SEQUENCE IF NOT EXISTS bs_run_batch_seq START 1;
CREATE SEQUENCE IF NOT EXISTS bs_run_agent_seq START 1;
CREATE SEQUENCE IF NOT EXISTS bs_run_tco_seq   START 1;
