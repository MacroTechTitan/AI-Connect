# AI Connect Auth0 Connector

The Auth0 connector lets AI Connect auto-wire authentication into projects you provision. Every new project via Project Genesis gets its own Auth0 application, callback URLs configured for the project's Render URL, and AUTH0_* credentials synced into the service's env vars — all automatically.

## What it does

You have an Auth0 tenant (e.g., `yourtenant.us.auth0.com`). You provision projects through AI Connect that need authentication. Without the connector, every new project would require:

- Manually creating an Auth0 application
- Manually configuring callback URLs, allowed origins, logout URLs
- Manually copying client_id, client_secret, and domain into env vars
- Repeating for every project

With the connector:

- Connect your Auth0 tenant once (5-step wizard)
- Provision projects normally
- AI Connect creates the Auth0 app, configures callbacks matching the project's Render URL, syncs env vars

## Architecture

### Components

**1. Auth0 Management API Client** (`apps/api/src/lib/integrations/auth0Client.ts`)
- Hand-rolled fetch wrapper, no Auth0 SDK dependency
- Handles Machine-to-Machine (M2M) token caching with auto-refresh (5min buffer before expiry)
- Methods: `getManagementToken`, `listApplications`, `getApplication`, `createApplication`, `updateApplicationCallbacks`, `getTenantInfo`, `verifyScopes`

**2. Validator** (`apps/api/src/lib/integrations/validators/auth0.ts`)
- Normalizes domain (strips `https://` and trailing slash)
- Validates domain shape (matches `*.auth0.com`, `*.us.auth0.com`, `*.eu.auth0.com`, `*.au.auth0.com`)
- Fetches Management API token to verify M2M creds work
- Checks required scope: `read:clients`
- Lists applications to confirm Management API access
- Returns identity with tenant name, application count, granted scopes

**3. Routes** (`apps/api/src/routes/integrations.ts`)
- `GET /api/integrations/:id/auth0/applications` — list apps (client_secret stripped)
- `GET /api/integrations/:id/auth0/applications/:appId` — single app with full details
- `POST /api/integrations/:id/auth0/applications` — create new application
- `PATCH /api/integrations/:id/auth0/applications/:appId/callbacks` — update URLs
- `PATCH /api/integrations/:id/auth0/default-application` — set integration's default app id

**4. Project Genesis Wiring** (`apps/api/src/lib/genesis/auth0Wiring.ts`)
- Runs as the final step of project provisioning
- Best-effort: never fails the project provisioning even if Auth0 wiring fails
- Creates a `regular_web` Auth0 application named after the project
- Configures callbacks: `${renderUrl}/callback` and `${renderUrl}/api/auth/callback`
- Syncs `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE` to Render env vars

**5. Frontend** (`apps/web/src/components/`)
- `Auth0Wizard.tsx` — 5-step connection wizard (Welcome → Credentials → Validate → Pick App → Done)
- `Auth0ApplicationManager.tsx` — panel for managing apps in the tenant

## Prerequisites

Before adding the Auth0 integration in AI Connect:

### 1. Have an Auth0 tenant

If you don't have one: sign up at `auth0.com`, create a tenant (they're free for development). Note your tenant domain (e.g., `yourtenant.us.auth0.com`).

### 2. Create a Machine-to-Machine application

In the Auth0 Dashboard:
- **Applications → Applications → Create Application**
- Name: "AI Connect Management" (or similar)
- Type: **Machine to Machine Applications**
- Click Create

### 3. Authorize the M2M app for the Management API

After creation, on the same page:
- Select "Auth0 Management API" from the API dropdown
- Click Authorize
- On the permissions selector, grant these scopes:
  - `read:clients` (required — used by validator and list route)
  - `create:clients` (required if you want AI Connect to create apps via the wizard or Project Genesis)
  - `update:clients` (required for editing callback URLs)
  - `read:client_keys` (required — Project Genesis needs client_secret to sync to Render env vars)
- Click Update

### 4. Note the M2M credentials

On the M2M application's Settings tab, note:
- Domain (e.g., `yourtenant.us.auth0.com`)
- Client ID
- Client Secret (click to reveal — you'll only need it during setup)

## Setup walkthrough

### 1. Add Auth0 integration in AI Connect

In AI Connect → Settings → Integrations:
- Click "Add Integration"
- Select "Auth0" from the type dropdown
- Click Add — the Auth0 wizard modal opens

### 2. Step through the wizard

**Step 1 — Welcome:** Read the prerequisites reminder. Click Continue.

**Step 2 — Credentials:** Paste your Auth0 domain, M2M client_id, and M2M client_secret. Click Continue.

**Step 3 — Validate:** AI Connect calls Auth0's Management API to verify the credentials work. Takes ~2-3 seconds. On success, auto-advances to Step 4.
- If it fails: check the error message. Common issues:
  - "Auth0 rejected the M2M credentials" → double-check client_id and client_secret
  - "M2M client is missing required scope: read:clients" → grant that scope in the Auth0 dashboard
  - "Domain does not look like a valid Auth0 tenant domain" → check the format (no `https://`, no trailing slash)

**Step 4 — Pick default application:** If your tenant has existing applications, pick one as the default for AI Connect's future references. Click "Use as Default". If not, click "Skip — new apps will be created per project".

**Step 5 — Done:** Summary shows tenant, app count, and default app. Click "Manage Applications" to review apps immediately, or "Done" to close.

## Project Genesis integration

Once the Auth0 integration is set up AND its "Include in projects" toggle is on, provisioning a new project through Project Genesis:

1. Runs the normal provisioning steps (GitHub repo, Supabase project, Render service)
2. As the final genesis step, `wire_auth0` runs
3. Creates a new Auth0 application named after the project (app_type: `regular_web`)
4. Configures callbacks:
   - `${renderUrl}/callback`
   - `${renderUrl}/api/auth/callback`
5. Syncs env vars to the Render service:
   - `AUTH0_DOMAIN=https://yourtenant.us.auth0.com/`
   - `AUTH0_CLIENT_ID=<new_client_id>`
   - `AUTH0_CLIENT_SECRET=<new_client_secret>`
   - `AUTH0_AUDIENCE=https://api.${projectSlug}.com` (placeholder — customize post-provision if needed)

### Best-effort semantics

Auth0 wiring is best-effort. If any step fails (rate limit, network blip, missing scope, Render API failure), the project provisioning itself STILL succeeds. The wiring result is included in the provisioning event stream (details.auth0_wiring on the wire_auth0 event) so the UI can surface whether wiring succeeded.

Failure modes returned as typed results:
- `no_integration` — user has no Auth0 integration with include_in_projects=true (silent skip, not really a failure)
- `integration_not_validated` — Auth0 integration exists but hasn't been validated
- `vault_read_failed` — could not read M2M secret from vault
- `auth0_app_creation_failed` — Auth0 Management API failed (rate limit, missing scope, etc.)
- `render_env_sync_failed` — Auth0 app was created but Render env sync failed (retrieve secret from Auth0 dashboard and add to Render manually)

### Deploy timing note

The AUTH0_* env vars are written to the Render service AFTER the service was created. Render does not auto-redeploy on env var changes — the new vars take effect on the next deploy. If the project's first deploy already succeeded before wire_auth0 ran, you'll need to trigger a manual redeploy for the Auth0 env vars to take effect. Sprint 8.5+ will add auto-redeploy.

## Managing applications

From the Integrations panel, click "Manage Applications" on the Auth0 integration row. The application manager shows:

- Left pane: all applications in your Auth0 tenant, with badges for app_type and "Default" pill
- Right pane: selected app's full details (callbacks, logout URLs, allowed origins, web origins)

Actions:
- "Set as Default" — updates the integration's default_application_id (which future features may reference)
- "Edit Callback URLs" — modal to update callbacks/allowed_logout_urls/allowed_origins/web_origins on an existing app
- "Create New Application" — modal to create a new app manually (independent of Project Genesis)

## Security model

- M2M client_secret is stored in AI Connect's Vault (Supabase Vault, encrypted at rest)
- Secret is never returned in API responses after creation — routes fetch from vault when needed
- Management API tokens are cached in-process (per (domain, client_id) tuple) with 5min refresh buffer
- Callbacks/origins on auto-provisioned apps are locked to the specific project's Render URL — no wildcards
- If the M2M credentials leak: rotate them in Auth0 Dashboard, then update the integration's credential in AI Connect

## What's not in v1

Deferred to Sprint 8.5+ or later:

- Auto-redeploy of Render service after AUTH0_* env sync
- Multi-tenant Auth0 setups (multiple Auth0 tenants per user)
- Auth0 user management (list users, create users, password resets)
- Auth0 connections config (Database vs Social vs Enterprise)
- Auth0 Actions / Rules
- Auth0 Branding / Universal Login customization
- Delete application UX (Auth0 API supports it, UX deliberately omitted from v1)
- Application secret regeneration
- Re-using existing Auth0 apps instead of always creating new during Project Genesis
- Real per-project AUTH0_AUDIENCE (currently a `https://api.${slug}.com` placeholder)

## Source code reference

- Types: `apps/api/src/lib/integrations/types.ts`
- Client: `apps/api/src/lib/integrations/auth0Client.ts`
- Validator: `apps/api/src/lib/integrations/validators/auth0.ts`
- Routes: `apps/api/src/routes/integrations.ts` (the `handle*Auth0*` handlers — search for `Auth0`)
- Genesis wiring: `apps/api/src/lib/genesis/auth0Wiring.ts`
- Wizard: `apps/web/src/components/Auth0Wizard.tsx`
- Application manager: `apps/web/src/components/Auth0ApplicationManager.tsx`
- Migration: `apps/api/drizzle/0009_*.sql` (extends integration_type CHECK to include 'auth0')
