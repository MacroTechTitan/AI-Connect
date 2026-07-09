# Sprint 9 — Stripe Connect + AI Connect Paid Tier

Branch: sprint/9-stripe-connect-and-paid-tier
Start date: 2026-06-24
Estimated work: 8-12 days
Product positioning: "AI Connect gets its first paid tier. Users get 'Just add Payments' — one wizard adds Stripe Connect to any provisioned project so their apps can accept money on day one."

## Context

Sprint 8 shipped the design system foundation + Auth0 connector. Sprint 8's "Build and Ship" story is real: WordPress gates, Auth0 wires, OpenClaw drives local agents. Sprint 9 does two intertwined things, mirroring the two-track Sprint 8 pattern:

**Track A — AI Connect's own paid tier launch (Stripe Standard).**
Free tier + Pro tier ($49/mo subscription). Real feature gates, real Stripe billing, real subscription lifecycle. This is how AI Connect starts making money.

**Track B — Stripe Connect connector for user projects (Stripe Express).**
When a user provisions a project through Project Genesis, they can optionally have AI Connect create a Stripe Express Connected Account and sync `STRIPE_*` env vars to their Render service. Their new SaaS accepts payments day one.

Both tracks validate each other: the AI Connect paid tier proves the Stripe Standard integration works before other users see it. The Stripe Connect connector uses the same Stripe SDK setup and webhook infrastructure.

## What ships in Sprint 9

In execution order:

### 1. Sprint spec doc (this file)

Single source of truth. Direct commit on branch.

### 2. Migration 0010 — subscriptions table

New `subscriptions` table:
- id (uuid, primary key)
- user_id (fk to users, unique — one subscription per user in v1)
- organization_id (fk to organizations, nullable)
- stripe_customer_id (text, unique)
- stripe_subscription_id (text, unique, nullable — Free users have no subscription)
- tier (text, CHECK: 'free' or 'pro')
- status (text, CHECK: 'active', 'past_due', 'canceled', 'incomplete', 'trialing')
- current_period_end (timestamptz, nullable)
- cancel_at_period_end (boolean, default false)
- created_at, updated_at (timestamps)

Indexes: on user_id (unique), on stripe_customer_id, on stripe_subscription_id.

RLS disabled (matches AI Connect pattern — app-layer auth).

Applied to Supabase manually per established pattern (post-commit).

### 3. Migration 0011 — extend integrations for stripe type + projects for stripe_account

Extend integrations.integration_type CHECK constraint to include 'stripe' (for user-projects Connect connector).

Add columns to projects:
- stripe_account_id (text, nullable) — the Stripe Express Connected Account ID for this project
- stripe_account_status (text, nullable, CHECK: 'pending', 'active', 'restricted') — from Connect account.updated webhook

Applied to Supabase manually per established pattern.

### 4. Stripe SDK setup + stripeClient.ts

Install stripe SDK (`stripe` npm package). Real dependency, no way around it — hand-rolling Stripe's API is not worth it given the SDK is well-maintained and Stripe-official.

Create apps/api/src/lib/integrations/stripeClient.ts with two clients:

**StripeStandardClient** — for AI Connect's own paid tier:
- getOrCreateCustomer(userId, email) → creates Stripe Customer for the AI Connect user
- createCheckoutSession(customerId, priceId, successUrl, cancelUrl) → returns hosted Checkout URL
- createCustomerPortalSession(customerId, returnUrl) → returns Customer Portal URL for self-service subscription management
- getSubscription(subscriptionId) → returns Stripe Subscription object
- cancelSubscription(subscriptionId, atPeriodEnd=true) → schedules cancellation

**StripeConnectClient** — for user projects (Express Connected Accounts):
- createExpressAccount(email, country, businessType) → returns new Connected Account ID
- createAccountLink(accountId, refreshUrl, returnUrl) → returns onboarding URL for the user to complete
- getAccount(accountId) → returns Account object (charges_enabled, payouts_enabled, requirements)
- createLoginLink(accountId) → returns Express Dashboard login URL for the user

Both clients read STRIPE_SECRET_KEY from env at construction time. No token caching needed (Stripe's SDK handles it).

Errors typed as StripeError with codes: `invalid_credentials`, `account_not_found`, `charge_failed`, `subscription_not_found`, `rate_limited`, `api_error`.

### 5. Webhook endpoint with signature verification + idempotency

New route: POST /api/stripe/webhook

Critical requirements:
- Signature verification using Stripe.webhooks.constructEvent + STRIPE_WEBHOOK_SECRET
- Raw body access required (Express default JSON parsing must be bypassed for this route — use express.raw({type: 'application/json'}))
- Idempotency: store event.id in a stripe_webhook_events table, refuse duplicates
- Return 200 quickly (async handling for anything slow)

Migration 0012 for the idempotency table:
- stripe_webhook_events (id: event.id from Stripe, received_at, event_type, processed boolean)

Event handlers for v1 (Standard side):
- `checkout.session.completed` → find subscription record by customer_id, set stripe_subscription_id, tier='pro', status='active'
- `customer.subscription.updated` → sync status + current_period_end + cancel_at_period_end + tier from Stripe
- `customer.subscription.deleted` → status='canceled', tier='free' (downgrade takes effect at period end via current_period_end)
- `invoice.payment_failed` → status='past_due'

Event handlers for v1 (Connect side):
- `account.updated` → update projects.stripe_account_status based on account.charges_enabled + account.details_submitted + account.requirements

### 6. Subscription bootstrapping for existing users

On next sign-in or via a one-shot script:
- For each existing user without a subscriptions row: create row with tier='pro', status='active', current_period_end=null (grandfather to Pro indefinitely — no Stripe customer/subscription needed for grandfathered users)

The tier check functions treat grandfathered pro (no stripe_subscription_id) the same as paid pro (has stripe_subscription_id). Distinction only matters if we later want to convert grandfathered users to real paying users.

### 7. Feature gate middleware + tier checks

New apps/api/src/lib/tiers.ts:
- getTierForUser(userId): Promise<'free' | 'pro'> — reads subscription, defaults to 'free' if no row
- FEATURE_LIMITS: constant map for Free tier limits:
  - free.max_integrations = 2
  - free.max_projects = 1
  - free.allowed_integration_types = ['sendgrid', 'wordpress']
  - pro.* = unlimited

New Express middleware requireTier(tier: 'pro'):
- Wraps route handlers
- Reads user's tier
- If tier lower than required → 403 with { error: 'tier_upgrade_required', current_tier, required_tier, upgrade_url }

Apply requireTier('pro') to:
- Creating a 3rd+ integration when Free
- Creating a 2nd+ project when Free
- Adding openclaw, auth0, anthropic, openai, stripe integration types when Free (allowed_integration_types check)

Do NOT block existing users' existing resources — enforcement is on new creates only. If a Free user already has 3 integrations, they can view/delete them but not create a 4th.

### 8. Subscription management routes

- POST /api/subscription/checkout → creates Stripe Checkout session for Pro tier upgrade, returns { url }
- POST /api/subscription/portal → creates Customer Portal session for existing subscription management, returns { url }
- GET /api/subscription → returns current user's tier + status + current_period_end + cancel_at_period_end
- POST /api/subscription/cancel → schedules cancellation at period end

### 9. Frontend: pricing page + subscription UI

- New apps/web/src/components/PricingPage.tsx — Free + Pro side-by-side comparison. Uses design system primitives. "Upgrade to Pro" button hits /api/subscription/checkout and redirects to Stripe.
- New apps/web/src/components/SubscriptionPanel.tsx — shows current tier + status. If Free: prominent "Upgrade" button. If Pro: "Manage Subscription" button that opens Customer Portal.
- Add to Settings page.
- Upgrade prompt modal: when a Free user hits a tier limit (add 3rd integration, etc.), show a Modal with "You've hit your Free plan limit. Upgrade to Pro to continue" and CTA to /api/subscription/checkout.

### 10. Stripe Connect integration type + validator

apps/api/src/lib/integrations/types.ts:
- Extend IntegrationType with 'stripe'
- Add StripeConfig: { stripe_customer_id?: string (for the platform's Stripe Standard Customer for user), stripe_account_id?: string (Express Connected Account for user projects) — v1 uses stripe_account_id }
- Add StripeIdentity: { account_id, charges_enabled, payouts_enabled, requirements_summary }

apps/api/src/lib/integrations/validators/stripe.ts:
- Verifies stripe_account_id exists and Stripe Connect account is reachable
- Returns identity with account status

### 11. Stripe Connect routes

- POST /api/integrations/:id/stripe/onboarding-link → creates Account Link, returns Stripe hosted onboarding URL
- POST /api/integrations/:id/stripe/dashboard-link → creates Login Link to Express Dashboard
- GET /api/integrations/:id/stripe/account → returns Account details for management panel

All require integration type === 'stripe' and status === 'validated'.

### 12. Project Genesis Stripe wiring

Similar to Auth0 wiring in Sprint 8.

New wire_stripe genesis step (apps/api/src/lib/genesis/stripeWiring.ts):
- Only fires if user has active Stripe integration with include_in_projects=true
- Creates new Express Connected Account for the project OR uses user's existing default
- Generates onboarding link
- Syncs env vars to Render:
  - STRIPE_ACCOUNT_ID
  - STRIPE_PUBLISHABLE_KEY (AI Connect's platform publishable key — same across projects)
  - STRIPE_SECRET_KEY (either the project's own key from Connect or AI Connect's platform key — depends on Stripe API pattern)
  - STRIPE_WEBHOOK_SECRET
- Returns wiring result including onboarding_link_url so UI can surface it
- Best-effort: never fails project provisioning

### 13. Stripe wizard + Connect onboarding UI

apps/web/src/components/StripeWizard.tsx — 5 steps:
1. Welcome + what Connect does
2. Business info (email, country dropdown, business_type: individual/company)
3. Create Express account (POST /api/integrations with stripe type)
4. Onboarding link — "Complete your Stripe onboarding" button opens onboarding URL in new tab, "I've completed onboarding" advances
5. Done

apps/web/src/components/StripeAccountManager.tsx — shows Account status, charges_enabled/payouts_enabled/requirements. Buttons: "Open Express Dashboard" (Login Link) + "Re-run Onboarding" (new Account Link).

### 14. Docs

- docs/STRIPE_CONNECTOR.md — user-facing guide. Two sections: (a) Upgrading AI Connect to Pro, (b) Adding Stripe Connect to your projects
- docs/BILLING.md — for admin: how subscriptions work, grandfathering, webhook handling, how to manually adjust a user's tier
- docs/sprints/SPRINT_9_TESTING.md — smoke test plan

## Architecture decisions

### Two Stripe accounts, one codebase

- **AI Connect's platform Stripe account** — used for Standard (paid tier billing)
- **Users' Stripe Express accounts** — created via Connect for their projects
- Same SDK, different API keys per operation. StripeStandardClient uses STRIPE_SECRET_KEY (platform). StripeConnectClient uses same key + Stripe-Account header to act on behalf of Connected Account.

### Webhook infrastructure is shared

One `/api/stripe/webhook` endpoint handles ALL events. Router dispatches on event.type. Both Standard and Connect events flow through here. Idempotency table catches duplicates from either.

### Grandfathering existing users to Pro

At Sprint 9 launch, existing users get tier='pro' with no stripe_subscription_id. Feature gates check tier only, not billing status. Grandfathered users can use Pro features indefinitely without paying. This is the correct move because there are no existing paying customers and forcing existing dev/test accounts to pay makes no sense.

Conversion later (if wanted) = separate email flow that generates them a Stripe checkout session.

### Stripe Express, not Standard or Custom, for Connect

Express hosts onboarding, dashboard, most compliance. Fastest to build correctly. Users see Stripe branding — acceptable for v1. Sprint 10+ could migrate to Custom for full white-labeling.

### Redirect to Stripe Checkout, not embedded Elements

Sprint 9 uses Stripe's hosted Checkout page for subscription purchase. Embedded Stripe Elements is faster/prettier but more work and more compliance surface. Redirect is battle-tested and Sprint 9-viable. Sprint 10+ could add embedded Elements.

### Feature gates enforce on CREATE only, not READ

Downgrading a Pro user to Free doesn't delete their extra resources. They can view, edit, delete existing ones. They just can't create more. Correct UX for subscription downgrades.

### Free tier limits are code constants, not database configuration

FEATURE_LIMITS is a TypeScript const. Changing limits = code deploy. Sprint 10+ could make them per-org/per-plan configurable via database, but v1 keeps it simple.

### Best-effort Stripe Genesis wiring

Same pattern as Auth0. Failure of wire_stripe never fails project provisioning. Genesis step always succeeded with typed result in details.stripe_wiring.

### Webhooks require raw body — Express config

Standard Express JSON parsing corrupts the raw body needed for signature verification. The /api/stripe/webhook route uses express.raw({type: 'application/json'}) BEFORE the general express.json() middleware. This is a critical gotcha documented in the code.

## Commit plan

1. Sprint 9 spec doc (this file) — direct commit on branch
2. Migration 0010 (subscriptions table)
3. Migration 0011 (stripe integration type + projects columns) + Migration 0012 (stripe_webhook_events)
4. Stripe SDK install + stripeClient.ts (StripeStandardClient + StripeConnectClient)
5. Webhook endpoint + signature verification + idempotency + event handlers (Standard side)
6. Webhook event handlers (Connect side) + Connect webhook routing
7. Subscription bootstrapping (grandfather existing users) + tier check module + feature gate middleware
8. Subscription management routes (checkout, portal, get, cancel)
9. Frontend: PricingPage + SubscriptionPanel + UpgradePromptModal + App.tsx integration
10. Stripe Connect types + validator + client + routes
11. Project Genesis Stripe wiring (wire_stripe genesis step)
12. StripeWizard + StripeAccountManager UI
13. docs/STRIPE_CONNECTOR.md + docs/BILLING.md
14. docs/sprints/SPRINT_9_TESTING.md

Each step gets its own commit. Branch + PR + merge same as Sprint 6, 7, 8.

## Deferred to Sprint 9.5+

- Embedded Stripe Elements checkout (currently redirect to hosted Checkout)
- Metered/usage-based pricing
- Annual billing option (currently monthly only)
- Promo codes / discounts
- Trial period on Pro tier
- Multi-tier (Team, Enterprise) — v1 is just Free + Pro
- Team billing (organization-wide subscription vs. per-user)
- Stripe Custom Connect instead of Express (white-label)
- Custom Connect UI within AI Connect (currently Express Dashboard external)
- Multi-account Stripe integrations (multiple Connected Accounts per user)
- Refund UI
- Invoice history UI
- Tax handling / Stripe Tax integration
- Fraud detection / Stripe Radar tuning
- Marketplace / split payments beyond basic Connect
- Stripe Terminal (in-person payments)
- Stripe Issuing (card issuing)

## Smoke test plan

Full plan in docs/sprints/SPRINT_9_TESTING.md. Sections cover:

- A: Grandfathering — existing users see tier='pro' after Sprint 9 deploy
- B: Free tier limits — new signup can create 2 integrations + 1 project, blocked on 3rd/2nd
- C: Pro upgrade flow — Checkout redirect works, webhook fires, tier upgrades to Pro
- D: Customer Portal — subscription management works, cancellation schedules at period end
- E: Downgrade — canceled subscription reverts to Free at period end, existing resources preserved
- F: Stripe Connect integration — Express account created, onboarding link works, account status syncs via webhook
- G: Project Genesis Stripe wiring — provisioning creates Connected Account + syncs STRIPE_* env vars
- H: Webhook resilience — duplicate events rejected, malformed events rejected, valid events processed
- I: Cross-cutting — three wizards (WordPress, OpenClaw, Auth0, Stripe) all use same primitives

## Acceptance criteria

Sprint 9 ships when:

- All Sprint 9 commits merged to master via PR
- Smoke test sections A-D pass (Grandfathering + Free limits + Pro upgrade + Portal)
- Smoke test section H passes (webhook signature verification + idempotency)
- Sprint 9 SPRINT_LOG.md entry committed direct-to-master
- Sprint 6/7/8 smoke tests still pass (no regression)

Sections E-G (Downgrade, Connect, Genesis wiring) can be verified post-merge on live system.
