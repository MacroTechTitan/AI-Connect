# Sprint 10 — Help Center + Admin UIs + GitHub App Connector

Branch: sprint/10-help-center-admin-github-app
Start date: 2026-07-09
Estimated work: 10-14 days
Product positioning: "AI Connect grows up. Users get in-app docs so they can help themselves. Admin (Joseph) gets tools to actually run the product. And AI Connect's biggest single-account bottleneck — Project Genesis pushing to MacroTechTitan's own org — gets solved via GitHub App so users can provision repos into their own orgs."

## Context

Sprint 9 shipped the paid tier + Stripe Connect. AI Connect is now a real product with billing. Sprint 10 addresses three real production gaps that have been deferred every sprint:

**Track A — Help Center / User Manual.**
Deferred since Sprint 6. Users have no in-app docs. All AI Connect knowledge lives in `docs/*_CONNECTOR.md` files in the repo — invisible to end users. Sprint 10 renders these as an in-app help center at `/help` with sidebar navigation and `?` deep links from each panel.

**Track B — Admin UIs.**
No way currently for Joseph (or future admins) to see across all users. Manual SQL queries required to check tier, cancel subscriptions, adjust configs, retry webhooks, view logs. Sprint 10 ships admin dashboards behind an `is_admin` boolean.

**Track C — GitHub App Connector.**
Project Genesis currently uses a MacroTechTitan-owned PAT to create repos in MacroTechTitan's own org. Every user's provisioned project lives under `github.com/MacroTechTitan`. Doesn't scale, doesn't feel right for users. Sprint 10 ships a real GitHub App (github.com/apps/ai-connect-app) users install on their own org. Project Genesis creates repos in the user's org via installation token. Also unlocks issue/PR creation and webhook events for future bot work.

## What ships in Sprint 10

In execution order:

### 1. Sprint spec doc (this file)

Single source of truth. Direct commit on branch.

### 2. Migration 0013 — is_admin column on users

Add `is_admin` boolean column to users table:
- default false
- not null
- No index needed (few admins, small table)

Applied to Supabase manually per pattern.

### 3. Migration 0014 — github_installations table + github_webhook_events table + extend integration_type

Three changes bundled (Drizzle may or may not split):

`github_installations`:
- id (uuid, primary key)
- installation_id (bigint, unique) — GitHub's numeric installation ID
- user_id (fk to users) — which AI Connect user installed it
- account_login (text) — GitHub org/user login (e.g., "MacroTechTitan")
- account_type (text, CHECK: 'User' or 'Organization')
- account_id (bigint) — GitHub's numeric account ID
- repository_selection (text, CHECK: 'all' or 'selected')
- permissions (jsonb) — snapshot of granted permissions
- suspended_at (timestamptz, nullable) — set when installation is suspended
- created_at, updated_at (timestamps)

`github_webhook_events`:
- id (text, primary key) — GitHub delivery ID from X-GitHub-Delivery header
- event_type (text, not null) — X-GitHub-Event header value
- received_at (timestamptz, not null, default now)
- processed (boolean, not null, default false)
- processed_at (timestamptz, nullable)
- processing_error (text, nullable)
- payload (jsonb, not null)
- indexes on event_type + received_at

Extend `integrations.integration_type` CHECK to include 'github'.

Applied to Supabase manually per pattern.

### 4. GitHub SDK setup + githubClient.ts

Install `@octokit/app` (App-level JWT signing + installation token minting) and `@octokit/rest` (REST API wrapper). Also `@octokit/webhooks-methods` for webhook signature verification.

Create apps/api/src/lib/integrations/githubClient.ts with:

- `getAppJwt()` — signs a JWT using GITHUB_APP_PRIVATE_KEY (RS256), 10-minute expiry, returns bearer for App-level API calls
- `getInstallationToken(installationId)` — mints a token via App JWT, caches per-installation with 55-minute TTL (tokens expire in 60min)
- `constructWebhookEvent(rawBody, signature)` — verifies X-Hub-Signature-256 header using GITHUB_APP_WEBHOOK_SECRET
- `GithubClient.getInstallation(installationId)` — App-level, returns installation details
- `GithubClient.getInstallationRepos(installationId)` — installation-level, returns repos App has access to
- `GithubClient.createRepo(installationId, params)` — creates repo in installation's account
- `GithubClient.createIssue(installationId, owner, repo, title, body)` — creates issue
- `GithubClient.createPullRequest(installationId, owner, repo, params)` — creates PR
- `GithubClient.getAuthenticatedUser(oauthToken)` — for OAuth callback flow, identifies which AI Connect user installed
- `GithubClient.exchangeOAuthCode(code)` — trades OAuth code for user token

GithubError typed with codes: `invalid_credentials`, `installation_not_found`, `installation_suspended`, `repo_not_found`, `permissions_missing`, `rate_limited`, `api_error`, `network_error`, `webhook_signature_invalid`.

Env vars added to `apps/api/src/env.ts`:
- `GITHUB_APP_ID` (required in prod)
- `GITHUB_APP_CLIENT_ID` (required in prod)
- `GITHUB_APP_CLIENT_SECRET` (required in prod)
- `GITHUB_APP_WEBHOOK_SECRET` (required in prod)
- `GITHUB_APP_PRIVATE_KEY` (required in prod, multi-line PEM)
- All optional in dev — client throws GithubError on first use if unset

### 5. GitHub webhook endpoint + signature verification + idempotency + Installation handlers

`POST /api/github/webhook`:
- express.raw({type:'application/json'}) mounted BEFORE express.json() for this route
- Signature verified via constructWebhookEvent
- Idempotency via github_webhook_events (PK = X-GitHub-Delivery)
- Handler routing on X-GitHub-Event header

Handlers for v1:
- `installation.created` → upsert github_installations row
- `installation.deleted` → delete github_installations row
- `installation.suspend` / `installation.unsuspend` → toggle suspended_at
- `installation_repositories.added` / `.removed` → no DB change in v1 (repos list fetched on-demand); log for observability
- `push`, `pull_request`, `issues`, `issue_comment`, `pull_request_review`, `check_run` → stubbed handlers that log for future bot work in Sprint 11+

### 6. OAuth callback route

`GET /api/github/oauth/callback`:
- Receives `code` and `state` (state carries the AI Connect user_id for the linking flow)
- Exchanges code for user's OAuth access token via exchangeOAuthCode
- Fetches authenticated GitHub user via getAuthenticatedUser
- Redirects to `${WEB_APP_URL}/settings/integrations?github_installed=1&installation_id=<id>`

Also: `GET /api/github/install` — starts the install flow. Redirects to `https://github.com/apps/ai-connect-app/installations/new?state=<user_id_hmac>`.

State parameter is HMAC-signed with a server secret to prevent CSRF.

### 7. GitHub integration type + validator + routes

Extend types.ts:
- IntegrationType += 'github'
- GithubConfig: { installation_id: number, account_login: string, account_type: 'User' | 'Organization', repository_selection: 'all' | 'selected' }
- GithubIdentity: { installation_id, account_login, account_type, repo_count, permissions_summary }

Validator: verifies installation exists via getInstallation.

Routes (all requireAuth + requireHydratedUser):
- `GET /api/integrations/:id/github/repositories` — list repos the installation has access to
- `POST /api/integrations/:id/github/issues` — create issue (params: owner, repo, title, body)
- `POST /api/integrations/:id/github/pull-requests` — create PR (params: owner, repo, title, body, base, head)
- `POST /api/integrations/:id/github/test-connection` — pings the installation

handleAddIntegration: 'github' is NOT in credentialRequired (no per-user secret; App private key is server-side). Adding a GitHub integration is unusual — it happens as a side effect of the OAuth callback flow, not through the standard wizard. The wizard button just redirects to `/api/github/install`.

### 8. Project Genesis GitHub App wiring

Modify existing `create_github_repo` genesis step to prefer the user's GitHub installation over the MacroTechTitan-owned PAT.

Logic:
1. Look for github integration on the user with `include_in_projects=true` and status='validated'
2. If found: use installation token, create repo in user's org via getInstallationToken → createRepo
3. If not found OR user opted out: fall back to existing PAT flow into MacroTechTitan org

Persist which flow was used to project row (new column `project_owner_org` or reuse `github_repo_full_name` — decide during implementation).

### 9. Subscription bootstrapping for existing users

Not needed for Sprint 10 — Sprint 9 covered subscription grandfathering. GitHub installations bootstrap themselves as users install the App.

### 10. GitHubWizard + GitHubIntegrationManager UI

`apps/web/src/components/GitHubWizard.tsx` — 3 steps:
1. Welcome + explanation ("Install AI Connect App on your GitHub org to let Project Genesis create repos there instead of MacroTechTitan's org")
2. Install button → redirects to `/api/github/install` (which redirects to GitHub)
3. Return step (fires when user comes back from GitHub with `?github_installed=1&installation_id=<id>`) — shows success + "Manage GitHub Integration" button

`apps/web/src/components/GitHubIntegrationManager.tsx` — single-pane panel:
- Header shows GitHub account (login + type Badge)
- Repository list (fetched from GET /api/integrations/:id/github/repositories) as Cards
- Actions:
  - Test Connection
  - Reinstall App (link to https://github.com/apps/ai-connect-app/installations/new)
  - Uninstall (link to user's installations page on github.com)
- Section "Try it" with Create Issue form (owner/repo/title/body) that calls POST /:id/github/issues

App.tsx:
- 'github' added to IntegrationsPanel type selector
- Selecting github + Add opens GitHubWizard
- Integration rows get Manage + Test Connection buttons

### 11. Admin routes + is_admin middleware

`apps/api/src/middleware/requireAdmin.ts`:
- Runs AFTER requireAuth + requireHydratedUser
- Reads `is_admin` from user row
- 403 with `{ error: 'admin_required' }` if false

Admin routes at `/api/admin/*`:
- `GET /api/admin/users` — list users with tier + status + creation date + last sign-in
- `GET /api/admin/users/:id` — single user detail
- `PATCH /api/admin/users/:id/tier` — manually set tier (audit logged)
- `GET /api/admin/subscriptions` — list all subscriptions with filters (tier, status)
- `POST /api/admin/subscriptions/:id/cancel` — force cancel a subscription
- `GET /api/admin/integrations` — list integrations across all users (type filter)
- `GET /api/admin/logs` — paginated system_logs viewer with filters (category, level, from, to)
- `GET /api/admin/webhooks/stripe` — recent stripe_webhook_events with filters (event_type, processed)
- `POST /api/admin/webhooks/stripe/:id/retry` — re-process a webhook event
- `GET /api/admin/webhooks/github` — recent github_webhook_events

All routes use requireAuth + requireHydratedUser + requireAdmin. All mutations audit-logged.

### 12. Admin UI

`apps/web/src/admin/AdminApp.tsx` — the admin dashboard, only accessible at `/admin` and only rendered if user is admin. Non-admins visiting `/admin` see a 403-style message.

Nav sidebar:
- Dashboard (overview stats)
- Users
- Subscriptions
- Integrations
- Logs
- Webhooks

Each section is a component. Uses Sprint 8 design system primitives. Data-heavy tables (using Card + Badge patterns from existing manager components).

Actions:
- Change tier: opens Modal with current tier + new tier dropdown → PATCH
- Cancel subscription: confirmation Modal → POST cancel
- Retry webhook: button on webhook row → POST retry

App.tsx: If user is admin, show "Admin" link in nav (small, subtle). Otherwise hide.

### 13. Help Center — infrastructure

`apps/web/src/help/` directory with:
- HelpCenter.tsx — main /help page with sidebar + article renderer
- HelpArticleRenderer.tsx — markdown → HTML with syntax highlighting
- articles/ — the article content (markdown files ported from docs/*_CONNECTOR.md + new introduction articles)

Article structure:
- `articles/index.ts` exports the article registry (id, title, category, path, content)
- Categories: "Getting Started", "Connectors", "Project Genesis", "Billing", "Advanced"
- Search: v1 has NO search — just categorized sidebar. Sprint 10.5+ adds search.

Article contents (v1):
- Getting Started: What is AI Connect, Your first project, Understanding tiers
- Connectors: WordPress (from docs/WORDPRESS_CONNECTOR.md), Auth0 (docs/AUTH0_CONNECTOR.md), Stripe (docs/STRIPE_CONNECTOR.md), GitHub (new)
- Project Genesis: Overview, Auto-wiring behavior, Best-effort semantics
- Billing: Upgrading to Pro, Managing your subscription (from docs/STRIPE_CONNECTOR.md section 1)
- Advanced: OpenClaw local mode (from docs/LOCAL_MODE.md)

Content is imported at build time (Vite handles markdown imports) — no dynamic fetching.

### 14. `?` help links from each panel

Small `?` icon button next to panel titles. Clicking opens the help center in a new tab at the relevant article. Panels wired:
- IntegrationsPanel → `/help#connectors`
- ProjectsPanel → `/help#project-genesis`
- SettingsPanel → `/help#getting-started`
- SubscriptionPanel → `/help#billing`
- Each connector wizard → deep link to that connector's article

### 15. Docs (existing docs stay canonical for developers)

- docs/GITHUB_CONNECTOR.md — user-facing guide (mirrors STRIPE_CONNECTOR.md and AUTH0_CONNECTOR.md structure)
- docs/ADMIN.md — admin operations guide (how to grant is_admin, common admin tasks, audit log conventions)
- docs/HELP_CENTER.md — for developers: how to add a new article, how to add a `?` link to a panel
- docs/sprints/SPRINT_10_TESTING.md — smoke test plan

## Architecture decisions

### GitHub App is single-instance (one App, many users)

There is ONE `ai-connect-app` on GitHub. Users install it on their orgs/accounts. AI Connect stores installation IDs per user in `github_installations`.

### JWT + installation token flow

App-level JWT signed with private key (10-min TTL). Used to mint per-installation tokens (60-min TTL) via the JWT. Installation tokens cached in-process per-installation with 55-min buffer. Same lazy-init pattern as Stripe SDK from Sprint 9.

### Webhook shares infrastructure pattern with Stripe

Same shape as `/api/stripe/webhook`: express.raw before express.json, signature verification, idempotency via PK conflict on delivery ID, handler dispatch on event header, 200 on success/duplicate, 500 on handler failure (GitHub retries).

### OAuth for identity, App for repo access

The GitHub App has "Request user authorization (OAuth) during installation" enabled. When users install the App, GitHub also returns an OAuth token identifying the user's GitHub account. We use OAuth only to link the installation to an AI Connect user; we use installation tokens (not OAuth tokens) for all repo operations.

### is_admin is a boolean, not a role table

Sprint 10 has ONE admin role (Joseph). Sprint 11+ can migrate to a proper roles table if multi-role becomes real. YAGNI for now.

### Admin UI is hidden by URL, not routing

No client-side route protection — anyone can visit `/admin`, they just see 403 content. Real gate is the backend `requireAdmin` middleware. The client-side is UX polish.

### Help Center content is compile-time imported

Vite's `import.meta.glob` imports all markdown at build time. No runtime fetching. Content is versioned with the code. Sprint 10.5+ could switch to CMS-driven if there's a real reason.

### `?` links open a new tab

Preserves the user's context in the app. They can flip back to the app after reading without losing state. Same pattern as Stripe hosted Checkout returning to `/settings/billing`.

### Project Genesis GitHub app preference is opt-in

Users must add a GitHub integration + toggle include_in_projects for Genesis to use their installation. Default remains the existing PAT flow. Zero risk of breaking Sprint 6-9 provisioning behavior.

## Commit plan

1. Spec doc (this file) — direct commit on branch
2. Migration 0013 (is_admin on users)
3. Migration 0014 (github_installations + github_webhook_events + integration_type extend)
4. GitHub SDK install + githubClient.ts (App JWT + installation token + webhook verification + REST wrappers)
5. GitHub webhook endpoint + signature verification + idempotency + installation handlers
6. OAuth callback route + install-flow start route
7. GitHub integration type + validator + routes (list repos, create issue, create PR, test connection)
8. Project Genesis GitHub App wiring (create_github_repo step prefers user installation)
9. GitHubWizard + GitHubIntegrationManager UI
10. `is_admin` middleware + admin API routes (users, subscriptions, integrations, logs, webhooks)
11. Admin dashboard UI (AdminApp with sidebar + section components)
12. Help Center infrastructure (HelpCenter, HelpArticleRenderer, article registry)
13. Help Center content (port existing docs, write intro articles)
14. `?` help links from each panel
15. docs/GITHUB_CONNECTOR.md
16. docs/ADMIN.md + docs/HELP_CENTER.md
17. docs/sprints/SPRINT_10_TESTING.md

Each step gets its own commit. Branch + PR + merge same as Sprints 6-9.

## Deferred to Sprint 10.5+ / Sprint 11+

- Help Center search — text search across articles
- Help Center content rewritten for non-developer audience (currently ports developer docs verbatim)
- Static hosted docs site (in addition to in-app)
- Article versioning / changelog
- Multi-language docs
- Admin UI: charts/visualizations (currently tables only)
- Admin UI: bulk actions (currently one row at a time)
- Admin UI: export to CSV
- Admin: role-based access (currently boolean is_admin)
- GitHub App: check runs / CI-style bot logic (webhook plumbing shipped, bot behavior deferred to Sprint 11+ where it fits with Maximus AI orchestration)
- GitHub App: repo templates from AI Connect (currently basic createRepo without template)
- GitHub App: branch protection setup on new repos
- GitHub App: sync existing repos into AI Connect (import flow)
- Sprint 8.5 items still deferred: Auto-redeploy Render, multi-tenant Auth0, real per-project AUTH0_AUDIENCE, Auth0 delete UX, search/filter in Auth0 application manager
- Sprint 9.5 items still deferred: Auto-redeploy Render after STRIPE_* sync, per-project Stripe Restricted Keys, embedded Stripe Elements, refund UI, invoice history, custom Stripe onboarding UI, multi-account per Stripe integration, country whitelist, annual billing, promo codes
- Smoke test execution for Sprints 7, 8, 9, 10 — all rolled into one retroactive session post-Sprint 10 merge

## Smoke test plan

Full plan in docs/sprints/SPRINT_10_TESTING.md. Sections cover:

- A: Migration validation (0013 + 0014 applied cleanly)
- B: GitHub App JWT + installation token minting
- C: GitHub webhook — signature verification + idempotency + installation lifecycle
- D: Install flow — user clicks Add GitHub, redirects to GitHub, installs App, redirects back with installation
- E: OAuth callback — user identity linked to installation
- F: List repos, create issue, create PR against a test repo
- G: Project Genesis with GitHub installation — repo created in user's org, not MacroTechTitan
- H: Admin — is_admin boolean gates access, admin routes work, admin UI renders for admin only
- I: Admin actions — change tier, cancel subscription, retry webhook (all audit logged)
- J: Help Center — /help route renders, articles load, sidebar navigation works, `?` links deep-link correctly
- K: Cross-cutting — no regression on Sprints 6-9 features

Sprint 10 acceptance = A + B + C + H + J fully pass. D, E, F, G, I verifiable post-merge on live system.
