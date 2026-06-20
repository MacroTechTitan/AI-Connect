# Sprint 6 — Build and Ship (Integration Foundation + WordPress Gated Apps)

Branch: sprint/6-build-and-ship
Start date: 2026-06-13
Estimated work: 7-9 days
Product positioning: "AI Connect lets you take any app from any builder (Lovable, Replit, v0, Cursor, hand-coded, AI Connect templates) and ship it as a gated section of your WordPress site, with MemberPress tier checks. No code, no DevOps, no SSL drama."

## Context

Sprint 4-5.7 shipped Project Genesis — AI Connect can provision a working Express app at *.onrender.com in ~3 minutes from a click. That's the "provision new infrastructure" pillar.

Sprint 6 adds the "integrate with existing services" pillar. Users connect third-party services (SendGrid, OpenAI, Anthropic, WordPress) to AI Connect, and AI Connect uses those credentials to make their projects more capable.

The headline feature is WordPress gated apps with MemberPress: install an AI Connect WordPress plugin on the user's WP site, then configure modules that embed external apps (built with any tool) as MemberPress-gated WordPress pages.

## What ships in Sprint 6

In order of priority (ship-by-priority — if we run out of runway, cut from the end):

### 1. Integration UI pattern foundation
- New "Integrations" panel in AI Connect frontend (parallel to "Hosting connections")
- Backend table `integrations` storing per-user integration configurations
- Generic credential storage via existing Vault pattern
- One per-user instance of each integration (MVP — multi-account deferred)
- Integration types registered server-side: sendgrid, openai, anthropic, wordpress

### 2. SendGrid integration
- User adds SendGrid API key in Integrations panel
- Credential stored in Vault, ID stored in integrations.credential_id
- Validation: ping SendGrid /v3/user/account on add to verify the key
- Sprint 5's createRenderService gains an optional "Include integrations" toggle — when enabled, AI Connect pushes SENDGRID_API_KEY to Render at create time alongside existing env vars

### 3. OpenAI per-project injection
- Sprint 2's BYOAI provider keys (provider_keys table) get a new "include in projects" flag
- When enabled, createRenderService pushes OPENAI_API_KEY to Render at create time
- No new credential storage — reuses existing provider_keys
- UI: toggle in Integrations panel labeled "Include OpenAI key in new projects"

### 4. Anthropic per-project injection
- Same pattern as OpenAI. ANTHROPIC_API_KEY pushed at create time.
- Same toggle UI pattern.

### 5. WordPress AI Connect plugin v1
- New sub-folder in main repo: wp-plugin/ai-connect/
- PHP plugin: ~300-500 lines
- Endpoints:
  - GET /wp-json/ai-connect/v1/ping — verifies plugin is installed and token is valid
  - GET /wp-json/ai-connect/v1/status — returns WP version, active theme, plugin version, MemberPress installed (yes/no), MemberPress version if installed
  - GET /wp-json/ai-connect/v1/modules — lists configured modules
- Plugin admin settings page in WP admin: "AI Connect Settings" — user generates a random token here, paste it into AI Connect later (token model A)
- Module system: plugin reads a modules.json file in its plugin directory listing all configured modules. Each module has:
  - slug (URL path component, e.g., "fitness-calculator")
  - title (page title shown in WP)
  - source_url (the external URL to embed)
  - required_memberpress_tier (membership ID required to view, or null for public)
- For each module, plugin auto-registers a WordPress page at /<slug>/ that:
  - Checks MemberPress tier if required (using MemberPress's PHP API)
  - If tier check passes (or no tier required) — renders iframe to source_url
  - If tier check fails — renders gating UI: "This content requires <tier_name> membership. <Login/Upgrade button>"

### 6. WordPress connection flow in AI Connect
- New "WordPress" integration type
- User installs the AI Connect plugin on their WP site (.zip download from AI Connect, manual upload to WP admin)
- User generates token in WP plugin admin
- User adds WordPress integration in AI Connect: WP site URL + token
- Validation: AI Connect hits /wp-json/ai-connect/v1/ping with the token to verify
- On success: integration row created, status badge shows "Connected"

### 7. AI Connect UI: "Add WordPress module"
- Form on the WordPress integration card
- Inputs: slug, title, source URL, required MemberPress tier
- For tier: AI Connect calls /wp-json/ai-connect/v1/status to discover what MemberPress memberships are available, dropdown selector
- "Generate plugin .zip" button: AI Connect generates a new plugin .zip with the updated modules.json
- User downloads .zip, uploads to WP admin (replaces existing plugin)
- After upload: AI Connect verifies via /wp-json/ai-connect/v1/modules that the new module is registered

## Architecture decisions

### One integration row per user per integration type
MVP. Multi-account support (e.g., 3 different SendGrid accounts) is Sprint 7+.

### Credential storage reuses Sprint 1-2 patterns
Vault for encrypted storage, IDs referenced in integrations table. Same shape as platform_credentials.

### "Include in projects" toggle per integration
Decoupling — user might add a SendGrid key for general purposes but not want it auto-injected into every new project. Default: enabled for SendGrid, OpenAI, Anthropic; not applicable to WordPress (project-scoped).

### WordPress plugin is iframe-based for v1
Reverse proxy approach deferred. Iframe works for most calculator-type sub-apps. X-Frame-Options issues with some sources (Lovable in particular) are a known limitation — captured in deferred work.

### Plugin .zip is the deploy mechanism for v1
Auto-sync from AI Connect to WordPress (no manual upload) is Sprint 7+. Requires either: WordPress site exposing a webhook endpoint AI Connect can push to, OR AI Connect polling for plugin update slot, OR a plugin updater API. All real work, deferred.

### MemberPress is the only membership plugin supported in v1
Generic membership plugin support (LearnDash, RCP, WooCommerce Memberships) is Sprint 7+. Plugin code abstracts the tier check into a single function so adding more is straightforward.

## Commit plan

In execution order:

1. Sprint 6 spec doc (this file) — direct commit on branch
2. Database migration 0007 — integrations table
3. Integrations backend foundation — types, CRUD routes, validation harness
4. Integrations frontend foundation — new panel in App.tsx
5. SendGrid integration — type, validator, env var injection in createRenderService
6. OpenAI per-project injection — toggle UI, env var injection
7. Anthropic per-project injection — same pattern as OpenAI
8. WordPress plugin v1 — PHP plugin in wp-plugin/ai-connect/, ping/status endpoints
9. WordPress connection flow — integration type, validator hits /ping
10. WordPress modules feature — add module UI, plugin .zip generation, modules.json processing in plugin

Each step gets its own commit. Branch + PR + merge as we've been doing.

## Deferred to Sprint 6.5+

Captured here so they don't get lost:

- Reverse proxy (non-iframe) WordPress module rendering
- Auto-sync of plugin .zip from AI Connect to WordPress (no manual upload)
- Generic membership plugin support (LearnDash, RCP, WooCommerce Memberships)
- Multi-account integrations (e.g., 3 different SendGrid accounts per user)
- Build-from-source WordPress modules (AI Connect builds the app from a repo, packages as module)
- AI-generated WordPress modules (user describes fitness calculator, AI Connect uses Claude via BYOAI to generate, packages)
- Module marketplace (third parties contribute modules)
- AI Connect WordPress plugin auto-update mechanism
- Stripe Connect (deferred from Sprint 6)
- AWS S3 / SES integrations (deferred from Sprint 6)
- Custom domain for AI Connect projects (deferred from Sprint 5.7 — needs dedicated domain like aiconnect.app)

## Smoke test plan

Sprint 6 smoke test will verify:

1. Add SendGrid integration → validate → toggle "include in projects" ON
2. Add OpenAI integration → validate → toggle ON
3. Add Anthropic integration → validate → toggle ON
4. Provision a new project → confirm Render service has SENDGRID_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY in env vars
5. Download AI Connect WordPress plugin .zip
6. Upload + activate on lifehackprotocol.com (real test site)
7. Generate token in plugin settings
8. Add WordPress integration in AI Connect → validate via /ping
9. Add WordPress module: slug "fitness-calculator-test", source "https://example.com", required MemberPress tier
10. Download new plugin .zip with module configured
11. Upload to lifehackprotocol.com, replace existing plugin
12. Visit lifehackprotocol.com/fitness-calculator-test/ — should show MemberPress gating if not logged in, embedded iframe if logged in with required tier

## Acceptance criteria

Sprint 6 ships when:

- All 10 commits land on master via PR
- Smoke test plan completes end-to-end on lifehackprotocol.com
- One real WordPress module embedded and gated successfully
- Sprint 6 SPRINT_LOG entry committed (direct-to-master post-merge, standard pattern)
