# Sprint 8 — Design System + Auth0 Connector

Branch: sprint/8-design-system-and-auth0
Start date: 2026-06-24
Estimated work: 7-10 days
Product positioning: "AI Connect's UI becomes a first-class feature. Plus 'Just add Auth' for any provisioned project — Auth0 wiring from one wizard, automatically synced to the project's Render env vars."

## Context

Sprint 6 shipped WordPress integration + gated apps. Sprint 7 shipped OpenClaw integration + local mode. Both shipped their own wizard UIs, each with bespoke styling and patterns.

Sprint 8 has two intertwined goals:

1. **Design System foundation** — Shared design tokens, primitive components, and a reusable Wizard pattern. Existing WordPress + OpenClaw wizards refactored onto the new primitives. Establishes UI as a feature.

2. **Auth0 Connector (full version)** — New integration type that validates Auth0 Management API M2M credentials, lists existing applications in the tenant, optionally creates new applications, configures callback URLs based on a provisioned project's Render URL, and syncs `AUTH0_DOMAIN` / `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` to the project's Render env vars during Project Genesis.

Building both in one sprint means the Auth0 wizard becomes the first new consumer of the design system, and the refactored WordPress + OpenClaw wizards stress-test it against existing patterns. Three real wizards on the new primitives validates the design before more features pile on.

## What ships in Sprint 8

In execution order:

### 1. Sprint spec doc (this file)

Single source of truth. Direct commit on branch.

### 2. Design tokens

New apps/web/src/ui/tokens.ts exporting:
- Typography scale (font sizes, line heights, font families)
- Color palette (primary, secondary, accent, semantic colors for success/warning/error/info, neutrals)
- Spacing scale (4px-based, e.g., space-1 = 4px, space-2 = 8px, etc.)
- Animation timings (instant, fast, normal, slow)
- Border radii (sharp, soft, round, pill)
- Shadow scale (sm, md, lg, xl)

Tokens are values, not Tailwind classes. They're the source of truth.

Tailwind config extension in apps/web/tailwind.config.js (or .ts) reads from tokens.ts and extends the theme so existing Tailwind utility classes (e.g., bg-primary-500) map to the tokens.

### 3. Shared component library

New components in apps/web/src/ui/:

- `Button.tsx` — variants (primary, secondary, ghost, danger), sizes (sm, md, lg), loading state, disabled state, icon support
- `Input.tsx` — text input with label, helper text, error state, prefix/suffix slots
- `Modal.tsx` — overlay + content container, close on backdrop click, escape key, focus trap
- `Card.tsx` — basic card with optional header/footer slots
- `Badge.tsx` — small status indicator (success/warning/error/info/neutral variants)
- `Pill.tsx` — rounded badge for status/category labels
- `Wizard.tsx` — multi-step container with step navigation, progress indicator, Back/Next/Cancel buttons, step content slots
- `Toast.tsx` — transient notifications (success/error/info), auto-dismiss

All components export their props as TypeScript types so consumers get autocomplete.

Each component has a corresponding `__demos__/<Component>.demo.tsx` file showing all variants and states.

New /ui route in App.tsx renders the demos as a live components page (only visible to admin users, or behind a `?ui=demo` query string — pick whichever is simplest).

### 4. Refactor WordPressWizard onto the new Wizard primitive

apps/web/src/components/WordPressWizard.tsx — migrate from inline step state machine to using the shared Wizard component. Same six steps, same UX, same flow. Just using new primitives. No functional changes; the smoke test from Sprint 6 should still pass.

### 5. Refactor OpenClawWizard onto the new Wizard primitive

Same treatment for apps/web/src/components/OpenClawWizard.tsx. All six steps now use shared primitives.

After commits 4 and 5, the design system has been validated against two existing real wizards. No surprises remaining for the new Auth0 wizard.

### 6. Auth0 integration type + validator

apps/api/src/lib/integrations/types.ts:
- Extend IntegrationType union with 'auth0'
- Add Auth0Config shape: { domain: string, m2m_client_id: string, m2m_client_secret_vault_id: string }
- Add Auth0Identity shape: { tenant_name, application_count, default_application_id?, default_application_name? }

apps/api/src/lib/integrations/validators/auth0.ts:
- Hits POST https://{domain}/oauth/token with client_credentials grant + audience https://{domain}/api/v2/ to verify M2M creds
- Hits GET https://{domain}/api/v2/clients to list applications, confirm at least basic Management API access
- Returns valid=true with identity on success
- Returns valid=false with actionable errors on common failures:
  - domain_invalid → "Domain {domain} is not a valid Auth0 tenant. Check the URL (e.g., yourtenant.us.auth0.com)."
  - invalid_credentials → "M2M credentials rejected by Auth0. Confirm client_id and client_secret are correct."
  - insufficient_scope → "M2M client lacks 'read:clients' scope. Grant Management API > Applications > Read access in Auth0 dashboard."

### 7. Auth0 client

apps/api/src/lib/integrations/auth0Client.ts:
- Methods: getTenantInfo(), listApplications(), createApplication(name, callbackUrls, allowedLogoutUrls, allowedOrigins), updateApplicationCallbacks(appId, callbackUrls, allowedLogoutUrls, allowedOrigins), getApplication(appId)
- Handles M2M token caching with refresh (tokens expire ~24h)
- Errors typed with Auth0ErrorCode: invalid_credentials, insufficient_scope, rate_limited, application_not_found, application_exists, validation_error

Uses fetch (no Auth0 SDK dependency — keep the surface small).

### 8. Auth0 routes

apps/api/src/routes/integrations.ts (or new auth0.ts if it grows beyond ~200 lines):
- GET /api/integrations/:id/auth0/applications — proxies to auth0Client.listApplications
- POST /api/integrations/:id/auth0/applications — body { name, callback_urls?, allowed_logout_urls?, allowed_origins? }, creates new SPA-type application
- GET /api/integrations/:id/auth0/applications/:appId — returns single app details (including client_id and client_secret for callback configuration)
- PATCH /api/integrations/:id/auth0/applications/:appId/callbacks — updates callback URLs for an existing app

All routes require integration type === 'auth0' and status === 'validated'.

### 9. Project Genesis integration

apps/api/src/lib/projectProvisioning.ts (or wherever provisioning lives):

When provisioning a project, if the user has an Auth0 integration with include_in_projects=true:

1. Call auth0Client.createApplication with name=projectName, callback_urls=[`https://${renderUrl}/callback`], allowed_logout_urls=[`https://${renderUrl}`], allowed_origins=[`https://${renderUrl}`]
2. Get back the new app's client_id and client_secret
3. Add to the new project's Render service env vars (via existing Render API access):
   - `AUTH0_DOMAIN=https://{tenant_domain}/`
   - `AUTH0_CLIENT_ID={new_client_id}`
   - `AUTH0_CLIENT_SECRET={new_client_secret}`
   - `AUTH0_AUDIENCE={project's API audience, default https://api.{projectName}.com}`
4. Log to system_logs that Auth0 was wired into the project
5. If any step fails, log the failure but don't fail the entire provisioning (Auth0 wiring is a bonus, not a hard requirement)

Surface success/failure of the Auth0 wire-up in the project provisioning result returned to the UI so the user can see whether Auth0 was successfully configured.

### 10. Auth0 wizard (built on new design system)

apps/web/src/components/Auth0Wizard.tsx — uses Wizard, Input, Button, Modal, Badge from the new ui/ directory:

- Step 1: Welcome. Explain what Auth0 connector does. Link to Auth0 setup docs.
- Step 2: M2M creds input. Three Input fields (Auth0 domain, M2M Client ID, M2M Client Secret). Helper text explaining how to get M2M creds (Auth0 Dashboard > Applications > APIs > Auth0 Management API > Machine to Machine Applications). Secret stored in Vault, not exposed in subsequent API responses.
- Step 3: Validate. Calls POST /api/integrations with body { integration_type: 'auth0', config: { domain, m2m_client_id, m2m_client_secret } }. Validator hits Auth0 Management API. Success advances; failures map to actionable error messages.
- Step 4: Set default application (optional). If user has existing apps, pick one as default. Otherwise skip ("Apps will be created automatically for projects you provision").
- Step 5: Test connection. List apps to confirm full round-trip works.
- Step 6: Success. Show tenant name + application count + default app (if set). Option to "View Applications" → opens Auth0ApplicationManager.

### 11. Auth0 application manager

apps/web/src/components/Auth0ApplicationManager.tsx — uses Card, Badge, Button:
- List existing apps with name, type (SPA/RegularWeb/M2M/Native), client_id (last 8 chars, full available on click)
- "Create New Application" button → opens modal with name + callback URL fields
- For each app: "View Details" → modal showing all callback URLs, allowed origins, etc.
- For each app: "Set as Default for Projects" → updates the integration's config.default_application_id

### 12. Cloud-mode UI updates

In App.tsx IntegrationsPanel, add Auth0 as a type option. Same pattern as WordPress + OpenClaw — type selector dropdown, wizard launches modal. No cloud-mode gating needed for Auth0 (it's pure API calls, works fine in cloud mode).

### 13. Docs

- docs/AUTH0_CONNECTOR.md — user-facing guide. Prereqs (Auth0 account, Management API M2M app with read:clients + create:clients + update:clients + delete:clients scopes), setup wizard walkthrough, project provisioning behavior, troubleshooting.
- docs/DESIGN_SYSTEM.md — for developers extending AI Connect. Design token usage, component API reference, when to add new tokens vs use existing ones, accessibility checklist.
- docs/sprints/SPRINT_8_TESTING.md — smoke test plan (cloud + Auth0 + design system visual regression).

## Architecture decisions

### Design system uses Tailwind, not a CSS-in-JS solution

AI Connect already uses Tailwind. Switching to CSS-in-JS mid-project is more disruption than value. Tokens drive Tailwind config extension; components use Tailwind utility classes internally.

### Tokens are values, components are presentational

apps/web/src/ui/tokens.ts has no React. apps/web/src/ui/Button.tsx has no business logic. Clean separation: tokens = design language, components = how they're applied.

### No new dependencies for the design system

Components are vanilla React + Tailwind. No Radix UI, no Headless UI, no MUI. Future Sprint can add Radix if accessibility primitives become a real need; for now, hand-rolled is fine.

### Wizard component pattern matches existing convention

The existing WordPressWizard and OpenClawWizard both use {open ? <Wizard/> : null} controlled-by-parent pattern. New Wizard component preserves this. No surprise breaking changes.

### Auth0 M2M creds stored in Vault

Same pattern as other secrets in AI Connect. The client_secret never appears in API responses after creation — only the vault_id is returned. Routes read from vault when needed.

### Auth0 Management API access requires specific scopes

The M2M application the user creates in Auth0 needs at minimum: read:clients (for list), create:clients (for new apps), update:clients (for callback config), delete:clients (optional, for app cleanup). Document this clearly in setup.

### Project Genesis Auth0 wiring is best-effort

If Auth0 app creation fails during provisioning (rate limit, network blip, scope missing), don't fail the whole project provisioning. Log the failure, return success with a warning, let user retry the Auth0 wiring manually from the integration UI.

### Existing wizards get refactored, not rebuilt

WordPressWizard and OpenClawWizard preserve their step content, validation logic, API calls. Only the visual primitives change. Sprint 6 + 7 smoke tests should still pass post-refactor without modification.

## Commit plan

In execution order:

1. Sprint 8 spec doc (this file) — direct commit on branch
2. Design tokens + Tailwind config extension
3. Shared component library (Button, Input, Modal, Card, Badge, Pill, Wizard, Toast) + /ui demo route
4. Refactor WordPressWizard onto new Wizard component
5. Refactor OpenClawWizard onto new Wizard component
6. Auth0 types + validator + Management API client wrapper
7. Auth0 routes (list, create, update callbacks)
8. Project Genesis integration (auto-wire Auth0 to provisioned projects)
9. Auth0 wizard built on new design system
10. Auth0 application manager UI
11. App.tsx integration list updates + docs/AUTH0_CONNECTOR.md + docs/DESIGN_SYSTEM.md
12. docs/sprints/SPRINT_8_TESTING.md

Each step gets its own commit. Branch + PR + merge same as Sprint 6 + 7.

## Deferred to Sprint 9+

Captured here so they don't get lost:

- Stripe connector (Sprint 9)
- AI Connect's own paid tier with Stripe billing (Sprint 9)
- AI Connect's own internal Auth0 management UI (Sprint 9 or 10 — admin convenience, not customer-facing)
- Help center / user manual (Sprint 9 or 10)
- Auth0 user management (list users, create users, password resets) — Sprint 10+
- Multi-account Auth0 integrations (multiple tenants per AI Connect user) — Sprint 10+
- Auth0 connection management (Database vs Social vs Enterprise) — Sprint 10+
- Auth0 Actions / Rules wiring — Sprint 11+
- Auth0 Branding / Universal Login customization — Sprint 11+
- Storybook proper (instead of /ui demo route) — Sprint 9 or 10
- Accessibility audit + WCAG AA compliance — Sprint 9 or 10
- Animation library / micro-interactions — Sprint 10+

## Smoke test plan

Sprint 8 smoke test will verify:

### Design system regression
1. Sprint 6 WordPress wizard still walks through all 6 steps with the same UX
2. Sprint 7 OpenClaw wizard still walks through all 6 steps with the same UX
3. /ui demo route renders all primitives without errors
4. Mobile responsive at 375px width
5. Dark mode (if existing) still works

### Auth0 connector
1. Add Integration → Auth0 type appears in dropdown
2. Wizard step 2: enter valid Auth0 domain + M2M creds → validation succeeds
3. Wizard step 2 with bad domain → validation fails with actionable message
4. Wizard step 2 with bad creds → validation fails with "credentials rejected" message
5. Wizard step 2 with creds missing scope → validation fails with "missing scope" message
6. Wizard step 4: pick default app → integration's default_application_id set correctly
7. Wizard step 6: success shows tenant name + app count
8. Auth0ApplicationManager: list of apps appears
9. "Create New Application" creates an app in Auth0 successfully (visible in Auth0 dashboard)

### Project Genesis Auth0 wiring
1. Provision a new project with Auth0 integration enabled
2. Confirm new Auth0 app created in tenant with project name
3. Confirm callback URLs match the new project's Render URL
4. Confirm AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET are in the project's Render env vars
5. Confirm the new project can actually authenticate users via the new Auth0 app

## Acceptance criteria

Sprint 8 ships when:

- All 12 commits land on master via PR
- All Sprint 8 smoke test items pass
- Sprint 8 SPRINT_LOG entry committed (direct-to-master post-merge)
- Sprint 6 + 7 smoke tests still pass (no regression)
