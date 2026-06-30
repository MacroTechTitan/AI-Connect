# AI Connect WordPress Connector

The WordPress connector lets you embed external web apps as MemberPress-gated pages on any WordPress site. Three clicks in AI Connect creates a new page on your WordPress site that gates an iframe-embedded app behind any MemberPress membership tier.

## What it does

You have a WordPress site with MemberPress installed (e.g., lifehackprotocol.com). You have an external web app you've built or deployed elsewhere (e.g., a macro calculator at macro-calc.vercel.app). You want to embed that app on a gated page like `lifehackprotocol.com/macros/`, accessible only to members of a specific MemberPress tier.

Without AI Connect, this would require:
- Writing custom PHP shortcodes
- Handling MemberPress integration manually
- Setting up cross-domain auth (if needed)
- Configuring iframe embedding
- Repeating all of the above for every new gated app

With AI Connect WordPress connector:
- Install the AI Connect plugin on your WordPress site (one-time, ~30 seconds)
- Generate a token in WP Admin → Settings → AI Connect
- Paste the token + site URL into the AI Connect wizard
- Add modules via AI Connect's UI: slug, source URL, required MemberPress tier
- The page appears at `yoursite.com/{slug}/` and is gated to the chosen tier

## Architecture

### Components

The connector is two pieces:

**1. AI Connect Plugin (`wp-plugin/ai-connect/`)** — a PHP plugin that gets installed on the WordPress site. Lives in this repo at `wp-plugin/ai-connect/`. Provides:
- Token-authenticated REST API at `/wp-json/ai-connect/v1/`
- Dynamic page registration via WordPress `init` + `template_redirect` hooks
- MemberPress integration with graceful fallback when not installed
- Admin settings page (WP Admin → Settings → AI Connect) for token management

**2. AI Connect Backend** — the AI Connect API server that orchestrates the WordPress plugin remotely. It:
- Validates the WordPress integration by hitting the plugin's `/ping` endpoint
- Manages modules via REST API calls to the plugin (`/modules` CRUD endpoints)
- Stores nothing about the WordPress site's data — the plugin owns it via `wp_options`

### Communication

```
AI Connect (cloud)  →  HTTPS + Bearer Token  →  WordPress Plugin (your site)  →  wp_options
                                                          ↓
                                                  template_redirect hook
                                                          ↓
                                                  Visitor's browser
```

All plugin REST API calls require a bearer token in the `Authorization` header. The token is:
- Generated in WP Admin → Settings → AI Connect → "Generate New Token"
- Stored in AI Connect's Vault (Supabase Vault, encrypted at rest)
- Sent on every plugin API call from AI Connect backend
- Validated by the plugin against the token stored in `wp_options`

### Modules

A "module" is a single row of configuration stored in WordPress's `wp_options` table:

```
{
  "slug": "macros",
  "title": "Macro Calculator",
  "source_url": "https://macro-calc.vercel.app",
  "required_memberpress_tier": 12345  // MemberPress membership ID, or null for public
}
```

Modules are managed entirely via REST API — AI Connect adds/edits/removes them remotely without touching plugin files. This means updating a module doesn't require re-uploading the plugin.

### Page rendering flow

When a visitor hits `yoursite.com/{slug}/`:

1. WordPress's request lifecycle starts
2. The plugin's `init` hook fires, checking if `{slug}` matches a registered module
3. The plugin's `template_redirect` hook fires before any page renders
4. Plugin reads the visitor's logged-in state via WordPress auth (`wp_get_current_user`)
5. **If logged out** → render the gating UI ("Members only — This content requires {tier} membership") with Log in + Become a member buttons
6. **If logged in and not a member of required tier** → same gating UI but adjusted copy ("This content requires {tier}")
7. **If logged in and member of required tier** → render the page with an iframe pointing at `source_url`
8. **If `required_memberpress_tier` is null** → render the iframe regardless of login state

The visitor never receives the embedded URL until the membership check passes. This is a server-side gate, not a client-side one — there's no JavaScript redirect, no `display: none` shenanigans. Logged-out visitors literally don't get the HTML containing the iframe source.

## Security model

### Trust boundaries

- **WordPress site owns membership state.** MemberPress is the source of truth for whether a user has a valid membership. AI Connect never sees user data — it doesn't know who's logged in, doesn't know which users have which tiers.
- **AI Connect owns module configuration.** What modules exist, which tier they require, and where their iframe source points — that's AI Connect's data, stored in `wp_options` via REST API.
- **The plugin token authorizes admin operations, not user access.** Plugin token = "this AI Connect installation may add/edit/delete modules on this WordPress site." It does NOT grant access to gated content; only valid MemberPress membership does.

### What the token does and doesn't do

The plugin token (sent in `Authorization: Bearer ...` header on every REST call from AI Connect):

**Does:**
- Authorize the call to come from a legitimate AI Connect installation
- Allow adding, editing, deleting modules
- Allow reading plugin status (`/ping`, `/status`)

**Does NOT:**
- Grant any access to user data on the WordPress site
- Bypass MemberPress membership checks
- Allow access to gated pages — gating is per-visitor, based on their MemberPress membership, regardless of the token

If the token leaks, an attacker could add unauthorized modules or modify existing ones on that one WordPress site. They could NOT access user accounts, read posts, or view gated content on behalf of users.

To rotate a leaked token: generate a new one in WP Admin → Settings → AI Connect (the old one is immediately invalidated), then update it in AI Connect's integration UI.

### What about the source URL?

The `source_url` is loaded into an iframe on the gated page. Browser-level protections apply:

- **X-Frame-Options / CSP frame-ancestors** — If the source URL sets these headers restrictively, the iframe will fail to load. The user will see an empty box where the embed should be. Workaround: configure the source site to allow framing from your WordPress domain.
- **HTTPS mixed-content** — Iframes from HTTP sources on HTTPS pages get blocked by browsers. Source URLs must be HTTPS.
- **Same-origin policy** — Scripts in the iframe can't access the parent page's DOM or vice versa. This is normal iframe behavior.

### What about Direct URL access

A logged-out visitor going to the iframe's `source_url` directly (instead of `yoursite.com/{slug}/`) bypasses your gating. The iframe URL is just a normal URL — anyone who knows it can visit it.

This is by design. The gating is "you need a membership to access this from yoursite.com," not "this URL is secret." If you need stronger access control on the source URL itself, that's the source site's responsibility (auth, IP allowlist, request signing, etc.).

## Setup walkthrough

### 1. Add WordPress integration in AI Connect

In AI Connect → Settings → Integrations:
- Click "Add Integration"
- Select "WordPress"
- Wizard step 1: read welcome
- Wizard step 2: click "Download AI Connect Plugin (.zip)"

### 2. Install the plugin on WordPress

In your WordPress site:
- Plugins → Add New → Upload Plugin
- Choose the `ai-connect.zip` you just downloaded
- Click Install Now
- Click Activate Plugin

### 3. Generate a token

In WordPress:
- Settings → AI Connect
- Click "Generate New Token"
- Copy the token (it's only shown once)

### 4. Connect AI Connect to your WordPress site

Back in AI Connect's wizard:
- Step 5: enter your WordPress site URL (e.g., `https://lifehackprotocol.com`) and paste the token
- Click "Test Connection"
- Wizard advances to "Connected!" step

### 5. Add modules

In the WordPress integration's "Manage Modules" panel:
- Click "Add Module"
- Fill in:
  - **Slug**: URL path component (e.g., `macros`)
  - **Title**: Page title shown in WordPress
  - **Source URL**: The external URL to embed (e.g., `https://macro-calc.vercel.app`)
  - **Required tier**: Pick from MemberPress memberships, or "None" for public
- Click "Add Module"
- AI Connect POSTs the module to the plugin; the plugin registers the page at `yoursite.com/{slug}/`

### 6. Verify it works

- Logged-out (incognito window): `yoursite.com/{slug}/` → should show "Members only" gating
- Logged-in with required tier: `yoursite.com/{slug}/` → should show the embedded iframe

## Limitations and known issues

### Iframe embedding restrictions

Many SaaS apps set `X-Frame-Options: DENY` to prevent iframe embedding. Examples: Google, Stripe Checkout, OAuth login pages. These won't work as modules; the user will see a blank box.

Workarounds:
- Use the source app's "embed" or "iframe-friendly" version if it has one
- For apps you control, configure the source to allow embedding from your WordPress domain

### Cookies and cross-domain auth

The iframe doesn't share cookies or auth state with WordPress. If the embedded app requires login, the user logs in separately to that app. Cross-domain SSO (e.g., shared Auth0 between WordPress and the iframe) is possible but requires explicit configuration — not part of v1.

### Plugin file location on Render

The AI Connect plugin .zip is generated on-the-fly by AI Connect's API server from the `wp-plugin/` directory. If AI Connect's Render service can't access this directory (it's outside the API's `rootDir`), the .zip download fails with a 500 error. Sprint 6 smoke-tested this on production and it works — but if you fork AI Connect and change the Render config, verify the .zip download still works.

### Single-account WordPress only

Each AI Connect WordPress integration connects to one WordPress site. Managing multiple WordPress sites means multiple integrations. This is intentional — keeps the auth model simple.

## Future improvements (not in v1)

- Auto-update the plugin when AI Connect ships new plugin versions
- Reverse-proxy modules (instead of iframe — would solve X-Frame-Options issues)
- LearnDash, RCP, WooCommerce Memberships support (currently MemberPress only)
- "Test Module" preview in AI Connect UI
- Module categories / tags
- Module access analytics

## Source code reference

- Plugin: `wp-plugin/ai-connect/` (PHP)
  - `ai-connect.php` — main plugin file
  - `includes/admin.php` — WP Admin settings page
  - `includes/rest-api.php` — REST endpoints (`/ping`, `/status`, `/modules`)
  - `includes/pages.php` — dynamic page registration via `init` + `template_redirect`
  - `includes/memberpress.php` — MemberPress integration with graceful fallback
- Plugin .zip endpoint: `apps/api/src/routes/wordpressPlugin.ts` (Express)
- WordPress client: `apps/api/src/lib/integrations/wordpressClient.ts`
- Validator: `apps/api/src/lib/integrations/validators/wordpress.ts`
- Wizard UI: `apps/web/src/components/WordPressWizard.tsx`
- Module manager UI: `apps/web/src/components/WordPressModuleManager.tsx`
