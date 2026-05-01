# Down migrations

Convention: for every forward migration `infra/postgres/NNN_*.sql` that's safe
to invert, ship a sibling `infra/postgres/down/NNN_*.sql` that undoes it. This
is **not** the same as a generic schema rollback tool (Liquibase / Flyway):
each script is hand-written, hand-reviewed, and may be intentionally absent
when the forward script is not safely reversible (e.g. data-bearing migrations
that would drop production rows).

## Rules

1. **One pair per migration.** `017_jsonb_deep_merge.sql` ↔ `down/017_jsonb_deep_merge.sql`.
2. **Apply in reverse order.** `make migrate-down N=2` rolls back the last 2.
3. **Idempotent.** Use `IF EXISTS` / `IF NOT EXISTS` so re-running doesn't fail.
4. **No data destruction without explicit opt-in.** A migration that adds
   `bs_resource` rows does **not** get a down script that DROPs the table —
   those rows are user-authored. Only schema changes whose inverse is purely
   structural (CREATE FUNCTION / CREATE TRIGGER / ADD COLUMN with no defaults)
   ship a down script.
5. **Annotate skipped ones.** If an up-migration deliberately has no down,
   leave a stub `down/NNN_<name>.sql.skip` with a one-line reason.

## Catalog (as of 2026-04-27)

| Up | Down | Reason if skipped |
|---|---|---|
| 001_init.sql | — | Schema bootstrap; rolling back drops everything. |
| 002_seed.sql | — | Seed data; intentionally not backed out. |
| 003-016 | — | (Backfill on demand. Not blocking Phase 0.) |
| 017_jsonb_deep_merge.sql | down/017_jsonb_deep_merge.sql | Drops the function. |
| 018_audit_immutable_trigger.sql | down/018_audit_immutable_trigger.sql | Drops triggers + function. |
| 019_astra_sim_engine.sql | down/019_astra_sim_engine.sql | Removes the astra-sim plugin row. |
| 020_engine_registry_v2.sql | down/020_engine_registry_v2.sql | RFC-001 v2 additive columns; reverse drops them only. |
| 021_engine_registry_v2_finalize.sql | down/021_*.sql.skip | RFC-001 v2 cutover; drops v1 columns + bootstrap rows. Roll back by deploying prior image. |

## How to run

```bash
make migrate-down N=1   # roll back the last migration that ships a down script
make migrate-down N=2   # roll back the last two
```

The harness applies `down/NNN_*.sql` files in **descending** lexical order,
stopping after `N`. Missing down scripts halt the chain — fix the gap or
write the down script before continuing.
