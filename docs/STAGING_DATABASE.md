# The AI Connect staging database

AI Connect had exactly one database until now: the production Supabase project
`ai-connect-prod`. Every migration through 0015 was applied straight to it, and
there was no supported way to run the API locally against anything else — no
`.env` loader, no seeded dev database, no migration command. Schema work was
therefore validated in production or not at all.

This document describes the non-production path that closes that gap.

> **Nothing here ever touches production.** The migration runner refuses any
> host it cannot prove is local, and refuses outright under
> `NODE_ENV=production`. See [Safety](#safety).

## What it is

A disposable Postgres 16 container, dedicated to AI Connect, defined in
[`docker-compose.staging.yml`](../docker-compose.staging.yml).

| | |
| --- | --- |
| Container | `ai-connect-staging-db` |
| Image | `postgres:16-alpine` |
| Address | `127.0.0.1:55432` (loopback only) |
| Database | `ai_connect_staging` |
| User | `aiconnect` |
| Volume | `ai-connect-staging-db-data` |

Port `55432` is deliberately not `5432`, so this can never be confused with —
or shadow — another Postgres on the machine.

### Why a container rather than a second Supabase project

A dedicated throwaway Supabase project would also be a correct answer, and the
setup below works against one unchanged (see
[Using a hosted staging database](#using-a-hosted-staging-database)). The
container was chosen for the default because it needs no account, no
provisioning wait, no credential to store, and no cost; it is destroyed and
rebuilt in seconds; and it makes the "is this production?" question trivially
answerable — the answer is on loopback.

Nothing in migrations 0000–0016 depends on Supabase. `gen_random_uuid()` is
built into Postgres 13+, and the `*_vault_secret_id` columns are plain `uuid`
columns with no reference to the `vault` schema. The one thing stock Postgres
cannot do is execute the Supabase Vault functions used by
`lib/vault.ts` — so the credential-storing routes (`/api/keys`,
`/api/platform-credentials`, `/api/integrations`) will fail against this
database. Build Control, projects, auth and logging do not touch Vault and work
fully.

## Setup

```bash
# 1. Start the database
pnpm staging:db:up

# 2. Point the API at it (gitignored; the template carries no real secrets)
cp apps/api/.env.example apps/api/.env.staging.local

# 3. Apply every committed migration
pnpm db:migrate

# 4. Run the API against it
pnpm --filter @ai-connect/api dev
```

Teardown:

```bash
pnpm staging:db:down      # stop, keep the data
pnpm staging:db:destroy   # stop and delete the volume
```

The password in `docker-compose.staging.yml` and `.env.example` is a throwaway
local credential, not a secret: it grants access to a loopback-only container
holding no real data. Override it by exporting
`AICONNECT_STAGING_DB_PASSWORD` before `staging:db:up` if you prefer.

## Environment loading

`apps/api/src/lib/loadLocalEnv.ts` reads the first of these that exists, from
`apps/api/`:

1. `.env.staging.local` — the documented home for the staging database URL
2. `.env.local`
3. `.env`

All three are gitignored. `apps/api/.env.example` is the committed template of
variable *names* and is the only `.env*` file in the repository.

Three rules make this safe to have in the tree:

- It is a no-op under `NODE_ENV=production`. Render injects real values and
  `lib/env.ts` parses `process.env` exactly as before.
- Variables already exported in your shell always win. The file never
  overwrites an explicit value.
- It runs only from `src/devServer.ts` and the scripts — never from
  `src/index.ts`, which is still the production entry point and is unchanged in
  behaviour.

`AICONNECT_ENV_FILE=<name>` selects a specific file;
`AICONNECT_SKIP_ENV_FILE=1` disables loading entirely.

## Migrations

```bash
pnpm db:generate    # unchanged — generate from src/db/schema.ts
pnpm db:migrate     # NEW — apply committed migrations to a non-production DB
```

`db:migrate` runs `apps/api/src/scripts/migrate.ts`, which uses drizzle-orm's
own migrator over `apps/api/drizzle/`. It reads `meta/_journal.json`, applies
whatever is missing, and records what it applied in
`drizzle.__drizzle_migrations`. Re-running it is a no-op.

This does **not** change the MTTBuild rule that migrations are never
auto-applied. Generate, commit and review first; `db:migrate` is how the
reviewed SQL then reaches a *staging* database so it can be exercised before
production ever sees it.

### Safety

`db:migrate` refuses to run unless it can show the target is not production:

| Target | Result |
| --- | --- |
| `NODE_ENV=production` | Always refused. |
| Host `localhost` / `127.0.0.1` / `::1` | Allowed. |
| Any other host | Refused unless `DB_MIGRATE_ACK_TARGET` is set to the exact `host/database` being targeted. |

The acknowledgement is a value the operator has to read off their own
connection string and type out; no default or generic "yes" satisfies it.

```
$ DATABASE_URL=postgresql://…@aws-0-us-east-2.pooler.supabase.com:5432/postgres pnpm db:migrate

  target host     : aws-0-us-east-2.pooler.supabase.com:5432
  target database : postgres
  classification  : REMOTE

  migrate: REFUSED — host 'aws-0-us-east-2.pooler.supabase.com' is not local, so
  this script cannot verify it is not production.
```

### Production is not managed by this script

Production's schema was applied by other means, before this script existed.
The `drizzle.__drizzle_migrations` bookkeeping table does not exist there, so
pointing `db:migrate` at production would try to replay `0000` onward against a
populated database. Production migrations remain a manual, reviewed operation
through the Supabase SQL editor.

### Using a hosted staging database

To use a throwaway Supabase project instead of the container, put its **session
pooler** URL in `apps/api/.env.staging.local` and acknowledge the host once:

```bash
DB_MIGRATE_ACK_TARGET="aws-1-us-east-2.pooler.supabase.com/postgres" pnpm db:migrate
```

Use a project created for this purpose. Never acknowledge the host of
`ai-connect-prod`.

## Exercising the API locally

Every `/api/*` route is gated by Auth0 JWT verification, which historically
made them unreachable locally without the real tenant. Rather than add a
middleware bypass — a production-shaped risk — the local harness stands up a
throwaway issuer:

- `apps/api/src/scripts/localIssuer.ts` generates an ephemeral RSA keypair per
  process, serves `/.well-known/jwks.json` on `127.0.0.1`, and mints tokens
  with the same claim shape Auth0 produces (including the namespaced email
  claim from the Post Login Action).
- `apps/api/src/scripts/localApiHarness.ts` boots the **real** `src/index.ts`
  against the staging database with `AUTH0_ISSUER_BASE_URL` pointed at that
  issuer.

The API trusts it only because the issuer URL is on loopback. Production points
at the real tenant and cannot be persuaded to trust a key generated on a
laptop.

```bash
# Drive every Build Control route through the full lifecycle
pnpm --filter @ai-connect/api smoke:build-control

# The same ground as assertions, cleaning up after itself
pnpm test:integration
```

`pnpm test` (unit tests) needs no database and is unchanged.
