# AI Connect Admin Operations

Sprint 10 added an admin panel: a boolean `is_admin` flag per user, a `requireAdmin` middleware that gates every admin route, and an `/admin` frontend that renders those routes.

The middleware is the real gate. The frontend is a UX layer — it renders the admin tree at `/admin` and surfaces a friendly message on a 403, but it decides nothing. A non-admin who reaches `/admin` (or curls the API directly) gets a server-side 403 with `{ error: 'admin_required' }`. Never treat the absence of the UI as an access control.

## Architecture

- `users.is_admin` — boolean, added in migration `0013`, default false
- `requireAdmin` (`apps/api/src/middleware/requireAdmin.ts`) — re-reads `is_admin` from the DB on every request. It runs AFTER `requireAuth` + `requireHydratedUser`, so `req.user` is populated. Admin status is never cached in the JWT, so a revoke takes effect on the next request rather than at token expiry.
- `/admin` frontend (`apps/web/src/admin/`) — renders inside the Auth0 wrapper (it needs a token), gated at the render root in `main.tsx`.

## Granting admin access

There is no UI for granting admin in v1 — it's a deliberate SQL-only operation. Run against the Supabase `ai-connect-prod` database.

Grant:

```sql
UPDATE users SET is_admin = true WHERE email = '<email>';
```

Revoke:

```sql
UPDATE users SET is_admin = false WHERE email = '<email>';
```

Verify a specific user's status:

```sql
SELECT id, email, is_admin FROM users WHERE email = '<email>';
```

List all admins:

```sql
SELECT id, email, created_at FROM users WHERE is_admin = true;
```

Because `requireAdmin` re-reads the flag per request, a revoke is effective immediately — the user does not need to log out.

## Admin API surface

All eleven routes are mounted behind the same guard stack:

```typescript
const guards = [requireAuth, requireHydratedUser, requireAdmin] as const;
```

| Method | Path | Query / body |
|--------|------|--------------|
| GET | `/api/admin/dashboard` | — |
| GET | `/api/admin/users` | `limit`, `offset`, `admins_only=true` |
| GET | `/api/admin/users/:id` | — |
| PATCH | `/api/admin/users/:id/tier` | body `{ tier: 'free' \| 'pro' }` |
| GET | `/api/admin/subscriptions` | `limit`, `offset`, `tier`, `status` |
| POST | `/api/admin/subscriptions/:id/cancel` | — |
| GET | `/api/admin/integrations` | `limit`, `offset`, `type`, `status` |
| GET | `/api/admin/logs` | `limit`, `offset`, `category`, `level`, `from`, `to` |
| GET | `/api/admin/webhooks/stripe` | `limit`, `offset`, `event_type`, `processed` |
| POST | `/api/admin/webhooks/stripe/:id/retry` | — |
| GET | `/api/admin/webhooks/github` | `limit`, `offset`, `event_type`, `processed` |

Pagination is uniform across every list route: `limit` defaults to 50 and is **clamped to a maximum of 100**; `offset` defaults to 0 and floors at 0. Requesting `limit=1000` silently returns 100 — page through with `offset` rather than assuming a large limit was honored.

Note that `/api/admin/diagnostics` (Sprint 0) sits in the same file but is NOT part of this stack — it is gated by `requireDiagnosticsToken` (a bearer token), not by `is_admin`.

## Audit logging

`requireAdmin` logs every access decision:

| Level | Message | When |
|-------|---------|------|
| info | `admin_access` | every successful admin route hit |
| warn | `unauthorized_admin_access` | every 403 rejection |

Both carry `user_id`, `path`, and `method`.

The three mutation routes log an additional entry:

| Level | Message | Route |
|-------|---------|-------|
| info | `user_tier_changed` | PATCH `/api/admin/users/:id/tier` |
| info | `subscription_force_canceled` | POST `/api/admin/subscriptions/:id/cancel` |
| info | `stripe_webhook_reset_for_retry` | POST `/api/admin/webhooks/stripe/:id/retry` |

Every mutation entry identifies the acting admin, but note the key differs by layer: `requireAdmin` records the actor as `user_id`, while the mutation handlers record it as `admin_user_id` and name the affected user `target_user_id`. When tracing "who did this to whom", search `admin_user_id`; when tracing "who touched admin at all", search `user_id` within `category='admin'`.

All admin logs use category `admin`.

## Admin UI

`apps/web/src/admin/`:

- `AdminApp.tsx` — root; sidebar + section renderer (`AdminApp.css` alongside)
- `AdminEntry.tsx` — Auth0 wrapper
- `sections/` — `DashboardSection`, `UsersSection`, `SubscriptionsSection`, `IntegrationsSection`, `LogsSection`, `WebhooksSection`
- `shared/` — `adminApi.ts` (authed fetch throwing a typed `AdminApiError` carrying the HTTP status, plus an `isAdminForbidden` helper for the 403 case), `AdminSidebar.tsx`, `formatters.ts`, `SectionState.tsx` (exports `SectionError` + `SectionLoading`)

The gate is a path-based render-root gate in `main.tsx`, parallel to `/ui` — matching `/admin` or any `/admin/*` path. This is NOT a client router: the `/admin` URL causes a different app tree to render entirely. Unlike `/ui` and `/help`, the admin tree renders *inside* the Auth0 wrapper because it needs a token.

A non-admin who visits `/admin` gets a rendered shell, and each section's fetch 403s — `SectionError` then shows "You don't have admin access. Ask an existing admin to grant it."

## Common admin tasks

### Grandfather a user to Pro

Preferred — `PATCH /api/admin/users/:id/tier` with `{ tier: 'pro' }`. The handler upserts: it updates the existing `subscriptions` row (setting `tier` and forcing `status='active'`) or inserts one if the user has never had a subscription.

SQL fallback (`subscriptions_user_id_unique` on `user_id` makes the upsert valid):

```sql
INSERT INTO subscriptions (user_id, tier, status) VALUES ('<uuid>', 'pro', 'active')
ON CONFLICT (user_id) DO UPDATE SET tier = 'pro', status = 'active';
```

See [BILLING.md](./BILLING.md) §"Manually adjusting a user's tier" for the fuller SQL treatment, including clearing the Stripe IDs on a grandfathered account.

### Cancel a subscription mid-cycle

`POST /api/admin/subscriptions/:id/cancel`. If the row has a `stripe_subscription_id`, the route cancels in Stripe first (immediately, not at period end). A Stripe failure other than `subscription_not_found` aborts with a 502 and leaves the local row untouched; a `subscription_not_found` is treated as already-canceled and the local update proceeds.

The local update is a full downgrade, not just a status flip — it sets `tier='free'`, `status='canceled'`, and nulls `stripe_subscription_id` + `current_period_end`, clearing `cancel_at_period_end`.

### Retry a failed webhook

`POST /api/admin/webhooks/stripe/:id/retry`. **v1 only resets the `processed` / `processed_at` / `processing_error` fields to unprocessed** — it does NOT re-invoke the handler synchronously (that would require extracting `routeStripeEvent` from the webhook route). Stripe's own retry, or a manual resend from the Stripe Dashboard, is what actually re-processes it. The response says so explicitly. Synchronous re-processing is deferred to Sprint 10.5+.

There is no equivalent retry route for GitHub webhooks in v1 — `/api/admin/webhooks/github` is read-only.

### Investigate a user

1. `GET /api/admin/users/:id` — user + subscription + integration count
2. `GET /api/admin/logs?category=<category>` — narrow to the relevant category, with `from`/`to` to bracket the incident window
3. `GET /api/admin/webhooks/stripe` or `.../github` — check webhook events around that window

## Debugging

- Everything routes through `logSystem`, so the `/api/admin/logs` category filter is the primary tool
- Common categories: `admin`, `genesis`, `stripe_webhook`, `github_webhook`, `auth`, `integration`
- Levels: `info`, `warn`, `error`
- Timestamps are stored UTC with timezone (`created_at`); `from`/`to` filters compare against it

## What's not in v1

Deferred to Sprint 10.5+:

- Charts and visualizations on the dashboard
- Bulk operations
- CSV export
- User search by email / name
- Sortable columns
- Real-time log stream (SSE)
- Synchronous webhook re-processing (and a GitHub webhook retry route)
- Admin-granting UI (SQL-only by design in v1)
- Multi-role access — currently a single `is_admin` boolean; a future `user_roles` table would allow read-only vs. mutating admins

## Source code reference

- Middleware: `apps/api/src/middleware/requireAdmin.ts`
- Routes: `apps/api/src/routes/admin.ts`
- Frontend: `apps/web/src/admin/` (`AdminApp`, `AdminEntry`, `sections/`, `shared/`)
- Render-root gate: `apps/web/src/main.tsx`
- Migration: `apps/api/drizzle/0013_sticky_puff_adder.sql` — `is_admin` column
- Related: [BILLING.md](./BILLING.md) for tier/subscription mechanics
