# Sprint 10.1 Backlog

Living document. Populated during smoke-test phase after Sprint 10 (2026-07-19 onward). Items get added as they surface during Sprint 7-10 retroactive smoke test. When smoke test is complete, Sprint 10.1 will be scoped from this backlog.

## Legend

- **[BUG]** — something is broken or behaves wrong
- **[POLISH]** — works but rough edges (UX, copy, missing state, etc.)
- **[FEATURE]** — new capability request
- **[SEC]** — security concern
- **[PERF]** — performance issue
- **[DOCS]** — documentation gap
- **[DEFERRED]** — carried forward from Sprint 6-10 deferrals

Severity where applicable:

- **P0** — blocks users from using the feature
- **P1** — significant friction, breaks a happy path
- **P2** — cosmetic, minor UX issue, edge case

Track:

- **A** — Help Center
- **B** — Admin UIs
- **C** — GitHub App connector
- **D** — Auth0 (Sprint 8)
- **E** — Stripe (Sprint 9)
- **F** — OpenClaw (Sprint 7)
- **G** — WordPress (Sprint 6)
- **H** — Project Genesis (all sprints)
- **I** — Cross-cutting / platform (auth, design system, main.tsx routing, etc.)

## Backlog

### 2026-07-19 — Smoke test findings

- **[BUG] P0** [Track I / cross-cutting] Signed-in users see the pre-launch marketing landing page instead of a real workspace / dashboard. When jgelet@macrotechtitan.com signs in at aiconnect.macrotechtitan.com, the screen shown is the same static "AI Connect — The methodology layer for AI-assisted development" landing page a signed-out visitor sees, with only a small "Signed in as..." card added at the bottom. There is no visible entry point to the actual product surface (Integrations panel, Projects panel, Settings, Genesis, admin dashboard). Links exist ("Manage settings", "Help", "Admin", "Sign out") but they're buried at the bottom of the marketing page.

  Expected: signed-in users land on a real app surface — Projects list, Integrations, or a workspace home — where they can see what they have and what they can do. The landing page should be for signed-OUT visitors only.

  Impact: no user can figure out what AI Connect actually does or how to use it after signing in. Blocks user acquisition entirely — first-run experience is "I signed up... now what?"

  Root cause hypothesis: main.tsx likely doesn't split rendering between authenticated + unauthenticated states in a meaningful way. The landing page renders regardless. The `/ui` and `/admin` and `/help` gates work for their specific paths but the root `/` has no signed-in variant.

  Fix scope for Sprint 10.1: signed-in users at `/` should be redirected to (or show inline) a workspace home. Real solution likely: introduce `/app` or `/dashboard` route that renders the workspace surface (Integrations + Projects), auto-redirect signed-in users from `/` to `/app`, keep `/` as marketing for signed-out.

- **[BUG] P0** [Track E — Stripe] `GET /api/subscription` returns error to signed-in user. UI shows red text "Couldn't load your subscription. Try again." for jgelet@macrotechtitan.com (admin, previously granted `tier=pro` via Sprint 9 grandfathering + Sprint 10 admin actions).

  Investigation needed:
  - Does the subscriptions row exist for user_id 875536fd-837c-4d2e-aa43-b1ed5a24100a in prod DB? (Sprint 9 bootstrapSubscriptions.ts may never have run in prod.)
  - If row exists, is `GET /api/subscription` failing at the API layer? Check Render logs for 500 or timeout.
  - Is the Auth0 bearer token being sent correctly by the client (SubscriptionPanel.tsx)?

  Impact: users can't see their tier, can't manage billing, can't tell if they're Free or Pro. Directly blocks paid user retention because someone with an active subscription would think it broke.

  Fix scope: run bootstrapSubscriptions.ts on prod (grandfather all existing users to Pro with `tier=pro, status=active, stripe_subscription_id=null`) as documented in Sprint 9 deploy tasks. If that doesn't fix it, debug the endpoint itself.

- **[POLISH] P1** [Track I / Track E] Pricing cards visible to signed-in users. When a signed-in user views Settings, they see the Free vs Pro side-by-side pricing table as if they were a prospect. Should be conditional on subscription state: signed-in Pro users see "Your subscription: Pro • Next renewal on X" without pricing tiles; Free users see the pricing tiles inline. Signed-out visitors on the marketing landing page see pricing separately.

  Impact: confusing UX. Admin/pro users see "Upgrade to Pro" button as if they weren't. Compounds with the P0 above — because subscription didn't load, the pricing table becomes the visual anchor of the page and everyone looks like an unpurchased prospect.

  Fix scope: SubscriptionPanel.tsx should render differently based on tier state. Pricing tiles hidden for active Pro users. "Manage subscription" primary action for Pro users. Only show pricing/upgrade UI when tier === 'free'.

- **[POLISH] P2** [Track I] Signed-in user info visually buried. The "Signed in as jgelet@macrotechtitan.com (role: admin) · MacroTechTitan · Hide settings · Help · Admin · Sign out" card sits between the marketing hero and Settings content. It's low-density and easy to miss.

  Impact: user identity + navigation feel like an afterthought. Feels like they were bolted on rather than designed for.

  Fix scope: after landing page bug (P0) is fixed and signed-in users get an app surface at `/app` or `/dashboard`, this card can become a proper header/nav bar with:
  - User avatar + email on the right
  - Nav links (Projects, Integrations, Settings, Admin, Help) as top nav
  - Sign out in a dropdown menu

## Standing carry-forward items from Sprint 6-10 deferrals

### Sprint 10.5+ small polish

- **[DEFERRED] [PERF]** Bundle optimization (dynamic imports for /help + /admin to code-split marked + dompurify + admin code out of main chunk — currently 600.81 kB main bundle). Track A + B.
- **[DEFERRED] [POLISH]** WEB_APP_URL env var (currently DEFAULT_WEB_APP_URL constant with request Origin header override — limitation for local dev testing of install→callback round trip). Track C.
- **[DEFERRED] [SEC] P1** Origin header allowlist in resolveWebOrigin (currently trusts attacker-controllable Origin header — real security concern before customer-facing prod). Track C.
- **[DEFERRED] [POLISH]** Auto-redeploy Render service after AUTH0_* / STRIPE_* env sync (env vars only take effect on next deploy currently). Sprint 8 + Sprint 9 + Sprint 10 carry-forward. Track D + E + H.
- **[DEFERRED] [FEATURE]** Per-project Stripe Restricted Keys instead of publishable-only sync. Sprint 9 carry-forward. Track E.
- **[DEFERRED] [FEATURE]** Reusing existing Stripe Connected Accounts across projects (currently creates fresh per project). Sprint 9. Track E + H.
- **[DEFERRED] [FEATURE]** Multi-tenant Auth0 support. Sprint 8. Track D.
- **[DEFERRED] [POLISH]** Real per-project AUTH0_AUDIENCE (currently placeholder). Sprint 8. Track D + H.
- **[DEFERRED] [FEATURE]** Auth0 user management, connections config, Actions/Rules, Universal Login branding. Sprint 8. Track D.
- **[DEFERRED] [FEATURE]** Delete Auth0/Stripe application/account UX. Sprint 8 + 9. Track D + E.
- **[DEFERRED] [POLISH]** Search/filter in Auth0/Stripe application/account managers. Sprint 8 + 9. Track D + E.
- **[DEFERRED] [POLISH]** Admin — charts and visualizations (currently tables only). Track B.
- **[DEFERRED] [FEATURE]** Admin — bulk actions (currently one row at a time). Track B.
- **[DEFERRED] [FEATURE]** Admin — CSV export. Track B.
- **[DEFERRED] [FEATURE]** Admin — user search (email, name). Track B.
- **[DEFERRED] [POLISH]** Admin — sortable columns (currently fixed sort by created_at desc). Track B.
- **[DEFERRED] [FEATURE]** Admin — real-time updates for logs (SSE/websocket). Track B.
- **[DEFERRED] [FEATURE]** Admin — synchronous webhook re-processing (currently resets only). Track B.
- **[DEFERRED] [FEATURE]** Admin — GitHub webhook retry route (Stripe has one; /api/admin/webhooks/github is GET-only in v1). Track B + C.
- **[DEFERRED] [FEATURE]** Admin — admin-granting UI (SQL-only by design in v1). Track B.
- **[DEFERRED] [FEATURE]** Help Center — text search across articles. Track A.
- **[DEFERRED] [POLISH]** Help Center — content rewritten for non-developer audience (currently ports developer docs verbatim). Track A.
- **[DEFERRED] [FEATURE]** Help Center — screenshots and images. Track A.
- **[DEFERRED] [FEATURE]** Help Center — article versioning / changelog. Track A.
- **[DEFERRED] [FEATURE]** Help Center — static hosted docs site (in addition to in-app). Track A.
- **[DEFERRED] [FEATURE]** GitHub App — PR creation UI in Manager (API supports it; v1 has issue form only). Track C.
- **[DEFERRED] [FEATURE]** GitHub App — reconciliation for orphan installations (OAuth callback never ran). Track C.
- **[DEFERRED] [FEATURE]** GitHub App — repo selection UI (add/remove specific repos from installation). Track C.
- **[DEFERRED] [FEATURE]** GitHub App — uninstall from AI Connect UI (currently must go to GitHub). Track C.
- **[DEFERRED] [POLISH]** GitHub App — setup_action=update handled separately (v1 treats as install). Track C.
- **[DEFERRED] [FEATURE]** OpenClaw — message history persistence (currently 10-message in-memory rolling in OpenClawAgentManager.tsx, so a page refresh clears it). Sprint 7. Track F.
- **[DEFERRED] [POLISH]** Full theme switcher. Sprint 8. Track I.
- **[DEFERRED] [FEATURE]** Storybook proper. Sprint 8. Track I.
- **[DEFERRED] [FEATURE]** Team / Enterprise tiers beyond Free + Pro. Sprint 9. Track E + I.
- **[DEFERRED] [FEATURE]** Annual billing option. Sprint 9. Track E.
- **[DEFERRED] [FEATURE]** Promo codes / discounts / trial periods. Sprint 9. Track E.
- **[DEFERRED] [FEATURE]** Multi-tenant subscriptions (org-wide). Sprint 9. Track E + I.
- **[DEFERRED] [POLISH]** Global fetch wrapper to centralize 403 tier_upgrade_required handling. Sprint 9. Track I.

### Sprint 11+ (bigger scope — likely NOT Sprint 10.1)

These are called out here for completeness but are large enough that they wouldn't be Sprint 10.1 scope. They belong to Sprint 11 or later.

- **[DEFERRED] [FEATURE]** Maximus AI skills integration + workflow mandate. Sprint 11 track. Track I.
- **[DEFERRED] [FEATURE]** Template scaffolding via installation token (unlocks GitHub App Path A). Sprint 11 track. Track C + H.
- **[DEFERRED] [FEATURE]** Real bot behavior for GitHub webhook repo-activity events (currently stubbed). Sprint 11 track. Track C.
- **[DEFERRED] [FEATURE]** Custom check runs / CI-style bot activity. Sprint 11 track. Track C.
- **[DEFERRED] [FEATURE]** Branch protection setup on new repos. Sprint 11 track. Track C + H.
- **[DEFERRED] [FEATURE]** Repo templates from AI Connect (parallel to Render templates). Sprint 11 track. Track C + H.
- **[DEFERRED] [FEATURE]** Import existing repos into AI Connect. Sprint 11 track. Track C.
- **[DEFERRED] [FEATURE]** Team accounts / organization billing. Sprint 11+. Track E + I.
- **[DEFERRED] [FEATURE]** Multi-role admin access (currently boolean is_admin; future: user_roles table). Sprint 11+. Track B.
- **[DEFERRED] [POLISH]** Deeper accessibility work: screen reader announcements, ARIA on icon-only buttons, high contrast, reduced motion. Ongoing. Track I.
- **[DEFERRED] [FEATURE]** Mobile auth broker for Life Hack Protocol — full spec below. Sprint 11+ scope. Track I (cross-product) + G (WordPress connector adjacent).

  **Goal:** the LHP mobile app authenticates users and checks their MemberPress membership WITHOUT the app ever talking to WordPress JWT plugins. AI Connect brokers via the MemberPress REST API.

  **Context:**
  - Target: lifehackprotocol.com, running MemberPress with Developer Tools REST API at `/wp-json/mp/v1/` (routes: members, memberships, subscriptions, me, validate-login).
  - Auth to MemberPress: `MEMBERPRESS-API-KEY` header (server-to-server; key lives in AI Connect vault, NEVER sent to app).
  - AI Connect already stores per-site config + has token-authed REST layer.

  **Build:**

  1. Site-config entry for lifehackprotocol.com holding: base URL + MemberPress API key. Reuse AI Connect's existing secret storage (vault_secret_id pattern) — do not hardcode.

  2. `POST /api/mobile/lhp/login` (adjust to AI Connect route conventions):
     - Body: `{ username, password }`
     - INVESTIGATE FIRST: does `mp/v1/validate-login` accept username+password and return pass/fail? If yes → use it. If not → fall back to WordPress core auth endpoint (single server-side auth check), then look up member.
     - On success: fetch MemberPress membership status (active memberships / tier) via `mp/v1` with API key.
     - Issue AI-Connect-signed JWT (AI Connect secret) encoding: user_id, email, membership tiers, active boolean, expiry.
     - Returns: `{ token, membership: { active, tiers }, user: { email, displayName } }`
     - On failure: clean 401, generic message.

  3. `POST /api/mobile/lhp/validate`:
     - Body: AI Connect token
     - Verifies signature + expiry
     - Returns current `{ active, tiers }`, re-checking MemberPress if token is older than short TTL (e.g. 15 min) so revoked/expired memberships don't linger.

  4. **Security:**
     - Rate-limit login attempts
     - Generic error messages (no user-enumeration)
     - API key only from vault
     - Tokens signed with AI Connect's secret
     - Short access-token TTL with validate endpoint as refresh path

  5. **Docs:** own `docs/MOBILE_AUTH.md` with request/response shapes so mobile app can integrate.

  **Investigation required first (before finalizing):** MemberPress `mp/v1` capabilities, especially `validate-login`'s exact behavior. Report which password-verification path chosen and why before building.

  **Deliverables after build:** exact endpoint URLs + curl example for login.

  **Implementation notes:** TypeScript, follow existing AI Connect patterns (route structure, vault usage, JWT signing, validation middleware).

### Other known standing items

- **[DEFERRED] [SEC] P1** Dependabot 31 open vulnerabilities on master (4 high, 21 moderate, 6 low — verified 2026-07-19 via the Dependabot alerts API). Address as small direct-to-master commit before Sprint 10.1 starts. Track I.
- **[DEFERRED] [SEC]** Dependabot PR #13 (vite 5.4.10 → 6.4.3, /apps/web) has been open since 2026-06-20 and is the only open PR on the repo. It is a major-version dev-dependency bump, so it needs a build + smoke check rather than a blind merge. Fold into the vulnerability sweep above. Track I.
- **[DEFERRED] [POLISH]** Migration 0014's `DROP CONSTRAINT` on `integrations_integration_type_check` is unguarded (no `IF EXISTS`, no DO-block), unlike the FK add in the same file — a partial re-run of 0014 fails on that statement. Harmless as applied, but worth guarding if migrations are ever re-run against a fresh environment. Track I.

## Sprint 10.1 candidates (once smoke test complete)

_Empty. Populated after smoke test is done, from items above that qualify as Sprint 10.1 scope._

Sprint 10.1 scope guideline: fix-and-polish, not new features. Items typically include:

- P0 and P1 bugs found in smoke test
- Small polish that improves the perceived quality (copy, error messages, empty states, loading skeletons, unclear labels)
- The high-severity Sprint 10.5+ deferrals that block real user acquisition (SEC P1 items especially)
- Dependabot vuln resolution
- README / repo hygiene items

Sprint 10.1 scope guideline: NOT new features. Features get deferred to Sprint 11+.
