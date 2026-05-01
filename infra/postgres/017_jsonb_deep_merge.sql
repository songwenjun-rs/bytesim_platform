-- Deep-merge JSONB function. Used by run-svc PatchRun for kpis updates so an
-- engine progress patch doesn't clobber a previously-stamped nested object
-- (notably _engine_provenance and _derived_from_* fields).
--
-- Semantics:
--   * NULL on either side returns the other side.
--   * Both objects → merged keys; on key collision, recurse if both values
--     are objects, otherwise right-hand wins (engine intent: latest patch
--     overrides scalar).
--   * Anything non-object on either side → right-hand wins (same as ||).
--
-- This replaces the bare `||` operator at run-svc store/postgres.go:368.

CREATE OR REPLACE FUNCTION jsonb_deep_merge(a jsonb, b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    CASE
      WHEN a IS NULL THEN b
      WHEN b IS NULL THEN a
      WHEN jsonb_typeof(a) = 'object' AND jsonb_typeof(b) = 'object' THEN
        coalesce(
          (
            SELECT jsonb_object_agg(k, v)
            FROM (
              SELECT
                coalesce(ka.key, kb.key) AS k,
                CASE
                  WHEN ka.value IS NULL THEN kb.value
                  WHEN kb.value IS NULL THEN ka.value
                  WHEN jsonb_typeof(ka.value) = 'object'
                   AND jsonb_typeof(kb.value) = 'object' THEN
                    jsonb_deep_merge(ka.value, kb.value)
                  ELSE kb.value
                END AS v
              FROM jsonb_each(a) ka
              FULL OUTER JOIN jsonb_each(b) kb ON ka.key = kb.key
            ) merged
          ),
          '{}'::jsonb
        )
      ELSE b
    END
$$;
