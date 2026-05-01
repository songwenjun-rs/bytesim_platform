-- Reverses 017_jsonb_deep_merge.sql.
-- Note: any callers that depend on the function (run-svc PatchRun) must be
-- rolled back BEFORE this script runs, otherwise PatchRun queries will fail
-- with "function jsonb_deep_merge does not exist".

DROP FUNCTION IF EXISTS jsonb_deep_merge(jsonb, jsonb);
