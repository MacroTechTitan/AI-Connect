# WordPress connector

The WordPress connector lets you embed external web apps as MemberPress-gated pages on any WordPress site. Three clicks in AI Connect creates a new page on your WordPress site that gates an iframe-embedded app behind any MemberPress membership tier.

## What it does

Say you have a WordPress site with MemberPress installed (e.g., `lifehackprotocol.com`) and an external web app you've built or deployed elsewhere (e.g., a macro calculator at `macro-calc.vercel.app`). You want to embed that app on a gated page like `lifehackprotocol.com/macros/`, accessible only to members of a specific MemberPress tier.

Without AI Connect, this would require writing custom PHP shortcodes, handling MemberPress integration manually, setting up cross-domain auth, configuring iframe embedding — and repeating all of it for every new gated app.

With the AI Connect WordPress connector:
- Install the AI Connect plugin on your WordPress site (one-time, ~30 seconds)
- Generate a token in WP Admin → Settings → AI Connect
- Paste the token + site URL into the AI Connect wizard
- Add modules via AI Connect's UI: slug, source URL, required MemberPress tier
- The page appears at `yoursite.com/{slug}/` and is gated to the chosen tier

## How it works

The connector is two pieces:

**1. The AI Connect plugin** — a lightweight plugin you install on your WordPress site once. It provides a token-authenticated API, registers your gated pages, integrates with MemberPress, and adds a settings page under WP Admin → Settings → AI Connect for managing your token.

**2. The AI Connect backend** — orchestrates the plugin remotely. It validates the connection, manages your modules, and stores nothing about your WordPress site's user data — the plugin owns that.

All communication runs over HTTPS with a bearer token you generate in WordPress. AI Connect stores that token encrypted at rest and sends it on every call to your site.

### Modules

A "module" is a single gated page. Each one has:
- **Slug** — the URL path (e.g., `macros` → `yoursite.com/macros/`)
- **Title** — the page title
- **Source URL** — the external app to embed in an iframe
- **Required tier** — a MemberPress membership, or "None" for a public page

Modules are managed entirely from AI Connect's UI — adding, editing, or removing one never requires re-uploading the plugin.

### What a visitor sees

When someone visits `yoursite.com/{slug}/`, the plugin checks their WordPress login and MemberPress membership *before rendering anything*:

- **Logged out** → a "Members only" gating screen with Log in and Become a member buttons
- **Logged in, but not a member of the required tier** → the same gating screen, adjusted for their tier
- **Logged in and a member of the required tier** → the embedded app loads in an iframe
- **No tier required (public module)** → the app loads for everyone

This is a server-side gate. Logged-out visitors never receive the HTML containing the embed — there's no JavaScript redirect or hidden element to bypass.

## Security model

- **Your WordPress site owns membership state.** MemberPress is the source of truth for who has a valid membership. AI Connect never sees your user data.
- **AI Connect owns module configuration.** What modules exist, which tier they require, and where they point — that's AI Connect's data.
- **The plugin token authorizes admin operations, not user access.** The token lets AI Connect add, edit, and delete modules on your site. It does *not* grant access to gated content — only a valid MemberPress membership does.

If the token leaks, an attacker could add or modify modules on that one WordPress site. They could *not* access user accounts, read posts, or view gated content on behalf of users. To rotate a leaked token: generate a new one in WP Admin → Settings → AI Connect (the old one is invalidated immediately), then update it in AI Connect's integration UI.

### A note on embedded URLs

The source URL you embed is loaded in a normal iframe. Anyone who knows that URL can visit it directly, outside your WordPress gate — the gating is "you need a membership to reach this from yoursite.com," not "this URL is secret." If the source itself needs stronger protection, that's the source site's responsibility (its own auth, IP allowlist, request signing, etc.).

## Setup walkthrough

### 1. Add the WordPress integration in AI Connect

Settings → Integrations → **Add Integration** → **WordPress**. On step 2 of the wizard, click **Download AI Connect Plugin (.zip)**.

### 2. Install the plugin on WordPress

In your WordPress admin: Plugins → Add New → Upload Plugin → choose the `ai-connect.zip` you just downloaded → Install Now → Activate Plugin.

### 3. Generate a token

In WordPress: Settings → AI Connect → **Generate New Token**. Copy the token — it's only shown once.

### 4. Connect AI Connect to your site

Back in the AI Connect wizard, enter your WordPress site URL (e.g., `https://lifehackprotocol.com`) and paste the token. Click **Test Connection** — the wizard advances to "Connected!"

### 5. Add modules

In the WordPress integration's **Manage Modules** panel, click **Add Module** and fill in the slug, title, source URL, and required tier (or "None" for public). AI Connect registers the page at `yoursite.com/{slug}/` immediately.

### 6. Verify

- In an incognito window: `yoursite.com/{slug}/` should show the "Members only" gate
- Logged in with the required tier: the same URL should show your embedded app

## Limitations and known issues

### Iframe embedding restrictions

Many SaaS apps set `X-Frame-Options: DENY` to prevent iframe embedding — Google, Stripe Checkout, and most OAuth login pages, for example. These won't work as modules; the visitor sees a blank box. Workarounds: use the source app's embed-friendly version if it has one, or (for apps you control) configure the source to allow framing from your WordPress domain.

### Cookies and cross-domain auth

The iframe doesn't share cookies or login state with WordPress. If the embedded app requires its own login, the visitor logs into it separately. Cross-domain single sign-on is possible but requires explicit configuration — not part of v1.

### Single WordPress site per integration

Each WordPress integration connects to one WordPress site. Managing multiple sites means multiple integrations. This keeps the auth model simple.

## Not in v1

- Auto-updating the plugin when AI Connect ships a new version
- Reverse-proxy modules (which would sidestep `X-Frame-Options` issues)
- LearnDash, RCP, or WooCommerce Memberships support (MemberPress only for now)
- "Test Module" preview in the AI Connect UI
- Module categories, tags, and access analytics
