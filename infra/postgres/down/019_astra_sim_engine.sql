-- Down for 019_astra_sim_engine.sql
-- Removes the astra-sim plugin row. Idempotent: DELETE WHERE name=… is a
-- no-op if the row was never inserted or has been removed by hand.
DELETE FROM bs_engine WHERE name = 'astra-sim';
