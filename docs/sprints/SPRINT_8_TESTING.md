# Sprint 8 Smoke Test Plan

Sprint 8 shipped two intertwined features: the design system foundation and the Auth0 connector. This is the end-to-end test plan to verify before declaring Sprint 8 done and running the acceptance criteria.

## Prerequisites

- Sprint 8 branch merged to master OR local branch checkout at Commit 12
- Migration 0009 applied to AI Connect Supabase (`integration_type` CHECK includes `'auth0'`) — verified via SELECT on `pg_get_constraintdef`
- Local dev environment: `pnpm --filter @ai-connect/api dev` + `pnpm --filter @ai-connect/web dev`
- For Auth0 sections: an Auth0 tenant + M2M application with these Management API scopes:
  - `read:clients`
  - `create:clients`
  - `update:clients`
  - `read:client_keys`
- Auth0 M2M credentials on hand: domain, client_id, client_secret

## A. Design System regression

Verifies Sprints 6-7 still work post-refactor (Commits 4-5 refactored WordPress and OpenClaw wizards onto new primitives).

### A1. /ui demo route renders
- Visit `/ui` (or app URL with `?ui=demo` query param)
- ✓ Pass: All 8 primitive sections render (Button, Input, Modal, Card, Badge, Pill, Wizard, Toast) with no console errors
- ✓ Pass: Modal demo — click "Open Modal" button, modal opens, Tab cycles focus within modal, Escape closes, backdrop click closes
- ✓ Pass: Toast demo — click each variant button (success/error/info/warning), toast appears bottom-right, auto-dismisses after ~4s
- ✓ Pass: Wizard demo — the hideFooter example shows step content owning its actions (no default Back/Continue)

### A2. WordPress wizard still works
- Settings → Integrations → Add Integration → WordPress
- ✓ Pass: Wizard modal opens with new design system chrome
- ✓ Pass: Step 1 Welcome → Continue
- ✓ Pass: Step 2 Download Plugin — click button, .zip downloads
- ✓ Pass: Step 3 Install — Continue
- ✓ Pass: Step 4 Get Token — Continue
- ✓ Pass: Step 5 Connect — inputs for Site URL + Plugin Token render as new Input primitives, "Test Connection" button is inline (hideFooter pattern), Back and Cancel are ghost buttons
- ✓ Pass: With valid Sprint 6 credentials, connection succeeds and advances to Step 6
- ✓ Pass: Step 6 Success shows "Add Your First Module" primary + "Done" ghost

If this step passes: the Sprint 6 WordPress integration is not regressed.

### A3. OpenClaw wizard still works (local mode required)
- Requires local mode setup per `docs/LOCAL_MODE.md`
- Settings → Integrations → Add Integration → OpenClaw
- ✓ Pass: Wizard modal opens with new design system chrome
- ✓ Pass: Step 1 Welcome with security warning callout → Continue
- ✓ Pass: Step 2 Bridge Path — Input with placeholder, Continue disabled while empty (canGoNext gating)
- ✓ Pass: Step 3 Discover — auto-runs on entry (not double-fires under React.StrictMode), shows progress, auto-advances on success or shows Retry + Back on error
- ✓ Pass: Step 4 Pick Agent — agents render as Cards (elevated when selected), Badges show "Default" / "Selected"
- ✓ Pass: Step 5 Test — Send button primary inline, reply appears, Continue button becomes visible
- ✓ Pass: Step 6 Success shows Done + Manage Agents

If this step passes: the Sprint 7 OpenClaw integration is not regressed.

### A4. Mobile responsive
- Resize browser to 375px width
- ✓ Pass: All wizards render without horizontal scrolling
- ✓ Pass: Buttons remain tappable (min 44px height maintained)
- ✓ Pass: Modals don't overflow viewport

## B. Auth0 connector — setup flow

Requires migration 0009 applied + Auth0 tenant with M2M app configured per prerequisites.

### B1. Wizard opens
- Settings → Integrations → Add Integration → "Auth0" option appears in type dropdown
- ✓ Pass: Auth0 is NOT gated behind local mode (unlike OpenClaw)
- ✓ Pass: Click Add → Auth0Wizard modal opens with Welcome step

### B2. Welcome → Credentials
- Step 1 Welcome describes prerequisites (M2M app + 4 scopes)
- Click Continue
- Step 2 shows three Inputs: Auth0 domain, M2M Client ID, M2M Client Secret
- ✓ Pass: Continue button disabled until all three fields have content
- ✓ Pass: Client Secret input is type=password (visible dots, not text)

### B3. Validation success path
- Enter valid domain (e.g., `yourtenant.us.auth0.com`), Client ID, Client Secret
- Click Continue → Step 3 Validate
- ✓ Pass: Loading state shows "Verifying credentials with Auth0..."
- ✓ Pass: Within 3-5 seconds, auto-advances to Step 4
- ✓ Pass: Backend logged the integration row as status='validated' (check Supabase → integrations table)

### B4. Validation error paths
Test each of these separately (rebuild integration each time — go back to Step 2, edit fields):

- **Bad domain format** (e.g., `https://yourtenant.us.auth0.com/`):
  - ✓ Pass: Domain gets normalized (strips protocol + slash) OR shows error "Domain format looks wrong. Expected: yourtenant.us.auth0.com"

- **Invalid client credentials** (correct domain, wrong client_id or client_secret):
  - ✓ Pass: Shows message like "Auth0 rejected the M2M credentials. Check client_id and client_secret are correct..."
  - ✓ Pass: "Retry" button available; "Back" returns to Step 2 for edits

- **M2M missing read:clients scope** (temporarily revoke it in Auth0, re-run wizard):
  - ✓ Pass: Shows message like "M2M client is missing required scopes: read:clients. Grant these in Auth0 Dashboard..."

- **Network/timeout**: Simulate by pointing at nonexistent domain (e.g., `nonexistent.us.auth0.com`):
  - ✓ Pass: Shows Auth0Error message from validator

### B5. Pick default application
- Step 4 lists all applications in tenant (or empty state if tenant has none)
- ✓ Pass: Applications render as Cards with app_type Badge (variant matches type)
- ✓ Pass: Clicking a card highlights it (elevated variant)
- ✓ Pass: "Use as Default" button appears when selected
- ✓ Pass: Click "Use as Default" → PATCH .../default-application → advances to Step 5
- ✓ Pass: Or click "Skip" → advances to Step 5 without setting default

### B6. Done step
- Step 5 shows summary Card with tenant, app count, and default app (or "None")
- ✓ Pass: "Manage Applications" button primary
- ✓ Pass: "Done" button ghost
- ✓ Pass: Click Done → wizard closes, integration appears in list with "auth0" type badge
- ✓ Pass: Description shows "Default app: {name}" (or "{count} apps" / "Ready for new projects")

## C. Auth0 application manager

Requires B1-B6 completed.

### C1. Open manager
- Click "Manage Applications" on the Auth0 integration row (or "View Applications" from wizard Step 5)
- ✓ Pass: Auth0ApplicationManager panel renders inline
- ✓ Pass: Top bar shows "Auth0 Applications" + tenant domain + Close
- ✓ Pass: Left pane shows application list with Cards, Badges, Pills
- ✓ Pass: Right pane shows empty state "Select an application to view details"

### C2. View application details
- Click an application card in the left pane
- ✓ Pass: Card becomes elevated + selected
- ✓ Pass: Right pane shows: full name, app_type Badge, Default Pill (if default), full client_id with Copy button, callback URLs list, allowed logout URLs list, allowed origins list, web origins list
- ✓ Pass: Click Copy button on client_id → copies to clipboard (visible in browser dev tools clipboard)

### C3. Set as default
- Select a non-default application
- ✓ Pass: "Set as Default" button primary is enabled
- ✓ Pass: Click Set as Default → button shows loading state, then success
- ✓ Pass: Selected app gets Default Pill
- ✓ Pass: Previously-default app loses Default Pill
- ✓ Pass: Integration row description updates to show new default

### C4. Edit callback URLs
- Select any application
- Click "Edit Callback URLs"
- ✓ Pass: Modal opens with three textareas prefilled with current URLs (Callback URLs, Allowed logout URLs, Allowed web origins — the web-origins field seeds both allowed_origins and web_origins on save)
- Modify a URL (e.g., add a new one on a new line)
- Click Save
- ✓ Pass: Modal closes, right pane refreshes to show updated URLs
- ✓ Pass: PATCH .../callbacks was called (verify in Network tab)
- ✓ Pass: The change is reflected in Auth0 dashboard

### C5. Create new application
- Click "Create New Application" at bottom of left pane
- ✓ Pass: Modal opens with Name, Description, App type radios (Regular Web selected by default), Callback URLs, Logout URLs, Web Origins textareas
- Fill in: Name = "Sprint 8 Test App", app_type = Regular Web, Callbacks = "https://example.com/callback"
- Click Create
- ✓ Pass: New application appears in left pane list
- ✓ Pass: New app appears in Auth0 dashboard
- ✓ Pass: Modal closes on success

### C6. Error handling on create
- Try to create another app with the same name
- ✓ Pass: Shows message like "An application with this name already exists. Try a different name."
- Try to create an app with empty name
- ✓ Pass: Create button disabled OR shows validation error

## D. Project Genesis auto-wiring

Requires B1-B6 completed AND Project Genesis platform credentials configured (GitHub, Render, Supabase).

### D1. Auth0 integration marked include_in_projects
- On the Auth0 integration row, toggle "Include in projects" ON
- ✓ Pass: Toggle persists (Supabase → integrations row has `include_in_projects=true`)

### D2. Provision a new project
- Click "New Project" (or wherever Project Genesis is triggered)
- Fill in name (e.g., "sprint-8-test") and pick a template
- Provision
- ✓ Pass: Standard provisioning steps run (GitHub repo, Supabase project, Render service)
- ✓ Pass: One of the final genesis steps in the SSE event stream is `wire_auth0`
- ✓ Pass: `wire_auth0` reports `status: 'succeeded'` (even if the internal Auth0 wiring failed — best-effort)

### D3. Verify Auth0 app was created
- In Auth0 dashboard → Applications
- ✓ Pass: A new application appears with the project name (e.g., "sprint-8-test")
- ✓ Pass: app_type is "Regular Web Application"
- ✓ Pass: Callback URLs include `{renderUrl}/callback` and `{renderUrl}/api/auth/callback`
- ✓ Pass: Allowed origins include the Render URL

### D4. Verify Render env vars synced
- In Render dashboard → the new project's service → Environment
- ✓ Pass: `AUTH0_DOMAIN=https://yourtenant.us.auth0.com/`
- ✓ Pass: `AUTH0_CLIENT_ID` matches the new Auth0 app's client_id
- ✓ Pass: `AUTH0_CLIENT_SECRET` matches the new app's client_secret
- ✓ Pass: `AUTH0_AUDIENCE=https://api.{project-slug}.com`

### D5. Best-effort failure modes
Test at least one failure mode:

**Failure mode 1: Auth0 M2M missing create:clients**
- Temporarily revoke `create:clients` from the M2M in Auth0 dashboard
- Provision a new project
- ✓ Pass: Project provisioning succeeds fully (GitHub repo + Supabase + Render service all created)
- ✓ Pass: `wire_auth0` step reports `status: 'succeeded'` but `details.auth0_wiring.success: false` with `reason: 'auth0_app_creation_failed'`
- ✓ Pass: Message includes actionable text about missing scope
- Restore the scope in Auth0 for subsequent tests

**Failure mode 2: No active Auth0 integration**
- Turn OFF "Include in projects" on the Auth0 integration
- Provision a project
- ✓ Pass: `wire_auth0` reports `details.auth0_wiring.reason: 'no_integration'`
- ✓ Pass: Project provisioning succeeds normally

### D6. Deploy timing note
- After D2 completes, click the Render service to check its deploy status
- ✓ Pass: The AUTH0_* env vars are present in Environment tab
- ⚠️ Known: The AUTH0_* env vars take effect on the NEXT deploy, not the first deploy that ran during provisioning. Trigger a manual redeploy to activate them.
- Sprint 8.5+ will add auto-redeploy after Auth0 env sync

## E. Cross-cutting

### E1. All three wizards use same primitives
- Compare visually: WordPressWizard vs OpenClawWizard vs Auth0Wizard
- ✓ Pass: All use the same Modal chrome (same rounded corners, shadow, backdrop)
- ✓ Pass: All use the same Button variants (same shape, colors, hover behavior)
- ✓ Pass: All use the same Input styling (same border, focus ring, label positioning)
- ✓ Pass: All use the same Wizard step indicator

Confirms the design system foundation is being used consistently.

### E2. No regressions on existing integrations
- Cycle through: SendGrid, OpenAI (with a provider key), Anthropic (with a provider key)
- ✓ Pass: Each can still be added via the inline form (they didn't get wizards; forms should render with new Input primitives if App.tsx uses them, otherwise original CSS)

### E3. Cloud vs Local mode behavior consistent
- Cloud mode: `curl -s https://api.aiconnect.macrotechtitan.com/health` returns `local_mode: false`
- Local mode: `curl -s http://localhost:8080/health` returns `local_mode: true` (the API's default PORT is 8080; adjust if you set PORT differently)
- ✓ Pass: Auth0 works in BOTH modes (no local-only gating)
- ✓ Pass: OpenClaw is gated in cloud mode ("Local mode only" pill + disabled Manage button)

## Sprint 8 acceptance

Sprint 8 ships when:

- All Sprint 8 commits (1-12 + WordPress docs) merged to master via PR
- Sections A (design system regression) + B (Auth0 setup) + C (application manager) fully pass
- Section D (Project Genesis wiring) at least D1-D4 pass on a real provisioned project
- Section E (cross-cutting) passes
- Sprint 8 SPRINT_LOG.md entry committed direct-to-master (post-merge)
- Sprint 6 + 7 smoke tests still pass (no regression)

Known deferrals to Sprint 8.5+:
- Auto-redeploy of Render service after AUTH0_* env sync (D6)
- Auth0 delete application UX
- Multi-tenant Auth0 setups
- Real per-project AUTH0_AUDIENCE (currently a placeholder)
- Search/filter applications in manager
- Auth0 user management (list users, create, password resets)
- Auth0 connections config, Actions/Rules, Universal Login branding
