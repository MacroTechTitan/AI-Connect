# Sprint 10 Smoke Test Plan

Sprint 10 shipped three tracks: the GitHub App connector, the admin panel, and the Help Center. This is the end-to-end test plan.

## Prerequisites

- Sprint 10 branch merged to master OR local checkout at Commit 17
- Migrations 0013, 0014, 0015 applied to AI Connect Supabase (manual, per the established pattern — see [Local dev limitations](#local-dev-testing-limitations))
- Local dev environment: `pnpm --filter @ai-connect/api dev` + `pnpm --filter @ai-connect/web dev`
- At least one user with `is_admin = true` (SQL-only — see [ADMIN.md](../ADMIN.md))
- For GitHub sections: an AI Connect GitHub App installed on a test account or org
- For regression sections: the Sprint 7–9 prerequisites (Auth0 tenant with M2M creds, Stripe test-mode keys + Stripe CLI, OpenClaw Mac mini reachable)

Environment variables on Render (all Sprint 6–9 vars, plus):

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY` (multi-line PEM; literal newlines or `\n` escapes both work — the client normalizes)
- `GITHUB_STATE_SIGNING_KEY`

All six are `z.string().optional()` in `lib/env.ts` — the API boots without them, and the GitHub routes fail at call time rather than at startup. Absence is therefore not a boot-time signal; test B1 is what actually proves they are set.

There is **no `WEB_APP_URL` env var.** The OAuth redirect origin resolves from the request `Origin` header, falling back to the module constant `DEFAULT_WEB_APP_URL = "https://aiconnect.macrotechtitan.com"` (`routes/githubOAuth.ts:23`). This matters for D and E — see [Local dev limitations](#local-dev-testing-limitations).

## A. Migration validation

### A1. Migrations 0013, 0014, 0015 applied

Confirm the three files applied cleanly:

- `0013_sticky_puff_adder.sql` — `users.is_admin`
- `0014_wealthy_yellowjacket.sql` — the GitHub tables + integrations CHECK swap
- `0015_typical_harrier.sql` — `projects.repo_owner_org`

### A2. `users.is_admin`

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'is_admin';
```

Expect `boolean`, `NO` (NOT NULL), default `false`.

### A3. `github_installations` — 11 columns

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'github_installations' ORDER BY ordinal_position;
```

Expect exactly 11 rows: `id` (uuid, PK, `gen_random_uuid()`), `installation_id` (bigint), `user_id` (uuid), `account_login` (text), `account_type` (text), `account_id` (bigint), `repository_selection` (text), `permissions` (jsonb), `suspended_at` (timestamptz, **nullable**), `created_at`, `updated_at` (timestamptz, NOT NULL, default `now()`). Only `suspended_at` is nullable.

Constraints and index:

- UNIQUE `github_installations_installation_id_unique` on `installation_id`
- CHECK `github_installations_account_type_check` — `IN ('User', 'Organization')`
- CHECK `github_installations_repository_selection_check` — `IN ('all', 'selected')`
- FK `github_installations_user_id_users_id_fk` → `users(id)` `ON DELETE cascade`
- Index `github_installations_user_id_idx` on `user_id`

The FK is added inside a `DO $$ ... EXCEPTION WHEN duplicate_object THEN null` block, so a re-run is safe on that statement specifically.

### A4. `github_webhook_events` — 7 columns

Expect exactly 7: `id` (**text** PK — the `X-GitHub-Delivery` UUID as a natural key, not a generated uuid), `event_type` (text), `received_at` (timestamptz, default `now()`), `processed` (boolean, default false), `processed_at` (timestamptz, nullable), `processing_error` (text, nullable), `payload` (jsonb).

Two indexes: `github_webhook_events_event_type_idx`, `github_webhook_events_received_at_idx`. No FKs, no CHECKs.

### A5. `projects.repo_owner_org`

Expect `text`, nullable.

### A6. Integrations type CHECK includes `'github'`

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'integrations_integration_type_check';
```

Expect all 8 values: `'sendgrid', 'openai', 'anthropic', 'wordpress', 'openclaw', 'auth0', 'stripe', 'github'`.

Note that 0014 does an **unguarded `DROP CONSTRAINT`** (no `IF EXISTS`, no DO-block) before re-adding it. If 0014 is ever partially re-run, that statement is the one that fails.

## B. GitHub App authentication

Verifies the client can authenticate as the App and mint installation tokens.

There is **no exported `getAppJwt`.** App-level JWT minting is delegated to `@octokit/app` (`new App({ appId, privateKey })`, `githubClient.ts:83`); no AI Connect code signs the JWT, so the RS256 / 10-minute-expiry claim in the file header comment is Octokit's behavior, not ours, and is not directly assertable. `getInstallationToken` (`:115`) and `getInstallationOctokit` (`:158`) are module-private; `exchangeOAuthCode` (`:461`) is a method on `GithubClient`, not a standalone export. **Test these through observable route behavior, not by importing them.**

### B1. App credentials resolve

With an installation live, `POST /api/integrations/:id/github/test-connection` returns `{ ok: true, account_login, account_type, repo_count }`. A 500 `invalid_credentials` here means the App ID / private key pair is wrong or the PEM did not survive env transport.

### B2. Installation token minted

`GET /api/integrations/:id/github/repositories` returns a repository array — this only succeeds if an installation token was minted successfully.

### B3. Token caching

Call B2 twice in quick succession. The second call must not re-mint. Cache is in-process (`installationTokenCache`, a `Map` keyed by `installation_id`), so it is **per API instance and lost on restart or redeploy** — not a shared cache.

There is no 55-minute constant. Expiry comes from GitHub's `expires_at` on the response, minus `TOKEN_TTL_BUFFER_MS = 5 * 60 * 1000` (`:111`). Since GitHub issues 60-minute tokens, effective TTL is ~55 minutes, but the number is derived, not configured.

### B4. Token refresh after expiry

Not practically testable in a smoke run (requires a ~55-minute wait or clock manipulation). Verify by inspection of `:119` — `if (cached && cached.expiresAt - TOKEN_TTL_BUFFER_MS > now)`.

## C. GitHub webhook

Endpoint: `POST /api/github/webhook`, mounted with `express.raw({ type: "application/json" })` and **no auth middleware** — the signature is the authentication.

### C1. Signature verification

| Request | Expect |
|---------|--------|
| Valid `X-Hub-Signature-256` (HMAC-SHA256 over the raw body with `GITHUB_APP_WEBHOOK_SECRET`) | 200 |
| Invalid signature | 400 `{ error: "invalid_signature" }` |
| Missing signature header | 400 `{ error: "invalid_signature" }` |
| Missing `X-GitHub-Delivery` or `X-GitHub-Event` | 400 `{ error: "missing_headers" }` |
| `GITHUB_APP_WEBHOOK_SECRET` unset on the server | 500 `{ error: "webhook_not_configured" }` |
| Malformed JSON body (valid signature) | 400 `{ error: "invalid_json" }` |

A missing signature and a wrong signature both produce `invalid_signature` — the verifier returns false on absence rather than short-circuiting to a distinct code. The failure logs `signature_verification_failed` with `delivery_id`, `event_type`, `signature_present`, so the two cases are distinguishable in logs even though the response is identical.

The `invalid_signature` response has **no `message` field**, unlike most error responses in the codebase.

### C2. Idempotency

Post the same payload twice with the same `X-GitHub-Delivery`.

- First → 200 `{ received: true }`
- Second → 200 `{ received: true, duplicate: true }`

Note the shape is `{ received: true, duplicate: true }`, not `{ duplicate: true }`. Detection is a Postgres unique-violation (`code === "23505"`) on the `github_webhook_events` text PK, not a pre-read — so the check is atomic. The second post must log `duplicate_event_skipped` and must not re-run the handler.

### C3. Installation lifecycle

| Action | Expected behavior |
|--------|-------------------|
| `installation.created` | Does **not** create a row. If a row already exists (OAuth callback ran first), UPDATE `permissions`, `repository_selection` (defaulting to `"all"`), `suspended_at = null` → logs `installation_created_row_updated`. If no row → logs `installation_created_awaiting_oauth` only. |
| `installation.deleted` | **Hard DELETE** of the `github_installations` row → logs `installation_deleted` |
| `installation.suspend` | Sets `suspended_at = now()` → logs `installation_suspended` |
| `installation.unsuspend` | Sets `suspended_at = null` → logs `installation_unsuspended` |
| `installation.<other>` | Logs `installation_action_unhandled`, 200 |

Row creation happens **only in the OAuth callback** (Section E), never in the webhook. A webhook-first ordering is expected and handled.

Error-handling asymmetry worth knowing when reading logs: `created` and `deleted` **throw** on a missing `installation.id` (surfacing as 500 `handler_failed`, which makes GitHub retry), whereas `suspend` and `unsuspend` silently return.

### C4. `installation_repositories`

`installation_repositories` is logged, not stubbed — logs `installation_repositories_changed` with `action`, `installation_id`, `added`, `removed`. 200, no row mutation.

### C5. Repo activity events stubbed

These nine return 200, log `stub_bot_event` (with `event_type`, `action`, `installation_id`, `repo`), and have no side effects:

`push`, `pull_request`, `issues`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_run`, `check_suite`

### C6. Unknown event types

An unrecognized `X-GitHub-Event` → 200, logs `unhandled_event_type` with `event_type` and `action`. No error.

### C7. Handler failure

A handler throw returns 500 `{ error: "handler_failed", message }` so GitHub retries. A DB insert failure returns 500 `{ error: "db_error" }`.

## D. Install flow

### D1. Install URL returned

Signed-in user calls `GET /api/github/install` (behind `requireAuth` + `requireHydratedUser`).

This returns **JSON, not a 302** — `{ install_url: "https://github.com/apps/ai-connect-app/installations/new?state=<signed>" }`. The frontend calls it via `authedFetch` and navigates the browser itself. App slug is the constant `"ai-connect-app"`.

State is an **HMAC-SHA256 signature**, not a JWT — `${payload}.${base64url(sig)}`, verified with `timingSafeEqual`.

### D2. State signing failure

With `GITHUB_STATE_SIGNING_KEY` unset → 500 `{ error: "state_signing_failed" }`.

### D3. Callback error redirects

The user completes the install on GitHub and returns to `GET /api/github/oauth/callback` (**no auth middleware** — the signed state is the trust anchor).

All errors 302 to `<webOrigin>/settings/integrations?github_error=<reason>`:

| Condition | `github_error` |
|-----------|----------------|
| No `state` param | `missing_state` |
| State fails HMAC verification | `invalid_state` |
| No `installation_id` param | `missing_installation_id` |
| `installation_id` non-finite or `<= 0` | `invalid_installation_id` |
| Installation fetch from GitHub fails | `installation_fetch_failed` |

The last two are **not** in the original spec — verify both. Each has a matching log (`callback_missing_state`, `callback_state_invalid` with `state_prefix`, `callback_missing_installation_id`, `callback_invalid_installation_id`, `installation_fetch_failed`).

## E. OAuth callback

### E1. Best-effort code exchange

- Valid `code` → `githubClient.exchangeOAuthCode` returns an `access_token`
- Invalid/expired `code` → logs `oauth_exchange_failed_but_continuing` and **proceeds anyway**; the installation is still upserted

The exchange is deliberately non-blocking: the installation token, not the user OAuth token, is what the connector actually runs on.

### E2. Row upsert

- New installation → row created, logs `installation_row_created`
- Existing installation → row updated with a fresh permissions snapshot, logs `installation_row_updated`

### E3. Success redirect

302 to `<webOrigin>/settings/integrations?github_installed=1&installation_id=<id>`. The frontend detects the params and opens `GitHubWizard` pre-advanced to step 3.

### E4. Origin resolution

`webOrigin` is `req.headers.origin` when present, else `DEFAULT_WEB_APP_URL`. Since GitHub's redirect is a top-level browser navigation, it carries no `Origin` header — so in practice this **always** lands on the production URL. That is why D and E are prod-verifiable only (see [Local dev limitations](#local-dev-testing-limitations)).

Security note for review, not a test step: the origin is taken from an attacker-controllable header with no allowlist. Worth an allowlist in Sprint 10.5+.

## F. Operational routes

Preconditions: a `github` integration created and validated (`status = 'validated'`), installation live.

### F1. List repositories

`GET /api/integrations/:id/github/repositories` → `{ repositories: [{ id, name, full_name, private, html_url, default_branch, description }] }`

### F2. Create issue

`POST /api/integrations/:id/github/issues`, body `{ owner, repo, title, body, labels }` → 201 `{ number, html_url }`

Validation: 400 `owner_required` / `repo_required` / `title_required`.

### F3. Create pull request

`POST /api/integrations/:id/github/pull-requests`, body `{ owner, repo, title, head, base, body, draft }` → 201 `{ number, html_url }`

Validation adds 400 `head_required` / `base_required`. Requires real PR-able branches in the test repo.

### F4. Test connection

`POST /api/integrations/:id/github/test-connection` → `{ ok: true, account_login, account_type, repo_count }`

### F5. Wizard installation lookup

`GET /api/integrations/github/installation/:installationId` → `{ installation_id, account_login, account_type, repository_selection }`

This route has **hand-written DB checks that shadow the `GithubError` codes of the same name** — its `installation_suspended` returns **400**, not the 403 that the operational routes return, and its `installation_not_found` message differs ("Installation not found or does not belong to you."). Do not treat F5's codes as equivalent to F1–F4's.

### F6. Resolver errors

Shared by F1–F4 (`resolveGithubTarget`):

- 404 `integration_not_found` — bad UUID or not owned by this user
- 400 `wrong_integration_type` — "Integration is type '<type>', expected 'github'."
- 400 `integration_not_validated` — "Integration has status '<status>'. Run validation first."

### F7. GitHub API error mapping

`handleGithubConnectError` maps `GithubError.code` → HTTP status, defaulting to **502** for unmapped codes:

| Code | Status |
|------|--------|
| `installation_not_found` | 404 |
| `installation_suspended` | 403 |
| `repo_not_found` | 404 |
| `permissions_missing` | 403 |
| `invalid_credentials` | 500 |
| `rate_limited` | 429 |
| `invalid_request` | 400 |
| `api_error` | 502 |
| `network_error` | 502 |
| `webhook_signature_invalid` | 400 |

Uninstall the App to exercise `installation_not_found`; suspend it to exercise `installation_suspended`.

## G. Project Genesis with GitHub App

**Path A is unreachable in v1.** It is gated behind `supportsGithubAppPath` per template, and all three v1 templates set it to `false`. This section therefore tests that the gate holds and Path B still works — not that Path A functions.

### G1. No v1 template enables Path A

Confirm all three `TEMPLATE_REPOS` entries in `lib/genesis/types.ts` have `supportsGithubAppPath: false`:

| Key | Template repo |
|-----|---------------|
| `html-js` | `MacroTechTitan/template-html-js` |
| `sveltekit` | `MacroTechTitan/template-sveltekit` |
| `nextjs` | `MacroTechTitan/template-nextjs` |

`steps.ts:161` — `if (!template?.supportsGithubAppPath)` — also catches a legacy/unset `templateChoice`, so old projects take the skip branch too.

### G2. Skip log fires

Provision a project as a user with a validated `github` integration and `include_in_projects = true`. Expect a system log:

- level `info`, source `genesis`
- message: `GitHub App path skipped (template unsupported) for project <projectId>`
- context: `projectId`, `templateChoice` (or `null`), `userHasGithubIntegration: true`

`findUserGithubInstallation` is called on every genesis run purely to populate that one telemetry field — it tracks latent demand for Path A. A `false` here on a user who does have an installation is a real bug.

### G3. Path B still works

`create_github_repo` falls through to `createGithubRepoViaPlatformAndRecordOwner`, which wraps `createGithubRepoViaPlatform` and persists the owner to `projects.repo_owner_org`.

**Correction to the original spec:** Path B does **not** hardcode `MacroTechTitan` as the destination org. It uses the project creator's platform-credential GitHub PAT, and the owner is derived from the API response (`result.resourceId.split("/")[0]`). `MacroTechTitan` is only the **template source** owner in `TEMPLATE_REPOS`. Assert that `repo_owner_org` matches whatever org the configured PAT resolves to — which will be `MacroTechTitan` on the standard operator credential, but that is a property of the credential, not of the code.

### G4. Rollback fork — deferred

Path A rollback (deleting the user-org repo via installation token) is untestable until a template with `supportsGithubAppPath: true` lands. Deferred to Sprint 10.5+.

## H. Admin

### H1. `is_admin` gating

- Non-admin → `GET /api/admin/dashboard` returns 403 `{ error: "admin_required", message: "This action requires admin privileges." }`
- Admin (`is_admin = true`) → 200 with dashboard data
- Unauthenticated → 401 `{ error: "unauthenticated" }`

`requireAdmin` re-reads `is_admin` from the DB per request, so revoking admin takes effect on the **next request** — no logout or token refresh needed. Verify by flipping the flag mid-session.

### H2. All 11 admin routes

Each returns 200 for a real admin. Guard stack on every route: `[requireAuth, requireHydratedUser, requireAdmin]`.

- `GET /api/admin/dashboard`
- `GET /api/admin/users?limit=1&offset=0`
- `GET /api/admin/users/:id` (own id)
- `PATCH /api/admin/users/:id/tier` body `{ tier: 'pro' }` (own id)
- `GET /api/admin/subscriptions`
- `POST /api/admin/subscriptions/:id/cancel` (on the subscription from H6)
- `GET /api/admin/integrations`
- `GET /api/admin/logs`
- `GET /api/admin/webhooks/stripe`
- `POST /api/admin/webhooks/stripe/:id/retry` (on a real event)
- `GET /api/admin/webhooks/github`

`/api/admin/diagnostics` (Sprint 0) lives in the same file but is **not** in this stack — it is gated by `requireDiagnosticsToken`. Confirm it still answers to its bearer token and still rejects an admin session without one.

### H3. Filters and pagination

- `GET /api/admin/users?admins_only=true` → only admins
- `GET /api/admin/subscriptions?tier=pro&status=active`
- `GET /api/admin/integrations?type=github`
- `GET /api/admin/logs?category=admin&level=warn` (plus `from` / `to`)
- `GET /api/admin/webhooks/stripe?event_type=customer.subscription.updated`
- `GET /api/admin/webhooks/github?processed=false`

Pagination is uniform: `parsePagination` clamps `limit` to **1–100** (default 50) and floors `offset` at 0. **Verify `limit=1000` silently returns 100, not an error** — a caller assuming the large limit was honored would miss records.

### H4. Audit logging

`requireAdmin` logs on every decision, source `admin`:

- `admin_access` (info) — every successful hit, with `user_id`, `path`, `method`
- `unauthorized_admin_access` (warn) — every 403, same fields

Mutations add a second entry using **different actor keys** — `admin_user_id` for the actor and `target_user_id` for the affected user (whereas `requireAdmin` uses `user_id`):

- `user_tier_changed` — PATCH tier
- `subscription_force_canceled` — POST cancel
- `stripe_webhook_reset_for_retry` — POST retry

Verify both keys appear, and that "who did this to whom" traces via `admin_user_id`.

### H5. Admin UI render

- `/admin` as non-admin → shell renders, each section's fetch 403s, `SectionError` shows "You don't have admin access. Ask an existing admin to grant it."
- `/admin` as admin → `AdminApp` with sidebar + Dashboard loaded
- `/admin/anything` → same gate (`startsWith("/admin/")`)

The gate is a render-root check in `main.tsx`, not a client router. Unlike `/help`, `/admin` renders **inside** the Auth0 wrapper.

### H6. Admin actions end to end

- **Change tier** — PATCH via UI upserts the `subscriptions` row (sets `tier`, forces `status='active'`); the Users detail reflects it
- **Force cancel** — cancels in Stripe first if `stripe_subscription_id` is set (immediately, not at period end). A Stripe failure other than `subscription_not_found` aborts with 502 and leaves the local row untouched; `subscription_not_found` is treated as already-canceled and proceeds. The local write is a full downgrade: `tier='free'`, `status='canceled'`, `stripe_subscription_id` and `current_period_end` nulled, `cancel_at_period_end` cleared.
- **Retry webhook** — resets `processed` / `processed_at` / `processing_error` only. It does **not** re-invoke the handler. Stripe's own retry (or a manual Dashboard resend) is what re-processes. Confirm the response says so.

There is no GitHub webhook retry route in v1 — `/api/admin/webhooks/github` is read-only.

## I. Admin UI sections

Each of the six renders without error:

- **DashboardSection** — 3 stat cards (Users total/pro/free, Integrations, Projects)
- **UsersSection** — paginated table; row click opens detail; Change Tier works; Cancel Subscription works when `stripe_subscription_id` is present
- **SubscriptionsSection** — tier/status filters; Cancel on active rows
- **IntegrationsSection** — type/status filters; row click shows config JSON
- **LogsSection** — category/level/from/to filters; row expand shows context JSON; "Show older" pages
- **WebhooksSection** — Stripe/GitHub tabs, event_type/processed filters, expandable payloads, Stripe Retry button

Also verify `adminApi.ts` surfaces a typed `AdminApiError` carrying the HTTP status, and that `isAdminForbidden` is what routes the 403 to the friendly `SectionError` rather than a generic failure.

## J. Help Center

### J1. `/help` renders publicly

- Visit `/help` **signed out** → `HelpApp` renders. This is the load-bearing assertion: `/help` is gated at the render root **outside** the Auth0 wrapper. A regression that moves it inside would make it silently auth-gated.
- `/help/anything` → same gate (`startsWith("/help/")`)
- Sidebar shows 5 categories in `CATEGORY_ORDER`: Getting Started, Connectors, Project Genesis, Billing, Advanced
- 12 articles total — 3 getting-started, 5 connectors, 1 project-genesis, 2 billing, 1 advanced

### J2. Article selection and rendering

- Sidebar click → article renders, URL hash updates to the article id
- Headings, code blocks, lists, links all render (marked, GFM on, `breaks: false` — a single newline is **not** a `<br>`)
- Hash sync uses `history.replaceState`, so selecting articles does **not** stack history entries

### J3. XSS sanitization

An article containing a raw `<script>` must be stripped by DOMPurify and never execute. Articles are build-time bundled and low-risk, but this is the assertion that keeps `dangerouslySetInnerHTML` safe. `target` and `rel` are explicitly allowed via `ADD_ATTR` — confirm external links keep `target="_blank"` after sanitization.

### J4. Deep linking

- `/help#stripe` → Stripe article loads
- `/help#nonexistent` **on mount** → falls back to `ARTICLES[0]` (`what-is-ai-connect`) — first in *registry* order, which is not necessarily first in sidebar order
- `/help#nonexistent` **via later `hashchange`** → ignored; the current article stays selected

These two bad-hash paths differ by design. Both fail quietly, so a "link does nothing" report means checking the id against the registry.

Because J2 uses `replaceState`, the back button navigates the hash history the browser recorded — it does not step through in-app selections.

### J5. `?` links from panels

13 `HelpLink` render sites across 12 files, resolving to 8 distinct article ids. Every one must resolve to a real article (no dangling ids) and open `/help#<id>` in a new tab with `target="_blank"` and `rel="noopener noreferrer"`.

| Surface | `articleId` |
|---------|-------------|
| `App.tsx` — Integrations panel | `wordpress` (label "Help — Connectors") |
| `App.tsx` — Projects panel | `project-genesis-overview` |
| `App.tsx` — Settings panel | `what-is-ai-connect` |
| `SubscriptionPanel.tsx` | `upgrading-to-pro` |
| `GitHubWizard` / `GitHubIntegrationManager` | `github` |
| `Auth0Wizard` / `Auth0ApplicationManager` | `auth0` |
| `StripeWizard` / `StripeAccountManager` | `stripe` |
| `OpenClawWizard` / `OpenClawAgentManager` | `openclaw` |
| `WordPressWizard` / `WordPressModuleManager` | `wordpress` |

The four wizards pass `HelpLink` via the Modal `titleAccessory` prop; the managers render it inline in the heading. Both placements need a visual check.

Known cosmetic issue, not a failure: the Integrations panel link is labelled "Help — Connectors" but lands on the WordPress article — there is no connectors-overview article. Four articles (`your-first-project`, `understanding-tiers`, `managing-your-subscription`, `openclaw-local-mode`) have no `?` link and are sidebar-only by design.

## K. Cross-cutting regression

### K1. Sprint 6 — WordPress + Genesis foundations

- WordPress wizard opens and validates
- Project Genesis provisions end to end (Path B)
- SSE event stream still streams

### K2. Sprint 7 — OpenClaw

- Local mode works (needs the Mac mini reachable)
- Cloud-mode agents work
- Message history still rolls at `MAX_HISTORY = 10`, in-memory in `OpenClawAgentManager.tsx` — **frontend state, so a page refresh clears it.** That is v1 behavior, not a regression.

### K3. Sprint 8 — Auth0

- Auth0 wizard opens and validates
- Application creation works
- Genesis Auth0 wiring runs

### K4. Sprint 9 — Stripe Connect + paid tier

- Free tier limits enforced from `FEATURE_LIMITS` in `lib/tiers.ts`: `max_integrations: 2`, `max_projects: 1`, `allowed_integration_types: ["sendgrid", "wordpress"]`. These are **code constants, not DB-driven** — changing them needs a deploy.
- Note the allowed-types list means a free user cannot create a `github` integration at all. Confirm the block message and that the GitHub sections above are exercised as Pro.
- Pro upgrade via Stripe checkout works
- Stripe Connect wizard creates Express accounts
- Genesis Stripe wiring runs
- Grandfathered users unchanged

### K5. Design system

- Sprint 8 tokens consistent across the app
- Wizards still follow the 3-step + `hideFooter` conventions
- Card / Badge / Pill / Button / Input primitives unchanged
- The new admin and help surfaces do not leak styles into the main app tree (both render from separate roots)

## Sprint 10 acceptance

Sprint 10 ships when:

- All Sprint 10 commits merged to master via PR
- Section A (Migration validation) fully passes
- Section B (GitHub App authentication) fully passes
- Section C (GitHub webhook) fully passes
- Section H (Admin) fully passes
- Section J (Help Center) fully passes
- Section K (Cross-cutting regression) fully passes
- Sprint 10 `SPRINT_LOG.md` entry committed direct-to-master post-merge
- Sprints 6, 7, 8, 9 smoke tests still pass (no regression)

Sections D, E, F, G can be verified post-merge on the live system with a real GitHub App installed on a test account.

## Deferrals from Sprint 10 execution

Live smoke-test execution is deferred to a dedicated retroactive session covering Sprints 7–10 together. Sprint 10 ships from a code perspective; live verification needs:

- Real Auth0 tenant with M2M credentials
- Stripe test-mode setup (`STRIPE_SECRET_KEY` `sk_test_`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`) and the Stripe CLI
- A GitHub App installed on a test account, with all six GitHub env vars set on Render
- OpenClaw Mac mini reachable for local mode
- Post-deploy access — the install → callback round trip only completes against the production web origin

Known deferrals to Sprint 10.5+:

- Template scaffolding with `supportsGithubAppPath: true` (unblocks Genesis Path A and its rollback fork)
- An `Origin` allowlist for the OAuth callback redirect
- Synchronous webhook re-processing, and a GitHub webhook retry route
- Admin: charts, bulk operations, CSV export, user search, sortable columns, SSE log stream, admin-granting UI, multi-role access
- Help Center: search, screenshots, article analytics, versioning, multi-language
- Code-splitting `/help` and `/admin` out of the main bundle (currently 600.81 kB, over Vite's 500 kB warning)

## Local dev testing limitations

- **The GitHub install → callback round trip is prod-only.** There is no `WEB_APP_URL` env var to point it locally. `resolveWebOrigin` uses the request `Origin` header and falls back to the hardcoded `DEFAULT_WEB_APP_URL = "https://aiconnect.macrotechtitan.com"`; GitHub's redirect is a top-level navigation carrying no `Origin`, so the fallback always wins. Sections D and E are therefore post-deploy only. Making the origin env-driven with an allowlist is Sprint 10.5+ work.
- **Installation token cache is per-process.** `tsx watch` restarts on every save, clearing it — B3 will appear to fail in dev unless the process is left alone between calls.
- **Migration application remains manual** (paste SQL into the Supabase SQL Editor) — the established pattern since Sprint 6.
- **Webhook testing needs a public URL.** Use a tunnel, or post hand-signed payloads directly at `/api/github/webhook` — the route only checks the HMAC, so a locally constructed request with a valid signature is indistinguishable from GitHub's.
