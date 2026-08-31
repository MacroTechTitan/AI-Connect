# Migration plan — 0016 DevOS Agentic Build Control

**Migration:** `apps/api/drizzle/0016_same_lady_bullseye.sql`
**Issue:** #19 · **PR:** #20 · **Branch:** `agent/devos-build-control`
**Status:** Applied and verified on the staging database (2026-08-31).
**NOT applied to production.**

Per MTTBuild ("When schema changes are needed"), this migration is generated,
committed and reviewed before it is applied anywhere. It has now been applied
to the staging database with eyes on the output and every verification query
below run against it. Production is still untouched, and stays that way until
the code that uses the new tables is merged.

## What it does

Creates four new tables and nothing else. It is **purely additive**: it drops
no table, alters no existing column, and touches no pre-existing row.

| Table | Purpose |
| --- | --- |
| `build_runs` | One supervised build task and its lifecycle state |
| `build_events` | Normalized, timestamped activity timeline per run |
| `build_reviews` | Independent reviewer verdicts (`PASS` / `REVISION_REQUIRED` / `STOP`) |
| `build_approvals` | The human approve/reject decision |

All four are organization- and project-scoped with `ON DELETE cascade` from
`organizations` and `projects`, and `ON DELETE restrict` from `users` so an
operator who made a decision cannot be deleted out from under the audit trail.

### Constraints worth knowing about

- `build_runs_state_check` — the ten-state vocabulary.
- `build_runs_release_status_check` — `NOT_EVALUATED` / `ELIGIBLE` / `BLOCKED`.
- `build_runs_worker_type_check` — `claude_code` only in v0.1.
- `build_reviews_verdict_check` — the three verdicts.
- `build_approvals_one_per_run_idx` — one human decision per run, ever.
- `build_runs_one_active_per_project_idx` — a **partial unique index** allowing
  only one non-terminal run per project. This is the concurrency authority;
  the API surfaces its rejection as `409 active_run_exists` rather than racing
  a check-then-insert.

## Irreversibility

Nothing here is irreversible. No data is transformed, no column is dropped, no
type is changed. Rollback is a clean `DROP TABLE` of four tables that did not
previously exist. Any Build Control data created before a rollback is lost,
which is acceptable while the feature has no users.

## Apply

### Staging — done

```bash
# review first
cat apps/api/drizzle/0016_same_lady_bullseye.sql

pnpm staging:db:up     # docker-compose.staging.yml
pnpm db:migrate        # guarded runner — refuses any non-local host
```

Applied 2026-08-31 to `ai_connect_staging` on `127.0.0.1:55432`, a container
created empty minutes earlier. Because the database was fresh, this applied
0000–0016 in one pass — 17 migrations, 20 tables, 0 errors — recorded in
`drizzle.__drizzle_migrations`. See `docs/STAGING_DATABASE.md`.

### Production — not done

Production is unchanged, and `pnpm db:migrate` cannot reach it (the guard
refuses any host it cannot prove is local). Applying 0016 to production remains
a manual, reviewed operation through the Supabase SQL editor, and is not part
of this work.

## Verification queries

```sql
-- 1. All four tables exist.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('build_runs','build_events','build_reviews','build_approvals')
ORDER BY table_name;
-- expect exactly 4 rows

-- 2. Diff statistics are integers and cost is numeric, not text.
SELECT column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name = 'build_runs'
  AND column_name IN ('additions','deletions','cost_usd')
ORDER BY column_name;
-- expect: additions integer, cost_usd numeric(10,6), deletions integer

-- 3. The state CHECK carries all ten states.
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'build_runs_state_check';
-- expect QUEUED, RUNNING, PAUSED, REVIEWING, REVISION_REQUIRED,
--        AWAITING_APPROVAL, COMPLETED, FAILED, REJECTED, STOPPED

-- 4. The one-active-run index is partial and excludes terminal states.
SELECT indexdef
FROM pg_indexes
WHERE indexname = 'build_runs_one_active_per_project_idx';
-- expect a WHERE clause listing only the six active states

-- 5. Foreign keys resolve.
SELECT conname, conrelid::regclass AS child, confrelid::regclass AS parent
FROM pg_constraint
WHERE contype = 'f' AND conrelid::regclass::text LIKE 'build_%'
ORDER BY conname;
-- expect 13 rows across the four tables
```

### Behavioural check (optional, on a non-production database)

```sql
-- The partial unique index must reject a second active run on one project.
-- Substitute real ids. The second INSERT must fail with 23505.
INSERT INTO build_runs (organization_id, project_id, created_by_user_id, title, goal)
VALUES ('<org>', '<project>', '<user>', 'first', 'goal');

INSERT INTO build_runs (organization_id, project_id, created_by_user_id, title, goal)
VALUES ('<org>', '<project>', '<user>', 'second', 'goal');
-- expect: ERROR duplicate key value violates unique constraint
--         "build_runs_one_active_per_project_idx"

-- Moving the first run to a terminal state must free the slot.
UPDATE build_runs SET state = 'STOPPED' WHERE title = 'first';
-- the second INSERT now succeeds
```

## Rollback

```sql
BEGIN;
DROP TABLE IF EXISTS build_approvals;
DROP TABLE IF EXISTS build_reviews;
DROP TABLE IF EXISTS build_events;
DROP TABLE IF EXISTS build_runs;
COMMIT;
```

Drop order matters: `build_events`, `build_reviews`, and `build_approvals` all
reference `build_runs`. Indexes and CHECK constraints are dropped with their
tables; no separate cleanup is needed.

After rolling back the schema, also revert the application code — the API
registers `/api/build-runs/*` at boot and those routes will fail once the
tables are gone.

## Staging verification results (2026-08-31)

All five verification queries returned exactly what this document predicted:

| Query | Result |
| --- | --- |
| 1. Four tables exist | 4 rows: `build_approvals`, `build_events`, `build_reviews`, `build_runs` |
| 2. Column types | `additions` integer, `deletions` integer, `cost_usd` numeric(10,6) |
| 3. State CHECK | All ten states present, in order |
| 4. One-active index | Partial, `WHERE state IN` the six active states — terminals excluded |
| 5. Foreign keys | 13 rows, matching the predicted count |

The behavioural check behaved as designed: the second active `INSERT` on one
project failed with `23505` on
`build_runs_one_active_per_project_idx`, and moving the first run to `STOPPED`
freed the slot so the retry succeeded. Fixture rows were removed afterwards.

## Follow-up

Migrations 0000–0015 were applied to production by other means, before any
migration runner existed in this repository. `pnpm db:migrate` (added with this
work) is the runner for **non-production** databases only; production's
`drizzle.__drizzle_migrations` table does not exist, so the runner would try to
replay 0000 onward there. Keep `drizzle/meta/_journal.json` consistent with
what is actually applied in each environment.
