# AI Connect GitHub App Connector

The GitHub App connector lets AI Connect create repos, issues, and pull requests on behalf of users in their own GitHub org or account.

Unlike the credential-based connectors (Auth0, Stripe, WordPress), GitHub uses a GitHub App installation model:

- One AI Connect App exists at `github.com/apps/ai-connect-app`
- Users install that App on their org or personal account
- AI Connect authenticates as the App (JWT signed with the private key), then mints short-lived installation tokens to act on the user's repos

There is no user secret in the Vault for this connector — the App private key is AI Connect's, and the user grants access by installing rather than by pasting a token.

## Architecture

### Single-instance GitHub App

There is exactly ONE `ai-connect-app` on GitHub. Users install it on their orgs/accounts. AI Connect stores installation IDs per user in the `github_installations` table. The App slug is hardcoded in `apps/api/src/routes/githubOAuth.ts` (`GITHUB_APP_SLUG`).

### Auth layers

**App-level — JWT signed with the private key (RS256, 10-min TTL):**
- Signed via `GITHUB_APP_PRIVATE_KEY`
- Used for installation management and for minting installation tokens

**Installation-level — short-lived tokens (60-min TTL from GitHub):**
- Minted via the App JWT: `POST /app/installations/{id}/access_tokens`
- Cached in-process per `installation_id`, refreshed 5 minutes before expiry (`TOKEN_TTL_BUFFER_MS`), so an effective ~55-min lifetime
- Used for all repo/issue/PR operations

**OAuth — identity linking only, no repo access:**
- Used during the install flow to identify which AI Connect user installed the App
- NOT used for repo operations

### Webhook

`POST /api/github/webhook`:
- `express.raw({type:'application/json'})` mounted on the route — the raw body is required for signature verification
- Signature verified via `@octokit/webhooks-methods` (HMAC-SHA256) using `GITHUB_APP_WEBHOOK_SECRET`
- Idempotency via the `github_webhook_events` table (PK = `X-GitHub-Delivery` header)
- Handlers dispatched on the `X-GitHub-Event` header, then on `action`

Installation lifecycle handlers (v1):
- `installation.created` → refresh permissions if the row exists, else log-only (the OAuth callback is what creates the row)
- `installation.deleted` → delete the `github_installations` row
- `installation.suspend` → set `suspended_at`
- `installation.unsuspend` → clear `suspended_at`
- any other `installation` action → log-only (`installation_action_unhandled`)

`installation_repositories` (repos added/removed from an installation) is log-only in v1 — repos are fetched on demand from GitHub rather than stored, so there is no local state to reconcile.

Repo activity events (`push`, `pull_request`, `issues`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_run`, `check_suite`) are stubbed as log-only (`stub_bot_event`). Real bot logic ships in Sprint 11+ with the Maximus AI orchestration integration. Unrecognized event types log `unhandled_event_type`.

## Environment variables

All are `optional()` in `apps/api/src/lib/env.ts` so `/health` boots without them in dev; they lazy-fail on first use. All are required in production.

| Var | Purpose |
|-----|---------|
| `GITHUB_APP_ID` | Numeric App ID from github.com/settings/apps/ai-connect-app |
| `GITHUB_APP_CLIENT_ID` | Starts `Iv23li...`. From App settings |
| `GITHUB_APP_CLIENT_SECRET` | Generated on the App settings page |
| `GITHUB_APP_WEBHOOK_SECRET` | Random string, set as the webhook secret in the App config |
| `GITHUB_APP_PRIVATE_KEY` | Full PEM contents including BEGIN/END markers. Multi-line — the env var must preserve newlines (or use `\n` escapes and normalize in code) |
| `GITHUB_STATE_SIGNING_KEY` | Random 32+ byte hex for HMAC-signing the OAuth state parameter (CSRF protection) |

### Setup on the GitHub side

1. Visit github.com/settings/apps → New GitHub App
2. Name: AI Connect App (or a variant if taken — if the slug changes, update `GITHUB_APP_SLUG`)
3. Homepage URL: `https://aiconnect.macrotechtitan.com`
4. Callback URL: `https://api.aiconnect.macrotechtitan.com/api/github/oauth/callback`
5. Webhook URL: `https://api.aiconnect.macrotechtitan.com/api/github/webhook`
6. Webhook secret: generate + save as `GITHUB_APP_WEBHOOK_SECRET`
7. Repository permissions:
   - Administration: Read & write (repo create/delete)
   - Contents: Read & write
   - Issues: Read & write
   - Pull requests: Read & write
   - Metadata: Read
   - Checks: Read & write (for the future CI bot in Sprint 11+)
8. Subscribe to events: Issue comment, Issues, Pull request, Pull request review, Pull request review comment, Pull request review thread, Push
9. Where installable: Any account
10. Create App → note the App ID + Client ID, generate a Client Secret, generate a Private Key (downloads a `.pem`)

Per the secret-handling rules in `CLAUDE.md`, enter these values in the Render dashboard UI — never inline on a command line.

## Database schema

### `github_installations`

Tracks GitHub App installations per user. Migration `0014`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | `gen_random_uuid()` |
| `installation_id` | bigint UNIQUE | GitHub's numeric installation ID |
| `user_id` | uuid FK users(id) ON DELETE CASCADE | Owning AI Connect user |
| `account_login` | text | GitHub org/user login (e.g. `MacroTechTitan`) |
| `account_type` | text CHECK ('User', 'Organization') | |
| `account_id` | bigint | GitHub's numeric account ID |
| `repository_selection` | text CHECK ('all', 'selected') | |
| `permissions` | jsonb | snapshot of granted permissions at install time |
| `suspended_at` | timestamptz | nullable — set on suspend, cleared on unsuspend |
| `created_at`, `updated_at` | timestamptz | default now |

Index: `github_installations_user_id_idx` on `user_id`.

### `github_webhook_events`

Idempotency for GitHub webhooks. Parallel to `stripe_webhook_events`. Migration `0014`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | `X-GitHub-Delivery` header value (natural key) |
| `event_type` | text | `X-GitHub-Event` header value |
| `received_at` | timestamptz | default now |
| `processed` | boolean | default false |
| `processed_at` | timestamptz | nullable |
| `processing_error` | text | nullable, set on handler failure |
| `payload` | jsonb | full event body |

Indexes: `github_webhook_events_event_type_idx`, `github_webhook_events_received_at_idx`.

### `integrations.integration_type` CHECK

Extended in migration `0014` to include `'github'`. Full list: `sendgrid`, `openai`, `anthropic`, `wordpress`, `openclaw`, `auth0`, `stripe`, `github`.

### `projects.repo_owner_org`

Added in migration `0015` (text, nullable). Records which org the repo landed in — the user's org (via the GitHub App path) or `MacroTechTitan` (via the platform PAT). Legacy projects have null. Display/tracking only: the write is best-effort and a failure never fails provisioning.

## Flow: user installs the GitHub App

1. User clicks Add → GitHub in the integrations panel
2. GitHubWizard step 2: `authedFetch('/api/github/install')` returns `{ install_url }` with an HMAC-signed state
3. Browser navigates to `install_url` → `github.com/apps/ai-connect-app/installations/new?state=<signed_state>`
4. User picks the account + repo access on GitHub → clicks Install
5. GitHub redirects to `/api/github/oauth/callback?code=...&state=...&installation_id=...`
6. The callback verifies the HMAC state (CSRF protection, constant-time comparison) and recovers the `user_id`
7. Best-effort OAuth code exchange for the GitHub identity
8. `githubClient.getInstallation(installation_id)` hydrates account details from the App API
9. Upserts the `github_installations` row linking `user_id` ↔ `installation_id`
10. Redirects to `${WEB_APP_URL}/settings/integrations?github_installed=1&installation_id=<id>`
11. Frontend detects the query param and opens the wizard pre-advanced to step 3
12. Wizard POSTs `/api/integrations` with `{integration_type: 'github', config: {installation_id, ...}}`
13. The validator confirms the installation is live via `getInstallation` → integration marked validated

The callback cannot sit behind `requireAuth` — GitHub redirects an unauthenticated top-level browser navigation to it, which is exactly why the signed state carries the user identity. Every failure path (`missing_state`, `invalid_state`, `missing_installation_id`, `invalid_installation_id`, `installation_fetch_failed`) 302-redirects back to the web app with an error param rather than rendering an API error.

## Project Genesis integration

The `create_github_repo` step (`apps/api/src/lib/genesis/steps.ts`) has TWO paths.

**Path A — the user's GitHub App installation:**
1. Look for a validated `github` integration with `include_in_projects = true` and `status = 'validated'`
2. Confirm the installation still exists in `github_installations` and is not suspended
3. Create the repo via an installation token in the user's account/org
4. Persist `repo_owner_org = accountLogin` to the `projects` row

**Path B — the MacroTechTitan platform PAT (legacy, still the default):**
1. The existing flow, preserved byte-for-byte
2. Creates the repo at `github.com/MacroTechTitan/<slug>`
3. Persists `repo_owner_org = 'MacroTechTitan'`

**Path A is GATED behind the per-template `supportsGithubAppPath` flag.** In v1 NO template sets it to `true`, so Path A is effectively unreachable. The reason is concrete: the App path creates an empty `auto_init` repo (App-side template scaffolding is deferred), which would break Render's first deploy. Template scaffolding via installation token is deferred to Sprint 10.5+ or Sprint 11, when template contents get checked out and pushed to the new user repo.

Path A is also defensive at runtime — if the App-based create throws, the step falls back to Path B rather than failing provisioning.

When the gate skips Path A, a `genesis` system log (`GitHub App path skipped (template unsupported) for project <id>`) records `templateChoice` and `userHasGithubIntegration`, tracking latent demand: users who would benefit once scaffolding lands.

Rollback follows the same fork, in `apps/api/src/lib/genesis/orchestrator.ts`:
- Path A repos → `deleteGithubRepoViaInstallation`, which reads `installation_id` out of the step's `details` and calls `githubClient.deleteRepo` (requires `administration:write`)
- Path B repos → the existing platform-PAT deletion logic

Both return the same `{deleted, errorMessage}` shape so the reverse-order rollback loop treats them uniformly. Deletion failures are soft — recorded as `failed_to_rollback`, never thrown.

## Operational routes

All are mounted with `requireAuth` + `requireHydratedUser`; each handler then calls `resolveGithubTarget` to resolve and gate the integration.

- `GET /api/integrations/:id/github/repositories` — lists repos accessible to the installation
- `POST /api/integrations/:id/github/issues` — creates an issue (body: `owner`, `repo`, `title`, `body`, `labels`)
- `POST /api/integrations/:id/github/pull-requests` — creates a PR (body: `owner`, `repo`, `title`, `head`, `base`, `body`, `draft`)
- `POST /api/integrations/:id/github/test-connection` — pings the installation, returns account + repo count
- `GET /api/integrations/github/installation/:installationId` — hydrates installation details for the wizard (used at step 3, before the integration row exists)

Installs happen via the OAuth flow (`routes/githubOAuth.ts`), not here; these routes act on an already-linked installation.

`resolveGithubTarget` gates:
- the integration exists and belongs to the caller
- `integration_type === 'github'`
- `status === 'validated'`

`GithubError` is mapped by `handleGithubConnectError` to HTTP codes:

| `err.code` | HTTP |
|-----------|------|
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

Unknown codes fall through to 502. Non-`GithubError` errors are re-thrown for the global handler.

## Security model

- The App private key is stored server-side only (env var — never in the DB, never returned to the client)
- Installation tokens are minted per-request and cached in-process for ~55 min; they are never persisted
- The OAuth state is HMAC-signed with `GITHUB_STATE_SIGNING_KEY` to prevent CSRF, and verified with a constant-time comparison in `verifyState`
- Webhook signatures are verified via HMAC-SHA256 using `GITHUB_APP_WEBHOOK_SECRET`, against the raw body
- The OAuth code exchange is best-effort — the install still succeeds if identity linking fails
- Users can uninstall on the GitHub side → `installation.deleted` fires → the row is deleted → the next validator run returns `installation_not_found`

## What's not in v1

Sprint 10.5+:
- Template scaffolding via installation token (unlocks Path A for all templates)
- Reconciliation for orphan installations (where the OAuth callback never ran)
- Uninstall UX from AI Connect (currently you must go to GitHub)
- Repo selection UI (add/remove specific repos from an installation)

Sprint 11+:
- Real bot behavior for `push`, `pull_request`, `issues`, `check_run` webhooks (Maximus AI orchestration integration)
- Custom check runs / CI-style bot activity
- Branch protection setup on new repos
- Repo templates from AI Connect (parallel to Render templates)
- Importing existing repos into AI Connect

## Testing

See `docs/sprints/SPRINT_10_TESTING.md` sections B, C, D, E, F, G for the GitHub App smoke tests.

## Source code reference

- Client: `apps/api/src/lib/integrations/githubClient.ts` — App JWT, installation tokens, REST wrappers, webhook signature verification, OAuth exchange
- OAuth state: `apps/api/src/lib/integrations/githubOAuthState.ts` — HMAC-signed state helpers (encode/verify)
- Validator: `apps/api/src/lib/integrations/validators/github.ts`
- Webhook: `apps/api/src/routes/githubWebhook.ts`
- Install flow: `apps/api/src/routes/githubOAuth.ts` — install-flow start + OAuth callback
- Routes: `apps/api/src/routes/integrations.ts` — integration CRUD + operational routes + wizard hydrate endpoint
- Genesis step: `apps/api/src/lib/genesis/steps.ts` — `create_github_repo` with the Path A/B fork + gate
- Genesis rollback: `apps/api/src/lib/genesis/orchestrator.ts`
- Schema: `apps/api/src/db/schema.ts` — `githubInstallations`, `githubWebhookEvents`, `projects.repoOwnerOrg`
- Migrations: `apps/api/drizzle/0014_wealthy_yellowjacket.sql` (GitHub tables + integration_type extend), `0015_typical_harrier.sql` (projects.repo_owner_org)
- Wizard: `apps/web/src/components/GitHubWizard.tsx` + `.css`
- Manager: `apps/web/src/components/GitHubIntegrationManager.tsx` + `.css`
