# Sprint 10.1 — Real GUI: Routing + Workspace + Design Rework

Branch: sprint/10.1-real-gui
Start date: 2026-07-25
Estimated work: 12-18 days (comparable to Sprint 8/10 in scope)
Product positioning: "AI Connect stops being a landing page with app code bolted underneath and becomes a real product. Real routing, real workspace surface for signed-in users, real design system reflecting the actual audience."

## Context

Sprint 10 shipped three tracks (Help Center + Admin UIs + GitHub App Connector). Immediately after merge, a 45-minute smoke test found four P0/P1 bugs that combined tell a bigger story:

1. **P0**: Signed-in users see the marketing landing page instead of a real workspace / dashboard
2. **P0**: `subscriptions` table missing from prod (Sprint 9 migration 0010 was never applied — patched in-session, but reveals a pattern: migrations don't have a paste-verification checklist)
3. **P0**: Client-side routing missing — `/settings`, `/projects`, `/integrations` all return Vercel 404
4. **P1**: Pricing tiles shown to signed-in Pro users (confuses state — "you have Pro" then immediately "Upgrade to Pro")
5. **P2**: Header/nav visually buried between marketing hero and Settings panel

None of these are polish. They're structural. AI Connect has app code (Sprint 6-10 shipped it), but the shell around it is still the pre-launch marketing landing page. Users can't find, navigate to, or bookmark any part of the actual product.

Sprint 10.1 fixes this in one arc. Four intertwined tracks.

## What ships in Sprint 10.1

In execution order:

### 1. Sprint spec doc (this file)

Single source of truth. Direct commit on branch.

### 2. Install wouter + Vercel routing config

Install `wouter` (~1.5 kB gzipped, simpler API than React Router — enough features for the routes Sprint 10.1 needs).

pnpm --filter @ai-connect/web add wouter

Add Vercel rewrites config so all client-side routes serve `index.html`. Create/update `apps/web/vercel.json`:

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

If vercel.json already exists with rewrites for /api/*, preserve those and add the catch-all as the LAST rule.

### 3. Design tokens rework (Sky + linen palette)

Update apps/web/src/tokens.ts (or wherever design tokens live in the codebase) from the current dark palette to light + glassy + pastel:

Real palette:
- **Primary background**: linen off-white (#FDFCF7 → #F0EDE5 range)
- **Accent**: dusty indigo (#5C6BC0)
- **Highlights**: sky blue (#F0F8FF → #B3D9E8 range)
- **Muted text**: warm grays (#4A4A4A → #757575)
- **Body text**: near-black warm (#212121)
- **Glass surfaces**: semi-transparent white (rgba(255,255,255,0.7)) with backdrop-filter blur(12px) and subtle border (rgba(255,255,255,0.2))

Update all `--ai-color-*` tokens. Border radius softened (existing --ai-radius-md gets 8px, --ai-radius-lg gets 12px, --ai-radius-xl gets 16px). Typography scale kept but weights reduced (no --ai-weight-bold in body copy, --ai-weight-semibold for headings max).

### 4. Router setup + route architecture

In apps/web/src/main.tsx replace the current path-based render-root gates (`/ui`, `/admin`, `/help`) with a wouter Router.

Route structure:
- `/` — marketing landing page (only for signed-out users; signed-in users redirect to `/app`)
- `/app` — workspace home (dashboard)
- `/app/projects` — projects list + create
- `/app/integrations` — integrations list + add
- `/app/settings` — settings (profile, preferences)
- `/app/billing` — subscription + billing
- `/admin` — admin dashboard (existing, wrapped in router with admin guard)
- `/admin/*` — admin sub-routes (users, subscriptions, integrations, logs, webhooks)
- `/help` — help center (existing, wrapped in router, public)
- `/help/:articleId` — deep-linked article (replaces URL hash approach — cleaner)

Auth gates:
- Signed-in users at `/` → redirect to `/app` (with any query params preserved)
- Signed-out users at `/app/*` → redirect to `/` with `?return_to=<path>` (post-login redirect back)
- Non-admin users at `/admin/*` → show SectionError from Sprint 10 (backend already 403s)
- `/help/*` — always public

### 5. Workspace shell — top nav + layout

apps/web/src/app/AppLayout.tsx — new component wrapping every `/app/*` route:

Top nav (fixed at top):
- Left: AI Connect logo/wordmark (links to `/app`)
- Center: Nav links (Projects, Integrations, Settings, Billing) — highlighted on active route
- Right: 
  - Admin link (if admin)
  - Help link
  - User menu dropdown: email + role, "Sign out" action

Content area:
- Full-width container
- Consistent padding, background (linen off-white)
- Renders active route's page component

Real width constraints: max-width around 1200-1400px for most pages (dashboard, lists), 900px for text-heavy pages (settings, article renderer).

### 6. Dashboard home at `/app`

apps/web/src/app/DashboardHome.tsx — the workspace landing page for signed-in users.

Content:
- Greeting: "Welcome back, {name/email}" (uses user email from Auth0 profile)
- At-a-glance stat cards (glass-surface, in a grid):
  - Projects — count with "View all" link to `/app/projects`
  - Integrations — count with "View all" link to `/app/integrations`
  - Subscription — tier badge + status ("Pro • Grandfathered" or "Free • 1/2 integrations used")
- Quick actions section:
  - "Create your first project" (if project count == 0) or "New project" (if > 0)
  - "Add an integration" (if integration count == 0) or "Add another integration"
- Recent activity section (real if data exists; otherwise skipped):
  - Last 5 items from system_logs where user_id = current user's id (filtered categories: project_created, integration_added, subscription_updated)

### 7. Projects page at `/app/projects`

Move existing ProjectsPanel content into a proper page component. Keep functionality (list projects, create new via Genesis, view details). Update styling to new tokens.

### 8. Integrations page at `/app/integrations`

Same treatment. Move IntegrationsPanel into `/app/integrations` page. Type selector, wizard modal invocation, integration cards — all in place with new tokens.

### 9. Settings page at `/app/settings`

Profile, preferences (theme, notifications if any). Sign-out button.

### 10. Billing page at `/app/billing`

Subscription state + pricing + management. This is where the subscription-aware display logic lives:

- **Grandfathered Pro**: Show "You have Pro access (grandfathered)" card + "Convert to paid Pro" primary action. NO pricing tiles. NO "Upgrade" copy.
- **Paying Pro**: Show subscription details (renewal date, cancel status, payment method link). "Manage subscription" opens Customer Portal. NO pricing tiles.
- **Free**: Show pricing tiles (Free vs Pro) with "Upgrade to Pro" primary action. Usage stats above pricing ("Using 1 of 2 integrations, 1 of 1 project").
- **Past due**: Warning banner. Link to Customer Portal to fix payment.

Move existing SubscriptionPanel + PricingPage logic here with proper state gating.

### 11. Admin dashboard integration

Wrap existing AdminApp in the router. `/admin` route uses `<RouteWithAdminGuard>` that:
- Checks auth (redirect to `/` if not signed in)
- Renders AdminApp (backend still 403s if not admin — no frontend admin check needed, keeps single source of truth)

Sub-routes (`/admin/users`, `/admin/subscriptions`, etc.) navigate within AdminApp's internal state instead of section dropdown. Real URLs for admin sections.

### 12. Help Center integration

Wrap HelpApp in the router. `/help` route is public (no auth guard). `/help/:articleId` deep-links to specific article (replaces URL hash approach).

Update HelpArticleRenderer to use wouter's params instead of window.location.hash. `?` help links from panels get updated: `/help#stripe` → `/help/stripe`.

### 13. Landing page cleanup

apps/web/src/marketing/LandingPage.tsx — the current pre-launch content, cleaned up:
- Remove "Signed in as..." bleed (signed-in users never see this page now)
- Real signed-out marketing content: hero, features, how it works, pricing, FAQ, "Sign up / Sign in" CTAs
- Uses new tokens (light + glassy) already
- Feels like a proper marketing page, not a hybrid app/landing surface

### 14. All wizards updated to new tokens

Auth0Wizard, StripeWizard, GitHubWizard, WordPressWizard, OpenClaw wizards — each gets a token-update pass:
- Light backgrounds
- Glass surfaces for cards
- Soft rounded corners
- Muted typography

Modal component itself needs a token update too (backdrop blur, semi-transparent surface).

### 15. All admin sections updated to new tokens

DashboardSection, UsersSection, SubscriptionsSection, IntegrationsSection, LogsSection, WebhooksSection — table styles, badges, filters, modals all get the light + pastel treatment.

### 16. All integration managers updated to new tokens

Auth0IntegrationManager, StripeAccountManager, GitHubIntegrationManager — single-pane panels get the same treatment.

### 17. Help Center updated to new tokens

HelpApp sidebar + article renderer. Article typography updates (headings feel calmer, code blocks stay dense but on lighter background).

### 18. Marketing landing page finalized

Real marketing content. If you want AI stubs / placeholders replaced with real product positioning, that's done here. Otherwise landing content stays as is but gets restyled.

## Architecture decisions

### Fold gates into router

Sprint 10 used path-based render-root gates in main.tsx (`/help`, `/admin`, `/ui`). Sprint 10.1 replaces these with a single wouter Router. Cleaner mental model, real routes with real params, no divergence between "gated app" and "gated content."

### wouter over React Router

wouter is 1.5 kB gzipped vs React Router's 13 kB. Bundle is already 600 kB (Sprint 10 deferred bundle optimization). No need to add more. wouter covers the routes Sprint 10.1 needs.

### Sky + linen palette

"Architect / engineering firm" + "Google-clean" + "Claude-adjacent" reference points synthesized. Sky blue for accents, linen off-white for backgrounds, dusty indigo for primary actions, warm grays for text. Calm, professional, no shouty maximalism.

### Glass surfaces via backdrop-filter

Real "glassy" quality comes from `backdrop-filter: blur(12px)` on semi-transparent white surfaces. Modern browser support is solid. Fallback: solid semi-transparent white (still readable, just less depth).

### Subscription-aware display

Real state machine in billing page:
- `subscription.tier === 'pro' && stripe_subscription_id === null` → grandfathered
- `subscription.tier === 'pro' && stripe_subscription_id !== null` → paying
- `subscription.tier === 'free'` → free
- `subscription.status === 'past_due'` → past due banner (any tier can be past-due, but usually pro-turned-past-due)

Pricing tiles and upgrade CTAs conditional on this state.

### Migration paste verification

The Sprint 9 migration 0010 miss is preventable. Add to SPRINT_LOG documentation (via docs update in a later commit): manual paste verification checklist required for each sprint's migrations:

1. Paste SQL in Supabase SQL Editor
2. Verify "Success. No rows returned."
3. Run `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';` before + after migration — expected delta matches the number of new tables in migration
4. Query at least one new column / constraint from the migration to confirm it landed
5. Only THEN mark migration applied in SPRINT_LOG

Sprint 10.1 doesn't add this to CLAUDE.md necessarily but adds it to sprint post-deploy checklists going forward.

### Real routing means real routes

URLs are not decorative. Users bookmark them, share them, refresh on them. Every `/app/*` URL is a first-class citizen. No hash-based state fallbacks.

## Commit plan

Each step gets its own commit. Branch + PR + merge same as Sprints 6-10.

1. Spec doc (this file) — direct commit on branch
2. Install wouter + Vercel routing config
3. Design tokens rework (light + linen + sky + dusty indigo palette)
4. Router setup + route architecture in main.tsx
5. AppLayout (top nav + shell)
6. DashboardHome
7. Projects page at `/app/projects`
8. Integrations page at `/app/integrations`
9. Settings page at `/app/settings`
10. Billing page at `/app/billing` with subscription-aware state gating
11. Admin dashboard integration in router
12. Help Center integration in router (deep links updated from hash to `/help/:articleId`)
13. Landing page cleanup (signed-out marketing)
14. Wizards restyle (Auth0, Stripe, GitHub, WordPress, OpenClaw)
15. Admin sections restyle
16. Integration managers restyle
17. Help Center restyle
18. docs/sprints/SPRINT_10_1_TESTING.md — smoke test plan

## Deferred to Sprint 10.2+ / Sprint 11+

- Bundle optimization (dynamic imports for /help and /admin routes)
- WEB_APP_URL env var (currently DEFAULT_WEB_APP_URL constant)
- Origin header allowlist in resolveWebOrigin (real security concern — moved to Sprint 11+)
- Rich dashboard widgets (charts, activity feed with real time updates)
- Storybook proper
- Deeper accessibility (screen reader announcements, ARIA on icon-only buttons, high contrast, reduced motion)
- Theme switcher (light + dark toggle)
- Sprint 10 GitHub App smoke test execution (deferred to retroactive smoke test session)
- Sprint 7-9 retroactive smoke tests
- Maximus AI skills integration (Sprint 11 track)
- Template scaffolding for GitHub App Path A (Sprint 11 track)
- Real bot behavior for GitHub webhook events (Sprint 11 track)
- Mobile auth broker for Life Hack Protocol (Sprint 11+ per SPRINT_10_1_BACKLOG.md)

## What this doesn't do

- No new integration types
- No new webhook infrastructure
- No new admin features (existing ones get restyle + real routes only)
- No new Help Center content
- No changes to backend routes (all routes stay as-is; frontend adapts)
- No changes to migrations (subscription table fix is a data-only patch, not a migration)
- No user-facing sign-up flow changes (Auth0 handles auth as before; workspace surface is behind auth)

## Smoke test plan

Full plan in docs/sprints/SPRINT_10_1_TESTING.md. Sections cover:

- A: Router basics (each `/app/*` URL loads, deep links work, back button works)
- B: Signed-in redirect from `/` to `/app` works
- C: Signed-out redirect from `/app/*` to `/` with return_to works
- D: Dashboard renders with real stats
- E: Each `/app/*` page shows correct content
- F: Billing page shows correct state per subscription (grandfathered vs paying vs free)
- G: Admin routes work (`/admin`, `/admin/users`, etc.)
- H: Help Center deep links via `/help/:articleId` work + `?` help links updated
- I: New design tokens rendered consistently across all pages
- J: Wizards / managers / help articles all look coherent in new palette
- K: No regression on Sprints 6-10 backend behavior (integrations, webhooks, admin API)

Sprint 10.1 acceptance = A + B + C + D + F + I fully pass.
