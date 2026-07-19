# Auth0 connector

The Auth0 connector lets AI Connect auto-wire authentication into projects you provision. Every new project via Project Genesis gets its own Auth0 application, callback URLs configured for the project's Render URL, and `AUTH0_*` credentials synced into the service's env vars — all automatically.

## What it does

Say you have an Auth0 tenant (e.g., `yourtenant.us.auth0.com`) and you provision projects through AI Connect that need authentication. Without the connector, every new project means manually creating an Auth0 application, configuring callback URLs and allowed origins, copying `client_id`, `client_secret`, and domain into env vars, and repeating for every project.

With the connector:
- Connect your Auth0 tenant once (5-step wizard)
- Provision projects normally
- AI Connect creates the Auth0 app, configures callbacks matching the project's Render URL, and syncs the env vars

## Prerequisites

Before adding the Auth0 integration:

### 1. Have an Auth0 tenant

If you don't have one, sign up at `auth0.com` and create a tenant (free for development). Note your tenant domain (e.g., `yourtenant.us.auth0.com`).

### 2. Create a Machine-to-Machine application

In the Auth0 Dashboard: **Applications → Applications → Create Application**. Name it something like "AI Connect Management", choose type **Machine to Machine Applications**, and click Create.

### 3. Authorize it for the Management API

On the same page, select **Auth0 Management API** from the dropdown, click Authorize, and grant these scopes:
- `read:clients` (required — used to validate and list applications)
- `create:clients` (required if you want AI Connect to create apps via the wizard or Project Genesis)
- `update:clients` (required for editing callback URLs)
- `read:client_keys` (required — Project Genesis needs the `client_secret` to sync to Render env vars)

Click Update.

### 4. Note the M2M credentials

On the M2M application's Settings tab, note the Domain, Client ID, and Client Secret (click to reveal — you'll only need it during setup).

## Setup walkthrough

### 1. Add the Auth0 integration

Settings → Integrations → **Add Integration** → **Auth0**. The wizard modal opens.

### 2. Step through the wizard

**Step 1 — Welcome:** Read the prerequisites reminder. Click Continue.

**Step 2 — Credentials:** Paste your Auth0 domain, M2M client ID, and M2M client secret. Click Continue.

**Step 3 — Validate:** AI Connect calls Auth0's Management API to verify the credentials (~2-3 seconds). On success it auto-advances. Common failures:
- "Auth0 rejected the M2M credentials" → double-check the client ID and secret
- "M2M client is missing required scope: read:clients" → grant that scope in the Auth0 dashboard
- "Domain does not look like a valid Auth0 tenant domain" → check the format (no `https://`, no trailing slash)

**Step 4 — Pick default application:** If your tenant has existing applications, pick one as the default. Otherwise click "Skip — new apps will be created per project".

**Step 5 — Done:** A summary shows your tenant, app count, and default app. Click "Manage Applications" to review, or "Done" to close.

## Project Genesis integration

Once the Auth0 integration is set up *and* its "Include in projects" toggle is on, provisioning a new project through Project Genesis will:

1. Run the normal provisioning steps (GitHub repo, Supabase project, Render service)
2. As the final step, run `wire_auth0`
3. Create a new Auth0 application named after the project (a `regular_web` app)
4. Configure callbacks:
   - `${renderUrl}/callback`
   - `${renderUrl}/api/auth/callback`
5. Sync env vars to the Render service:
   - `AUTH0_DOMAIN=https://yourtenant.us.auth0.com/`
   - `AUTH0_CLIENT_ID=<new_client_id>`
   - `AUTH0_CLIENT_SECRET=<new_client_secret>`
   - `AUTH0_AUDIENCE=https://api.${projectSlug}.com` (a placeholder — customize post-provision if needed)

### Best-effort semantics

Auth0 wiring is best-effort. If any step fails (rate limit, network blip, missing scope, Render API failure), the project provisioning itself *still* succeeds. The wiring result appears in the provisioning event stream (`details.auth0_wiring` on the `wire_auth0` event) so the UI can show whether wiring worked.

Typed failure modes:
- `no_integration` — no Auth0 integration with "Include in projects" (silent skip)
- `integration_not_validated` — the integration exists but hasn't been validated
- `vault_read_failed` — could not read the M2M secret from the vault
- `auth0_app_creation_failed` — Auth0 Management API failed (rate limit, missing scope, etc.)
- `render_env_sync_failed` — the app was created but the Render env sync failed (retrieve the secret from the Auth0 dashboard and add it to Render manually)

### Deploy timing note

The `AUTH0_*` env vars are written to the Render service *after* the service is created. Render doesn't auto-redeploy when env vars change, so the new vars take effect on the next deploy. If the project's first deploy already ran before `wire_auth0`, trigger a manual redeploy for the Auth0 vars to take effect.

## Managing applications

From the Integrations panel, click **Manage Applications** on the Auth0 integration row. The application manager shows every app in your tenant on the left, with the selected app's callbacks, logout URLs, and allowed origins on the right. From here you can set a default app, edit callback URLs, or create a new application manually (independent of Project Genesis).

## Security model

- The M2M `client_secret` is stored in AI Connect's Vault (encrypted at rest) and never returned in API responses after creation
- Management API tokens are cached in-process with a 5-minute refresh buffer
- Callbacks and origins on auto-provisioned apps are locked to the specific project's Render URL — no wildcards
- If the M2M credentials leak: rotate them in the Auth0 Dashboard, then update the integration's credential in AI Connect

## Not in v1

- Auto-redeploy of the Render service after `AUTH0_*` env sync
- Multiple Auth0 tenants per user
- Auth0 user management, connections config, Actions/Rules, or branding
- Delete-application UX (deliberately omitted)
- Reusing an existing Auth0 app instead of always creating a new one during Project Genesis
- A real per-project `AUTH0_AUDIENCE` (currently a placeholder)
